// Real device report, 2026-09-15 — the first time this app was ever opened
// on an actual phone (an installed iOS PWA) rather than in Chromium. Four
// things were reported as "not working". Three of them were not broken at
// all, and that is the finding: every one had its explanation parked in a
// `title` attribute, and a touch screen has no hover, so a correctly-disabled
// control and a dead control are the same object to the person holding the
// phone. The fourth (photo upload) is a genuine iOS failure mode.
//
// This file is the regression net for all four. It exists as its own file
// rather than as additions to four feature files because the defect is one
// defect - "explanation only reachable by hovering, in an app that is only
// ever used by touching" - and a future change that reintroduces it will do
// so in one of these four shapes.
//
// The two inverted assertions live in their own files next to the behaviour
// they describe (test/achievements.test.mjs, test/community-notifications.test.mjs),
// each carrying a comment about what it used to require and why that was wrong.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp, bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

// =====================================================================
// 2. An earned medal still prints its rule
// =====================================================================
// Reported from the phone as the Squat bronze plate being lit but unlabelled,
// sitting beside a locked Deadlift bronze that explained itself in full.
test("an earned medal prints its rule as visible text, not only as a title attribute", async () => {
  const window = await bootApp();
  // One movement in each of the five PR categories earns "אתלט שלם" - the
  // same fixture test/achievements.test.mjs uses to get a reliably EARNED
  // badge on screen without depending on a tier threshold.
  for (const cat of ["Squat", "Deadlift", "Press", "Olympic", "Pull"]) {
    await window.addMovement(`Caption Check ${cat}`, cat);
    window.applyFieldValue("step", "weight", 40);
    window.applyFieldValue("step", "reps", 3);
    window.applyFieldValue("step", "sets", 1);
    await window.saveSet();
  }
  window.closeCelebration();
  window.openAchievements();

  const badges = [...window.document.querySelectorAll(".medal-badge")];
  assert.ok(badges.length, "the medals list should render");
  const earned = badges.filter((b) => b.classList.contains("earned"));
  assert.ok(earned.length, "this fixture should have earned at least one medal");
  for (const b of earned) {
    const rule = b.querySelector(".medal-rule");
    const name = b.querySelector(".medal-name")?.textContent || "(unnamed)";
    assert.ok(rule && rule.textContent.trim(), `earned medal "${name}" renders no visible caption - a title is invisible on touch`);
  }
  // The control: a locked medal was always captioned, and must stay that way.
  const locked = badges.filter((b) => b.classList.contains("locked"));
  assert.ok(locked.length, "this fixture should still have locked medals");
  assert.ok(locked.every((b) => b.querySelector(".medal-rule")?.textContent.trim()),
    "a locked medal must keep its caption too");
  window.closeAchievements();
});

// =====================================================================
// 3. A disabled invite-release button says why, on screen
// =====================================================================
function seededAdmin() {
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
  return mock;
}

function ghostRow(stalledDays) {
  return {
    user_id: "ghost-1", username: null, label: null, role: "member",
    invite_source: "shared_code", redeemed_at: "2026-09-08T04:26:31.730Z",
    signed_up_at: "2026-09-08T04:20:00.000Z", last_sign_in_at: "2026-09-08T04:26:00.000Z",
    stalled_days: stalledDays, purgeable_after_reclaim: true,
  };
}

async function bootGhost(stalledDays) {
  const mock = seededAdmin();
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  mock.onRpc("admin_incomplete_signups", () => ({ data: [ghostRow(stalledDays)], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  // The club panel (2026-09-15): the two management panels were made fully
  // disjoint, so club surfaces live behind the head coach's row. An admin
  // fixture gets BOTH rows and reaches this one by its own id; a coach
  // fixture has only the one, under the shared id.
  (window.document.getElementById("tabClubManageBtn") || window.document.getElementById("tabManageBtn")).click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.getElementById("communityHead"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="invites"]').click();
  await waitFor(() => !!window.document.querySelector('[data-incomplete-signups-section="1"]'), 3000);
  return window;
}

// ===========================================================================
// Tap-to-prefill from the recent chips (2026-09-15)
// ===========================================================================
// The chips already existed and were read-only decoration: a member could SEE
// they squatted 100x5 on Sunday, then had to dial 100 back in by hand - about
// 32 taps of a 2.5kg stepper from the default. Hevy and Strong both build
// their entire logging loop around a tappable "previous" column, and it is the
// reason reviewers call those apps fast. Ours suits it even better, because we
// log AFTER training: the member is reconstructing a session they have already
// done, so a recent value is the most likely value.
test("a recent-entry chip is a real button that fills weight, reps and sets", async () => {
  const window = await bootApp();
  await window.addMovement("Prefill Squat", "Squat");
  window.applyFieldValue("step", "weight", 92.5);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 3);
  await window.saveSet();
  window.closeCelebration();

  const chip = window.document.querySelector('[data-action="prefill-from-recent"]');
  assert.ok(chip, "the recent entry should render as a tappable chip, not inert text");
  assert.equal(chip.dataset.weight, "92.5");
  assert.equal(chip.dataset.reps, "5");
  assert.equal(chip.dataset.sets, "3");
  assert.ok(Number(chip.style.minHeight.replace("px", "")) >= 44 || /min-height:44px/.test(chip.getAttribute("style") || ""),
    "it carries a real touch target, since it is now a control rather than a label");

  // Move the fields away from the saved values, then tap.
  window.applyFieldValue("step", "weight", 20);
  window.applyFieldValue("step", "reps", 1);
  window.applyFieldValue("step", "sets", 1);
  chip.click();
  assert.equal(window.getFieldValue("step", "weight"), 92.5, "weight is filled from the chip");
  assert.equal(window.getFieldValue("step", "reps"), 5, "reps too");
  assert.equal(window.getFieldValue("step", "sets"), 3, "and sets, which is the part that saves the most taps");
});

test("the chip names what it filled, because 'filled' alone invites 'filled with what?'", async () => {
  const window = await bootApp();
  await window.addMovement("Prefill Press", "Press");
  window.applyFieldValue("step", "weight", 45);
  window.applyFieldValue("step", "reps", 8);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
  window.closeCelebration();
  window.document.querySelector('[data-action="prefill-from-recent"]').click();
  assert.match(window.document.body.textContent, /45 ק״ג × 8/,
    "the confirmation names the values, and uses the gershayim like the rest of the app");
});
