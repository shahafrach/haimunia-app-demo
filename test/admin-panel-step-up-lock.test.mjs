// Step-up lock on the admin panel (2026-09-15).
//
// Asked for directly: "on ניהול מערכת there is need to be separate log in for
// admin, because this is the area for that." The panel holds bug reports, the
// audit log, role assignment and password resets - the things that are worth
// a second question even from someone already signed in.
//
// WHAT THIS IS, said plainly here because a lock described as more than it is
// becomes the reason nobody adds the real one later: it is NOT the security
// boundary. is_admin() in the database is, and it is re-checked on every
// action regardless of this flag - nothing in this file can grant a non-admin
// anything. This guards the PHYSICAL-ACCESS case: an unattended phone in a
// gym, a head coach who also holds admin, a member handed the device to look
// at a photo.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

function adminMock() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "admin", display_name: "ניהול", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "i1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "admin@club.example" });
  return mock;
}

async function openAdminPanel(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector("#content .page-title"), 3000);
}

test("the admin panel asks for the password again before it renders anything", async () => {
  const window = await bootCommunity(adminMock(), { syncEnabled: false });
  await openAdminPanel(window);
  assert.ok(window.document.getElementById("adminUnlock"),
    "an unlock form should stand in front of the panel");
  // The point of the lock: the contents are not merely hidden behind a
  // collapsed section, they are not rendered at all.
  for (const id of ["manageArea-bugs", "manageArea-audit", "manageArea-settings"]) {
    assert.equal(window.document.getElementById(id), null,
      `${id} must not render before the password is re-entered`);
  }
});

test("the right password opens it; the wrong one does not, and does not sign you out", async () => {
  const mock = adminMock();
  mock.seedCredentials("u1", "admin@club.example", "Aa123456789!");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAdminPanel(window);

  const submit = (pw) => {
    const form = window.document.getElementById("adminUnlock");
    form.elements.password.value = pw;
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };

  submit("wrong-password");
  await waitFor(() => /הסיסמה שגויה/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("adminUnlock"), "a wrong password leaves the gate up");
  // The failure must not cascade into a sign-out - losing the session over a
  // mistyped password would be a far worse outcome than the lock prevents.
  assert.ok(window.communityIsAdmin(), "and it must NOT sign the admin out");

  submit("Aa123456789!");
  await waitFor(() => !window.document.getElementById("adminUnlock"), 4000);
  assert.ok(window.document.getElementById("manageArea-bugs"),
    "the correct password renders the panel");
});

test("the unlock is held in memory only - never in storage that survives a reload", () => {
  // Persisting it would defeat the thing it exists for: this guards an
  // already-unlocked phone, and a token that survives a reload hands the
  // panel over anyway.
  const at = cloudJs.indexOf("adminUnlockedUntil");
  assert.ok(at > -1);
  const region = cloudJs.slice(at, at + 6000);
  assert.ok(!/localStorage[^\n]*adminUnlock/i.test(region), "never localStorage");
  assert.ok(!/sessionStorage[^\n]*adminUnlock/i.test(region), "never sessionStorage");
  // And it is cleared on sign-out, or the next person to sign in on this
  // device inherits an open admin panel.
  assert.match(cloudJs, /state\.admin\.adminUnlockedUntil = 0;/,
    "sign-out must drop the unlock");
});

test("it is a screen lock, not a permission - the server gate is untouched", () => {
  // The honest property. If this flag were load-bearing for authority, a
  // client-side edit would be an escalation. It is not: every admin action
  // still goes through an is_admin() check in the database.
  const at = cloudJs.indexOf("function renderManagePanel");
  const body = cloudJs.slice(at, at + 1800);
  assert.match(body, /isAdminMode \? !isAdmin\(\) : !isStaff\(\)/,
    "the role check still runs first and independently of the unlock");
  assert.match(body, /isAdminMode && !adminUnlocked\(\)/,
    "the unlock gates RENDERING, after the role check, not instead of it");
});
