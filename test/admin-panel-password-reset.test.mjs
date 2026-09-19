// COMM-379. THE PASSWORD RESET THE PANEL SPLIT LEFT WITH NOBODY, and the
// disabled button that never said why.
//
// renderManagePanel()'s own charter, written when the two panels were made
// disjoint on 2026-09-15, is unambiguous: "ADMIN runs the APP - bug
// reports, the audit log, who holds which role, password resets, and which
// modules are switched on." Three of those five moved onto the admin
// panel. Password resets did not. They stayed inside
// renderMemberManagement(), which only the CLUB panel renders, and which
// then self-gates on isAdmin() - so a head coach on the club panel cannot
// see it, and an admin on the admin panel has no screen that draws it at
// all. The only route left was to hold the club role as well and go
// looking on the other panel for a control the design had assigned to you.
//
// The second half is the same defect this repository keeps producing, in
// its third copy. The roster row's role buttons carry a visible one-line
// reason when they are disabled, because a `title` is invisible on a phone
// (real device report, 2026-09-15, fixed first for ghost-reclaim, then for
// the role buttons). The reset button sits in the SAME row, disabled by
// the SAME readOnly flag, and was missed both times: a head coach saw one
// greyed control with a reason and another right under it with none.
//
// Nothing here is a new capability. adminResetPassword() is untouched, the
// edge function is untouched, the confirm dialog is the same askConfirm()
// call, and the reveal card is one renderer used by both panels.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

const src = cloudSource();
const VERIFIED = new Date().toISOString();

