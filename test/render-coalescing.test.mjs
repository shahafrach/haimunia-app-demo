// The feed rerender storm, and the two other per-item loaders beside it.
//
// WHAT THIS FILE IS DEFENDING. rerender() rebuilds the whole tab with one
// innerHTML write. That is deliberate (COMM-366 spiked scoped rendering,
// measured the full rebuild at ~4.9 ms, and kept it on purpose), and it is
// fine ONCE. The problem was never the cost of one rebuild; it was three
// loaders that are PER ITEM calling it once per response:
//
//   ensureReactionsLoaded() -> one loadReactionsFor() per rendered post card
//   resolveAvatarUrl()      -> one signed-URL request per distinct avatar
//   resolvePhotoUrl()       -> one per distinct post photo
//
// Measured with scripts/browser-check/feed-rerender-storm.mjs before the fix:
// ONE scroll to the bottom of a 30-post feed cost 11 full rebuilds, 8 of them
// from loadReactionsFor alone. Each of those 8 destroyed and rebuilt the DOM
// the previous one had just built, and each is a point where focus, caret and
// scroll position have to be restored by hand. After: 4 rebuilds, and the 8
// became a single coalesced flush.
//
// The assertions below are about the RULE, not the number, because the number
// depends on how many posts a fixture happens to have: N responses landing
// together must produce ONE rebuild, and a member's own tap must still
// rerender synchronously - deferring that by a frame is a visible lag on the
// one path where responsiveness is the entire point.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, holdPosts, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const BASE = Date.now() - 5 * 60000;

function row(i) {
  return {
    id: `p${i}`,
    post_type: "POST_TEXT",
    author_id: `u${(i % 3) + 2}`,
    author: { display_name: `חבר ${i}`, handle: `m${i}` },
    body: `פוסט מספר ${i}`,
    visibility: "club",
    created_at: new Date(BASE - i * 60000).toISOString(),
    published_at: new Date(BASE - i * 60000).toISOString(),
    reaction_count: 2,
    comment_count: 0,
    media: [],
    metadata: {},
  };
}

function seeded(rows) {
  const mock = createMockSupabase({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u3", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u4", handle: "omer", display_name: "עומר", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    feed_page_rows: rows,
    feed_impressions: [], feed_interactions: [], follows: [], hidden_posts: [], saved_posts: [],
    reactions: [], post_comments: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// Counts full window.render() calls over a window of time. The instrument is
// the same one the browser-check script uses: wrap render, count, restore.
function countRenders(window) {
  const real = window.render;
  let n = 0;
  window.render = function () { n += 1; return real.apply(this, arguments); };
  return { get count() { return n; }, stop() { window.render = real; } };
}

async function openFeed(window, atLeast, mock) {
  mock.onRpc("circle_feed", () => ({ data: null, error: { message: "offline" } }));
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 5000);
  holdPosts(window, mock.db.feed_page_rows);
  await waitFor(() => window.document.querySelectorAll("#communityHeldPosts .post-card").length >= atLeast, 5000);
}

test("many reaction loads landing together produce ONE rebuild, not one per post", async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });

  // Instrumented BEFORE the tab is opened, so the count covers the whole
  // first paint of the feed - which is exactly when ensureReactionsLoaded()
  // fires one loadReactionsFor() per card. No test-only hook in cloud.js:
  // this is the real path a member takes.
  const probe = countRenders(window);
  await openFeed(window, 8, mock);
  // Long enough for all eight reaction responses AND the coalesced flush.
  await new Promise((r) => setTimeout(r, 800));
  const n = probe.count;
  probe.stop();

  assert.ok(n >= 1, "the feed did paint");
  // A BOUND, not the exact number. How many rebuilds the first paint costs
  // depends on how loadFeed itself is structured - two pages, an impression
  // batch, a scope read - and that is not what this test owns. What it owns
  // is that eight per-card loaders do not each add one on top. Measured on
  // this fixture, same run, only loadReactionsFor's last line differing:
  // 12 rebuilds with the coalescing, 19 without. The threshold sits between
  // them with room on both sides rather than pinning either.
  assert.ok(n <= 14,
    `eight per-card reaction loads must coalesce into the frame, not add one full rebuild each - saw ${n}`);
});

test("a member's own tap still rerenders synchronously - the fix must not defer what someone just did", async () => {
  const mock = seeded([row(1), row(2)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2, mock);
  await new Promise((r) => setTimeout(r, 300));

  const probe = countRenders(window);
  // Reacting is the plainest user action on a post card; the optimistic
  // toggle repaints in the same turn it was tapped.
  window.document.querySelector('[data-post-id="p1"] [data-community-action="react"][data-kind="fist_bump"]').click();
  // NO await. If this action had been routed through the coalescing path the
  // DOM would still be the old one at this point in the same turn.
  const immediate = probe.count;
  probe.stop();
  assert.ok(immediate >= 1,
    "a tap must repaint in the same turn it happened, not a frame later");
});
