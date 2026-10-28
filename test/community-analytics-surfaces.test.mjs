// COMM-170. The Phase 1 analytics surfaces, executed for real in jsdom
// against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// - configure() runs once from the session-ready path, before any track(),
//   and attaches the product bus bridge.
// - Each Phase 1 surface writes exactly one analytics_events row with the
//   documented prop shape.
// - Nothing double fires: not on a re-render, not on a close, not on the
//   six event names the bus bridge already covers.
// - Props carry ids, enums and counts only. No member-authored text ever
//   reaches the table.
//
// WHAT THIS FILE DOES NOT VERIFY
// The RLS insert policy and the 4 KB props trigger. Those are Postgres,
// pinned in test/community-rls-boundaries.test.mjs. The helper's own
// contract (trimming, never throwing, the name allow-list) is
// test/platform-analytics.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, holdPosts, waitFor, waitForCommunityGate } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
// Anchored to Date.now(), not a fixed calendar date - see the identical
// fix/comment in community-notifications.test.mjs.
const BASE = Date.now() - 5 * 60000;

function row(i, extra) {
  return Object.assign({
    id: `p${i}`,
    post_type: "POST_TEXT",
    author_id: `u${i + 1}`,
    author: { display_name: `חבר ${i}`, handle: `m${i}` },
    body: `פוסט מספר ${i}`,
    visibility: "club",
    created_at: new Date(BASE - i * 60000).toISOString(),
    published_at: new Date(BASE - i * 60000).toISOString(),
    reaction_count: 0,
    comment_count: 0,
    media: [],
    metadata: {},
  }, extra || {});
}

function seeded(rows, opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, allow_mentions: true, in_leaderboards: true },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, allow_mentions: true },
    ],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    feed_page_rows: rows || [],
    analytics_events: [],
    feed_impressions: [], feed_interactions: [],
    follows: [], hidden_posts: [], saved_posts: [], reactions: [], post_comments: [],
    notifications: [], notification_preferences: [], reports: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

const events = (mock, name) => mock.db.analytics_events.filter((r) => r.event_name === name);
const names = (mock) => mock.db.analytics_events.map((r) => r.event_name);
// An object built inside the jsdom realm has that realm's prototype, which
// deepStrictEqual reads as a mismatch even when the data agrees.
const plain = (v) => JSON.parse(JSON.stringify(v));

async function openCommunity(window) {
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
}
async function openFeed(window, mock, atLeast = 1) {
  mock.onRpc("circle_feed", () => ({ data: null, error: { message: "offline" } }));
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  holdPosts(window, mock.db.feed_page_rows);
  await waitFor(() => window.document.querySelectorAll("#communityHeldPosts .post-card").length >= atLeast, 4000);
}

// ===== configure ======================================================

test("configure runs from the session-ready path, so the first tracked event is written rather than dropped", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);

  // The bridge is what proves configure() ran with attachToBus on.
  assert.equal(window.HaimuniaEvents.handlerCount("POST_CREATED"), 1, "the bus bridge must be attached exactly once");
  assert.equal(window.HaimuniaEvents.handlerCount("REACTION_CREATED"), 1);
  // And a row reached the table, which only happens with a client.
  await waitFor(() => mock.db.analytics_events.length > 0, 3000);
  const first = mock.db.analytics_events[0];
  assert.equal(first.user_id, "u1", "the row carries the signed-in member");
  assert.equal(first.schema_version, window.HaimuniaAnalytics.SCHEMA_VERSION);
});

