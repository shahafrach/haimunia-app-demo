// Screenshots for the owner's guide (docs/owner-guide).
//
// LOCAL AND MOCKED, ALWAYS. resolveLocalOnlyTarget() refuses anything but a
// local server and installMockCloud() aborts every request to supabase.co, so
// nothing here can reach - or photograph - the real club's data. Every name,
// workout and number below is invented for the guide.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "../browser-check/lib/target.mjs";
import { installMockCloud } from "../browser-check/lib/mockCloud.mjs";
import { dismissWelcomeModal, switchTab, selectMovement, openManagementPanel, dismissCelebrationIfOpen } from "../browser-check/lib/actions.mjs";

// A few real sets, logged through the real UI. The progress and calendar
// screens are empty states on a fresh install, and a guide that opens on
// "log a set to start seeing progress" teaches the reader nothing about what
// the screen is FOR. Driving the actual save path keeps the data honest -
// these are genuine entries, not painted pixels.
async function logSomeSets(page, movements) {
  for (const name of movements) {
    await switchTab(page, "tabAddBtn");
    await selectMovement(page, name).catch(() => {});
    await page.waitForTimeout(250);
    const save = await page.$("[data-action='save-set']");
    if (save) {
      await save.click();
      await page.waitForTimeout(600);
      await dismissCelebrationIfOpen(page).catch(() => {});
    }
  }
}
import { mkdirSync } from "node:fs";

