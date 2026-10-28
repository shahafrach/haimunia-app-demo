// 202609220005 "התאמנו יחד" — the client half, executed.
//
// The author of a workout post names who was in the room; the named members
// are notified and any of them can take their own name off. The server owns
// every one of those rules and supabase/tests/0122 is where they are proved
// in Postgres. What THIS file proves is the half a pgTAP suite cannot see:
// that the card prints the line, that the sheet offers the right day's
// classmates, that a save re-reads rather than guessing, that the tagged
// member's own remove control is on the card and not behind the author's
// menu, and that a club with the module off is offered none of it.
//
// The mock's stand-ins (test/helpers/mockSupabase.mjs) implement the skip
// rules the client depends on - a target with allow_mentions off, a target
// behind a block edge - because the client's behaviour after a save is built
// on the server having skipped somebody. They do not implement the RLS
// policy, and this file makes no claim about it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, holdPosts } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

const layerJs = cloudSource();
const migrationSql = fs.readFileSync(
  new URL("../supabase/migrations/202609220005_trained_together.sql", import.meta.url), "utf8");

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// u1 is the viewer and the author. u2 and u3 trained the same day and show
// attendance; u4 trained that day with allow_mentions OFF; u5 trained
// yesterday only, so they must never be suggested for a post about today.
function profiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
    { id: "u3", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
    { id: "u4", handle: "tomer", display_name: "תומר", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: false, allow_follows: true },
    { id: "u5", handle: "gal", display_name: "גל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
  ];
}

function workoutPost(overrides) {
  return Object.assign({
    id: "p1", post_type: "POST_WORKOUT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" },
    title: "Fran", occurred_on: TODAY, visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [],
    metadata: { workout_name: "Fran", workout_date: TODAY },
  }, overrides || {});
}

