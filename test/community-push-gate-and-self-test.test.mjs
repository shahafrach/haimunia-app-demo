// The notification-permission gate, push_permission, the iOS install line,
// and the account-settings push self-test.
//
// WHAT THIS FILE VERIFIES
// - The prompt is NEVER reached on first load, outside the installed app, or
//   before the member has logged a workout or joined the community. All three
//   conditions, each on its own, and each with a visible Hebrew reason rather
//   than a control that silently does nothing.
// - push_permission records the browser's own answer, including the DENIAL
//   push_opt_in structurally cannot see, and the `default` bucket read off
//   the Account tab without asking anybody anything.
// - app_opened carries display_mode and platform, once per page load, and
//   never the user agent string.
// - The iOS install banner carries the notifications line, and the
//   Chrome/Android banner does not.
// - The self-test asks the SERVICE WORKER to show the notification, the
//   worker's receipt comes back through app.js's existing message listener,
//   and the row is written by the page through analyticsTrack - not by the
//   worker, which has no Supabase client.
// - "Not received" is a real settled answer with its own row, not a spinner.
//
// WHAT THIS FILE DOES NOT VERIFY
// The push SERVER (notif_push_pending and the Edge Function behind it,
// 202609170002). The self-test deliberately does not exercise it, and neither
// does this file; those live in supabase/tests.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, notifPrefControl, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const PUSH_ON = { "haimunia-demo:notifPushFlag": "1" };

function seeded(opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    analytics_events: [],
    notifications: [], notification_preferences: [], push_subscriptions: [],
    follows: [], hidden_posts: [], saved_posts: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

const events = (mock, name) => mock.db.analytics_events.filter((r) => r.event_name === name);
const plain = (v) => JSON.parse(JSON.stringify(v));

// The Push API, plus the two facts the gate reads. `standalone` and
// `logged` are separate switches on purpose: each is one of the gate's three
// conditions and the tests below turn exactly one off at a time.
function stubPush(window, opts = {}) {
  const calls = { requestPermission: 0, subscribe: 0 };
  let sub = null;
  const reg = {
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async () => {
        calls.subscribe++;
        sub = {
          endpoint: "https://push.example/ep-1", keys: { p256dh: "keyA", auth: "keyB" },
          toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
          unsubscribe: async () => { sub = null; return true; },
        };
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
  Object.defineProperty(window.navigator, "standalone", { value: opts.standalone !== false, configurable: true });
  // The training log's own count, which app.js exports for exactly this gate.
  // A member with a community profile is already "earned" by the other half
  // of the rule, so the test that exercises the not-earned branch boots
  // SIGNED OUT rather than trying to take a profile away.
  window.haimuniaTotalLoggedEntries = () => (opts.logged === undefined ? 1 : opts.logged);
  return calls;
}

async function openAccount(window) {
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!notifPrefControl(window, "trained_together"), 4000);
}

// The push CHOICE, since the preference rows became one <select> each -
// picking it is what used to be a click on the push button. Both halves of
// the old control are still reachable: the option's existence (it is omitted
// entirely while the module flag is off) and choosing it.
const choosePush = (window, type = "trained_together") => pickNotifPref(window, type, true);

// ===== the gate =======================================================

test("nothing asks for notification permission on first load - the only callers are click handlers", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  const calls = stubPush(window);
  await openAccount(window);
  // A full render of the tab the push controls live on, with the API stubbed
  // and every gate condition satisfied. The prompt is still untouched,
  // because no code path asks without a press.
  assert.equal(calls.requestPermission, 0, "boot and render must never reach requestPermission()");
  assert.equal(mock.db.push_subscriptions.length, 0);

  // And the source says so: the ONLY call to requestPermission in the
  // community layer sits behind pushAskGateReason, which refuses without
  // userAction. A future caller that forgets fails here.
  const src = fs.readFileSync(new URL("../src/community/notifications.js", import.meta.url), "utf8");
  const asks = src.split("Notification.requestPermission").length - 1;
  assert.equal(asks, 2, "exactly two call sites: enableNotifPush and runPushSelfTest");
  // Those two, plus setNotifPref, which asks the gate only to decide whether
  // to TRY to subscribe (a switch tap is a user action) and otherwise says why
  // the switch will be for the bell.
  assert.equal(src.split("pushAskGateReason({ userAction: true })").length - 1, 3,
    "each is gated, and each states the user action rather than implying it");
});

test("outside the installed app the prompt is refused, with a visible reason instead of a dead control", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  const calls = stubPush(window, { standalone: false });
  await openAccount(window);

  choosePush(window);
  await waitFor(() => window.document.body.textContent.includes("להוסיף את האפליקציה למסך הבית"), 4000);
  assert.equal(calls.requestPermission, 0, "the one prompt a browser ever gives is not spent in a tab");
  assert.equal(mock.db.push_subscriptions.length, 0);
  await waitFor(() => mock.db.notification_preferences.length === 1, 4000);
  assert.equal(mock.db.notification_preferences[0].channel, "in_app", "the switch is for the bell, never stored as push");
});

