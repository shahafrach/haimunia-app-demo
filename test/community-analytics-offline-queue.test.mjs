// Analytics offline: an event recorded with no connection is QUEUED, not
// dropped.
//
// WHAT WAS WRONG. analyticsTrack() did a direct
// client.from("analytics_events").insert(row) and ended in `.catch(() =>
// false)`. Offline, the fetch rejected and the row was gone - no retry, no
// trace, nothing to reconcile later. In an offline-first app that is not a
// lost packet, it is a blind spot with a shape: a member who trains in a
// basement, logs the session there and syncs on the way home was missing
// from every number this table feeds, and attendance_recorded - the one
// event that can make somebody WCAM-active without ever opening the
// Community tab - is the event most likely to be recorded with no signal.
//
// WHAT IT DOES NOW. The row rides the existing community outbox (COMM
// RELIABILITY, src/outbox.js) as a SILENT row: persisted in IndexedDB,
// drained on the same reconnect the member's own queued writes use, and
// deliberately invisible - it can never become `failed`, never appears in
// the outbox banner or its retry/discard list, and never holds up a queued
// post behind it. Those three exemptions exist because the queue was built
// for member WRITES and analytics has the opposite contract: a dropped
// measurement is acceptable, a member's lost post is not.
//
// This file drives the real src/outbox.js engine over a fake store (the
// same harness community-outbox.test.mjs uses) and the real
// src/analytics.js over a stub client, plus one end-to-end pass through
// bootCommunity so the wiring in cloud.js is exercised rather than assumed.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outboxSrc = fs.readFileSync(path.join(root, "src", "outbox.js"), "utf8");
const analyticsSrc = fs.readFileSync(path.join(root, "src", "analytics.js"), "utf8");

// ---- the engine harness, matching community-outbox.test.mjs --------------
function makeOutbox(seed) {
  const store = seed || new Map();
  const win = {
    crypto: { randomUUID: () => "k" + Math.random().toString(16).slice(2) + Date.now().toString(16) },
    async dbPutCommunityOutboxRow(row) { store.set(row.id, JSON.parse(JSON.stringify(row))); },
    async dbLoadCommunityOutbox() { return [...store.values()].map((r) => JSON.parse(JSON.stringify(r))); },
    async dbDeleteCommunityOutbox(id) { store.delete(id); },
  };
  const factory = new Function("window", "crypto", outboxSrc + "\nreturn window.HaimuniaOutbox;");
  return { api: factory(win, win.crypto), store, win };
}