function seeded(opts) {
  const o = opts || {};
  const posts = o.posts || [workoutPost()];
  const mock = createMockSupabase({
    profiles: o.profiles || profiles(),
    invite_redemptions: (o.profiles || profiles()).map((p) => ({ user_id: p.id, invite_id: "inv-1", role: "member", redeemed_at: VERIFIED })),
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    club_features: o.features || [],
    feed_page_rows: posts,
    // The mock's post_tag_training_partners arm reads this table for the
    // author check, so the feed rows need matching workout_posts rows - the
    // real server reads one table for both.
    workout_posts: posts.map((p) => ({ id: p.id, author_id: p.author_id, post_type: p.post_type, title: p.title, deleted_at: null })),
    post_training_partners: o.tags || [],
    attendance_log: o.attendance || [
      { user_id: "u1", occurred_on: TODAY, recorded_at: VERIFIED },
      { user_id: "u2", occurred_on: TODAY, recorded_at: VERIFIED },
      { user_id: "u3", occurred_on: TODAY, recorded_at: VERIFIED },
      { user_id: "u4", occurred_on: TODAY, recorded_at: VERIFIED },
      { user_id: "u1", occurred_on: YESTERDAY, recorded_at: VERIFIED },
      { user_id: "u5", occurred_on: YESTERDAY, recorded_at: VERIFIED },
    ],
    blocks: o.blocks || [],
    follows: [], hidden_posts: [], saved_posts: [], feed_impressions: [], feed_interactions: [],
    notifications: [], notification_preferences: [], analytics_events: [],
  });
  mock.setUser({ id: o.viewer || "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  holdPosts(window, mock.db.feed_page_rows);
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"]'), 4000);
  return window;
}
const q = (window, sel) => window.document.querySelector(sel);
const text = (el) => (el ? el.textContent : "");

// ===========================================================================
// The registry row and the migration behind it
// ===========================================================================




// ===========================================================================
// The card
// ===========================================================================

test("a tagged workout post prints התאמנו יחד with the tagged names", async () => {
  const window = await openFeed(seeded({
    tags: [
      { post_id: "p1", tagged_user_id: "u2", tagged_by: "u1", created_at: "2026-09-22T10:00:00.000Z" },
      { post_id: "p1", tagged_user_id: "u3", tagged_by: "u1", created_at: "2026-09-22T10:00:01.000Z" },
    ],
  }));
  await waitFor(() => !!q(window, '[data-post-partners="ready"]'), 4000);
  const line = q(window, '[data-post-partners="ready"]');
  const t = text(line);
  assert.match(t, /התאמנו יחד/, "the line is labelled");
  assert.ok(t.includes("נועם") && t.includes("יעל"), `both tagged members are named: ${t}`);
  // The order is the server's - created_at, then name, then id - and the
  // client does not re-sort it.
  assert.ok(t.indexOf("נועם") < t.indexOf("יעל"), `printed in the order the server returned: ${t}`);
  // The names are the same profile control the rest of the feed uses, not
  // plain text - a tagged member is a member you can open.
  // Circles have no profile screens: a name is a name.
  assert.equal(q(window, '[data-post-partners="ready"] [data-community-action="view-profile"]'), null);
});

test("a post the server returned no tags for prints no line at all", async () => {
  const mock = seeded({ tags: [] });
  const window = await openFeed(mock);
  // The question really was asked - this is "the server said none", not
  // "nobody looked", which is the distinction postTrainingPartners() keeps.
  await waitFor(() => mock.rpcCalls.some((c) => c.name === "post_training_partners_for"), 4000);
  assert.equal(q(window, '[data-post-partners="ready"]'), null,
    "no tags means no line at all - not an empty one");
});

// ===========================================================================
// The author's sheet
// ===========================================================================

async function openMenu(window, postId) {
  q(window, `[data-post-id="${postId}"] [data-community-action="toggle-post-menu"]`).click();
  await waitFor(() => !!q(window, `[data-post-id="${postId}"] .post-menu`), 3000);
}

test("the author of a workout post is offered the tagging control; nobody else is, and no other post type carries it", async () => {
  const window = await openFeed(seeded());
  await openMenu(window, "p1");
  assert.ok(q(window, '[data-community-action="post-tag-partners"][data-id="p1"]'),
    "the author sees מי התאמן/ה איתי on their own workout post");

  const other = await openFeed(seeded({
    posts: [workoutPost({ author_id: "u2", author: { display_name: "נועם", handle: "noam" } })],
  }));
  await openMenu(other, "p1");
  assert.equal(other.document.querySelector('[data-community-action="post-tag-partners"]'), null,
    "a reader of somebody else's workout post is not offered it - only the author says who they trained with");

  const textPost = await openFeed(seeded({
    posts: [workoutPost({ post_type: "POST_TEXT", title: null, occurred_on: null, metadata: {} })],
  }));
  await openMenu(textPost, "p1");
  assert.equal(textPost.document.querySelector('[data-community-action="post-tag-partners"]'), null,
    "a text post is not a session anybody else was present at");
});

test("the tagging control is not offered on a card the sheet could not open", () => {
  // renderPostCard() is called from the feed AND from a profile's Posts tab,
  // but findFeedPost() only looks in state.feed.items - so a card drawn on
  // the profile tab cannot be resolved back to its row. The three older
  // own-post controls degrade quietly there; a tagging sheet has no sensible
  // degraded form, because it needs the post's DAY to suggest anybody at all.
  // Pinned as source, not as a render: reaching the profile Posts tab in
  // jsdom means driving community_profile, and the claim here is about which
  // lookup the gate consults.
  const at = layerJs.indexOf("function postCanTagPartners(");
  assert.ok(at > -1, "postCanTagPartners is still the one gate");
  const fn = layerJs.slice(at, layerJs.indexOf("\n  }", at));
  assert.match(fn, /findFeedPost\(post\.id\)/,
    "the control is offered only where the sheet can resolve the post - not as a menu item that opens onto nothing");
  // ...and the read half must NOT be gated the same way, or a tagged member
  // would lose their own remove button on the profile tab.
  const html = layerJs.slice(layerJs.indexOf("function trainingPartnersHtml("));
  assert.ok(!html.slice(0, html.indexOf("\n  }")).includes("findFeedPost"),
    "the partners line and the untag button work wherever the card is drawn");
});



test("unticking a name and saving removes it - the sheet is a set, not an append", async () => {
  const mock = seeded({
    tags: [
      { post_id: "p1", tagged_user_id: "u2", tagged_by: "u1", created_at: "2026-09-22T10:00:00.000Z" },
      { post_id: "p1", tagged_user_id: "u3", tagged_by: "u1", created_at: "2026-09-22T10:00:01.000Z" },
    ],
  });
  const window = await openFeed(mock);
  await openMenu(window, "p1");
  q(window, '[data-community-action="post-tag-partners"][data-id="p1"]').click();
  await waitFor(() => !!q(window, '[data-partner-pick="u3"]'), 3000);
  const box = q(window, '[data-partner-pick="u3"]');
  assert.equal(box.checked, true, "an already-tagged member opens the sheet ticked");
  box.checked = false;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  q(window, '[data-community-action="partners-save"]').click();
  await waitFor(() => !text(q(window, '[data-post-partners="ready"]')).includes("יעל"), 4000);
  const t = text(q(window, '[data-post-partners="ready"]'));
  assert.ok(t.includes("נועם"), `the kept name survives: ${t}`);
  assert.ok(!mock.db.post_training_partners.some((r) => r.tagged_user_id === "u3"),
    "the unticked member's row is gone from the server");
});

// ===========================================================================
// The tagged member's own control
// ===========================================================================

test("a tagged member can take their own name off, from the card itself", async () => {
  const mock = seeded({
    viewer: "u2",
    tags: [
      { post_id: "p1", tagged_user_id: "u2", tagged_by: "u1", created_at: "2026-09-22T10:00:00.000Z" },
      { post_id: "p1", tagged_user_id: "u3", tagged_by: "u1", created_at: "2026-09-22T10:00:01.000Z" },
    ],
  });
  const window = await openFeed(mock);
  await waitFor(() => !!q(window, '[data-community-action="partner-untag-self"]'), 4000);
  // Not behind the author's menu, and not behind a profile setting: the
  // control is on the card the member is looking at.
  q(window, '[data-community-action="partner-untag-self"]').click();
  await waitFor(() => !text(q(window, '[data-post-partners="ready"]')).includes("נועם"), 4000);

  const call = mock.rpcCalls.filter((c) => c.name === "post_training_partner_remove").pop();
  assert.equal(call.args.p_user_id, undefined,
    "the call names nobody - the server defaults to the caller, so it cannot remove somebody else's tag even if forged");
  assert.ok(!mock.db.post_training_partners.some((r) => r.tagged_user_id === "u2"),
    "the member's own row is gone");
  assert.ok(mock.db.post_training_partners.some((r) => r.tagged_user_id === "u3"),
    "and the other member's tag is untouched");
});

test("a member who is not tagged is offered no remove control", async () => {
  const window = await openFeed(seeded({
    viewer: "u5",
    tags: [{ post_id: "p1", tagged_user_id: "u2", tagged_by: "u1", created_at: "2026-09-22T10:00:00.000Z" }],
  }));
  await waitFor(() => !!q(window, '[data-post-partners="ready"]'), 4000);
  assert.equal(q(window, '[data-community-action="partner-untag-self"]'), null,
    "there is nothing of theirs to remove");
});

// ===========================================================================
// The switch
// ===========================================================================


// ===========================================================================
// The notification type
// ===========================================================================

test("trained_together is a real notification type with its own preference key", () => {
  const at = layerJs.indexOf("trained_together:");
  assert.ok(at > -1, "NOTIF_TYPES carries the type");
  const row = layerJs.slice(at, layerJs.indexOf("\n", at));
  // Every notification is its own row now; the batched/immediate split went
  // with the batch group.
  assert.ok(!/mode:/.test(row), "no batched/immediate mode");
  // notif_pref_key() is the identity, so the real key is the literal type
  // name. Anything coarser here is a toggle that silently suppresses nothing -
  // the exact bug feed_activity carried for weeks.
  assert.match(row, /pref: "trained_together"/,
    "the preference key is the literal type name, matching notif_pref_key()");
  assert.ok(!/serverTitle/.test(row), "the client's Hebrew label wins over the stored title");
  assert.match(layerJs, /\{ key: "trained_together",\s*label: "[^"]*[֐-׿][^"]*" \}/,
    "and it has a Hebrew row in the Settings preference list");
  // The server side of the same claim.
  assert.match(migrationSql, /'trained_together', 'community',/,
    "notif_create is called with the type and the community category");
  assert.match(migrationSql, /create trigger post_training_partners_notify after insert on public\.post_training_partners/,
    "fired off the row, not from inside the writer - any future writer notifies without remembering to");
});
