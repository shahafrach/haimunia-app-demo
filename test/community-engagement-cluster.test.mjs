// COMM-120 to COMM-125, the engagement cluster, executed for real in jsdom
// against the mock Supabase client (test/helpers/mockSupabase.mjs).
//
// WHAT THIS FILE VERIFIES
// - COMM-120 reactions are three kinds (fist bump, fire, clap), each an
//   optimistic toggle with a rollback and a message on failure, and the
//   "who reacted" sheet lists the people with their kind.
// - COMM-125 a blocked member's reaction is hidden, and the block list (in Me)
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
  // Handed to the screen directly; the circle feed read must not replace it.
  mock.onRpc("circle_feed", () => ({ data: null, error: { message: "offline" } }));
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  holdPosts(window, mock.db.feed_page_rows);
  await waitFor(() => window.document.querySelectorAll("#communityHeldPosts .post-card").length >= 1, 4000);
}
function pressed(window, kind) { return card(window).querySelector(`[data-community-action="react"][data-kind="${kind}"]`).getAttribute("aria-pressed"); }
function card(window) { return window.document.querySelector('[data-post-id="p1"]'); }
// --- COMM-120 reactions -------------------------------------------------

test("COMM-120: tapping a reaction adds it, tapping again removes it, optimistically; the kinds are independent", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);
  const tap = (kind) => card(window).querySelector(`[data-community-action="react"][data-kind="${kind}"]`).click();

  tap("fire");
  assert.equal(pressed(window, "fire"), "true", "optimistic: the button reads pressed before the server answers");
  assert.equal(pressed(window, "clap"), "false");
  await waitFor(() => mock.callsTo("toggle_reaction").length === 1, 3000);
  assert.equal(mock.callsTo("toggle_reaction")[0].p_kind, "fire");
  // The in-flight guard drops a tap that lands before the first settles; a
  // real tick is what a real second tap has.
  await new Promise((r) => setTimeout(r, 20));
  tap("clap");
  assert.equal(pressed(window, "fire"), "true", "a member may hold all three: the second does not replace the first");
  assert.equal(pressed(window, "clap"), "true");
  await new Promise((r) => setTimeout(r, 20));
  tap("fire");
  assert.equal(pressed(window, "fire"), "false", "tapping again takes it back");
});

test("COMM-120: a failed reaction rolls back and shows a message", async () => {
  const mock = seeded();
  mock.onRpc("toggle_reaction", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);

  card(window).querySelector('[data-community-action="react"][data-kind="fist_bump"]').click();
  await waitFor(() => /לא ניתן היה להגיב/.test(window.document.body.textContent), 3000);
  assert.equal(pressed(window, "fist_bump"), "false", "the optimistic press was reverted");
});

test("COMM-120: the who-reacted sheet lists people with the kind they chose", async () => {
  const mock = seeded({
    row: { reaction_counts: { fist_bump: 1, fire: 1 }, reaction_count: 2 },
    reactions: [
      { post_id: "p1", user_id: "a", kind: "fist_bump", created_at: "2026-08-28T08:00:00.000Z", profiles: { display_name: "אבי", emoji: "🦁" } },
      { post_id: "p1", user_id: "b", kind: "fire", created_at: "2026-08-28T08:01:00.000Z", profiles: { display_name: "בני", emoji: "🌿" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);
  card(window).querySelector('[data-community-action="reactors"]').click();
  await waitFor(() => window.document.querySelectorAll("[data-reactor-user]").length === 2, 3000);
  const text = window.document.querySelector('[data-cloud-dialog="reactors"]').textContent;
  assert.match(text, /אבי/);
  assert.match(text, /🔥/);
});

// --- COMM-125 block effects -------------------------------------

test("COMM-125: a blocked member's reaction is dropped from the who-reacted sheet", async () => {
  const mock = seeded({
    blocks: [{ blocker_id: "u1", blocked_id: "u2" }],
    row: { reaction_counts: { fist_bump: 1 }, reaction_count: 1 },
    reactions: [
      { post_id: "p1", user_id: "u2", kind: "fist_bump", created_at: "2026-08-28T08:00:00.000Z", profiles: { display_name: "רון", emoji: "🦁" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);
  await waitFor(() => !!window.document.querySelector('[data-community-action="reactors"]'), 3000);
  window.document.querySelector('[data-community-action="reactors"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reactors"]'), 3000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(window.document.querySelectorAll("[data-reactor-user]").length, 0, "the blocked reactor is not listed");
});

// Live bug hunt round 4 (2026-09-11): blocking had no reverse path
// anywhere in the app - no unblock() function, no "blocked members" list,
// nothing on the full profile overlay. Confirmed live: a permanent
// one-way action for the life of both accounts, recoverable only via
// direct database access.
test("a blocked member can be unblocked from Me's own blocked-members list", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", recovery_verified_at: VERIFIED },
      { id: "u2", handle: "ron", display_name: "רון", recovery_verified_at: VERIFIED },
    ],
    blocks: [{ blocker_id: "u1", blocked_id: "u2" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.switchAppTab("me");
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
      { id: "u1", handle: "dana", display_name: "דנה", recovery_verified_at: VERIFIED },
      { id: "u3", handle: "gil", display_name: "גיל", recovery_verified_at: VERIFIED },
    ],
    // u3 blocked u1 - the OTHER direction. blockedIds (used to hide
    // reactions) intentionally merges both directions, but blockedByMe (this
    // list) must not, or a member could "unblock" someone who blocked them,
    // undoing a decision that was never theirs.
    blocks: [{ blocker_id: "u3", blocked_id: "u1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityProfile"), 4000);
  assert.equal(window.document.querySelector('[data-blocked-members-section="1"]'), null,
    "no blocked-members section at all when the viewer hasn't blocked anyone themselves");
});
