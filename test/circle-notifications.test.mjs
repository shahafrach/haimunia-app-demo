// A tapped push (or a tapped row in the bell) opens the right circle and, for a
// reaction or a tag, scrolls to the right post. Every notification route names
// its circle: /circles?c=<circle>[&post=<post>][&week=1].
//
// The server rules that decide whether a notification exists at all (opted in,
// still in the circle, not blocked, once per post per hour) are pgTAP
// (supabase/tests/0026, 0027, 0142); the switches in Me are
// community-notifications.test.mjs; subscribing is community-web-push.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { createCirclesMock, bootCircle, membership, ME, FRIEND, CIRCLE_A, CIRCLE_B, waitFor, tick } from "./helpers/circles.mjs";

function feedRow(post_id, over = {}) {
  return Object.assign({
    post_id, author_id: FRIEND, author_name: "דנה", author_emoji: "🦁", post_type: "POST_WORKOUT",
    title: "סקוואט", result_text: "סקוואט 5 × 3", body: null, metadata: {}, occurred_on: "2026-10-26",
    published_at: "2026-10-26T10:00:00Z", reaction_counts: {}, my_reactions: [], unreacted_pr: false,
  }, over);
}

// Two circles; each answers circle_feed with its own posts.
function twoCircles() {
  const feeds = { [CIRCLE_A]: [feedRow("p-a")], [CIRCLE_B]: [feedRow("p-b1", { published_at: "2026-10-26T11:00:00Z" }), feedRow("p-b2")] };
  const mock = createCirclesMock({
    circles: [membership(), membership({ id: CIRCLE_B, name: "הצוות", emoji: "⚡" }, { joined_at: "2026-10-02T00:00:00Z" })],
    rpc: { circle_feed: (a) => ({ data: feeds[a.p_club_id] || [], error: null }) },
  });
  return mock;
}
const activeCircle = (w) => w.document.querySelector('[data-community-action="c-pick"][aria-pressed="true"]').dataset.id;

test("a tapped push opens the circle it is about, on the post it is about", async () => {
  const mock = twoCircles();
  const window = await bootCircle(mock);
  await waitFor(() => !!window.document.querySelector('[data-post-id="p-a"]'), 4000);
  assert.equal(activeCircle(window), CIRCLE_A);

  window.communityHandlePushDeepLink(`/circles?c=${CIRCLE_B}&post=p-b2`);
  await waitFor(() => activeCircle(window) === CIRCLE_B, 4000);
  await waitFor(() => !!window.document.querySelector('[data-post-id="p-b2"]'), 4000);
  assert.ok(mock.callsTo("circle_feed").some((c) => c.p_club_id === CIRCLE_B), "circle B's feed was read");
  assert.ok(!window.document.querySelector('[data-post-id="p-a"]'), "and circle A's post is no longer on screen");
});

test("a week-card push opens that circle on its week", async () => {
  const mock = twoCircles();
  const window = await bootCircle(mock);

  window.communityHandlePushDeepLink(`/circles?c=${CIRCLE_B}&week=1`);
  await waitFor(() => activeCircle(window) === CIRCLE_B, 4000);
  await waitFor(() => mock.callsTo("circle_week").some((c) => c.p_club_id === CIRCLE_B), 4000);
  assert.equal(window.document.getElementById("circleTab-week").getAttribute("aria-selected"), "true", "the week tab is the one selected");
});

test("a link with a circle and no post opens the circle's feed", async () => {
  const mock = twoCircles();
  const window = await bootCircle(mock);
  window.communityHandlePushDeepLink(`/circles?c=${CIRCLE_B}`);
  await waitFor(() => activeCircle(window) === CIRCLE_B, 4000);
  assert.equal(window.document.getElementById("circleTab-feed").getAttribute("aria-selected"), "true");
});

test("a push about a circle the member is no longer in says so and opens nothing else", async () => {
  const mock = twoCircles();
  const window = await bootCircle(mock);
  const left = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  window.communityHandlePushDeepLink(`/circles?c=${left}&post=p-gone`);
  await waitFor(() => /המעגל הזה כבר לא זמין לך/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(activeCircle(window), CIRCLE_A, "the member stays where they were");
  assert.ok(!mock.callsTo("circle_feed").some((c) => c.p_club_id === left), "and nothing about that circle is read");
});

test("a post that is not in the loaded page says so rather than doing nothing", async () => {
  const mock = twoCircles();
  const window = await bootCircle(mock);
  window.communityHandlePushDeepLink(`/circles?c=${CIRCLE_B}&post=p-missing`);
  await waitFor(() => /התוכן הזה לא נטען כרגע/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(activeCircle(window), CIRCLE_B, "still in the right circle");
});

test("a push link is used only when the member is signed in", async () => {
  const mock = createCirclesMock({ signedIn: false });
  const window = await bootCircle(mock).catch(() => null);
  if (window) {
    window.communityHandlePushDeepLink(`/circles?c=${CIRCLE_A}&post=p-a`);
    await tick(50);
    assert.equal(mock.callsTo("circle_feed").length, 0, "no circle is read for nobody");
  }
});

test("the stored deep link can only be an in-app route: the column's CHECK, and the client's parser, ignore anything else", async () => {
  const migration = (await import("node:fs")).readFileSync(new URL("../supabase/migrations/202608280008_notifications.sql", import.meta.url), "utf8");
  assert.match(migration, /deep_link ~ '\^\/\[A-Za-z0-9_\/\?=&\.%-\]\{0,300\}\$'/, "a leading slash and a closed alphabet");
  const mock = twoCircles();
  const window = await bootCircle(mock);
  const t = window.notifResolveTarget({ deep_link: "https://evil.example/circles?c=" + CIRCLE_B });
  assert.equal(t.circle, CIRCLE_B, "the parser reads the query only; it never navigates to a URL");
  assert.ok(ME);
});