test("before the first logged workout and before joining the community, the app does not ask", async () => {
  // Signed OUT, which is the only state in which neither half of "earned" is
  // true: a member looking at the push controls has a community profile by
  // construction, so the workout half is what covers everybody else - the
  // training log is the whole app for a member who never joined the club.
  const mock = createMockSupabase({ profiles: [], clubs: [{ id: "club-1", name: "מעגל הדגמה" }], analytics_events: [] });
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  stubPush(window, { logged: 0 });

  assert.match(window.pushAskGateReason({ userAction: true }), /אחרי האימון הראשון/,
    "an empty log and no club membership is not a relationship worth interrupting");

  // One logged workout is enough. Nothing else about the member changed.
  window.haimuniaTotalLoggedEntries = () => 1;
  assert.equal(window.pushAskGateReason({ userAction: true }), null);

  // And the first condition still stands over both: no press, no ask, ever.
  window.haimuniaTotalLoggedEntries = () => 50;
  assert.match(window.pushAskGateReason({}), /רק מתוך פעולה באפליקציה/);
  assert.match(window.pushAskGateReason({ userAction: "yes" }), /רק מתוך פעולה באפליקציה/,
    "a truthy value is not the flag - the gate takes exactly true");
});

test("a member who has joined the community is earned even with an empty training log", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  const calls = stubPush(window, { logged: 0 });
  await openAccount(window);

  choosePush(window);
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  assert.equal(calls.requestPermission, 1, "asked exactly once, from the press");
});

// ===== push_permission ================================================

test("push_permission records the default bucket from the Account tab without asking anybody anything", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  const calls = stubPush(window);
  await openAccount(window);

  await waitFor(() => events(mock, "push_permission").length >= 1, 4000);
  const props = plain(events(mock, "push_permission")[0].props);
  assert.deepStrictEqual(props, { status: "default", source: "account_tab", display_mode: "standalone" });
  assert.equal(calls.requestPermission, 0, "reading the permission is not asking for it");
});

test("a denial is recorded - the one answer push_opt_in structurally cannot see", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  stubPush(window, { deny: true });
  await openAccount(window);
  // The permission the browser reports does not move in this stub, so the
  // prompt row is what carries the answer.
  window.Notification.requestPermission = async () => { window.Notification.permission = "denied"; return "denied"; };

  choosePush(window);
  await waitFor(() => events(mock, "push_permission").some((r) => r.props.source === "prompt"), 4000);

  const prompt = plain(events(mock, "push_permission").find((r) => r.props.source === "prompt").props);
  assert.deepStrictEqual(prompt, { status: "denied", source: "prompt", display_mode: "standalone" });
  assert.equal(events(mock, "push_opt_in").length, 0, "no subscription, so no opt-in - which is the gap this name closes");
  assert.equal(mock.db.push_subscriptions.length, 0);
});

test("a grant is recorded once per distinct status, so a re-render of the panel writes nothing further", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON });
  stubPush(window);
  await openAccount(window);
  window.Notification.requestPermission = async () => { window.Notification.permission = "granted"; return "granted"; };

  choosePush(window);
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  await waitFor(() => events(mock, "push_permission").some((r) => r.props.status === "granted"), 4000);

  const before = events(mock, "push_permission").length;
  // A second type routed through the same device re-renders the whole panel
  // and does not re-prompt; it must not re-record either.
  choosePush(window, "reaction");
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "reaction" && r.channel === "push"), 4000);
  assert.equal(events(mock, "push_permission").length, before, "same status, same source, no second row");
});

// ===== app_opened =====================================================

test("app_opened carries display_mode and platform, once per page load, and never the user agent", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => events(mock, "app_opened").length === 1, 4000);

  const props = plain(events(mock, "app_opened")[0].props);
  assert.deepStrictEqual(Object.keys(props).sort(), ["display_mode", "platform"]);
  assert.ok(["standalone", "browser"].includes(props.display_mode));
  assert.ok(["ios", "android", "other"].includes(props.platform));
  assert.ok(!JSON.stringify(props).includes("Mozilla"), "a user agent string is a fingerprint, not a prop");

  // Opening the Community tab and moving around does not write a second one:
  // this is a session, not a navigation.
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!notifPrefControl(window, "trained_together"), 4000);
  assert.equal(events(mock, "app_opened").length, 1);
});

