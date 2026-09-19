// COMM-377. Member roster screen: browse the full membership list, newest-
// joined first, reusing admin_search_members' exact row shape/renderer
// (admin_member_roster, COMM-374, returns the identical eight columns -
// pgTAP 0060 asserts the two `pg_get_function_result` strings are byte-
// identical) rather than a second row template.
//
// THAT GAP IS CLOSED (202609180001). admin_member_roster sorts and pages on
// coalesce(invite_redemptions.redeemed_at, profiles.created_at) and used to
// return only redeemed_at - so once a page's last row had no
// invite_redemptions row at all (redeemed_at null), there was no correct
// next cursor and loadRoster() stopped rather than resend a null cursor
// (which the RPC reads as "start over"). The RPC now returns that coalesced
// value as sort_key, so the roster pages straight through such a row; the
// old stop-early behaviour survives only as the un-migrated-server fallback,
// and both are asserted below.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(extra, role) {
  const profiles = [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true },
  ];
  const mock = createMockSupabase(Object.assign({
    profiles,
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  seedAdminStepUp(mock, "u1", "dana@members.haimuniya.invalid");
  return mock;
}

// Redesign, Phase 1: renderMemberManagement()/renderMemberRoster() moved
// from Community's "account" sub-tab to the Manage tab's own "members"
// sub-tab.
async function openAccountTab(window) {
  // The club panel (2026-09-15): the two management panels were made fully
  // disjoint, so club surfaces live behind the head coach's row. An admin
  // fixture gets BOTH rows and reaches this one by its own id; a coach
  // fixture has only the one, under the shared id.
  (window.document.getElementById("tabClubManageBtn") || window.document.getElementById("tabManageBtn")).click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="members"]').click();
}

// The RPC's real row shape since 202609180001: sort_key is
// coalesce(redeemed_at, profiles.created_at), so it defaults to whatever
// redeemed_at this row was given and a caller can override just one of them
// to build the case that matters (a member with no invite_redemptions row:
// redeemed_at null, sort_key their profile's created_at).
function rosterRow(role, extra) {
  const row = Object.assign({ id: `m-${role}`, handle: role, display_name: role, avatar_url: null, is_admin: false, role: "member", redeemed_at: "2026-08-01T00:00:00Z", last_activity_on: null }, extra || {});
  if (!("sort_key" in row)) row.sort_key = row.redeemed_at;
  return row;
}

test("a plain member never sees the roster, and admin_member_roster is never called", async () => {
  const mock = seeded({}, "member");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => { calls.push(args); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  // The ROW is shown to everyone since management became a separate identity
  // (2026-09-15): gating it on the signed-in member would hide it from the
  // owner, whose training account deliberately holds nothing. So the stronger
  // assertion is not "no door" but "the door opens onto a login" - and, below,
  // that nothing behind it loaded.
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector("#content .page-title"), 4000);
  assert.ok(window.document.getElementById("panelUnlock"),
    "a plain member reaches a management login, never the panel");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-member-roster-section="1"]'), null);
  assert.equal(calls.length, 0);
});

test("a coach (is_staff, not admin) sees the roster read-only", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  const btn = window.document.querySelector('[data-community-action="admin-grant-coach"]');
  assert.ok(btn, "the role control still renders for a coach viewer");
  assert.equal(btn.disabled, true, "but it is disabled");
});

test("fresh-eyes audit: a coach can filter the loaded roster by name/handle, not only an admin", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob", { display_name: "בוב" }), rosterRow("noa", { display_name: "נועה" })], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  // Scoped to the roster section itself, not document.body as a whole:
  // "בוב" is a substring of "סיבובים" (rounds), already on screen from
  // unrelated WOD-builder copy, so a body-wide text match is unreliable here.
  const rosterSection = () => window.document.querySelector('[data-member-roster-section="1"]');
  await waitFor(() => !!rosterSection() && rosterSection().textContent.includes("בוב"), 3000);
  const input = window.document.getElementById("rosterSearch");
  assert.ok(input, "the roster gets its own search box once it has rows, available to a coach too");
  input.value = "נוע";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const section = rosterSection();
  assert.match(section.textContent, /נועה/, "the matching member still renders");
  assert.doesNotMatch(section.textContent, /בוב/, "a non-matching member is filtered out");
});

test("a roster search matching nothing among loaded members shows an empty state naming the search, distinct from the zero-row case", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob", { display_name: "בוב" })], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  const rosterSection = () => window.document.querySelector('[data-member-roster-section="1"]');
  await waitFor(() => !!rosterSection() && rosterSection().textContent.includes("בוב"), 3000);
  const input = window.document.getElementById("rosterSearch");
  input.value = "zzz-no-match";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const section = rosterSection();
  assert.match(section.textContent, /לא נמצאו חברים תואמים/);
});

