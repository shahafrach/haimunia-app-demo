// COMM-120 to COMM-125, the engagement cluster, executed for real in jsdom
// against the mock Supabase client (test/helpers/mockSupabase.mjs).
//
// WHAT THIS FILE VERIFIES
// - COMM-120 one reaction type, optimistic toggle add/remove, reactor avatar
//   strip and total, rollback with a message on failure.
// - COMM-125 a blocked member's reaction avatar is hidden, and the block list
//   only ever offers to unblock people the viewer blocked.
// (Comments, replies, mentions and the coach badge were dropped with text
// comments; their COMM-121 to COMM-124 tests went with them.)
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, holdPosts, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const RON_ID = "11111111-1111-1111-1111-111111111111";
const COACH_ID = "22222222-2222-2222-2222-222222222222";

function feedRow(extra) {
  return Object.assign({
    id: "p1",
    post_type: "POST_TEXT",
    author_id: "u2",
    author: { display_name: "רון", handle: "ron" },
    body: "הפוסט הראשון",
    visibility: "club",
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
    published_at: new Date(Date.now() - 5 * 60000).toISOString(),
    reaction_count: 0,
    comment_count: 0,
    media: [],
    metadata: {},
  }, extra || {});
}

function seeded(opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    feed_page_rows: [feedRow(opts && opts.row)],
    feed_impressions: [], feed_interactions: [], follows: [], hidden_posts: [], saved_posts: [],
    blocks: [], reactions: [], post_comments: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(window, mock) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  holdPosts(window, mock.db.feed_page_rows);
  await waitFor(() => window.document.querySelectorAll("#communityHeldPosts .post-card").length >= 1, 4000);
}
function card(window) { return window.document.querySelector('[data-post-id="p1"]'); }
// --- COMM-120 reactions -------------------------------------------------

test("COMM-120: tapping the reaction adds it, tapping again removes it, optimistically", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => mock.db.reactions.some((r) => r.post_id === "p1" && r.user_id === "u1"), 3000);
  await waitFor(() => !!card(window).querySelector(".reaction-strip"), 3000);
  assert.match(card(window).querySelector(".reaction-strip").textContent, /הגבתם/);
  assert.equal(mock.db.reactions.filter((r) => (r.kind || "cheer") === "cheer").length, 1, "one reaction row, one type");

  // The launch-readiness audit added an in-flight guard to react() (same
  // shape as pinTarget/unpinTarget's existing pinBusy) so a real double-tap
  // can't fire toggle_reaction twice before the first response lands. In a
  // real browser that in-flight window is a network round trip, dwarfing
  // any human double-tap cadence; in this jsdom harness the mock resolves
  // near-instantly, but the promise continuation still needs a real tick to
  // run (see the other `setTimeout(r, ...)` flush waits throughout this
  // suite) - without it this second click can land while the guard from
  // the first click's still-settling promise is up, and get silently
  // dropped instead of exercising the toggle-off path this test is for.
  await new Promise((r) => setTimeout(r, 20));

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => mock.db.reactions.length === 0, 3000);
  await waitFor(() => !card(window).querySelector(".reaction-strip"), 3000);
});

test("COMM-120: the card shows the first few reactor avatars and the total", async () => {
  const mock = seeded({
    row: { reaction_count: 3 },
    reactions: [
      { post_id: "p1", user_id: "a", kind: "cheer", created_at: "2026-08-28T08:00:00.000Z", profiles: { handle: "a", display_name: "אבי" } },
      { post_id: "p1", user_id: "b", kind: "cheer", created_at: "2026-08-28T08:01:00.000Z", profiles: { handle: "b", display_name: "בני" } },
      { post_id: "p1", user_id: "c", kind: "cheer", created_at: "2026-08-28T08:02:00.000Z", profiles: { handle: "c", display_name: "גיל" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);
  await waitFor(() => card(window).querySelectorAll(".reaction-strip .avatar-badge").length === 3, 3000);
  assert.match(card(window).querySelector(".reaction-strip").textContent, /3 הגבות/);
});

test("COMM-120: a failed reaction rolls back and shows a message", async () => {
  const mock = seeded();
  mock.onRpc("toggle_reaction", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => /לא ניתן היה להגיב/.test(window.document.body.textContent), 3000);
  assert.equal(card(window).querySelector(".reaction-strip"), null, "the optimistic strip was reverted");
  assert.equal(mock.db.reactions.length, 0, "nothing was written");
});

// --- COMM-121 replies -------------------------------------------------

// --- COMM-122 edit / delete -----------------------------------------

// --- COMM-123 mentions ---------------------------------------------

// --- COMM-124 coach emphasis --------------------------------------

// --- COMM-125 block effects -------------------------------------

test("COMM-125: a blocked member's reaction avatar is dropped", async () => {
  const mock = seeded({
    blocks: [{ blocker_id: "u1", blocked_id: "u2" }],
    row: { reaction_count: 1 },
    reactions: [
      { post_id: "p1", user_id: "u2", kind: "cheer", created_at: "2026-08-28T08:00:00.000Z", profiles: { handle: "ron", display_name: "רון" } },
    ],
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u2", body: "טקסט חסום", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);
  await waitFor(() => !!card(window).querySelector(".reaction-strip"), 3000);
  assert.equal(card(window).querySelectorAll(".reaction-strip .avatar-badge").length, 0, "the blocked reactor's avatar is dropped");
});

// Live bug hunt round 4 (2026-09-11): blocking had no reverse path
// anywhere in the app - no unblock() function, no "blocked members" list,
// nothing on the full profile overlay. Confirmed live: a permanent
// one-way action for the life of both accounts, recoverable only via
// direct database access.
test("a blocked member can be unblocked from the Account tab's own blocked-members list", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u2", handle: "ron", display_name: "רון", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    blocks: [{ blocker_id: "u1", blocked_id: "u2" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!window.document.querySelector('[data-blocked-members-section="1"]'), 4000);

  const section = window.document.querySelector('[data-blocked-members-section="1"]');
  assert.match(section.textContent, /רון/, "the blocked member's real name is shown, not just a raw id");
  const unblockBtn = section.querySelector('[data-community-action="unblock"][data-id="u2"]');
  assert.ok(unblockBtn, "an unblock control exists for a block this member actually initiated");

  unblockBtn.click();
  await waitFor(() => !mock.db.blocks.some((b) => b.blocker_id === "u1" && b.blocked_id === "u2"), 4000);
  await waitFor(() => !window.document.querySelector('[data-blocked-members-section="1"]'), 4000);
});

test("the blocked-members list only ever offers to unblock people the viewer blocked themselves, never someone who blocked the viewer", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u3", handle: "gil", display_name: "גיל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    // u3 blocked u1 - the OTHER direction. blockedIds (used to hide
    // comments/reactions) intentionally merges both directions, but
    // blockedByMe (this list) must not, or a member could "unblock"
    // someone who blocked them, undoing a decision that was never theirs.
    blocks: [{ blocker_id: "u3", blocked_id: "u1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 4000);
  assert.equal(window.document.querySelector('[data-blocked-members-section="1"]'), null,
    "no blocked-members section at all when the viewer hasn't blocked anyone themselves");
});

