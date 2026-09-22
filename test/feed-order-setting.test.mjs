// 202609220003. The club chooses its feed's order from the modules panel.
//
// The order itself is Postgres's - feed_page() reads
// club_features.config -> feed -> order and sorts accordingly, and
// supabase/tests/0120 is what proves a chronological page really is
// chronological and really does still hide what it hid. What this file owns
// is the panel: that the control exists and is a real choice rather than a
// number, that what the club picked is what the club sees, and - the one
// that would be silent and expensive - that choosing an order does not cost
// the club any other key in the same config object.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(features) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: features || [{ club_id: "club-1", module_key: "feed", enabled: true, config: {} }],
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
function orderControl(window) {
  return window.document.querySelector('[data-club-feature-setting="feed"][data-setting-key="order"]');
}
function hoursControl(window) {
  return window.document.querySelector('[data-club-feature-setting="feed"][data-setting-key="coach_top_hours"]');
}

test("the feed switch carries two settings: the order, and how long the lifted block lasts", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);

  const el = orderControl(window);
  assert.ok(el, "the feed module has an order control");
  assert.equal(el.tagName, "SELECT", "an order is one of two words, not a number");
  assert.deepEqual([...el.options].map((o) => o.value), ["chronological", "ranked"],
    "exactly the two orders the server implements, and no third");
  assert.equal(el.value, "chronological",
    "a club that has never chosen sees the shipped default - the same one club_feature_choice() falls back to");

  // The coach tier's bound. A number, and one where the panel's own
  // "empty field = the default" rule applies, so it is a text box and not a
  // second select: 72 is a starting point a club moves, not a choice.
  const hours = hoursControl(window);
  assert.ok(hours, "and a control for how long a coach post stays lifted");
  assert.equal(hours.type, "number");
  assert.equal(hours.placeholder, "72", "the shipped default is the placeholder");
  assert.equal(hours.value, "", "not pre-filled, so 'nobody set this' stays visible");
  assert.equal(hours.min, "1");
  assert.equal(hours.max, "336", "the range mirrors club_feature_number()'s clamp, which is the real one");
});

test("the hours save alongside the order, and clearing them means the default rather than zero", async () => {
  const mock = seeded([{ club_id: "club-1", module_key: "feed", enabled: true, config: { order: "chronological", coach_top_hours: 24 } }]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  assert.equal(hoursControl(window).value, "24", "what the club set is what the club sees");
  hoursControl(window).value = "";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="feed"]').click();
  await waitFor(() => calls.length === 1, 3000);

  assert.deepEqual(calls[0].p_config, { order: "chronological" },
    "the cleared field is gone from the object entirely - a written 0 would be a real, clamped, very different number");
});

test("what the club chose is what the club sees, and a word this build does not know reads as the default", async () => {
  const ranked = await bootCommunity(seeded([
    { club_id: "club-1", module_key: "feed", enabled: true, config: { order: "ranked" } },
  ]), { syncEnabled: false });
  await openModuleSettings(ranked);
  assert.equal(orderControl(ranked).value, "ranked", "the stored order is the selected one");

  // The panel and the server agree about rubbish: club_feature_choice()
  // returns its default for a value outside the allowed set, so a control
  // showing anything else would be telling an admin their club runs an order
  // it does not run.
  const nonsense = await bootCommunity(seeded([
    { club_id: "club-1", module_key: "feed", enabled: true, config: { order: "by_vibes" } },
  ]), { syncEnabled: false });
  await openModuleSettings(nonsense);
  assert.equal(orderControl(nonsense).value, "chronological",
    "an unimplemented order shows as the default, which is what the server will actually use");
});

test("choosing an order sends it through the same RPC as the switch, and keeps the module on", async () => {
  const mock = seeded([{ club_id: "club-1", module_key: "feed", enabled: true, config: {} }]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  orderControl(window).value = "ranked";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="feed"]').click();
  await waitFor(() => calls.length === 1, 3000);

  assert.equal(calls[0].p_module_key, "feed");
  assert.equal(calls[0].p_enabled, true, "saving the order must not switch the feed off");
  assert.deepEqual(calls[0].p_config, { order: "ranked" });
  await waitFor(() => orderControl(window).value === "ranked", 3000);
});

test("choosing an order does not erase any other key in the same config object", async () => {
  // THE FAILURE THIS PREVENTS. `order` lives in the object that already
  // holds enabled_at (written by the server when a module is switched on,
  // 202609220002) and whatever the next module-level setting turns out to
  // be. A form that sent only its own field would ask the server to drop
  // facts the club never typed - and for enabled_at specifically, that is
  // how no_contact_30 loses its floor and opens a task for every member at
  // once. The server carries that one forward on its own; the panel still
  // has no business asking.
  const mock = seeded([{
    club_id: "club-1", module_key: "feed", enabled: true,
    config: { enabled_at: "2026-09-01T08:00:00+00", order: "chronological", something_else: 7 },
  }]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  orderControl(window).value = "ranked";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="feed"]').click();
  await waitFor(() => calls.length === 1, 3000);

  assert.deepEqual(calls[0].p_config, {
    enabled_at: "2026-09-01T08:00:00+00",
    order: "ranked",
    something_else: 7,
  }, "only the key the form owns moved; the other two went back exactly as they came");
});

test("flipping the module off and on sends no config at all, so the club's order survives it", async () => {
  // admin_set_club_feature(key, enabled) with no third argument KEEPS the
  // stored config (202609220002). The switch must keep calling it that way:
  // sending {} would be an explicit request to clear, and would put a club
  // that had chosen the ranked order back onto the chronological one the
  // next time somebody toggled the module.
  const mock = seeded([{ club_id: "club-1", module_key: "feed", enabled: true, config: { order: "ranked" } }]);
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args) => { calls.push(args); return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  const box = window.document.querySelector('[data-club-feature="feed"]');
  box.checked = false;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => calls.length === 1, 3000);

  assert.equal(calls[0].p_enabled, false, "the module went off");
  assert.ok(!("p_config" in calls[0]) || calls[0].p_config === undefined,
    "and the toggle said nothing about the config, which is what makes the server keep it");
  await waitFor(() => orderControl(window).value === "ranked", 3000);
});

test("a failed save does not leave the panel claiming an order the club is not on", async () => {
  const mock = seeded([{ club_id: "club-1", module_key: "feed", enabled: true, config: { order: "chronological" } }]);
  mock.onRpc("admin_set_club_feature", () => ({ data: null, error: { message: "nope" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  orderControl(window).value = "ranked";
  window.document.querySelector('[data-community-action="save-club-feature-config"][data-key="feed"]').click();
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לשמור את הערכים"), 3000);
  assert.equal(orderControl(window).value, "chronological",
    "the control falls back to what the server still holds, not to what was typed at it");
});
