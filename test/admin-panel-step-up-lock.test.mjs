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
  assert.ok(window.document.getElementById("panelUnlock"),
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
    const form = window.document.getElementById("panelUnlock");
    form.elements.password.value = pw;
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };

  submit("wrong-password");
  await waitFor(() => /הסיסמה שגויה/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "a wrong password leaves the gate up");
  // The failure must not cascade into a sign-out - losing the session over a
  // mistyped password would be a far worse outcome than the lock prevents.
  assert.ok(window.communityIsAdmin(), "and it must NOT sign the admin out");

  submit("Aa123456789!");
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.getElementById("manageArea-bugs"),
    "the correct password renders the panel");
});

test("the unlock is held in memory only - never in storage that survives a reload", () => {
  // Persisting it would defeat the thing it exists for: this guards an
  // already-unlocked phone, and a token that survives a reload hands the
  // panel over anyway.
  const at = cloudJs.indexOf("panelUnlockedUntil");
  assert.ok(at > -1);
  const region = cloudJs.slice(at, at + 6000);
  assert.ok(!/localStorage[^\n]*panelUnlock/i.test(region), "never localStorage");
  assert.ok(!/sessionStorage[^\n]*panelUnlock/i.test(region), "never sessionStorage");
  // And it is cleared on sign-out, or the next person to sign in on this
  // device inherits an open admin panel.
  assert.match(cloudJs, /state\.admin\.panelUnlockedUntil = \{ admin: 0, club: 0 \};/,
    "sign-out must drop BOTH unlocks");
});

test("it is a screen lock, not a permission - the server gate is untouched", () => {
  // The honest property. If this flag were load-bearing for authority, a
  // client-side edit would be an escalation. It is not: every admin action
  // still goes through an is_admin() check in the database.
  const at = cloudJs.indexOf("function renderManagePanel");
  const body = cloudJs.slice(at, at + 1800);
  assert.match(body, /isAdminMode \? !isAdmin\(\) : !isStaff\(\)/,
    "the role check still runs first and independently of the unlock");
  assert.match(body, /if \(!panelUnlocked\(panelKey\)\)/,
    "the unlock gates RENDERING, after the role check, not instead of it");
});

// ===========================================================================
// The club panel is locked too, and independently (2026-09-15)
// ===========================================================================
// "ניהול המועדון needs to also use password." Correct: adding and removing
// members, lifting restrictions and editing what every new member reads is
// not a smaller responsibility than reading the audit log - it is a different
// one, held by a different person.

function headCoachMock() {
  const mock = createMockSupabase({
    profiles: [{ id: "hc1", handle: "headcoach", display_name: "מאמן/ת ראשי/ת", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "hc1", invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  });
  mock.setUser({ id: "hc1", is_anonymous: false, email: "headcoach@members.haimuniya.invalid" });
  mock.seedCredentials("hc1", "headcoach@members.haimuniya.invalid", "Aa123456789!");
  return mock;
}

test("the club panel asks for the password too, and renders nothing until it is given", async () => {
  const window = await bootCommunity(headCoachMock(), { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector("#content .page-title"), 3000);
  assert.ok(window.document.getElementById("panelUnlock"), "the club panel is gated");
  assert.equal(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'), null,
    "the invite surface must not render before the password is re-entered");

  const form = window.document.getElementById("panelUnlock");
  assert.equal(form.dataset.panel, "club", "and it knows which panel it is guarding");
  form.elements.password.value = "Aa123456789!";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'),
    "the correct password opens the club panel");
});

test("the two unlocks are independent - opening one must not open the other", () => {
  // The load-bearing property of keying by panel. One shared flag would make
  // the weaker of the two locks the effective lock on both, and an account
  // that holds both roles should still be asked twice if it wants both.
  const at = cloudJs.indexOf("panelUnlockedUntil");
  const region = cloudJs.slice(at, at + 400);
  assert.match(region, /\{ admin: 0, club: 0 \}/, "one expiry per panel, not one shared flag");
  assert.match(cloudJs, /state\.admin\.panelUnlockedUntil\[panel\] = Date\.now\(\)/,
    "unlocking sets ONLY the panel that was asked for");
});

// ===========================================================================
// The coach board is for coaches (2026-09-15)
// ===========================================================================
test("an admin who does not coach is not offered the coach board", () => {
  // "coach area will be visible only for coach." isStaff() means "coach and
  // above", which sweeps in an admin - and since the panels were split, an
  // admin's job is the app, not the floor. The board is a working surface for
  // whoever actually coaches: congratulate this member, welcome that one,
  // chase the one who has not been in.
  assert.match(cloudJs, /function isCoachTier\(\)/, "a coach-tier test exists, distinct from isStaff()");
  const at = cloudJs.indexOf("function isCoachTier");
  const body = cloudJs.slice(at, at + 300);
  assert.match(body, /state\.redemption\.role === "coach" \|\| state\.redemption\.role === "head_coach"/,
    "coach-tier is a redeemed ROLE, not the is_admin flag");
  assert.ok(!/is_admin/.test(body),
    "the is_admin flag alone must NOT make someone a coach");
  // Every REAL gate that decides the board exists uses it. Comment lines are
  // stripped first: this section explains at length why the module toggle
  // exists and names the call while doing so, and an earlier version of this
  // assertion counted that prose as a fourth gate.
  const codeLines = cloudJs.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const gates = codeLines.filter((l) => l.includes('isModuleEnabled("coach_tools")'));
  assert.ok(gates.length >= 3, `expected the coach_tools gates to be found, got ${gates.length}`);
  for (const g of gates) {
    assert.ok(g.includes("isCoachTier()"),
      `a coach_tools gate is not coach-tier, so an admin would still be offered the board:\n  ${g.trim()}`);
  }
});
