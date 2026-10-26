#!/usr/bin/env node
// The circles client in a real Chromium, in RTL, at phone width (390x844): join
// through an invite link, create a circle, log and share a workout, react, and
// the week view. The node suite (test/circles-*.test.mjs) proves the logic in
// jsdom; this proves what jsdom cannot see - that the sheets fit a phone, that
// every control is a real tap target, that the two weeks of a couple sit side
// by side in the right reading order, and that the page never scrolls sideways.
//
// ONE SCRIPT, FIVE SECTIONS, and deliberately not five scripts:
// scripts/browser-check/ is enumerated from disk by run-all.mjs (CLAUDE.md,
// "Parallel work"), so every file added here is a merge hazard for every other
// open branch.
//
// The backend is the in-page mock (lib/mockCloud.mjs); nothing here can reach a
// real project. The Circles RPCs are stood in for with small handlers below.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal, dismissFirstLogArrival, selectMovement } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VIEWPORT = { width: 390, height: 844 };
const VERIFIED = new Date().toISOString();
const ME = "11111111-1111-4111-8111-111111111111";
const DANA = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "ab".repeat(32);

function club(over) {
  return Object.assign({ id: A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME }, over);
}
function membership(clubOver, over) {
  const c = club(clubOver);
  return Object.assign({ club_id: c.id, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: c }, over);
}
function seed(over) {
  return Object.assign({
    profiles: [
      { id: ME, handle: "member_me", display_name: "אני", emoji: "💪", recovery_verified_at: VERIFIED },
      { id: DANA, handle: "dana_k", display_name: "דנה", emoji: "🦁", recovery_verified_at: VERIFIED },
    ],
    circle_members: [membership()],
    member_targets: [], post_training_partners: [], workout_posts: [], benchmark_results: [], blocks: [], reactions: [],
    notifications: [], notification_preferences: [], analytics_events: [],
  }, over || {});
}

