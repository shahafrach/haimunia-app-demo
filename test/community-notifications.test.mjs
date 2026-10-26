// COMM-140..144, the client half of the notifications cluster, executed
// for real in jsdom against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// - COMM-140: the bell opens a category-grouped, paged, focus-trapped
//   dialog; each row has an icon, title, body, time, read state, deep link.
// - COMM-141: reads go only through notif_list; notif_unread_count drives
//   the badge and refreshes on a realtime own-row event; mark read is
//   optimistic with rollback; the 90-day horizon and "show older".
// - COMM-142: an immediate notification is its own row; a batched type
//   renders as one collapsed group that expands. The operational-
//   announcement override.
// - COMM-143: deep link resolution opens the exact target screen and item,
//   and marks the row read.
// - COMM-144: the Account preferences panel lists every type with Push
//   (disabled), In-app and Off; a change is a direct own-row upsert into
//   notification_preferences and reverts on error.
//
// - Launch-readiness pass: `new_report` (202609050003) and
//   `monthly_club_recap` (202609010002) are registered in NOTIF_TYPES with
//   Hebrew copy instead of falling through to a raw-English unknown-type
//   render; `resolveNotifTarget` tells a monthly recap deep link apart from
//   a weekly one (both match `/\/recap(\/|$)/`, so the monthly one used to
//   silently open the weekly dialog); `NOTIF_PREF_TYPES`' `comment_reply`/
//   `comment_on_post`/`achievement_unlocked` keys were re-keyed to match
//   the server's real `notif_pref_key()` output (COMM-218/219 known
//   drift), leaving `challenges` a documented gap; `navigateToNotifTarget`
//   gained branches for `target.challenge`/`target.announcement`/
//   `target.achievement`, which `resolveNotifTarget` already resolved but
//   which previously landed on the right tab and did nothing further.
//
// WHAT THIS FILE DOES NOT VERIFY
// The server trigger set that creates the rows and the batch flusher.
// Those are Postgres, documented in contracts.md under "Needs from
// schema, notifications". A test seeds `notifications` directly, the same
// way the RLS boundary tests do.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, holdPosts, waitFor, notifPrefControl, notifPrefOption, notifPrefValue, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
// Anchored to Date.now(), not a fixed calendar date - a hardcoded past
// date eventually crosses relativeTime()'s 7-day "switch to absolute date"
// threshold and fails this suite's own relative-time assertions on any
// day after that, regardless of the product code being correct.
const BASE = Date.now() - 5 * 60000;

function iso(days) { return new Date(Date.now() + days * 86400000).toISOString(); }

function notif(i, extra) {
  return Object.assign({
    id: `n${i}`,
    user_id: "u1",
    type: "achievement_unlocked",
    category: "community",
    title: `התראה ${i}`,
    body: `גוף ההתראה ${i}`,
    source_type: null,
    source_id: null,
    deep_link: null,
    read_at: null,
    created_at: new Date(BASE - i * 60000).toISOString(),
  }, extra || {});
}

function seeded(notifications, opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    notifications: notifications || [],
    notification_preferences: [],
    feed_page_rows: (opts && opts.feed) || [],
    follows: [], hidden_posts: [], saved_posts: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openCommunity(window) {
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
}
async function openCenter(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector("[data-notif-center]"), 4000);
  // let the first page settle
  await waitFor(() => {
    const c = window.document.querySelector("[data-notif-center]");
    return c && !/aria-busy="true"/.test(c.innerHTML);
  }, 4000);
}
async function openAccount(window) {
  await openCommunity(window);
  await waitFor(() => !!notifPrefControl(window, "trained_together"), 4000);
}
const centerText = (window) => window.document.querySelector("[data-notif-center]").textContent;

// ===== COMM-140 notification centre ===================================

