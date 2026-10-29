#!/usr/bin/env node
// The founder link in a real Chromium, RTL, at 390x844 (docs/ops/FOUNDER_LINK.md).
// Two halves of one flow: a member makes the "start your own circle" link in Me
// and shares or copies it; a friend opens it, signs up, and lands on the
// create-circle sheet. test/founder-link.test.mjs proves the logic in jsdom;
// this proves what jsdom cannot see: that the Me panel and both sheets fit a
// phone, that the controls are real tap targets, that the link is shown left
// to right inside a right-to-left page, and that nothing scrolls sideways.
//
// The backend is the in-page mock (lib/mockCloud.mjs); nothing here reaches a
// real project.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
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
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "cd".repeat(32);
const FOUNDER_URL = "https://box-log.pages.dev/#invite=" + TOKEN;

function club(over) {
  return Object.assign({ id: A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME }, over);
}
function membership() {
  const c = club();
  return { club_id: c.id, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: c };
}
function seed(over) {
  return Object.assign({
    profiles: [{ id: ME, handle: "member_me", display_name: "אני", emoji: "💪", recovery_verified_at: VERIFIED }],
    circle_members: [membership()],
    member_targets: [], post_training_partners: [], workout_posts: [], benchmark_results: [], blocks: [], reactions: [],
    notifications: [], notification_preferences: [], analytics_events: [], invite_redemptions: [],
  }, over || {});
}

