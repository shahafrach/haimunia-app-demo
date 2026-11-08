// The weekly summary (Home port, feature 2): the numbers, the wording, the progress screen and the schedule.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { createRequire } from "node:module";
import { bootCommunity, waitFor, notifPrefControl, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
const P = createRequire(import.meta.url)("../src/progress.js");

let n = 0;
const set = (date, weight, reps) => ({ id: "s" + ++n, exerciseId: "back-squat", date, ts: Date.parse(date + "T08:00:00Z") + n, weight, reps, sets: 1 });
// 2026-11-08 is a Sunday; the week under test is 11-08 .. 11-14, "today" is Friday 11-13.
const TODAY = "2026-11-13";
const history = [set("2026-10-20", 100, 5), set("2026-10-22", 100, 5), set("2026-10-27", 102.5, 5), set("2026-11-03", 105, 5)];
const lift = (extra) => ({ id: "back-squat", name: "סקוואט", entries: history.concat(extra) });

test("a week with a PR and a better estimate reports both, counts days, and never invents bad news", () => {
  const d = P.weekDigest([lift([set("2026-11-09", 110, 5), set("2026-11-12", 100, 5)])], ["2026-11-09", "2026-11-12"], 3, TODAY, { minPrior: 3 });
  assert.equal(d.workouts, 2);
  assert.equal(d.prs.length, 1);
  assert.equal(d.prs[0].weight, 110);
  assert.equal(d.e1rm.length, 1);
  assert.ok(d.e1rm[0].to > d.e1rm[0].from);
  const text = P.digestLines(d).join(" | ");
  assert.match(text, /2 מתוך 3 אימונים השבוע/);
  assert.match(text, /שיא אישי חדש: סקוואט/);
  assert.match(text, /1RM משוער/);
  assert.doesNotMatch(text, /פספס|החמצ|ירידה|נכשל|רק /, "positive wording only");
});

test("a lower estimate or an empty week gives no line of failure, only a way in", () => {
  const down = P.weekDigest([lift([set("2026-11-10", 80, 5)])], ["2026-11-10"], 0, TODAY, { minPrior: 3 });
  assert.equal(down.e1rm.length, 0, "lower is silent");
  assert.deepEqual(P.digestLines(down), ["אימון אחד השבוע"]);
  const empty = P.weekDigest([lift([])], [], 3, TODAY, { minPrior: 3 });
  assert.equal(empty.workouts, 0);
  assert.deepEqual(P.digestLines(empty), ["שבוע חדש מתחיל. אימון קטן אחד מספיק כדי להתחיל."]);
});

test("the run counts consecutive weeks on target and the unfinished week never breaks it", () => {
  const days = ["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"]; // two full weeks at target 2, this week not yet
  const d = P.weekDigest([], days, 2, TODAY);
  assert.equal(d.run, 2);
  assert.match(P.digestLines(d).join(" "), /2 שבועות ברצף ביעד/);
  const gap = P.weekDigest([], ["2026-10-12", "2026-10-13", "2026-11-04", "2026-11-05"], 2, TODAY);
  assert.equal(gap.run, 1, "a missed week ends the run (nothing else is taken away)");
});

test("the migration schedules the digest as its own pick, content-free, and the progress screen is built on the device", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202611080002_weekly_digest.sql", import.meta.url), "utf8");
  assert.match(sql, /digest_day\s+smallint not null default 5/);
  assert.match(sql, /notif_pref_allows\(rp\.user_id, 'weekly_digest'\)/);
  assert.doesNotMatch(sql, /entries|private_records|e1rm|workout_posts/i, "the server never reads the log for the digest");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /renderWeeklySummary\(\) \+ renderWeeksSection\(\)/);
});

test("Me offers the weekly summary switch with a single-day picker; the schedule saves", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString(), visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "i", role: "member", redeemed_at: new Date().toISOString() }],
    clubs: [{ id: "c1", name: "מעגל" }], notifications: [], notification_preferences: [], reminder_prefs: [], feed_page_rows: [], follows: [], hidden_posts: [], saved_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.switchAppTab("me");
  await waitFor(() => !!notifPrefControl(window, "weekly_digest"), 4000);
  pickNotifPref(window, "weekly_digest", true);
  await waitFor(() => !!window.document.querySelector('[data-reminder-schedule="weekly_digest"]'), 4000);
  const fri = window.document.querySelector('[data-reminder-schedule="weekly_digest"] [data-day="5"]');
  assert.equal(fri.getAttribute("aria-pressed"), "true", "Friday until the member chooses");
  window.document.querySelector('[data-reminder-schedule="weekly_digest"] [data-day="0"]').click();
  await waitFor(() => mock.db.reminder_prefs.some((r) => r.digest_day === 0), 4000);
  assert.equal(window.document.querySelector('[data-reminder-schedule="weekly_digest"] [data-day="5"]').getAttribute("aria-pressed"), "false", "one day only");
});
