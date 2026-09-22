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

  // COMM-140/141, hoisted. Used to be built inline only inside feedTab's
  // club-strip block, which meant the bell - and the unread-notification
  // badge on it - was unreachable from anywhere the feed pill isn't shown:
  // a club that turns the feed module off loses the bell for every member,
  // and staff living on the new Manage tab had no bell at all. Standalone
  // now so both feedTab and renderManageApp() can mount it.
  function renderNotificationBell() {
    const club = state.club.row || null;
    const unread = state.notif.unreadLoaded
      ? Number(state.notif.unread) || 0
      : Number((club && club.unread_notifications) || 0);
    return `<button class="chip-btn" data-community-action="feed-notifications" aria-label="התראות${unread ? (unread === 1 ? ", התראה אחת חדשה" : `, ${unread} חדשות`) : ""}" aria-haspopup="dialog" style="position:relative;">🔔${unread ? `<span class="tab-badge" aria-hidden="true">${unread}</span>` : ""}</button>`;
  }

  // ==== COMM-140..144 notifications ====================================
  //
  // The client renders and marks read. Every notification row is created
  // server-side by a trigger or an event-bus consumer (the table has no
  // insert grant) - the full trigger set is documented in
  // docs/community/contracts.md under "Needs from schema, notifications".
  // Web push (COMM-229) is behind state.featureFlags.notifPush, which is
  // DEFAULT ON as of 2026-09-17 (B3) now that there is something behind it:
  // notif_push_send, the Edge Function that actually delivers, plus a real
  // VAPID keypair whose private half is an Edge Function secret. It was
  // default off for as long as a member choosing "Push" would have produced
  // a subscription nothing ever sent to.
  //
  // Turning it on prompts nobody. It adds a third button to the notification
  // preferences panel; the browser permission request happens when a member
  // picks that button, which is the only time it should - a permission
  // prompt fired on load is denied by reflex, and a denial is close to
  // unrecoverable without the member walking into browser settings.
  //
  // The localStorage escape hatch inverts with the default, matching
  // coachEngage: set haimunia-demo:notifPushFlag to "0" to turn it back off
  // on one device.
  // Two gates, and they are different things. featureFlags.notifPush is the
  // build-level flag (a device escape hatch, default on since B3). The module
  // is the CLUB's switch, owned by the admin panel and enforced server-side
  // in notif_push_pending - checked here too so a club with push off does not
  // offer members a button that would produce a subscription nothing sends to.
  function notifPushEnabled() {
    return !!(state.featureFlags && state.featureFlags.notifPush) && isModuleEnabled("push_notifications");
  }
  const NOTIF_PAGE_SIZE = 20;
  // COMM-141. Rows older than this are not walked by default.
  const NOTIF_RECENT_DAYS = 90;

  // The five categories, in display order, with the Hebrew heading each
  // shows in the centre.
  const NOTIF_CATEGORIES = [
    { id: "community", label: "קהילה" },
    { id: "training", label: "אימונים" },
    { id: "challenges", label: "אתגרים" },
    { id: "events", label: "אירועים" },
    { id: "club", label: "מועדון" },
  ];

  // Every notification type the server can send in V1. `mode` is how the
  // centre renders it: an immediate row stands alone, a batched row is one
  // collapsed group that expands. `pref` is the notification_preferences
  // key its delivery is gated on (COMM-144). `operational: true` means it
  // always lands in-app regardless of that preference. `icon` and `title`
  // are the client copy; the server fills `body` and `deep_link`.
  // `serverTitle: true` is the one exception: for an announcement the row's
  // stored title IS the announcement's own headline (notif_announcement_fanout
  // passes v_row.title), so it has to win over the generic client label.
  // Every OTHER type gets a hardcoded English string from notif_create -
  // 'Achievement unlocked', 'New comment on your post', 'Event cancelled' -
  // which is why the client label is preferred everywhere else. The
  // immediate/batched split here MUST match the server trigger set - see
  // the routing table in contracts.md.
  //
  // `pref` values below match `public.notif_pref_key()` (202608280026, as
  // amended). Three were re-keyed (COMM-218/219): `comment_reply` now reads
  // `comment_reply` (was the client-only `replies`), `comment_on_post` and
  // `comment_also` both now read `comment_on_post` (was `comments`), and
  // `achievement_unlocked` now reads `achievement_unlocked` (was
  // `achievements`) - each one made its Settings toggle actually suppress
  // delivery for the first time, since the server's identity fallback maps
  // an unmapped type to itself, not to the client's old coarse name.
  // `challenge_ending_soon`/`challenge_update` are DELIBERATELY left on the
  // shared client-only key `challenges`: the server has no arm for either
  // (each falls through to its own raw type name), so there is no single
  // server-side key a combined client toggle could honestly map to today.
  // Splitting that one toggle into two, or adding the server arms, is a
  // separate, larger change (schema coordination or a UX change) and is a
  // documented known gap, same as contracts.md already records it.
  //
  // `new_report` (202609050003) and `monthly_club_recap` (202609010002) are
  // both real server-emitted types with no `notif_pref_key` arm, so - same
  // reasoning as the three above - each MUST use its own literal type name
  // as `pref`, matching the server's identity fallback exactly.
  // `new_report` is moderators-only (`mod_alert_recipients()`: is_admin or a
  // role holding `community.comment.moderate`, owner included) - a plain
  // member is never a recipient, so its Settings row is gated to staff in
  // `renderNotifPrefsPanel()` (`staffOnly` below) rather than shown to
  // everyone as a toggle that would never do anything for them.
  // `monthly_club_recap` fans out club-wide to every member, so it gets an
  // ordinary toggle everyone sees, sibling to `weekly_recap`. It is
  // IMMEDIATE, not batched, per contracts.md: it fires at most twelve times
  // a year, at the moment a staff member deliberately publishes it, so
  // there is nothing to roll up.
  const NOTIF_TYPES = {
    comment_reply:         { category: "community",  mode: "immediate", pref: "comment_reply",       icon: "↩️", title: "תגובה חדשה לתגובה שלך" },
    comment_on_post:       { category: "community",  mode: "immediate", pref: "comment_on_post",     icon: "💬", title: "תגובה חדשה על הפוסט שלך" },
    comment_also:          { category: "community",  mode: "batched",   pref: "comment_on_post",     icon: "💬", title: "תגובות חדשות בשיחה שהשתתפת בה" },
    mention:               { category: "community",  mode: "immediate", pref: "mentions",            icon: "@",  title: "תייגו אותך בתגובה" },
    coach_mention:         { category: "community",  mode: "immediate", pref: "mentions",            icon: "@",  title: "מאמן/ת תייג/ה אותך" },
    reaction:              { category: "community",  mode: "batched",   pref: "reactions",           icon: "🔥", title: "עידודים חדשים על הפוסט שלך" },
    // 202609220005. The author of a workout post named this member as
    // somebody who trained with them. IMMEDIATE rather than batched, and
    // deliberately: it is one person naming one person, at most ten times on
    // one post, and it is the notification that tells a member a tag exists
    // at all - which is what makes "you can remove it" a real option rather
    // than a setting nobody finds. notif_create()'s own one-hour de-dupe on
    // (user, type, source_id) already collapses a re-save of the same list.
    //
    // `pref` is the literal type name, the same no-server-pref-arm shape as
    // new_report/streak_at_risk above: notif_pref_key() has no arm for
    // trained_together, so its identity fallback (`else p_type`) makes the
    // real server-side key the string "trained_together". Anything coarser
    // here would be a toggle that silently suppresses nothing.
    //
    // NOT serverTitle: notif_create writes the fixed English 'You were
    // tagged as a training partner' and the body carries the workout's own
    // title, so the client label below is the one that should win.
    trained_together:      { category: "community",  mode: "immediate", pref: "trained_together",    icon: "🤝", title: "תויגתם כמי שהתאמנו יחד" },
    // Live bug hunt (2026-09-11): pref was "comments" - the OLD pre-rename
    // key COMM-218/219 renamed everywhere else to comment_on_post, just
    // missed here. notif_pref_key()'s real SQL (202608290009) has no
    // explicit arm for feed_activity, so it falls through to its identity
    // fallback (`else p_type`) - the real server-side key is the literal
    // string "feed_activity", not "comments". No key in NOTIF_PREF_TYPES
    // ever wrote "comments" either way, so this toggle could never be muted
    // at all - same shape as weekly_recap/streak_at_risk below, now fixed
    // the same way (see the new NOTIF_PREF_TYPES row).
    feed_activity:         { category: "community",  mode: "batched",   pref: "feed_activity",       icon: "📣", title: "פעילות חדשה בפיד" },
    new_report:            { category: "community",  mode: "immediate", pref: "new_report",          icon: "🚩", title: "דיווח חדש לבדיקה" },
    // Admins only, by 202609150005's bug_report_alert_recipients() - the same
    // no-server-pref-arm shape as new_report above. Immediate rather than
    // batched on purpose: a bug report is a member telling you the app is
    // broken for them, and a six-hour batch window is the wrong latency for
    // that. notif_create()'s own 1-hour de-dupe still collapses a burst.
    new_bug_report:        { category: "community",  mode: "immediate", pref: "new_bug_report",      icon: "🐞", title: "דיווח תקלה חדש" },
    // 202609190001. Admins only, by admin_alert_recipients() - exactly the
    // same audience and the same no-server-pref-arm shape as new_bug_report
    // above, and like it, deliberately absent from NOTIF_PREF_TYPES: an
    // operational alert about the backend having stopped working is not a
    // thing to offer a mute switch for. serverTitle is NOT set, so the
    // client's fixed title wins and the server's row supplies the body
    // ("N עבודות מתוזמנות לא רצו כמתוכנן") - the count is the whole message;
    // job names never leave the database. There is no deep link because
    // there is no in-app screen for this, and resolveNotifTarget() would
    // otherwise land the admin on the feed, which is worse than no link.
    job_health_alert:      { category: "community",  mode: "immediate", pref: "job_health_alert",    icon: "⚙️", title: "תקלה בעבודות המתוזמנות" },
    achievement_unlocked:  { category: "training",   mode: "immediate", pref: "achievement_unlocked",icon: "🏅", title: "פתחת הישג חדש" },
    friend_achievement:    { category: "training",   mode: "batched",   pref: "friend_achievements", icon: "🎉", title: "חברים פתחו הישגים" },
    challenge_ending_soon: { category: "challenges", mode: "immediate", pref: "challenges",          icon: "⏳", title: "אתגר מסתיים בקרוב" },
    challenge_update:      { category: "challenges", mode: "batched",   pref: "challenges",          icon: "🏆", title: "עדכונים באתגר" },
    event_cancelled:       { category: "events",     mode: "immediate", pref: "events",              icon: "🚫", title: "אירוע בוטל" },
    announcement:          { category: "club",       mode: "immediate", pref: "announcements", operational: true, serverTitle: true, icon: "📢", title: "הודעה חשובה מהמועדון" },
    weekly_recap:          { category: "club",       mode: "batched",   pref: "weekly_recap",        icon: "📅", title: "הסיכום השבועי שלך" },
    monthly_club_recap:    { category: "club",       mode: "immediate", pref: "monthly_club_recap",  icon: "🗓️", title: "סיכום החודש של הקהילה" },
    // Community structure research, 2026-09-10 (202609100002). Same
    // no-server-pref-arm shape as new_report/monthly_club_recap above: each
    // pref key is the type's own literal name, matching notif_pref_key()'s
    // identity fallback for an unmapped type. streak_at_risk is a plain
    // member-facing type; engagement_decline_flagged is staff-only in
    // practice (only ever created for mod_alert_recipients()), same
    // audience as new_report.
    streak_at_risk:             { category: "training",  mode: "immediate", pref: "streak_at_risk",             icon: "🔥", title: "הרצף שלך בסכנה" },
    // serverTitle: true (burst guard, 202609100004) - coach_notify_
    // engagement_flags() now sends a genuinely different title depending
    // on whether one flag or several apply to a given recipient ("חבר/ה
    // עשוי/ה להתרחק" vs. "N חברים עשויים להתרחק"), so unlike every other
    // non-serverTitle type here, the server's real string has to win -
    // same reason `announcement` above is the one other exception.
    engagement_decline_flagged: { category: "community", mode: "immediate", pref: "engagement_decline_flagged", serverTitle: true, icon: "📉", title: "חבר/ה עשוי/ה להתרחק" },
  };
  function notifTypeDef(type) { return NOTIF_TYPES[type] || null; }

  // The Preferences panel in Account lists exactly these, in this order
  // (COMM-144). Defaults: everything in_app (a missing row means in_app).
  // `note`, when present, is a short caveat rendered under the row's label -
  // used by COMM-219 so "כבוי" on `announcements` does not read as "silences
  // everything": important/urgent announcements are operational
  // (`notif_is_operational`) and always land in-app regardless of this row.
  // Keys `comments`/`replies`/`achievements` were renamed to
  // `comment_on_post`/`comment_reply`/`achievement_unlocked` (COMM-218/219)
  // to match `NOTIF_TYPES[...].pref`, which now matches the server's real
  // `notif_pref_key()` output - see the long note above NOTIF_TYPES. This is
  // a stored-preference-row rename: a member's existing `notification_
  // preferences` row keyed `comments`/`replies`/`achievements` is orphaned by
  // this change (a fresh row under the new key reverts to the in_app
  // default) exactly the way any other client-side re-key would; there is no
  // migration step for it because notification_preferences is 100%
  // client-written and this repo does not touch that table's data.
  // `challenges` is UNCHANGED and stays a documented known gap (see above).
  // `staffOnly: true` (added for `new_report`) hides the row from a plain
  // member's Settings panel - `new_report` is never delivered to one, per
  // `mod_alert_recipients()` - while keeping the key valid for `setNotifPref`
  // (NOTIF_PREF_KEYS below is built from every entry, gated or not) so a
  // moderator's own toggle still writes and reads correctly.
  const NOTIF_PREF_TYPES = [
    { key: "comment_on_post",     label: "תגובות על הפוסטים שלי" },
    { key: "comment_reply",       label: "תגובות לתגובות שלי" },
    { key: "mentions",            label: "תיוגים" },
    // 202609220005. Its own row rather than folding into `mentions` above:
    // the two are different server keys (notif_pref_key has an arm for
    // mention/coach_mention and none for trained_together), so one toggle
    // could not honestly write both - the same reason challenge_ending_soon
    // and challenge_update are a documented gap rather than a merged row.
    { key: "trained_together",    label: "תיוג באימון משותף" },
    { key: "reactions",           label: "עידודים" },
    // Live bug hunt (2026-09-11): feed_activity had no row here at all - see
    // NOTIF_TYPES.feed_activity's own comment.
    { key: "feed_activity",       label: "פעילות חדשה בפיד" },
    { key: "achievement_unlocked",label: "הישגים שנפתחו" },
    { key: "friend_achievements", label: "הישגים של חברים" },
    { key: "challenges",          label: "אתגרים" },
    { key: "events",              label: "אירועים" },
    { key: "announcements",       label: "הודעות מהמועדון", note: "הודעות ברמת ❗ חשוב ו-🚨 דחוף יגיעו אליכם גם כשזה כבוי." },
    { key: "weekly_recap",        label: "סיכום שבועי" },
    { key: "monthly_club_recap",  label: "סיכום חודשי" },
    { key: "new_report",          label: "דיווחים חדשים לבדיקה", staffOnly: true },
    { key: "streak_at_risk",              label: "תזכורת רצף אימונים" },
    { key: "engagement_decline_flagged",  label: "התרעת ירידה במעורבות חבר/ה", staffOnly: true },
  ];
  const NOTIF_PREF_KEYS = new Set(NOTIF_PREF_TYPES.map((t) => t.key));
  const NOTIF_CHANNELS = ["push", "in_app", "off"];

  // The one place that says how a type is delivered given the member's
  // stored preferences. The server trigger set applies the same rule
  // (documented in contracts.md); this copy lets the centre explain a
  // type and a test pin the mapping. Returns { channel, mode, suppressed }.
  function notifRoute(type, prefs) {
    const def = NOTIF_TYPES[type];
    if (!def) return { channel: "off", mode: "immediate", suppressed: true };
    let channel = (prefs && prefs[def.pref]) || "in_app";
    if (NOTIF_CHANNELS.indexOf(channel) < 0) channel = "in_app";
    if (channel === "push" && !notifPushEnabled()) channel = "in_app";
    // Operational announcements always land in-app, muted or not.
    if (channel === "off" && def.operational) return { channel: "in_app", mode: def.mode, suppressed: false };
    return { channel: channel, mode: def.mode, suppressed: channel === "off" };
  }
  function classifyNotification(row) {
    const def = notifTypeDef(row && row.type);
    return def ? def.mode : "immediate";
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
    if (!pushAskEarned()) return "נבקש הרשאת התראות אחרי האימון הראשון שתרשמו, או אחרי ההצטרפות לקהילת המועדון.";
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
  function notifPushUnsupportedReason() {
    if (communityIsIOSDevice() && !isStandalonePwa()) {
      return "כדי לקבל התראות דחיפה ב-iPhone/iPad יש קודם להוסיף את האפליקציה למסך הבית ולפתוח אותה משם.";
    }
    const hasApi = ("serviceWorker" in navigator) && (typeof window.PushManager !== "undefined") && (typeof Notification !== "undefined");
    if (!hasApi) return "הדפדפן הזה לא תומך בהתראות דחיפה.";
    return null;
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
  // Triggers the browser permission prompt - the ticket's own "loading
  // state is the prompt itself", no spinner needed. On grant, registers a
  // PushSubscription and writes {endpoint, keys}; only returns true once
  // that write has actually succeeded, which is what setNotifPref below
  // gates the preference write itself on. On denial or any failure, shows
  // the exact Hebrew copy the ticket specifies and leaves the stored
  // preference untouched, so the toggle reads whatever it already was
  // (in_app by default) - "reverts to In-app".
  async function enableNotifPush(source, prefType) {
    const reason = notifPushUnsupportedReason();
    if (reason) { setMessage(reason); return false; }
    // The one prompt, the one gate. Every caller of this function is a click
    // handler, and each states so here rather than leaving it implied - which
    // is what makes "never on first load" a property of the code instead of a
    // claim about it.
    const gate = pushAskGateReason({ userAction: true });
    if (gate) { setMessage(gate); return false; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const perm = await Notification.requestPermission();
        // Recorded on BOTH branches, before the early return below: a denial
        // is the answer this event exists for.
        notePushPermission("prompt");
        if (perm !== "granted") { setMessage("לא אושרה הרשאת התראות"); return false; }
        const pubKey = (window.HAIMUNIA_CONFIG && window.HAIMUNIA_CONFIG.notifPushVapidPublicKey) || "";
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyToUint8Array(pubKey) });
      }
      const json = sub.toJSON ? sub.toJSON() : sub;
      const { error } = await client.from("push_subscriptions").upsert(
        { user_id: state.user.id, endpoint: json.endpoint, keys: json.keys || {}, revoked_at: null },
        { onConflict: "endpoint" });
      if (error) { setMessage(failText("לא אושרה הרשאת התראות", error)); return false; }
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
      setMessage("לא אושרה הרשאת התראות");
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
    const unsupported = notifPushUnsupportedReason();
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
      if (perm !== "granted") return pushSelfTestSet("failed", "לא אושרה הרשאת התראות");
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

  async function setNotifPref(type, channel) {
    if (!state.user || !NOTIF_PREF_KEYS.has(type)) return;          // unknown type is ignored
    if (NOTIF_CHANNELS.indexOf(channel) < 0) return;
    if (channel === "push") {
      if (!notifPushEnabled()) return;                              // push is disabled in V1 default
      if (notifPushUnsupportedReason()) return;                     // the control itself renders disabled for this case
      if (!state.notif.pushSub) {
        const ok = await enableNotifPush("notif_pref", type);
        if (!ok) return;                                            // permission denied/failed: leaves the stored channel untouched
      }
    }
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
      loadingMore: false, moreError: false, expanded: {}, showOlder: false, _focused: false,
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

  // --- COMM-140/141 deep links ---------------------------------------
  // The one place that turns a stored in-app route into a real
  // navigation. The route convention is documented in contracts.md;
  // source_type/source_id is the fallback when deep_link is absent.
  function resolveNotifTarget(row) {
    const link = String((row && row.deep_link) || "");
    const qi = link.indexOf("?");
    const path = (qi >= 0 ? link.slice(0, qi) : link).replace(/\/+$/, "");
    const q = {};
    if (qi >= 0) for (const part of link.slice(qi + 1).split("&")) {
      const eqp = part.indexOf("=");
      if (eqp < 0) continue;
      q[decodeURIComponent(part.slice(0, eqp))] = decodeURIComponent(part.slice(eqp + 1));
    }
    const st = row && row.source_type;
    const sid = row && row.source_id;
    // COMM-214/COMM-140. q.event has to be checked before the generic
    // /feed path fallback, the same way q.announcement already is one line
    // below: an event_cancelled notification's deep link is
    // /community/feed?event=<id>, which matches /\/feed(\/|$)/ just as
    // much as a plain feed link does. Without this guard it always fell
    // into the first branch and opened plain feed instead of the event -
    // found by the schema agent while building the cancellation trigger
    // (202608290009).
    if (q.post || st === "post" || st === "comment" || /\/feed(\/|$)/.test(path) && !q.announcement && !q.event) {
      return { tab: "feed", post: q.post || (st === "post" ? sid : null), comment: q.comment || (st === "comment" ? sid : null) };
    }
    if (q.user || st === "profile") return { tab: "account", profile: q.user || sid };
    if (q.challenge || st === "challenge" || /\/boards(\/|$)/.test(path)) return { tab: "boards", challenge: q.challenge || sid };
    if (q.ma || q.achievement || st === "achievement" || /\/achievements(\/|$)/.test(path)) return { tab: "account", achievement: q.ma || q.achievement || sid };
    if (q.announcement || st === "announcement" || /\/announcement/.test(path)) return { tab: "feed", announcement: q.announcement || sid };
    if (q.event || st === "event" || /\/events(\/|$)/.test(path)) return { tab: "feed", event: q.event || sid };
    // COMM-309. monthly_club_recap's own deep link is
    // /community/recap/monthly?month=<the month's first day> - recap_
    // monthly_publish's real notif_create() call, contracts.md's "Later-
    // phase types" entry for monthly_club_recap. This branch MUST come
    // before the weekly one just below: that branch's own /\/recap(\/|$)/
    // regex matches ANY path starting with "/recap", including
    // "/community/recap/monthly" (it has a "/recap/" substring), so without
    // this guard every monthly recap notification silently opened as a
    // weekly one. There is no monthly-recap dialog to open (see openRecap's
    // own comment - the monthly card is an inline Account-tab section, not a
    // per-month browsable surface), so this resolves to a distinct
    // `recapMonth` key rather than reusing `recapWeek`'s shape.
    if (q.month || st === "monthly_club_recap" || /\/recap\/monthly(\/|$)/.test(path)) return { tab: "account", recapMonth: q.month || null };
    // COMM-220/221. weekly_recap's own deep link is /community/recap?week=<monday>.
    if (q.week || st === "weekly_recap" || /\/recap(\/|$)/.test(path)) return { tab: "account", recapWeek: q.week || null };
    // 202609100002. coach_notify_engagement_flags()'s own deep link is
    // /community/coach - lands a staff member on the sub-tab
    // renderCoachTab() already lists open coach_engagement_flags rows on,
    // same tab id the "coach" sub-tab push uses (tabs.push({id:"coach",...})).
    if (st === "coach_engagement_flag" || /\/coach(\/|$)/.test(path)) return { tab: "coach" };
    return { tab: "feed" };
  }
  // COMM-140/COMM-229. The one place that actually navigates once a target
  // has been resolved - shared by tapping a row in the centre (openNotif,
  // which additionally marks it read first) and by a push notification's
  // click (communityHandlePushDeepLink below, which has no stored row to
  // mark read). Pulled out as its own function rather than duplicated so
  // there is exactly one navigation path to keep correct.
  function navigateToNotifTarget(target) {
    // Redesign, Phase 3 fix: a notification/deep-link tap can fire while
    // the top-level app is on Manage, not Community - see
    // window.switchToCommunityTopTab's own comment in app.js.
    if (typeof window.switchToCommunityTopTab === "function") window.switchToCommunityTopTab();
    setCommunityTab(target.tab || "feed");
    if (target.post) {
      state.engagement.openComments[target.post] = true;
      if (target.comment) state.engagement.openReplies[target.comment] = true;
      rerender();
      setTimeout(() => {
        // Security hunt (2026-09-11): was a naive manual '"'-only escape -
        // querySelector can't execute script from a malformed selector, so
        // this was never an XSS vector, but the shared cssSel() helper
        // (CSS.escape when available) is the established, correct way to
        // build a selector from an attacker-controlled string (target.post
        // is reachable via ?notif=) and should be used for consistency.
        const sel = '[data-post-id="' + cssSel(target.post) + '"]';
        const node = document.querySelector(sel);
        if (node && node.scrollIntoView) {
          node.scrollIntoView({ block: "center" });
        } else {
          // Live bug hunt (2026-09-11): the target post isn't guaranteed to
          // be on the currently-loaded feed page (the feed is paginated) -
          // this used to silently do nothing at all, closing the
          // notification center with no sign anything was even attempted.
          // Confirmed live with a real mention notification pointing at a
          // post outside the loaded page.
          delete state.engagement.openComments[target.post];
          setMessage("התוכן הזה לא נטען בפיד כרגע — אפשר לגלול או לרענן ולנסות שוב");
          rerender();
        }
      }, 60);
    } else if (target.event) {
      openEvent(target.event, "notification");
    } else if (target.profile) {
      viewCommunityProfile(target.profile);
    } else if (target.challenge) {
      // Same shape as the target.event branch just above: resolveNotifTarget
      // already puts the tab on "boards", this opens the specific challenge
      // detail on top of it (challenge_ending_soon/challenge_update).
      openChallenge(target.challenge, "notification");
    } else if (target.announcement) {
      // Announcements render inline in the feed (there is no separate
      // announcement dialog) - data-announcement-id on both the pinned card
      // and the plain list rows (renderFeedTab) is the anchor, the same
      // scrollIntoView pattern target.post already uses off data-post-id.
      // loadAnnouncements() runs in the boot Promise.all, not lazily on tab
      // entry, so the row is already in the DOM once the feed tab renders.
      rerender();
      setTimeout(() => {
        const sel = '[data-announcement-id="' + String(target.announcement).replace(/"/g, '\\"') + '"]';
        const node = document.querySelector(sel);
        // Real device feedback ("the feed is getting too long"): older
        // archive rows now sit behind a closed <details> disclosure - a
        // closed one collapses its content to zero height, so scrolling to
        // a node inside it lands on an invisible target. Open it first.
        const details = node && node.closest("details");
        if (details && !details.open) details.open = true;
        // KEYED ON THE NODE'S EXISTENCE, not on whether it can be scrolled to.
        // My first version wrote this as `else` on the scrollIntoView test,
        // which conflates two different facts: a node that is present but
        // whose environment has no scrollIntoView would have been reported as
        // deleted. A regression test caught it immediately, which is the
        // whole argument for writing the test before believing the fix.
        if (!node) setMessage("ההודעה הזו כבר לא זמינה");
        else if (node.scrollIntoView) node.scrollIntoView({ block: "center" });
        // SAY SO WHEN IT IS GONE. Live bug hunt, fresh round 4 (2026-09-15) -
        // sibling drift inside one function. target.post got exactly this
        // fallback on 2026-09-11; the announcement and achievement branches
        // below were written from the same scrollIntoView pattern and never
        // given it. An announcement that has since been archived or deleted
        // closed the notification centre, switched tabs, and then did
        // nothing at all - indistinguishable, from the member's side, from a
        // tap that simply did not register.
      }, 60);
    } else if (target.achievement) {
      // data-achievement-id on renderMyAchievements()'s own rows is the
      // anchor (added alongside this fix - there was none before).
      // loadMyAchievements() also runs in the boot Promise.all, so the row
      // is already in state by the time the Account tab renders.
      rerender();
      setTimeout(() => {
        const sel = '[data-achievement-id="' + String(target.achievement).replace(/"/g, '\\"') + '"]';
        const node = document.querySelector(sel);
        // Same fallback as the announcement branch above, for the same
        // reason: a medal can be revoked or edited away (achievement_edit is
        // a real audit action here), and its notification outlives it. Keyed
        // on the node's existence, not on scrollability - see there.
        if (!node) setMessage("המדליה הזו כבר לא זמינה");
        else if (node.scrollIntoView) node.scrollIntoView({ block: "center" });
      }, 60);
    } else if (target.recapWeek !== undefined) {
      openRecap(target.recapWeek || null, "notification");
    } else if (target.recapMonth !== undefined) {
      // No dialog to open (see renderMonthlyRecapMemberSection's own
      // comment) - setCommunityTab("account") above already re-renders,
      // which re-arms the lazy `!state.recaps.monthly.loaded` load effect
      // (afterRenderCommunity) the first time a session reaches this tab.
      // Scrolling to data-monthly-recap-section is still worth doing on its
      // own timeout: a session that already visited Account this run has
      // the row cached and rendered immediately, with nothing else to
      // trigger the scroll.
      setTimeout(() => {
        const node = document.querySelector('[data-monthly-recap-section]');
        if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
      }, 60);
    } else {
      rerender();
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
    // The streak_risk_nudges module's one event, and the one place in this
    // change where a second row is written for a single tap on purpose.
    //
    // streak_risk_nudges is a scheduled server job (notif_streak_at_risk,
    // 202609100002) whose entire client footprint is a notification of one
    // type. notification_opened above already records that tap, but it
    // belongs to the `notifications` module in the event-to-module map, so
    // without this line the nudge module stays exactly as unmeasurable as it
    // was - the tap would be counted, just never against the thing that
    // caused it. Two modules, two rows, and per-module unique_users stays
    // correct for both; the totals in query 2 are per module, not a sum.
    //
    // It does NOT count for WCAM. notification_opened fires on the same tap
    // and already counts that member once; counting again would change
    // nothing except the number of ways one action can appear.
    if (row.type === "streak_at_risk") track(A.STREAK_NUDGE_OPENED, { was_unread: !!row._wasUnread });
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
    // The client label wins over the stored one. notif_create() is called
    // with a hardcoded ENGLISH title for every immediate type except
    // announcement ('Achievement unlocked', 'New comment on your post',
    // 'Event cancelled', ...), so taking r.title first leaked English into
    // an otherwise all-Hebrew centre. announcement is the one type whose
    // stored title is real per-row content rather than a type label, and
    // NOTIF_TYPES marks it serverTitle. r.title remains the last resort for
    // a future type this client does not know, the same fallback
    // renderNotifBatchGroup already relies on.
    const title = esc((def.serverTitle && r.title) || def.title || r.title || "");
    const bodyHtml = r.body ? `<span style="display:block;color:var(--steel);font-size:12.5px;margin-top:2px;">${esc(r.body)}</span>` : "";
    return `<button class="log-row" data-community-action="notif-open" data-id="${esc(r.id)}" data-notif-mode="${esc(def.mode || "immediate")}" style="width:100%;text-align:right;background:none;border:0;border-inline-start:3px solid ${emphasise ? "var(--energy)" : "transparent"};padding:8px 10px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;">
      <span aria-hidden="true" style="font-size:18px;line-height:1.2;">${esc(def.icon)}</span>
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${title}</span>
        ${bodyHtml}
        <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${esc(relativeTime(r.created_at))}</span>
      </span>
    </button>`;
  }
  // COMM-142. A batched notification renders as one collapsed row that
  // expands. Consecutive rows of the same batched type fold into one
  // group. Windows are server-side; this only renders what came back.
  function renderNotifBatchGroup(group, c) {
    const def = notifTypeDef(group[0].type) || { icon: "🔔", title: group[0].title || "התראה" };
    // Live bug hunt (2026-09-11): was group[0].id - a realtime INSERT
    // unshift()s the new row onto the FRONT of c.rows (onNotifRealtime()
    // above), which becomes the new group[0] on the very next render. That
    // changed this key out from under an already-open group, so
    // c.expanded[key] read undefined and a group a member was mid-reading
    // silently snapped shut. The group's LAST (oldest) row's id is what
    // actually stays stable when new rows get prepended to the front -
    // confirmed live against the same mock.emitRealtime() harness
    // test/community-notifications.test.mjs already uses.
    const key = group[0].type + ":" + group[group.length - 1].id;
    const open = !!c.expanded[key];
    const emphasise = group.some((g) => g._wasUnread);
    return `<div class="notif-group${emphasise ? " emphasise" : ""}" data-notif-group="${esc(key)}">
      <button class="link-btn" data-community-action="notif-toggle-group" data-key="${esc(key)}" aria-expanded="${open ? "true" : "false"}" style="display:flex;gap:10px;align-items:center;width:100%;text-align:right;padding:8px 10px;">
        <span aria-hidden="true" style="font-size:18px;">${esc(def.icon)}</span>
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${esc(def.title)}${group.length > 1 ? " · " + group.length : ""}</span>
          <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${esc(relativeTime(group[0].created_at))}</span>
        </span>
        <span aria-hidden="true">${open ? "▲" : "▼"}</span>
      </button>
      ${open ? `<div class="notif-group-body">${group.map(renderNotifRow).join("")}</div>` : ""}
    </div>`;
  }
  function renderNotifCategoryRows(rows, c) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (classifyNotification(r) !== "batched") { out.push(renderNotifRow(r)); i++; continue; }
      const group = [r];
      let j = i + 1;
      while (j < rows.length && rows[j].type === r.type) { group.push(rows[j]); j++; }
      i = j;
      out.push(renderNotifBatchGroup(group, c));
    }
    return out.join("");
  }
  function notifRowCategory(r) {
    const def = notifTypeDef(r.type);
    return (def && def.category) || r.category || "community";
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
        return `<div class="ach-section" style="margin-top:14px;">${sectionHead("var(--blue)", cat.label)}<div class="log-list">${renderNotifCategoryRows(rows, c)}</div></div>`;
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

  // COMM-144/229. The Preferences panel, rendered in the Account tab.
  function renderNotifPrefsPanel() {
    // COMM-229. pushOn mirrors the state.featureFlags.notifPush check every
    // other push code path uses.
    //
    // Real device feedback from when the flag was off by default (it is on
    // as of 2026-09-17; this branch still runs for anyone who set the
    // localStorage escape hatch, and on a browser with no push support):
    // the push button used to still render - disabled, labelled "התראת
    // דחיפה · בקרוב" - and that one long, non-functional label was roughly
    // 3x the width of "באפליקציה"/"כבוי" beside it, unbalancing every row
    // on the panel. The push OPTION itself is now omitted entirely while
    // the flag is off, not just visually de-emphasized: two buttons
    // (in_app/off), not three, and no "coming soon" mention anywhere on
    // the panel. THE SUBSCRIBE/REVOKE/DEEP-LINK MACHINERY BELOW THIS
    // FUNCTION IS UNTOUCHED - notifPushEnabled(), notifPushUnsupportedReason(),
    // registerPushSubscription, disableNotifPush, sw.js's push/
    // notificationclick handlers, communityHandlePushDeepLink - all of it
    // stays exactly as built and exactly as tested. The moment
    // state.featureFlags.notifPush is ever flipped on, this function's
    // `pushOn` branch below renders the full three-button row again,
    // badge/revoke-control/browser-unsupported-explanation included,
    // unchanged from before this pass - nothing here is a deletion of
    // that engineering, only of a button with nothing behind it yet.
    const pushOn = notifPushEnabled();
    const pushReason = pushOn ? notifPushUnsupportedReason() : null;
    const pushDisabled = !!pushReason;
    const rowFor = (t) => {
      const stored = state.notif.prefs[t.key] || "in_app";
      const eff = (stored === "push" && !pushOn) ? "in_app" : stored;
      const saving = !!state.notif.prefSaving[t.key];
      const btn = (ch, label, disabled, title) =>
        `<button type="button" class="chip-btn${eff === ch ? " selected" : ""}" data-community-action="notif-pref" data-type="${t.key}" data-channel="${ch}"${(disabled || saving) ? " disabled" : ""}${disabled && title ? ` aria-disabled="true" title="${esc(title)}"` : ""}>${label}</button>`;
      const noteHtml = t.note ? `<span style="color:var(--steel);font-size:11px;">${esc(t.note)}</span>` : "";
      // Populated (COMM-229 frontend states): an active subscription on
      // THIS device shows "פעיל" next to the push option, only for a row
      // whose effective channel actually is push. Empty (push never opted
      // into) renders no badge at all - the row looks exactly like any
      // other channel, per the ticket's own wording.
      const pushBadge = (pushOn && eff === "push" && state.notif.pushSub)
        ? `<span style="color:var(--green);font-size:11px;">פעיל</span>` : "";
      // Only reachable once pushOn is true (a browser-unsupported reason
      // cannot exist while the flag itself is off) - the V1-default "בקרוב"
      // case that used to live here has no button to explain any more.
      const explainHtml = pushDisabled
        ? `<span style="color:var(--steel);font-size:11px;">${esc(pushReason)}</span>` : "";
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <span style="font-size:13px;">${esc(t.label)}</span>
        ${noteHtml}
        <div class="chip-row" role="group" aria-label="${esc(t.label)}" style="margin-top:0;">
          ${pushOn ? btn("push", "התראת דחיפה", pushDisabled, pushDisabled ? pushReason : null) : ""}
          ${pushBadge}
          ${btn("in_app", "באפליקציה", false)}
          ${btn("off", "כבוי", false)}
        </div>
        ${explainHtml}
      </div>`;
    };
    // `staffOnly` (currently just `new_report`) is hidden from a plain
    // member: that type is never delivered to one (mod_alert_recipients()
    // is moderators/admin/owner only), so showing the toggle to everyone
    // would be a control that never does anything for most members. Same
    // permission pair the moderation queue itself gates on (hasPerm/isAdmin
    // above the queue render, and mod_alert_recipients() on the server).
    const visiblePrefTypes = NOTIF_PREF_TYPES.filter((t) => !t.staffOnly || hasPerm(PERM.COMMENT_MODERATE) || isAdmin());
    const rows = state.notif.prefsLoaded
      ? visiblePrefTypes.map(rowFor).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    // COMM-229. One device-level control, not one per row: a
    // PushSubscription is per browser/device, so "turn push off" is a
    // single action here rather than duplicated ten times. Shown only once
    // the flag is on and this device actually has an active subscription.
    const deviceStatusHtml = (pushOn && state.notif.pushSub)
      ? `<div class="chip-row" style="margin-top:0;margin-bottom:8px;align-items:center;"><span style="font-size:12px;color:var(--steel);">התראות דחיפה פעילות במכשיר זה.</span><button type="button" class="link-btn" data-community-action="notif-push-disable">כיבוי במכשיר זה</button></div>`
      : "";
    // The "push is coming in a future version" sentence only makes sense
    // next to a push option a member can actually see - with the flag off
    // (V1 default) there is no such option on this panel any more, so the
    // copy no longer promises one.
    const introHtml = "בחרו איך כל סוג התראה מגיע אליכם. הודעות תפעוליות מהמועדון תמיד יופיעו כאן, גם אם כיביתם אותן.";
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--brass)", "העדפות התראות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">${introHtml}</div>
      ${deviceStatusHtml}
      <div class="log-list">${rows}</div>
      ${renderPushSelfTestPanel()}
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
      resultHtml = `<div role="status" style="color:var(--steel);font-size:12px;margin-top:6px;">לא התקבלה התראה. בדקו שהתראות מהאפליקציה מאושרות בהגדרות המכשיר, ושהאפליקציה פתוחה מהמסך הבית ולא מהדפדפן.</div>`;
    } else if (st.status === "failed") {
      resultHtml = `<div role="alert" style="color:var(--steel);font-size:12px;margin-top:6px;">${esc(st.reason || "לא ניתן היה לשלוח התראת בדיקה.")}</div>`;
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
  // Published beside notifRoute/classifyNotification/notifResolveTarget for
  // the same reason those are: they are pure answers about the current
  // environment with no side effect, and the permission gate in particular is
  // a rule that has to be assertable from outside the scope it lives in.
  window.communityDisplayMode = communityDisplayMode;
  window.communityPlatformBucket = communityPlatformBucket;
  window.pushAskGateReason = pushAskGateReason;
  window.notifRoute = notifRoute;
  window.classifyNotification = classifyNotification;
  window.notifResolveTarget = resolveNotifTarget;
