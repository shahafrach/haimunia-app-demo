// Push triggers (Home port, feature 1): the schedule beside the workout reminder switch, the deep link of a
// personal push, and the shape of migration 202611080001. Who is written and who is pushed to is pgTAP.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, notifPrefControl, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "מעגל" }], notifications: [], notification_preferences: [], reminder_prefs: [],
    feed_page_rows: [], follows: [], hidden_posts: [], saved_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openMe(window) {
  window.switchAppTab("me");
  await waitFor(() => !!notifPrefControl(window, "workout_reminder"), 4000);
}

test("the workout reminder shows its day and time pickers only once it is switched on, and saves them", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMe(window);
  assert.equal(window.document.querySelector('[data-reminder-schedule="workout_reminder"]'), null, "off: no schedule");
  pickNotifPref(window, "workout_reminder", true);
  await waitFor(() => !!window.document.querySelector('[data-reminder-schedule="workout_reminder"]'), 4000);

  const chip = window.document.querySelector('[data-community-action="reminder-day"][data-day="0"]');
  assert.equal(chip.getAttribute("aria-pressed"), "false");
  assert.ok(chip.getAttribute("aria-label"), "a day chip has a full spoken name");
  chip.click();
  await waitFor(() => mock.db.reminder_prefs.some((r) => (r.workout_days || []).includes(0)), 4000);
  const sel = window.document.querySelector('[data-reminder-field="hour"]');
  sel.value = "7"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.db.reminder_prefs.some((r) => r.workout_hour === 7), 4000);
  const row = mock.db.reminder_prefs[0];
  assert.equal(row.user_id, "u1");
  assert.equal(row.workout_minute, 0);
});

test("a personal push opens a core tab, not a circle", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMe(window);
  const opened = [];
  window.haimuniaOpenTab = (n) => opened.push(n);
  window.communityHandlePushDeepLink("/tab/history");
  window.communityHandlePushDeepLink("/tab/add");
  assert.deepEqual(opened, ["history", "add"]);
  const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /\(add\|history\)/, "a cold start from the lock screen opens the same tab");
});

test("the migration: reaction defaults on, other types stay opt-in, personal pushes need no circle, the new table is own-row", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202611080001_push_triggers.sql", import.meta.url), "utf8");
  assert.match(sql, /p_type = 'reaction' and not exists/);
  assert.match(sql, /'pr_circle', 'workout_reminder', 'weekly_digest'/);
  assert.match(sql, /n\.type in \('workout_reminder', 'weekly_digest'\)/);
  assert.match(sql, /create table public\.reminder_prefs[\s\S]*enable row level security/);
  assert.match(sql, /policy aal2_required on public\.reminder_prefs as restrictive/);
  assert.match(sql, /grant select on public\.reminder_prefs to service_role/);
  assert.doesNotMatch(sql, /grant [^;]*reminder_prefs to (anon|public)/i);
  assert.doesNotMatch(sql, /reminder_push_due[\s\S]{0,400}weight|e1rm|body_?weight/i, "the reminder text never mentions training data");
});
