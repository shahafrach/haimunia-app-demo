#!/usr/bin/env node
// Home in a real Chromium, RTL, at 390x844, in all three states: signed out,
// signed in with no circle, signed in with circles. Home is about the member's own
// training (from the device), with one compact circles card; the gate, feed, week
// and invites belong to the Circle tab. test/home-screen.test.mjs proves the logic in
// jsdom; this measures what jsdom cannot: that the screen is right to left, nothing
// scrolls sideways, the controls are real tap targets, and the ring and the circles
// card fit a phone.
//
// The backend is the in-page mock (lib/mockCloud.mjs); nothing here reaches a real project.
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
const ME = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERIFIED = new Date().toISOString();
const club = { id: A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME };
const seed = (circles) => ({
  profiles: [{ id: ME, handle: "member_me", display_name: "אני", emoji: "💪", recovery_verified_at: VERIFIED }],
  circle_members: circles ? [{ club_id: A, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: club }] : [],
  member_targets: [{ user_id: ME, paused_until: null }], circle_targets: [{ club_id: A, user_id: ME, weekly_target: 3 }], post_training_partners: [], workout_posts: [], benchmark_results: [], blocks: [], reactions: [],
  notifications: [], notification_preferences: [], analytics_events: [], invite_redemptions: [],
});
const FEED = [1, 2, 3, 4].map((n) => ({ post_id: "p" + n, author_id: "f", author_name: "דנה", author_emoji: "🦁", post_type: "POST_TEXT", title: "פוסט " + n, result_text: "", body: "", metadata: {}, occurred_on: "2026-10-2" + n, published_at: "2026-10-2" + n + "T10:00:00Z", reaction_counts: {}, my_reactions: [] }));

function rpcs() {
  const m = window.__mock;
  const ok = (data) => () => ({ data, error: null });
  m.onRpc("circle_feed", ok(window.__feed));
  m.onRpc("circle_week", ok([]));
  m.onRpc("notif_unread_count", ok(0));
  m.onRpc("post_training_partners_for", ok([]));
  m.onRpc("mark_recovery_verified", ok(true));
}
async function open(browser, tables, user, feed) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, tables, user ? { user } : {});
  await page.addInitScript({ content: `window.__feed = ${JSON.stringify(feed || [])};` });
  await page.addInitScript({ content: `(${rpcs.toString()})();` });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  // A week of training in the device's own log.
  await page.evaluate(async () => {
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    const rows = [[60, 14], [60, 10], [60, 7], [70, 0]];
    let i = 0;
    for (const [weight, ago] of rows) {
      await window.dbPut({ id: "seed-" + i, ts: Date.now() - i * 1000 - ago * 86400000, updatedAt: Date.now(), exerciseId: "back-squat", type: "reps", weight, reps: 5, sets: 1, date: day(ago), isPR: false, est1RM: 0, durationSeconds: 0, groupId: null, blockLabel: "" });
      i++;
    }
    await window.reloadFromDb();
    window.switchAppTab("home");
  });
  await page.waitForSelector("[data-home-circles]", { timeout: 8000 });
  return { page, errors };
}
const box = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, right: r.right };
}, sel);
const fits = (b) => b && b.left >= -1 && b.right <= VIEWPORT.width + 1;

async function common(label, page, errors) {
  const l = await page.evaluate(() => ({ dir: getComputedStyle(document.documentElement).direction, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`${label}: right to left`, l.dir === "rtl", l.dir);
  check(`${label}: no sideways scroll at 390px`, l.sw <= l.cw + 1, `${l.sw} vs ${l.cw}`);
  const ring = await box(page, "[data-week-ring] .week-ring");
  check(`${label}: the ring is there and inside the screen`, ring && ring.w > 60 && fits(ring), JSON.stringify(ring));
  check(`${label}: "N done / N left" wording and weeks met are there`, await page.evaluate(() => /מתוך 3 אימונים השבוע/.test(document.body.innerText) && !!document.querySelector("[data-weeks-met]")));
  const same = await box(page, '[data-action="log-same-lift"]');
  check(`${label}: log-the-same-lift is a 44px tap target inside the screen`, same && same.h >= 44 && fits(same), JSON.stringify(same));
  const cta = await box(page, ".home-log-cta");
  check(`${label}: the log button is inside the screen`, cta && cta.h >= 44 && fits(cta), JSON.stringify(cta));
  check(`${label}: latest PRs with a percent`, await page.evaluate(() => /\+\d+(\.\d+)?%/.test((document.querySelector("[data-home-prs]") || {}).textContent || "")));
  check(`${label}: no Circle-tab furniture on Home`, await page.evaluate(() => !document.querySelector('[data-community-action="c-section"], [data-community-action="c-invite-open"], #circleJoin, #communityLogin')));
  check(`${label}: no console errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);
const browser = await chromium.launch();

{ // 1. signed out
  const { page, errors } = await open(browser, seed(false), null);
  await common("signed out", page, errors);
  const card = await page.evaluate(() => { const c = document.querySelector('[data-home-circles="none"]'); return c ? { buttons: c.querySelectorAll("button").length, text: c.innerText } : null; });
  check("signed out: one compact circles card with create and join", card && card.buttons === 2, JSON.stringify(card));
  for (const b of await page.$$eval('[data-home-circles="none"] button', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { h: r.height, l: r.left, r: r.right }; }))) {
    check("signed out: a circles button is a 44px target inside the screen", b.h >= 44 && b.l >= -1 && b.r <= VIEWPORT.width + 1, JSON.stringify(b));
  }
  await page.close();
}
{ // 2. signed in, no circle
  const { page, errors } = await open(browser, seed(false), { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" });
  await common("no circle", page, errors);
  check("no circle: greeting with the member's name and the avatar to Me", await page.evaluate(() => !!document.getElementById("communityHead") && /אני/.test(document.getElementById("communityHead").innerText) && !!document.querySelector('[data-community-action="c-open-me"]')));
  check("no circle: create and join are on Home", await page.evaluate(() => !!document.querySelector('[data-home-circles="none"] [data-community-action="c-create-open"]') && !!document.querySelector('[data-home-circles="none"] [data-community-action="c-join-open"]')));
  await page.close();
}
{ // 3. signed in, with a circle
  const { page, errors } = await open(browser, seed(true), { id: ME, is_anonymous: false, email: "me@members.haimuniya.invalid" }, FEED);
  await page.waitForSelector("[data-home-posts]", { timeout: 8000 });
  await common("circles", page, errors);
  const n = await page.$$eval("[data-home-posts] .log-row", (els) => els.length);
  check("circles: the list and the latest three posts", n === 3 && (await page.$$eval('[data-community-action="c-open-circle"]', (e) => e.length)) === 1, String(n));
  const row = await box(page, '[data-community-action="c-open-circle"]');
  check("circles: the circle row is a 44px target inside the screen", row && row.h >= 44 && fits(row), JSON.stringify(row));
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
