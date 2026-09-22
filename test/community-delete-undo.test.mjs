// The five-second undo on the two community deletes a member can perform
// on their own content: a post and a comment.
//
// WHY THIS FILE EXISTS. The offline training log has confirmed AND offered
// an undo since the audit (askAppConfirm + offerUndo, app.js) — a
// confirmation stops the accident, an undo repairs the one that got through
// anyway. The community half confirmed and then wrote, and its sheets said
// so ("הפעולה לא ניתנת לביטול"). Same app, same finger, two promises. The UX
// review named the asymmetry; this pins the fix from both ends.
//
// WHAT IS ACTUALLY BEING ASSERTED, and it is not "a toast appears". The
// write is HELD rather than reversed (deferCommunityDelete, cloud.js): a
// post delete is a hard delete with cascades and a comment delete is
// comment_delete()'s soft delete, and neither has a client-callable inverse,
// so an undo that re-created the row would mint a new id and orphan every
// reply, reaction and notification pointing at the old one. So the three
// facts that matter are:
//   1. the row leaves the screen immediately (it is a delete, not a maybe),
//   2. NOTHING reaches the server while the undo is on screen,
//   3. "בטלו" means the write never happens at all — not that it happens
//      and is undone.
//
// THE FIVE-SECOND CLOCK IS EXERCISED FOR REAL once, in the last test. Every
// other test closes the window with settleToast(false), which is the same
// call app.js makes on pagehide — waiting out a real five seconds in each of
// six tests would add half a minute to a suite that already runs for ten.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const AGO = (min) => new Date(Date.now() - min * 60000).toISOString();

function feedRow(extra) {
  return Object.assign({
    id: "p1",
    post_type: "POST_TEXT",
    author_id: "u1",
    author: { display_name: "דנה", handle: "dana" },
    body: "הפוסט שאני עומדת למחוק",
    visibility: "club",
    created_at: AGO(5),
    published_at: AGO(5),
    reaction_count: 0,
    comment_count: 0,
    media: [],
    metadata: {},
  }, extra || {});
}

function seeded(opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    feed_page_rows: [feedRow()],
    feed_impressions: [], feed_interactions: [], follows: [], hidden_posts: [], saved_posts: [],
    blocks: [], reactions: [], post_comments: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("post_delete", (args, ctx) => { ctx.db.__deleted = args; return { data: null, error: null }; });
  return mock;
}

async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= 1, 4000);
}
async function openComments(window) {
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] [data-comment-thread="open"]'), 4000);
}
function card(window) { return window.document.querySelector('[data-post-id="p1"]'); }
const toast = (window) => window.document.getElementById("appToastBar");
const undoBtn = (window) => window.document.querySelector('#appToastBar [data-action="toast-action"]');

async function confirmDeletePost(window) {
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-delete"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
}

async function confirmDeleteComment(window) {
  window.document.querySelector('[data-post-id="p1"] [data-community-action="delete-comment"]').click();
  await waitFor(() => !!window.document.getElementById("communityConfirmTitle"), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
}

// --- the post -------------------------------------------------------------

test("deleting your own post offers the same undo toast the training log offers", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await confirmDeletePost(window);

  await waitFor(() => window.document.querySelector('[data-post-id="p1"]') === null, 3000);
  const bar = toast(window);
  assert.ok(bar, "the delete offers a toast, not silence");
  assert.match(bar.textContent, /הפוסט נמחק/, "and the toast names what left");
  assert.ok(undoBtn(window), "with a real undo control on it");
  assert.equal(undoBtn(window).textContent.trim(), "בטלו", "labelled exactly as the log's own undo is");
  assert.equal(mock.db.__deleted, undefined, "and nothing has reached the server yet");
});

test("undoing a post delete means the write never happens at all", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await confirmDeletePost(window);
  await waitFor(() => window.document.querySelector('[data-post-id="p1"]') === null, 3000);

  undoBtn(window).click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p1"]'), 3000);
  assert.match(card(window).textContent, /הפוסט שאני עומדת למחוק/, "the post is back, with its body intact");
  assert.equal(mock.db.__deleted, undefined, "post_delete was never called — the row was never touched");
  assert.equal(toast(window), null, "and the toast is gone once it has been used");
});

test("letting the undo window close sends the post delete once, and only once", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await confirmDeletePost(window);
  await waitFor(() => window.document.querySelector('[data-post-id="p1"]') === null, 3000);

  window.settleToast(false);
  await waitFor(() => !!mock.db.__deleted, 3000);
  assert.deepEqual(mock.db.__deleted, { post_id: "p1" });
  // A second close of an already-settled toast must not re-send: the whole
  // point of `settled` inside deferCommunityDelete is that onExpire and the
  // undo are one-shot whatever else fires.
  mock.db.__deleted = undefined;
  window.settleToast(false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.db.__deleted, undefined, "the held write went out exactly once");
});

