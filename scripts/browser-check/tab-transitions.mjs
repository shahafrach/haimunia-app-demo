#!/usr/bin/env node
// Every tab to every other tab, asserted on what is visible, at 390px.
//
// THE BUG (reported on the Design preview): after tapping Circle, tapping
// another tab stayed on Circle. Circle loads its data asynchronously and the
// app re-rendered the bottom bar each time, replacing the button under a
// finger mid-tap, so the click landed on a detached node and was lost.
//
// Three passes over all 12 ordered pairs of the four tabs:
//   1. a plain tap, after the destination had time to settle;
//   2. a tap with a re-render forced between pointer down and pointer up, the
//      exact interleaving a slow phone produces (this fails without the fix);
//   3. two quick taps in a row, with the data of the first screen still loading.
// "Visible screen" is the page's own h1 plus the active tab, so a tab that is
// highlighted but still showing the old screen fails too.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, consoleErrorCollector } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  if (!ok) { failed = true; console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`); }
  return ok;
}
const ME = "11111111-1111-4111-8111-111111111111", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", V = new Date().toISOString();
const club = { id: A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME };
const seed = { profiles: [{ id: ME, handle: "m", display_name: "אני", emoji: "💪", recovery_verified_at: V }], circle_members: [{ club_id: A, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: club }], member_targets: [], post_training_partners: [], workout_posts: [], benchmark_results: [], blocks: [], reactions: [], notifications: [], notification_preferences: [], analytics_events: [] };
const TABS = [["tabHomeBtn", "בית"], ["tabCommunityBtn", "מעגל"], ["tabAddBtn", "סיכום אימון"], ["tabHistoryBtn", "התקדמות"]];

const target = await resolveLocalOnlyTarget();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const errors = await consoleErrorCollector(page);
await installMockCloud(page, seed, { user: { id: ME, is_anonymous: false } });
await page.addInitScript(() => {
  const m = window.__mock;
  // A slow circle feed: the re-render lands while the next tap is in flight.
  m.onRpc("circle_feed", () => new Promise((r) => setTimeout(() => r({ data: [], error: null }), 250)));
  m.onRpc("circle_week", () => ({ data: [], error: null }));
  m.onRpc("notif_unread_count", () => ({ data: 0, error: null }));
  m.onRpc("post_training_partners_for", () => ({ data: [], error: null }));
});
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible" });
await dismissWelcomeModal(page);

const screenNow = () => page.evaluate(() => ({ h1: (document.querySelector("#content h1") || {}).textContent, active: (document.querySelector("#bottomTabBar .tabbtn.active") || {}).id }));
async function expectScreen(label, id, h1) {
  await page.waitForFunction(([i, t]) => (document.querySelector("#bottomTabBar .tabbtn.active") || {}).id === i && ((document.querySelector("#content h1") || {}).textContent || "").includes(t), [id, h1], { timeout: 3000 }).catch(() => {});
  const s = await screenNow();
  return check(label, s.active === id && (s.h1 || "").includes(h1), `active=${s.active} screen="${s.h1}"`);
}
let n = 0;
for (const [from, ] of TABS) for (const [to, h1] of TABS) {
  if (from === to) continue;
  // 1. plain
  await page.click("#" + from); await page.waitForTimeout(350);
  await page.click("#" + to);
  n += +(await expectScreen(`${from} -> ${to}`, to, h1));
  // 2. a re-render between pointer down and up
  await page.click("#" + from); await page.waitForTimeout(350);
  const box = await page.locator("#" + to).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => window.render());
  await page.mouse.up();
  n += +(await expectScreen(`${from} -> ${to} with a re-render mid-tap`, to, h1));
  // 3. two quick taps, the first screen still loading
  await page.click("#" + from);
  await page.click("#" + to);
  n += +(await expectScreen(`${from} -> ${to} straight after`, to, h1));
}
check("12 pairs, three ways each, all land on the screen that was tapped", n === 36, `${n}/36`);
check("no console errors", errors.length === 0, errors.join(" | "));
console.log(failed ? "\ntab-transitions: FAILED" : `\ntab-transitions: all ${n} transitions land on the tapped screen`);
await browser.close(); await target.close();
process.exit(failed ? 1 : 0);
