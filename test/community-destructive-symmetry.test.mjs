// Five-persona UX audit, defect 2: NO CONFIRMATION NAMED ITS SUBJECT.
//
// "לחסום את המשתמש?" is a dialog opened FROM A POST about a specific human,
// and it did not say which one - the mechanism by which the wrong member gets
// blocked. The message carries a {subject} TOKEN, the name rides beside it as
// `subject`, and subjectSentenceHtml() joins the escaped sentence fragments
// around a bidiText()-isolated name: esc() runs over every part, nothing is
// bypassed, and every askConfirm call site is fixed at once.
//
// (Defect 1 of that audit - the coach grant/revoke and member-removal
// confirmations in the admin panel, and the moderation queue's decisions -
// went with the staff features; this file keeps the half that applies to the
// block confirmation and the shared mechanism.)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootHeldPosts, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const src = cloudSource();
const VERIFIED = new Date().toISOString();

// A member with a post held on the client. "Dana K" is the mixed-script case:
// a Latin display name inside an RTL Hebrew sentence, which is the whole
// reason the name is isolated rather than concatenated.
function mockWithPost(authorName) {
  const mock = createMockSupabase({
    profiles: [
      { id: "u1", handle: "yael_b", display_name: "יעל בר", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "mem-1", handle: "kobi", display_name: authorName, is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
      { user_id: "mem-1", invite_id: "i3", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    workout_posts: [{ id: "post-1", author_id: "mem-1", post_type: "POST_TEXT", body: "שלום", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
    feed_page_rows: [{ id: "post-1", author_id: "mem-1", post_type: "POST_TEXT", body: "שלום", created_at: VERIFIED, published_at: VERIFIED, author: { display_name: authorName, handle: "kobi" }, reaction_count: 0, comment_count: 0, media: [], metadata: {} }],
    notifications: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "yael@members.haimuniya.invalid" });
  return mock;
}

async function openBlockDialog(window, userId) {
  window.eval(`window.handleCommunityClick({ dataset: { communityAction: "block", id: ${JSON.stringify(userId)} } })`);
  await waitFor(() => !!dialog(window), 3000);
}

const dialog = (window) => window.document.querySelector('[data-cloud-dialog="confirmSheet"]');

// A source guard rather than one test per control: the point of defect 1 is
// that ONE control was missed, so what needs pinning is the rule, not the
// three call sites that happened to be found.
test("every person-scoped confirmation carries a named subject, and no person-scoped destructive action bypasses the dialog", () => {
  const calls = src.match(/askConfirm\(\{[^\n]*subject: subjectNameFor\([^\n]*\}\)/g) || [];
  assert.ok(calls.length >= 1, `expected the person-scoped confirmation to be found, got ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /\{subject\}/, `this confirmation does not name its subject: ${call.slice(0, 90)}`);
  }
  // The click handler may open a dialog for blocking; it may never call the
  // mutating function itself. runConfirm() is the only caller.
  const handler = src.slice(src.indexOf("window.handleCommunityClick = function (el) {"));
  assert.doesNotMatch(handler, /[^.]action === "block"\)\s*block\(/, "block() must not be reachable straight from a click");
});

// ===== DEFECT 2: the subject is named, and named SAFELY ==================

test("a Latin display name in an RTL sentence is bidi-isolated, not concatenated", async () => {
  const mock = mockWithPost("Dana K");
  const window = await bootHeldPosts(mock);
  await openBlockDialog(window, "mem-1");
  const bdi = Array.from(dialog(window).querySelectorAll("bdi")).find((b) => b.textContent === "Dana K");
  assert.ok(bdi, "the name is inside its own <bdi>, so it cannot be reordered against the Hebrew around it");
  assert.match(dialog(window).textContent, /לחסום את Dana K\?/);
});

test("the subject is escaped, not injected - esc() is still the only path to the DOM", async () => {
  const mock = mockWithPost('<img src=x onerror=alert(1)> & "פ"');
  const window = await bootHeldPosts(mock);
  await openBlockDialog(window, "mem-1");
  assert.equal(dialog(window).querySelector("img"), null, "no element is created from a display name");
  assert.match(dialog(window).textContent, /<img src=x onerror=alert\(1\)> & "פ"/, "it renders as the literal text it is");
});

test("an unresolvable subject degrades to one shared wording, never to a hole in the sentence", async () => {
  const mock = mockWithPost("קובי");
  const window = await bootHeldPosts(mock);
  // No post or profile row for this id exists on the client at all.
  await openBlockDialog(window, "nobody-here");
  assert.match(dialog(window).textContent, /לחסום את החבר\/ה\?/);
  assert.doesNotMatch(dialog(window).textContent, /לחסום את \?/, "never an empty subject slot");
});

test("blocking from a feed post names the author it was opened from", async () => {
  const mock = mockWithPost("קובי");
  const window = await bootHeldPosts(mock);
  await waitFor(() => window.document.body.textContent.includes("קובי"), 4000);
  await openBlockDialog(window, "mem-1");
  assert.match(dialog(window).textContent, /לחסום את קובי\?/);
});

// ===== the mechanism itself ==============================================

test("subjectSentenceHtml escapes both halves and isolates only the name, and no fourth dialog was added", () => {
  const fn = src.slice(src.indexOf("function subjectSentenceHtml("), src.indexOf("function askConfirm("));
  assert.match(fn, /parts\.map\(esc\)\.join\(bidiText\(name\)\)/,
    "the sentence fragments stay esc()'d and only the name is wrapped - never the other way round");
  assert.match(fn, /\|\| CONFIRM_SUBJECT_UNKNOWN/, "one shared fallback wording, not a per-call-site one");
  // The route: askConfirm was taught to carry the subject, so this fix adds
  // no dialog. renderGhostReclaimSheet stays the only dedicated one.
  //
  // The count moved 13 -> 14 for the outward-share sheet (five-persona UX
  // audit, outward sharing) and for nothing else. That sheet is not a
  // confirmation and could not have reused askConfirm: it renders a canvas
  // preview of the image about to leave the device, a switch that repaints
  // that image, and four different exits (share, copy, download, close).
  // askConfirm is a title + message + one confirm + one cancel, with no
  // place to put any of that. Assert the exact set rather than only the
  // count, so a NEW dialog still trips this even if one is removed in the
  // same change.
  //
  // "termSheet" is the fifteenth, added by design spec section 3 (jargon
  // disclosure). Treated as the review trigger this pin is meant to be:
  //
  //   WHY A DIALOG AND NOT A REUSE. The candidates were askConfirm and the
  //   report sheet. askConfirm is a title + message + confirm + cancel and
  //   its whole shape is "make a decision" - but a term sheet asks for NO
  //   decision, has no destructive counterpart, and must be dismissible by
  //   tapping outside without anything happening. Bending askConfirm to
  //   carry a term, a gloss, a body, an optional worked example and a
  //   second page (the full glossary) would have turned it into a general
  //   dialog framework, which is precisely what this pin exists to prevent.
  //
  //   WHY IT IS THIRD. Same stacking rule as confirmSheet and outwardShare
  //   above it, applied in the other direction: a `?` marker can be rendered
  //   inside the challenge, event, recap and profile overlays' own content,
  //   so the term sheet paints on top of those and must be matched before
  //   them. It stays BELOW confirmSheet and outwardShare because neither of
  //   those can contain a term marker, so nothing can stack on top of it.
  //
  //   WHY IT IS ONE ENTRY AND NOT TWO. The full glossary is a second PAGE of
  //   this same sheet (state.ui.termGlossaryOpen), not a second dialog, so
  //   both pages share one focus trap, one Escape binding and one backdrop
  //   click instead of duplicating all three.
  const dialogs = src.slice(src.indexOf("const CLOUD_DIALOGS = ["), src.indexOf("];", src.indexOf("const CLOUD_DIALOGS = [")));
  assert.deepEqual([...dialogs.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]), [
    "confirmSheet", "outwardShare", "termSheet",
    "notifCenter", "achUnlock", "prPrompt",
    // The short "לשתף עם המועדון?" sheet after an ordinary logged workout,
    // beside prPrompt: the two can never be open together, so their relative
    // order settles nothing.
    "workoutPrompt",
    // The "who reacted" list. LAST: it is only ever opened from a post card,
    // so nothing can be covered BY it, while the confirm and term sheets can
    // both cover it. (The composer, profile, challenge, event, recap, report,
    // moderation and club-WOD-board dialogs went with their features.)
    "reactors",
  ], "a dialog was added or removed - say why here and update the pin in community-state-namespaces.test.mjs too");
});