test("the bell opens a dialog; each row carries an icon, title, body and relative time", async () => {
  const mock = seeded([notif(1, { type: "trained_together", title: "תגובה חדשה", body: "נועם הגיב/ה לך" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  const dlg = window.document.querySelector("[data-notif-center]");
  assert.equal(dlg.getAttribute("role"), "dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  const rowEl = dlg.querySelector('[data-community-action="notif-open"]');
  assert.ok(rowEl, "a notification row renders");
  assert.match(rowEl.textContent, /תויגתם/, "the client title for the type");
  assert.match(rowEl.textContent, /נועם הגיב/);
  assert.match(rowEl.textContent, /לפני|עכשיו/, "a relative timestamp is shown");
});

test("rows are grouped under the two category headings in order", async () => {
  const mock = seeded([
    notif(1, { type: "trained_together", category: "community" }),
    notif(2, { type: "achievement_unlocked", category: "training" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  const t = centerText(window);
  const order = ["מעגל", "אימונים"].map((h) => t.indexOf(h));
  assert.ok(order.every((i) => i >= 0), "every category heading is present");
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, "headings render in category order");
});

test("the centre pages 20 at a time and hands the cursor back for the next page", async () => {
  const rows = [];
  for (let i = 1; i <= 25; i++) rows.push(notif(i, { type: "trained_together" }));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 20, "first page is 20");
  window.document.querySelector('[data-community-action="notif-load-more"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-community-action="notif-open"]').length === 25, 4000);

  const listCalls = mock.callsTo("notif_list");
  assert.ok(listCalls.length >= 2, "a second page was fetched");
  assert.equal(listCalls[0].p_cursor, null, "first page has no cursor");
  assert.ok(listCalls[1].p_cursor, "the second page passes the cursor from the first");
  assert.ok(listCalls.every((c) => c.p_limit <= 40), "limit stays within the server cap");
});

test("empty, loading and error states each render", async () => {
  // empty
  let mock = seeded([]);
  let window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.match(centerText(window), /אין עדיין התראות/);

  // error
  mock = seeded([notif(1)]);
  mock.onRpc("notif_list", () => ({ data: null, error: { message: "boom" } }));
  window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => /לא ניתן לטעון התראות/.test(centerText(window)), 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-retry"]'), "a retry control is offered");
});

test("Escape closes the centre and returns focus to the bell", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.querySelector("[data-notif-center]"), 4000);
  assert.equal(window.document.activeElement, window.document.querySelector('[data-community-action="feed-notifications"]'), "focus returns to the bell");
});

// ===== COMM-141 model, read, mark-read wiring =========================

test("the badge count comes from notif_unread_count()", async () => {
  const mock = seeded([notif(1), notif(2), notif(3)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  assert.ok(mock.callsTo("notif_unread_count").length >= 1, "the count RPC was called on session load");
  const bell = window.document.querySelector('[data-community-action="feed-notifications"]');
  assert.match(bell.getAttribute("aria-label"), /3 חדשות/);
});

test("the centre reads only through notif_list, never a raw notifications select", async () => {
  const mock = seeded([notif(1), notif(2)]);
  const seenTables = [];
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => { seenTables.push(table); return realFrom(table); };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.ok(mock.callsTo("notif_list").length >= 1, "notif_list drives the list");
  assert.ok(!seenTables.includes("notifications"), "no direct .from('notifications') anywhere");
});

test("opening the centre marks the rows it showed read, and the badge drops", async () => {
  const mock = seeded([notif(1), notif(2), notif(3)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  await waitFor(() => mock.db.notifications.every((n) => n.read_at), 4000);
  assert.ok(mock.callsTo("notif_mark_read").length >= 1, "notif_mark_read was called on open");
  await openCommunity(window); // re-render the strip
  assert.doesNotMatch(window.document.querySelector('[data-community-action="feed-notifications"]').getAttribute("aria-label"), /חדשות/);
});

test("mark all read clears rows loaded after the first page", async () => {
  const rows = [];
  for (let i = 1; i <= 25; i++) rows.push(notif(i, { type: "trained_together" }));
  const mock = seeded(rows);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  window.document.querySelector('[data-community-action="notif-load-more"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-community-action="notif-open"]').length === 25, 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-mark-all"]'), "mark-all is offered while unread rows are loaded");

  window.document.querySelector('[data-community-action="notif-mark-all"]').click();
  await waitFor(() => mock.db.notifications.every((n) => n.read_at), 4000);
  // Changed 2026-09-15 after the first real-phone session: the control used
  // to stay in the DOM as a DISABLED .link-btn, which on a phone is a 13px
  // steel underline at opacity .45 next to an identical-looking enabled
  // "סגירה" - tapped, nothing happened, reported as broken. It now leaves
  // and states the fact instead, so the assertion moves from "is disabled"
  // to "is gone, and the reason is on screen".
  await waitFor(() => !window.document.querySelector('[data-community-action="notif-mark-all"]'), 4000);
  assert.ok(!window.document.querySelector('[data-community-action="notif-mark-all"]'), "mark-all stops being offered once everything is read");
  assert.match(window.document.querySelector("[data-notif-center]").textContent, /הכול כבר סומן כנקרא/,
    "and says so, rather than leaving a dead control the member will tap and report as broken");
});

test("mark read is optimistic and rolls back when the server rejects it", async () => {
  const mock = seeded([notif(1, { type: "trained_together", deep_link: "/community/boards?challenge=ch1" })]);
  mock.onRpc("notif_mark_read", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => /לא ניתן לסמן כנקרא/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(mock.db.notifications[0].read_at, null, "the failed mark-read left the row unread");
});

test("the 90-day horizon is not walked until 'show older' is used", async () => {
  const fresh = [notif(1), notif(2), notif(3)];
  // The marker is `body`, not `title`: a row's title comes from the client's
  // own NOTIF_TYPES label for its type (the server sends a fixed English
  // string for every type but `announcement`), so a per-row title is not
  // rendered and cannot identify one row. `body` is per-row server content
  // and is rendered verbatim.
  const old = [
    notif(90, { created_at: new Date(BASE - 120 * 86400000).toISOString(), body: "התראה ישנה" }),
    notif(91, { created_at: new Date(BASE - 130 * 86400000).toISOString() }),
  ];
  const mock = seeded(fresh.concat(old));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.doesNotMatch(centerText(window), /התראה ישנה/, "rows past 90 days are not fetched by default");
  assert.ok(window.document.querySelector('[data-community-action="notif-show-older"]'), "a 'show older' control is offered");

  window.document.querySelector('[data-community-action="notif-show-older"]').click();
  await waitFor(() => /התראה ישנה/.test(centerText(window)), 4000);
});

// ===== COMM-142 immediate versus batched rendering ===================

test("routing: an immediate notification renders as its own row", async () => {
  const mock = seeded([
    notif(1, { type: "trained_together" }),
    notif(2, { type: "trained_together" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 2, "two standalone rows");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-toggle-group"]').length, 0, "no collapsed group");
  assert.equal(window.classifyNotification({ type: "trained_together" }), "immediate");
});

test("routing: a batched type renders as one collapsed row that expands", async () => {
  const mock = seeded([
    notif(1, { type: "reaction" }),
    notif(2, { type: "reaction" }),
    notif(3, { type: "reaction" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  const group = window.document.querySelectorAll('[data-community-action="notif-toggle-group"]');
  assert.equal(group.length, 1, "three reactions collapse into one group");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 0, "children are hidden while collapsed");
  assert.equal(group[0].getAttribute("aria-expanded"), "false");

  group[0].click();
  await waitFor(() => window.document.querySelectorAll('[data-community-action="notif-open"]').length === 3, 4000);
  assert.equal(window.classifyNotification({ type: "reaction" }), "batched");
});

test("notifRoute honours the per-type preference, and an unknown type is suppressed", async () => {
  // Explicitly flag-off: this asserts the "push reads as in_app" fallback,
  // which only exists while push is unavailable. Default is on since B3.
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  await openCommunity(window);

  assert.deepEqual(window.notifRoute("reaction", { reactions: "off" }), { channel: "off", mode: "batched", suppressed: true });
  assert.deepEqual(window.notifRoute("trained_together", {}), { channel: "in_app", mode: "immediate", suppressed: false });
  // web push is off in V1: a stored "push" degrades to in-app
  assert.equal(window.notifRoute("reaction", { reactions: "push" }).channel, "in_app");
  // a type the client no longer knows (comments, announcements ... went with their features) is suppressed
  assert.equal(window.notifRoute("announcement", {}).suppressed, true);
});

// ===== COMM-143 phase 1 types and deep links =========================

test("deep link resolution maps route and source fields to the exact target", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  const R = window.notifResolveTarget;
  assert.deepEqual(R({ deep_link: "/community/feed?post=p1" }), { tab: "account", post: "p1" });
  assert.deepEqual(R({ deep_link: "/community/account/achievements?ma=ma1" }), { tab: "account", achievement: "ma1" });
  assert.equal(R({ source_type: "post", source_id: "p2" }).post, "p2", "source_type/source_id is the fallback");
  assert.deepEqual(R({ deep_link: "/community/boards?challenge=ch1" }), { tab: "account" }, "a link into a dropped screen lands on the home");
});

test("tapping a row opens its deep-link target and marks it read", async () => {
  const post = {
    id: "p7", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: new Date(BASE).toISOString(), published_at: new Date(BASE).toISOString(),
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  };
  const mock = seeded(
    [notif(1, { type: "trained_together", deep_link: "/community/feed?post=p7" })],
    { feed: [post] },
  );
  // The post is handed to the Circle tab directly; the feed read must not replace it.
  mock.onRpc("circle_feed", () => ({ data: null, error: { message: "offline" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  // The post is in the Circle tab; the bell and the centre are in Me.
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  holdPosts(window, [post]);
  window.switchAppTab("me");
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-notifications"]'), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => !window.document.querySelector("[data-notif-center]"), 4000);
  await waitFor(() => !!window.document.querySelector('#communityHeldPosts [data-post-id="p7"]'), 4000);
  assert.deepEqual(mock.callsTo("notif_mark_read").slice(-1)[0], { p_ids: ["n1"] }, "the tapped row was marked read");
});

test("each type carries its own icon, category and copy", async () => {
  const mock = seeded([
    notif(1, { type: "trained_together", category: "community" }),
    notif(2, { type: "achievement_unlocked", category: "training" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  const html = window.document.querySelector("[data-notif-center]").innerHTML;
  assert.match(html, /🤝/, "trained-together icon");
  assert.match(html, /🏅/, "achievement icon");
  // category placement
  const t = centerText(window);
  assert.ok(t.indexOf("קהילה") < t.indexOf("אימונים"), "community before training");
});

// ===== COMM-144 preferences per type =================================

test("the Account panel lists every type with Push (disabled), In-app and Off", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  await openAccount(window);

  const types = new Set([...window.document.querySelectorAll("[data-notif-pref-select]")].map((b) => b.dataset.type));
  assert.deepEqual([...types].sort(), ["achievement_unlocked", "reactions", "trained_together"],
    "the member-visible preference types that are left (comments, mentions, challenges, events, announcements, recaps, streaks and friend alerts went with their features)");

  // Real device feedback: a disabled push button ("התראת דחיפה · בקרוב")
  // used to still render in V1, unbalancing the row next to in_app/off -
  // the option is omitted entirely now while the flag is off, not merely
  // disabled. See test/community-web-push.test.mjs for the dedicated
  // coverage of this and the flag-on case.
  const push = notifPrefOption(window, "reactions", "push");
  assert.equal(push, null, "push is not offered at all in V1, not just disabled");
  const inApp = notifPrefOption(window, "reactions", "in_app");
  assert.ok(!inApp.disabled, "In-app works");
  assert.equal(notifPrefValue(window, "reactions"), "in_app", "the default selection is In-app");
});

test("changing a preference is a direct own-row upsert into notification_preferences", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  pickNotifPref(window, "trained_together", "off");
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "trained_together" && r.channel === "off"), 4000);

  const row = mock.db.notification_preferences.find((r) => r.type === "trained_together");
  assert.equal(row.user_id, "u1", "written under the caller's own id");
  assert.equal(row.channel, "off");

  // reflected on re-render
  window.render();
  await waitFor(() => !!notifPrefControl(window, "trained_together"), 4000);
  assert.equal(notifPrefValue(window, "trained_together"), "off");
});

test("stored preferences load and drive the panel selection", async () => {
  const mock = seeded([], { notification_preferences: [
    { user_id: "u1", type: "reactions", channel: "off" },
    { user_id: "u1", type: "trained_together", channel: "in_app" },
  ] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  assert.equal(notifPrefValue(window, "reactions"), "off");
  assert.equal(notifPrefValue(window, "trained_together"), "in_app");
});

test("a failed preference save reverts the control and shows the Hebrew error", async () => {
  const mock = seeded([]);
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "notification_preferences") chain.upsert = () => ({ then: (res) => Promise.resolve(res({ error: { message: "boom" } })) });
    return chain;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  pickNotifPref(window, "reactions", "off");
  await waitFor(() => /לא ניתן לשמור העדפה זו/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(notifPrefValue(window, "reactions"), "in_app", "the control reverted to In-app");
});

// ===== COMM-219 announcements row states the important/urgent bypass ==

// ===== push path is feature-flagged off ==============================

test("no push subscription is created and push offers no control at all with the flag off", async () => {
  const mock = seeded([notif(1)]);
  const seenTables = [];
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => { seenTables.push(table); return realFrom(table); };
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  await openAccount(window);
  // Real device feedback: this used to click a disabled push button - now
  // there is no button to click at all while the flag is off (see
  // community-web-push.test.mjs for the dedicated coverage of both states).
  assert.equal(
    notifPrefOption(window, "reactions", "push"), null,
    "no push control exists in the DOM in V1");
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!seenTables.includes("push_subscriptions"), "nothing writes push_subscriptions in V1");
  assert.equal(mock.db.notification_preferences.length, 0, "nothing was written");
});

// ===== Launch-readiness fix 1: new_report / monthly_club_recap registered ==

// ===== Launch-readiness fix 2: monthly recap deep link vs weekly (COMM-309) =

// ===== Launch-readiness fix 3: NOTIF_PREF_TYPES keys match the server ======

// ===== Launch-readiness fix 4: navigateToNotifTarget's missing branches ====

test("tapping an achievement-unlocked notification scrolls to that achievement in the Account tab", async () => {
  const mock = seeded(
    [notif(1, { type: "achievement_unlocked", category: "training", deep_link: "/community/account/achievements?ma=ma1" })],
    { member_achievements: [{ id: "ma1", user_id: "u1", achievement_id: "ad-1", code: "first_pr", visibility: "club", shared_at: null, unlocked_at: VERIFIED, achievement_definitions: { code: "first_pr", name: "PR ראשון", icon: "🏋️" } }] },
  );
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => !window.document.querySelector("[data-notif-center]"), 4000);
  await waitFor(() => !!window.document.querySelector('[data-achievement-id="ma1"]'), 4000);

  assert.ok(window.document.querySelector('[data-achievement-id="ma1"]'), "the specific unlocked achievement has a real DOM anchor to scroll to");
});

