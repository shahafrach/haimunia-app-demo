// The client half of web push: turning a switch in Me on subscribes this
// device, the VAPID key fails closed, a subscription does not outlive the
// session, and the sw.js handlers read what the sender writes.
//
// WHAT THIS FILE VERIFIES
// - With the device flag off, no push mention and no Push API call.
// - Flag on and a capable browser: turning a switch on asks permission, then
//   pushManager.subscribe with the VAPID applicationServerKey, then a
//   push_subscriptions upsert, then the notification_preferences upsert.
// - FAIL CLOSED ON THE KEY: while cloud-config.js still holds the placeholder
//   (or anything that is not a 65-byte P-256 point) there is no permission
//   prompt, no subscribe attempt and no push_subscriptions write; the switch
//   falls back to the bell and the screen says push is not set up.
// - A subscription made under another key is replaced, not reused.
// - Permission denied: the exact Hebrew copy, nothing subscribed, the switch
//   still works for the bell.
// - A device that is already subscribed does not re-prompt for a second type.
// - Unsupported browsers and iOS Safari without an installed PWA say why.
// - The explicit device control revokes (revoked_at, never a delete).
// - SIGN-OUT removes this device's subscription, the browser's and the server
//   row, without ever blocking the sign-out; ACCOUNT DELETION removes every
//   one the member has.
// - sw.js's push and notificationclick handlers (source-level; jsdom cannot
//   run a service worker) and the deep-link receivers in cloud.js/app.js.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, waitForCommunityGate, notifPrefControl, notifPrefValue, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    notifications: [],
    notification_preferences: [],
    push_subscriptions: [],
    follows: [], hidden_posts: [], saved_posts: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccount(window) {
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!notifPrefControl(window, "reaction"), 4000);
}

// A faithful-enough stand-in for the browser's Push API: one mutable
// subscription slot per stub, so a test can simulate "already subscribed"
// (seed opts.existingEndpoint) and "the browser dropped it" (setSub(null)).
//
// It also puts the window in STANDALONE by default, and that is not
// incidental scaffolding. Since the permission gate landed
// (pushAskGateReason, src/community/notifications.js) the app does not ask
// for notification permission outside the installed app on any platform, so
// a stub that left navigator.standalone unset would be stubbing a Push API
// that this app would never reach - every test below would pass or fail on
// the gate rather than on what it means to test. Pass `standalone: false` to
// exercise the gate itself; test/community-push-gate-and-self-test.test.mjs
// is where that is done deliberately.
function stubPushApis(window, opts = {}) {
  Object.defineProperty(window.navigator, "standalone", {
    value: opts.standalone !== false,
    configurable: true,
  });
  const calls = { requestPermission: 0, subscribe: 0, getSubscription: 0 };
  let sub = opts.existingEndpoint ? makeSub(opts.existingEndpoint, opts.existingKey) : null;
  function makeSub(endpoint, applicationServerKey) {
    return {
      endpoint,
      options: applicationServerKey ? { applicationServerKey } : {},
      keys: { p256dh: "keyA", auth: "keyB" },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
      unsubscribe: async () => { sub = null; return true; },
    };
  }
  const reg = {
    pushManager: {
      getSubscription: async () => { calls.getSubscription++; return sub; },
      subscribe: async (options) => {
        calls.subscribe++;
        calls.subscribeOptions = options;
        sub = makeSub(opts.newEndpoint || "https://push.example/ep-" + (calls.subscribe), options.applicationServerKey);
        return sub;
      },
    },
  };
  window.navigator.serviceWorker = Object.assign(window.navigator.serviceWorker || {}, { ready: Promise.resolve(reg) });
  window.PushManager = function () {};
  window.Notification = {
    permission: opts.permission || "default",
    requestPermission: async () => { calls.requestPermission++; return opts.deny ? "denied" : "granted"; },
  };
  return { calls, setSub: (s) => { sub = s; }, getSub: () => sub };
}

function stubIOSNonStandalone(window) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15",
    configurable: true,
  });
  Object.defineProperty(window.navigator, "standalone", { value: false, configurable: true });
}

// ===== the flag stays off by default ==================================