// src/analytics.js over a fake window, so track() can be driven with the
// network answering however a test needs it to.
function makeAnalytics(opts = {}) {
  const inserted = [];
  const queued = [];
  const win = {
    navigator: { onLine: opts.onLine === undefined ? true : opts.onLine },
    console: { warn() {}, log() {} },
  };
  const factory = new Function("window", "navigator", "TextEncoder", analyticsSrc + "\nreturn window.HaimuniaAnalytics;");
  const api = factory(win, win.navigator, TextEncoder);
  const client = {
    from() {
      return {
        insert(row) {
          inserted.push(row);
          if (opts.reject) return Promise.reject(new Error("Failed to fetch"));
          if (opts.error) return Promise.resolve({ error: { message: opts.error } });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  api.configure({
    client,
    getUserId: () => "u1",
    attachToBus: false,
    queueRow: opts.noQueue ? undefined : (row) => { queued.push(row); return true; },
  });
  return { api, inserted, queued, win };
}

const ROWS = (store) => [...store.values()];
const silentRows = (store) => ROWS(store).filter((r) => r.silent);

// ===== the helper's own half ==========================================

test("a known-offline event is queued without spending a round trip on a request that cannot succeed", async () => {
  const { api, inserted, queued } = makeAnalytics({ onLine: false });
  const ok = await api.track("app_opened", { display_mode: "standalone", platform: "ios" });

  assert.equal(ok, true, "track() reports success once the row is safely queued");
  assert.equal(inserted.length, 0, "navigator.onLine === false is a reliable NO; no request is made");
  assert.equal(queued.length, 1);
  assert.deepStrictEqual(queued[0], {
    event_name: "app_opened",
    props: { display_mode: "standalone", platform: "ios" },
    schema_version: api.SCHEMA_VERSION,
    user_id: "u1",
  });
});

test("a rejected insert - the shape an offline fetch actually takes - is queued rather than swallowed", async () => {
  const { api, inserted, queued } = makeAnalytics({ reject: true });
  const ok = await api.track("attendance_recorded", { occurred_on: "2026-09-22" });

  assert.equal(inserted.length, 1, "it tried first: navigator.onLine is an unreliable yes");
  assert.equal(queued.length, 1, "and the rejection did not end in a dropped row");
  assert.equal(queued[0].event_name, "attendance_recorded");
  assert.equal(ok, true);
});

test("an insert that comes back with an error is queued too, and the props are the projected ones", async () => {
  const { api, queued } = makeAnalytics({ error: "network unreachable" });
  await api.track("mention_inserted", { source: "comment", display_name: "נועם" });

  assert.equal(queued.length, 1);
  assert.deepStrictEqual(queued[0].props, { source: "comment" },
    "the HAND_PROP_KEYS projection runs BEFORE the queue, so a queued row can never carry more than a sent one");
  assert.ok(!JSON.stringify(queued[0]).includes("נועם"));
});

test("a successful insert queues nothing", async () => {
  const { api, inserted, queued } = makeAnalytics();
  const ok = await api.track("club_tab_viewed", { tab: "feed" });
  assert.equal(ok, true);
  assert.equal(inserted.length, 1);
  assert.equal(queued.length, 0);
});

test("with no queue configured the old behaviour stands - dropped, never thrown", async () => {
  const { api, queued } = makeAnalytics({ reject: true, noQueue: true });
  const ok = await api.track("feed_viewed", { scope: "club", source: "club_tab" });
  assert.equal(ok, false, "a dropped measurement reports false and nothing else happens");
  assert.equal(queued.length, 0);
});

test("a queue that throws cannot break the surface being measured", async () => {
  const { api } = makeAnalytics({ reject: true, noQueue: true });
  api.configure({ queueRow: () => { throw new Error("IndexedDB is gone"); }, attachToBus: false });
  const ok = await api.track("post_opened", { post_id: "p1" });
  assert.equal(ok, false, "it degrades to a dropped row - analytics is measurement, not a feature");
});

test("an unknown event name is still refused before anything is queued", async () => {
  const { api, queued } = makeAnalytics({ onLine: false });
  const ok = await api.track("not_a_real_event", { a: 1 });
  assert.equal(ok, false);
  assert.equal(queued.length, 0, "the allow-list is upstream of the queue, so it cannot be bypassed by being offline");
});

test("the debug switch still writes nothing and queues nothing", async () => {
  const { api, inserted, queued } = makeAnalytics({ onLine: false });
  api.configure({ debug: true, attachToBus: false });
  const ok = await api.track("app_opened", { display_mode: "browser", platform: "other" });
  assert.equal(ok, true);
  assert.equal(inserted.length, 0);
  assert.equal(queued.length, 0, "a developer watching the console must not fill a member's queue");
});

// ===== the queue's half: silent rows ==================================

test("a silent row survives a browser restart and drains on reconnect, like any queued write", async () => {
  const first = makeOutbox();
  await first.api.enqueue("analytics_event", { row: { event_name: "post_created" } }, { userId: "u1", silent: true });
  assert.equal(silentRows(first.store).length, 1);

  // Same store, a new engine - the restart.
  const second = makeOutbox(first.store);
  const sent = [];
  second.api.registerHandler("analytics_event", async (args) => { sent.push(args.row); });
  const res = await second.api.flush({ userId: "u1" });

  assert.equal(res.sent, 1);
  assert.equal(sent[0].event_name, "post_created");
  assert.equal(ROWS(second.store).length, 0, "and it leaves the queue when it lands");
});

test("a silent row NEVER becomes failed - it is deleted, so no member is shown a measurement to retry", async () => {
  const { api, store } = makeOutbox();
  await api.enqueue("analytics_event", { row: { event_name: "post_impression" } }, { userId: "u1", silent: true });
  api.registerHandler("analytics_event", async () => { throw new Error("boom"); });

  // Five attempts, the same budget a member's write gets.
  for (let i = 0; i < 6; i++) {
    const rows = await api.list();
    for (const r of rows) { r.nextAttemptAt = 0; await store.set(r.id, r); }
    await api.flush({ userId: "u1" });
  }

  assert.equal(ROWS(store).length, 0, "gone, not parked in the failure list");
  assert.equal(await api.failedCount(), 0);
});

test("a permanent error drops a silent row immediately instead of surfacing it", async () => {
  const { api, store } = makeOutbox();
  await api.enqueue("analytics_event", { row: { event_name: "post_created" } }, { userId: "u1", silent: true });
  api.registerHandler("analytics_event", async () => { throw new Error("not authorized"); });

  const res = await api.flush({ userId: "u1" });
  assert.equal(res.dropped, 1);
  assert.equal(res.failed, 0);
  assert.equal(ROWS(store).length, 0);
});

test("a silent row never blocks a member's post behind it - the FIFO stop rule is for writes only", async () => {
  const { api } = makeOutbox();
  // A telemetry row FIRST, then the member's post.
  await api.enqueue("analytics_event", { row: { event_name: "post_impression" } }, { userId: "u1", silent: true });
  await api.enqueue("post_create", { body: "בוקר טוב" }, { userId: "u1" });

  const sent = [];
  api.registerHandler("analytics_event", async () => { throw new Error("still offline"); });
  api.registerHandler("post_create", async (args) => { sent.push(args.body); });

  const res = await api.flush({ userId: "u1" });
  assert.deepStrictEqual(sent, ["בוקר טוב"], "the post went out even though the telemetry row ahead of it failed");
  assert.equal(res.sent, 1);
  assert.equal(res.stopped, null, "and the drain was never stopped");
});

test("a backed-off silent row is stepped over, not waited on", async () => {
  const { api } = makeOutbox();
  await api.enqueue("analytics_event", { row: { event_name: "post_impression" } }, { userId: "u1", silent: true });
  await api.enqueue("post_create", { body: "שלום" }, { userId: "u1" });
  api.registerHandler("analytics_event", async () => { throw new Error("offline"); });
  const sent = [];
  api.registerHandler("post_create", async (args) => { sent.push(args.body); });

  await api.flush({ userId: "u1" });          // arms the analytics row's backoff
  sent.length = 0;
  const res = await api.flush({ userId: "u1" });   // immediately again
  assert.equal(res.stopped, null, "a backed-off telemetry row does not stop the drain");
});

test("an unsupported silent action is deleted, while an unsupported member action still fails visibly", async () => {
  const { api, store } = makeOutbox();
  await api.enqueue("analytics_event", { row: {} }, { userId: "u1", silent: true });
  await api.enqueue("some_removed_action", {}, { userId: "u1" });
  // No handler registered for either.
  const res = await api.flush({ userId: "u1" });

  const left = ROWS(store);
  assert.equal(left.length, 1, "only the member's own op is kept");
  assert.equal(left[0].action, "some_removed_action");
  assert.equal(left[0].status, "failed", "which still fails visibly - nothing of the member's vanishes");
  assert.equal(res.failed, 1);
});

test("the member-visible counts exclude silent rows entirely", async () => {
  const { api } = makeOutbox();
  await api.enqueue("analytics_event", { row: {} }, { userId: "u1", silent: true });
  await api.enqueue("analytics_event", { row: {} }, { userId: "u1", silent: true });
  await api.enqueue("post_create", { body: "x" }, { userId: "u1" });

  assert.equal(await api.pendingCount(), 1, "one member write pending, not three things");
  assert.equal(await api.failedCount(), 0);
});

test("silent rows are capped, oldest first, and a member's write is never trimmed to make room", async () => {
  const { api, store } = makeOutbox();
  await api.enqueue("post_create", { body: "הפוסט שלי" }, { userId: "u1" });
  for (let i = 0; i < 230; i++) {
    await api.enqueue("analytics_event", { row: { event_name: "post_impression", n: i } }, { userId: "u1", silent: true });
  }

  const silent = silentRows(store);
  assert.equal(silent.length, 200, "bounded - browsing a cached feed offline cannot grow this without limit");
  const kept = silent.map((r) => r.args.row.n).sort((a, b) => a - b);
  assert.equal(kept[0], 30, "the oldest were dropped, so the newest survive");
  assert.equal(kept[kept.length - 1], 229);
  assert.ok(ROWS(store).some((r) => r.action === "post_create"), "the member's post is untouched by the cap");
});

test("a silent row queued by one member is not drained under another member's session", async () => {
  const { api, store } = makeOutbox();
  await api.enqueue("analytics_event", { row: { event_name: "post_created" } }, { userId: "u1", silent: true });
  const sent = [];
  api.registerHandler("analytics_event", async (args) => { sent.push(args.row); });

  const res = await api.flush({ userId: "u2" });
  assert.equal(sent.length, 0, "the same misattribution guard a member's write gets");
  assert.equal(res.skipped, 1);
  assert.equal(ROWS(store).length, 1, "it waits for its own member rather than being sent or dropped");
});

// ===== end to end, through the real cloud.js wiring ===================

const VERIFIED = new Date().toISOString();
function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    analytics_events: [], announcements: [], feed_page_rows: [],
    notifications: [], notification_preferences: [], follows: [], hidden_posts: [], saved_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

test("end to end: an event recorded offline lands in the queue, and reaches the table on reconnect", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => mock.db.analytics_events.some((r) => r.event_name === "app_opened"), 4000);
  const onlineCount = mock.db.analytics_events.length;

  // Go offline. navigator.onLine is the signal both communityRpc() and
  // analyticsTrack() read, and it is only ever trusted as a NO.
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });

  await window.analyticsTrack("attendance_recorded", { occurred_on: "2026-09-22" });
  await waitFor(async () => (await window.HaimuniaOutbox.list()).some((r) => r.silent), 4000);

  const queued = (await window.HaimuniaOutbox.list()).filter((r) => r.silent);
  assert.equal(queued.length, 1, "queued, not dropped");
  assert.equal(queued[0].action, "analytics_event");
  assert.equal(queued[0].args.row.event_name, "attendance_recorded");
  assert.equal(mock.db.analytics_events.length, onlineCount, "and nothing reached the table while offline");

  // The member is not told about it: the outbox banner counts member writes.
  assert.equal(await window.HaimuniaOutbox.pendingCount(), 0);

  // Reconnect. The same "online" event that drains a member's queued post.
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.dispatchEvent(new window.Event("online"));

  await waitFor(() => mock.db.analytics_events.some((r) => r.event_name === "attendance_recorded"), 5000);
  const landed = mock.db.analytics_events.find((r) => r.event_name === "attendance_recorded");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(landed.props)), { occurred_on: "2026-09-22" });
  assert.equal(landed.user_id, "u1", "attributed to the member who was offline, not to whoever drained it");
  assert.equal((await window.HaimuniaOutbox.list()).filter((r) => r.silent).length, 0, "and it leaves the queue");
});

test("end to end: the offline queue never puts a telemetry row in front of the member", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => mock.db.analytics_events.length > 0, 4000);
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });

  for (let i = 0; i < 5; i++) await window.analyticsTrack("post_impression", { post_id: "p" + i, position: i });
  await waitFor(async () => (await window.HaimuniaOutbox.list()).filter((r) => r.silent).length === 5, 4000);

  assert.equal(await window.HaimuniaOutbox.pendingCount(), 0, "the outbox banner counts member writes, not measurements");
  assert.equal(await window.HaimuniaOutbox.failedCount(), 0);
  assert.ok(!window.document.body.textContent.includes("post_impression"));
});
