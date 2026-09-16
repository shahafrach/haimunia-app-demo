// THE PATH EVERY MEMBER'S ACCESS DEPENDS ON.
//
// A club is a closed community: nobody gets in without a code, and the only
// thing that mints one is an admin pressing "יצירת קוד" in ניהול המועדון.
// Until 2026-09-16 that button had no end-to-end coverage, because the mock
// did not implement admin_invite_code_create at all.
//
// The gap surfaced the way this kind always does. The owner could not find the
// screen, asked, and the harness could not tell him whether the button even
// worked - so the answer was "send me a screenshot" instead of "yes, and here
// is the test that proves it". Coverage of a path is also how you answer a
// question about it.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, seedAdminStepUp, unlockAdminPanel, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

// Shaped exactly like the real admin account: is_admin true, and NO invite
// redemption - management is not a membership (202609150010). An account that
// looked like a member would not be testing the case that exists.
function adminMock(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "admin", display_name: "ניהול", is_admin: true,
                 recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [],
    clubs: [{ id: "club-1", name: "האימוניה" }],
    club_features: [], invite_codes: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "haimuniya@gmail.com" });
  seedAdminStepUp(mock, "u1", "haimuniya@gmail.com");
  return mock;
}

async function openClubPanel(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabClubManageBtn").click();
  await unlockAdminPanel(window, "haimuniya@gmail.com");
  await waitFor(() => !!window.document.getElementById("communityInviteCodeCreate"), 4000);
  return window;
}

test("the create-code form is in ניהול המועדון, where an admin can actually reach it", async () => {
  const window = await openClubPanel(adminMock());
  const form = window.document.getElementById("communityInviteCodeCreate");
  assert.ok(form, "the form is on the club panel");
  assert.ok(form.elements.maxUses, "with a max-uses field");
  assert.ok(form.elements.expiresAt, "and an optional expiry");
  // Gated on INVITE_MANAGE_CODES || isAdmin(), and in a management panel
  // isAdmin() must resolve against the MANAGEMENT account rather than the
  // member - an admin who is not a club member would otherwise be locked out
  // of the one screen only they can use.
  assert.ok(!window.document.body.textContent.includes("זמין למנהל/ת בלבד"),
    "and not shown read-only to the account that owns it");
});

test("creating a code reveals the plaintext exactly once, with a QR offered", async () => {
  const mock = adminMock();
  const window = await openClubPanel(mock);
  const form = window.document.getElementById("communityInviteCodeCreate");
  form.elements.maxUses.value = "500";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!window.document.querySelector("[data-invite-code-created]"), 4000);

  const card = window.document.querySelector("[data-invite-code-created]");
  const code = card.querySelector("code");
  assert.ok(code && code.textContent.trim().length >= 40, "the plaintext code is shown");
  // THE ONE-SHOT CONTRACT. The server stores only code_hash, so this card is
  // the single moment the code exists in readable form anywhere. The copy has
  // to say so, or an admin closes it expecting to find it again in the list.
  assert.match(card.textContent, /הפעם היחידה שהוא יוצג/,
    "and the card says plainly that this is the only time it is shown");
  assert.ok(card.querySelector("[data-community-action='copy-invite-code']"), "copy is offered");
  assert.ok(card.querySelector("[data-community-action='reopen-invite-qr']"), "so is the QR");

  // It really reached the backend, with the numbers asked for.
  const saved = mock.db.invite_codes;
  assert.equal(saved.length, 1, "one row was created");
  assert.equal(saved[0].max_uses, 500, "with the max-uses the admin typed");
  assert.equal(saved[0].use_count, 0);
  assert.equal(saved[0].role, "member", "a shared code is always member-tier");
  assert.ok(!("code" in saved[0]), "and the plaintext is never stored in the row");
});

test("a code can be deactivated, which is how a leaked one is killed", async () => {
  // A shared code is a string that travels. Once it is loose - forwarded,
  // photographed off a wall, left in an old WhatsApp group - the only remedy
  // is switching it off, so this control is the whole recovery story.
  const mock = adminMock({
    invite_codes: [{ id: "ic-old", role: "member", active: true, max_uses: 25,
                     use_count: 0, expires_at: null, revoked_at: null, created_at: VERIFIED }],
  });
  const window = await openClubPanel(mock);
  await waitFor(() => !!window.document.querySelector("[data-community-action='invite-code-toggle-active']"), 4000);
  const toggle = window.document.querySelector("[data-community-action='invite-code-toggle-active']");
  assert.ok(toggle, "the existing code is listed with a control to switch it off");
  toggle.click();
  await waitFor(() => mock.db.invite_codes[0].active === false, 4000);
  assert.equal(mock.db.invite_codes[0].active, false, "and it stops working");
});

test("a shared code may never hand out an elevated tier", async () => {
  // Minting an invite that grants coach or above would make the invite itself
  // a privilege-escalation path: it travels through WhatsApp, and whoever
  // forwards it would be handing out staff access. The server refuses; this
  // pins that the refusal is real rather than merely a UI that omits the option.
  const mock = adminMock();
  const res = await mock.client.rpc("admin_invite_code_create", { p_role: "head_coach", p_max_uses: 10 });
  assert.ok(res.error, "head_coach is refused");
  const ok = await mock.client.rpc("admin_invite_code_create", { p_role: "member", p_max_uses: 10 });
  assert.ok(!ok.error && ok.data && ok.data.code, "member is allowed");
});
