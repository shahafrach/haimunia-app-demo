#!/usr/bin/env node
// THE FEED RERENDER STORM, measured rather than argued about.
//
// rerender() rebuilds the whole tab with one innerHTML write - deliberate,
// spiked and kept (COMM-366, ~4.9 ms). Fine once. The problem was three
// PER-ITEM loaders each calling it on every response: ensureReactionsLoaded()
// fires one loadReactionsFor() per rendered card, and resolveAvatarUrl() /
// resolvePhotoUrl() one signed-URL request per image.
//
// This script counts full window.render() calls during one member action and
// attributes each to the stack that caused it, so "the feed rerenders too
// much" becomes a number with a line of code attached to it.
//
// Measured 2026-09-16, 30-post feed, one scroll to the bottom:
//   before  11 rebuilds, 20.2 ms  (8 of them from loadReactionsFor alone)
//   after    4 rebuilds,  8.5 ms  (the 8 became one coalesced flush)
//
// Local static server + the in-page mock backend only, never TARGET_URL -
// the same rule every other scenario in this directory follows.
//
// Usage: node scripts/browser-check/feed-rerender-storm.mjs
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

const VERIFIED = new Date().toISOString();
const FEED_ROWS = 30;
function feedRow(i) {
  return {
    id: "p" + i,
    post_type: "POST_TEXT",
    author_id: "u" + ((i % 2) + 1),
    author: { display_name: i % 2 ? "נועם" : "דנה", handle: i % 2 ? "noam" : "dana" },
    body: "פוסט מספר " + i + " - טקסט לדוגמה שמייצג פוסט רגיל באורך סביר בפיד של המועדון.",
    visibility: "club",
    created_at: new Date(Date.now() - i * 60000).toISOString(),
    published_at: new Date(Date.now() - i * 60000).toISOString(),
    reaction_count: i % 7,
    comment_count: i % 4,
    media: [],
    metadata: {},
  };
}

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  feed_page_rows: Array.from({ length: FEED_ROWS }, (_, i) => feedRow(i)),
  feed_impressions: [], feed_interactions: [], hidden_posts: [], saved_posts: [],
  private_records: [], follows: [], blocks: [], analytics_events: [],
  attendance_log: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)\n`);

// EVERY EXIT PATH HAS TO CLOSE THE STATIC SERVER, not just the happy one.
//
// resolveLocalOnlyTarget() starts a local HTTP server, and an open server
// handle keeps node alive. Measured rather than assumed, because the obvious
// theory was wrong: a script that THROWS exits fine (node rejects the
// top-level await and terminates, exit 1), while a script that finishes
// NORMALLY without closing the server hangs forever (exit 124 under a
// timeout). So the dangerous path is not the loud one.
//
// This script reaches process.exit() on its own happy path, which is why it
// survived locally. What it did not survive is any await that never settles -
// browser.close() on a wedged chromium is the usual one in CI - because then
// process.exit() is never reached and the open server does the rest.
// run-all.mjs spawns these synchronously, so "never returns" is not this
// script hanging, it is CI hanging: the browser-checks job sat in_progress
// for four hours on 2026-09-17, reporting nothing.
//
// community-render-cost.mjs closes both the browser and the target; this file
// was added beside it and closed only the browser. Sibling drift again.
// run-all.mjs now also kills anything that overruns, because a cleanup block
// cannot help an await that never returns.
let failed = false;
let browser;
try {
const launched = await chromium.launch();
browser = launched;
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
// test/helpers/mockSupabase.mjs's feed_page() stand-in base64s its cursor
// through node's Buffer, which does not exist in a browser - so it throws the
// moment it has any row to page, and the feed comes back empty. Every other
// community browser scenario seeds feed_page_rows: [] and never hits it; this
// one is the first that needs a NON-empty feed, so it brings its own minimal
// Buffer shim rather than editing the shared mock out from under the jsdom
// suite. Only the two calls that mock makes are implemented.
await page.addInitScript(() => {
  if (typeof globalThis.Buffer !== "undefined") return;
  globalThis.Buffer = {
    from(input, enc) {
      if (enc === "base64") { const bin = atob(String(input)); return { toString: () => bin }; }
      const s = String(input);
      return { toString: (e) => (e === "base64" ? btoa(s) : s) };
    },
  };
});
await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector("#communityFeedList .post-card", { timeout: 10000 });

// Instrument: count every full window.render() and total the time they take.
await page.evaluate(() => {
  const real = window.render;
  window.__storm = { n: 0, ms: 0, stacks: [] };
  window.render = function () {
    const t0 = performance.now();
    const r = real.apply(this, arguments);
    window.__storm.n += 1;
    window.__storm.ms += performance.now() - t0;
    const st = (new Error().stack || "").split("\n").slice(2, 4).join(" | ");
    window.__storm.stacks.push(st);
    return r;
  };
});

async function burst(label, act) {
  await page.evaluate(() => { window.__storm.n = 0; window.__storm.ms = 0; window.__storm.stacks = []; });
  await act();
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({ n: window.__storm.n, ms: window.__storm.ms, stacks: window.__storm.stacks }));
  const counts = {};
  for (const s of r.stacks) counts[s] = (counts[s] || 0) + 1;
  console.log(`\n${label}: ${r.n} full rebuilds, ${r.ms.toFixed(1)} ms total`);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([s, c]) => console.log(`   ${String(c).padStart(3)}x  ${s.trim().slice(0, 150)}`));
  return r;
}

// run-all.mjs picks this file up automatically, so it is a REGRESSION GUARD
// as well as an instrument: the improvement above has to stay true, not just
// have been true once. The threshold sits above the measured 4 and well below
// the 11 this started at - it catches a per-item loader being added back to
// the synchronous rerender() path, without pinning an exact number that other
// legitimate feed work would have to fight.
const SCROLL_REBUILD_TRIPWIRE = 6;
const scroll = await burst("scroll the feed to the bottom (pagination)", async () => {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
});
await burst("switch to feed filter tab", async () => {
  const b = await page.$('#communityFeedFilters [role="tab"]:nth-child(2)');
  if (b) await b.click();
});
// BACK TO THE DEFAULT SCOPE FIRST. The burst above leaves the feed on the
// second chip ("אחרי מי שאני עוקב/ת"), which has no posts in this fixture -
// so the two bursts below found no card, clicked nothing, and reported a
// perfectly clean "0 full rebuilds" for two interactions that never happened.
// Both of them matter more now that a card carries a comment preview and a
// reaction summary, so they are made to run against a feed that has cards in
// it. (Found while fixing a real regression this file caught on the scroll
// burst - see loadCommentsFor's scheduleRerender.)
await page.click('#communityFeedFilters [role="tab"]:nth-child(1)');
await page.waitForSelector('#communityFeedList .post-card', { timeout: 5000 });
await burst("tap a reaction", async () => {
  const b = await page.$('#communityFeedList .post-card [data-community-action="cheer"]');
  if (b) await b.click(); else console.log("   (no reaction button found)");
});
await burst("open a post's comments", async () => {
  const b = await page.$('#communityFeedList .post-card [data-community-action="toggle-comments"]');
  if (b) await b.click(); else console.log("   (no comments button found)");
});
if (scroll && scroll.n > SCROLL_REBUILD_TRIPWIRE) {
  console.log(`\nFAIL  one scroll cost ${scroll.n} full rebuilds, over the ${SCROLL_REBUILD_TRIPWIRE} this guard allows.`);
  console.log("      Check the stack attribution above: a per-item loader is calling");
  console.log("      rerender() directly instead of scheduleRerender().");
  failed = true;
} else if (scroll) {
  console.log(`\nPASS  one scroll cost ${scroll.n} full rebuilds (limit ${SCROLL_REBUILD_TRIPWIRE}).`);
}
} finally {
  // Both, unconditionally. A cleanup that itself throws must not mask the
  // real error, hence the catch on each.
  if (browser) await browser.close().catch(() => {});
  await target.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