// Stand-ins for the Circles RPCs, registered in the page before the app boots.
// They take the same arguments rpcs.md lists and answer with the same shapes.
function circleRpcs() {
  return () => {
    const m = window.__mock;
    const ok = (data) => () => ({ data: data === undefined ? null : data, error: null });
    m.onRpc("circle_feed", () => ({ data: window.__feed || [], error: null }));
    m.onRpc("circle_week", () => ({ data: window.__week || [], error: null }));
    for (const n of ["toggle_reaction", "mark_recovery_verified"]) m.onRpc(n, ok(true));
    for (const n of ["set_weekly_target", "set_pause", "set_share_defaults", "update_circle", "leave_circle", "remove_member", "post_delete"]) m.onRpc(n, ok(null));
    m.onRpc("notif_unread_count", ok(0));
    m.onRpc("post_training_partners_for", ok([]));
    m.onRpc("create_circle_invite", ok("ab".repeat(32)));
    m.onRpc("create_circle", (args, ctx) => {
      m.db.circle_members.push({ club_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", user_id: ctx.currentUser.id, role: "owner", joined_at: "2026-10-02T00:00:00Z", share_defaults: {},
        clubs: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: args.p_name, type: args.p_type, emoji: args.p_emoji || "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ctx.currentUser.id } });
      return { data: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", error: null };
    });
    m.onRpc("join_circle", (args, ctx) => {
      const uid = ctx.currentUser.id;
      m.db.profiles.push({ id: uid, handle: "u" + uid.replace(/[^a-z0-9]/g, ""), display_name: null, emoji: "🙂", recovery_verified_at: null });
      m.db.circle_members.push({ club_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: uid, role: "member", joined_at: "2026-10-02T00:00:00Z", share_defaults: {},
        clubs: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: "x" } });
      return { data: { status: "joined", club_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null };
    });
    m.onRpc("mark_recovery_verified", (args, ctx) => {
      const p = m.db.profiles.find((x) => x.id === ctx.currentUser.id);
      if (p) p.recovery_verified_at = new Date().toISOString();
      return { data: true, error: null };
    });
  };
}

async function newPage(browser, tables, user, init) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, tables, user ? { user } : {});
  await page.addInitScript({ content: `(${circleRpcs().toString()})();` });
  if (init) await page.addInitScript({ content: init });
  return { page, errors };
}

// Layout facts about the page as it is right now.
const layout = (page) => page.evaluate(() => ({
  dir: getComputedStyle(document.documentElement).direction,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
const tapSize = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}, selector);

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);
const browser = await chromium.launch();

// ===========================================================================
// 1. Join through an invite link
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed({ profiles: [], circle_members: [] }), null);
  await page.goto(target.url + "#invite=" + TOKEN, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await page.waitForSelector('[data-community-action="start-signup"]', { timeout: 8000 });
  const url = page.url();
  check("join: the token is not left in the address bar", !url.includes(TOKEN) && !url.includes("#invite"), url);
  const l = await layout(page);
  check("join: the page is right-to-left", l.dir === "rtl", l.dir);
  check("join: no sideways scroll at 390px", l.scrollWidth <= l.clientWidth + 1, `${l.scrollWidth} vs ${l.clientWidth}`);
  const body = await page.textContent("#content");
  check("join: the invite landing says what the member was invited to", body.includes("הוזמנת להצטרף למעגל"));
  const calls0 = await page.evaluate(() => window.__mock.rpcCalls.map((c) => c.name));
  check("join: opening the link calls the server for nothing", calls0.every((n) => n === "notif_unread_count") , calls0.join(","));
  const btn = await tapSize(page, '[data-community-action="start-signup"]');
  check("join: the primary button is a 44px tap target", btn && btn.h >= 44, JSON.stringify(btn));

  await page.click('[data-community-action="start-signup"]');
  await page.waitForSelector("#communityCredentials", { timeout: 10000 });
  const joinCall = await page.evaluate(() => window.__mock.rpcCalls.filter((c) => c.name === "join_circle").map((c) => c.args));
  check("join: join_circle got the token from the fragment, once", joinCall.length === 1 && joinCall[0].p_token === TOKEN, JSON.stringify(joinCall));
  await page.fill('#communityCredentials input[name="username"]', "dana_k");
  await page.fill('#communityCredentials input[name="password"]', "Abcdefgh12");
  await page.fill('#communityCredentials input[name="passwordConfirm"]', "Abcdefgh12");
  await page.click('#communityCredentials button[type="submit"]');
  await page.waitForSelector("#communityProfile", { timeout: 10000 });
  const fields = await page.$$eval("#communityProfile input[name], #communityProfile textarea[name]", (els) => els.map((e) => e.name));
  check("join: the profile asks for a name and an emoji and nothing else", JSON.stringify(fields) === JSON.stringify(["displayName", "emoji"]), fields.join(","));
  await page.fill('#communityProfile input[name="displayName"]', "דנה כהן");
  await page.click('#communityProfile [data-community-action="c-emoji-pick"][data-emoji="🦁"]');
  await page.click('#communityProfile button[type="submit"]');
  await page.waitForSelector('[data-community-action="c-leave-ask"]', { timeout: 10000 });
  check("join: the member lands in the circle they were invited to", (await page.textContent("#content")).includes("החבר'ה"));
  const l2 = await layout(page);
  check("join: still no sideways scroll", l2.scrollWidth <= l2.clientWidth + 1);
  check("join: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 2. Create a circle
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed(), { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector('[data-community-action="c-create-open"]', { timeout: 8000 });
  await page.click('[data-community-action="c-create-open"]');
  await page.waitForSelector("#circleCreate", { timeout: 5000 });
  const sheet = await page.evaluate(() => {
    const s = document.querySelector('[data-cloud-dialog="circleSheet"] .modal-sheet');
    const r = s.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, vw: innerWidth };
  });
  check("create: the sheet fits the phone", sheet.top >= 0 && sheet.bottom <= sheet.vh + 1 && sheet.left >= -1 && sheet.right <= sheet.vw + 1, JSON.stringify(sheet));
  const submitBtn = await tapSize(page, '#circleCreate button[type="submit"]');
  check("create: the submit button is a 44px tap target and on screen", submitBtn && submitBtn.h >= 44 && submitBtn.bottom <= VIEWPORT.height, JSON.stringify(submitBtn));
  await page.click('#circleCreate label:has(input[value="couple"])');
  await page.fill('#circleCreate input[name="name"]', "אני והיא");
  await page.click('#circleCreate [data-community-action="c-emoji-pick"][data-emoji="🌟"]');
  await page.click('#circleCreate button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#circleCreate"), { timeout: 8000 });
  const call = await page.evaluate(() => window.__mock.rpcCalls.filter((c) => c.name === "create_circle").map((c) => c.args));
  check("create: create_circle got the type, name and emoji", call.length === 1 && call[0].p_type === "couple" && call[0].p_name === "אני והיא" && call[0].p_emoji === "🌟", JSON.stringify(call));
  const chips = await page.$$eval('[data-community-action="c-pick"]', (els) => els.map((e) => e.textContent.trim()));
  check("create: the switcher now lists both circles", chips.length === 2 && chips[1].includes("אני והיא"), chips.join(" | "));
  const l = await layout(page);
  check("create: the switcher does not widen the page", l.scrollWidth <= l.clientWidth + 1, `${l.scrollWidth} vs ${l.clientWidth}`);
  // The invite sheet: create, then the link and its two buttons.
  await page.click('[data-community-action="c-invite-open"]');
  await page.waitForSelector("#circleInvite", { timeout: 5000 });
  await page.click('#circleInvite button[type="submit"]');
  await page.waitForSelector("#circleInviteLink", { timeout: 5000 });
  const link = await page.inputValue("#circleInviteLink");
  const u = new URL(link);
  check("invite: the link carries the token after #, never in the query", u.hash === "#invite=" + TOKEN && u.search === "", link);
  const copy = await tapSize(page, '[data-community-action="c-invite-copy"]');
  check("invite: copy is a 44px tap target", copy && copy.h >= 44, JSON.stringify(copy));
  check("create: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 3. Log a workout and share it
// ===========================================================================
{
  const tables = seed({ circle_members: [membership(), membership({ id: B, name: "הזוג", type: "couple", emoji: "💞" })] });
  const { page, errors } = await newPage(browser, tables, { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await page.waitForFunction(() => window.communityCircleIds && window.communityCircleIds().length === 2, { timeout: 8000 });
  await switchTab(page, "tabAddBtn");
  await selectMovement(page, "Back Squat");
  await page.click("#bottomBarBtn");
  await dismissFirstLogArrival(page);
  await page.waitForSelector("[data-share-bar]", { timeout: 8000 });
  const bar = await page.evaluate(() => {
    const b = document.querySelector("[data-share-bar] > div").getBoundingClientRect();
    const nav = document.getElementById("bottomTabBar").getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, navTop: nav.top, vw: innerWidth, text: document.querySelector("[data-share-bar]").textContent.replace(/\s+/g, " ").trim() };
  });
  check("share: the bar says where the workout went", bar.text.includes("האימון שותף ב-2 מעגלים"), bar.text);
  check("share: the bar sits inside the screen and above the tab bar", bar.left >= 0 && bar.right <= bar.vw + 1 && bar.bottom <= bar.navTop + 1, JSON.stringify(bar));
  const posts = await page.evaluate(() => window.__mock.db.workout_posts.map((p) => ({ club: p.club_id, title: p.title, result: p.result_text, src: p.source_record_id })));
  const friends = posts.find((p) => p.club === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const couple = posts.find((p) => p.club === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  check("share: one post per circle, each with its club_id", posts.length === 2 && friends && couple, JSON.stringify(posts));
  check("share: the friends circle got a count only", friends && friends.title === null && friends.result === null, JSON.stringify(friends));
  check("share: the couple circle got the lift without its kilograms", couple && /Squat/.test(couple.title || "") && !/ק״ג/.test(couple.result || ""), JSON.stringify(couple));
  await page.click('[data-community-action="c-share-bar-change"]');
  await page.waitForSelector("[data-share-pick]", { timeout: 5000 });
  const picks = await page.$$eval("[data-share-pick]", (els) => els.map((e) => e.checked));
  check("share: the per-workout control shows both circles ticked", picks.length === 2 && picks.every(Boolean), picks.join(","));
  const apply = await tapSize(page, '[data-community-action="c-share-apply"]');
  check("share: the save button is a 44px tap target", apply && apply.h >= 44, JSON.stringify(apply));
  await page.click('[data-community-action="c-sheet-close"]');
  const l = await layout(page);
  check("share: no sideways scroll", l.scrollWidth <= l.clientWidth + 1);
  check("share: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 4. React
// ===========================================================================
const FEED = [
  { post_id: "p1", author_id: DANA, author_name: "דנה", author_emoji: "🦁", post_type: "POST_PR", title: "דדליפט", result_text: null, body: null,
    metadata: { movement: "דדליפט", improvement: "+5.0%" }, occurred_on: "2026-10-26", published_at: "2026-10-24T10:00:00Z", reaction_counts: {}, my_reactions: [], unreacted_pr: true },
  { post_id: "p2", author_id: DANA, author_name: "דנה", author_emoji: "🦁", post_type: "POST_WORKOUT", title: "סקוואט", result_text: "סקוואט 5 × 3", body: null,
    metadata: {}, occurred_on: "2026-10-26", published_at: "2026-10-26T10:00:00Z", reaction_counts: { fist_bump: 1 }, my_reactions: [], unreacted_pr: false },
];
{
  const { page, errors } = await newPage(browser, seed(), { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" },
    `window.__feed = ${JSON.stringify(FEED)};`);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector('article.post-card[data-post-id="p1"]', { timeout: 8000 });
  const order = await page.$$eval("article.post-card", (els) => els.map((e) => e.dataset.postId));
  check("react: the PR nobody reacted to is lifted above the newer post", order[0] === "p1", order.join(","));
  const lift = await page.evaluate(() => {
    const el = document.querySelector('[data-post-id="p1"]');
    return { cls: el.classList.contains("post-card--lift"), border: getComputedStyle(el).borderTopColor };
  });
  check("react: and drawn with the quiet highlight", lift.cls, JSON.stringify(lift));
  const kinds = await page.$$eval('[data-post-id="p2"] [data-community-action="react"]', (els) => els.map((e) => e.dataset.kind));
  check("react: exactly three reactions", JSON.stringify(kinds) === JSON.stringify(["fist_bump", "fire", "clap"]), kinds.join(","));
  const sizes = await page.$$eval('[data-post-id="p2"] [data-community-action="react"]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), left: Math.round(r.left) }; }));
  check("react: each one is a 44px tap target", sizes.every((s) => s.h >= 44 && s.w >= 44), JSON.stringify(sizes));
  check("react: the row reads right to left, fist bump first (rightmost)", sizes[0].right > sizes[1].right && sizes[1].right > sizes[2].right, JSON.stringify(sizes));
  for (const k of ["fist_bump", "fire", "clap"]) {
    await page.click(`[data-post-id="p2"] [data-community-action="react"][data-kind="${k}"]`);
    await page.waitForTimeout(40);
  }
  const pressed = await page.$$eval('[data-post-id="p2"] [data-community-action="react"]', (els) => els.map((e) => e.getAttribute("aria-pressed")));
  check("react: a member can hold all three at once", pressed.join(",") === "true,true,true", pressed.join(","));
  const sent = await page.evaluate(() => window.__mock.rpcCalls.filter((c) => c.name === "toggle_reaction").map((c) => c.args.p_kind));
  check("react: toggle_reaction got each kind", JSON.stringify(sent) === JSON.stringify(["fist_bump", "fire", "clap"]), sent.join(","));
  const l = await layout(page);
  check("react: no sideways scroll", l.scrollWidth <= l.clientWidth + 1, `${l.scrollWidth} vs ${l.clientWidth}`);
  check("react: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 5. The week
// ===========================================================================
const WEEK = [
  { user_id: DANA, display_name: "דנה", emoji: "🦁", workouts: 2, target: null, percent: 67, paused: false, weeks_met: 3 },
  { user_id: ME, display_name: "אני", emoji: "💪", workouts: 4, target: 3, percent: 133, paused: false, weeks_met: 1 },
  { user_id: "33333333-3333-4333-8333-333333333333", display_name: "גל", emoji: "🌿", workouts: null, target: null, percent: null, paused: true, weeks_met: null },
];
{
  const { page, errors } = await newPage(browser, seed(), { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" },
    `window.__week = ${JSON.stringify(WEEK)};`);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.click('[data-community-action="c-section"][data-section="week"]');
  await page.waitForSelector("[data-week-member]", { timeout: 8000 });
  const cards = await page.$$eval("[data-week-member]", (els) => els.map((e) => ({ id: e.dataset.weekMember, text: e.textContent.replace(/\s+/g, " ").trim() })));
  check("week: one card per member, in the server's order", cards.length === 3 && cards[0].id === DANA, cards.map((c) => c.id.slice(0, 2)).join(","));
  check("week: percent of their own target", cards[1].text.includes("133%") && cards[0].text.includes("67%"));
  check("week: the paused member is marked and has no percent", /בהפסקה/.test(cards[2].text) && !/%/.test(cards[2].text), cards[2].text);
  check("week: weeks met are shown", /3 שבועות עמדו ביעד/.test(cards[0].text));
  const bar = await page.evaluate((id) => {
    const track = document.querySelector(`[data-week-member="${id}"] .week-bar`);
    const fill = track.firstElementChild;
    const t = track.getBoundingClientRect(), f = fill.getBoundingClientRect();
    return { track: t.width, fill: f.width, right: t.right, fillRight: f.right };
  }, ME);
  check("week: the bar stops at full when the number does not", Math.abs(bar.fill - bar.track) <= 1, JSON.stringify(bar));
  check("week: and fills from the right, the reading side", Math.abs(bar.fillRight - bar.right) <= 1, JSON.stringify(bar));
  const l = await layout(page);
  check("week: no sideways scroll", l.scrollWidth <= l.clientWidth + 1);
  check("week: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}
// A couple circle: the two weeks side by side.
{
  const tables = seed({ circle_members: [membership({ id: B, name: "הזוג", type: "couple", emoji: "💞" })] });
  const { page, errors } = await newPage(browser, tables, { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" },
    `window.__week = ${JSON.stringify(WEEK.slice(0, 2))};`);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.click('[data-community-action="c-section"][data-section="week"]');
  await page.waitForSelector('[data-week-layout="pair"] [data-week-member]', { timeout: 8000 });
  const pair = await page.$$eval("[data-week-member]", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.weekMember, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
  check("couple: the two weeks are side by side (same row)", pair.length === 2 && Math.abs(pair[0].top - pair[1].top) < 2, JSON.stringify(pair));
  check("couple: the first is on the right, the reading side", pair[0].right > pair[1].right, JSON.stringify(pair));
  check("couple: neither card leaves the screen", pair.every((p) => p.left >= 0 && p.right <= VIEWPORT.width), JSON.stringify(pair));
  const l = await layout(page);
  check("couple: no sideways scroll", l.scrollWidth <= l.clientWidth + 1);
  check("couple: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