const OUT = new URL("../../docs/owner-guide/shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const VERIFIED = iso(-40);

const SEED = {
  profiles: [
    { id: "u1", handle: "שחף", display_name: "שחף רחמני", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u2", handle: "דנה", display_name: "דנה כהן", recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u3", handle: "יואב", display_name: "יואב לוי", recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u4", handle: "מאיה", display_name: "מאיה בר", recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "i2", role: "coach", redeemed_at: VERIFIED },
    { user_id: "u3", invite_id: "i3", role: "member", redeemed_at: iso(-9) },
    { user_id: "u4", invite_id: "i4", role: "member", redeemed_at: iso(-3) },
  ],
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  club_features: [],
  community_streaks: [{ user_id: "u1", current_streak: 4, longest_streak: 11 }],
  workout_posts: [
    { id: "p1", post_type: "POST_PR", author_id: "u2", body: "Back Squat 95 ק\"ג — שיא חדש!", status: "active",
      visibility: "club", created_at: iso(-0.2), published_at: iso(-0.2),
      metadata: { movement_name: "Back Squat", weight: 95, reps: 1 } },
    { id: "p2", post_type: "POST_TEXT", author_id: "u3", body: "בוקר טוב לכולם, נתראה באימון של 18:30 💪", status: "active",
      visibility: "club", created_at: iso(-0.5), published_at: iso(-0.5) },
    { id: "p3", post_type: "POST_TEXT", author_id: "u4", body: "סיימתי את Murph בפעם הראשונה. תודה על העידוד!", status: "active",
      visibility: "club", created_at: iso(-1.2), published_at: iso(-1.2) },
  ],
  // feed_page() in the mock returns these rows AS the posts - it reads r.id,
  // r.post_type and r.author_id off them directly - so they are the full
  // objects, not references to workout_posts.
  feed_page_rows: [
    { id: "p1", post_type: "POST_PR", author_id: "u2", body: "Back Squat 95 ק\"ג — שיא חדש!", status: "active",
      visibility: "club", created_at: iso(-0.2), published_at: iso(-0.2),
      metadata: { movement_name: "Back Squat", weight: 95, reps: 1 } },
    { id: "p2", post_type: "POST_TEXT", author_id: "u3", body: "בוקר טוב לכולם, נתראה באימון של 18:30 💪", status: "active",
      visibility: "club", created_at: iso(-0.5), published_at: iso(-0.5) },
    { id: "p3", post_type: "POST_TEXT", author_id: "u4", body: "סיימתי את Murph בפעם הראשונה. תודה על העידוד!", status: "active",
      visibility: "club", created_at: iso(-1.2), published_at: iso(-1.2) },
  ],
};

const target = await resolveLocalOnlyTarget();
const browser = await chromium.launch();

async function shot(name, fn, opts = {}) {
  const page = await browser.newPage({
    viewport: { width: 420, height: 880 },
    deviceScaleFactor: 2,
  });
  await installMockCloud(page, SEED, opts.mock || {});
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await dismissWelcomeModal(page, "שחף רחמני").catch(() => {});
  await fn(page);
  // Past the hero image. Every tab opens with a full-bleed photo, which is
  // right for the app and useless in a guide - the reader needs the controls.
  if (opts.scroll !== false) {
    await page.evaluate((y) => window.scrollTo(0, y), opts.scroll || 620);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
  console.log("shot:", name);
}

// 1. The logging screen - the app's centre of gravity.
await shot("01-log", async (page) => {
  await switchTab(page, "tabAddBtn");
  await selectMovement(page, "Back Squat").catch(() => {});
  await page.waitForTimeout(400);
});

// 2. Progress - charts and personal records, with something to show.
await shot("02-progress", async (page) => {
  await logSomeSets(page, ["Back Squat", "Deadlift", "Bench Press"]);
  await switchTab(page, "tabHistoryBtn");
  await page.waitForTimeout(600);
});

// 3. The year calendar, with a trained day on it.
await shot("03-calendar", async (page) => {
  await logSomeSets(page, ["Back Squat"]);
  await switchTab(page, "tabCalendarBtn");
  await page.waitForTimeout(600);
});

// 4. The club WOD / benchmark workouts screen.
await shot("04-wod", async (page) => {
  await switchTab(page, "tabWodBtn");
});

// 5. The community feed, signed in as the owner.
const AS_OWNER = { user: { id: "u1", is_anonymous: false, email: "owner@members.haimuniya.invalid" } };

await shot("05-community", async (page) => {
  await switchTab(page, "tabCommunityBtn");
  // Long enough for loadMemberRoles() to come back, or every post is signed
  // "חבר/ה" and the guide shows a feed nobody appears in.
  await page.waitForTimeout(2600);
}, { mock: AS_OWNER });

// 6. Club management - the human side.
await shot("06-club-manage", async (page) => {
  await page.evaluate(() => window.__mock.seedCredentials("u1", "owner@members.haimuniya.invalid", "Aa123456789!"));
  await openManagementPanel(page, "tabClubManageBtn", "owner@members.haimuniya.invalid", "Aa123456789!");
  await page.waitForTimeout(1500);
}, { mock: AS_OWNER, scroll: 420 });

// 7. System management - the switches.
await shot("07-system-manage", async (page) => {
  await page.evaluate(() => window.__mock.seedCredentials("u1", "owner@members.haimuniya.invalid", "Aa123456789!"));
  await openManagementPanel(page, "tabManageBtn", "owner@members.haimuniya.invalid", "Aa123456789!");
  await page.waitForTimeout(1500);
}, { mock: AS_OWNER, scroll: 420 });

await browser.close();
// BOTH, AND THEN EXIT. resolveLocalOnlyTarget() leaves an HTTP server
// listening, and an open server handle keeps node alive: a script that
// finishes normally without closing it does not end, it hangs. Measured
// 2026-09-17 - a throw exits cleanly (1), a clean finish with the server open
// hangs (124 under a timeout), which is the counter-intuitive half.
//
// This file was the one that did it. It sat in scripts/browser-check/, where
// run-all.mjs globs every .mjs, so CI ran it as though it were a regression
// check and the browser-checks job stayed in_progress for four hours
// reporting nothing. It has moved here, out of that glob, because
// regenerating a PDF for the owner is a build step and not a check of
// anything - but the cleanup is fixed regardless, so running it by hand ends.
await target.close();
console.log("done");
process.exit(0);