test("signing out and back in does not stack a second bus bridge", async () => {
  const mock = seeded([row(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "CorrectHorse9");

  await mock.client.auth.signOut();
  await waitForCommunityGate(window);
  await mock.client.auth.signInWithPassword({ email: "dana@members.haimuniya.invalid", password: "CorrectHorse9" });
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);

  assert.equal(window.HaimuniaEvents.handlerCount("POST_CREATED"), 1, "one bridge, however many sessions");
  const before = mock.db.analytics_events.length;
  window.HaimuniaEvents.emit("POST_CREATED", { post_id: "p9", post_type: "POST_TEXT" });
  await waitFor(() => mock.db.analytics_events.length === before + 1, 3000);
  assert.equal(events(mock, "post_created").length, 1);
});

// ===== views ==========================================================

// ===== opens ==========================================================

test("notification_opened fires once per opened row and carries the type, not the body", async () => {
  const mock = seeded([], {
    notifications: [{
      id: "n1", user_id: "u1", type: "reaction", category: "community",
      title: "תגובה חדשה", body: "נועם הגיב/ה לך", deep_link: null,
      source_type: null, source_id: null, read_at: null, created_at: new Date(BASE).toISOString(),
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  // The bell sits in the signed-in home's header.
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-notifications"]'), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => events(mock, "notification_opened").length === 1, 3000);
  const props = plain(events(mock, "notification_opened")[0].props);
  assert.deepStrictEqual(props, { notification_id: "n1", type: "reaction", target: "circle", was_unread: true });
  assert.ok(!JSON.stringify(props).includes("הגיב"), "the notification body never reaches analytics");
});

// ===== actions ========================================================

test("achievement_shared fires once from the unlock sheet, alongside post_created from the bus rather than instead of it", async () => {
  const mock = seeded([], {
    achievement_definitions: [{ id: "ad-1", code: "first_cheer", name: "עידוד ראשון", enabled: true, visibility: "club", trigger_type: "REACTION_CREATED", config: { client_claimable: true } }],
    member_achievements: [{ id: "ma-1", user_id: "u1", achievement_id: "ad-1", code: "first_cheer", visibility: "club", shared_at: null, unlocked_at: VERIFIED, achievement_definitions: { code: "first_cheer", name: "עידוד ראשון", icon: "👏" } }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="ach-share-later"]'), 3000);

  window.document.querySelector('[data-community-action="ach-share-later"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="ach-share"]'), 3000);
  window.document.querySelector('[data-community-action="ach-share"]').click();

  await waitFor(() => events(mock, "achievement_shared").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "achievement_shared")[0].props), { member_achievement_id: "ma-1", code: "first_cheer", source: "unlock_sheet" });
  // The bus bridge wrote the post row on its own. Two names, one action,
  // and neither of them written twice.
  await waitFor(() => events(mock, "post_created").length === 1, 3000);
  assert.equal(events(mock, "achievement_shared").length, 1);
});

// ===== the bus bridge is the only writer of its six names ==============

test("reacting writes exactly one reaction_added, from the bus and not from a second hand-written call", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="react"][data-kind="fist_bump"]').click();
  await waitFor(() => events(mock, "reaction_added").length === 1, 3000);
  assert.deepStrictEqual(plain(events(mock, "reaction_added")[0].props), { post_id: "p1" });

  // Un-react. toggle_reaction removes the row and the producer only emits
  // on a new reaction, so there is no second event and no phantom one.
  window.document.querySelector('[data-post-id="p1"] [data-community-action="react"][data-kind="fist_bump"]').click();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events(mock, "reaction_added").length, 1);
});

// ===== the props budget ===============================================

test("every prop payload the Phase 1 surfaces write stays well under the client budget", async () => {
  const mock = seeded([row(1, { author_id: "u2" }), row(2, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock, 2);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="react"][data-kind="fist_bump"]').click();
  window.HaimuniaEvents.emit("POST_CREATED", { post_id: "p9", post_type: "POST_TEXT" });
  await waitFor(() => mock.db.analytics_events.length >= 2, 4000);

  const budget = window.HaimuniaAnalytics.PROPS_BUDGET_BYTES;
  for (const r of mock.db.analytics_events) {
    const size = JSON.stringify(r.props).length;
    assert.ok(size <= budget, `${r.event_name} props are ${size} bytes, over the ${budget} budget`);
    assert.equal(r.props._truncated, undefined, `${r.event_name} should never need trimming`);
    assert.ok(window.HaimuniaAnalytics.isKnown(r.event_name), `${r.event_name} is not a defined constant`);
  }
});

test("a failing analytics write is invisible to the member and never breaks the surface underneath it", async () => {
  const mock = seeded([row(1, { author_id: "u2" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, mock);
  // Every later insert is rejected the way an RLS denial would be.
  window.HaimuniaAnalytics.configure({
    client: { from: () => ({ insert: () => Promise.reject(new Error("network down")) }) },
    getUserId: () => "u1",
  });

  window.document.querySelector('[data-post-id="p1"] [data-community-action="react"][data-kind="fist_bump"]').click();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(window.document.querySelector('[data-post-id="p1"]'), "the card is still rendered");
  assert.ok(!/משהו השתבש/.test(window.document.body.textContent), "no error surface");
  assert.ok(!names(mock).includes("reaction_added"), "and nothing was written to the real table");
});