// Stand-ins for the RPCs, registered in the page before the app boots.
function founderRpcs(founderUrl) {
  return () => {
    const m = window.__mock;
    const ok = (data) => () => ({ data: data === undefined ? null : data, error: null });
    m.onRpc("circle_feed", ok([]));
    m.onRpc("circle_week", ok([]));
    m.onRpc("notif_unread_count", ok(0));
    m.onRpc("post_training_partners_for", ok([]));
    m.onRpc("mark_recovery_verified", (args, ctx) => {
      const p = m.db.profiles.find((x) => x.id === ctx.currentUser.id);
      if (p) p.recovery_verified_at = new Date().toISOString();
      return { data: true, error: null };
    });
    m.onRpc("create_founder_invite", ok(window.__founderUrl));
    // The friend's side: join_circle does not know a founder token.
    m.onRpc("join_circle", ok({ status: "invalid" }));
    m.onRpc("redeem_invite_code", (args, ctx) => {
      m.db.invite_redemptions.push({ user_id: ctx.currentUser.id, invite_id: "inv-founder", role: "member", redeemed_at: new Date().toISOString() });
      return { data: "member", error: null };
    });
    m.onRpc("create_circle", (args, ctx) => {
      m.db.circle_members.push({ club_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", user_id: ctx.currentUser.id, role: "owner", joined_at: "2026-10-02T00:00:00Z", share_defaults: {},
        clubs: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: args.p_name, type: args.p_type, emoji: args.p_emoji || "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ctx.currentUser.id } });
      return { data: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", error: null };
    });
  };
}

async function newPage(browser, tables, user) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, tables, user ? { user } : {});
  await page.addInitScript({ content: `window.__founderUrl = ${JSON.stringify(FOUNDER_URL)};` });
  await page.addInitScript({ content: `(${founderRpcs().toString()})();` });
  return { page, errors };
}

const layout = (page) => page.evaluate(() => ({
  dir: getComputedStyle(document.documentElement).direction,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
const box = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}, selector);
const inView = (b) => b && b.left >= -1 && b.right <= VIEWPORT.width + 1 && b.bottom <= VIEWPORT.height + 1;

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);
const browser = await chromium.launch();

// ===========================================================================
// 1. The member: Me, the action, the sheet, the link
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed(), { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" });
  await page.addInitScript({ content: "window.__shared = []; navigator.share = async (d) => { window.__shared.push(d); };" });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await page.evaluate(() => window.switchAppTab("me"));
  await page.waitForSelector("#founderLinkPanel", { timeout: 8000 });
  await page.locator("#founderLinkPanel").scrollIntoViewIfNeeded();
  const l = await layout(page);
  check("me: the page is right-to-left", l.dir === "rtl", l.dir);
  check("me: no sideways scroll at 390px", l.scrollWidth <= l.clientWidth + 1, `${l.scrollWidth} vs ${l.clientWidth}`);
  const panel = await page.textContent("#founderLinkPanel");
  check("me: the action and its one-line explanation are there", panel.includes("קישור לחבר שרוצה מעגל משלו") && panel.includes("מעגל משלהם"), panel);
  const open = await box(page, '[data-community-action="c-founder-open"]');
  check("me: the action is a 44px tap target inside the screen", open && open.h >= 44 && inView(open), JSON.stringify(open));
  check("me: opening Me made no link", (await page.evaluate(() => window.__mock.rpcCalls.filter((c) => c.name === "create_founder_invite").length)) === 0);

  await page.click('[data-community-action="c-founder-open"]');
  await page.waitForSelector('[data-community-action="c-founder-create"]', { timeout: 5000 });
  const sheet = await page.evaluate(() => {
    const r = document.querySelector('[data-cloud-dialog="circleSheet"] .modal-sheet').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, vw: innerWidth };
  });
  check("sheet: it fits the phone", sheet.top >= 0 && sheet.bottom <= sheet.vh + 1 && sheet.left >= -1 && sheet.right <= sheet.vw + 1, JSON.stringify(sheet));
  const create = await box(page, '[data-community-action="c-founder-create"]');
  check("sheet: create is a 44px tap target and on screen", create && create.h >= 44 && inView(create), JSON.stringify(create));
  await page.click('[data-community-action="c-founder-create"]');
  await page.waitForSelector("#founderLink", { timeout: 5000 });
  const link = await page.inputValue("#founderLink");
  check("sheet: the link has the token after #, never in the query", new URL(link).hash === "#invite=" + TOKEN && new URL(link).search === "", link);
  check("sheet: the link field reads left to right", (await page.evaluate(() => getComputedStyle(document.getElementById("founderLink")).direction)) === "ltr");
  const field = await box(page, "#founderLink");
  check("sheet: the link field stays inside the screen", inView(field), JSON.stringify(field));
  for (const sel of ['[data-community-action="c-founder-share"]', '[data-community-action="c-founder-copy"]']) {
    const b = await box(page, sel);
    check(`sheet: ${sel.match(/c-founder-\w+/)[0]} is a 44px tap target on screen`, b && b.h >= 44 && inView(b), JSON.stringify(b));
  }
  await page.click('[data-community-action="c-founder-share"]');
  await page.waitForFunction(() => window.__shared.length === 1, null, { timeout: 5000 });
  const shared = await page.evaluate(() => window.__shared[0]);
  check("sheet: Web Share got the link as its url", shared.url === FOUNDER_URL, JSON.stringify(shared));
  const l2 = await layout(page);
  check("sheet: still no sideways scroll", l2.scrollWidth <= l2.clientWidth + 1, `${l2.scrollWidth} vs ${l2.clientWidth}`);
  check("me: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 2. The friend: open the link, sign up, land on the create-circle sheet
// ===========================================================================
{
  const { page, errors } = await newPage(browser, seed({ profiles: [], circle_members: [] }), null);
  await page.goto(target.url + "#invite=" + TOKEN, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await page.waitForSelector('[data-community-action="start-signup"]', { timeout: 8000 });
  check("friend: the token is not left in the address bar", !page.url().includes(TOKEN) && !page.url().includes("#invite"), page.url());
  await page.click('[data-community-action="start-signup"]');
  await page.waitForSelector("#communityCredentials", { timeout: 10000 });
  const redeem = await page.evaluate(() => window.__mock.rpcCalls.filter((c) => c.name === "redeem_invite_code").map((c) => c.args.p_code));
  check("friend: the token was redeemed once", redeem.length === 1 && redeem[0] === TOKEN, JSON.stringify(redeem));
  check("friend: and joined no circle", (await page.evaluate(() => window.__mock.db.circle_members.length)) === 0);
  await page.fill('#communityCredentials input[name="username"]', "noa_levi");
  await page.fill('#communityCredentials input[name="password"]', "Abcdefgh12");
  await page.fill('#communityCredentials input[name="passwordConfirm"]', "Abcdefgh12");
  await page.click('#communityCredentials button[type="submit"]');
  await page.waitForSelector("#communityProfile", { timeout: 10000 });
  await page.fill('#communityProfile input[name="displayName"]', "נועה לוי");
  await page.click('#communityProfile [data-community-action="c-emoji-pick"][data-emoji="🦁"]');
  await page.click('#communityProfile button[type="submit"]');
  await page.waitForSelector("#circleCreate", { timeout: 10000 });
  check("friend: they land on the create-circle sheet", true);
  const sheet = await page.evaluate(() => {
    const r = document.querySelector('[data-cloud-dialog="circleSheet"] .modal-sheet').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, vw: innerWidth };
  });
  check("friend: the sheet fits the phone", sheet.top >= 0 && sheet.bottom <= sheet.vh + 1 && sheet.left >= -1 && sheet.right <= sheet.vw + 1, JSON.stringify(sheet));
  const l = await layout(page);
  check("friend: right-to-left, no sideways scroll", l.dir === "rtl" && l.scrollWidth <= l.clientWidth + 1, JSON.stringify(l));
  await page.fill('#circleCreate input[name="name"]', "המעגל של נועה");
  await page.click('#circleCreate button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#circleCreate"), null, { timeout: 8000 });
  const made = await page.evaluate(() => window.__mock.rpcCalls.filter((c) => c.name === "create_circle").map((c) => c.args.p_name));
  check("friend: their own circle was created", made.length === 1 && made[0] === "המעגל של נועה", JSON.stringify(made));
  check("friend: no console errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