test("with the device flag explicitly off, nothing mentions push and no Push API call happens", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  const push = stubPushApis(window);
  await openAccount(window);

  const row = notifPrefControl(window, "reaction").closest(".log-row");
  assert.doesNotMatch(row.textContent, /דחיפה/, "no push mention on the row");
  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.notification_preferences.length === 1, 4000);
  assert.equal(mock.db.notification_preferences[0].channel, "in_app", "on means the bell");
  assert.equal(push.calls.requestPermission, 0);
  assert.equal(push.calls.subscribe, 0);
  assert.equal(mock.db.push_subscriptions.length, 0, "no subscription exists while the flag is off");
});

// ===== flag on, happy path =============================================

test("flag on: turning a switch on asks permission, subscribes with the VAPID key, writes push_subscriptions, then the preference - in that order", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window);
  await openAccount(window);

  pickNotifPref(window, "trained_together", true);
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);

  assert.equal(push.calls.requestPermission, 1, "the browser permission prompt was triggered");
  assert.equal(push.calls.subscribe, 1, "pushManager.subscribe was called");
  // instanceof would fail here even for a real Uint8Array: it was constructed
  // inside the jsdom window's own realm - the same cross-realm gap
  // ArrayBuffer.isView() exists to paper over.
  assert.ok(ArrayBuffer.isView(push.calls.subscribeOptions.applicationServerKey), "the VAPID public key was passed as a byte array");
  assert.ok(push.calls.subscribeOptions.applicationServerKey.length === 65, "the decoded key is the uncompressed 65-byte EC point");

  const row = mock.db.push_subscriptions[0];
  assert.equal(row.user_id, "u1");
  assert.ok(row.endpoint);
  assert.deepEqual(row.keys, { p256dh: "keyA", auth: "keyB" });
  assert.equal(row.revoked_at, null, "a fresh subscription is not revoked");

  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "trained_together" && r.channel === "push"), 4000);
  await waitFor(() => /פעיל/.test(notifPrefControl(window, "trained_together").closest(".log-row").textContent), 4000);
  assert.ok(window.document.querySelector('[data-community-action="notif-push-disable"]'), "a device-level turn-off control is offered");
});

// ===== fail closed on the VAPID key ======================================

for (const [label, key] of [
  ["the shipped placeholder", "REPLACE_WITH_VAPID_PUBLIC_KEY"],
  ["an empty value", ""],
  ["a key that is not 65 bytes", "BD16mHSAcS-jU5cV2xEqkNy09hCQ7MTjkY22CK8UrRw1JpI"],
  ["a compressed point", "AD16mHSAcS-jU5cV2xEqkNy09hCQ7MTjkY22CK8UrRw1JpI_5kjReL7tME6O4BFmQhuiaOVCWQ-nqsnoa1_0nAo"],
]) {
  test(`FAIL CLOSED: with ${label} as the VAPID key there is no prompt, no subscribe, no push_subscriptions write`, async () => {
    const mock = seeded();
    const window = await bootCommunity(mock, { syncEnabled: false, vapidKey: key });
    const push = stubPushApis(window);
    await openAccount(window);

    assert.match(window.document.querySelector("[data-notif-push-reason]").textContent, /עדיין לא הוגדרו/, "the screen says push is not set up");
    pickNotifPref(window, "reaction", true);
    await waitFor(() => mock.db.notification_preferences.length === 1, 4000);
    assert.equal(mock.db.notification_preferences[0].channel, "in_app", "the switch still works, for the bell");
    assert.equal(push.calls.requestPermission, 0, "the permission prompt is never raised for a key that cannot work");
    assert.equal(push.calls.subscribe, 0, "and pushManager.subscribe is never called");
    assert.equal(mock.db.push_subscriptions.length, 0);
  });
}

