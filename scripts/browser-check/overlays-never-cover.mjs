#!/usr/bin/env node
// Nothing may cover a control the member is about to tap.
//
// The first end-to-end user tests (docs/qa/user-tests-2026-10.md, finding 4)
// found three things sitting on top of the control under a thumb: the circles'
// share bar over the save button for its twelve seconds, the medal prompt over
// the backup question's two buttons, and the tab bar over the account button
// once the page was scrolled the way the browser scrolls a field into view.
// jsdom has no layout, so this is a real Chromium at 390x844 (RTL), and every
// check is the same three steps a thumb takes: bring the control into view the
// way a person or the browser would, ask which element is under its centre
// (document.elementFromPoint), and press there with the mouse, not at the element.
//
// Local-only, against the in-page mock backend (lib/mockCloud.mjs).
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
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "ab".repeat(32);
const MEMBER = { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" };

function club(over) {
  return Object.assign({ id: A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME }, over);
}
function seed(over) {
  const c = club();
  return Object.assign({
    profiles: [{ id: ME, handle: "member_me", display_name: "אני", emoji: "💪", recovery_verified_at: VERIFIED }],
    circle_members: [{ club_id: c.id, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: c }],
    member_targets: [], post_training_partners: [], workout_posts: [], benchmark_results: [], blocks: [], reactions: [],
    notifications: [], notification_preferences: [], analytics_events: [],
  }, over || {});
}

// The Circles RPCs, as small stand-ins (same shapes rpcs.md lists).
function circleRpcs() {
  return () => {
    const m = window.__mock;
    const ok = (data) => () => ({ data: data === undefined ? null : data, error: null });
    m.onRpc("circle_feed", () => ({ data: [], error: null }));
    m.onRpc("circle_week", () => ({ data: [], error: null }));
    m.onRpc("notif_unread_count", ok(0));
    m.onRpc("post_training_partners_for", ok([]));
    m.onRpc("mark_recovery_verified", ok(true));
    m.onRpc("pr_share", ok("pr-post-1"));
    m.onRpc("join_circle", (args, ctx) => {
      const uid = ctx.currentUser.id;
      m.db.profiles.push({ id: uid, handle: "u" + uid.replace(/[^a-z0-9]/g, ""), display_name: null, emoji: "🙂", recovery_verified_at: null });
      m.db.circle_members.push({ club_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: uid, role: "member", joined_at: "2026-10-02T00:00:00Z", share_defaults: {},
        clubs: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: "x" } });
      return { data: { status: "joined", club_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null };
    });
  };
}

async function newPage(browser, tables, user) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, tables, user ? { user } : {});
  await page.addInitScript({ content: `(${circleRpcs().toString()})();` });
  return { page, errors };
}

// What is under the centre of a control right now, and whether it is the control.
const hitTest = (page, selector) => page.evaluate((sel) => {
  const el = [...document.querySelectorAll(sel)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  const label = (n) => n ? (n.getAttribute("data-cloud-dialog") || n.id || n.getAttribute("data-share-bar") && "share-bar" || n.className || n.tagName) + "" : "nothing";
  return { found: true, ok: !!hit && (el === hit || el.contains(hit)), x: Math.round(x), y: Math.round(y), by: label(hit && hit.closest("[data-cloud-dialog], .modal-overlay, [data-share-bar], #bottomNavWrap")) || label(hit) };
}, selector);
// Bring a control into view the way the browser does for a focused field.
const scrollLikeTheBrowser = (page, selector) => page.evaluate((sel) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0);
  if (el) el.scrollIntoView({ block: "nearest" });
}, selector);
async function pressAtCentre(page, selector) {
  const t = await hitTest(page, selector);
  await page.mouse.click(t.x, t.y);
  return t;
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);
const browser = await chromium.launch();

