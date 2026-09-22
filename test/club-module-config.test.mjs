// 202609220002. The first thresholds behind a module switch.
//
// club_features.config has existed since 202609010012 with an empty object in
// every row and its own comment saying "none does today" about modules that
// need more than on/off. coach_tasks and onboarding_challenge do, and the
// numbers are the whole point of them: a club that cannot move "welcome by
// day 7" to day 5 has been handed somebody else's opinion about their gym.
//
// The RULES those numbers drive are Postgres's, and supabase/tests/0118
// proves that moving one really moves the rule. What this file owns is the
// panel: that the fields exist, that saving sends them through the same
// admin_set_club_feature() the switch itself uses, that a cleared field means
// "use the default" rather than "zero", and - the one that would be silent
// and expensive - that saving thresholds does not switch the module off.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const KEYS = ["coach_tasks", "onboarding_challenge"];

function seeded(features) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: features || KEYS.map((module_key) => ({ club_id: "club-1", module_key, enabled: false, config: {} })),
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  seedAdminStepUp(mock, "u1", "dana@members.haimuniya.invalid");
  return mock;
}
async function openModuleSettings(window) {
  window.document.getElementById("tabManageBtn").click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="moderation"]').click();
  await waitFor(() => !!window.document.querySelector("[data-club-modules-panel]"), 3000);
}
function fields(window, key) {
  return [...window.document.querySelectorAll(`[data-club-feature-setting="${key}"]`)];
}

test("both modules with rules behind them carry a threshold field per rule, and no other module does", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  assert.equal(fields(window, "coach_tasks").length, 7, "one field per coach-task threshold");
  assert.equal(fields(window, "onboarding_challenge").length, 3, "goal, window and the offer window");
  // Every other switch is still a switch. A panel where twenty modules each
  // grew a form is a panel nobody reads.
  assert.equal(fields(window, "events").length, 0, "a module with no numbers gets no fields");
  assert.equal(fields(window, "benchmarks").length, 0, "and neither does one that has not been built");
});

test("the shipped default is the placeholder, never the value - so 'nobody set this' is visible", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  const goal = window.document.querySelector('[data-club-feature-setting="onboarding_challenge"][data-setting-key="goal_sessions"]');
  assert.equal(goal.placeholder, "8", "the default is shown");
  assert.equal(goal.value, "", "and is NOT pre-filled - an admin can tell an unset field from one somebody chose");
  assert.equal(goal.min, "1");
  assert.equal(goal.max, "60");
});

test("a configured value is shown as a value, and a cleared field removes the key rather than writing zero", async () => {
  const mock = seeded([
    { club_id: "club-1", module_key: "onboarding_challenge", enabled: true, config: { goal_sessions: 12, window_days: 45 } },
  ]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  const goal = window.document.querySelector('[data-club-feature-setting="onboarding_challenge"][data-setting-key="goal_sessions"]');
  assert.equal(goal.value, "12", "what the club set is what the club sees");

  // Clear the goal, keep the window: the save must drop goal_sessions from
  // the object entirely. A written 0 would be a real, clamped, very different
  // number, and club_feature_number() has no way to tell it from a choice.
  goal.value = "";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="onboarding_challenge"]').click();
  await waitFor(() => calls.length === 1, 3000);

  assert.deepEqual(calls[0].p_config, { window_days: 45 }, "the cleared key is gone, the untouched one survives");
  assert.ok(!("goal_sessions" in calls[0].p_config), "and no zero was invented for it");
});

test("saving thresholds re-sends the module's own enabled state, so a save never switches it off", async () => {
  // admin_set_club_feature() UPSERTS the whole row. Omitting p_enabled would
  // write the default and silently turn the module off - which, for a module
  // whose whole job is a coach's daily list, would look exactly like the
  // feature breaking rather than like a settings save going wrong.
  const mock = seeded([{ club_id: "club-1", module_key: "coach_tasks", enabled: true, config: {} }]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  window.document.querySelector('[data-club-feature-setting="coach_tasks"][data-setting-key="checkin_day"]').value = "45";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="coach_tasks"]').click();
  await waitFor(() => calls.length === 1, 3000);

  assert.equal(calls[0].p_module_key, "coach_tasks");
  assert.equal(calls[0].p_enabled, true, "the module stays on");
  assert.deepEqual(calls[0].p_config, { checkin_day: 45 });
  assert.equal(window.document.querySelector('[data-club-feature="coach_tasks"]').checked, true, "and the switch on screen still reads on");
});

test("the save goes through the same RPC as the switch, and a failure does not pretend it worked", async () => {
  const mock = seeded([{ club_id: "club-1", module_key: "coach_tasks", enabled: true, config: {} }]);
  mock.onRpc("admin_set_club_feature", () => ({ data: null, error: { message: "nope" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  window.document.querySelector('[data-club-feature-setting="coach_tasks"][data-setting-key="checkin_day"]').value = "45";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="coach_tasks"]').click();
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לשמור את הערכים"), 3000);
  // The client's cached map must NOT have taken the value: an admin who reads
  // 45 back off a screen after a failed save will believe the club is running
  // a rule it is not.
  const goal = window.document.querySelector('[data-club-feature-setting="coach_tasks"][data-setting-key="checkin_day"]');
  assert.equal(goal.value, "", "the field falls back to showing nothing set, because nothing was set");
});

test("a non-numeric entry is dropped rather than sent, and the range is stated on the field", async () => {
  const mock = seeded([{ club_id: "club-1", module_key: "coach_tasks", enabled: true, config: {} }]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  const day = window.document.querySelector('[data-club-feature-setting="coach_tasks"][data-setting-key="checkin_day"]');
  assert.equal(day.type, "number", "it is a number field, so most rubbish never gets typed");
  assert.equal(day.min, "1");
  assert.equal(day.max, "365");
  day.value = "";
  window.document.querySelector('[data-club-feature-setting="coach_tasks"][data-setting-key="no_contact_days"]').value = "14.7";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="coach_tasks"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0].p_config, { no_contact_days: 15 },
    "a fraction is rounded to a whole number of days - half a day is not a threshold this schema can express");
});

test("the panel says what an empty field means, because 'clear it to reset' is not guessable", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  const block = window.document.querySelector('[data-club-feature-settings="coach_tasks"]');
  assert.match(block.textContent, /שדה ריק/, "the empty-field rule is written down");
  assert.match(block.textContent, /ברירת המחדל/, "and named as the default");
  assert.match(block.textContent, /מוחזר לגבול/, "and so is the server-side clamp, which is where the real range lives");
});