test("display_mode and platform are coarse enums that answer for every device", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => events(mock, "app_opened").length === 1, 4000);

  for (const [standalone, expected] of [[true, "standalone"], [false, "browser"]]) {
    Object.defineProperty(window.navigator, "standalone", { value: standalone, configurable: true });
    assert.equal(window.communityDisplayMode(), expected);
  }
  const uas = {
    ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
    other: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
  };
  for (const [expected, ua] of Object.entries(uas)) {
    Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    assert.equal(window.communityPlatformBucket(), expected);
  }
});

test("app_opened is not a WCAM event - opening the app is not participating in the club", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => events(mock, "app_opened").length === 1, 4000);
  const a = window.HaimuniaAnalytics;
  for (const name of ["app_opened", "push_permission", "push_self_test"]) {
    assert.equal(a.isActiveMemberEvent(name), false, `${name} must not make a member active for the week`);
  }
});

// ===== the iOS install line ===========================================

test("the iOS install hint says notifications need the installed app, and the Chrome banner does not", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ios = html.slice(html.indexOf('id="iosInstallBanner"'));
  const iosCard = ios.slice(0, ios.indexOf("</div>\n  </div>"));
  assert.match(iosCard, /התראות עובדות רק מהאפליקציה המותקנת/, "the one line, on the iOS banner");

  const chrome = html.slice(html.indexOf('id="installBanner"'));
  const chromeCard = chrome.slice(0, chrome.indexOf('id="iosInstallBanner"'));
  assert.doesNotMatch(chromeCard, /התראות עובדות רק מהאפליקציה המותקנת/,
    "false on Chrome/Android, where a browser tab can receive push perfectly well");

  // Built from tokens already used by the two lines above it, so it themes
  // itself and needs no rule in either dark block (CLAUDE.md).
  assert.match(iosCard, /color:var\(--color-text-muted\); margin-bottom:12px;">גם התראות/);
});

test("the iOS banner renders that line to a member on iOS Safari, and never in the installed app", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15", configurable: true,
  });
  Object.defineProperty(window.navigator, "standalone", { value: false, configurable: true });

  const banner = window.document.getElementById("iosInstallBanner");
  assert.match(banner.textContent, /התראות עובדות רק מהאפליקציה המותקנת/);
  // maybeShowIOSInstallBanner is the only thing that ever shows it, and it
  // returns for a standalone window - so the line cannot reach a member for
  // whom it would be false.
  Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  banner.style.display = "none";
  window.eval("maybeShowIOSInstallBanner()");
  assert.equal(banner.style.display, "none", "never shown inside the installed app");
});

// ===== the self-test ==================================================

// A service worker stand-in with both halves the self-test needs: an active
// worker to post TO, and navigator.serviceWorker's own message listener to
// post BACK through - the same listener app.js has used for
// PUSH_NOTIFICATION_CLICK since COMM-229.
function swHarness() {
  const posted = [];
  const messageHandlers = [];
  const reg = {
    active: { postMessage: (m) => posted.push(m) },
    addEventListener() {},
    waiting: null,
    pushManager: { getSubscription: async () => null, subscribe: async () => null },
  };
  const stub = {
    register: () => Promise.resolve(reg),
    ready: Promise.resolve(reg),
    controller: reg.active,
    addEventListener(type, cb) { if (type === "message") messageHandlers.push(cb); },
  };
  return {
    stub, posted,
    // What sw.js does once showNotification() resolves.
    reportReceipt: (id) => messageHandlers.forEach((cb) => cb({ data: { type: "PUSH_SELF_TEST_RECEIVED", id } })),
  };
}

async function startSelfTest(window) {
  const btn = window.document.querySelector('[data-community-action="notif-push-self-test"]');
  assert.ok(btn, "the self-test control renders in account settings while push is on");
  btn.click();
}