function seeded(role) {
  const isAdmin = role === "admin";
  const mock = createMockSupabase({
    profiles: [
      { id: "u1", handle: "yael_b", display_name: "יעל בר", is_admin: isAdmin, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "m-kobi", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "i1", role: isAdmin ? "member" : role, redeemed_at: VERIFIED },
      { user_id: "m-kobi", invite_id: "i2", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: [], admin_actions: [], reports: [], workout_posts: [],
    feed_page_rows: [], notifications: [], community_streaks: [],
    coach_engagement_flags: [], analytics_events: [], challenges: [],
    onboarding_step_content: [], monthly_club_recaps: [], member_contact_log: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "yael@members.haimuniya.invalid" });
  seedAdminStepUp(mock, "u1", "yael@members.haimuniya.invalid");
  return mock;
}

function memberRow(extra) {
  return Object.assign({ id: "m-kobi", handle: "kobi", display_name: "קובי", avatar_url: null, is_admin: false, role: "member", redeemed_at: VERIFIED, sort_key: VERIFIED, last_activity_on: null }, extra || {});
}

// The SYSTEM ADMIN panel - tabManageBtn, mode "admin". Distinct from
// tabClubManageBtn below, and that distinction is the whole subject here.
async function openAdminPanel(mock, results) {
  if (results) mock.onRpc("admin_search_members", () => ({ data: results, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="moderation"]'), 4000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="moderation"]').click();
  return window;
}
// Drives the real search box, so the row clicked is the one an admin would
// be looking at - and the one subjectNameFor() resolves the name from.
async function searchOnAdminPanel(window, query) {
  const input = window.document.getElementById("adminPasswordResetSearch");
  assert.ok(input, "the admin panel offers a member lookup for the reset");
  input.value = query;
  input.dispatchEvent(new window.Event("input"));
  await waitFor(() => !!window.document.querySelector('[data-password-reset-panel] [data-community-action="admin-reset-password"]'), 4000);
}

// ===========================================================================
// PART 1 - the control exists on the panel the design assigned it to
// ===========================================================================

test("the system admin panel has a password-reset section", async () => {
  const window = await openAdminPanel(seeded("admin"));
  const panel = window.document.querySelector("[data-password-reset-panel]");
  assert.ok(panel, "the admin panel draws it");
  assert.ok(window.document.getElementById("manageArea-passwords"), "as its own area, with a heading of its own");
  // Before anyone has typed, the section says what to do rather than
  // showing an empty list - the same empty state the club panel's search
  // has carried since it shipped.
  assert.match(panel.textContent, /חיפוש לפי handle/);
  // And it explains WHY an admin is the one doing this at all: there is no
  // real address to send a reset link to. That is a property of this app's
  // sign-in (usernameToEmail) that an admin cannot be expected to infer.
  assert.match(panel.textContent, /אין כתובת מייל אמיתית/);
});

test("an admin finds a member there and resets, through the same confirm dialog", async () => {
  const mock = seeded("admin");
  const window = await openAdminPanel(mock, [memberRow()]);
  await searchOnAdminPanel(window, "kobi");

  const calls = [];
  mock.onFunction("admin_reset_password", (body) => {
    calls.push(body);
    return { data: { temp_password: "Temp-9f3a-Kx" }, error: null };
  });

  window.document.querySelector('[data-password-reset-panel] [data-community-action="admin-reset-password"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  const dialog = window.document.querySelector('[data-community-action="confirm-yes"]').closest("div[role], .sheet, div");
  // The destructive direction asks first and names its subject, exactly as
  // it does from the club panel - this is the same askConfirm() call site,
  // reached from a new button.
  assert.match(window.document.body.textContent, /קובי/, "the dialog names who is being reset");
  assert.ok(dialog, "the confirmation is a real dialog, not a window.confirm");

  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => calls.length === 1, 4000);
  assert.deepEqual(calls[0], { target_user_id: "m-kobi" },
    "the existing edge function, called with the existing argument");
});

test("the one-time password is revealed on the admin panel, named, with copy and close", async () => {
  const mock = seeded("admin");
  const window = await openAdminPanel(mock, [memberRow()]);
  await searchOnAdminPanel(window, "kobi");
  mock.onFunction("admin_reset_password", () => ({ data: { temp_password: "Temp-9f3a-Kx" }, error: null }));

  window.document.querySelector('[data-password-reset-panel] [data-community-action="admin-reset-password"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => !!window.document.querySelector("[data-password-reset-created]"), 4000);

  const card = window.document.querySelector("[data-password-reset-created]");
  // The reveal card is INSIDE this section, not orphaned onto a screen the
  // admin is not looking at. A one-time secret shown somewhere else is a
  // one-time secret lost: the server has already rotated the password.
  assert.ok(card.closest("[data-password-reset-panel]"),
    "the card appears in the section the admin just acted from");
  assert.equal(card.querySelector("code").textContent.trim(), "Temp-9f3a-Kx");
  // Named. The whole point of carrying subjectNameFor() onto this card.
  assert.match(card.textContent, /קובי/, "whose password this is");
  assert.match(card.textContent, /הפעם היחידה שהיא תוצג/, "and that this is the only showing");
  assert.ok(card.querySelector('[data-community-action="copy-invite-code"]'), "copy");
  assert.ok(card.querySelector('[data-community-action="close-password-reset-result"]'), "and close");

  window.document.querySelector('[data-community-action="close-password-reset-result"]').click();
  await waitFor(() => !window.document.querySelector("[data-password-reset-created]"), 3000);
});

test("a failed reset says so and reveals nothing", async () => {
  const mock = seeded("admin");
  const window = await openAdminPanel(mock, [memberRow()]);
  await searchOnAdminPanel(window, "kobi");
  mock.onFunction("admin_reset_password", () => ({ data: null, error: { message: "not authorized" } }));

  window.document.querySelector('[data-password-reset-panel] [data-community-action="admin-reset-password"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => /איפוס הסיסמה נכשל/.test(window.document.body.textContent), 4000);
  assert.equal(window.document.querySelector("[data-password-reset-created]"), null,
    "no card, and so no ambiguity about whether a password was rotated");
});

test("the reveal card has ONE renderer, not a copy per panel", () => {
  // There is one reveal slot (state.admin.passwordResetResult) and
  // adminResetPassword() refuses to overwrite an unread one. Two copies of
  // the markup for one slot is this codebase's characteristic defect, and
  // the copy that drifts here is the one showing a secret without saying
  // whose it is - the exact bug the name on this card was added to fix.
  assert.equal(src.split("data-password-reset-created=").length - 1, 1,
    "the card is emitted from exactly one place");
  assert.match(src, /function passwordResetResultHtml\(\)/, "and that place is a named, shared renderer");
  for (const caller of ["renderPasswordResetPanel", "renderMemberManagement"]) {
    const at = src.indexOf(`function ${caller}(`);
    assert.ok(at > -1, `${caller} exists`);
    assert.match(src.slice(at, src.indexOf("\n  }", at)), /passwordResetResultHtml\(\)/,
      `${caller} renders the shared card rather than its own`);
  }
});

test("the admin panel's reset control is admin-gated, and goes through the dialog like every other one", () => {
  const at = src.indexOf("function renderPasswordResetPanel()");
  const body = src.slice(at, src.indexOf("\n  }", at));
  assert.match(body, /if \(!isAdmin\(\)\) return "";/,
    "same gate renderMemberManagement() has - this moves a control, it does not widen one");
  // The click opens askConfirm(); only runConfirm() may call the mutating
  // function. community-destructive-symmetry.test.mjs pins that rule
  // globally, and this is the new call site it now has to cover.
  assert.match(body, /data-community-action="admin-reset-password"/,
    "it reuses the existing action, so it reuses the existing confirmation");
  assert.ok(!/adminResetPassword\(/.test(body), "and never calls the reset directly");
});

test("only the admin panel draws the section - the club panel is unchanged", async () => {
  // The split is meant to be disjoint in both directions. Putting resets on
  // the admin panel must not also leave a second copy on the club panel,
  // where the same control already exists on the roster row.
  const at = src.indexOf("function renderManagePanel(mode)");
  const body = src.slice(at, src.indexOf("\n  }", at) + 4);
  const wiring = body.split("\n").filter((l) => l.includes("manageAdminArea(areaPasswords"));
  assert.equal(wiring.length, 1, "the section is rendered from exactly one place");
  assert.match(wiring[0], /isAdminMode \? manageAdminArea\(areaPasswords, renderPasswordResetPanel\(\)\) : ""/,
    "on the admin panel only");
});

// ===========================================================================
// PART 2 - the disabled button says why, on the club panel
// ===========================================================================

async function openClubRoster(mock, rows) {
  mock.onRpc("admin_member_roster", () => ({ data: rows, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  (window.document.getElementById("tabClubManageBtn") || window.document.getElementById("tabManageBtn")).click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="members"]'), 4000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="members"]').click();
  await waitFor(() => !!window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-reset-password"]'), 4000);
  return window;
}

test("a coach sees a visible reason under the disabled reset button, not only a tooltip", async () => {
  const window = await openClubRoster(seeded("coach"), [memberRow()]);
  const btn = window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-reset-password"]');
  assert.equal(btn.disabled, true, "a coach is not offered the reset");
  // THE POINT. `title` is what it had, and a title never appears on a touch
  // screen - which is every screen this app ships to.
  const row = btn.closest(".chip-row");
  assert.match(row.textContent, /איפוס סיסמה זמין למנהל\/ת בלבד\./,
    "the reason is rendered text, in the same row as the button it explains");
  const note = Array.from(row.querySelectorAll(".footer-note")).find((n) => /איפוס סיסמה זמין/.test(n.textContent));
  assert.ok(note, "and it uses the same .footer-note element the role buttons' reason uses, so the two read as one kind of message");
});

test("the reason sits beside the role buttons' reason, one per boundary, neither duplicated", async () => {
  const window = await openClubRoster(seeded("coach"), [memberRow()]);
  const memberRowEl = window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-reset-password"]').closest(".log-row");
  const notes = Array.from(memberRowEl.querySelectorAll(".footer-note")).map((n) => n.textContent.trim());
  assert.ok(notes.includes("שינוי הרשאה זמין למנהל/ת בלבד."), "the role buttons keep theirs");
  assert.ok(notes.includes("איפוס סיסמה זמין למנהל/ת בלבד."), "the reset button now has its own");
  // ONE note per group of controls, not one per button - the rule
  // memberRoleButtonsHtml() already set for its three.
  assert.equal(notes.filter((n) => n === "איפוס סיסמה זמין למנהל/ת בלבד.").length, 1);
});

test("an admin gets the live button and no reason - the note is about the boundary, not decoration", async () => {
  const window = await openClubRoster(seeded("admin"), [memberRow()]);
  const btn = window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-reset-password"]');
  assert.equal(btn.disabled, false, "an admin may reset");
  assert.ok(!/איפוס סיסמה זמין למנהל\/ת בלבד/.test(window.document.body.textContent),
    "and is told nothing, because nothing is withheld");
});