// REWRITTEN BY 202609160005, which reversed the product decision this test
// used to pin. It asserted `=== null` on the remove control, on COMM-377's
// reading that removal belonged only to renderMemberManagement()'s search
// panel. That panel returns "" for anyone who is not is_admin(), so the rule
// it was defending meant the head coach - the role that owns the invite
// surface and the only one whose panel renders it - could add members to the
// club and never take one off. The roster is the board; it acts now.
test("an admin sees the roster with live role controls AND the remove control on a roster row", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  const section = window.document.querySelector('[data-member-roster-section="1"]');
  const btn = section.querySelector('[data-community-action="admin-grant-coach"]');
  assert.equal(btn.disabled, false);
  assert.ok(section.querySelector('[data-community-action="admin-remove-member"]'),
    "the roster offers the remove control to a viewer who outranks the row");
});

test("a head coach can remove a member straight off the roster, and the call is admin_remove_member", async () => {
  const mock = seeded({}, "head_coach");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const removeCalls = [];
  mock.onRpc("admin_remove_member", (args) => { removeCalls.push(args); return { error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  const btn = window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-remove-member"]');
  assert.ok(btn, "a head coach - not an admin - is offered the control");
  btn.click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  // The destructive direction asks first, like every other one on this row.
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => removeCalls.length === 1, 3000);
  assert.deepEqual(removeCalls[0], { p_user_id: "m-bob" });
});

test("the rank guard is drawn, not just enforced: a head coach gets no remove control against another head coach", async () => {
  const mock = seeded({}, "head_coach");
  mock.onRpc("admin_member_roster", () => ({ data: [
    rosterRow("peer", { role: "head_coach" }),
    rosterRow("bob"),
  ], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("peer"), 3000);
  const rows = Array.from(window.document.querySelectorAll('[data-member-roster-section="1"] .log-row'));
  const peerRow = rows.find((r) => r.textContent.includes("peer"));
  const bobRow = rows.find((r) => r.textContent.includes("bob"));
  assert.ok(peerRow && bobRow, "both rows render");
  assert.equal(peerRow.querySelector('[data-community-action="admin-remove-member"]'), null,
    "an equal rank is out of reach, and the button is not drawn onto a call the server would refuse");
  assert.ok(bobRow.querySelector('[data-community-action="admin-remove-member"]'),
    "a member below the viewer's rank still gets one");
});

test("a plain coach holds no remove permission, so no roster row offers the control", async () => {
  const mock = seeded({}, "coach");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  assert.equal(
    window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-remove-member"]'),
    null, "community.member.remove starts at head_coach");
});

// REPORTED LIVE, 2026-09-16: "after giving coach permission, it's not
// changing". The RPC succeeded every time; the roster never re-read it.
// adminGrantCoach / adminSetRole / adminRevokeCoach all refreshed only
// renderMemberManagement()'s SEARCH panel, which is admin-only and empty
// until somebody types into it - so acting from the roster, the browsable
// list and the only one a head coach has, left the changed row on screen
// unchanged. adminRemoveMember got the roster reload when its control moved
// here; the other three did not.
test("a role change from the roster re-reads the roster, so the row actually updates", async () => {
  const mock = seeded({}, "admin");
  let role = "member";
  const rosterCalls = [];
  mock.onRpc("admin_member_roster", () => {
    rosterCalls.push(1);
    return { data: [rosterRow("bob", { role })], error: null };
  });
  mock.onRpc("admin_grant_coach", () => { role = "coach"; return { error: null }; });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  const before = rosterCalls.length;

  window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-grant-coach"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();

  await waitFor(() => rosterCalls.length > before, 3000);
  // The row itself, not just the extra call: the RPC was always firing, and
  // what was broken was the screen still showing the old answer.
  await waitFor(() => {
    const section = window.document.querySelector('[data-member-roster-section="1"]');
    return !!section && /מאמן/.test(section.textContent);
  }, 3000);
});

test("the roster's role buttons are the exact adminGrantCoach/adminSetRole/adminRevokeCoach RPCs already wired to member search", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [rosterRow("bob")], error: null }));
  const grantCalls = [];
  mock.onRpc("admin_grant_coach", (args) => { grantCalls.push(args); return { error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
  window.document.querySelector('[data-member-roster-section="1"] [data-community-action="admin-grant-coach"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => grantCalls.length === 1, 3000);
  assert.deepEqual(grantCalls[0], { p_user_id: "m-bob" });
});

test("a zero-row page still renders the section header, never a special empty message (COMM-377's own frontend-states note)", async () => {
  const mock = seeded({}, "admin");
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector('[data-member-roster-section="1"]'), 3000);
  assert.doesNotMatch(window.document.querySelector('[data-member-roster-section="1"]').textContent, /אין/, "no special empty copy");
});

test("Error state renders the ticket's own copy with a working retry", async () => {
  const mock = seeded({}, "admin");
  let calls = 0;
  mock.onRpc("admin_member_roster", () => { calls++; return calls === 1 ? { data: null, error: { message: "boom" } } : { data: [rosterRow("bob")], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את רשימת החברים."), 3000);
  window.document.querySelector('[data-community-action="roster-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("bob"), 3000);
});

test("Load more pages via the cursor, and existing search is untouched by the roster's own state", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => {
    calls.push(args);
    if (calls.length === 1) {
      const page = Array.from({ length: 25 }, (_, i) => rosterRow(`p1-${i}`, { id: `p1-${i}`, redeemed_at: `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z` }));
      return { data: page, error: null };
    }
    return { data: [rosterRow("older", { redeemed_at: "2026-07-01T00:00:00Z" })], error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("p1-0"), 3000);
  const moreBtn = window.document.querySelector('[data-community-action="roster-more"]');
  assert.ok(moreBtn, "a full 25-row first page still offers Load more");
  moreBtn.click();
  await waitFor(() => calls.length === 2, 3000);
  assert.equal(calls[1].p_cursor, "2026-08-01T00:00:00Z", "pages on the last row's own sort_key, oldest-so-far");
  await waitFor(() => window.document.body.textContent.includes("older"), 3000);
});

// 202609180001. The case the roster used to give up on: the last row of a
// full page is a member with NO invite_redemptions row, so redeemed_at is
// null and the only date that can page past them is the created_at the RPC
// sorted on - which it now returns as sort_key.
test("a page ending on a member with no invite_redemptions row pages on sort_key and keeps going", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => {
    calls.push(args);
    if (calls.length === 1) {
      return { data: Array.from({ length: 25 }, (_, i) => rosterRow(`p1-${i}`, {
        id: `p1-${i}`,
        // The 25th row is the boundary: no redemption, so the date the
        // server ordered on is their profile's created_at and nothing else.
        redeemed_at: i === 24 ? null : `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z`,
        sort_key: i === 24 ? "2026-07-15T00:00:00Z" : `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z`,
      })), error: null };
    }
    return { data: [rosterRow("older", { redeemed_at: "2026-07-01T00:00:00Z" })], error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => window.document.body.textContent.includes("p1-0"), 3000);
  const moreBtn = window.document.querySelector('[data-community-action="roster-more"]');
  assert.ok(moreBtn, "load more IS offered past a null-redeemed_at boundary row now that its sort_key came back with it");
  moreBtn.click();
  await waitFor(() => calls.length === 2, 3000);
  assert.equal(calls[1].p_cursor, "2026-07-15T00:00:00Z",
    "and the cursor is that row's sort_key - its profiles.created_at - never its null redeemed_at, which the RPC would read as 'no bound at all' and answer with the top of the list");
  assert.equal(calls[1].p_cursor_id, "p1-24", "paired with the same row's id, the tie-break half 202609160002 added");
  await waitFor(() => window.document.body.textContent.includes("older"), 3000);
});

test("against an UN-MIGRATED server (no sort_key column) pagination still stops rather than looping", async () => {
  const mock = seeded({}, "admin");
  const calls = [];
  mock.onRpc("admin_member_roster", (args) => {
    calls.push(args);
    // Deliberately the pre-202609180001 row shape: sort_key deleted, not
    // null. This is the client-ships-first half of the deploy window.
    const page = Array.from({ length: 25 }, (_, i) => {
      const row = rosterRow(`p${calls.length}-${i}`, { id: `p${calls.length}-${i}`, redeemed_at: i === 24 ? null : `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z` });
      delete row.sort_key;
      return row;
    });
    return { data: page, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => calls.length === 1, 3000);
  // Exactly the old behaviour: "load more" must not render, and a second
  // call must never happen on its own (which would restart at the top, per
  // the RPC's own `p_cursor is null or ...` clause, and loop the same 25
  // rows forever). Degrading to the old stop-early is the point - the one
  // thing that must not happen is the loop.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(window.document.querySelector('[data-community-action="roster-more"]'), null, "load more is not offered when neither sort_key nor redeemed_at can be a cursor");
  assert.equal(calls.length, 1, "admin_member_roster was called exactly once - pagination never looped");
});
