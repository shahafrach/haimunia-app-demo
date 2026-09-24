// The staff report for the training-log edition's anonymous usage counts
// (202609230013). The numbers are the server's; this checks that the
// dashboard asks for them once, shows them as DEVICES rather than people,
// and fails like its neighbours do.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  seedAdminStepUp(mock, "u1", "dana@members.haimuniya.invalid");
  mock.onRpc("analytics_dashboard", () => ({ data: { core: {}, additional: {} }, error: null }));
  mock.onRpc("member_segments", () => ({ data: [], error: null }));
  mock.onRpc("registration_funnel", () => ({ data: null, error: null }));
  return mock;
}

async function openAnalytics(window) {
  (window.document.getElementById("tabClubManageBtn") || window.document.getElementById("tabManageBtn")).click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="moderation"]').click();
}

const REPORT = {
  as_of: "2026-09-23", first_day: "2026-09-01",
  devices_seen: 41, devices_logged: 27, devices_seen_7d: 30, devices_logged_7d: 19,
  weeks: [
    { week_start: "2026-09-08", devices: 22, logging_devices: 15, new_devices: 22 },
    { week_start: "2026-09-15", devices: 28, logging_devices: 18, new_devices: 12 },
    { week_start: "2026-09-22", devices: 30, logging_devices: 19, new_devices: 7 },
  ],
  screens: [{ screen: "add", devices: 29 }, { screen: "wod", devices: 17 }],
};

test("the dashboard asks for twelve weeks once, and shows totals, the weekly trend and screens - as devices", async () => {
  const mock = seeded();
  const calls = [];
  mock.onRpc("training_log_usage_report", (args) => { calls.push(args); return { data: REPORT, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAnalytics(window);
  const section = await waitFor(() => {
    const el = window.document.querySelector('[data-training-log-usage-section="1"]');
    return el && el.textContent.includes("41") ? el : null;
  }, 4000, 5, "the usage section with its numbers");
  assert.deepEqual(calls, [{ p_weeks: 12 }]);
  const text = section.textContent;
  assert.match(text, /מכשירים שפתחו את האפליקציה\s*41/);
  assert.match(text, /מכשירים שרשמו לפחות אימון אחד\s*27/);
  assert.ok(text.includes("30 פעילים · 19 רשמו · 7 חדשים"), "the newest week, first");
  assert.ok(text.indexOf("30 פעילים") < text.indexOf("22 פעילים"), "newest week at the top");
  assert.ok(text.includes("רישום") && text.includes("29"), "screen reach");
  assert.ok(text.includes("נספרים מכשירים, לא אנשים"), "says what is counted");
  assert.ok(text.includes("הנתונים נשמרים 180 יום"), "says how long the counts are kept");
});

test("a refusal is named, and retry asks again", async () => {
  const mock = seeded();
  let n = 0;
  mock.onRpc("training_log_usage_report", () => (++n === 1
    ? { data: null, error: { message: "not authorized" } }
    : { data: REPORT, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAnalytics(window);
  await waitFor(() => window.document.body.textContent.includes("אין לך הרשאה לצפות בנתוני השימוש."), 4000);
  window.document.querySelector('[data-community-action="training-log-usage-retry"]').click();
  await waitFor(() => (window.document.querySelector('[data-training-log-usage-section="1"]')?.textContent || "").includes("41"), 4000);
  assert.equal(n, 2);
});