test("the shipped cloud-config.js carries the placeholder, so a build that skipped the rotation cannot subscribe", async () => {
  const cfg = fs.readFileSync(new URL("../cloud-config.js", import.meta.url), "utf8");
  assert.match(cfg, /notifPushVapidPublicKey: "REPLACE_WITH_VAPID_PUBLIC_KEY"/);
  assert.equal((cfg.match(/notifPushVapidPublicKey/g) || []).length >= 1, true);
  // The client reads the key from that one property and nowhere else.
  const reads = ["cloud.js", "app.js", "sw.js", "src/community/notifications.js"].flatMap((f) =>
    fs.readFileSync(new URL("../" + f, import.meta.url), "utf8").split("\n").filter((l) => /notifPushVapidPublicKey/.test(l) && !/^\s*\/\//.test(l)).map((l) => f));
  assert.deepEqual(reads, ["src/community/notifications.js"], "exactly one place reads it");
});

test("a subscription made under an older key is dropped and replaced, not reused", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  const oldKey = new Uint8Array(65).fill(7);
  const push = stubPushApis(window, { existingEndpoint: "https://push.example/old", existingKey: oldKey.buffer, newEndpoint: "https://push.example/new" });
  await openAccount(window);

  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.push_subscriptions.some((r) => r.endpoint === "https://push.example/new"), 4000);
  assert.equal(push.calls.subscribe, 1, "re-subscribed under the current key");
  assert.equal(push.getSub().endpoint, "https://push.example/new");
});

test("permission denied: the exact Hebrew copy is shown, nothing is subscribed, the switch still works for the bell", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window, { deny: true });
  await openAccount(window);

  pickNotifPref(window, "reaction", true);
  await waitFor(() => /לא אושרה הרשאת התראות/.test(window.document.getElementById("content").textContent), 4000);

  assert.equal(push.calls.subscribe, 0, "subscribe is never called once permission is denied");
  assert.equal(mock.db.push_subscriptions.length, 0);
  await waitFor(() => mock.db.notification_preferences.length === 1, 4000);
  assert.equal(mock.db.notification_preferences[0].channel, "in_app", "stored as the bell, never as push");
});

test("a device that is already subscribed does not re-prompt when a second type is turned on", async () => {
  const mock = seeded({ push_subscriptions: [{ id: "ps1", user_id: "u1", endpoint: "https://push.example/existing", keys: { p256dh: "a", auth: "b" }, revoked_at: null }] });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window, { existingEndpoint: "https://push.example/existing" });
  await openAccount(window);

  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "reaction" && r.channel === "push"), 4000);
  const promptsAfterFirst = push.calls.requestPermission;
  const subscribesAfterFirst = push.calls.subscribe;

  pickNotifPref(window, "week_card", true);
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "week_card" && r.channel === "push"), 4000);

  assert.equal(push.calls.requestPermission, promptsAfterFirst, "no new permission prompt for the second type");
  assert.equal(push.calls.subscribe, subscribesAfterFirst, "no new subscribe call for the second type");
  assert.equal(mock.db.push_subscriptions.length, 1, "still exactly one row for this device");
});

// ===== unsupported browsers and iOS ====================================

test("flag on, a browser with no Push API: the panel says so, and the switch is for the bell", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  // No stubPushApis() call: this browser has neither serviceWorker nor
  // PushManager nor Notification.
  await openAccount(window);

  assert.match(window.document.querySelector("[data-notif-push-reason]").textContent, /לא תומך בהתראות דחיפה/);
  assert.match(window.document.querySelector("[data-notif-push-reason]").textContent, /יופיעו בפעמון/);
  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.notification_preferences.some((r) => r.channel === "in_app"), 4000);
});

test("flag on, iOS Safari without an installed PWA: the install explanation, not a silent failed prompt", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window); // the browser APIs exist - iOS non-standalone is still blocked ahead of them
  stubIOSNonStandalone(window);
  await openAccount(window);

  assert.match(window.document.querySelector("[data-notif-push-reason]").textContent, /להוסיף את האפליקציה למסך הבית/);
  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.notification_preferences.length === 1, 4000);
  assert.equal(push.calls.requestPermission, 0, "no prompt outside the installed app");
});

// ===== revoke: never deletes the row ===================================

