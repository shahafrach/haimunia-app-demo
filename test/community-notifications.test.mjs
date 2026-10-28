// The client half of notifications, executed for real in jsdom against the mock
// Supabase client: the bell and its dialog, paging, mark read, the type
// registry (four types, all circle notifications), the opt-in routing rule, and
// the preference switches in Me.
//
// The Me switches' push behaviour is test/community-web-push.test.mjs; deep-link
// navigation into a circle and post is test/circle-notifications.test.mjs; the
// server side (who is written, who is pushed to) is pgTAP.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, notifPrefControl, notifPrefValue, pickNotifPref } from "./helpers/boot.mjs";
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
    type: "reaction",
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
  assert.match(rowEl.textContent, /תיוג לאימון משותף/, "the client title for the type");
  assert.match(rowEl.textContent, /נועם הגיב/);
  assert.match(rowEl.textContent, /לפני|עכשיו/, "a relative timestamp is shown");
});

test("every row sits under the one circles heading", async () => {
  const mock = seeded([
    notif(1, { type: "trained_together", category: "community" }),
    notif(2, { type: "week_card", category: "community" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  const t = centerText(window);
  assert.equal(t.split("מעגלים").length - 1, 1, "one heading, once");
  assert.match(t, /תיוג לאימון משותף/);
  assert.match(t, /כרטיס השבוע מוכן/);
  assert.doesNotMatch(t, /אימונים\s*$|קהילה/, "the gym-era headings are gone");
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
  const mock = seeded([notif(1, { type: "trained_together", deep_link: "/circles?c=club-1" })]);
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

// ===== rows and routing =============================================

test("every notification is its own row: nothing collapses into a group", async () => {
  const mock = seeded([
    notif(1, { type: "reaction" }),
    notif(2, { type: "reaction" }),
    notif(3, { type: "reaction" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-open"]').length, 3, "three standalone rows");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-toggle-group"]').length, 0, "no collapsed group");
  assert.equal(window.classifyNotification, undefined, "the batched/immediate split is gone with the batch group");
});

test("notifRoute is opt-in: no stored preference is off, and a type the client no longer knows is suppressed", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  await openCommunity(window);

  for (const type of ["reaction", "trained_together", "circle_joined", "week_card"]) {
    assert.deepEqual(window.notifRoute(type, {}), { channel: "off", suppressed: true }, `${type} is off by default`);
    assert.deepEqual(window.notifRoute(type, { [type]: "off" }), { channel: "off", suppressed: true });
    assert.deepEqual(window.notifRoute(type, { [type]: "in_app" }), { channel: "in_app", suppressed: false });
  }
  assert.equal(window.notifRoute("reaction", { reaction: "bogus" }).suppressed, true, "an unknown channel is off, not on");
  // With the device flag off a stored "push" degrades to the bell.
  assert.equal(window.notifRoute("reaction", { reaction: "push" }).channel, "in_app");
  // Gym-era types are not types any more.
  for (const gone of ["announcement", "coach_mention", "event_cancelled", "challenge_complete", "streak_at_risk", "achievement_unlocked", "comment_on_post", "mention"]) {
    assert.equal(window.notifRoute(gone, { [gone]: "push" }).suppressed, true, `${gone} is suppressed`);
  }
});

// ===== deep links ====================================================

test("deep link resolution maps route and source fields to the circle and post", async () => {
  const mock = seeded([notif(1)]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  const R = window.notifResolveTarget;
  assert.deepEqual(R({ deep_link: "/circles?c=club-1&post=p1" }), { tab: "circle", circle: "club-1", post: "p1", week: false });
  assert.deepEqual(R({ deep_link: "/circles?c=club-1&week=1" }), { tab: "circle", circle: "club-1", post: null, week: true });
  assert.deepEqual(R({ deep_link: "/circles?c=club-1" }), { tab: "circle", circle: "club-1", post: null, week: false });
  assert.deepEqual(R({ circle_id: "club-9", source_type: "post", source_id: "p2" }), { tab: "circle", circle: "club-9", post: "p2", week: false },
    "circle_id and source_type/source_id are the fallback when deep_link is absent");
  assert.deepEqual(R({ deep_link: "/community/boards?challenge=ch1" }), { tab: "circle", circle: null, post: null, week: false },
    "a link into a dropped screen names no circle");
});

test("each of the four types carries its own icon, category and copy", async () => {
  const mock = seeded([
    notif(1, { type: "reaction" }),
    notif(2, { type: "trained_together" }),
    notif(3, { type: "circle_joined" }),
    notif(4, { type: "week_card" }),
  ]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCenter(window);
  const html = window.document.querySelector("[data-notif-center]").innerHTML;
  for (const icon of ["🔥", "🤝", "👋", "📅"]) assert.ok(html.includes(icon), `${icon} renders`);
  assert.doesNotMatch(html, /🏅/, "no achievement notification");
});

// ===== the switches in Me ==============================================

const FOUR = ["reaction", "trained_together", "circle_joined", "week_card"];

test("Me has one switch per type, and ALL FOUR ARE OFF for a member who has set nothing", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  const types = [...window.document.querySelectorAll("[data-notif-pref-toggle]")].map((b) => b.dataset.type);
  assert.deepEqual(types, FOUR, "exactly these, in this order (comments, mentions, coach, class, event, challenge, recap, streak and achievement preferences are gone)");
  for (const t of FOUR) {
    assert.equal(notifPrefValue(window, t), "off", `${t} is off by default`);
    assert.equal(notifPrefControl(window, t).getAttribute("role"), "switch");
    assert.ok(notifPrefControl(window, t).getAttribute("aria-label"), `${t} has its own accessible name`);
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(mock.db.notification_preferences.length, 0, "looking at the panel writes nothing");
  assert.equal(mock.db.push_subscriptions ? mock.db.push_subscriptions.length : 0, 0, "and subscribes nothing");
});

test("turning a switch on is a direct own-row upsert into notification_preferences; off writes an explicit off", async () => {
  const mock = seeded([]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  // jsdom has no Push API, so "on" here is the bell.
  pickNotifPref(window, "trained_together", true);
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "trained_together" && r.channel === "in_app"), 4000);
  const row = mock.db.notification_preferences.find((r) => r.type === "trained_together");
  assert.equal(row.user_id, "u1", "written under the caller's own id");

  window.render();
  await waitFor(() => !!notifPrefControl(window, "trained_together"), 4000);
  assert.equal(notifPrefValue(window, "trained_together"), "on", "reflected on re-render");
  assert.equal(notifPrefValue(window, "reaction"), "off", "and the other three did not move");

  pickNotifPref(window, "trained_together", false);
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "trained_together" && r.channel === "off"), 4000);
  assert.equal(mock.db.notification_preferences.length, 1, "the same row, now off");
});

test("stored preferences load and drive the switches", async () => {
  const mock = seeded([], { notification_preferences: [
    { user_id: "u1", type: "reaction", channel: "off" },
    { user_id: "u1", type: "trained_together", channel: "in_app" },
    { user_id: "u1", type: "week_card", channel: "push" },
  ] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  assert.equal(notifPrefValue(window, "reaction"), "off");
  assert.equal(notifPrefValue(window, "trained_together"), "on");
  assert.equal(notifPrefValue(window, "week_card"), "on");
  assert.equal(notifPrefValue(window, "circle_joined"), "off", "no row is off");
});

test("a failed preference save reverts the switch and shows the Hebrew error", async () => {
  const mock = seeded([]);
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "notification_preferences") chain.upsert = () => ({ then: (res) => Promise.resolve(res({ error: { message: "boom" } })) });
    return chain;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  pickNotifPref(window, "reaction", true);
  await waitFor(() => /לא ניתן לשמור העדפה זו/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(notifPrefValue(window, "reaction"), "off", "the switch reverted to off");
});

test("with the device flag off nothing touches push_subscriptions and no push mention is shown", async () => {
  const mock = seeded([notif(1)]);
  const seenTables = [];
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => { seenTables.push(table); return realFrom(table); };
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  await openAccount(window);
  assert.doesNotMatch(window.document.getElementById("notifPrefs").textContent, /דחיפה/);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!seenTables.includes("push_subscriptions"), "nothing writes push_subscriptions");
  assert.equal(mock.db.notification_preferences.length, 0, "nothing was written");
});
