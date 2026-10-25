// Live bug hunt, round 6 (2026-09-11): three fresh agents driving the real
// app found confirmed bugs across Hebrew grammar/RTL content, extreme
// content values, and units/dates/locale formatting (see CHANGES.md for the
// full report). This file covers the cloud.js findings; the multi-line
// session-note fix lives next to its sibling test in
// test/roadmap-features.test.mjs, and the onboarding-recap grammar fix's
// test is inline in test/community-onboarding.test.mjs (it already seeded
// exactly the count=1 boundary this fix targets).
//
// Forced to Asia/Jerusalem so the todayIso()-was-UTC bug (Israel is always
// ahead of UTC) reproduces deterministically regardless of the host
// machine's own timezone. Must be set before any Date is touched.
process.env.TZ = "Asia/Jerusalem";

import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString(), visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: new Date().toISOString(), first_week_shown_at: new Date().toISOString(), first_month_shown_at: new Date().toISOString(), first_class_shown_at: new Date().toISOString(), third_class_shown_at: new Date().toISOString() }],
    challenges: [], challenge_participants: [], weekly_recaps: [],
    notifications: [], notification_preferences: [],
    attendance_log: [], announcements: [], club_wod_sessions: [], workout_posts: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
}
// Same trick test/live-bug-hunt-round3.test.mjs already uses for app.js:
// boot with the real clock, THEN swap window.Date so every subsequent
// `new Date()` call (todayIso() included - it is called fresh on every
// render, never memoized) resolves against the fixed instant.
function installFixedClock(window, iso) {
  const RealDate = window.Date;
  const fixedMs = new Date(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  window.Date = FixedDate;
  return () => { window.Date = RealDate; };
}

// ---------------------------------------------------------------------------
// todayIso() was UTC, not local - confirmed live 01:00 Asia/Jerusalem time
// (= 22:00 UTC the day before), where Israel's real calendar day has already
// advanced but the old UTC-based function still reported yesterday.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Hebrew singular/plural grammar - relativeTime() and participantsLabel(),
// the two highest-traffic sites (feed timestamps; event/challenge RSVP
// counts).
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Identity spoofing via bidi-override characters, and the zero-width-only
// "invisible name that still counts as set" gap - both closed at the
// shared cleanStr() layer (src/shared/safe-helpers.js), applied to
// cloud.js's saveProfile() for the first time this round.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// daysSinceBoxStart() drifted a day around a DST spring-forward boundary
// (raw ms-division, not local-calendar-day counting).
// ---------------------------------------------------------------------------
test("daysSinceBoxStart() counts local calendar days correctly across a DST spring-forward boundary", async () => {
  const window = await bootApp();
  // 2026-03-24 (before Israel's spring-forward) to 2026-03-30 00:10 local
  // (after it) is exactly 6 calendar days - real elapsed ms is 6*86400000
  // MINUS the lost DST hour, which the old Math.floor(ms/86400000)
  // implementation reported as 5.
  window.saveBoxStartDate("2026-03-24");
  const RealDate = window.Date;
  const fixedMs = new RealDate("2026-03-29T21:10:00.000Z").getTime(); // = 2026-03-30T00:10 IDT local
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  window.Date = FixedDate;
  try {
    assert.equal(window.daysSinceBoxStart(), 6, "must count 6 full local calendar days, not 5 (the DST-drift bug)");
  } finally { window.Date = RealDate; }
});
