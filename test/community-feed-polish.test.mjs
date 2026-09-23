// The feed polish pass, reported from real 390px phone screenshots: the ⋯
// menu that opened off the left edge of the screen, the role badge and the
// author name that wrapped under a heavy underline, the orange שליחה button
// sitting under every card, three emoji among the feed's own line-drawn
// icons, the coach's empty-day card shown to members, and a streak that
// printed its words without its number.
//
// WHAT THIS FILE VERIFIES AND WHAT IT CANNOT. Everything here is DOM and
// source: which elements exist, what they carry, what a keystroke does to
// them. jsdom has no layout, so not one assertion below is about geometry -
// "the menu is inside the viewport", "the badge is on one line", "the send
// icon is inside the field", "the number reads first in RTL" are measured in
// real Chromium at 390x844 by scripts/browser-check/community-feed-polish.mjs
// and are not, and must not be, inferred from anything in this file.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { communityFile } from "./helpers/community-src.mjs";

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const postsJs = communityFile("src/community/posts.js");
const commentsJs = communityFile("src/community/comments.js");
const notificationsJs = communityFile("src/community/notifications.js");

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const at = (min) => new Date(Date.now() - min * 60000).toISOString();

const LONG_NAME = "יונתן בן-אברהם הכהן מזרחי";
const PROFILES = [
  { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  { id: "u2", handle: "yonatan", display_name: LONG_NAME, is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
];

function seeded(feedRows, extra, asUser) {
  const mock = createMockSupabase(Object.assign({
    profiles: PROFILES,
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "head_coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    feed_page_rows: feedRows,
    reactions: [], post_comments: [], follows: [], blocks: [],
    hidden_posts: [], saved_posts: [], attendance_log: [],
    feed_impressions: [], feed_interactions: [], analytics_events: [],
    club_wod_board_rows: [], community_streaks: [], club_wods: [],
  }, extra || {}));
  const who = asUser || "u1";
  mock.setUser({ id: who, is_anonymous: false, email: `${who}@members.haimuniya.invalid` });
  return mock;
}

function coachPost(id, overrides) {
  return Object.assign({
    id, post_type: "POST_TEXT", author_id: "u2",
    author: { display_name: LONG_NAME, handle: "yonatan" },
    body: "מי בא לאימון של הערב?", visibility: "club",
    created_at: at(3), published_at: at(3),
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  }, overrides || {});
}

const openFeed = async (window, atLeast = 1) => {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= atLeast, 5000);
};
const card = (window, id) => window.document.querySelector(`[data-post-id="${id}"]`);

// ===== 1. The ⋯ menu ======================================================

test("the ⋯ menu is anchored on the side the room is on, and says what it is", async () => {
  const mock = seeded([coachPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const btn = card(window, "p1").querySelector('[data-community-action="toggle-post-menu"]');
  assert.equal(btn.getAttribute("aria-haspopup"), "menu", "not the legacy 'true' alias - this really is a menu");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(btn.getAttribute("aria-controls"), "postMenu-p1", "the button names the panel it owns");

  btn.click();
  await waitFor(() => !!card(window, "p1").querySelector(".post-menu"), 3000);
  const menu = card(window, "p1").querySelector(".post-menu");
  assert.equal(menu.id, "postMenu-p1");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(menu.getAttribute("aria-labelledby"), "postMenuBtn-p1", "announced by the button's own name");
  assert.equal(card(window, "p1").querySelector('[data-community-action="toggle-post-menu"]').getAttribute("aria-expanded"), "true");
  const items = [...menu.querySelectorAll(".post-menu-item")];
  assert.ok(items.length >= 3, "a non-own post offers save, hide, report and block");
  assert.ok(items.every((i) => i.getAttribute("role") === "menuitem"));
});

// The anchoring itself is a CSS fact and the only place it can be stated, so
// it is pinned here as source and MEASURED in Chromium. `inset-inline-start`
// is what put the panel off the screen in RTL: the button is at the card's
// inline-end, so the panel has to hang from its inline-END edge to grow back
// into the card.
test("the menu's CSS anchors it on the inline-end and caps it against the viewport", () => {
  const rule = indexHtml.match(/\n {2}\.post-menu\{[^}]*\}/);
  assert.ok(rule, ".post-menu still has one rule");
  assert.match(rule[0], /inset-inline-end:0/, "anchored on the button's inline-end, not its inline-start");
  assert.doesNotMatch(rule[0], /inset-inline-start:0/, "the old anchor is gone, not merely overridden");
  assert.match(rule[0], /max-width:min\(/, "capped against the viewport as well as the card");
  const item = indexHtml.match(/\n {2}\.post-menu-item\{[^}]*\}/);
  assert.match(item[0], /min-height:44px/, "44px is this app's tap-target floor and these are destructive actions");
});

test("the menu answers the keyboard: focus on open, arrows, Escape back to the button", async () => {
  const mock = seeded([coachPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  card(window, "p1").querySelector('[data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!card(window, "p1").querySelector(".post-menu"), 3000);
  const firstItem = card(window, "p1").querySelector(".post-menu-item");
  assert.equal(window.document.activeElement, firstItem, "opening a role=menu moves focus into it");

  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  const items = [...card(window, "p1").querySelectorAll(".post-menu-item")];
  assert.equal(window.document.activeElement, items[1], "ArrowDown walks the items");
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  assert.equal(window.document.activeElement, items[0]);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(window.document.activeElement, items[items.length - 1]);

  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !card(window, "p1").querySelector(".post-menu"), 3000);
  const btn = card(window, "p1").querySelector('[data-community-action="toggle-post-menu"]');
  assert.equal(window.document.activeElement, btn, "closing a popup puts focus back where it came from");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
});

// ===== 2 + 3. The name line ===============================================

test("the author name and the role badge are siblings on one row, and neither is underlined", async () => {
  const mock = seeded([coachPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  // memberRole() is filled by member_roles(), fetched after the first paint.
  await waitFor(() => !!card(window, "p1").querySelector(".badge-tag"), 4000);

  const row = card(window, "p1").querySelector(".post-author-row");
  assert.ok(row, "the head has a name ROW now, not a name with a badge inside it");
  const name = row.querySelector(".post-author");
  const badge = row.querySelector(".badge-tag");
  assert.ok(name && badge);
  assert.equal(badge.parentElement, row, "the badge is a sibling of the name, not a child of it");
  assert.equal(name.querySelector(".badge-tag"), null, "nothing left inside the name to wrap with it");

  // Still a profile link.
  assert.equal(name.tagName, "BUTTON");
  assert.equal(name.getAttribute("data-community-action"), "view-profile");
  assert.equal(name.getAttribute("data-id"), "u2");
  assert.equal(name.textContent.trim(), LONG_NAME, "the FULL name is in the DOM - the ellipsis is paint, not content");
  assert.equal(name.getAttribute("title"), LONG_NAME, "and a mouse can read the part the ellipsis eats");
  assert.equal(badge.textContent.trim(), "מאמן/ת ראשי/ת");
  // The inline style block that used to fight the class is gone: `font:inherit`
  // there was silently overriding .post-author's own font-size.
  assert.ok(!(name.getAttribute("style") || "").includes("font:inherit"));
});

test("the name's CSS drops .link-btn's underline and lets the ellipsis work", () => {
  const rule = indexHtml.match(/\n {2}\.post-author\.link-btn\{[^}]*\}/);
  assert.ok(rule, ".post-author.link-btn beats .link-btn on exactly the three properties it cannot live with");
  assert.match(rule[0], /text-decoration:none/);
  // .link-btn is display:inline-flex, which makes text-overflow a no-op.
  assert.match(rule[0], /display:block/);
  const base = indexHtml.match(/\n {2}\.post-author\{[^}]*\}/);
  assert.match(base[0], /text-overflow:ellipsis/);
  assert.match(base[0], /white-space:nowrap/);
  assert.match(base[0], /min-width:0/, "without this the flex item never shrinks and the ellipsis never fires");
  const badge = indexHtml.match(/\n {2}\.badge-tag\{[^}]*\}/);
  assert.match(badge[0], /white-space:nowrap/, "a LABEL does not break across two lines");
  assert.match(badge[0], /text-decoration:none/, "and does not pick up the underline of whatever it sits inside");
});

// ===== 4. The comment box =================================================

test("the comment box carries no orange button - the send icon appears with the first character", async () => {
  const mock = seeded([coachPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const form = card(window, "p1").querySelector(".comment-form");
  assert.ok(form, "every card still has its comment box");
  assert.equal(form.querySelector(".chip-btn.primary"), null, "the full-width orange שליחה under every card is gone");
  assert.equal(form.getAttribute("data-has-text"), "0");

  const send = form.querySelector(".comment-send");
  assert.ok(send, "the send control is in the DOM, hidden by CSS rather than rendered in and out");
  assert.equal(send.getAttribute("type"), "submit", "still the form's own submit: Enter in the field is unchanged");
  assert.ok(send.getAttribute("aria-label"), "it is an icon, so it needs its own name");
  assert.ok(send.querySelector("svg"), "a stroke icon, not a word and not an emoji");
  // No wrapper: the button is a direct child of the form, whose only in-flow
  // child is the input - so the form's box is the field's box and the icon
  // lands inside it without one more element per card. WHERE it lands is
  // geometry and is measured in Chromium.
  assert.equal(send.parentElement, form);
  assert.equal(form.querySelector("[data-comment-input]").parentElement, form);

  // Typing flips the attribute the CSS keys on - WITHOUT a rerender, which
  // would take the caret with it.
  const input = form.querySelector("[data-comment-input]");
  input.value = "יפה מאוד";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(form.getAttribute("data-has-text"), "1");
  assert.equal(card(window, "p1").querySelector(".comment-form"), form, "the form element itself survived - nothing re-rendered");

  input.value = "   ";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(form.getAttribute("data-has-text"), "0", "whitespace is not something to send");
  input.value = "";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(form.getAttribute("data-has-text"), "0");
});

test("the send icon is hidden until there is text, by CSS, so it is out of the tab order", () => {
  const rule = indexHtml.match(/\n {2}\.comment-send\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /display:none/, "display:none, not opacity - an invisible but focusable submit is worse than a visible one");
  assert.match(indexHtml, /\.comment-form\[data-has-text="1"\] \.comment-send\{ display:inline-flex; \}/);
});

test("a typed comment still posts - the icon is the same submit the chip was", async () => {
  const mock = seeded([coachPost("p1")]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const form = card(window, "p1").querySelector(".comment-form");
  const input = form.querySelector("[data-comment-input]");
  input.value = "כל הכבוד";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => mock.db.post_comments.some((c) => c.body === "כל הכבוד"), 4000);
  assert.equal(mock.db.post_comments.filter((c) => c.body === "כל הכבוד").length, 1);
});

// ===== 5. Stroke icons, not emoji =========================================

test("the feed's three emoji are gone, replaced by icons in the dumbbell's language", async () => {
  const mock = seeded([coachPost("p1", { comment_count: 2 })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const commentBtn = card(window, "p1").querySelector('[data-community-action="toggle-comments"]');
  const bell = window.document.querySelector('[data-community-action="feed-notifications"]');
  const camera = window.document.querySelector('[data-community-action="open-composer-photo"]');
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  for (const [name, el] of [["comment count", commentBtn], ["bell", bell], ["camera", camera]]) {
    assert.ok(el, `${name} is on screen`);
    const svg = el.querySelector("svg");
    assert.ok(svg, `${name} draws an svg`);
    assert.equal(svg.getAttribute("fill"), "none", `${name} is a STROKE icon`);
    assert.equal(svg.getAttribute("stroke"), "currentColor", `${name} takes its control's colour in both themes`);
    assert.equal(svg.getAttribute("aria-hidden"), "true", `${name}'s glyph is decoration - the control carries the name`);
    assert.ok(!EMOJI.test(el.textContent || ""), `${name} has no emoji left in it`);
    assert.ok(el.getAttribute("aria-label"), `${name} still has an accessible name`);
  }
  assert.match(commentBtn.getAttribute("aria-label"), /2/, "the count is in the name, which an emoji never put there");
  assert.equal(commentBtn.querySelector(".reaction-count").textContent.trim(), "2");

  // And no call site sneaks one back in.
  assert.doesNotMatch(postsJs, /💬/);
  assert.doesNotMatch(notificationsJs.split("function notifTypeDef")[0], /🔔/, "the BELL is redrawn; the notification centre's own type icons are a separate taxonomy and are deliberately untouched");
  assert.match(cloudJs, /FEED_ICONS\.camera/);
  assert.match(postsJs, /FEED_ICONS\.comment/);
  assert.match(commentsJs, /FEED_ICONS\.send/);
});

// ===== 6. The coach's empty day is the coach's ============================

test("a member is shown nothing on a day with no club WOD; a coach is shown the card, the instructions and the form", async () => {
  const features = [{ club_id: "club-1", module_key: "club_wod", enabled: true, config: {} }];
  const memberMock = seeded([], { club_features: features }, "u1");
  const member = await bootCommunity(memberMock, { syncEnabled: false });
  member.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!member.document.getElementById("communityFeedFilters"), 5000);
  await waitFor(() => memberMock.callsTo("club_wod_boards").length > 0, 5000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(member.document.querySelector('[data-empty-state="club-wod-today-none"]'), null, "no card");
  assert.doesNotMatch(member.document.body.textContent, /לא נקבע אימון למועדון היום/, "no headline");
  assert.doesNotMatch(member.document.body.textContent, /אימון מהקטלוג שנקבע ליום מסוים/, "and none of the coach instructions");
  assert.equal(member.document.getElementById("communityClubWodSession"), null, "and no publish form");

  const coachMock = seeded([], { club_features: features }, "u2");
  coachMock.onRpc("club_wods_list", () => ({
    data: [{ id: "customwod-1", name: "Dana's Chipper", category: "Club", scoreType: "time", desc: "21-15-9", emomMovements: [], emomTargetReps: [], emomMinutes: null, timeCapSeconds: 1200, publishedBy: "u2", publishedAt: VERIFIED, retiredAt: null }],
    error: null,
  }));
  const coach = await bootCommunity(coachMock, { syncEnabled: false });
  coach.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!coach.document.querySelector('[data-empty-state="club-wod-today-none"]'), 5000);
  assert.match(coach.document.body.textContent, /אימון מהקטלוג שנקבע ליום מסוים/, "the coach keeps the instructions");
  await waitFor(() => !!coach.document.getElementById("communityClubWodSession"), 5000);
});

// ===== 7. The streak figure ===============================================

test("the streak prints its number at every value, with the noun and adjective agreeing", async () => {
  const mock = seeded([], {
    community_streaks: [
      { user_id: "u2", handle: "yonatan", display_name: LONG_NAME, current_streak: 12, last_activity_on: TODAY },
      { user_id: "u1", handle: "dana", display_name: "דנה", current_streak: 1, last_activity_on: TODAY },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-feed-active-members="ready"]'), 5000);

  const rows = [...window.document.querySelectorAll('[data-feed-active-members="ready"] .streak-count')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].textContent.replace(/\s+/g, " ").trim(), "12 ימים רצופים");
  assert.equal(rows[1].textContent.replace(/\s+/g, " ").trim(), "1 יום רצוף", "one day still carries its digit");
  // Only the digits are .mono (direction:ltr; unicode-bidi:isolate). The whole
  // phrase used to be, which is what stranded the number beside its words.
  for (const r of rows) {
    const digits = r.querySelector(".mono");
    assert.ok(digits, "the number is the mono run");
    assert.match(digits.textContent.trim(), /^\d+$/, "and it is the ONLY thing in it");
    assert.equal(digits.tagName, "BDI", "isolated in its own right, not only by a class");
  }
  assert.doesNotMatch(cloudJs, /ימים ברצף/, "the old phrase is gone, not left beside the new one");
});
