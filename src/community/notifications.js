"use strict";
// ---- Community: notifications (COMM-140..144, COMM-229) -------------------
//
// The notification centre, the per-type preference matrix, web push, and the
// deep links that turn a notification into the surface it is about. The
// client renders and marks read; every row is created server-side by a
// trigger or an event-bus consumer, and the table has no insert grant.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// WHAT STAYED BEHIND, deliberately: the Realtime subscription block
// (realtimeDebounce, ensureNotifRealtime, ensureFeedRealtime,
// ensureChallengeRealtime and their handlers). It is one debounce and one
// channel-lifecycle rule serving notifications, feed and challenges alike —
// platform, not a feature — so it stays in cloud.js with the rest of the
// core rather than being copied into three modules.
//
// communityIsIOSDevice() comes with it. app.js has its own near-copy under
// the name isIOSDevice, differing by a String() coercion; the two are named
// apart rather than merged, so the drift is visible instead of being settled
// by whichever script happens to load last.

  // The notification bell and its unread badge, mounted on the Community
  // screen's header.
  const BELL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z"/><path d="M10.4 19a2 2 0 0 0 3.2 0"/></svg>';
  function renderNotificationBell() {
    const unread = state.notif.unreadLoaded ? (Number(state.notif.unread) || 0) : 0;
    return `<button class="chip-btn" data-community-action="feed-notifications" aria-label="התראות${unread ? (unread === 1 ? ", התראה אחת חדשה" : `, ${unread} חדשות`) : ""}" aria-haspopup="dialog" style="position:relative;">${BELL_ICON}${unread ? `<span class="tab-badge" aria-hidden="true">${unread}</span>` : ""}</button>`;
  }

  // ==== notifications ===================================================
  //
  // The client renders and marks read. Every notification row is created
  // server-side by a trigger or the hourly week-card job (the table has no
  // insert grant). Four types exist, every one OFF until the member turns it
  // on in Me, and every one belongs to exactly one circle:
  //   reaction          someone reacted to my post (at most one per post per hour)
  //   trained_together a tag is waiting for my confirmation
  //   circle_joined     someone joined a circle I own
  //   week_card         the week card of one of my circles is ready
  // A toggle on means "tell me": by web push when this device can and the
  // member allows it, otherwise in the bell. Nothing here prompts anybody: the
  // browser permission request happens when a member turns a toggle on, which
  // is the only time it should - a prompt fired on load is denied by reflex.
  //
  // featureFlags.notifPush is a per-device escape hatch (default on): set
  // haimunia-demo:notifPushFlag to "0" to turn push off on one device.
  function notifPushEnabled() {
    return !!(state.featureFlags && state.featureFlags.notifPush);
  }
  const NOTIF_PAGE_SIZE = 20;
  // COMM-141. Rows older than this are not walked by default.
  const NOTIF_RECENT_DAYS = 90;

  // One category: everything is about a circle.
  const NOTIF_CATEGORIES = [
    { id: "community", label: "מעגלים" },
  ];

  // Every notification type the client renders. `pref` is the
  // notification_preferences key its delivery is gated on (the type itself).
  // `icon` and `title` are the client copy; the server fills `body` and
  // `deep_link`.
  const NOTIF_TYPES = {
    reaction:         { category: "community", pref: "reaction",         icon: "🔥", title: "עידוד חדש על הפוסט שלך" },
    trained_together: { category: "community", pref: "trained_together", icon: "🤝", title: "תיוג לאימון משותף מחכה לאישור שלך" },
    circle_joined:    { category: "community", pref: "circle_joined",    icon: "👋", title: "חבר/ה חדש/ה במעגל" },
    week_card:        { category: "community", pref: "week_card",        icon: "📅", title: "כרטיס השבוע מוכן" },
  };
  function notifTypeDef(type) { return NOTIF_TYPES[type] || null; }

  // The toggles in Me, in this order. Every one is OFF until the member turns
  // it on: a missing row means off, here and on the server (notif_pref_allows).
  const NOTIF_PREF_TYPES = [
    { key: "reaction",         label: "עידוד על פוסט שלי" },
    { key: "trained_together", label: "תיוג לאימון משותף שמחכה לאישור שלי" },
    { key: "circle_joined",    label: "מישהו הצטרף למעגל שלי" },
    { key: "week_card",        label: "כרטיס השבוע מוכן (מוצאי שבת)" },
  ];
  const NOTIF_PREF_KEYS = new Set(NOTIF_PREF_TYPES.map((t) => t.key));
  const NOTIF_CHANNELS = ["push", "in_app", "off"];

  // The one place that says how a type is delivered given the member's stored
  // preferences. Opt-in: no stored row, or an unknown channel, is off. Returns
  // { channel, suppressed }.
  function notifRoute(type, prefs) {
    const def = NOTIF_TYPES[type];
    if (!def) return { channel: "off", suppressed: true };
    let channel = (prefs && prefs[def.pref]) || "off";
    if (NOTIF_CHANNELS.indexOf(channel) < 0) channel = "off";
    if (channel === "push" && !notifPushEnabled()) channel = "in_app";
    return { channel: channel, suppressed: channel === "off" };
  }

  function notifCutoffIso() {
    return new Date(Date.now() - NOTIF_RECENT_DAYS * 86400000).toISOString();
  }

  // --- COMM-141 unread badge -------------------------------------------
  async function loadNotifUnread() {
    if (!state.user || !client) return;
    const { data, error } = await client.rpc("notif_unread_count");
    if (!error) { state.notif.unread = Number(data) || 0; state.notif.unreadLoaded = true; rerender(); }
  }

  // --- COMM-144 per-type preferences (direct own-row RLS upsert) -------
  async function loadNotifPrefs() {
    if (!state.user || !client) return;
    const { data, error } = await client.from("notification_preferences")
      .select("type,channel").eq("user_id", state.user.id);
    const next = {};
    if (!error && Array.isArray(data)) for (const r of data) next[r.type] = r.channel;
    state.notif.prefs = next;
    state.notif.prefsLoaded = !error;
    rerender();
  }
  // --- COMM-229 web push (behind state.featureFlags.notifPush) ---------
  //
  // A browser has exactly one PushSubscription per device, shared by every
  // notification type - the per-type preference above only decides
  // whether that type routes through it (notifRoute). This block is what
  // actually asks for permission, registers the subscription with the
  // browser's push service, and writes {endpoint, keys} to
  // push_subscriptions (own-row RLS, table already shipped in
  // 202608280008 - no schema change). Actually sending a push from the
  // server is explicitly out of scope; see notif_push_send in
  // contracts.md.
  const NOTIF_PUSH_ENDPOINT_KEY = "haimunia-demo:notifPushEndpoint";

  // iOS Safari does not implement the Push API unless the app is installed
  // to the home screen (Safari 16.4+ once installed is accepted product
  // scope, per the 2026-08-30 decision - a plain browser tab is not).
  function communityIsIOSDevice() {
    const ua = String(navigator.userAgent || "");
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isStandalonePwa() {
    return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches));
  }
  // "standalone" or "browser", the two values app_opened's display_mode prop
  // takes. Built on isStandalonePwa() above rather than on a second
  // matchMedia call: there are already two detectors for this fact in the
  // repository (this one and app.js's own isStandalone(), which app.js's
  // install banners need and which cannot read this scope), and a third would
  // be exactly the sibling drift CLAUDE.md names. Both existing ones test the
  // same two signals in the opposite order and agree on every input.
  function communityDisplayMode() { return isStandalonePwa() ? "standalone" : "browser"; }
  // A coarse bucket, never the user agent string. "ios" is the only value
  // with a behaviour attached to it (Safari withholds the Push API outside an
  // installed app), "android" is the other half of the phone club, and
  // everything else - desktop, a tablet that lies, a browser nobody has heard
  // of - is "other". Built on communityIsIOSDevice() for the same
  // no-third-detector reason as above. A full UA string in analytics_events
  // would be a fingerprint in a table whose read grant is a permission, not a
  // role; it is carried, deliberately and only, on a support report the
  // member chose to send.
  function communityPlatformBucket() {
    if (communityIsIOSDevice()) return "ios";
    return /Android/i.test(String(navigator.userAgent || "")) ? "android" : "other";
  }

  // ---- WHEN THE APP MAY ASK FOR NOTIFICATION PERMISSION ------------------
  //
  // A browser gives a site ONE chance at this prompt. Deny it and the answer
  // is sticky - there is no API to ask again, and on most engines the member
  // has to find the permission in browser settings to undo it. So the prompt
  // is not a thing to show early and hope; it is a thing to spend once, on
  // somebody who already has a reason to say yes.
  //
  // Three conditions, and all three must hold:
  //
  //   1. A USER ACTION, always. Every caller passes userAction and this
  //      refuses without it, so no boot path, no render, no realtime event
  //      and no retry can reach requestPermission(). NEVER ON FIRST LOAD is
  //      not a timer - it is the absence of any code path that asks without
  //      somebody having pressed something.
  //   2. INSIDE THE INSTALLED APP. On iOS this is a hard platform rule (no
  //      Push API in a plain Safari tab at all), and everywhere else it is a
  //      product one: a notification is a promise to interrupt someone later,
  //      and a browser tab is not where this app keeps that promise. The iOS
  //      install banner says so in its own line now, rather than leaving a
  //      member to discover it from a control that does nothing.
  //   3. EARNED. The member has logged at least one workout, or has joined
  //      the club's community. Before either, "may we send you notifications"
  //      is a question about a relationship that does not exist yet.
  function pushAskEarned() {
    // Joined the community: a profile row is the thing redemption creates.
    if (state.user && state.profile) return true;
    // Or logged a workout. app.js owns the training log and exports the
    // count; a build where cloud.js loaded and app.js somehow did not is not
    // a reason to ask, so a missing function reads as "not earned".
    try {
      if (typeof window.haimuniaTotalLoggedEntries === "function") return window.haimuniaTotalLoggedEntries() > 0;
    } catch (e) { /* fall through */ }
    return false;
  }
  // null when the app may ask right now; a Hebrew sentence saying why not
  // otherwise, so a member who taps and gets nothing is told the reason
  // instead of meeting a dead control.
  function pushAskGateReason(opts) {
    if (!opts || opts.userAction !== true) return "אפשר להפעיל התראות רק מתוך פעולה באפליקציה.";
    if (!isStandalonePwa()) return "כדי לקבל התראות יש להוסיף את האפליקציה למסך הבית ולפתוח אותה משם.";
    if (!pushAskEarned()) return "נבקש הרשאת התראות אחרי האימון הראשון שתרשמו, או אחרי ההצטרפות למעגל.";
    return null;
  }
  // push_permission. The browser's own answer, recorded as it stands.
  //
  // It is NOT the same measurement as push_opt_in, which fires only after a
  // push_subscriptions row is written: a member who was asked and said no
  // writes no subscription, so until this name existed a denial produced no
  // row anywhere and "how many people did we ask, and what did they say" was
  // unanswerable. status is the browser's own three-value enum, unmapped.
  //
  // display_mode rides along because the answer is not comparable across the
  // two: a denial in a browser tab and a denial in the installed app are
  // different events with the same word on them.
  let pushPermissionLogged = "";
  function currentPushPermission() {
    try {
      if (typeof Notification === "undefined") return null;
      const p = Notification.permission;
      return (p === "granted" || p === "denied" || p === "default") ? p : null;
    } catch (e) { return null; }
  }
  // Records at most one row per distinct status per page load. The status is
  // the key rather than a plain boolean, so the transition a prompt produces
  // (default -> granted) is two rows and a re-render of the same screen is
  // still none.
  function notePushPermission(source) {
    const status = currentPushPermission();
    if (!status) return;
    const key = status + "|" + String(source || "");
    if (pushPermissionLogged === key) return;
    pushPermissionLogged = key;
    track(A.PUSH_PERMISSION, { status: status, source: source || "unknown", display_mode: communityDisplayMode() });
  }

  // null when push can be offered in this browser context right now; a
  // Hebrew explanation otherwise, rendered as visible text under the Push
  // option (not just a title attribute) so a member on an unsupported
  // browser sees why, rather than a control that silently does nothing.
  function notifPushBrowserUnsupportedReason() {
    if (communityIsIOSDevice() && !isStandalonePwa()) {
      return "כדי לקבל התראות דחיפה ב-iPhone/iPad יש קודם להוסיף את האפליקציה למסך הבית ולפתוח אותה משם.";
    }
    const hasApi = ("serviceWorker" in navigator) && (typeof window.PushManager !== "undefined") && (typeof Notification !== "undefined");
    if (!hasApi) return "הדפדפן הזה לא תומך בהתראות דחיפה.";
    return null;
  }
  // THE VAPID PUBLIC KEY, READ FROM ONE PLACE (cloud-config.js) AND CHECKED
  // BEFORE ANYTHING USES IT. It is a placeholder until the rotate-vapid
  // workflow has run and its public key has been pasted in; a placeholder, an
  // empty value or anything that is not a 65-byte uncompressed P-256 point
  // reads as "" and push FAILS CLOSED: no permission prompt, no subscribe
  // attempt, and a visible reason.
  const VAPID_PLACEHOLDER = "REPLACE_WITH_VAPID_PUBLIC_KEY";
  const VAPID_NOT_SET_TEXT = "התראות דחיפה עדיין לא הוגדרו באפליקציה.";
  function vapidPublicKey() {
    const raw = window.HAIMUNIA_CONFIG && window.HAIMUNIA_CONFIG.notifPushVapidPublicKey;
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || key === VAPID_PLACEHOLDER || !/^[A-Za-z0-9_-]{87}$/.test(key)) return "";
    try {
      const bytes = vapidKeyToUint8Array(key);
      return (bytes.length === 65 && bytes[0] === 4) ? key : "";
    } catch (e) { return ""; }
  }
  // null when push can be offered right now; a Hebrew sentence otherwise. The
  // browser's own limits come first, then the missing key.
  function notifPushUnsupportedReason() {
    return notifPushBrowserUnsupportedReason() || (vapidPublicKey() ? null : VAPID_NOT_SET_TEXT);
  }
  // The VAPID public key ships base64url (cloud-config.js), the
  // uncompressed EC point PushManager.subscribe's applicationServerKey
  // expects raw bytes for.
  function vapidKeyToUint8Array(base64urlString) {
    const padding = "=".repeat((4 - (base64urlString.length % 4)) % 4);
    const base64 = (base64urlString + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  // Confirms whether THIS device already has a live, unrevoked
  // subscription. Checked lazily the first time a member with the flag on
  // lands on the Account tab (window.afterRenderCommunity below), never on
  // every session - the same lazy-load pattern the other flag-gated
  // Phase 2 reads use (coachEngage).
  async function loadNotifPushStatus() {
    state.notif.pushChecked = true;
    // Reading the permission is not asking for it. This runs once, lazily,
    // when a member lands on the Account tab, and it is what makes the
    // "default" bucket - members who have never been asked - countable at
    // all; a prompt-only measurement can only ever see the people who were
    // already asked.
    notePushPermission("account_tab");
    if (!state.user || !client || !notifPushEnabled() || notifPushUnsupportedReason()) { state.notif.pushSub = null; return; }
    try {
      const hasSw = "serviceWorker" in navigator;
      const reg = hasSw ? await navigator.serviceWorker.ready : null;
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const { data, error } = await client.from("push_subscriptions")
          .select("id,endpoint").eq("endpoint", sub.endpoint).is("revoked_at", null).maybeSingle();
        state.notif.pushSub = (!error && data) ? { endpoint: sub.endpoint } : null;
        if (state.notif.pushSub) { try { localStorage.setItem(NOTIF_PUSH_ENDPOINT_KEY, sub.endpoint); } catch (e) {} }
      } else {
        state.notif.pushSub = null;
        // The browser has no live subscription right now. If this device
        // previously had one - permission revoked outside the app, or the
        // browser otherwise dropped it - the endpoint is gone for good
        // (there is no API to recover a discarded PushSubscription), so
        // the last endpoint this app itself wrote is the only thing left
        // to mark revoked_at on, matching the acceptance criterion that a
        // revoke never leaves a stale unrevoked row.
        let stale = null;
        try { stale = localStorage.getItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
        if (stale) {
          await client.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("endpoint", stale).is("revoked_at", null);
          try { localStorage.removeItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
        }
      }
    } catch (err) {
      state.notif.pushSub = null;
    }
    rerender();
  }
  // THE PERMISSION SENTENCE, ONCE. It was typed out at four call sites (two
  // in enableNotifPush, one in its catch, one in runPushSelfTest) and the
  // self-test panel now has to RECOGNISE it to know when to offer the
  // how-to-allow instructions below - a comparison against a string literal
  // that four other literals have to keep matching is exactly the drift
  // CLAUDE.md warns about, so there is now one constant.
  const NOTIF_PERMISSION_DENIED_TEXT = "לא אושרה הרשאת התראות";
  // Triggers the browser permission prompt - the ticket's own "loading
  // state is the prompt itself", no spinner needed. On grant, registers a
  // PushSubscription and writes {endpoint, keys}; only returns true once
  // that write has actually succeeded, which is what setNotifPref below
  // gates the preference write itself on. On denial or any failure, shows
  // the exact Hebrew copy the ticket specifies and leaves the stored
  // preference untouched, so the toggle reads whatever it already was
  // (in_app by default) - "reverts to In-app".
  // True when the subscription was made under this key. A subscription that
  // does not say (no options.applicationServerKey) is kept: only a key that is
  // known to differ is a reason to drop it.
  function subscriptionUsesKey(sub, key) {
    try {
      const k = sub && sub.options && sub.options.applicationServerKey;
      if (!k) return true;
      const have = new Uint8Array(k), want = vapidKeyToUint8Array(key);
      if (have.length !== want.length) return false;
      for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
      return true;
    } catch (e) { return true; }
  }
  async function enableNotifPush(source, prefType) {
    const reason = notifPushUnsupportedReason();
    if (reason) { setMessage(reason); return false; }
    // The one prompt, the one gate. Every caller of this function is a click
    // handler, and each states so here rather than leaving it implied - which
    // is what makes "never on first load" a property of the code instead of a
    // claim about it.
    const gate = pushAskGateReason({ userAction: true });
    if (gate) { setMessage(gate); return false; }
    // Fail closed: no key, no prompt and no subscribe attempt.
    const pubKey = vapidPublicKey();
    if (!pubKey) { setMessage(VAPID_NOT_SET_TEXT); return false; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // A subscription is bound to the key it was made with. After a rotation
      // the old one can never be sent to again: drop it and make a new one.
      if (sub && !subscriptionUsesKey(sub, pubKey)) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
      if (!sub) {
        const perm = await Notification.requestPermission();
        // Recorded on BOTH branches, before the early return below: a denial
        // is the answer this event exists for.
        notePushPermission("prompt");
        if (perm !== "granted") { setMessage(NOTIF_PERMISSION_DENIED_TEXT); return false; }
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyToUint8Array(pubKey) });
      }
      const json = sub.toJSON ? sub.toJSON() : sub;
      const { error } = await client.from("push_subscriptions").upsert(
        { user_id: state.user.id, endpoint: json.endpoint, keys: json.keys || {}, revoked_at: null },
        { onConflict: "endpoint" });
      if (error) { setMessage(failText(NOTIF_PERMISSION_DENIED_TEXT, error)); return false; }
      state.notif.pushSub = { endpoint: json.endpoint };
      try { localStorage.setItem(NOTIF_PUSH_ENDPOINT_KEY, json.endpoint); } catch (e) {}
      // COMM-233. Only once the subscription row is actually written -
      // a granted browser permission whose upsert then failed is not an
      // opt-in, and the every-return-path-above branches leave it unsent.
      // The endpoint is a device secret and never a prop: what is measured
      // is that a member turned push on, and which control asked them to.
      track(A.PUSH_OPT_IN, { source: source || "notif_pref", pref_type: prefType || null });
      rerender();
      return true;
    } catch (err) {
      setMessage(NOTIF_PERMISSION_DENIED_TEXT);
      return false;
    }
  }
  // ---- The push self-test (account settings) -----------------------------
  //
  // WHAT IT PROVES, AND WHAT IT DOES NOT. It asks this device's own service
  // worker to show a real notification and waits for the worker to report
  // back that it did. That exercises the four things that actually break on
  // a phone: the permission is granted, a service worker is registered AND
  // controlling this page, the worker can call showNotification(), and the
  // page and the worker can still talk to each other. It does NOT exercise
  // the push SERVER - notif_push_pending and the Edge Function behind it
  // (202609170002) - because that path is a scheduled job measured in
  // minutes, and a "test" a member waits five minutes for is not a test.
  // The screen says as much in one line rather than implying more.
  //
  // WHY THE WORKER SHOWS IT rather than the page. A notification raised from
  // the page proves only that the page can raise notifications; every real
  // push this app will ever deliver is drawn by sw.js's push handler, from
  // the worker's own registration, which is exactly the surface a member who
  // says "I never get notifications" has a problem with.
  const PUSH_SELF_TEST_TIMEOUT_MS = 8000;
  let pushSelfTestTimer = null;
  function pushSelfTestSet(status, reason) {
    state.notif.selfTest.status = status;
    state.notif.selfTest.reason = reason || "";
    rerender();
  }
  function clearPushSelfTestTimer() {
    if (pushSelfTestTimer) { clearTimeout(pushSelfTestTimer); pushSelfTestTimer = null; }
  }
  async function runPushSelfTest() {
    if (!state.user) return;
    const st = state.notif.selfTest;
    if (st.status === "sending" || st.status === "waiting") return;
    clearPushSelfTestTimer();
    const unsupported = notifPushBrowserUnsupportedReason();
    if (unsupported) return pushSelfTestSet("failed", unsupported);
    // The self-test is a user action inside the app, so it is a legitimate
    // place to ask - the same gate enableNotifPush uses, stated the same way.
    // A member who has never granted permission gets the prompt here and a
    // notification immediately after, which is the clearest possible version
    // of what they just agreed to.
    if (currentPushPermission() !== "granted") {
      const gate = pushAskGateReason({ userAction: true });
      if (gate) return pushSelfTestSet("failed", gate);
      let perm = null;
      try { perm = await Notification.requestPermission(); } catch (e) { perm = null; }
      notePushPermission("self_test");
      if (perm !== "granted") return pushSelfTestSet("failed", NOTIF_PERMISSION_DENIED_TEXT);
    }
    const id = "st" + Date.now() + Math.random().toString(36).slice(2, 6);
    st.id = id;
    pushSelfTestSet("sending", "");
    try {
      const reg = await navigator.serviceWorker.ready;
      const worker = reg.active || navigator.serviceWorker.controller;
      if (!worker) return pushSelfTestSet("failed", "אין עובד שירות פעיל במכשיר הזה. נסו לסגור ולפתוח את האפליקציה.");
      worker.postMessage({ type: "PUSH_SELF_TEST", id: id });
    } catch (err) {
      return pushSelfTestSet("failed", "לא ניתן היה לשלוח התראת בדיקה. נסו שוב.");
    }
    pushSelfTestSet("waiting", "");
    // NOT RECEIVED IS AN ANSWER, and it is the answer the member came for.
    // A test that hangs on a spinner tells them nothing; a test that says
    // "nothing arrived" after eight seconds tells them exactly what they
    // suspected, and writes the row that makes it countable across the club.
    pushSelfTestTimer = setTimeout(() => {
      pushSelfTestTimer = null;
      // A session that ended while the test was in flight writes nothing. The
      // row would carry a null user_id (the insert policy allows one), and
      // "somebody, once, did not get a notification" is not a measurement.
      if (!state.user) return;
      if (state.notif.selfTest.id !== id || state.notif.selfTest.status !== "waiting") return;
      track(A.PUSH_SELF_TEST, { result: "not_received" });
      pushSelfTestSet("not_received", "");
    }, PUSH_SELF_TEST_TIMEOUT_MS);
  }
  // sw.js posts this back the moment showNotification() resolves, reaching
  // here through app.js's serviceWorker "message" listener - the same
  // page-decides split PUSH_NOTIFICATION_CLICK already uses, and the reason
  // the worker does not write the row itself: a service worker has no
  // Supabase client and deliberately cannot read cloud-config.js (see sw.js's
  // own note on why importScripts there is not worth it). The RECEIPT is the
  // worker's; the INSERT is analyticsTrack's, the one existing writer of
  // public.analytics_events, on the page where the session already lives.
  //
  // The id check is what makes a late receipt from an abandoned run unable to
  // resolve a newer one, or to write a second row after the timeout already
  // wrote "not_received".
  function communityHandlePushSelfTestReceipt(id) {
    const st = state.notif.selfTest;
    if (!state.user) return;
    if (!id || st.id !== id || st.status !== "waiting") return;
    clearPushSelfTestTimer();
    track(A.PUSH_SELF_TEST, { result: "received" });
    pushSelfTestSet("received", "");
  }

  // Explicit "turn off on this device" control (renderNotifPrefsPanel).
  // Revoking sets revoked_at rather than deleting the row, matching the
  // existing partial index `where revoked_at is null`.
  async function disableNotifPush() {
    if (!state.user || !client) return;
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe().catch(() => {});
          await client.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("endpoint", endpoint).is("revoked_at", null);
        }
      }
    } catch (err) { /* best-effort; the device just no longer reports itself active */ }
    try { localStorage.removeItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
    state.notif.pushSub = null;
    rerender();
  }

  // ---- A push subscription does not outlive the session -------------------
  //
  // Sign-out removes THIS device's subscription: the server row is deleted
  // (own-row RLS, while the session still exists) and the browser's
  // subscription is dropped, so the next person to sign in on a shared phone is
  // not pushed the previous member's notifications. Account deletion removes
  // every subscription the member has (also done server-side by
  // request_account_deletion). Neither may block signing out: the service
  // worker lookup is time-boxed, and every failure is swallowed.
  function notifWithTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  }
  async function dropBrowserPushSubscription() {
    const endpoints = [];
    try {
      if ("serviceWorker" in navigator) {
        const reg = await notifWithTimeout(navigator.serviceWorker.ready, 1500);
        const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
        if (sub) {
          endpoints.push(sub.endpoint);
          await sub.unsubscribe().catch(() => {});
        }
      }
    } catch (e) { /* best effort */ }
    return endpoints;
  }
  async function removeDevicePushSubscription(opts) {
    const everyDevice = !!(opts && opts.everyDevice);
    const endpoints = [];
    try { const stored = localStorage.getItem(NOTIF_PUSH_ENDPOINT_KEY); if (stored) endpoints.push(stored); } catch (e) {}
    // The server rows first: they need the session that is about to end.
    try {
      const live = await dropBrowserPushSubscription();
      for (const ep of live) if (endpoints.indexOf(ep) < 0) endpoints.push(ep);
      if (client && state.user) {
        if (everyDevice) await client.from("push_subscriptions").delete().eq("user_id", state.user.id);
        else for (const ep of endpoints) await client.from("push_subscriptions").delete().eq("endpoint", ep);
      }
    } catch (e) { /* best effort */ }
    try { localStorage.removeItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
    state.notif.pushSub = null;
    state.notif.pushChecked = false;
  }
  // The session ended some other way (expired, signed out in another tab): no
  // session to delete the row with, but the device still must not keep a
  // subscription for a member who is no longer signed in here.
  // The stored endpoint is kept on purpose: the next sign-in on this device
  // finds no live subscription for it and retires the server row
  // (loadNotifPushStatus).
  async function forgetDevicePushLocally() {
    await dropBrowserPushSubscription();
    state.notif.pushSub = null;
    state.notif.pushChecked = false;
  }
  async function endSessionAndForgetPush() {
    await removeDevicePushSubscription();
    await client.auth.signOut();
  }

  // A toggle in Me. On means "tell me": by push when this device can (the
  // permission prompt appears here, on the tap), otherwise in the bell. Off
  // writes an explicit off row.
  async function setNotifPref(type, on) {
    if (!state.user || !NOTIF_PREF_KEYS.has(type)) return;          // unknown type is ignored
    let channel = "off";
    if (on) {
      channel = "in_app";
      if (notifPushEnabled()) {
        const why = notifPushUnsupportedReason() || pushAskGateReason({ userAction: true });
        if (!why) {
          if (state.notif.pushSub || await enableNotifPush("notif_pref", type)) channel = "push";
        } else {
          // Say why this one will only appear in the bell.
          setMessage(why);
        }
      }
    }
    await saveNotifPref(type, channel);
  }
  async function saveNotifPref(type, channel) {
    if (!state.user || !NOTIF_PREF_KEYS.has(type)) return;
    if (NOTIF_CHANNELS.indexOf(channel) < 0) return;
    const prev = state.notif.prefs[type];
    if (prev === channel) return;
    state.notif.prefs[type] = channel;
    state.notif.prefSaving[type] = true;
    rerender();
    const { error } = await client.from("notification_preferences").upsert(
      { user_id: state.user.id, type: type, channel: channel, updated_at: new Date().toISOString() },
      { onConflict: "user_id,type" });
    delete state.notif.prefSaving[type];
    if (error) {
      if (prev == null) delete state.notif.prefs[type]; else state.notif.prefs[type] = prev;
      setMessage("לא ניתן לשמור העדפה זו");
      return;
    }
    rerender();
  }

  // --- COMM-140 the centre: open, page, mark read --------------------
  // returnFocusSelector: a full CSS selector for the control focus should
  // return to on close, defaulting to the feed's own bell chip. The header
  // bell (app.js's window.openCommunityNotifCenter, fresh-eyes audit) is
  // not a [data-community-action] element and passes its own id instead,
  // since it can open this from any screen, not only Community's feed.
  async function openNotifCenter(returnFocusSelector) {
    if (!state.user || !client) return;
    state.notif.center = {
      loading: true, error: false, rows: [], cursor: null, end: false, hasOlder: false,
      loadingMore: false, moreError: false, showOlder: false, _focused: false,
      returnFocus: returnFocusSelector || '[data-community-action="feed-notifications"]',
    };
    rerender();
    await fetchNotifPage(true);
  }
  function closeNotifCenter() {
    const back = state.notif.center && state.notif.center.returnFocus;
    state.notif.center = null;
    rerender();
    if (back) {
      const el = document.querySelector(back);
      if (el && el.focus) el.focus();
    }
  }
  async function fetchNotifPage(first) {
    const c = state.notif.center;
    if (!c) return;
    if (!first && (c.loadingMore || c.end)) return;
    if (first) { c.loading = true; c.error = false; } else { c.loadingMore = true; c.moreError = false; }
    rerender();
    // Same composite cursor as the audit log above, for the same reason -
    // notif_create() fans one event out to every recipient in a loop, so rows
    // sharing a timestamp are routine. 200 seeded rows rendered 199.
    const { data, error } = await client.rpc("notif_list", { p_cursor: c.cursor, p_cursor_id: c.cursorId || null, p_limit: NOTIF_PAGE_SIZE });
    if (!state.notif.center || state.notif.center !== c) return;
    if (error) {
      if (first) { c.loading = false; c.error = true; } else { c.loadingMore = false; c.moreError = true; }
      rerender();
      return;
    }
    const raw = Array.isArray(data) ? data : [];
    let rows = raw.slice();
    let hitOld = false;
    if (!c.showOlder) {
      const cut = notifCutoffIso();
      const keep = [];
      for (const r of rows) { if (r.created_at && r.created_at < cut) { hitOld = true; break; } keep.push(r); }
      rows = keep;
    }
    for (const r of rows) { r._wasUnread = !r.read_at; c.rows.push(r); }
    if (rows.length) { c.cursor = rows[rows.length - 1].created_at; c.cursorId = rows[rows.length - 1].id; }
    c.end = hitOld || raw.length < NOTIF_PAGE_SIZE;
    c.hasOlder = hitOld;
    c.loading = false; c.loadingMore = false;
    rerender();
    // COMM-140. Opening the centre marks the rows it just showed as seen.
    if (first) markNotifsSeen(rows);
  }
  async function loadMoreNotifs() { await fetchNotifPage(false); }
  async function notifShowOlder() {
    const c = state.notif.center;
    if (!c) return;
    c.showOlder = true; c.end = false; c.hasOlder = false;
    await fetchNotifPage(false);
  }
  async function markNotifsSeen(rows) {
    const targets = (rows || []).filter((r) => !r.read_at);
    if (!targets.length) return;
    const ids = targets.map((r) => r.id);
    const stamp = new Date().toISOString();
    for (const r of targets) r.read_at = stamp;
    const prevUnread = Number(state.notif.unread) || 0;
    state.notif.unread = Math.max(0, prevUnread - ids.length);
    rerender();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await client.rpc("notif_mark_read", { p_ids: ids.slice(i, i + 100) });
      if (error) { for (const r of targets) r.read_at = null; state.notif.unread = prevUnread; rerender(); return; }
    }
  }
  async function markAllNotifsRead() {
    const c = state.notif.center;
    if (!c) return;
    const targets = c.rows.filter((r) => !r.read_at);
    if (!targets.length) return;
    const ids = targets.map((r) => r.id);
    const stamp = new Date().toISOString();
    for (const r of targets) r.read_at = stamp;
    const prevUnread = Number(state.notif.unread) || 0;
    state.notif.unread = Math.max(0, prevUnread - ids.length);
    rerender();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await client.rpc("notif_mark_read", { p_ids: ids.slice(i, i + 100) });
      if (error) { for (const r of targets) r.read_at = null; state.notif.unread = prevUnread; loadNotifUnread(); rerender(); return; }
    }
  }
  async function markNotifRead(id) {
    const c = state.notif.center;
    const row = c && c.rows.find((r) => r.id === id);
    if (!row || row.read_at) return;
    // Optimistic with rollback (COMM-141).
    row.read_at = new Date().toISOString();
    state.notif.unread = Math.max(0, (Number(state.notif.unread) || 0) - 1);
    rerender();
    const { error } = await client.rpc("notif_mark_read", { p_ids: [id] });
    if (error) {
      row.read_at = null;
      state.notif.unread = (Number(state.notif.unread) || 0) + 1;
      setMessage("לא ניתן לסמן כנקרא");
      rerender();
    }
  }

  // --- deep links ----------------------------------------------------------
  // The one place that turns a stored in-app route into a real navigation.
  // Every route names a circle: /circles?c=<circle>[&post=<post>][&week=1].
  // Both the bell and a tapped push come through here, so a push opens the
  // right circle and, for a reaction or a tag, scrolls to the right post.
  // circle_id/source_id on the row are the fallback when deep_link is absent.
  function resolveNotifTarget(row) {
    const link = String((row && row.deep_link) || "");
    const qi = link.indexOf("?");
    const q = {};
    if (qi >= 0) for (const part of link.slice(qi + 1).split("&")) {
      const eqp = part.indexOf("=");
      if (eqp < 0) continue;
      try { q[decodeURIComponent(part.slice(0, eqp))] = decodeURIComponent(part.slice(eqp + 1)); } catch (e) { /* a malformed pair is skipped */ }
    }
    const st = row && row.source_type;
    const sid = row && row.source_id;
    return {
      tab: "circle",
      circle: q.c || (row && row.circle_id) || null,
      post: q.post || (st === "post" ? sid : null) || null,
      week: q.week === "1",
    };
  }
  async function navigateToNotifTarget(target) {
    if (typeof window.switchToCommunityTopTab === "function") window.switchToCommunityTopTab();
    if (!target.circle) { rerender(); return; }
    // A cold start gets here before the circles have loaded.
    if (!state.circles.loaded && typeof loadMyCircles === "function") await loadMyCircles();
    if (!circleById(target.circle)) {
      setMessage("המעגל הזה כבר לא זמין לך");
      rerender();
      return;
    }
    setCurrentCircle(target.circle);
    state.circles.section = target.week ? "week" : "feed";
    if (target.post) {
      if (!feedState(target.circle).loaded) await loadFeed(target.circle);
      setSection("feed");
      setTimeout(() => {
        const sel = '[data-post-id="' + cssSel(target.post) + '"]';
        const node = document.querySelector(sel);
        if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
        else { setMessage("התוכן הזה לא נטען כרגע — אפשר לגלול או לרענן ולנסות שוב"); rerender(); }
      }, 60);
    } else {
      setSection(state.circles.section);
    }
  }

  async function openNotif(id) {
    const c = state.notif.center;
    const row = c && c.rows.find((r) => r.id === id);
    if (!row) return;
    const target = resolveNotifTarget(row);
    // COMM-170. Before the await, so a slow mark-read cannot lose the
    // event, and once per row because the centre closes right after.
    // was_unread reads the flag the fetch stamped, not read_at: opening
    // the centre already marks every row it showed as seen, so read_at is
    // false for everything by the time a member taps one.
    track(A.NOTIFICATION_OPENED, { notification_id: id, type: row.type || null, target: target.tab || null, was_unread: !!row._wasUnread });
    await markNotifRead(id);
    closeNotifCenter();
    navigateToNotifTarget(target);
  }
  // COMM-229. Reached from two places: sw.js's notificationclick handler
  // posting back to an already-open window (see app.js's serviceWorker
  // "message" listener), and window.__pendingPushDeepLink - a ?notif=
  // query param app.js captures at boot for the "no window was open, the
  // service worker opened a fresh one" cold-start case, consumed once the
  // session is ready (refreshSession below). Both hand back the same
  // deep_link string notifications.deep_link already uses, so this reuses
  // resolveNotifTarget - the one place that turns a route into a
  // navigation - rather than a second parser. There is no notification id
  // to mark read here: a real push payload is not necessarily backed by a
  // row the centre has ever loaded.
  function communityHandlePushDeepLink(deepLink) {
    if (!deepLink || !state.user) return;
    // The Community sub-tab (setCommunityTab, inside navigateToNotifTarget)
    // is not the same as app.js's own top-level tab bar (add/history/
    // calendar/wod/community) - a push notification can arrive while a
    // completely different top-level tab is open. cloud.js has no direct
    // reference into app.js's own `tab`/`render` (they are two separate
    // <script> evaluations in the test harness, and reaching past
    // window.* into another script's bare bindings is not a pattern used
    // anywhere else in this codebase - see window.renderCommunityApp for
    // the actual convention: app.js calls INTO cloud.js through window,
    // never the reverse). A real click on the existing tab button is the
    // same DOM-level bridge every other cross-file test in this repo
    // already relies on.
    const topBtn = document.getElementById("tabCommunityBtn");
    if (topBtn && !topBtn.classList.contains("active")) topBtn.click();
    navigateToNotifTarget(resolveNotifTarget({ deep_link: deepLink }));
  }
  window.communityHandlePushDeepLink = communityHandlePushDeepLink;


  // --- COMM-140/142 rendering --------------------------------------
  function renderNotifRow(r) {
    const def = notifTypeDef(r.type) || { icon: "🔔", title: r.title || "התראה" };
    const emphasise = !!r._wasUnread;
    // The client label wins over the stored one, so the centre reads the same
    // whatever the server wrote; the server's body carries the names. r.title
    // remains the last resort for a type this client does not know.
    const title = esc(def.title || r.title || "");
    const bodyHtml = r.body ? `<span style="display:block;color:var(--steel);font-size:12.5px;margin-top:2px;">${esc(r.body)}</span>` : "";
    return `<button class="log-row" data-community-action="notif-open" data-id="${esc(r.id)}" style="width:100%;text-align:right;background:none;border:0;border-inline-start:3px solid ${emphasise ? "var(--energy)" : "transparent"};padding:8px 10px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;">
      <span aria-hidden="true" style="font-size:18px;line-height:1.2;">${esc(def.icon)}</span>
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${title}</span>
        ${bodyHtml}
        <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${esc(relativeTime(r.created_at))}</span>
      </span>
    </button>`;
  }
  function renderNotifCategoryRows(rows) {
    return rows.map(renderNotifRow).join("");
  }
  function notifRowCategory(r) {
    const def = notifTypeDef(r.type);
    // One category exists. A row of a type this client does not know still
    // shows, under the same heading, rather than vanishing.
    return (def && def.category) || "community";
  }
  function renderNotificationCenter() {
    const c = state.notif.center;
    if (!c) return "";
    let body;
    if (c.loading && !c.rows.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:70%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(5)}</div>`;
    } else if (c.error && !c.rows.length) {
      body = `<div class="empty">לא ניתן לטעון התראות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="notif-retry">ניסיון חוזר</button></div></div>`;
    } else if (!c.rows.length) {
      body = `<div class="empty">אין עדיין התראות.</div>`;
    } else {
      body = NOTIF_CATEGORIES.map((cat) => {
        const rows = c.rows.filter((r) => notifRowCategory(r) === cat.id);
        if (!rows.length) return "";
        return `<div class="ach-section" style="margin-top:14px;">${sectionHead("var(--blue)", cat.label)}<div class="log-list">${renderNotifCategoryRows(rows)}</div></div>`;
      }).join("");
    }
    const moreHtml = c.rows.length && !c.end
      ? `<div class="chip-row" style="justify-content:center;margin-top:10px;"><button class="chip-btn" data-community-action="notif-load-more"${c.loadingMore ? " disabled" : ""}>${c.loadingMore ? "טוען…" : c.moreError ? "ניסיון חוזר" : "טעינת עוד"}</button></div>`
      : "";
    const olderHtml = c.end && c.hasOlder && !c.showOlder
      ? `<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="link-btn" data-community-action="notif-show-older">הצגת התראות ישנות יותר</button></div>`
      : "";
    // Real device report (2026-09-15): tapped on a phone, nothing happened,
    // reported as broken. `disabled` was correct - every loaded row already
    // had a read_at - but a disabled .link-btn is a 13px steel underline at
    // opacity .45 sitting next to an identical-looking enabled "סגירה", which
    // on a phone is indistinguishable from a button that simply does not
    // work. A control that can do nothing should say so rather than sit there
    // looking tappable, so the dead button is replaced by the fact itself.
    const canMarkAll = c.rows.some((r) => !r.read_at);
    // Immersive club redesign, IMPLEMENTATION_SPEC.md §8 Notifications:
    // "reuse the Community scene, not a new photograph... club wall only in
    // the header zone or beneath a solid scrim" - the community-logo-wall
    // photo as a compact strip above the title, everything below (the
    // actual notification rows) stays the plain opaque/scannable list the
    // spec explicitly says is fine here. Same isolation:isolate fix the
    // achievements mini-scene needed (z-index:-3 media otherwise escapes
    // behind the modal's own opaque background).
    const headerStrip = `<div class="scene-page--community" style="position:relative; isolation:isolate; margin:-18px -18px 14px; height:100px; overflow:hidden;">
      <div class="scene-page__media" style="height:100px;" aria-hidden="true"></div>
      <div class="scene-page__scrim" aria-hidden="true"></div>
    </div>`;
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="notifCenterTitle" data-notif-center data-cloud-dialog="notifCenter" style="align-items:center;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:520px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          ${headerStrip}
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:6px;">
            <h2 id="notifCenterTitle" style="margin-top:0;font-weight:800;font-size:16px;margin-bottom:0;">התראות</h2>
            <button class="link-btn" data-community-action="notif-close" aria-label="סגירה">סגירה</button>
          </div>
          <div class="chip-row" style="margin-top:0;margin-bottom:4px;">${canMarkAll
            ? `<button class="link-btn" data-community-action="notif-mark-all">סימון הכול כנקרא</button>`
            : `<span class="footer-note" style="margin:0;">הכול כבר סומן כנקרא.</span>`}</div>
          ${body}
          ${moreHtml}
          ${olderHtml}
        </div>
      </div>
    </div>`;
  }

  // The notification toggles, rendered in Me. One switch per type, every one
  // off until the member turns it on (a missing row is off). Turning one on is
  // the only thing that ever asks the browser for permission.
  function renderNotifPrefsPanel() {
    const pushOn = notifPushEnabled();
    const pushReason = pushOn ? notifPushUnsupportedReason() : null;
    const rowFor = (t) => {
      const stored = state.notif.prefs[t.key];
      const on = stored === "push" || stored === "in_app";
      const saving = !!state.notif.prefSaving[t.key];
      const pushBadge = (pushOn && stored === "push" && state.notif.pushSub)
        ? `<span style="color:var(--green);font-size:11px;"> · פעיל</span>` : "";
      return `<label class="log-row" data-notif-pref-row="${t.key}" style="justify-content:space-between;gap:12px;align-items:center;cursor:pointer;min-height:44px;">
        <span style="font-size:13px;min-width:0;">${esc(t.label)}${pushBadge}</span>
        <input type="checkbox" role="switch" data-notif-pref-toggle data-type="${t.key}" aria-label="${esc(t.label)}"${on ? " checked" : ""}${saving ? " disabled" : ""}/>
      </label>`;
    };
    const rows = state.notif.prefsLoaded
      ? NOTIF_PREF_TYPES.map(rowFor).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(NOTIF_PREF_TYPES.length);
    // A PushSubscription is per browser/device, so "turn push off" is a single
    // action here rather than one per row.
    const deviceStatusHtml = (pushOn && state.notif.pushSub)
      ? `<div class="chip-row" style="margin-top:0;margin-bottom:8px;align-items:center;"><span style="font-size:12px;color:var(--steel);">התראות דחיפה פעילות במכשיר זה.</span><button type="button" class="link-btn" data-community-action="notif-push-disable">כיבוי במכשיר זה</button></div>`
      : "";
    const reasonHtml = pushReason
      ? `<div data-notif-push-reason style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">${esc(pushReason)} ההתראות יופיעו בפעמון.</div>` : "";
    const introHtml = "כל ההתראות כבויות עד שתדליקו אותן. מקבלים התראה רק על מעגל שעדיין חברים בו, ואף פעם לא ממי שחסמתם. עידוד על אותו פוסט מגיע לכל היותר פעם בשעה.";
    return `<div class="ach-section" id="notifPrefs" style="margin-top:18px;">${sectionHead("var(--brass)", "התראות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">${introHtml}</div>
      ${reasonHtml}
      ${deviceStatusHtml}
      <div class="log-list">${rows}</div>
      ${renderPushSelfTestPanel()}
    </div>`;
  }

  // WHAT TO DO ABOUT IT. The self-test's own bug report: it answered "לא
  // אושרה הרשאת התראות" and stopped there, which tells a member what the
  // browser said and nothing about what they can do - and on a phone the
  // answer is not in this app at all, it is two screens deep in the OS, in a
  // different place on each platform. Both platforms are listed rather than
  // the detected one: communityPlatformBucket() reads a user-agent string,
  // an iPad reporting as a Mac is a known case, and a member reading two
  // short lines and picking their own phone cannot be sent to the wrong
  // settings screen by a sniff that guessed wrong.
  //
  // The iPhone line leads with the home-screen step on purpose: Safari on
  // iOS grants web push ONLY to an installed PWA, so for an iPhone member
  // reading this in a browser tab there is no permission to allow yet and
  // the Settings route would simply not list the app.
  //
  // The retry is the same runPushSelfTest() the button above it runs; it is
  // repeated here so the next step and the control that takes it are in one
  // place, instead of asking the member to scroll back up past the failure.
  function pushPermissionHelpHtml() {
    const line = (device, steps) =>
      `<div style="margin-top:6px;"><b style="color:var(--chalk);">${device}</b><div>${steps}</div></div>`;
    return `<div data-push-permission-help="1" style="color:var(--steel);font-size:12px;line-height:1.6;margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">
      <div style="font-weight:700;color:var(--chalk);">איך מאשרים התראות</div>
      ${line("אייפון", "קודם מוסיפים את האפליקציה למסך הבית: בספארי, כפתור השיתוף ← „הוספה למסך הבית”. אחר כך פותחים אותה משם, ובהגדרות המכשיר: הגדרות ← התראות ← BOX-LOG ← „אפשר התראות”.")}
      ${line("אנדרואיד", "הגדרות ← אפליקציות ← BOX-LOG ← התראות ← מפעילים „הצג התראות”. בכרום אפשר גם: ⋮ ← הגדרות אתר ← התראות.")}
      <div class="chip-row" style="margin-top:8px;">
        <button type="button" class="chip-btn" data-community-action="notif-push-self-test">ניסיון חוזר</button>
      </div>
    </div>`;
  }

  // Rendered under the preference rows rather than beside the push button on
  // each of them: a PushSubscription is per device, so "does this phone get
  // notifications" is one question asked once, exactly like the
  // turn-off-on-this-device control above it.
  //
  // Only while the push module is on. With push switched off club-wide there
  // is nothing to test and offering a test would contradict the panel, which
  // omits the push option entirely in that state.
  function renderPushSelfTestPanel() {
    if (!notifPushEnabled()) return "";
    const st = state.notif.selfTest;
    const busy = st.status === "sending" || st.status === "waiting";
    // The result line. Three settled answers and one in-flight, each saying
    // what it means rather than only what happened - "not received" is the
    // one a member actually arrives here with, so it is the one that carries
    // the next step.
    let resultHtml = "";
    if (st.status === "received") {
      resultHtml = `<div role="status" style="color:var(--green);font-size:12px;margin-top:6px;">התראה התקבלה במכשיר הזה.</div>`;
    } else if (st.status === "not_received") {
      resultHtml = `<div role="status" style="color:var(--steel);font-size:12px;margin-top:6px;">לא התקבלה התראה. בדקו שהתראות מהאפליקציה מאושרות בהגדרות המכשיר, ושהאפליקציה פתוחה מהמסך הבית ולא מהדפדפן.</div>${pushPermissionHelpHtml()}`;
    } else if (st.status === "failed") {
      resultHtml = `<div role="alert" style="color:var(--steel);font-size:12px;margin-top:6px;">${esc(st.reason || "לא ניתן היה לשלוח התראת בדיקה.")}</div>`
        + (st.reason === NOTIF_PERMISSION_DENIED_TEXT ? pushPermissionHelpHtml() : "");
    } else if (busy) {
      resultHtml = `<div role="status" style="color:var(--steel);font-size:12px;margin-top:6px;">ממתינים להתראה…</div>`;
    }
    return `<div class="chart-card" style="margin-top:10px;" data-push-self-test="${esc(st.status)}">
      <div style="font-weight:800;font-size:13px;">בדיקת התראות במכשיר הזה</div>
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-top:4px;">שליחת התראת בדיקה למכשיר הזה בלבד. הבדיקה מוודאת שההרשאה ניתנה ושהאפליקציה יכולה להציג התראה — היא לא בודקת התראות שנשלחות מהשרת.</div>
      <div class="chip-row" style="margin-top:8px;">
        <button type="button" class="chip-btn primary" data-community-action="notif-push-self-test"${busy ? " disabled" : ""}>${busy ? "שולח…" : "שליחת התראת בדיקה"}</button>
      </div>
      ${resultHtml}
    </div>`;
  }

  window.communityHandlePushSelfTestReceipt = communityHandlePushSelfTestReceipt;
  // Published beside notifRoute/notifResolveTarget for
  // the same reason those are: they are pure answers about the current
  // environment with no side effect, and the permission gate in particular is
  // a rule that has to be assertable from outside the scope it lives in.
  window.communityDisplayMode = communityDisplayMode;
  window.communityPlatformBucket = communityPlatformBucket;
  window.pushAskGateReason = pushAskGateReason;
  window.notifRoute = notifRoute;
  window.notifResolveTarget = resolveNotifTarget;