test("the self-test asks the service worker to show the notification, and the worker's receipt writes the row through the page", async () => {
  const mock = seeded();
  const sw = swHarness();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON, serviceWorkerStub: sw.stub });
  stubPush(window, { permission: "granted" });
  // stubPush replaces navigator.serviceWorker wholesale; put the harness's
  // active worker and ready promise back, since the self-test needs both.
  window.navigator.serviceWorker.ready = Promise.resolve(sw.stub.ready ? await sw.stub.ready : null);
  await openAccount(window);

  await startSelfTest(window);
  await waitFor(() => sw.posted.some((m) => m.type === "PUSH_SELF_TEST"), 4000);
  const sent = sw.posted.find((m) => m.type === "PUSH_SELF_TEST");
  assert.ok(sent.id, "a token travels out so a stale receipt cannot resolve a later run");
  assert.equal(events(mock, "push_self_test").length, 0, "nothing is recorded before the worker answers");
  await waitFor(() => /ממתינים להתראה/.test(window.document.body.textContent), 4000);

  sw.reportReceipt(sent.id);
  await waitFor(() => events(mock, "push_self_test").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "push_self_test")[0].props), { result: "received" });
  await waitFor(() => /התראה התקבלה במכשיר הזה/.test(window.document.body.textContent), 4000);
});

test("a receipt carrying somebody else's token resolves nothing", async () => {
  const mock = seeded();
  const sw = swHarness();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON, serviceWorkerStub: sw.stub });
  stubPush(window, { permission: "granted" });
  window.navigator.serviceWorker.ready = Promise.resolve(await sw.stub.ready);
  await openAccount(window);

  await startSelfTest(window);
  await waitFor(() => sw.posted.some((m) => m.type === "PUSH_SELF_TEST"), 4000);

  sw.reportReceipt("st-from-an-abandoned-run");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events(mock, "push_self_test").length, 0);
  assert.match(window.document.body.textContent, /ממתינים להתראה/, "still waiting, as it should be");
});

test("nothing arriving is a settled answer with its own row, not a spinner", async () => {
  const mock = seeded();
  const sw = swHarness();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON, serviceWorkerStub: sw.stub });
  stubPush(window, { permission: "granted" });
  window.navigator.serviceWorker.ready = Promise.resolve(await sw.stub.ready);
  await openAccount(window);

  await startSelfTest(window);
  await waitFor(() => sw.posted.some((m) => m.type === "PUSH_SELF_TEST"), 4000);
  // The worker never answers. The page's own eight-second timeout does.
  await waitFor(() => events(mock, "push_self_test").length === 1, 14000);
  assert.deepStrictEqual(plain(events(mock, "push_self_test")[0].props), { result: "not_received" });
  assert.match(window.document.body.textContent, /לא התקבלה התראה/);
  assert.match(window.document.body.textContent, /בהגדרות המכשיר/, "and what to check next");
});

test("the self-test refuses outside the installed app rather than spending the one prompt", async () => {
  const mock = seeded();
  const sw = swHarness();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: PUSH_ON, serviceWorkerStub: sw.stub });
  const calls = stubPush(window, { standalone: false });
  window.navigator.serviceWorker.ready = Promise.resolve(await sw.stub.ready);
  await openAccount(window);

  await startSelfTest(window);
  await waitFor(() => window.document.body.textContent.includes("להוסיף את האפליקציה למסך הבית"), 4000);
  assert.equal(calls.requestPermission, 0);
  assert.equal(sw.posted.filter((m) => m.type === "PUSH_SELF_TEST").length, 0, "no notification is attempted either");
});

// ===== sw.js's half, source-level (jsdom cannot run a real worker) ======

test("sw.js shows the test notification from its own registration and reports the receipt back", () => {
  const src = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf('e.data.type === "PUSH_SELF_TEST"'));
  assert.match(handler, /self\.registration\.showNotification\(/,
    "drawn by the worker, which is the surface every real push uses");
  assert.match(handler, /tag: "haimunia-push-self-test"/, "a second tap replaces rather than stacks");
  assert.match(handler, /postMessage\(\{ type: "PUSH_SELF_TEST_RECEIVED", id: id \}\)/,
    "the token is echoed unchanged");
  // The worker must not try to write the row itself: it has no Supabase
  // client, and pulling cloud-config.js into the worker scope would drag the
  // project keys along with it.
  // Code lines only: sw.js's push handler discusses importScripts() at length
  // in a comment explaining why it does NOT do it, which is the argument this
  // assertion exists to keep true.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /createClient|rest\/v1|supabasePublishableKey/i,
    "the insert stays on the page, where the session is - the worker has no client");
  assert.doesNotMatch(code, /importScripts\s*\(/, "and the config, keys and all, stays out of the worker");
});

test("app.js routes the worker's receipt to the community handler, beside the deep-link one it already routed", () => {
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(src, /PUSH_SELF_TEST_RECEIVED[\s\S]{0,200}communityHandlePushSelfTestReceipt/);
  assert.match(src, /window\.haimuniaTotalLoggedEntries = totalLoggedEntries;/,
    "the gate's 'earned' condition reads the training log through app.js's own export");
});