// --- the comment ----------------------------------------------------------

const withComment = () => seeded({
  post_comments: [
    { id: "c1", post_id: "p1", author_id: "u1", body: "התגובה שלי", parent_comment_id: null, created_at: AGO(2), edited_at: null, deleted_at: null, status: "active", profiles: { handle: "dana", display_name: "דנה" } },
  ],
});

test("deleting your own comment offers the same undo toast", async () => {
  const mock = withComment();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  await confirmDeleteComment(window);

  await waitFor(() => !/התגובה שלי/.test(card(window).textContent), 3000);
  const bar = toast(window);
  assert.ok(bar, "the delete offers a toast, not silence");
  assert.match(bar.textContent, /התגובה נמחקה/);
  assert.equal(undoBtn(window).textContent.trim(), "בטלו");
  // Asserted on the RPC, not on the fixture row: the mock hands the client
  // the very objects it stores, so the optimistic in-place mark reaches
  // mock.db too. That is an artefact of the fixture (a real client holds a
  // deserialized copy) and would make a status check here pass or fail for
  // the wrong reason. "comment_delete has not been called" is the fact this
  // test is actually about.
  assert.equal(mock.callsTo("comment_delete").length, 0,
    "comment_delete has not run — nothing reached the server while the undo is on screen");
});

test("undoing a comment delete puts the comment back, status and all", async () => {
  const mock = withComment();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  await confirmDeleteComment(window);
  await waitFor(() => !/התגובה שלי/.test(card(window).textContent), 3000);

  undoBtn(window).click();
  await waitFor(() => /התגובה שלי/.test(card(window).textContent), 3000);
  // The optimistic removal MUTATES the comment row in place, and the array
  // snapshot holds the same object — restoring the array alone used to leave
  // a row that still said status:"removed", which is why putBack() restores
  // the two fields by hand. This is the assertion that would catch that
  // coming back: the placeholder must be gone, not just the array replaced.
  assert.doesNotMatch(card(window).textContent, /התגובה נמחקה/,
    "no removed-comment placeholder is left behind");
  assert.equal(mock.callsTo("comment_delete").length, 0, "and comment_delete was never called");
});

test("letting the undo window close soft-deletes the comment through comment_delete", async () => {
  const mock = withComment();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  await confirmDeleteComment(window);
  await waitFor(() => !/התגובה שלי/.test(card(window).textContent), 3000);

  window.settleToast(false);
  await waitFor(() => mock.callsTo("comment_delete").length === 1, 3000);
  assert.deepEqual(mock.callsTo("comment_delete")[0], { p_comment_id: "c1" },
    "the held RPC goes out with the comment it was holding");
  assert.equal(mock.db.post_comments.find((c) => c.id === "c1").status, "removed");
  assert.ok(!!mock.db.post_comments.find((c) => c.id === "c1"),
    "still a soft delete — the row survives so a reply keeps its parent");
});

// --- the clock, and the one thing a held write must never do --------------

test("the undo window really is the toast's own five seconds, not a promise", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await confirmDeletePost(window);
  await waitFor(() => window.document.querySelector('[data-post-id="p1"]') === null, 3000);

  // Well inside the window: still nothing on the wire, toast still offered.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(mock.db.__deleted, undefined, "1.5s in, the member can still change their mind");
  assert.ok(toast(window), "and the undo is still on screen");

  // Past it: the held write goes out on the toast's own timer, with nobody
  // calling settleToast by hand.
  await waitFor(() => !!mock.db.__deleted, 6000);
  assert.deepEqual(mock.db.__deleted, { post_id: "p1" });
  await waitFor(() => toast(window) === null, 2000);
});

test("a second delete does not strand the first one — the older held write goes out", async () => {
  const mock = seeded({
    feed_page_rows: [feedRow(), feedRow({ id: "p2", body: "הפוסט השני" })],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!window.document.querySelector('[data-post-id="p2"]'), 4000);

  await confirmDeletePost(window);
  await waitFor(() => window.document.querySelector('[data-post-id="p1"]') === null, 3000);
  assert.equal(mock.db.__deleted, undefined);

  // Deleting a second post replaces the toast. showToast() settles the one
  // it replaces, which is what stops the first delete being silently
  // dropped — a held write with no toast left to release it would never
  // reach the server at all.
  window.document.querySelector('[data-post-id="p2"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('[data-post-id="p2"] .post-menu'), 3000);
  window.document.querySelector('[data-post-id="p2"] [data-community-action="post-delete"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();

  await waitFor(() => !!mock.db.__deleted, 3000);
  assert.deepEqual(mock.db.__deleted, { post_id: "p1" }, "the first delete was released, not lost");
});