// ===========================================================================
// 1. The share bar never covers the save button
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed(), MEMBER);
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app", { state: "visible", timeout: 15000 });
  await dismissWelcomeModal(page);
  await page.waitForFunction(() => window.communityCircleIds && window.communityCircleIds().length === 1, { timeout: 8000 });
  await switchTab(page, "tabAddBtn");
  await selectMovement(page, "Back Squat");
  await page.click("#bottomBarBtn");
  await dismissFirstLogArrival(page);
  await page.waitForSelector("[data-share-bar]", { timeout: 8000 });
  const geo = await page.evaluate(() => {
    const bar = document.querySelector("[data-share-bar] > div").getBoundingClientRect();
    const save = document.getElementById("bottomBarBtn").getBoundingClientRect();
    return { barBottom: bar.bottom, saveTop: save.top, saveVisible: save.height > 0 };
  });
  check("share bar: the save button is on screen while the bar is up", geo.saveVisible);
  check("share bar: the bar ends above the save button", geo.barBottom <= geo.saveTop + 1, `bar bottom ${Math.round(geo.barBottom)}, save top ${Math.round(geo.saveTop)}`);
  const t = await hitTest(page, "#bottomBarBtn");
  check("share bar: the centre of the save button is the save button", t.ok, `covered by ${t.by}`);
  const before = await page.evaluate(() => entries.length);
  await pressAtCentre(page, "#bottomBarBtn");
  await page.waitForFunction((n) => entries.length === n + 1, before, { timeout: 5000 }).then(
    () => check("share bar: pressing there saves the next set", true),
    () => check("share bar: pressing there saves the next set", false, "no new entry"));
  check("share bar: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 2. The medal prompt waits for the backup question
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed(), MEMBER);
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app", { state: "visible", timeout: 15000 });
  await dismissWelcomeModal(page);
  await page.waitForFunction(() => window.communityCircleIds && window.communityCircleIds().length === 1, { timeout: 8000 });
  await switchTab(page, "tabAddBtn");
  await selectMovement(page, "Back Squat");
  await page.click("#bottomBarBtn");
  await dismissFirstLogArrival(page);
  await page.waitForSelector("[data-action='backup-consent-yes']", { timeout: 8000 });
  // The share bar from that first save is not what this section is about.
  await page.evaluate(() => { const x = document.querySelector('[data-community-action="c-share-bar-close"]'); if (x) x.click(); });
  await page.evaluate(() => window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-1", visibility: "club" }));
  await page.waitForTimeout(400);
  check("backup question: a medal that unlocks meanwhile does not open", (await page.$("#achUnlock")) === null);
  await scrollLikeTheBrowser(page, "[data-action='backup-consent-yes']");
  const yes = await hitTest(page, "[data-action='backup-consent-yes']");
  const no = await hitTest(page, "[data-action='backup-consent-no']");
  check("backup question: nothing is over the yes button", yes.ok, `covered by ${yes.by}`);
  check("backup question: nothing is over the no button", no.ok, `covered by ${no.by}`);
  await pressAtCentre(page, "[data-action='backup-consent-no']");
  await page.waitForSelector("#achUnlock", { timeout: 6000 }).then(
    () => check("backup question: once it is answered the medal is offered", true),
    () => check("backup question: once it is answered the medal is offered", false, "the medal never opened"));
  const notNow = await hitTest(page, '[data-cloud-dialog="achUnlock"] [data-community-action="ach-not-now"]');
  check("medal prompt: its own buttons are reachable", notNow.ok, `covered by ${notNow.by}`);
  check("backup question: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 3. The tab bar never covers the account button
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed({ profiles: [], circle_members: [] }), null);
  await page.goto(target.url + "#invite=" + TOKEN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app", { state: "visible", timeout: 15000 });
  await dismissWelcomeModal(page);
  await page.waitForSelector('[data-community-action="start-signup"]', { timeout: 8000 });
  await page.click('[data-community-action="start-signup"]');
  await page.waitForSelector("#communityCredentials", { timeout: 10000 });
  await page.fill('#communityCredentials input[name="username"]', "dana_k");
  await page.fill('#communityCredentials input[name="password"]', "Abcdefgh12");
  await page.fill('#communityCredentials input[name="passwordConfirm"]', "Abcdefgh12");
  await scrollLikeTheBrowser(page, '#communityCredentials button[type="submit"]');
  const geo = await page.evaluate(() => {
    const b = document.querySelector('#communityCredentials button[type="submit"]').getBoundingClientRect();
    const nav = document.getElementById("bottomNavWrap").getBoundingClientRect();
    return { bottom: b.bottom, navTop: nav.top };
  });
  check("account button: scrolled into view, it ends above the tab bar", geo.bottom <= geo.navTop, `button bottom ${Math.round(geo.bottom)}, bars start at ${Math.round(geo.navTop)}`);
  const t = await hitTest(page, '#communityCredentials button[type="submit"]');
  check("account button: the centre of the button is the button", t.ok, `covered by ${t.by}`);
  await pressAtCentre(page, '#communityCredentials button[type="submit"]');
  await page.waitForSelector("#communityProfile", { timeout: 10000 }).then(
    () => check("account button: pressing there creates the account", true),
    () => check("account button: pressing there creates the account", false, "the profile step never came"));
  check("account button: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 4. A share is confirmed where the member is: the Log tab too
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed(), MEMBER);
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app", { state: "visible", timeout: 15000 });
  await dismissWelcomeModal(page);
  await page.waitForFunction(() => window.communityCircleIds && window.communityCircleIds().length === 1, { timeout: 8000 });
  await switchTab(page, "tabAddBtn");
  await page.evaluate(() => window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-1", movement: "סקוואט", new_result: "105 ק״ג × 5", previous_result: "100 ק״ג × 5", improvement: "+5 ק״ג", new_value_numeric: 105, previous_value_numeric: 100 } }));
  await page.waitForSelector('[data-community-action="pr-share"]', { timeout: 8000 });
  await pressAtCentre(page, '[data-community-action="pr-share"]');
  await page.waitForFunction(() => /השיא שותף/.test((document.getElementById("appToastDock") || {}).innerText || ""), null, { timeout: 5000 }).then(
    () => check("share confirmation: the Log tab says the PR was shared", true),
    () => check("share confirmation: the Log tab says the PR was shared", false, "nothing in the toast dock"));
  const dock = await hitTest(page, "#bottomBarBtn");
  check("share confirmation: and the toast does not cover the save button", dock.ok || dock.found === false, `covered by ${dock.by}`);
  check("share confirmation: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
