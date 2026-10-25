// COMM-362. gotrue-js fires the same SIGNED_OUT event both when a caller
// calls signOut() and when its own background access-token refresh fails
// outright (an expired or revoked refresh token - the case an app
// backgrounded past its refresh window hits). cloud.js's onAuthStateChange
// handler makes no distinction between the two, by design; see
// mockSupabase.mjs's expireSession(), which fires that event without going
// through signOut() so a reader does not mistake this for a user action.
// The assertion is that a session dying out from under the app, mid-session,
// drops it back to a clear signed-out gate, not a half-alive state.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, waitForCommunityGate } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

test("a session that dies mid-session (refresh failure, not a user sign-out) drops back to the signed-out gate", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: true });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 3000);

  mock.expireSession();

  await waitForCommunityGate(window);
  assert.equal(window.document.getElementById("communityHead"), null, "the signed-in home must not still be showing as if the session were live");
  // The gate is the CHOICE screen since design spec section 7, not the login
  // form: a member whose session died lands on a screen that offers both
  // doors, rather than on a bare credential form implying they did something
  // wrong.
  assert.ok(window.document.querySelector('#content [data-community-action="start-signup"]'),
    "the app must degrade to a clear signed-out gate, not a half-alive state with a dead session");
  assert.ok(window.document.querySelector('#content [data-community-action="show-login"]'),
    "and the signed-out gate must still offer the way back in for someone who already has an account");
});
