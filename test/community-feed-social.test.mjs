// The social feed pass: one card layout, a reaction pill with a summary and
// a list behind it, two comments under every card, the classmates strip, the
// club-WOD roll-up, the new-posts pill, the composer row and the welcome an
// empty feed shows.
//
// WHAT THIS FILE VERIFIES AND WHAT IT CANNOT. Everything here is DOM: which
// elements exist, in what document order, carrying what text and what ARIA.
// jsdom has no layout, so not one assertion below is about geometry - "the
// pill and the summary share a line", "the strip scrolls sideways", "nothing
// overflows 390px" are measured in real Chromium by
// scripts/browser-check/community-feed-social.mjs and are not, and must not
// be, inferred from anything in this file.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const BASE = Date.now() - 5 * 60000;
const at = (min) => new Date(BASE - min * 60000).toISOString();

const PROFILES = [
  { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  { id: "u3", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
];

function seeded(feedRows, extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: PROFILES,
    invite_redemptions: PROFILES.map((p) => ({ user_id: p.id, invite_id: "inv-1", role: "member", redeemed_at: VERIFIED })),
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    feed_page_rows: feedRows,
    reactions: [], post_comments: [], follows: [], blocks: [],
    hidden_posts: [], saved_posts: [], attendance_log: [],
    feed_impressions: [], feed_interactions: [], analytics_events: [],
    club_wod_board_rows: [], community_streaks: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

function textPost(id, overrides) {
  return Object.assign({
    id, post_type: "POST_TEXT", author_id: "u2",
    author: { display_name: "נועם", handle: "noam" },
    body: "פוסט " + id, visibility: "club",
    created_at: at(3), published_at: at(3),
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  }, overrides || {});
}

const openFeed = async (window, atLeast = 1) => {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= atLeast, 4000);
};
const card = (window, id) => window.document.querySelector(`[data-post-id="${id}"]`);
const renderedIds = (window) => Array.from(window.document.querySelectorAll("#communityFeedList [data-post-id]")).map((el) => el.getAttribute("data-post-id"));

// ===== 1. One card layout =================================================

test("every post type draws the same body order: media, then text, then the result block", async () => {
  const media = [{ url: "https://example.invalid/a.jpg", alt_text: "אימון" }];
  const mock = seeded([
    textPost("p-text", { post_type: "POST_TEXT", body: "טקסט בלבד עם תמונה", media }),
    textPost("p-photo", { post_type: "POST_PHOTO", body: "כיתוב", media }),
    textPost("p-workout", { post_type: "POST_WORKOUT", body: "היה קשה", media, title: "Fran", metadata: { workout_name: "Fran", result_text: "4:21" } }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 3);

  // THE WHOLE POINT: the text card and the photo card used to disagree about
  // where the caption goes, and the workout card put its figures above both.
  for (const id of ["p-text", "p-photo", "p-workout"]) {
    const el = card(window, id);
    const nodes = Array.from(el.querySelectorAll("img.post-photo, .post-body, .post-result-block"));
    const kinds = nodes.map((n) => (n.tagName === "IMG" ? "media" : n.classList.contains("post-body") ? "text" : "result"));
    const firstMedia = kinds.indexOf("media"), firstText = kinds.indexOf("text"), firstResult = kinds.indexOf("result");
    assert.ok(firstMedia > -1 && firstText > -1, `${id} must carry both media and text`);
    assert.ok(firstMedia < firstText, `${id}: media must come before the text (got ${kinds.join(",")})`);
    if (firstResult > -1) assert.ok(firstText < firstResult, `${id}: the result block must come last (got ${kinds.join(",")})`);
  }
});

test("every type carries a small type label on the head, and a plain text post carries none", async () => {
  const mock = seeded([
    textPost("p-text"),
    textPost("p-pr", { post_type: "POST_PR", metadata: { movement: "Deadlift", new_result: "160" } }),
    textPost("p-ann", { post_type: "POST_ANNOUNCEMENT", author_id: null, author: null, metadata: { title: "הודעה" } }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 3);

  assert.equal(card(window, "p-text").querySelector(".post-type-tag"), null,
    "a plain post is not a KIND of anything - a tag reading פוסט on nine cards in ten is noise");
  assert.equal(card(window, "p-pr").querySelector(".post-type-tag").textContent.trim(), "שיא אישי");
  // opts.badge still wins where a renderer already had a better word.
  assert.equal(card(window, "p-ann").querySelector(".post-type-tag").textContent.trim(), "הודעת מועדון");
});

test("hide, save, report, edit and delete are only reachable through the three-dot menu", async () => {
  const mock = seeded([textPost("p-mine", { author_id: "u1", author: { display_name: "דנה", handle: "dana" } }), textPost("p-theirs")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);

  const DESTRUCTIVE = ["post-hide", "post-save", "report", "post-delete", "delete-post", "post-edit-caption", "post-change-visibility", "block"];
  for (const id of ["p-mine", "p-theirs"]) {
    const loose = Array.from(card(window, id).querySelectorAll("[data-community-action]"))
      .filter((el) => DESTRUCTIVE.includes(el.getAttribute("data-community-action")))
      .filter((el) => !el.closest(".post-menu"));
    assert.deepEqual(loose.map((el) => el.getAttribute("data-community-action")), [], `${id} leaves a destructive control loose on the card`);
  }

  // ...and the menu really does hold them, per whose post it is.
  card(window, "p-mine").querySelector('[data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!card(window, "p-mine").querySelector(".post-menu"), 3000);
  const mine = Array.from(card(window, "p-mine").querySelectorAll(".post-menu [data-community-action]")).map((el) => el.getAttribute("data-community-action"));
  assert.ok(mine.includes("post-delete") && mine.includes("post-edit-caption"), mine.join(","));
  assert.ok(!mine.includes("report"), "the author is not offered a report of their own post");

  card(window, "p-theirs").querySelector('[data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!card(window, "p-theirs").querySelector(".post-menu"), 3000);
  const theirs = Array.from(card(window, "p-theirs").querySelectorAll(".post-menu [data-community-action]")).map((el) => el.getAttribute("data-community-action"));
  assert.ok(theirs.includes("report") && theirs.includes("post-hide") && theirs.includes("post-save"), theirs.join(","));
  assert.ok(!theirs.includes("post-delete"), "only the author is offered delete");
});

// ===== 2. Reactions =======================================================

test("the reaction pill carries the dumbbell, the count and a pressed state, and one reaction per member still holds", async () => {
  const mock = seeded([textPost("p1", { reaction_count: 2 })], {
    reactions: [
      { post_id: "p1", user_id: "u2", kind: "cheer", created_at: at(2) },
      { post_id: "p1", user_id: "u3", kind: "cheer", created_at: at(1) },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!card(window, "p1").querySelector(".reaction-summary"), 4000);

  const pill = card(window, "p1").querySelector(".reaction-pill");
  assert.ok(pill.querySelector("svg.reaction-icon"), "the pill draws the dumbbell, not an emoji");
  assert.equal(pill.querySelector(".reaction-count").textContent.trim(), "2");
  assert.equal(pill.getAttribute("aria-pressed"), "false", "the viewer has not reacted yet");

  pill.click();
  await waitFor(() => mock.db.reactions.filter((r) => r.user_id === "u1" && r.post_id === "p1").length === 1, 4000);
  await waitFor(() => card(window, "p1").querySelector(".reaction-pill").getAttribute("aria-pressed") === "true", 4000);
  assert.equal(card(window, "p1").querySelector(".reaction-count").textContent.trim(), "3");

  // ONE REACTION PER MEMBER: tapping again removes it, it never adds a second.
  //
  // The wait is react()'s own in-flight guard (reactionBusy, comments.js) and
  // not a timing fudge: the pressed state above is OPTIMISTIC and paints
  // before toggle_reaction has answered, so a second tap landing in that
  // window is exactly the fast double-tap the guard exists to swallow. The
  // reactor list being re-read is what says the first toggle has fully
  // landed.
  await waitFor(() => { const r = mock.callsTo("toggle_reaction"); return r.length === 1; }, 4000);
  await new Promise((r) => setTimeout(r, 30));
  card(window, "p1").querySelector(".reaction-pill").click();
  await waitFor(() => mock.db.reactions.filter((r) => r.user_id === "u1" && r.post_id === "p1").length === 0, 4000);
  assert.equal(mock.db.reactions.filter((r) => r.post_id === "p1").length, 2, "the other two members' reactions are untouched");
});

test('the summary reads "<name> ועוד N" and tapping it lists who reacted', async () => {
  const mock = seeded([textPost("p1", { reaction_count: 3 })], {
    // `profiles` is seeded onto the row itself because the mock's select()
    // is a no-op - an embed is whatever the fixture already carries, the
    // same convention every post_comments fixture in this suite uses.
    reactions: [
      { post_id: "p1", user_id: "u2", kind: "cheer", created_at: at(3), profiles: { handle: "noam", display_name: "נועם", avatar_url: null } },
      { post_id: "p1", user_id: "u3", kind: "cheer", created_at: at(2), profiles: { handle: "yael", display_name: "יעל", avatar_url: null } },
      { post_id: "p1", user_id: "u1", kind: "cheer", created_at: at(1), profiles: { handle: "dana", display_name: "דנה", avatar_url: null } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!card(window, "p1").querySelector(".reaction-summary"), 4000);

  const summary = card(window, "p1").querySelector(".reaction-summary");
  // The viewer reacted, so they are named first - "אתם ועוד 2".
  assert.match(summary.textContent.trim(), /ועוד\s*2$/);
  assert.equal(summary.getAttribute("aria-haspopup"), "dialog");

  summary.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reactors"]'), 4000);
  const sheet = window.document.querySelector('[data-cloud-dialog="reactors"]');
  const listed = Array.from(sheet.querySelectorAll("[data-reactor-user]")).map((el) => el.getAttribute("data-reactor-user")).sort();
  assert.deepEqual(listed, ["u1", "u2", "u3"]);
  assert.match(sheet.textContent, /נועם/);
  // It is a real dialog in the shared registry, not a bespoke overlay.
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(sheet.getAttribute("aria-modal"), "true");
  assert.ok(sheet.querySelector("h2#reactorsTitle"), "its title is a heading, like every other dialog's");
});

// ===== 3. Comments ========================================================

test("the two latest comments render under the card with a time and a reply link, and every card carries an inline comment box", async () => {
  const mock = seeded([textPost("p1", { comment_count: 3 }), textPost("p2")], {
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u2", body: "ראשונה", parent_comment_id: null, created_at: at(9), status: "active" },
      { id: "c2", post_id: "p1", author_id: "u3", body: "שנייה", parent_comment_id: null, created_at: at(6), status: "active" },
      { id: "c3", post_id: "p1", author_id: "u2", body: "שלישית", parent_comment_id: null, created_at: at(3), status: "active" },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  await waitFor(() => card(window, "p1").querySelectorAll(".comment-preview .comment-row").length === 2, 4000);

  const rows = Array.from(card(window, "p1").querySelectorAll(".comment-preview .comment-row"));
  // The two LATEST, newest last, so the card reads in the same order an open
  // thread does.
  assert.deepEqual(rows.map((r) => r.textContent.replace(/\s+/g, " ").trim()).map((t) => /שנייה/.test(t) ? "c2" : /שלישית/.test(t) ? "c3" : "?"), ["c2", "c3"]);
  for (const r of rows) {
    assert.ok(r.querySelector('[data-community-action="comment-reply"]'), "each previewed comment offers a reply");
    assert.match(r.textContent, /לפני|עכשיו/, "each previewed comment carries its time");
  }
  assert.ok(card(window, "p1").querySelector('[data-community-action="toggle-comments"].comment-more, .comment-more'), "the third is reachable");
  // On EVERY card, including one with no comments at all.
  for (const id of ["p1", "p2"]) {
    assert.ok(card(window, id).querySelector('[data-comment-thread="preview"] [data-comment-input]'), `${id} has no inline comment box`);
  }
});

test("replying from the preview uses the existing two-level thread and never opens a third level", async () => {
  const mock = seeded([textPost("p1", { comment_count: 1 })], {
    post_comments: [{ id: "c1", post_id: "p1", author_id: "u2", body: "שורש", parent_comment_id: null, created_at: at(4), status: "active" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!card(window, "p1").querySelector('[data-community-action="comment-reply"]'), 4000);

  card(window, "p1").querySelector('[data-community-action="comment-reply"]').click();
  await waitFor(() => !!window.document.querySelector('form[data-comment-parent-id="c1"]'), 3000);
  const form = window.document.querySelector('form[data-comment-parent-id="c1"]');
  form.elements.body.value = "מסכימה";
  form.elements.body.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => mock.db.post_comments.some((c) => c.parent_comment_id === "c1" && c.author_id === "u1"), 4000);
  const calls = mock.callsTo("add_post_comment");
  assert.equal(calls[calls.length - 1].p_parent_comment_id, "c1", "the reply rides the existing parent path, not a new one");
});

// ===== 4. The classmates strip ============================================

test("the classmates strip sits above the feed list, keeps its Follow control, and stays silent on no signal", async () => {
  const mock = seeded([textPost("p1")], {
    attendance_log: [
      { user_id: "u1", occurred_on: TODAY, recorded_at: at(1) },
      { user_id: "u2", occurred_on: TODAY, recorded_at: at(2) },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!window.document.querySelector('[data-classmates-today="ready"]'), 4000);

  const strip = window.document.querySelector('[data-classmates-today="ready"]');
  assert.ok(strip.classList.contains("classmates-strip"), "it is the strip, not the old stacked card");
  assert.match(strip.textContent, /נועם/);
  assert.ok(!/דנה/.test(strip.textContent), "the caller is never their own classmate");
  assert.match(strip.textContent, /@noam/, "the handle stays in the accessible name");
  assert.ok(strip.querySelector('[data-community-action="follow"][data-id="u2"]'), "the card's Follow control survives the move to a strip");
  // ABOVE the feed list, in document order.
  const list = window.document.getElementById("communityFeedList");
  assert.equal(strip.compareDocumentPosition(list) & window.Node.DOCUMENT_POSITION_FOLLOWING, window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test("no attendance signal renders no strip at all - not an empty one", async () => {
  const mock = seeded([textPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => mock.callsTo("attendance_classmates_today").length >= 1, 4000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(window.document.querySelector('[data-classmates-today="ready"]'), null);
  assert.equal(window.document.querySelector(".classmates-strip"), null);
});

// ===== 5 + 6. The club WOD roll-up ========================================

const SESSION_ID = "s-1";
const WOD_ID = "w-1";
const boardRow = (overrides) => Object.assign({
  session_id: SESSION_ID, session_date: TODAY, note: "", post_id: "p-wod",
  published_at: at(20), published_by: { id: "u3", display_name: "יעל", handle: "yael", avatar_url: null },
  cancelled_at: null,
  wod: { id: WOD_ID, name: "Fran", desc: "21-15-9", scoreType: "for_time" },
  result_count: 3,
  results: [
    { user_id: "u2", display_name: "נועם", handle: "noam", avatar_url: null, is_viewer: false, result_text: "4:21", result_hidden: false, score_type: "for_time", rx: true, occurred_on: TODAY, attached_at: at(9) },
    { user_id: "u1", display_name: "דנה", handle: "dana", avatar_url: null, is_viewer: true, result_text: "5:02", result_hidden: false, score_type: "for_time", rx: false, occurred_on: TODAY, attached_at: at(6) },
    { user_id: "u3", display_name: "יעל", handle: "yael", avatar_url: null, is_viewer: false, result_text: null, result_hidden: true, score_type: "for_time", rx: true, occurred_on: TODAY, attached_at: at(3) },
  ],
  viewer: { attached: true, result_text: "5:02", score_type: "for_time", rx: false, occurred_on: TODAY, attached_at: at(6), can_attach: true, can_detach: true, closed_reason: null },
}, overrides || {});

const sessionPost = () => textPost("p-wod", {
  post_type: "POST_CLUB_WOD", author_id: "u3", author: { display_name: "יעל", handle: "yael" },
  title: "Fran", body: "", occurred_on: TODAY,
  metadata: { club_wod_session_id: SESSION_ID, club_wod_id: WOD_ID, session_date: TODAY, score_type: "for_time" },
});
// One member's own shared result for that same WOD on that same day. The
// comparison_key is exactly what app.js writes: `wod:<wodId>:<type>:<rx>`.
const resultPost = (id, author) => textPost(id, {
  post_type: "POST_WORKOUT", author_id: author, author: { display_name: author === "u2" ? "נועם" : "יעל", handle: author },
  title: "Fran", occurred_on: TODAY, comparison_key: `wod:${WOD_ID}:for_time:rx`,
  metadata: { workout_name: "Fran", workout_date: TODAY, result_text: "4:21" },
});

test("a club WOD session is one card: the individual result posts for that session are folded into it", async () => {
  const mock = seeded([sessionPost(), resultPost("p-res-1", "u2"), resultPost("p-res-2", "u3"), textPost("p-other")],
    { club_wod_board_rows: [boardRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  await waitFor(() => !!card(window, "p-wod").querySelector(".club-wod-rollup"), 4000);

  assert.deepEqual(renderedIds(window), ["p-wod", "p-other"],
    "the two result posts for this session are carried by the session card, not drawn again beside it");
});

test("a result post whose day does NOT match the session stays a card of its own", async () => {
  const other = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const mock = seeded([sessionPost(), resultPost("p-res-old", "u2")], { club_wod_board_rows: [boardRow()] });
  mock.db.feed_page_rows[1].occurred_on = other;
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  assert.deepEqual(renderedIds(window), ["p-wod", "p-res-old"],
    "the same member repeating the same WOD three weeks later must not be swallowed by an unrelated session");
});

test("the session card shows the count, stacked faces, three results and a link to the full board", async () => {
  const mock = seeded([sessionPost()], { club_wod_board_rows: [boardRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!card(window, "p-wod").querySelector(".club-wod-rollup"), 4000);

  const rollup = card(window, "p-wod").querySelector(".club-wod-rollup");
  assert.match(rollup.textContent, /3 מהמועדון צירפו תוצאה/);
  assert.equal(rollup.querySelectorAll(".stacked-avatars .stacked-avatar").length, 3, "one face per listed member");
  // :scope, because #communityFeedList is itself a .log-list - a descendant
  // selector rooted at the roll-up still matches through it and would count
  // the viewer line (a sibling of this list, not a row in it) as a fourth.
  assert.equal(rollup.querySelector(".log-list").querySelectorAll(":scope > .log-row").length, 3, "three results shown");
  // Honesty, not decoration: the three are the board's own order (who
  // attached first), and the card says so rather than calling them a ranking
  // the server returns no column to build.
  assert.match(rollup.textContent, /הראשונים שצירפו/);
  // A member whose figure is not this viewer's to read says so.
  assert.match(rollup.textContent, /התוצאה מוסתרת/);
  assert.ok(card(window, "p-wod").querySelector('[data-community-action="open-club-wod-board"][data-id="s-1"]'), "a link to the full board");
});

test("once the viewer has logged one, the card shows their own result and their place on the board", async () => {
  const mock = seeded([sessionPost()], { club_wod_board_rows: [boardRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!card(window, "p-wod").querySelector(".club-wod-viewer-line"), 4000);

  const line = card(window, "p-wod").querySelector(".club-wod-viewer-line");
  assert.match(line.textContent, /התוצאה שלך/);
  assert.match(line.textContent, /5:02/);
  // SECOND of three, in the board's own attached_at order - which is what the
  // line says, in as many words. club_wod_board_json returns no score column,
  // and most figures are hidden by default, so a score-ranked place is not
  // computable from what the server sends; saying "place 2" of a ranking that
  // does not exist would be the dishonest version of this line.
  assert.match(line.textContent, /צירפת במקום 2 מתוך 3/);
});

test("a viewer who has not attached gets no own-result line at all", async () => {
  const board = boardRow({
    results: boardRow().results.filter((r) => !r.is_viewer),
    result_count: 2,
    viewer: { attached: false, result_text: null, score_type: null, rx: null, occurred_on: null, attached_at: null, can_attach: true, can_detach: false, closed_reason: null },
  });
  const mock = seeded([sessionPost()], { club_wod_board_rows: [board] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!card(window, "p-wod").querySelector(".club-wod-rollup"), 4000);
  assert.equal(card(window, "p-wod").querySelector(".club-wod-viewer-line"), null);
});

// ===== 7. The composer row ================================================

test('the composer row reads "מה עשית היום?" and its photo button opens the one existing composer', async () => {
  const mock = seeded([textPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const row = window.document.querySelector(".post-composer-row");
  assert.ok(row, "the feed opens with a composer row");
  assert.match(row.querySelector(".post-composer-trigger").textContent, /מה עשית היום\?/);

  const photo = row.querySelector('[data-community-action="open-composer-photo"]');
  assert.ok(photo, "and a photo button beside it");
  photo.click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="composer"]'), 4000);
  // THE SAME composer, with the module's one file input - not a second
  // upload path that would have to re-do EXIF stripping and alt text.
  assert.ok(window.document.querySelector('[data-cloud-dialog="composer"] [data-composer-file]'));
});

// ===== 8. New posts, pull to refresh, skeletons ===========================

test("a post arriving over realtime becomes a pill and does not touch the list until the member asks", async () => {
  const mock = seeded([textPost("p1"), textPost("p2")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  const before = renderedIds(window);

  mock.db.feed_page_rows.unshift(textPost("p-new", { created_at: at(0), published_at: at(0) }));
  assert.equal(mock.emitRealtime("feed-posts", { eventType: "INSERT", new: { id: "p-new", author_id: "u3" } }), 1,
    "the feed-posts channel is subscribed while the feed tab is on screen");

  await waitFor(() => !!window.document.querySelector(".new-posts-pill"), 4000);
  assert.match(window.document.querySelector(".new-posts-pill").textContent, /פוסט חדש/);
  assert.deepEqual(renderedIds(window), before, "the list the member is reading did not change under them");

  window.document.querySelector(".new-posts-pill").click();
  await waitFor(() => renderedIds(window)[0] === "p-new", 4000);
  assert.equal(window.document.querySelector(".new-posts-pill"), null, "the pill goes once it has been taken");
});

test("a member's own post never becomes a pill - their own publish already refreshed the feed", async () => {
  const mock = seeded([textPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  mock.emitRealtime("feed-posts", { eventType: "INSERT", new: { id: "p-mine", author_id: "u1" } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(window.document.querySelector(".new-posts-pill"), null);
});

test("the loading feed draws skeleton cards shaped like the card they stand in for", async () => {
  const mock = seeded([textPost("p1")]);
  let release;
  const held = new Promise((r) => { release = r; });
  mock.onRpc("feed_page", async () => { await held; return { data: [textPost("p1")], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[aria-busy="true"] .post-card'), 4000);

  const skeletons = window.document.querySelectorAll('[aria-busy="true"] .post-card');
  assert.equal(skeletons.length, 3);
  const first = skeletons[0];
  assert.equal(first.getAttribute("aria-hidden"), "true", "a placeholder is not content a screen reader should read");
  assert.ok(first.querySelector(".post-head .skeleton-block"), "an avatar and a name");
  assert.ok(first.querySelectorAll(".skeleton-block").length >= 5, "a media block and text lines, not one grey bar");
  release();
});

test("pull to refresh is wired, and its indicator is a zero-height strip the render never resizes", async () => {
  const mock = seeded([textPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  const el = window.document.getElementById("communityPullRefresh");
  assert.ok(el, "the feed carries the pull indicator");
  assert.equal(el.getAttribute("data-ready"), "0");
  assert.equal(el.getAttribute("aria-hidden"), "true");
  // The gesture itself is touch-only and gated on (pointer: coarse), so it
  // cannot be driven here - what a real finger does to it is measured in
  // Chromium. What this pins is that the indicator is in the document and
  // that no render writes a height onto it.
  assert.equal(el.getAttribute("style"), null);
});

// ===== 9. The empty feed ==================================================

test("an empty feed welcomes a new member and names the club's most active", async () => {
  const mock = seeded([], {
    community_streaks: [
      { user_id: "u2", handle: "noam", display_name: "נועם", current_streak: 12, last_activity_on: TODAY },
      { user_id: "u3", handle: "yael", display_name: "יעל", current_streak: 1, last_activity_on: TODAY },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-feed-welcome="ready"]'), 4000);

  const welcome = window.document.querySelector('[data-feed-welcome="ready"]');
  assert.match(welcome.textContent, /ברוכים הבאים לקהילת המועדון/);
  // The card quotes the composer prompt, so the instruction and the button
  // cannot drift apart.
  assert.match(welcome.textContent, /מה עשית היום\?/);
  assert.ok(welcome.querySelector('[data-community-action="open-composer"]'));

  await waitFor(() => !!window.document.querySelector('[data-feed-active-members="ready"]'), 4000);
  const active = window.document.querySelector('[data-feed-active-members="ready"]');
  assert.match(active.textContent, /נועם/);
  // The FIGURE is the point of the row, so it is printed at every value -
  // including one, which used to render the bare words with no number at all
  // - and the noun and adjective agree with it (יום/ימים, רצוף/רצופים).
  assert.match(active.textContent, /12 ימים רצופים/);
  assert.match(active.textContent, /1 יום רצוף/, "one day is singular AND still carries its number");
  // Only the digits are .mono (direction:ltr): the whole phrase used to be,
  // which laid a mixed number-and-Hebrew string out as an LTR paragraph
  // inside an RTL row. See streakDaysHtml() in cloud.js.
  const streak = active.querySelector(".streak-count");
  assert.ok(streak, "the streak is its own element, not an inline-styled span");
  assert.equal(streak.querySelector(".mono").textContent.trim(), "12", "the mono run is the number alone");
});

test("with no streaks at all the welcome stands alone rather than heading an empty list", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-feed-welcome="ready"]'), 4000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(window.document.querySelector('[data-feed-active-members="ready"]'), null);
});