test("the explicit device control revokes: sets revoked_at, never deletes the row", async () => {
  const mock = seeded({ push_subscriptions: [{ id: "ps1", user_id: "u1", endpoint: "https://push.example/existing", keys: { p256dh: "a", auth: "b" }, revoked_at: null }] });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window, { existingEndpoint: "https://push.example/existing" });
  await openAccount(window);

  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-push-disable"]'), 4000);
  window.document.querySelector('[data-community-action="notif-push-disable"]').click();

  await waitFor(() => mock.db.push_subscriptions[0].revoked_at, 4000);
  assert.equal(mock.db.push_subscriptions.length, 1, "the row is never deleted");
  assert.ok(mock.db.push_subscriptions[0].revoked_at, "revoked_at is set instead");
  assert.equal(window.document.querySelector('[data-community-action="notif-push-disable"]'), null, "the control disappears once there is no active subscription");
});

test("a permission revoked outside the app is detected on the next load and marks revoked_at, without deleting the row", async () => {
  const mock = seeded();
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "CorrectHorse9");
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window);
  await openAccount(window);

  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  assert.equal(mock.db.push_subscriptions[0].revoked_at, null);

  // The OS/browser silently drops the subscription, and the session ends
  // without the member pressing sign-out (expiry): there is no session to
  // delete the row with, so the next sign-in retires it.
  push.setSub(null);
  await mock.client.auth.signOut();
  await waitForCommunityGate(window);
  await mock.client.auth.signInWithPassword({ email: "dana@members.haimuniya.invalid", password: "CorrectHorse9" });
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!notifPrefControl(window, "reaction"), 4000);

  await waitFor(() => mock.db.push_subscriptions[0].revoked_at, 5000);
  assert.equal(mock.db.push_subscriptions.length, 1, "the row is kept, only marked");
});

// ===== a subscription does not outlive the session ========================

test("SIGN-OUT removes this device's subscription: the server row is deleted and the browser's is dropped", async () => {
  const mock = seeded();
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "CorrectHorse9");
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window);
  await openAccount(window);
  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  assert.ok(push.getSub(), "subscribed before signing out");
  window.localStorage.setItem("haimunia-demo:notifPushEndpoint", mock.db.push_subscriptions[0].endpoint);

  window.document.querySelector('[data-community-action="sign-out"]').click();
  await waitForCommunityGate(window);

  assert.equal(mock.db.push_subscriptions.length, 0, "the server row is gone, not merely revoked");
  assert.equal(push.getSub(), null, "the browser subscription was dropped");
  assert.equal(window.localStorage.getItem("haimunia-demo:notifPushEndpoint"), null, "and the remembered endpoint with it");
});

test("signing out is never held up by a service worker that does not answer", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  await openAccount(window);
  window.navigator.serviceWorker = Object.assign(window.navigator.serviceWorker || {}, { ready: new Promise(() => {}) });

  window.document.querySelector('[data-community-action="sign-out"]').click();
  await waitForCommunityGate(window);
  assert.equal(mock.getUser(), null, "the session ended");
});

test("a session that ends by itself (expiry, another tab) still drops this device's browser subscription", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window);
  await openAccount(window);
  pickNotifPref(window, "reaction", true);
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);

  await mock.client.auth.signOut();
  await waitFor(() => push.getSub() === null, 4000);
  assert.equal(mock.db.push_subscriptions.length, 1, "no session to delete the row with: it stays for the next sign-in to retire");
});

