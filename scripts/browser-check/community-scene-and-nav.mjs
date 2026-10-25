#!/usr/bin/env node
// The Community tab's chrome, measured in a real engine at 390x844 — the
// phone the club actually uses — and re-measured at 1440 as the member-
// layout regression guard CLAUDE.md asks for.
//
// WHY THIS SCRIPT EXISTS. The finding it covers is pure geometry, and jsdom
// reports every rect as 0x0 at (0,0):
//
//   The scene background is a photo-free CSS pattern now, so the old pixel
//   count of the club's painted wordmark has nothing left to measure and was
//   removed with the photographs.
//
// The feed scope filter and the undo-on-delete toast that this script used to
// measure went with the feed in the strip-gym change; the 1440 member-layout
// guard stays.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const BASE = Date.now() - 5 * 60000;
const at = (min) => new Date(BASE - min * 60000).toISOString();

// One post, owned by the caller, so the ⋯ menu offers delete and the undo
// toast can be driven for real.
const OWN_POST = {
  id: "p1", post_type: "POST_TEXT", author_id: "u1",
  author: { display_name: "דנה", handle: "dana" },
  body: "בוקר טוב, סיימתי את האימון",
  visibility: "club", created_at: at(3), published_at: at(3),
  reaction_count: 0, comment_count: 0, media: [], metadata: {},
};

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  ],
  invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  feed_page_rows: [OWN_POST],
  attendance_log: [{ user_id: "u1", occurred_on: TODAY, recorded_at: VERIFIED }],
  post_comments: [], private_records: [], follows: [], blocks: [], analytics_events: [],
  notifications: [], notification_preferences: [], saved_posts: [], hidden_posts: [],
  reactions: [], feed_impressions: [], feed_interactions: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();

async function openCommunity(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = await consoleErrorCollector(page);
  await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
  await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector("#communityHead", { timeout: 10000 });
  await page.waitForTimeout(400);
  return { page, errors };
}

// ===========================================================================
// 390px — the phone.
// ===========================================================================
console.log("\n--- 390px ---");
const { page, errors } = await openCommunity(390, 844);

check("no console errors on the community tab", errors.length === 0, errors.join(" | "));

// ===========================================================================
// 1440px — the member-layout regression guard.
// ===========================================================================
console.log("\n--- 1440px ---");
{
  const { page: wide, errors: wideErrors } = await openCommunity(1440, 900);
  const geo = await wide.evaluate(() => {
    const app = document.getElementById("app").getBoundingClientRect();
    const head = document.getElementById("communityHead").getBoundingClientRect();
    return {
      appW: +app.width.toFixed(1),
      inside: head.right <= app.right + 0.5 && head.left >= app.left - 0.5,
      staff: document.documentElement.getAttribute("data-staff"),
    };
  });
  // CLAUDE.md: member layouts on desktop must not change. Nothing about the
  // shell may key on the laptop at all, and the account head must stay inside
  // the same column it occupies on the phone.
  check("a member at 1440 is not in a staff shell", geo.staff === null, JSON.stringify(geo.staff));
  check("the account head stays inside the member column at 1440", geo.inside, JSON.stringify(geo));
  check("no console errors at 1440", wideErrors.length === 0, wideErrors.join(" | "));
}

await browser.close();
await target.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