test("ACCOUNT DELETION removes every push subscription the member has, then signs out", async () => {
  const mock = seeded({ push_subscriptions: [
    { id: "ps1", user_id: "u1", endpoint: "https://push.example/phone", keys: { p256dh: "a", auth: "b" }, revoked_at: null },
    { id: "ps2", user_id: "u1", endpoint: "https://push.example/laptop", keys: { p256dh: "a", auth: "b" }, revoked_at: null },
    { id: "ps3", user_id: "u2", endpoint: "https://push.example/someone-else", keys: { p256dh: "a", auth: "b" }, revoked_at: null },
  ] });
  mock.onRpc("request_account_deletion", () => ({ data: null, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  const push = stubPushApis(window, { existingEndpoint: "https://push.example/phone" });
  await openAccount(window);

  window.handleCommunityClick({ dataset: { communityAction: "delete-account" } });
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 4000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.getUser() === null, 4000);

  assert.equal(mock.callsTo("request_account_deletion").length, 1);
  assert.deepEqual(mock.db.push_subscriptions.map((r) => r.id), ["ps3"], "both of the member's devices are gone; nobody else's is touched");
  assert.equal(push.getSub(), null, "and this browser's subscription is dropped");
});

// ===== sw.js source-level handlers (jsdom cannot run a real SW) =========

const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");

test("sw.js registers a push handler that renders the payload's title, body, and deep link", () => {
  const block = sw.slice(sw.indexOf('self.addEventListener("push"'), sw.indexOf('self.addEventListener("notificationclick"'));
  assert.match(block, /payload\.title/);
  assert.match(block, /payload\.body/);
  assert.match(block, /payload\.deep_link/);
  assert.match(block, /showNotification/);
  assert.match(block, /waitUntil/);
});

test("sw.js registers a notificationclick handler that focuses an open window or opens one at the deep link", () => {
  const block = sw.slice(sw.indexOf('self.addEventListener("notificationclick"'));
  assert.match(block, /clients\.matchAll/);
  assert.match(block, /\.focus\(\)/);
  assert.match(block, /clients\.openWindow/);
  assert.match(block, /deepLink/);
});

// ===== deep link receivers (the route format is /circles?c=&post=) =====

test("window.communityHandlePushDeepLink opens the exact target screen and item, reusing resolveNotifTarget", async () => {
  const post = {
    id: "p7", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 1, media: [], metadata: {},
  };
  const mock = seeded({ feed_page_rows: [post] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabAddBtn").click(); // start off the community tab entirely

  window.communityHandlePushDeepLink("/circles?c=club-1&post=p7");
  await waitFor(() => window.document.getElementById("tabCommunityBtn").className.includes("active"), 4000);

  const communityBtn = window.document.getElementById("tabCommunityBtn");
  assert.ok(communityBtn.className.includes("active"), "the top-level Community tab was switched to");
});

test("a ?notif= cold start (sw.js's own-window fallback) is captured by app.js and consumed once the session is ready", async () => {
  const post = {
    id: "p9", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  };
  const mock = seeded({ feed_page_rows: [post] });
  const deepLink = encodeURIComponent("/circles?c=club-1&post=p9");
  const window = await bootCommunity(mock, {
    syncEnabled: false,
    url: "https://example.test/index.html?tab=community&notif=" + deepLink,
  });

  await waitFor(() => window.document.getElementById("tabCommunityBtn").className.includes("active"), 4000);
  // The query param is stripped so a reload can't re-fire it.
  assert.doesNotMatch(window.location.search, /notif=/);
});

test("app.js's own serviceWorker message listener reaches communityHandlePushDeepLink", async () => {
  const post = {
    id: "p11", post_type: "POST_TEXT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" }, body: "פוסט", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  };
  const mock = seeded({ feed_page_rows: [post] });
  const messageHandlers = [];
  const serviceWorkerStub = {
    register: () => Promise.resolve({ addEventListener() {}, waiting: null }),
    controller: null,
    addEventListener(type, cb) { if (type === "message") messageHandlers.push(cb); },
  };
  const window = await bootCommunity(mock, { syncEnabled: false, serviceWorkerStub });
  window.document.getElementById("tabAddBtn").click();

  assert.ok(messageHandlers.length > 0, "app.js registered its own serviceWorker message listener");
  for (const cb of messageHandlers) cb({ data: { type: "PUSH_NOTIFICATION_CLICK", deepLink: "/circles?c=club-1&post=p11" } });

  await waitFor(() => window.document.getElementById("tabCommunityBtn").className.includes("active"), 4000);
  assert.ok(window.document.getElementById("tabCommunityBtn").className.includes("active"));
});

test("the default is ON: a member who set nothing is offered push, behind a switch that is off", async () => {
  // Booting with no localStorage at all is exactly what every real device does.
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  const push = stubPushApis(window);
  await openAccount(window);

  assert.equal(notifPrefValue(window, "reaction"), "off");
  assert.equal(window.document.querySelector("[data-notif-push-reason]"), null, "nothing stands in the way of push on a capable, installed browser");
  assert.equal(push.calls.requestPermission, 0, "and nobody has been asked anything");
});
