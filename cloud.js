"use strict";
// WHY THIS FILE IS NO LONGER AN IIFE.
//
// Splitting the community layer into src/community/*.js needs those files to
// see what this one declares - state, rerender, client, setMessage - and a
// separate classic <script> cannot reach into another script's IIFE. Real
// browsers share one global LEXICAL environment across classic <script>
// tags (the same property src/constants.js's own header describes, and the
// reason test/helpers/boot.mjs concatenates the app's src files before
// eval'ing them: jsdom does not reproduce it). Dropping the wrapper is what
// puts this file and src/community/*.js in that one shared scope, with no
// call-site changes anywhere.
//
// The body below is still indented two spaces. That is deliberate: it keeps
// this commit's diff to the five lines that actually changed rather than
// reindenting 22,000, and every source-text test that anchors on the old
// indentation keeps matching.
//
// The cost is that these 1,132 top-level names are now global. Exactly five
// of them already existed in a sibling classic script, and each is resolved
// where it is declared: esc, cssSel and cleanStr are `var` here because
// src/constants.js declares the same three with `var` (var + var is legal
// and both bind the identical window.BoxLogSafe function); bidiText is `var`
// here and in app.js for the same reason; and isIOSDevice was renamed to
// communityIsIOSDevice, because app.js has its own near-copy and a silent
// last-declaration-wins merge of two drifted implementations is precisely
// the defect CLAUDE.md's "sibling drift" rule is about.
  // COMM-367/COMM-368. THE HTML escape for every template literal in this
  // file - ~370 call sites. Until COMM-367 this file carried its own
  // byte-identical local copy called esc(), so a hardening fix to the
  // escape had to be made twice; now there is exactly one definition, in
  // src/shared/safe-helpers.js, shared with app.js and (by design) with the
  // sibling Box Log client.
  //
  // Read off window, not as a bare identifier, for the same reason every
  // other platform module is (eventbus/analytics/realtime/image): this file
  // is its own IIFE and jsdom does not share a lexical environment across
  // separately-eval'd classic scripts the way a browser does. Reached
  // unguarded, and deliberately: safe-helpers.js is the first script
  // index.html loads and a REQUIRED service-worker precache asset, so it is
  // always there - and an escape function is the one dependency that must
  // fail loudly rather than degrade to a no-op fallback that would ship XSS.
  var esc = window.BoxLogSafe.esc;
  // Security hunt (2026-09-11): first real call site - navigateToNotifTarget()
  // below used a naive manual escape instead. See that call site's own comment.
  var cssSel = window.BoxLogSafe.cssSel;
  // Live bug hunt (2026-09-11): saveProfile()/postAnnouncement()/
  // setWeeklyChallenge() sanitized human-typed text with only
  // `.trim().slice(N)` - no control-char, bidi-override, or zero-width
  // stripping at all. Confirmed live: a display name typed as
  // "safe_photo" + RLO + "gnp.exe" was stored verbatim and painted as
  // "safe_photoexe.png" everywhere it renders (profile, feed author,
  // search). app.js has used SAFE.cleanStr for every untrusted text field
  // since COMM-368; cloud.js never bound it at all, so it silently missed
  // the same coverage.
  var cleanStr = window.BoxLogSafe.cleanStr;
  const cfg = window.HAIMUNIA_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl || "") && !!cfg.supabasePublishableKey;
  const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    // detectSessionInUrl stays false: this app never uses OAuth, magic
    // links, or email confirmation (COMMUNITY_SETUP.md - email delivery is
    // permanently out of scope), so there is no flow it serves. Left true it
    // makes supabase-js adopt any #access_token=...&refresh_token=... found
    // in the URL fragment on every load - a one-click session-fixation
    // vector against a link-shareable, installable PWA. Launch-readiness
    // audit, SEC-013.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }) : null;
  // COMM-365. One state object, namespaced by feature domain.
  //
  // Until COMM-365 this was 139 flat sibling keys, grouped only by which
  // ticket added them and disambiguated only by hand-maintained name prefixes
  // (feedScope / challengeView / coachCelebrate / modQueueStatus...). Every new
  // feature cluster grew the same one namespace, so the prefix convention was
  // the only thing keeping two clusters from colliding on a name like `view`,
  // `items`, `loading` or `error`.
  //
  // Now each cluster owns a sub-object and the prefix is the namespace:
  // state.posts.prPrompt, state.notif.center, state.ui.message. Two domains can both have `.loading` and
  // `.error` without either one having to invent a longer name.
  //
  // The ROOT of the object is deliberately NOT a domain. It holds only the
  // session/auth/config core that every domain reads and no domain owns:
  // `configured`/`client` (the Supabase wiring), `user`/`profile`/`redemption`
  // (who is signed in and what they are), `syncEnabled` and `featureFlags`
  // (localStorage-backed, read once at module init) and the boot guard.
  // Namespacing those would only add a level of indirection to the most-read
  // keys in the file without separating anything.
  //
  // Sub-object identity matters: nothing ever replaces a whole namespace
  // (state.posts = {...} would silently drop keys the sign-out reset does not
  // list). Every write is to a leaf.
  const state = {
    // ---- session / auth / config core (see above: intentionally flat) ----
    configured, client, user: null, profile: null, redemption: null,
    // Launch-readiness audit, CQ-006 - see loadProfile()/loadRedemption().
    profileLoadError: false, redemptionLoadError: false,
    syncEnabled: localStorage.getItem("haimunia-demo:cloudSyncEnabled") === "1",
    signupStarted: false,
    // COMM-331. Guards ensureCommunityDataLoaded()'s feed/streaks/
    // announcements/etc. cascade so it fires once, the first time the
    // Community tab actually renders, instead of on every cold boot. See
    // that function's own comment for exactly which loaders this covers
    // and, just as importantly, which ones it deliberately does NOT (kept
    // eager in refreshSession()/onAuthStateChange instead, because a
    // cross-tab consumer needs them regardless of whether Community was
    // ever opened).
    communityDataLoaded: false, communityDataLoading: false,
    
    // COACHENGAGE IS GONE (N3). COMM-226 shipped the coach-engage section behind
    // a per-device localStorage flag, default off; COMM-304 built the producer
    // and flipped it on. What was left was a switch every coach carried their
    // own copy of: an admin could not turn the section off for the club, two
    // coaches could disagree about whether it existed, and clearing site data
    // turned it back on. The section now reads isModuleEnabled("engagement_alerts"),
    // the club switch that 202609100002 already uses to gate
    // coach_notify_engagement_flags(), so the alert and the dashboard it belongs
    // to answer to one control. The default does not move: that key ships
    // enabled and the device flag defaulted on.
    //
    // NOTIFPUSH STAYS, AND ITS COMMENT WAS WRONG. It used to say push "stays
    // default off in production until VAPID keys are provisioned", while the
    // code reads `!== "0"` - default ON. Both halves were true of different
    // things, which is how it survived: this device flag defaults ON, and push
    // is nevertheless off in production because notifPushEnabled()
    // (notifications.js) ANDs it with the push_notifications CLUB module, which
    // ships disabled and is enforced server-side in notif_push_pending. The
    // club switch is what keeps push off; this flag is only a per-device escape
    // hatch, and a test flips it via bootCommunity's localStorage hook before
    // module load rather than by mutating state afterwards.
    featureFlags: { notifPush: localStorage.getItem("haimunia-demo:notifPushFlag") !== "0" },

    // ---- ui: the community tab shell ----
    // tab is which community sub-tab is showing. message is the one status
    // line every surface writes through setMessage(). fieldErrors is keyed by
    // form+field (see field()). confirmDialog is the shared confirm sheet.
    // manageTab is the active sub-tab of the separate "ניהול" (Manage) top-
    // level tab - its own field, not reusing `tab`, since a staff member can
    // leave Manage and come back without losing their place in either.
    // manageTab defaults to "invites" - the "הוספת חבר/ה" tab - because that
    // is the thing a gym manager opens ניהול to do most weeks. It was
    // "dashboard" until the operator-depth rework, which retired that tab
    // (see MANAGE_TAB_ALIASES). manageScrollTo is a one-shot section id
    // consumed by afterRenderManage() - see setManageTab().
    ui: { tab: "feed", message: "", fieldErrors: {}, confirmDialog: null, backupDeleteConfirm: false, selfExportBusy: false,
      // Launch-readiness audit, RELIABILITY. The invite code the member
      // is typing, kept in state for the same reason reportNote and the
      // comment drafts are: this app re-renders by replacing #content's
      // innerHTML, so ANY background render (maybeAutoStartBackup()'s
      // "your workouts are backed up" message is the one that actually
      // hit this) swapped the form for a fresh one and silently erased
      // what had been typed. A member then submitted an empty code and
      // got "code required" for a code they had just entered.
      inviteCodeDraft: "",
      // Live bug hunt round 5 (2026-09-11): redeemCode()'s in-flight guard -
      // see its own comment. Declared here like every other ui leaf
      // (community-state-namespaces.test.mjs enforces this).
      redeemingCode: false,
      // Design spec section 7. Which of the community gate's THREE screens is
      // showing while there is still no redemption: "" is the neutral choice
      // screen (what the club is, then "יש לי קוד הזמנה" as the primary
      // action), "login" is the credential form on a screen of its own.
      //
      // A SEPARATE FIELD RATHER THAN A THIRD STATE OF signupStarted, because
      // the two answer different questions and conflating them is what would
      // break the QR deep link: signupStarted means "this person is joining"
      // (captureInviteDeepLink sets it, ensureAnonymousSession keys off it),
      // while gateView only decides which of the two pre-signup screens to
      // paint. Keeping them apart is what lets "כבר יש לכם חשבון? התחברות" on
      // the invite step land a QR scanner directly on the login FORM - clear
      // one flag, set the other - rather than on the choice screen, which
      // would have made 9c15214's way back one tap longer than it is today.
      gateView: "",
      // The term sheet (design spec section 3, tier 3): the id of the
      // glossary entry being explained, or null. Lives in ui rather than a
      // namespace of its own for the same reason confirmDialog does - it is
      // shell furniture that any surface can raise, owned by no feature.
      termSheet: null,
      // The full glossary list, pushed onto the same sheet from its
      // "כל המונחים" row. A boolean, not a second dialog: it is the same
      // sheet showing a different page, so it shares the focus trap, the
      // Escape handler and the backdrop click rather than duplicating them.
      termGlossaryOpen: false },


    // ---- posts: composing, own-post controls, sharing (COMM-100..108) ----
    // openMenu is the post id whose "..." menu is open; savedIds is the
    // caller's own saved-post set; comparison/comparisonForPostId are the
    // inline compare strip, scoped to the one post that asked for it.
    posts: {
      // The posts the client holds for the screen that draws them (see
      // window.holdPosts); nothing loads them in this build.
      held: [],
      openMenu: null, 
      captionEdit: null, prPrompt: null, workoutPrompt: null, openShare: {},
      
      // Five-persona UX audit, outward sharing. The share-outside-the-app
      // sheet: { subject, caption, showName, spec, status, previewUrl, blob,
      // sharing, result }. Lives in `posts` rather than a namespace of its
      // own because this domain is already "composing, own-post controls,
      // sharing" and every one of its subjects is a post or a post's source
      // record. Holds a Blob and an object URL, so closeOutwardShare() is the
      // only way it is cleared - it revokes the URL on the way out.
      outwardShare: null,
      // 202609220005 "התאמנו יחד". Two separate things, deliberately not one:
      //   partners: post_id -> the tag rows the server returned for it, as
      //     post_training_partners_for() ordered them. Read by every card,
      //     written only by loadTrainingPartners(). A post with no entry has
      //     not been asked about yet; a post with [] has been asked about and
      //     carries no tags - the card must not confuse the two, or an
      //     unloaded page renders "no partners" for every post on it.
      //   partnersPanel: the author's open tagging sheet for ONE post -
      //     { postId, day, suggestions, picked, loading, saving, error }.
      //     Null when closed, the shape captionEdit
      //     already uses for a per-post inline editor.
      partners: {}, partnersPanel: null,
    },

    // ---- engagement: comments, replies, reactions, mentions (COMM-120..125) ----
    engagement: {
      
      
      reactions: {}, reactionError: null, 
      // The post id whose "who reacted" sheet is open, or null. A dialog, so
      // it starts closed and lives in CLOUD_DIALOGS like every other one.
      reactorsFor: null,
    },

    // ---- members: search results, directory, follow/block, profiles ----
    members: {
      // COMM-228. `people` is community_search()'s members group and keeps
      // its exact row shape - it is what the follow/block/profile controls
      // read. `search`/`results` are the older standalone member lookup.
      
      blockedIds: [], blocksLoaded: false, 
      
      // Live bug hunt (2026-09-11): blockedIds merges BOTH directions (who I
      // blocked AND who blocked me) into one set, by design, for the
      // comment/reaction-hiding check (isBlockedUser()) - it never needed to
      // distinguish direction before. Unblocking does: only a block I
      // initiated is mine to undo. blockedByMe is that subset, with names
      // fetched the same second-read way loadRestrictions() already does
      // ("a missing display name must degrade... rather than lose the row").
      blockedByMe: [], blockedByMeNames: {}, blockedByMeLoaded: false, unblocking: "",
      
    },








    // ---- achievements (COMM-130/134) ----
    achievements: { mine: [], unlock: null },

    // ---- notif (COMM-140..144) ----
    // COMM-229. Web push is device-level (one PushSubscription per
    // browser/device backs every type whose preference is "push" -
    // notifRoute still decides per type whether that channel is used).
    // pushSub is this device's existing push_subscriptions row once confirmed
    // unrevoked (null until checked, or genuinely none). pushChecked guards
    // the lazy load (window.afterRenderCommunity) to once per flag-on session,
    // the same way coach.engage's own .loaded guards its own lazy load.
    notif: {
      center: null, unread: 0, unreadLoaded: false,
      prefs: {}, prefsLoaded: false, prefSaving: {},
      pushSub: null, pushChecked: false,
      // The account-settings push self-test. status walks
      // idle -> sending -> waiting -> received | not_received | failed, and
      // it is per device and per page load on purpose: "did a notification
      // reach THIS phone just now" is not a fact worth persisting, and a
      // stored answer from last week would be worse than no answer.
      // id is the token the service worker echoes back, so a receipt from an
      // earlier run cannot resolve a later one. reason carries the Hebrew
      // sentence for the failed branch.
      selfTest: { status: "idle", id: "", reason: "" },
    },





    // ---- coach: the Coach Dashboard sub-tab (COMM-223..226, 309, 315) ----
    // Only ever added to the tab bar for isStaff(), see the render function -
    // Celebrate, Welcome, Engage, Member of the Week, Monthly recap preview.
    // Challenges re-surfaces renderChallengesListSection() unchanged, so it
    // has no state of its own here.
    // Launch-readiness audit, RELIABILITY. The community write queue's
    // view-model: `pending` is how many writes are waiting to go out (a
    // count is all the banner needs), `failed` holds the full rows for the
    // ones that gave up, because each needs its own retry/discard control
    // and its own error text. Populated by refreshOutboxState().
    outbox: { pending: 0, failed: [] },
  };

  // --- COMM-170 / COMM-233 analytics -------------------------------------
  // The tracked event names (COMM-013) and the one call into the helper.
  // COMM-170 wired the Phase 1 surfaces, COMM-233 the Phase 2 ones.
  // Every call below is a measurement of something that already happened:
  // nothing is awaited, nothing sets a message, and nothing here can fail
  // in a way a member sees. Props carry ids, enums, counts and booleans
  // only - never a display name, a handle, a caption, a comment body or a
  // report note. The full event-to-surface table is in
  // docs/community/metrics.md.
  const A = window.ANALYTICS_EVENTS || {};
  function track(eventName, props) {
    if (!eventName) return;
    try { if (typeof window.analyticsTrack === "function") window.analyticsTrack(eventName, props); } catch (e) {}
  }
  // configure() has to run BEFORE the first track(): an unconfigured
  // analyticsTrack() is an inert no-op that silently drops the event. So
  // it sits at the head of the session-ready path, not the tail. getUserId
  // is a getter over state.user rather than a snapshot, which is why one
  // configure covers every later sign-out and sign-in without a second
  // call - and a second call would only replace the bus bridge anyway,
  // never stack it.
  let analyticsConfigured = false;
  function ensureAnalyticsConfigured() {
    if (analyticsConfigured || !client || !window.HaimuniaAnalytics) return false;
    analyticsConfigured = true;
    window.HaimuniaAnalytics.configure({
      client,
      getUserId: () => (state.user ? state.user.id : null),
      // OFFLINE. An event recorded with no connection used to be dropped
      // outright. It now rides the community outbox as a SILENT row, which
      // means it is persisted in IndexedDB, drained on the same reconnect
      // the member's own queued writes are, and never shown to anybody:
      // it cannot become `failed`, cannot appear in the outbox banner and
      // cannot hold up a queued post behind it. See src/outbox.js.
      //
      // Returns true only once the enqueue has been ACCEPTED, and returns
      // false rather than throwing if the queue is unavailable - the old
      // behaviour, a dropped row, is the correct fallback for a
      // measurement.
      queueRow: (row) => {
        if (!window.HaimuniaOutbox || !state.user) return false;
        try {
          Promise.resolve(window.HaimuniaOutbox.enqueue(
            ANALYTICS_OUTBOX_ACTION,
            { row },
            { userId: state.user.id, silent: true }
          )).catch(() => {});
          return true;
        } catch (err) { return false; }
      },
    });
    // app_opened. One row per page load, written from the first moment there
    // is anything to write it with - which is also the earliest moment the
    // row can carry a user_id, and this event is only worth having per
    // member.
    //
    // WHY IT EXISTS. isStandalone() has been computed in app.js since the
    // install banner shipped, and app.js is where it stays; nothing ever sent
    // the answer anywhere, so "how many of our members actually installed the
    // app" - the question underneath the push gate, the iOS notification
    // line, the seven-day IndexedDB eviction on iOS Safari and every future
    // argument about whether an install banner is worth its screen space -
    // could only be answered by asking members one at a time.
    //
    // Two props, both coarse enums (communityDisplayMode /
    // communityPlatformBucket, src/community/notifications.js). Never the
    // user agent string: it is long enough to identify a device in a table
    // whose read grant is a permission rather than a role.
    //
    // It is NOT a WCAM event. Opening the app is not participating in the
    // club, and a session event that counted would make WCAM a measure of
    // installs.
    track(A.APP_OPENED, { display_mode: communityDisplayMode(), platform: communityPlatformBucket() });
    return true;
  }

  function rerender() { if (typeof window.render === "function") window.render(); }
  // COALESCED RERENDER, for data that ARRIVES rather than data the member
  // just changed.
  //
  // rerender() rebuilds the whole tab with one innerHTML write. That is a
  // measured, deliberate architecture (COMM-366's spike: ~4.9 ms, kept on
  // purpose) and it is fine ONCE. It is not fine N times in a row, and three
  // loaders here are per-item: ensureReactionsLoaded() fires one
  // loadReactionsFor() per rendered post card, and resolveAvatarUrl() /
  // resolvePhotoUrl() fire one signed-URL request per distinct image. Each
  // response independently called rerender(), so every card that came back
  // rebuilt the entire tab again.
  //
  // MEASURED, not assumed (scripts/browser-check/feed-rerender-storm.mjs):
  // one scroll to the bottom of a 30-post feed cost 11 full rebuilds, 8 of
  // them from loadReactionsFor alone. Every one of those 8 threw away and
  // rebuilt the DOM the previous one had just built, and each is a point
  // where focus, caret and scroll have to be restored by hand.
  //
  // requestAnimationFrame is the right window: responses that land in the
  // same frame paint once, and a frame is exactly the granularity the screen
  // can show anyway. jsdom provides rAF under pretendToBeVisual (which
  // test/helpers/boot.mjs sets), and the setTimeout fallback keeps this
  // working anywhere it does not.
  //
  // NOT used for anything the member did. A tap, a toggle, a submit still
  // calls rerender() synchronously: those need the DOM to reflect the action
  // before the handler returns, and deferring them by a frame would be a
  // visible lag on the one path where responsiveness is the whole point.
  let rerenderScheduled = false;
  function scheduleRerender() {
    if (rerenderScheduled) return;
    rerenderScheduled = true;
    const flush = () => { rerenderScheduled = false; rerender(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }
  // WHERE A CONFIRMATION APPEARS DECIDES WHETHER IT IS SEEN.
  //
  // state.ui.message is this app's single notice channel - 66 success
  // confirmations route through it ("הפוסט פורסם", "ההזמנה נוצרה",
  // "הפריט הוצמד"...). It rendered as a static line directly under the
  // sub-tab bar, at the very top of the document. Every control that raises
  // one of those messages is somewhere else: the invite panels, the
  // moderation queue, a post's own action row - all reached by scrolling well
  // past that line. So the confirmation painted off-screen, above where the
  // member or coach was actually looking. Feedback that exists and cannot be
  // seen is, to the person tapping, no feedback: reported as "I don't know if
  // I copied the text".
  //
  // Two faults, both fixed here:
  //   POSITION - anchored to the VIEWPORT now, just above the fixed bottom
  //     bar, so it appears where the eye already is whatever the scroll.
  //     role="status" is kept, so it is announced and not merely drawn.
  //   STALENESS - it was cleared in exactly three places, so a confirmation
  //     could survive later navigation and be read as the answer to something
  //     else entirely. It now clears itself.
  //
  // Per-control feedback (markCopied) still wins wherever the answer is about
  // one button among several; this channel is for everything else.
  let messageTimer = null;
  function setMessage(message) {
    state.ui.message = message || "";
    if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
    if (state.ui.message) {
      const shown = state.ui.message;
      messageTimer = setTimeout(() => {
        messageTimer = null;
        if (state.ui.message === shown) { state.ui.message = ""; rerender(); }
      }, 6000);
    }
    rerender();
  }
  // Cleared by markCopied() so a "הועתק ✓" from one control cannot linger
  // on screen after another copy, or after a panel is closed and reopened.
  let copyResetTimer = null;
  function participantsLabel(n) {
    const count = Number(n) || 0;
    return count === 1 ? "משתתף אחד" : `${count} משתתפים`;
  }
  // Live bug hunt (2026-09-11): admin/coach surfaces (invite lists, member
  // rows, ghost invites, the directory profile sheet) printed a raw ISO
  // date fragment ("2026-06-15") straight into otherwise-Hebrew-formatted
  // text instead of a localized date - unlocalized, not incorrect, but a
  // systemic pattern across every one of those surfaces. A light, compact
  // D.M.YYYY formatter for exactly the read-only-label call sites (never
  // touches anything feeding a form/<input type="date"> value - those keep
  // the raw ISO string, which is what the DOM requires there).
  function shortHebDate(iso) {
    const s = String(iso || "").slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    return `${Number(m[3])}.${Number(m[2])}.${Number(m[1])}`;
  }
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  // A REJECTED SUBMIT MUST NOT EMPTY THE FORM.
  //
  // Live bug hunt, fresh round 2 (2026-09-15) - HIGH, reproduced live on all
  // three forms of the join path. This calls rerender(), which replaces
  // #content's innerHTML wholesale, and these inputs are written as plain
  // HTML with no value= bound back to state. So a password one character
  // short of ten wiped the USERNAME too; a taken username wiped the password
  // and its confirmation; a mistyped login password wiped the username on
  // every attempt; an invalid club handle wiped a perfectly good display name
  // and bio.
  //
  // Every member creates an account through this path exactly once, on a
  // phone, in an RTL app with LTR credential fields, and there is no
  // self-service password reset to fall back on. Being made to retype
  // everything because one rule was missed is the kind of friction that ends
  // a signup.
  //
  // Restored from the DOM rather than by binding every input to state: the
  // invite-code field already does the state-binding version
  // (state.ui.inviteCodeDraft) and it takes a dedicated state key, a render
  // site and an input handler per field. This is one place, works for every
  // form, and cannot drift out of sync with what the member actually typed.
  //
  // ONLY ON REJECTION. Clearing errors after a SUCCESSFUL submit calls this
  // too, and a form that refilled itself on success would be worse than the
  // bug - so the snapshot is restored only when there is an error to show.
  function captureFormValues(form) {
    const out = {};
    if (!form || !form.elements) return out;
    for (const el of Array.prototype.slice.call(form.elements)) {
      if (!el.name || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
      if (el.type === "checkbox" || el.type === "radio") out[el.name] = { checked: !!el.checked };
      else out[el.name] = { value: el.value };
    }
    return out;
  }
  function restoreFormValues(formId, snapshot) {
    const form = document.getElementById(formId);
    if (!form || !form.elements || !snapshot) return;
    for (const name of Object.keys(snapshot)) {
      const el = form.elements[name];
      if (!el || typeof el.name !== "string") continue;
      const v = snapshot[name];
      if ("checked" in v) el.checked = v.checked;
      else el.value = v.value;
    }
  }
  function setFieldErrors(formId, errors) {
    const hasErrors = !!(errors && Object.keys(errors).length);
    const snapshot = hasErrors ? captureFormValues(document.getElementById(formId)) : null;
    if (hasErrors) state.ui.fieldErrors[formId] = errors;
    else delete state.ui.fieldErrors[formId];
    rerender();
    // rerender() is synchronous, so the rebuilt form is already in the DOM.
    if (snapshot) restoreFormValues(formId, snapshot);
  }
  // Compact, deterministic per-identity color so the same person always
  // gets the same avatar color across the feed, comments and search.
  const AVATAR_PALETTE = ["var(--energy)", "var(--blue)", "var(--teal)", "var(--purple)", "var(--green)", "var(--brass)"];
  function avatarHtml(name, size) {
    const px = size || 36;
    // Two conventions call this: some sites pass the bare handle
    // (`display_name || handle`), others the display string
    // (`display_name || "@" + handle`). For a member with no display name
    // the second gave every avatar the initial "@" and, because the colour
    // hash runs over the same label, a DIFFERENT colour from the first - so
    // one member showed up as a different badge in the directory than in
    // their own profile header. Dropping a leading "@" here makes both
    // conventions agree without touching eighteen call sites.
    const label = String(name || "?").trim().replace(/^@+/, "");
    const initial = label ? label[0].toUpperCase() : "?";
    let hash = 0;
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
    const color = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
    return `<span aria-hidden="true" class="avatar-badge" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.42)}px;background:${color};">${esc(initial)}</span>`;
  }
  // display_name is Hebrew and renders fine on its own; the "@handle"
  // fallback is a Latin run with a leading neutral "@" - in this app's RTL
  // paragraphs that "@" resolves to match the paragraph direction rather
  // than hugging the handle, so it paints as "handle@" instead of
  // "@handle". <bdi> isolates the run from the surrounding paragraph
  // direction the same way this problem is meant to be solved - no CSS
  // needed, and it degrades to plain text in a context that already
  // requires no HTML (there is none here).
  function nameHtml(displayName, handle) {
    // Live bug hunt (2026-09-11): bare esc() here (defense-in-depth on top
    // of the write-side cleanStr() fix in saveProfile() - a row written
    // before that fix shipped, or by any other future write path, could
    // still carry a bidi-override character) - bidiText() is the same
    // per-line isolation app.js already gives every human-typed field.
    return displayName ? bidiText(displayName) : `<bdi>@${esc(handle || "")}</bdi>`;
  }
  // The isolation nameHtml() applies to "@handle" is needed by EVERY string a
  // human typed, and there the failure is far worse than a misplaced "@". A
  // coach's pinned announcement reading
  //
  //     21-15-9 Thrusters + Pull-ups. Rx 43/30 ק״ג.
  //
  // rendered its rep scheme as 9-15-21, and in a second observed paint
  // stranded the ק״ג at the opposite end of the line from the 43/30 it
  // belongs to. Two personas hit this independently. The cause is the LTR
  // runs a workout is made of - rep schemes, English movement names,
  // weights, times - being reordered against the RTL Hebrew paragraph they
  // sit in. This is not a garbled string a member notices and ignores: it is
  // a plausible, valid-looking, DIFFERENT workout that a member can follow
  // without ever knowing it was not what the coach wrote.
  //
  // <bdi> rather than a CSS `unicode-bidi: isolate` (what .est-line and .mono
  // use): those two are LTR-only surfaces, but a body of free text sits in a
  // paragraph that must stay RTL for its Hebrew. Only <bdi>'s implicit
  // dir="auto" lets each run take its base direction from its own first
  // strong character - so the line above resolves LTR and reads 21-15-9,
  // while an ordinary Hebrew-first line still resolves RTL exactly as today.
  //
  // Isolation is per LINE, not per field. Bodies are multi-line and a workout
  // note routinely pairs a Hebrew intro line with an LTR rep-scheme line; one
  // dir="auto" over the whole field would resolve from the first line only
  // and leave every later line as broken as before. Joining the pieces back
  // on "\n" reproduces the original text exactly, so a `white-space:pre-wrap`
  // surface still breaks where it did and a collapsing one still collapses.
  //
  // ESCAPING IS UNCHANGED AND NON-NEGOTIABLE: esc() still runs over the text
  // and only its OUTPUT is wrapped. Never isolate before escaping. Never use
  // this in an attribute or inside <textarea>, where the tag would land as
  // literal characters instead of markup - those contexts keep bare esc().
  // BINDINGS, not definitions: bidiText/bidiHtml live in
  // src/shared/safe-helpers.js, reached the same way esc is at the head of
  // this IIFE. Promoted there when the run-level half of the fix landed - see
  // that module's header for the run rule, the RTL-line gate, and every
  // restriction on where these may be used. bidiHtml is the already-escaped
  // variant, for a comment body whose @mentions mentionMarkersToHtml() has
  // turned into buttons.
  var bidiText = window.BoxLogSafe.bidiText;
  const bidiHtml = window.BoxLogSafe.bidiHtml;
  // bidiUnit is the third: a MEASUREMENT (a number plus a Hebrew unit or a
  // Hebrew count word) whose base direction is stated RTL rather than
  // inferred. Every `.mono` readout in this file and in src/community/*.js
  // that puts a Hebrew word next to a number needs it - `.mono` declares
  // `direction:ltr`, which is right for a bare number and wrong the moment a
  // Hebrew word joins it (a challenge's "5 / 3 שבועות", a post's
  // "40% מהיעד הושלמו"). See the "CONTAINER level" section in
  // safe-helpers.js.
  //
  // The example that used to stand here was the feed's own streak chip, and
  // it is no longer an example of anything: streakDaysHtml() puts only the
  // digits inside `.mono`, so that row needs no isolation at all.
  // test/community-feed-polish.test.mjs scans this whole file for the old
  // phrasing and fails on it, comment or code - correctly, because a stale
  // example in a comment is how the old shape gets copied back in.
  // `var`, like bidiText directly above and for the identical reason: app.js
  // binds the same helper at ITS top level, and these two classic scripts
  // share one global lexical environment. `var` + `var` binding the identical
  // frozen function is legal; a `const` on either side is a redeclaration
  // SyntaxError that takes the whole app down at parse time.
  var bidiUnit = window.BoxLogSafe.bidiUnit;
  var bidiUnitHtml = window.BoxLogSafe.bidiUnitHtml;

  // ==========================================================================
  // JARGON DISCLOSURE (design spec section 3)
  //
  // THE DIAGNOSIS THAT MATTERS: the app already wrote this fix and hid it.
  // Four plain-Hebrew glosses have lived in #wodBuilderOverlay since COMM-324
  // ("זמן" -> "כמה מהר סיימתם", "AMRAP" -> "כמה סיבובים הספקתם", ...), behind
  // a comment saying they had been written once, lost, and deliberately put
  // back. They shipped at 9.5px - the smallest type in the app, explaining
  // the hardest words in the app - and behind an overlay with no reachable
  // opener. index.html:886 has since raised them to 13px on the shared
  // .term-sub rule. So the vocabulary below is NOT new copy: the four format
  // glosses are lifted VERBATIM from what the team already wrote, and the
  // rest are the spec's own table.
  //
  // THREE TIERS, one vocabulary, one glossary:
  //
  //   Tier 1 - a permanent inline gloss (.term-sub) under a term that LABELS
  //            A CONTROL. Always on, for everyone, including experts: one
  //            line under a chip you are choosing between helps a ten-year
  //            athlete too. This is the existing "רישום סולם / סופרסט"
  //            pattern, which the beginner persona singled out as the one
  //            thing the app already did right.
  //   Tier 2 - a `?` marker (.term-mark) after a term that appears inside
  //            CONTENT. First occurrence only, at most 4 per screen, and it
  //            AUTO-RETIRES after three sheets have been opened.
  //   Tier 3 - a bottom sheet (this file's termSheet dialog) that never
  //            blocks a tap and never covers the thing being explained.
  //
  // WHAT IS DELIBERATELY *NOT* HERE: Hebrew translations of movement names.
  // "Back Squat" and "Fran" are what the coach says on the floor of an
  // Israeli box - they are the vernacular, not jargon. The distinction this
  // whole section rests on is between a NAME that needs no translation and a
  // CONCEPT that needs an explanation. AMRAP and Rx are concepts. Thruster is
  // a name, and the entry for it explains the movement rather than renaming
  // it. src/constants.js's CATEGORY_LABELS is untouched for the same reason.
  //
  // `term` is printed as-is and is the sheet's heading; `gloss` is the
  // one-line tier-1/tier-2 headline (max ~28 Hebrew characters so it fits one
  // line at 390px - if it does not fit, shorten the gloss, never shrink the
  // type); `body` is the sheet's explanation. Keys are lowercased for lookup.
  const TERM_GLOSSARY = Object.freeze([
    { id: "wod", term: "WOD", gloss: "אימון היום", body: "האימון היומי המשותף. ראשי תיבות של Workout Of the Day." },
    { id: "amrap", term: "AMRAP", gloss: "כמה סיבובים הספקתם", body: "עובדים בזמן קבוע — נניח 20 דקות — וסופרים כמה סיבובים שלמים הספקתם. אין \"לסיים\", יש \"כמה\"." },
    { id: "emom", term: "EMOM", gloss: "תרגיל חדש כל דקה", body: "בתחילת כל דקה מתחילים את התרגיל הבא. מה שנשאר מהדקה הוא המנוחה שלכם." },
    { id: "fortime", term: "For Time", gloss: "כמה מהר סיימתם", body: "עושים את כל מה שכתוב, כמה שיותר מהר, ורושמים את הזמן." },
    { id: "rx", term: "Rx", gloss: "במשקלים המלאים שנכתבו", body: "האימון בדיוק כפי שנכתב — אותם משקלים, אותן חזרות." },
    { id: "scaled", term: "Scaled", gloss: "בהתאמה אישית", body: "אותו אימון, במשקלים או בתרגילים שמתאימים לכם. זו הבחירה של רוב המתאמנים, וזה נחשב בדיוק אותו אימון." },
    { id: "1rm", term: "1RM", gloss: "הערכה של המשקל המרבי לחזרה אחת", body: "חישוב בלבד, לפי המשקל והחזרות שרשמתם — לא משקל שהרמתם בפועל." },
    { id: "pr", term: "שיא אישי (PR)", gloss: "התוצאה הכי טובה שלכם עד היום", body: "בתרגיל הזה, מאז שהתחלתם לרשום כאן. לא השוואה לאף אחד אחר." },
    { id: "repscheme", term: "21-15-9", gloss: "מספר החזרות בכל סיבוב", body: "שלושה סיבובים: בראשון 21 חזרות מכל תרגיל, בשני 15, בשלישי 9." },
    { id: "thruster", term: "Thruster", gloss: "סקוואט קדמי ודחיפה מעל הראש", body: "תנועה אחת רציפה: עולים מהסקוואט ומיד דוחפים את המוט מעל הראש." },
    { id: "hspu", term: "HSPU", gloss: "שכיבת סמיכה בעמידת ידיים", body: "Handstand Push-Up. דחיפה כלפי מעלה מעמידת ידיים, בדרך כלל בעזרת הקיר." },
    { id: "ohs", term: "OHS", gloss: "סקוואט עם מוט מעל הראש", body: "Overhead Squat. סקוואט כשהמוט מוחזק ישר מעל הראש בידיים פשוטות." },
    { id: "doubleunders", term: "Double-unders", gloss: "שני סיבובי חבל בכל קפיצה", body: "בדילגית — החבל מספיק להסתובב פעמיים לפני שהרגליים נוחתות." },
    { id: "kbswing", term: "KB swing", gloss: "נדנוד קטלבל", body: "מניפים משקולת כדור מבין הרגליים ולמעלה, בכוח שמגיע מהירכיים ולא מהידיים." },
    { id: "wallball", term: "Wall Ball", gloss: "סקוואט וזריקת כדור לקיר", body: "יורדים לסקוואט עם כדור כבד, ובעלייה זורקים אותו לסימן על הקיר." },
    { id: "muscleup", term: "Muscle-up", gloss: "עלייה מהמתח אל מעל המוט", body: "מתח, ואז דחיפה שמעבירה את הגוף מעל המוט או הטבעות בתנועה אחת." },
    { id: "pistol", term: "Pistol", gloss: "סקוואט על רגל אחת", body: "יורדים לסקוואט מלא על רגל אחת, כשהשנייה מושטת קדימה." },
    { id: "superset", term: "סולם / סופרסט", gloss: "כמה סטים ברצף", body: "כמה סטים ברצף — אותו תרגיל במשקלים שונים, או שני תרגילים לסירוגין." },
    // Fresh-eyes audit: a trainee-persona review named these two, from the
    // WOD catalogue's own benchmark descriptions ("Isabel — 30 Snatches",
    // "Grace — 30 Clean & Jerks"), as unexplained jargon this glossary
    // never covered.
    { id: "snatch", term: "Snatch", gloss: "מהרצפה ישר מעל הראש בתנועה אחת", body: "המוט עולה מהרצפה ישר מעל הראש, בתנועה רציפה אחת, בלי לעצור בכתפיים בדרך." },
    { id: "cleanjerk", term: "Clean & Jerk", gloss: "לכתפיים, ואז דחיפה מעל הראש", body: "שתי תנועות: ה-Clean מרים את המוט מהרצפה לכתפיים, ואז ה-Jerk דוחף אותו מהכתפיים מעל הראש." },
  ]);
  const TERM_BY_ID = Object.create(null);
  for (const t of TERM_GLOSSARY) TERM_BY_ID[t.id] = t;
  function termById(id) { return TERM_BY_ID[String(id || "")] || null; }

  // ---- Tier 2's off-switches -----------------------------------------------
  // Two of them, and they are different things on purpose (spec 3.5).
  //
  //   AUTO-RETIRE is the one that matters. After a member has opened three
  //   term sheets they have demonstrated they know how this works, so the
  //   circles stop being PAINTED app-wide. The terms stay tappable and the
  //   glossary stays reachable - nothing is taken away, the visual noise just
  //   stops. This costs an expert three grey circles, once, ever.
  //
  //   THE EXPLICIT SWITCH is the escape hatch for the member the counter gets
  //   wrong in either direction: an expert who wants them gone on day one,
  //   and a returning beginner who wants them back after the counter retired
  //   them. Default on, and it overrides the counter both ways.
  //
  // localStorage-backed rather than state-backed for the same reason
  // BACKUP_OPTOUT_KEY is: this is a per-device preference that must survive a
  // sign-out, and nothing else in the app needs to react to it changing.
  const TERM_OPENS_KEY = "haimunia-demo:termSheetOpens";
  const TERM_MARKS_KEY = "haimunia-demo:termMarks";
  const TERM_RETIRE_AFTER = 3;
  function termMarksSwitchOn() { return localStorage.getItem(TERM_MARKS_KEY) !== "0"; }
  function termSheetOpenCount() {
    const n = parseInt(localStorage.getItem(TERM_OPENS_KEY) || "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function termMarksVisible() { return termMarksSwitchOn() && termSheetOpenCount() < TERM_RETIRE_AFTER; }

  // ---- Tier 2's per-screen budget ------------------------------------------
  // "First occurrence only, at most 4 per screen." Both halves are about the
  // same failure: a feed of twelve workout posts carrying a circle on every
  // AMRAP is not disclosure, it is a rash. The budget is reset at the top of
  // each full community render (see rerender()), so it counts marks per
  // PAINT, not per session - which is what "per screen" actually means once
  // the screen re-renders on every state change.
  const TERM_MARKS_PER_SCREEN = 4;
  let termMarksDrawn = null;
  function resetTermMarkBudget() { termMarksDrawn = Object.create(null); }
  resetTermMarkBudget();
  function termMarkBudgetAllows(id) {
    if (!termMarksDrawn) resetTermMarkBudget();
    if (termMarksDrawn[id]) return false;                       // first occurrence only
    if (Object.keys(termMarksDrawn).length >= TERM_MARKS_PER_SCREEN) return false;
    termMarksDrawn[id] = true;
    return true;
  }
  // The marker itself. Returns "" - not a space, not a placeholder - when the
  // term is unknown, retired or over budget, so a caller can concatenate it
  // unconditionally and an expert's line is byte-identical to today's.
  //
  // aria-label carries the whole question ("מה זה AMRAP?") because the visible
  // text is a single "?" character, which tells a screen-reader user nothing
  // about which term is being asked about.
  function termMark(id) {
    const t = termById(id);
    if (!t || !termMarksVisible() || !termMarkBudgetAllows(id)) return "";
    return `<button type="button" class="term-mark" data-community-action="term-open" data-term="${esc(t.id)}" aria-label="${esc("מה זה " + t.term + "?")}">?</button>`;
  }
  // Tier 1. The permanent gloss under a control's label. Hardcoded copy, but
  // it still goes through bidiText: several glosses are pure Hebrew today and
  // a future one will not be, and this is exactly the class of line - Hebrew
  // beside a Latin term - that e013bed was written for.
  function termSub(id) {
    const t = termById(id);
    return t ? `<span class="term-sub">${bidiText(t.gloss)}</span>` : "";
  }
  // A term rendered inside content, with its marker: the term's own
  // typography is untouched (spec 3.3 - an expert must see exactly what they
  // see today plus a small grey circle), so this is deliberately NOT a
  // wrapper that styles anything.
  function termWithMark(id, text) {
    const t = termById(id);
    const label = text == null ? (t ? t.term : "") : text;
    return `<bdi>${esc(label)}</bdi>${termMark(id)}`;
  }

  // ---- The two vocabularies a workout post actually prints -----------------
  //
  // SCORE TYPE. app.js stores one of WOD_SCORE_TYPES (src/constants.js:333)
  // and the feed card printed it RAW - a member reading somebody's post saw
  // the literal lowercase string `amrap`, which is not a word in either
  // language. So this is two fixes in one line: a display form, and a `?` on
  // the two entries that are genuinely opaque.
  //
  // `load` and `time` get Hebrew labels and NO marker, on purpose. Once the
  // label reads `משקל מקסימלי` there is nothing left to explain, and spending
  // one of the four per-screen markers on a self-explanatory Hebrew phrase is
  // exactly the noise that makes a member stop reading them. Markers are for
  // AMRAP and EMOM, which stay in Latin because that is what is written on
  // the whiteboard at the box.
  // Keyed by the STORAGE enum and by the display spellings that reach the
  // same field from the server: a POST_WORKOUT's metadata.score_type is free
  // text on the wire and real rows carry "For Time" as well as "time". Both
  // spellings must land on the same gloss, or the marker would appear for
  // one member's post and not for the identical workout posted by another.
  const SCORE_TYPE_DISPLAY = Object.freeze({
    time: { label: "זמן", term: "fortime" },
    "for time": { label: "זמן", term: "fortime" },
    fortime: { label: "זמן", term: "fortime" },
    amrap: { label: "AMRAP", term: "amrap" },
    emom: { label: "EMOM", term: "emom" },
    load: { label: "משקל מקסימלי", term: null },
    "max load": { label: "משקל מקסימלי", term: null },
  });
  function scoreTypeHtml(scoreType) {
    const key = String(scoreType || "").trim().toLowerCase();
    const d = Object.prototype.hasOwnProperty.call(SCORE_TYPE_DISPLAY, key) ? SCORE_TYPE_DISPLAY[key] : null;
    // An unrecognised score type is still shown, escaped and unmarked -
    // dropping it would hide a real value the server sent, and the club's own
    // programming is allowed to invent a format this app has never heard of.
    if (!d) return scoreType ? bidiText(scoreType) : "";
    return `<bdi>${esc(d.label)}</bdi>${d.term ? termMark(d.term) : ""}`;
  }
  // EFFORT. Design spec 3.6, the display half. `Rx` and `מותאם` were an
  // asymmetric pair: one bare English abbreviation nobody defines, one
  // Hebrew word - so the two halves of a binary choice did not even read as
  // the same kind of thing. Hebrew first, English kept in parentheses so the
  // member can still recognise `Rx` on the whiteboard rather than having it
  // vanish, which is the whole reason not to simply translate it away.
  const EFFORT_DISPLAY = Object.freeze({
    rx: { label: "מלא (Rx)", term: "rx" },
    scaled: { label: "מותאם (Scaled)", term: "scaled" },
  });
  function effortHtml(effort, level) {
    const key = String(effort || "").toLowerCase();
    if (key === "level") return bidiText(("רמה " + (level || "")).trim());
    const d = Object.prototype.hasOwnProperty.call(EFFORT_DISPLAY, key) ? EFFORT_DISPLAY[key] : null;
    if (!d) return "";
    return `<bdi>${esc(d.label)}</bdi>${termMark(d.term)}`;
  }
  // Live bug hunt (2026-09-11): no diffDay===1 branch - a 1-day-old feed
  // post/comment/mod-queue row/audit-log entry rendered "לפני 1 ימים"
  // instead of "לפני יום". Highest-traffic grammar bug of the round: this
  // one function feeds timestamps across nearly every social surface.
  // Matches the singular-branch pattern app.js's own daysAgoLabel() already
  // uses for the same "one day" case.
  function relativeTime(iso) {
    if (!iso) return "";
    const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (diffMin < 1) return "עכשיו";
    if (diffMin === 1) return "לפני דקה";
    if (diffMin < 60) return `לפני ${diffMin} דק׳`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr === 1) return "לפני שעה";
    if (diffHr < 24) return `לפני ${diffHr} שע׳`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return "לפני יום";
    if (diffDay < 7) return `לפני ${diffDay} ימים`;
    return new Date(iso).toLocaleDateString("he-IL");
  }

  // The community data that is not needed until the Community tab renders
  // (blocked ids, the member's achievements, the notification count and
  // preferences) loads once per session, the first time it does, gated by the
  // communityDataLoaded/communityDataLoading pair - see the
  // afterRenderCommunity() call below. loadProfile() and loadRedemption() stay
  // eager in refreshSession()/onAuthStateChange: window.isCommunitySignedIn()
  // is a global gate consumed by the PR-share prompt and achievement-claim
  // flows, which are triggered from the core training-log tabs.
  async function ensureCommunityDataLoaded() {
    // Also gated on recovery_verified_at: renderCommunityApp() returns the
    // recovery gate's own content and nothing else while it's pending (see
    // that check's own comment, COMM-016), so there's no UI yet for any of
    // this to feed. Loading it anyway raced a loader's state.ui.message
    // reset against verifyRecovery()'s
    // own failure message on the exact same field - whichever finished
    // last silently won, so a real verification failure could show no
    // error at all depending on timing. The gate's own success path
    // re-renders once verified, which re-enters afterRenderCommunity() and
    // triggers this for real at that point.
    if (!state.user || !state.profile || !state.profile.recovery_verified_at || state.communityDataLoaded || state.communityDataLoading) return;
    state.communityDataLoading = true;
    try {
      // loadClubWods() joins this Promise.all rather than being awaited ahead
      // of it. It could not while loadWeeklyChallenge() froze the challenge's
      // `valid` at load time - losing that race stamped a good club challenge
      // invalid for the whole session - but activeWeeklyChallenge() derives
      // that at read time now (see weeklyChallengeIsValid), so there is no
      // ordering left to preserve and no reason to serialise a round trip in
      // front of thirteen parallel ones.
      await Promise.all([loadBlockedIds(), loadMyAchievements(), loadNotifUnread(), loadNotifPrefs()]);
      // COMM-229. Consumes window.__pendingPushDeepLink once the session
      // and its data are actually ready - see communityHandlePushDeepLink
      // for why this exists (the cold-start "sw.js opened a fresh window"
      // path). Deferring this alongside the rest is safe: a push
      // notification's deep link always points into Community, so it
      // needs this same data loaded before it can resolve regardless.
      if (window.__pendingPushDeepLink) {
        const link = window.__pendingPushDeepLink;
        window.__pendingPushDeepLink = null;
        communityHandlePushDeepLink(link);
      }
      state.communityDataLoaded = true;
    } catch (e) {
      // Live bug hunt round 5 (2026-09-11): no top-level error handling
      // existed here at all. Every individual loader above already
      // normalizes a real Supabase network failure into a resolved
      // {data:null,error} object (confirmed by reading vendor/supabase.js's
      // PostgrestBuilder), so this is not reachable through an ordinary
      // network hiccup - but if some OTHER bug ever threw inside one of
      // these ~17 parallel loaders, the old finally-only version still
      // marked communityDataLoaded = true (permanently blocking any retry
      // for the rest of the session, since the guard at the top of this
      // function checks exactly that flag) while the exception itself
      // propagated past afterRenderCommunity()'s un-awaited call as an
      // unhandled rejection. Net effect: Community silently, permanently
      // blank with no way back short of a full reload. Now: not marked
      // loaded (the next call can retry) and surfaced, not swallowed.
      console.error("ensureCommunityDataLoaded failed", e);
    } finally {
      state.communityDataLoading = false;
    }
    rerender();
  }

  // WHAT TO DO WHEN THE PASSWORD IS GONE. There is no email reset and there
  // never will be (no email, no SMTP), and the staff reset is gone with the
  // staff. The login screen says so rather than leaving a dead end.
  const LOGIN_RECOVERY_NOTE = `<div class="footer-note" style="margin-top:14px;">${bidiText("שכחתם את הסיסמה? אי אפשר לאפס אותה כרגע. אפשר להצטרף מחדש עם הזמנה חדשה, והיומן הפרטי נשאר במכשיר.")}</div>`;

  function openPrivacySettings() {
    // Both share prompts carry a link here (the show_workout_results note),
    // and navigating out from under an open modal leaves it painted over the
    // panel the member came to read. Dropped rather than closed through
    // dismissWorkoutSharePrompt()/dismissPrPrompt(), either of which would
    // release the next parked prompt on top of the screen they just asked
    // for - and, in the PR prompt's case, would burn the record as dismissed
    // for a tap that was about privacy, not about the share.
    state.posts.workoutPrompt = null;
    state.posts.prPrompt = null;
    if (typeof window.switchToCommunityTopTab === "function") window.switchToCommunityTopTab();
    rerender();
  }


  // An invite code is a live credential, and a URL is the leakiest place one
  // can sit (history, back-stack, screenshots, Referer). It is read once at
  // boot and stripped from the address bar before anything renders. Nothing
  // here logs it, and no analytics event carries it.
  const INVITE_CODE_PATTERN = /^[a-f0-9]{40,128}$/;
  function captureInviteDeepLink() {
    let code = "";
    try {
      const search = String((window.location && window.location.search) || "");
      if (!search || search.indexOf("invite=") === -1) return;
      code = String(new URLSearchParams(search).get("invite") || "").trim().toLowerCase();
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      // Strip first, validate second: a malformed code must leave the URL too.
      window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    } catch (e) { return; }
    if (!INVITE_CODE_PATTERN.test(code)) return;
    state.ui.inviteCodeDraft = code;
    // Land on the invite step itself rather than the neutral screen: someone
    // who followed an invite link has already answered that question.
    state.signupStarted = true;
  }
  captureInviteDeepLink();


  // ---- Reactions (COMM-120) ----------------------------------------------

  // ---- Comments and replies (COMM-121, COMM-122, COMM-124) --------------

  // ---- Mention picker (COMM-123) ---------------------------------------

  // COMM-300. The two private_records types that stand for "I trained
  // today". Kept in step with attendance_session_record_types() in
  // 202608310001 - bodyweight and measurement carry a `date` of the same
  // shape and are deliberately not here, because stepping on a scale is not
  // training.
  const ATTENDANCE_SESSION_TYPES = ["strength_entry", "wod_entry"];
  const ATTENDANCE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  // One emit per member per calendar day for the life of this page, mirroring
  // the (user_id, occurred_on) unique key server-side. Three lifts logged on
  // one day are one attendance day, so they are one event here too - without
  // this, "sessions per week" in metrics.md would count sets, not days.
  const attendanceEmitted = new Set();
  // COMM-300, and COMM-012's ATTENDANCE_RECORDED getting its first producer
  // since Phase 0. This is a COURTESY for client consumers (a future
  // challenge auto-progress rule is the named case) and for the analytics
  // bridge. It is explicitly NOT what writes public.attendance_log: the
  // private_records_attendance_log trigger does that, server-side,
  // independently, from the same upsert that just succeeded. Nothing
  // downstream may depend on this firing for correctness - a member on a
  // build without this line still produces attendance rows.
  function noteAttendanceRecorded(row) {
    if (!row || row.deleted) return;
    if (!ATTENDANCE_SESSION_TYPES.includes(row.recordType)) return;
    const occurredOn = row.payload && row.payload.date;
    if (typeof occurredOn !== "string" || !ATTENDANCE_DAY_RE.test(occurredOn)) return;
    const key = `${state.user ? state.user.id : ""}:${occurredOn}`;
    if (attendanceEmitted.has(key)) return;
    attendanceEmitted.add(key);
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ATTENDANCE_RECORDED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ATTENDANCE_RECORDED, { occurred_on: occurredOn }); } catch (e) {}
    }
  }
  // ONE FLUSH AT A TIME, and a re-run if anything was queued while it ran.
  //
  // Live bug hunt, fresh round 2 (2026-09-15) - CRITICAL, reproduced live.
  // queueSyncRecord() fires "haimunia-sync-needed" on EVERY local write, and
  // that event calls this fire-and-forget. Two edits to the same entry within
  // one network round trip therefore started two independent flushes, each
  // reading the same outbox row. They completed out of order, the STALE
  // upload landed last and overwrote the newer one in private_records, and
  // then both deleted the same outbox row - so nothing was left queued to
  // ever correct the drift. Local IndexedDB held the right value, the cloud
  // backup held a permanently wrong one, and nothing would notice unless the
  // member happened to edit that exact record again.
  //
  // The re-run matters as much as the lock: dropping the second call outright
  // would lose a write that arrived mid-flush. This defers it instead.
  let outboxFlushing = false;
  let outboxFlushQueued = false;
  async function flushOutbox() {
    if (!client || !state.user || !state.syncEnabled || typeof window.dbLoadSyncOutbox !== "function") return;
    if (outboxFlushing) { outboxFlushQueued = true; return; }
    outboxFlushing = true;
    try {
      do {
        outboxFlushQueued = false;
        const me = state.user && state.user.id;
        if (!me) return;
        const rows = await window.dbLoadSyncOutbox();
        for (const row of rows) {
          // A ROW BELONGS TO WHOEVER MADE IT, not to whoever is signed in
          // when it finally drains. Same hunt, also CRITICAL and also
          // reproduced live: member A logs a workout while offline, signs
          // out, member B signs in on the same phone, the queue drains - and
          // A's private training data was uploaded tagged with B's user_id.
          // A's cloud backup silently lost the entry and B's silently gained
          // one they never did.
          //
          // Rows queued before this shipped carry no owner; they are adopted
          // by the current member, which is exactly the old behaviour and the
          // best available answer for a row whose origin was never recorded.
          // New rows always know, so the window closes as the queue drains.
          if (row.userId && row.userId !== me) continue;
          const payload = { user_id: me, record_type: row.recordType, record_id: row.recordId, payload: row.payload || {}, deleted_at: row.deleted ? new Date(row.queuedAt).toISOString() : null, updated_at: new Date(row.queuedAt).toISOString() };
          const { error } = await client.from("private_records").upsert(payload, { onConflict: "user_id,record_type,record_id" });
          if (!error) {
            await window.dbDeleteSyncOutbox(row.id);
            // After the write succeeded, never before: a failed sync is not a
            // session, and the row stays in the outbox to be retried.
            noteAttendanceRecorded(row);
          }
        }
      } while (outboxFlushQueued);
    } finally {
      outboxFlushing = false;
    }
  }
  // ---------------------------------------------------------------------
  // The community write queue (launch-readiness audit, RELIABILITY).
  // ---------------------------------------------------------------------
  // flushOutbox() above is the private_records channel and stays exactly as
  // it was. This is the second, separate queue for community EVENTS - see
  // src/outbox.js's header for why they are not one queue.
  //
  // Every write routed through communityRpc() carries a client-generated
  // p_idempotency_key. The server (202609060014) returns the original
  // result for a repeated key instead of writing again, which is what makes
  // the retry below safe: without it, a queued post that actually landed
  // before the connection dropped would be posted twice on reconnect.
  // pr_share and ach_share joined the list with the share prompt: a member
  // who trains where there is no signal - which is most basements and half
  // the gyms in the country - was being offered a share that could only fail.
  // Both already take p_idempotency_key with a default (202609060019 /
  // 202609110004 / 202609120001), which is the precondition for being in here
  // at all and is what test/community-outbox-rpc-contract.test.mjs checks.
  const OUTBOX_ACTIONS = ["post_create", "toggle_reaction", "pr_share", "ach_share"];
  // Deliberately NOT in OUTBOX_ACTIONS. That list is what communityRpc()
  // consults to decide whether a member's write can be queued, and every
  // entry in it is an RPC name; this one is a table insert and is queued by
  // src/analytics.js rather than by communityRpc(). Keeping it out is what
  // stops a future caller from reaching it through the member-write path.
  const ANALYTICS_OUTBOX_ACTION = "analytics_event";

  function isOfflineError(error) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    const m = String((error && error.message) || "");
    // supabase-js surfaces a dropped connection as a TypeError from fetch;
    // the message text differs per browser, hence the alternation.
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out/i.test(m);
  }

  // ---- Five-persona UX audit: the server speaks Postgres, members read Hebrew --
  //
  // Every write in this file ends at an RPC that refuses with a bare English
  // wire code - 'posting_restricted', 'recovery method required',
  // 'rate_limited'. Those are strings for a CLIENT to branch on, not
  // sentences for a person, and renderOutboxBanner() printed one straight
  // into the failure card it shows a member:
  //
  //     פוסט
  //     posting_restricted
  //
  // That was how a moderated member found out they had been sanctioned. An
  // English enum, no statement of what the sanction covers, no route to a
  // human who can lift it - and, because the queue classifies that message
  // as permanent, a "ניסיון חוזר" button sitting next to it that can never
  // work. Verified against the real stack rather than read off the schema:
  // signed in as a restricted member, post_create and add_post_comment both
  // answer 'posting_restricted' while feed_page, community_search and
  // toggle_reaction all still return 200 - which is why the sentence below
  // can promise reading and cheering without lying.
  //
  // Same shape as ghostReclaimErrorText() rather than a second pattern: one
  // flat lookup on the message, plain Hebrew, and a neutral fallback. Two
  // rules carried over from it:
  //
  //   1. Each entry says WHAT HAPPENED and WHAT TO DO NEXT, in the register
  //      of the invite-code screen - which explains why there is a code and
  //      then bounds what it does NOT affect. Bounding the blast radius is
  //      most of the reassurance: a member who cannot post needs to hear
  //      that their workout log is untouched.
  //   2. NO "try again" on anything a retry cannot fix. A restriction, a
  //      missing recovery method and a permission refusal are all stable
  //      states; telling a member to retry one is a lie that costs them a
  //      few more taps and the last of their trust. Only 'rate_limited' and
  //      the connection failures below are genuinely time-limited, and only
  //      they invite another attempt.
  //
  // NOTHING falls through to a raw server string. An unrecognised message is
  // a message this app has never seen, which makes it the LEAST safe thing
  // to show, not the most informative - it would be untranslated, probably
  // English, possibly a Postgres internal, and it is never actionable.
  const SERVER_ERROR_TEXT = {
    // 202609160005's rank guard. The refusal is a fact about the TARGET, not
    // about the person reading it, so the sentence names who is out of reach
    // rather than saying "you are not allowed" - a head coach who tried to
    // remove another head coach has the permission and is being told about
    // this row, not about themselves.
    "cannot remove a member at or above your own role": "אפשר להסיר רק חבר/ה בדרגה נמוכה משלכם. מנהל/ת או בעל/ת המועדון מוסרים/ות על ידי מנהל/ת המערכת.",
    "use account deletion for your own account": "כדי למחוק את החשבון שלכם יש להשתמש במחיקת חשבון במסך החשבון, לא בהסרת חבר/ה.",
    // The COMM-016 gate. Worth being blunt that this closes reading too:
    // feed_page carries the same is_community_member() check as post_create,
    // so "you can still browse" would be the same false promise the account
    // security screen used to make.
    "recovery method required": "החשבון עוד לא אומת כחשבון שאפשר לשחזר, ולכן הקהילה כולה סגורה בפניו — גם הפיד וגם הפרסום. במסך אבטחת החשבון יש כפתור אימות שפותח את הכול; רישום האימונים עצמו לא מושפע וממשיך לעבוד כרגיל.",
    // COMM-153. The one message in this table that a member may be reading
    // as the first news that they have been moderated at all, so it names
    // the sanction plainly, states exactly what still works, and points at
    // the only people who can lift it. No retry: only a moderator clears it.
    //
    // REVISITED once the Account tab actually had a restriction panel
    // (renderMyRestrictionPanel). This sentence was written to carry a route
    // to a human BECAUSE it was the member's only channel - it was doing the
    // job of a surface that did not exist. It no longer is that, so it now
    // names where the reason and the end date live, which is the one thing it
    // structurally cannot say itself: an error string has no row behind it
    // and can never state a date. The route to a coach STAYS rather than
    // being handed off wholesale, because this message is still very often
    // the first news, and "go and read a tab" is a colder thing to say to
    // somebody who has just been refused than "go and read a tab, and there
    // are people you can ask".
    posting_restricted: "המועדון הגביל את הפרסום מהחשבון הזה, ולכן פוסטים ותגובות חדשים לא נשלחים. אפשר להמשיך לקרוא את הפיד ולעודד אחרים כרגיל. הסיבה שנרשמה ומועד סיום ההגבלה מופיעים בטאב \"חשבון\", וההגבלה נפתחת רק על ידי המנהלים — כדאי לפנות לבעל/ת המעגל.",
    "not authorized": "לחשבון הזה אין הרשאה לפעולה הזו. הרשאות של צוות המועדון ניתנות על ידי מנהל/ת, וניסיון נוסף לא ישנה את התוצאה.",
    // The only server refusal that clears on its own, so the only one that
    // earns a "try again". Matches the wording react() and the comment
    // editor already use for the same code.
    rate_limited: "נשלחו יותר מדי פעולות בזמן קצר והשרת עצר את האחרונה. זו הגבלה זמנית — אפשר לנסות שוב בעוד כמה דקות.",
    "captcha_failed": "אימות האבטחה לא עבר. אפשר לנסות שוב; אם זה חוזר, כדאי לרענן את הדף.",
    // Content refusals a queued post or comment can carry. Each one is a
    // thing the member can actually fix in the composer, so each names the
    // fix instead of the rule.
    "a post needs text or at least one photo": "פוסט חייב לכלול טקסט או לפחות תמונה אחת, והפוסט הזה יצא ריק. אפשר להסיר אותו מהתור ולכתוב אותו מחדש.",
    "at most 4 photos per post": "אפשר לצרף עד ארבע תמונות לפוסט. יש להסיר את הפוסט מהתור ולפרסם אותו מחדש עם פחות תמונות.",
    "each media item needs a storage_path": "אחת התמונות לא הועלתה במלואה, ולכן הפוסט לא נשלח. אפשר להסיר אותו מהתור ולצרף את התמונה שוב.",
    "at most 10 mentions per comment": "אפשר לתייג עד עשרה אנשים בתגובה אחת. יש להסיר את התגובה מהתור ולכתוב אותה מחדש עם פחות תיוגים.",
    "comment body required": "לא נשלחה תגובה ריקה. אפשר להסיר אותה מהתור ולכתוב אותה מחדש.",
    "reply depth is capped at 2": "אפשר להגיב לתגובה, אבל לא לתגובה על תגובה. כדאי להשיב ישירות לתגובה הראשונה בשרשור.",
    // The target of a queued write moved while the write was waiting. None
    // of these can succeed on a retry: the row is gone or closed.
    "post not found": "הפוסט הזה כבר לא קיים — יכול להיות שהכותב/ת מחק/ה אותו בינתיים. אפשר להסיר את הפעולה מהתור.",
    "post is not available": "הפוסט הזה כבר לא זמין לצפייה. אפשר להסיר את הפעולה מהתור.",
    "comment not found": "התגובה הזו כבר לא קיימת. אפשר להסיר את הפעולה מהתור.",
    "parent comment not found": "התגובה שאליה רצינו להשיב כבר לא קיימת. אפשר להסיר את הפעולה מהתור ולהגיב ישירות לפוסט.",
    "parent comment is no longer available": "התגובה שאליה רצינו להשיב הוסרה בינתיים. אפשר להסיר את הפעולה מהתור ולהגיב ישירות לפוסט.",
    "content author is no longer available": "החשבון שכתב את התוכן הזה כבר לא פעיל, ולכן הפעולה לא רלוונטית. אפשר להסיר אותה מהתור.",
    "event not found": "האירוע הזה כבר לא קיים. אפשר להסיר את ההרשמה מהתור.",
    "event not open for rsvp": "האירוע הזה סגור להרשמה — הוא כבר התקיים או שההרשמה נסגרה. אפשר להסיר את ההרשמה מהתור.",
    event_full: "האירוע מלא ואין בו יותר מקומות. אפשר להסיר את ההרשמה מהתור; אם יתפנה מקום, כדאי לבדוק שוב בדף האירוע.",
    "challenge not found": "האתגר הזה כבר לא קיים. אפשר להסיר את העדכון מהתור.",
    // The club WOD catalogue (202609060028). This is THE error a coach has to
    // actually understand, and the raw string does not say it: the club copy
    // is a snapshot taken at publish time, so re-publishing after editing
    // locally did not overwrite it - and the reason it refuses rather than
    // overwriting is that overwriting would change what a running challenge
    // asks of people, mid-week, with scores already on the board. The message
    // therefore has to name the fix as well as the fact.
    "wod already published": "האימון הזה כבר נמצא בקטלוג המועדון. העותק של המועדון הוא צילום מצב מרגע הפרסום, ולכן שינוי שנעשה כאן מאז לא עבר אליו — וזה מכוון, כדי שאתגר שכבר רץ לא ישנה את מה שהוא מבקש באמצע השבוע. לתיקון שם או תיאור אפשר לערוך את האימון בקטלוג; לשינוי סוג הניקוד או התרגילים צריך לפרסם אימון חדש.",
    "wod not found": "האימון הזה לא נמצא בקטלוג המועדון.",
    "wod id must be a custom WOD id": "אפשר לפרסם רק אימון שנבנה כאן באפליקציה.",
    "wod is used by a live challenge": "אי אפשר להוציא מהקטלוג אימון שיש עליו אתגר שעדיין לא הסתיים. אפשר לחזור לזה אחרי שהאתגר נגמר.",
    "wod is locked by a challenge": "כבר התקיים אתגר על האימון הזה, ולכן אי אפשר לשנות אותו — לוח התוצאות מתעד מה אנשים עשו מול אימון מסוים. לאימון שונה צריך לפרסם אימון חדש.",
    "not an active participant": "העדכון הזה שייך לאתגר שכבר לא משתתפים בו. אפשר להסיר אותו מהתור.",
    // ---- Club WOD sessions and boards (202609080002) ---------------------
    // Every refusal the six RPCs can raise, mapped. The rule this file
    // already follows applies with unusual force here: NOTHING below says
    // "try again", because none of these can succeed on a retry - each one
    // is a stable state, and each one therefore names the move that IS
    // available instead (cancel and re-publish, pick another day, log the
    // workout, open the board from the feed).
    //
    // 'wod not found' is deliberately NOT re-stated: club_wod_session_publish
    // raises the same string club_wod_publish already does, for the same
    // reason (the id is not in the catalogue), and the sentence above it
    // reads correctly for both.
    "wod is retired": "האימון הזה הוצא מקטלוג המועדון, ולכן אי אפשר לקבוע עליו אימון יום. אפשר להחזיר אותו לקטלוג בניהול הקטלוג, או לבחור אימון אחר.",
    // The snapshot rule, again - same shape as 'wod already published' above
    // and for the same reason: the note is frozen at publish time so a card
    // the club has already read cannot change under it. The correction path
    // is real and is named.
    "session already posted": "האימון הזה כבר נקבע ליום הזה, והטקסט שנשמר איתו הוא מה שהמועדון כבר ראה. לשינוי הטקסט אפשר לבטל את האימון שנקבע ולקבוע אותו מחדש; הלוח והתוצאות שכבר צורפו נשמרים.",
    "too many sessions posted for that day": "כבר נקבעו ארבעה אימונים ליום הזה, וזו התקרה. אפשר לבטל אחד מהם או לקבוע ליום אחר.",
    "a session can only be posted for yesterday, today or tomorrow": "אפשר לקבוע אימון יום לאתמול, להיום או למחר בלבד — כך הפיד נשאר מה שקורה עכשיו במועדון ולא לוח זמנים של שבוע קדימה.",
    "session not found": "האימון הזה כבר לא קיים בלוח של המועדון.",
    // Two different closures behind one server string; the client knows
    // which from viewer.closed_reason and says so on the board itself, so
    // this sentence has to cover both without guessing.
    "this board is closed": "הלוח הזה סגור לצירוף תוצאות — או שהאימון בוטל, או שעברו יותר מ-14 יום מהיום שהוא נקבע אליו. התוצאה שכבר צורפה נשארת, ואפשר להסיר אותה בכל רגע.",
    "the session has not happened yet": "האימון הזה נקבע למחר, ואפשר לצרף אליו תוצאה רק מהיום שהוא נקבע אליו.",
    "record is required": "לא נבחר רישום לצירוף. אפשר לרשום את האימון ביומן ואז לצרף את התוצאה.",
    "that result is for a different workout": "הרישום שנבחר שייך לאימון אחר, ולכן אי אפשר לצרף אותו ללוח הזה. אפשר לרשום את האימון של היום ולצרף את הרישום שלו.",
    // Thrown by registerOutboxHandlers() itself, not by the server: the
    // queue tried to send while nobody was signed in.
    "session expired": "החיבור לחשבון פג, ולכן הפעולה לא נשלחה. אחרי התחברות מחדש עם שם המשתמש והסיסמה אפשר לשלוח אותה שוב מכאן.",
  };
  // Accepts a Supabase error object, an Error, or a bare string - the outbox
  // stores lastError as a string, every other caller holds the error object,
  // and neither should have to remember which.
  // A DOMAIN MESSAGE, UNLESS THE CAUSE CHANGES WHAT THE MEMBER SHOULD DO.
  //
  // 29 failure branches in this file said only "<thing> נכשלה" and threw the
  // cause away. That is right for a failure nobody can act on differently -
  // "הסרת החבר/ה נכשלה" names what did not happen, which is what a member
  // needs. It is wrong when the cause DOES change the next step: a dropped
  // connection means "nothing was lost, try again when you are back", and a
  // rate limit means "wait", and neither is "it failed".
  //
  // So: keep the domain message, except where serverErrorText() actually
  // RECOGNISED the error - not where it fell through to its own generic. A
  // generic replacing a specific one is a downgrade, which is why this cannot
  // simply call serverErrorText() everywhere.
  const SERVER_ERROR_GENERIC = "הפעולה לא הושלמה. אפשר לנסות שוב, ואם זה חוזר כדאי לפנות לבעל/ת המועדון.";
  function failText(domainMessage, error) {
    const translated = serverErrorText(error);
    return translated && translated !== SERVER_ERROR_GENERIC ? translated : domainMessage;
  }
  function serverErrorText(error) {
    const msg = String((error && error.message) || error || "").trim();
    if (SERVER_ERROR_TEXT[msg]) return SERVER_ERROR_TEXT[msg];
    // A dropped connection, which is the one failure that is nobody's fault
    // and always worth another attempt. Checked on the message alone rather
    // than through isOfflineError(), which also consults navigator.onLine -
    // wrong here, because a row that failed offline is being described later,
    // very possibly after the connection came back.
    if (/failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out/i.test(msg)) {
      return "הפעולה לא הגיעה לשרת, כנראה בגלל חיבור לא יציב. שום דבר לא אבד — אפשר לנסות לשלוח שוב כשהחיבור חוזר.";
    }
    // outbox.js writes "unsupported action: <action>" for an op queued by a
    // previous version of the app whose handler no longer exists. The raw
    // string ends in an English action id, which is exactly the kind of
    // token that must not reach a member.
    if (/^unsupported action/i.test(msg)) {
      return "הפעולה הזו נוצרה בגרסה קודמת של האפליקציה וכבר אינה נתמכת, ולכן היא לא תישלח. אפשר להסיר אותה מהתור ולבצע אותה מחדש.";
    }
    // Rate limiting is expressed as 'rate_limited' by every RPC in this
    // schema, but the Supabase edge (and any proxy in front of it) can answer
    // 429 with its own wording, so the family is matched as well as the code.
    if (/rate.?limit|too many requests|429/i.test(msg)) return SERVER_ERROR_TEXT.rate_limited;
    // Unrecognised. Deliberately says nothing about the cause rather than
    // guessing, and offers the one next step that is always true. Named as a
    // constant because failText() has to be able to tell "recognised" from
    // "fell through to this" - see its comment above.
    return SERVER_ERROR_GENERIC;
  }
  // The other half of "no message says try again unless it can work". The
  // failure banner offers a "ניסיון חוזר" button on every failed row, which
  // for a restriction or a deleted post is a button that reruns the same
  // call and lands the row straight back in the same list - and it sits
  // directly under a sentence that has just told the member a retry will not
  // help. One of the two has to go, and it is not the sentence.
  //
  // Allow-list, not a deny-list: retry stays for the connection failures,
  // rate limiting and anything UNRECOGNISED, since an unknown error is
  // exactly where the member should keep the option. Only the codes this
  // file can positively identify as stable states lose it.
  const PERMANENT_SERVER_ERRORS = Object.keys(SERVER_ERROR_TEXT).filter((k) => k !== "rate_limited" && k !== "captcha_failed");
  function serverErrorIsRetryable(error) {
    const msg = String((error && error.message) || error || "").trim();
    if (/^unsupported action/i.test(msg)) return false;
    return PERMANENT_SERVER_ERRORS.indexOf(msg) < 0;
  }

  function newIdempotencyKey() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return null;
  }

  // Returns { queued, data, error }. `queued: true` means the write is
  // safely persisted in IndexedDB and will be sent on reconnect - the
  // caller should show a "will send when you're back online" state, not an
  // error.
  // A server that has not received this release's migrations yet does not
  // have the p_idempotency_key parameter, and PostgREST resolves functions
  // by the EXACT set of named arguments - so an un-migrated project answers
  // every keyed call with PGRST202 "Could not find the function". That is
  // not a hypothetical: shipping the client ahead of the migrations would
  // have taken out posting, commenting, reactions, RSVP and coach progress
  // entries all at once, and the event_rsvp bug in this same release was
  // the single-function version of exactly this failure.
  //
  // Rather than leave that as a deploy-order instruction in a document
  // nobody reads at 23:00, the client detects it and degrades: it retries
  // once WITHOUT the key. The write then behaves exactly as it did before
  // idempotency existed - which is a real loss (a retry can duplicate) but
  // an enormously smaller one than the feature being dead.
  //
  // Latched per action, so the fallback costs one wasted round trip per
  // action per session rather than doubling every write. Once the
  // migrations land the flag simply never gets set again.
  const missingIdempotencyParam = Object.create(null);
  function isMissingFunctionError(error) {
    if (!error) return false;
    // PGRST202 is the function-not-found code; the message check keeps this
    // from swallowing a genuinely missing RPC (a typo'd action name), which
    // must still surface as an error rather than silently retrying.
    return error.code === "PGRST202" && /p_idempotency_key/.test(String(error.message || "") + String(error.details || ""));
  }

  async function communityRpc(action, args, opts) {
    const options = opts || {};
    // Security hunt (2026-09-11): userId - see src/outbox.js's enqueue()/
    // flush() comments for the confirmed misattribution finding this closes.
    const enqueueOpts = Object.assign({}, options, { userId: state.user && state.user.id });
    const key = missingIdempotencyParam[action] ? null : newIdempotencyKey();
    const withKey = key ? Object.assign({}, args, { p_idempotency_key: key }) : Object.assign({}, args);
    const canQueue = !!(window.HaimuniaOutbox && OUTBOX_ACTIONS.indexOf(action) >= 0);

    if (canQueue && typeof navigator !== "undefined" && navigator.onLine === false) {
      await window.HaimuniaOutbox.enqueue(action, withKey, enqueueOpts);
      return { queued: true, data: null, error: null };
    }
    let { data, error } = await client.rpc(action, withKey);

    if (isMissingFunctionError(error)) {
      // Server predates this release. Remember it and retry un-keyed, so
      // the member's action still lands.
      missingIdempotencyParam[action] = true;
      const bare = Object.assign({}, args);
      ({ data, error } = await client.rpc(action, bare));
    }

    if (error && canQueue && isOfflineError(error)) {
      await window.HaimuniaOutbox.enqueue(action, withKey, enqueueOpts);
      return { queued: true, data: null, error: null };
    }
    // WHY A FAILED WRITE IS RECORDED.
    //
    // The avatar bug (profiles .upsert() refused by profiles_insert_self once
    // recovery_verified_at was set) broke photo, privacy and profile saves for
    // every member who had completed account recovery - and the only way it
    // was ever found was a member photographing their own screen. Nothing in
    // this app told anybody it was happening. 29 failure branches show a fixed
    // Hebrew string and discard the cause; none of them reach a log.
    //
    // WHAT IS RECORDED: the action name and a coarse error signature - the
    // PostgREST/Postgres code, or "network" - and nothing else. Never the
    // arguments, never a message body, never member content: an error string
    // can quote the row that failed, so passing it through would turn
    // telemetry into a data leak. A code plus an action name is enough to see
    // "club_wod_attach_result is failing 42501 for everyone since Tuesday",
    // which is the entire question this answers.
    if (error) trackWriteFailure(action, error);
    return { queued: false, data, error };
  }
  // Deliberately fire-and-forget and never awaited by a caller: telemetry
  // must not add a second failure on top of the one it is reporting, and a
  // member's action must never wait on it.
  function trackWriteFailure(action, error) {
    try {
      if (!A.WRITE_FAILED) return;
      const code = (error && (error.code || error.status)) || (isOfflineError(error) ? "network" : "unknown");
      track(A.WRITE_FAILED, { action: String(action || "").slice(0, 60), code: String(code).slice(0, 20) });
    } catch (_) { /* telemetry can never break the thing it is watching */ }
  }

  // One handler per queued action. Deliberately thin: the queue owns
  // ordering, backoff, attempt counting and failure classification; this
  // only knows how to put one row on the wire and how to say "that failed".
  function registerOutboxHandlers() {
    if (!window.HaimuniaOutbox) return;
    OUTBOX_ACTIONS.forEach((action) => {
      window.HaimuniaOutbox.registerHandler(action, async (args, row) => {
        if (!client || !state.user) throw new Error("session expired");
        // Security hunt (2026-09-11): a second, cheap check right at the
        // point of sending - flush()'s own check (src/outbox.js) already
        // catches the real scenario Agent N confirmed (sign out, someone
        // else signs in, the queue drains), but this closes the narrower
        // window where the session itself changes mid-flush, between
        // flush()'s check and this RPC actually going out. Matches
        // AUTH_ERROR_RE ("session"), so the queue pauses on it rather than
        // marking the row failed or, worse, retrying it under whoever is
        // signed in next.
        if (row && row.userId && row.userId !== state.user.id) throw new Error("session mismatch, queued for a different member");
        let { error } = await client.rpc(action, args);
        // Same un-migrated-server fallback communityRpc() carries. It
        // matters more here: the queue's PERMANENT_ERROR_RE matches "not
        // found", so without this a PGRST202 would mark every queued write
        // permanently failed and dump the member's offline posts into the
        // failure banner - the exact "never lose a queued action" promise
        // this queue exists to keep.
        if (isMissingFunctionError(error)) {
          missingIdempotencyParam[action] = true;
          const bare = Object.assign({}, args);
          delete bare.p_idempotency_key;
          ({ error } = await client.rpc(action, bare));
        }
        if (error) throw new Error(error.message || "rpc failed");
      });
    });
    // The one SILENT action (src/outbox.js): an analytics row recorded while
    // the device was offline. It is a table insert rather than an RPC,
    // because analytics_events takes a direct RLS insert and always has -
    // which is also why it is registered here, separately, instead of being
    // added to OUTBOX_ACTIONS, whose handler above calls client.rpc().
    //
    // Nothing here surfaces anything. A row that will not go is deleted by
    // the queue rather than shown to the member; see the silent-row rules.
    window.HaimuniaOutbox.registerHandler(ANALYTICS_OUTBOX_ACTION, async (args, row) => {
      if (!client || !state.user) throw new Error("session expired");
      if (row && row.userId && row.userId !== state.user.id) throw new Error("session mismatch, queued for a different member");
      const payload = Object.assign({}, args && args.row);
      // The row was built when the member was offline and carries the user
      // id from that moment. flush() and the check above already refuse a
      // row belonging to somebody else, so this only re-stamps a row queued
      // before the session resolved - an event recorded on a cold offline
      // boot, which is precisely the case worth keeping.
      if (!payload.user_id) payload.user_id = state.user.id;
      const { error } = await client.from("analytics_events").insert(payload);
      if (error) throw new Error(error.message || "analytics insert failed");
    });
    // The share prompt's workout write (src/community/posts.js). Registered
    // here beside the analytics one, and for the same reason: it is a table
    // upsert, not an RPC, so it cannot ride the OUTBOX_ACTIONS handler above,
    // which calls client.rpc(). Unlike the analytics row it is a MEMBER
    // WRITE - not silent - so a permanent failure surfaces in the banner with
    // its own retry, exactly like a queued post.
    window.HaimuniaOutbox.registerHandler(WORKOUT_SHARE_OUTBOX_ACTION, workoutShareOutboxHandler);
  }

  async function flushCommunityOutbox() {
    if (!window.HaimuniaOutbox || !client || !state.user) return;
    // Security hunt (2026-09-11): userId here is what lets flush() refuse to
    // send a row that was queued under a different member's session - see
    // src/outbox.js's own flush() comment.
    const result = await window.HaimuniaOutbox.flush({ userId: state.user.id });
    if (result && (result.sent || result.failed)) {
      await refreshOutboxState();
      rerender();
    }
  }

  async function refreshOutboxState() {
    if (!window.HaimuniaOutbox) return;
    const rows = await window.HaimuniaOutbox.list();
    // `!r.silent` on both: these two feed the member-facing outbox banner
    // and its retry/discard list, and a telemetry row is not something a
    // member is waiting on or can act on. The queue itself already refuses
    // to mark a silent row failed; this is the second half of the same rule,
    // on the side that draws the screen.
    state.outbox.pending = rows.filter((r) => r.status === "pending" && !r.silent).length;
    state.outbox.failed = rows.filter((r) => r.status === "failed" && !r.silent);
  }

  async function retryOutboxItem(id) {
    if (!window.HaimuniaOutbox) return;
    await window.HaimuniaOutbox.retry(id);
    await refreshOutboxState();
    rerender();
    await flushCommunityOutbox();
  }

  async function discardOutboxItem(id) {
    if (!window.HaimuniaOutbox) return;
    await window.HaimuniaOutbox.discard(id);
    await refreshOutboxState();
    setMessage("הפעולה הוסרה מהתור");
    rerender();
  }

  // Every login used to re-fetch and re-apply every private record (up
  // to 20,000) from scratch, even though almost nothing changed since
  // last time - slow and IndexedDB-write-heavy for a long-running
  // account. Keyed per-user (dbGetSetting/dbSetSetting), not globally,
  // so a different account signing in on the same device never inherits
  // a stale cursor and silently misses its own older records.
  function syncCursorKey(userId) { return `haimunia-demo:syncCursor:${userId}`; }
  async function pullPrivateRecords() {
    if (!client || !state.user || typeof window.applyRemotePrivateRecord !== "function") return;
    const cursorKey = syncCursorKey(state.user.id);
    const cursor = typeof window.dbGetSetting === "function" ? await window.dbGetSetting(cursorKey) : null;
    let query = client.from("private_records").select("record_type,record_id,payload,deleted_at,updated_at").order("updated_at", { ascending: true }).limit(20000);
    if (cursor) query = query.gt("updated_at", cursor);
    const { data, error } = await query;
    if (error) return;
    for (const row of data || []) await window.applyRemotePrivateRecord(row);
    const newest = (data || []).length ? data[data.length - 1].updated_at : null;
    if (newest && typeof window.dbSetSetting === "function") await window.dbSetSetting(cursorKey, newest);
    if (typeof window.reloadFromDb === "function") { await window.reloadFromDb(); rerender(); }
  }
  // THE THIRD PHOTO SURFACE. Live bug hunt, fresh round 9 (2026-09-16).
  //
  // post_photos was added to CLUB_MODULE_TOGGLES the day before and wired
  // into the feed composer and the PR-share prompt - and missed here, in the
  // inline share control that Calendar's day detail, the Add tab's
  // today's-sets card and the WOD progress card all render. A club that
  // switched photos off still had the camera offered on five call sites.
  //
  // These toggles only hide the offer (they are clientOnly by design), so a
  // surface that keeps offering is the whole of the failure: the club said no
  // and one of three places did not listen.
  window.renderShareControl = function (type, id) {
    if (!window.isCommunitySignedIn || !window.isCommunitySignedIn()) return "";
    const key = shareKey(type, id);
    // MERGE NOTE. Two branches replaced this emoji at once, for the same
    // reported reason ("replace the share emoji on the progress card with a
    // stroke share icon"), and main's is the one that survives: a local
    // SHARE_ICON const here would have been a second drawing of an action
    // that already has one, which is the drift the shared set exists to stop.
    // The behaviour both sides wanted - no emoji, a stroked glyph inheriting
    // the button's own --steel - is what SHARE_ICONS.club already gives.
    // The glyph is SHARE_ICONS.club (src/community/outward.js), the same one
    // the "ההישגים שלי" rows now draw for "share this to the club" - it was
    // an outbox-tray emoji here and an arrow emoji there, two different
    // pictures of one action, each rendered by whatever emoji font the phone
    // happened to ship. See that constant's own comment. (Named rather than
    // typed, so test/member-surface-polish.test.mjs can assert this function
    // contains no emoji at all.)
    if (!state.posts.openShare[key]) return `<button data-community-action="toggle-share" data-type="${esc(type)}" data-id="${esc(id)}" aria-label="שיתוף לקהילה" style="color:var(--steel);padding:4px;line-height:0;">${SHARE_ICONS.club}</button>`;
    return `<div class="flex items-center gap-6" style="flex-wrap:wrap;">
      <button class="chip-btn primary" data-community-action="publish" data-type="${esc(type)}" data-id="${esc(id)}" data-visibility="public" style="padding:5px 9px;font-size:11px;">לכולם</button>
      <button class="link-btn" data-community-action="toggle-share" data-type="${esc(type)}" data-id="${esc(id)}" aria-label="ביטול שיתוף" style="padding:5px;">✕</button>
    </div>`;
  };
  // The one account-deletion path, reached from the Community account tab
  // and from the backup panel (launch-readiness audit B5: a backup-only
  // member has no profile, so no account tab, and had no way to ask).
  // Backup is switched off on this device before signing out: the deleted
  // account takes its private_records with it at the purge, and without the
  // opt-out the very next saved set would quietly open a NEW anonymous
  // account and start uploading again - a deletion the member asked for,
  // undone by the app the next time they train.
  async function requestDeletion() {
    if (!state.user) return;
    const { error } = await client.rpc("request_account_deletion");
    if (error) return setMessage(failText("בקשת המחיקה נכשלה", error));
    localStorage.setItem(BACKUP_OPTOUT_KEY, "1");
    if (state.syncEnabled) { state.syncEnabled = false; localStorage.setItem("haimunia-demo:cloudSyncEnabled", "0"); }
    state.ui.backupDeleteConfirm = false;
    // Before signOut(): its auth event is what repaints, and showToast()
    // only paints on the next render.
    if (typeof window.showToast === "function") window.showToast("בקשת המחיקה התקבלה. החשבון ומה שגובה לענן יימחקו לצמיתות בתוך 30 יום. האימונים במכשיר הזה נשארים.");
    await client.auth.signOut();
  }
  // ---- S16: "download my data" ------------------------------------------
  //
  // Everything the server holds about the signed-in member, as one JSON
  // file, read with the member's OWN client - so RLS, not this list, is what
  // decides what can be read. This list decides only what is LEFT OUT of
  // what RLS already allows:
  // - every select names its columns (no "*"), and none of them is a staff
  //   column: profiles.is_admin/assigned_coach_id, post_comments.deleted_by,
  //   challenge_progress.entered_by/note, member_of_week.published_by,
  //   weekly_recaps.classmates, push_subscriptions.keys/endpoint;
  // - every read is filtered to the member's own id on the column that
  //   makes the row theirs, because several policies (reactions, follows,
  //   blocks, challenge_participants, member_of_week...) also return other
  //   members' rows, and "who blocked you" is one of them;
  // - tables a member cannot read, or that are staff records about them,
  //   are not attempted: reports, analytics_events, coach_congratulations,
  //   coach_tasks, member_contact_log, pins, training_log_usage (no user).
  //   bug_reports and posting_restrictions go through their existing
  //   own-data RPCs, which already strip admin_note/moderator_id.
  // One failed read never sinks the file: the section records the failure
  // and the rest is still delivered, because a partial copy the member can
  // see is labelled beats no copy at all. No migration: this is read-only.
  const SELF_EXPORT_LIMIT = 20000;
  const SELF_EXPORT_TABLES = Object.freeze([
    { section: "profile", table: "profiles", owner: "id", cols: "id,handle,display_name,bio,created_at,updated_at,visible_to_club,show_workout_results,show_attendance,show_upcoming_booking,show_prs,show_achievements,in_leaderboards,allow_follows,allow_mentions,allow_messages,show_in_attendee_lists" },
    { section: "private_records", table: "private_records", owner: "user_id", cols: "record_type,record_id,payload,deleted_at,created_at,updated_at" },
    { section: "posts", table: "workout_posts", owner: "author_id", cols: "id,post_type,source_type,source_record_id,visibility,title,result_text,body,comparison_key,score_value,score_direction,rx,occurred_on,metadata,status,published_at,created_at,updated_at" },
    { section: "reactions", table: "reactions", owner: "user_id", cols: "post_id,kind,created_at" },
    { section: "blocked", table: "blocks", owner: "blocker_id", cols: "blocked_id,created_at" },
    { section: "notifications", table: "notifications", owner: "user_id", cols: "id,type,category,title,body,source_type,source_id,deep_link,read_at,created_at" },
    { section: "notification_preferences", table: "notification_preferences", owner: "user_id", cols: "type,channel,updated_at" },
    { section: "push_subscriptions", table: "push_subscriptions", owner: "user_id", cols: "id,created_at,revoked_at" },
    { section: "achievements", table: "member_achievements", owner: "user_id", cols: "id,achievement_id,source_id,unlocked_at,shared_at,visibility,repeatable,verified" },
    { section: "account_deletion_request", table: "account_deletion_requests", owner: "user_id", cols: "requested_at,purge_after" },
    { section: "tagged_as_training_partner", table: "post_training_partners", owner: "tagged_user_id", cols: "post_id,created_at" },
    { section: "invite_redemption", table: "invite_redemptions", owner: "user_id", cols: "role,redeemed_at" },
  ]);
  const SELF_EXPORT_RPCS = Object.freeze([
    { rpc: "bug_report_list_mine", section: "bug_reports" },
  ]);
  // Belt and braces: each row is cut down to the columns its select named,
  // so a server that ever returns more (a "*" regression, a view that grows)
  // still cannot widen the file.
  function pickCols(rows, cols) {
    const keys = String(cols).split(",");
    return (rows || []).map((row) => {
      const out = {};
      for (const k of keys) if (row && row[k] !== undefined) out[k] = row[k];
      return out;
    });
  }
  async function buildSelfExport() {
    const uid = state.user && state.user.id;
    if (!client || !uid) return null;
    const sections = {};
    const unavailable = [];
    await Promise.all(SELF_EXPORT_TABLES.map(async (spec) => {
      try {
        const { data, error } = await client.from(spec.table).select(spec.cols).eq(spec.owner, uid).limit(SELF_EXPORT_LIMIT);
        if (error) { unavailable.push(spec.section); return; }
        sections[spec.section] = pickCols(data, spec.cols);
      } catch (e) { unavailable.push(spec.section); }
    }));
    await Promise.all(SELF_EXPORT_RPCS.map(async (spec) => {
      try {
        const { data, error } = await client.rpc(spec.rpc);
        if (error) { unavailable.push(spec.section); return; }
        sections[spec.section] = data || [];
      } catch (e) { unavailable.push(spec.section); }
    }));
    const ordered = {};
    for (const key of Object.keys(sections).sort()) ordered[key] = sections[key];
    return {
      kind: "box-log-account-export",
      format_version: 1,
      exported_at: new Date().toISOString(),
      user_id: uid,
      // Honest about its own gaps: a read RLS refused (a module switched
      // off, a membership gate) is listed rather than silently absent.
      unavailable: unavailable.sort(),
      truncated: Object.keys(ordered).filter((k) => Array.isArray(ordered[k]) && ordered[k].length >= SELF_EXPORT_LIMIT),
      data: ordered,
    };
  }
  function downloadJsonFile(payload, filename) {
    if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }
  async function exportMyServerData() {
    if (state.ui.selfExportBusy) return false;
    state.ui.selfExportBusy = true;
    rerender();
    let ok = false;
    try {
      const payload = await buildSelfExport();
      ok = !!payload && downloadJsonFile(payload, `box-log-my-data-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) { ok = false; }
    state.ui.selfExportBusy = false;
    if (typeof window.showToast === "function") window.showToast(ok ? "ההורדה התחילה: כל מה שנשמר עליכם בשרת, בקובץ אחד." : "הורדת הנתונים נכשלה. נסו שוב כשיש חיבור.");
    rerender();
    return ok;
  }
  window.communityBuildSelfExport = buildSelfExport;
  // Rendered on the backup card (for a backup-only member, who has no
  // account tab) and in the account tab - the same two surfaces the
  // deletion request lives on, and for the same reason.
  function selfExportButtonHtml(style) {
    if (!state.user) return "";
    return `<button class="link-btn" data-community-action="self-export" style="${style || "display:block;margin-top:10px;"}"${state.ui.selfExportBusy ? " disabled aria-busy=\"true\"" : ""}>${state.ui.selfExportBusy ? "מכינים את הקובץ…" : "הורדת הנתונים שלי מהשרת (JSON)"}</button>`;
  }


  // A single in-app confirm dialog, replacing three different patterns
  // that used to exist for comparably serious actions: the native browser
  // confirm dialog (broke out of the app's entire custom visual language), an inline
  // footer swap (app.js's clear-all-data), and no confirmation at all
  // (publishing to the community feed, which — unlike blocking someone —
  // used to fire immediately). Every destructive or broadcast-to-others
  // action now goes through this same path.
  //
  // ---- WHO the action is about (five-persona UX audit, defect 2) ---------
  //
  // "הגבלת פרסום קבועה" / "לחסום את המשתמש?" named no one. Every one of these
  // dialogs is opened from a LIST, which is exactly how the wrong row gets
  // actioned - the admin reads a name in the roster, taps, and then confirms
  // a sentence that could be about anybody.
  //
  // The earlier pass (commit 05e1ee5) concluded askConfirm() "structurally
  // cannot carry a name that mixes Latin and Hebrew" and built a dedicated
  // sheet instead. That conclusion was about the MESSAGE field only: it is
  // rendered with esc() as one flat run, so a name spliced into the string
  // before it reaches here would indeed be reordered against the Hebrew
  // sentence around it (and could not be <bdi>-isolated, since esc() would
  // turn the tag into literal text). The fix is to stop splicing: the
  // message carries a TOKEN, the name travels beside it as `subject`, and
  // the sheet joins the escaped sentence fragments around a bidiText()-
  // isolated name. esc() still runs over both halves - nothing is bypassed -
  // and every existing call site is fixed at once instead of growing a
  // fourth dialog. CLOUD_DIALOGS stays at 13.
  const CONFIRM_SUBJECT_TOKEN = "{subject}";
  // Single source, so the degraded wording cannot drift between call sites:
  // used only when a subject could not be resolved at all (a stale list, an
  // id the client has never seen a profile for). "לחסום את החבר/ה?" is a
  // worse dialog than "לחסום את יעל בר?" but it is still a grammatical one.
  const CONFIRM_SUBJECT_UNKNOWN = "החבר/ה";
  // The name for a confirmation about a person, keyed by id so it cannot
  // return a different member than the row clicked. Empty when unresolved.
  function subjectNameFor(userId) {
    const blocked = userId && state.members.blockedByMeNames && state.members.blockedByMeNames[userId];
    if (blocked) return blocked;
    // The post menu's "block" is the entry point, and there the name lives on
    // the post rather than on a profile row.
    if (userId && Array.isArray(state.posts.held)) {
      const post = state.posts.held.find((p) => p && p.author_id === userId);
      if (post) { const n = postAuthorName(post); if (n) return n; }
    }
    return "";
  }
  // The sentence-with-a-name rendering used by the confirmation sheet.
  function subjectSentenceHtml(message, subject) {
    const parts = String(message == null ? "" : message).split(CONFIRM_SUBJECT_TOKEN);
    if (parts.length === 1) return esc(parts[0]);
    const name = String(subject == null ? "" : subject).trim() || CONFIRM_SUBJECT_UNKNOWN;
    return parts.map(esc).join(bidiText(name));
  }
  function askConfirm(opts) { state.ui.confirmDialog = opts; rerender(); }
  function closeConfirm() { state.ui.confirmDialog = null; rerender(); }
  function runConfirm() {
    const c = state.ui.confirmDialog;
    state.ui.confirmDialog = null;
    if (!c) return;
    if (c.action === "migrate") migrateLocalData();
    else if (c.action === "block") block(c.payload.userId);
    else if (c.action === "delete-account") requestDeletion();
    else if (c.action === "publish") publishWorkout(c.payload.type, c.payload.id, c.payload.visibility);
    else if (c.action === "post-delete-rpc") postDeleteViaMenu(c.payload.postId);
    else rerender();
  }

  // ---- The five-second undo, for the community's own destructive writes ---
  //
  // THE ASYMMETRY THIS CLOSES. Deleting a logged set on the offline side
  // confirms AND offers an undo (askAppConfirm + offerUndo, app.js): a
  // confirmation stops the accident, an undo repairs the one that got
  // through anyway. Deleting a post or a comment — the two deletes that
  // happen in front of the whole club — confirmed and then went straight to
  // the server, and the sheets said so in as many words ("הפעולה לא ניתנת
  // לביטול"). Same app, same finger, two different promises.
  //
  // THE WRITE IS HELD, NOT REVERSED, and the schema is what decides that
  // rather than convenience. A post delete is a hard delete of the
  // workout_posts row (its comments, reactions and impressions follow by
  // cascade) and a comment delete is comment_delete()'s soft delete, which
  // has no client-callable inverse — there is no restore RPC and this branch
  // adds no migration. Re-inserting either after the fact would mint a new
  // id and leave every reply, reaction and notification pointing at a row
  // that no longer exists. So: the row leaves the screen at once, the toast
  // holds the actual write open for the toast's own window, and "בטלו" means
  // the write never happens at all. What a member sees is identical to the
  // log's undo; what reaches Postgres is strictly safer.
  //
  // ONE CLOCK, and it is app.js's. showToast()'s onExpire fires when the
  // toast's window closes without being tapped — timeout, a newer toast
  // replacing it, or pagehide — so the held write and the toast can never
  // disagree about when five seconds are up, which two timers eventually
  // would. `settled` is belt and braces on top of that: onExpire and the
  // undo are mutually exclusive by construction there, and a double delivery
  // from anywhere still cannot send the write twice or send it after an undo.
  //
  // NO TOAST AVAILABLE (app.js not loaded yet, or a build without it) is not
  // a reason to drop a delete the member confirmed: commit() runs at once,
  // which is exactly the behaviour this replaced.
  function deferCommunityDelete(opts) {
    opts.remove();
    let settled = false;
    const once = (fn) => () => { if (settled) return; settled = true; fn(); };
    // ARMED BEFORE THE REPAINT, not after it. offerUndo() only STORES the
    // toast; app.js's render() is what paints it, and rerender() is that
    // render. Calling them the other way round leaves the member watching
    // their post vanish with no undo on screen at all - the same ordering
    // trap app.js's own deleteEntry() documents at its call site.
    const haveToast = typeof window.offerUndo === "function";
    if (haveToast) window.offerUndo(opts.label, once(() => { opts.restore(); rerender(); }), once(opts.commit));
    rerender();
    if (!haveToast) once(opts.commit)();
  }

  // Splices aria-invalid/aria-describedby onto an already-built <input>/
  // <textarea> string when that field has a live validation error, and
  // renders the matching visible error text right under the field — the
  // same error, not a duplicate message, so a screen reader and a sighted
  // user learn the same thing at the same place.
  function field(formId, name, labelText, inputHtml) {
    const err = (state.ui.fieldErrors[formId] || {})[name];
    const errId = `err-${formId}-${name}`;
    // <select> joined the list when the weekly-challenge comparison key became
    // a picker instead of a text box - without it that field would have shown
    // a visible error with nothing tying it to the control for a screen reader.
    const tagged = err ? inputHtml.replace(/^<(input|textarea|select)/, `<$1 aria-invalid="true" aria-describedby="${errId}"`) : inputHtml;
    return `<label class="field"><span class="field-label">${labelText}</span>${tagged}${err ? `<span class="field-error" id="${errId}" role="alert">${esc(err)}</span>` : ""}</label>`;
  }
  function renderConfirmSheet() {
    const c = state.ui.confirmDialog;
    if (!c) return "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="communityConfirmTitle" data-cloud-dialog="confirmSheet" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;border-bottom:1px solid var(--border);max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <h2 id="communityConfirmTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">${esc(c.title || "אישור פעולה")}</h2>
          <div style="color:var(--steel);font-size:13.5px;line-height:1.6;margin-bottom:20px;"${c.subject !== undefined ? ' data-confirm-subject="1"' : ""}>${subjectSentenceHtml(c.message, c.subject)}</div>
          <div class="chip-row" style="margin-top:0;">
            <button class="chip-btn" data-community-action="confirm-no">ביטול</button>
            <button class="chip-btn primary${c.destructive ? " danger" : ""}" data-community-action="confirm-yes">${esc(c.confirmLabel || "אישור")}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // `trailing` is an optional control that rides the END of the head row
  // (margin-inline-start:auto on the control itself, so it answers RTL
  // rather than a hardcoded side). One caller uses it — the feed's scope
  // filter, which used to be a stacked rail of its own; see filterHtml.
  // An optional fourth argument rather than a second head renderer: a
  // near-copy of this markup somewhere else is exactly the sibling drift
  // this file keeps paying for.
  function sectionHead(color, title, adminTag, trailing) {
    return `<div class="ach-section-head"><span class="ach-section-dot" style="background:${color};"></span><h2 class="ach-section-title">${title}</h2>${adminTag ? `<span class="admin-tag">ניהול</span>` : ""}${trailing || ""}</div>`;
  }


  window.renderPostCardSkeleton = renderPostCardSkeleton;






  // Composed cloud overlay: the confirm sheet plus every posts-cluster dialog,
  // rendered by app.js after every tab so a PR prompt or an open composer is
  // not tied to the Community tab being active.
  // COMM-234 QA sweep: renderConfirmSheet() used to be concatenated FIRST
  // here, which put it EARLIER in DOM order than every other overlay this
  // function renders. All of them share the same .modal-overlay class and
  // the same fixed z-index:50 (index.html), so two open at once stack by
  // DOM order, not by which one is logically "on top" - a later sibling
  // paints over an earlier one. askConfirm() is meant to be a modal-on-modal
  // confirmation nested inside whatever triggered it (leave-challenge fires
  // it while challengeView is still open, event-cancel while eventView is
  // still open, composer-discard while the post composer is still open,
  // etc.), so it has to render LAST, not first - a real Chromium browser
  // check caught this (jsdom's programmatic .click() has no hit-testing, so
  // every existing node test clicked straight through the invisible overlap
  // and never noticed a real user cannot reach the confirm button at all in
  // this state). See scripts/browser-check/community-challenge-lifecycle.mjs.
  function renderConfirmDialog() {
    // FIRST, so everything that can stack ON the board paints after it: the
    // term sheet (the board is full of `?`-marked terms - Rx, Scaled, For
    // Time) and the confirm sheet (a coach cancelling the session). Nothing
    // can ever be under it, since the board is only opened from the feed or
    // the club-home strip.
    return renderReactorsSheet()
      + renderPrSharePrompt() + renderWorkoutSharePrompt() + renderAchievementUnlockCelebration() + renderNotificationCenter()
      + renderTermSheet()
      // Second-to-last, immediately under the confirm sheet: the outward
      // share sheet is opened FROM the PR prompt and the achievement
      // celebration, so it stacks on top of them and must paint after them
      // for the same z-order reason renderConfirmSheet() paints last.
      + renderOutwardShareSheet()
      + renderConfirmSheet();
  }
  // THE CLOSE BUTTON EVERY SHEET IN THIS APP USES, defined once.
  //
  // Real-phone report: "the terms sheet has a large boxed close button unlike
  // every other sheet". Both halves are right. .chip-btn is a pill - a 44px
  // min-height, a real border, a filled background, sized for "RSVP" or
  // "לעוקבים" - and a bare "✕" glyph inside it reads as a button that does
  // something, not as the dismiss affordance. Every app.js dialog
  // (#notificationsOverlay, #achievementsOverlay, #supportOverlay, the
  // exercise picker) closes with .icon-btn and the 20x20 stroked X below,
  // and that is what a member arriving at the glossary from the workouts
  // library has just been looking at.
  //
  // WHICH WAY THE DRIFT GOES, because it is a real question here. This file
  // and src/community/*.js had SIX copies of the chip-btn form and zero of
  // the standard one, so the term sheet was not the odd one out within
  // cloud.js - it was consistent with five siblings and all six were
  // inconsistent with the app around them. Fixing only the reported one
  // would have left five, so all six call this, and this is the only
  // definition. Listed in the PR.
  function sheetCloseBtnHtml(action) {
    return `<button class="icon-btn" data-community-action="${esc(action)}" aria-label="סגירה" style="color:var(--steel);">`
      + `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`
      + `</button>`;
  }
  // ==========================================================================
  // Design spec section 3, TIER 3 — the term sheet.
  //
  // A BOTTOM SHEET, NOT A FULL-SCREEN MODAL, and that is the whole design.
  // The member asked what a word on the screen means; covering the screen
  // that word is on answers the question in the one place they cannot check
  // it against. .modal-sheet anchored to the bottom (the .modal-overlay
  // default) is the same component the exercise picker already uses, so this
  // adds a vocabulary, not a component.
  //
  // Two pages, one dialog: the term itself, and the full glossary behind
  // "כל המונחים". state.ui.termGlossaryOpen is a boolean rather than a second
  // registry entry precisely so both pages share one focus trap, one Escape
  // binding and one backdrop click — a second dialog would have had to
  // duplicate all three and would have been a second thing to get wrong.
  //
  // Dismiss by tap-outside, ✕, or Esc — all three come free from
  // CLOUD_DIALOGS. There is no confirm button: nothing here is a decision.
  function renderTermGlossaryPage() {
    const items = TERM_GLOSSARY.map((t) => `<div class="term-glossary-item">
      <div style="font-weight:800;font-size:15px;color:var(--chalk);"><bdi>${esc(t.term)}</bdi></div>
      <div style="font-size:13px;color:var(--steel);margin-top:2px;line-height:1.4;">${bidiText(t.gloss)}</div>
    </div>`).join("");
    return `<button class="gate-back" data-community-action="term-glossary-back">‹ חזרה</button>
      <h2 id="termSheetTitle" style="margin-top:0;margin-bottom:4px;color:var(--chalk);font-weight:800;font-size:18px;">כל המונחים</h2>
      <div style="max-height:52vh;overflow-y:auto;margin-top:8px;">${items}</div>`;
  }
  function renderTermSheet() {
    const open = state.ui.termSheet;
    if (!open) return "";
    const t = termById(open);
    if (!t) return "";
    // An <h2>, not a styled div: it is the aria-labelledby target of a
    // role="dialog", so it has to appear in heading navigation (a11y A2). The
    // two margins are pinned for the same reason every other converted
    // dialog title pins them - an h2's UA default margin would push the
    // sheet's content down and make this a design change as well as a
    // semantic one.
    const page = state.ui.termGlossaryOpen ? renderTermGlossaryPage() : `
      <h2 class="term-sheet-term" id="termSheetTitle" style="margin-top:0;margin-bottom:0;"><bdi>${esc(t.term)}</bdi></h2>
      <div class="term-sheet-gloss">${bidiText(t.gloss)}</div>
      <div class="term-sheet-body">${bidiText(t.body)}</div>
      <button class="term-glossary-row" data-community-action="term-glossary">
        <span>כל המונחים</span><span aria-hidden="true">›</span>
      </button>`;
    // No data-community-action on the overlay itself: the backdrop click is
    // handled generically off data-cloud-dialog (and only fires when the
    // overlay IS the event target), so putting an action here as well would
    // make every click INSIDE the sheet bubble up and close it.
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="termSheetTitle" data-cloud-dialog="termSheet" style="align-items:flex-end;padding:0;">
      <div class="modal-sheet" data-term-sheet style="max-height:none;">
        <div class="modal-head">
          <span class="modal-title" style="font-size:13px;color:var(--steel);">${state.ui.termGlossaryOpen ? "מונחים" : "מה זה?"}</span>
          ${sheetCloseBtnHtml("term-close")}
        </div>
        <div style="padding:4px 18px calc(env(safe-area-inset-bottom,0px) + 22px);">${page}</div>
      </div>
    </div>`;
  }
  // Opening a sheet is what advances the auto-retire counter (spec 3.5): the
  // signal that a member no longer needs the circles is that they have USED
  // them, three times. Paging into the glossary from an already-open sheet is
  // not a fourth open and deliberately does not count.
  function openTermSheet(id) {
    if (!termById(id)) return;
    state.ui.termSheet = id;
    state.ui.termGlossaryOpen = false;
    try { localStorage.setItem(TERM_OPENS_KEY, String(termSheetOpenCount() + 1)); } catch (e) {}
    rerender();
  }
  function closeTermSheet() { state.ui.termSheet = null; state.ui.termGlossaryOpen = false; rerender(); }


  // The posts the client holds (state.posts.held). Nothing in this build
  // loads them - the ranked feed that did is gone, and the circle screen will
  // fill this slot - so in practice it renders nothing. It exists so the post
  // cards, reactions, caption edit and trained-together controls, which are
  // kept, have somewhere to be drawn and exercised.
  // The one way in: whatever loads posts for a screen hands them over here.
  window.holdPosts = function (posts) {
    state.posts.held = Array.isArray(posts) ? posts : [];
    rerender();
    if (state.posts.held.length) loadTrainingPartners(state.posts.held.map((r) => r && r.id)).then(() => rerender());
  };
  function renderHeldPosts() {
    const items = Array.isArray(state.posts.held) ? state.posts.held : [];
    if (!items.length) return "";
    return `<div class="log-list" id="communityHeldPosts">${items.map((post) => (post && post.post_type ? renderPostCard(post) : "")).join("")}</div>`;
  }
  window.renderCommunityApp = function () {
    // Design spec 3.3's "at most 4 markers per screen, first occurrence
    // only". The budget is per PAINT, which is what "per screen" means in an
    // app that re-renders the whole tab on every state change. Reset HERE
    // rather than in renderConfirmDialog() because app.js calls this first
    // (app.js:4241) and the dialog mount second (app.js:4287) - so an open
    // overlay shares the budget with the content behind it instead of
    // resetting it halfway through one paint.
    resetTermMarkBudget();
    if (!configured) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:8px;">הקהילה מוכנה לחיבור</div><div style="color:var(--steel);font-size:13px;line-height:1.7;">יש ליצור פרויקט Supabase, להריץ את קובץ המיגרציה ולהכניס URL ומפתח publishable בקובץ cloud-config.js. אין להכניס מפתח secret.</div></div>`;
    // Live bug hunt (2026-09-11): state.signupStarted is in-memory-only and
    // resets to false on reload - confirmed live, a real member whose
    // invite-code redemption had already committed server-side (the RPC's
    // response just never made it back before the reload) was bounced back
    // to this neutral "start" screen as if signup had never begun. Re-typing
    // the same (now-spent) code then failed with a generic "invalid/used"
    // error, misleading someone who actually is mid-signup. A confirmed
    // server-side redemption (state.redemption, loaded fresh by
    // loadRedemption() regardless of this in-memory flag) is exactly as
    // strong a signal as signupStarted that this session should skip the
    // neutral gate - the post-gate flow below already branches on
    // state.redemption to jump straight to the credentials step.
    if (!state.user || (state.user.is_anonymous && !state.signupStarted && !state.redemption)) {
      // Two real entry points — log into an existing account, or start fresh
      // with a club invite code. Nothing happens silently *from this screen*
      // — but state.user can already be a real (anonymous) session by the
      // time anyone opens this tab: maybeAutoStartBackup() (Settings >
      // protect my data) may have already created a backup-only session off
      // the back of a saved set, with no invite code and no Community
      // involvement at all. The is_anonymous + !signupStarted check keeps
      // that person on this same neutral choice instead of skipping straight
      // to "enter your invite code" as if they had clicked start-signup —
      // ensureAnonymousSession() below still no-ops for them since a session
      // already exists.
      //
      // ================ DESIGN SPEC SECTION 7: THE GATE WAS BACKWARDS =======
      //
      // Until now this branch rendered ONE screen, and it led with a login
      // form and a 56px primary `התחברות ושחזור החשבון` — for an account the
      // arriving member does not have. The path they actually need was an
      // 11px underlined .link-btn at the bottom of it.
      //
      // For a club rolling this out to a cohort, EVERY arriving member is
      // new. The primary action was the one almost nobody needs. The
      // beginner persona's verbatim first reaction was "I don't have a
      // username. Did I already sign up and forget? Did I do something
      // wrong?" — a member blaming herself for the app's ordering.
      //
      // So the one screen becomes two, and they swap emphasis:
      //
      //   gateView ""      the neutral CHOICE screen. Says what the community
      //                    is, then offers the invite code as the primary
      //                    .save-btn and login as a real >=44px secondary
      //                    control (.gate-alt — not the 13px .link-btn that
      //                    was the defect, just pointed the other way).
      //   gateView "login" the credential form, alone on a screen.
      //
      // THE TWO SENTENCES MOVED UP VERBATIM. The invite-code screen's own
      // copy — "הכניסה עם קוד הזמנה שמקבלים מחבר/ה במעגל" and "הקוד לא נוגע
      // לרישום האימונים" — is the app's own best writing and the sentence
      // that stops a nervous member panicking. It was one screen too late.
      // It is repeated on the invite step rather than moved off it:
      // reassurance is allowed to repeat.
      //
      // THE STAFF SENTENCE IS DELETED FROM THE GATE. "הסנכרון הפרטי" and
      // "הרשאות הצוות" mean nothing to a member and were being shown, at
      // 12.5px, to a person who has no account and no staff role. Rewritten
      // in member terms and shown only on the login screen, which is the one
      // place it is answering a question somebody actually asked.
      //
      // WHAT THIS DOES *NOT* FIX, so nobody believes it did: the spec claims
      // splitting login onto its own screen is also the structural fix for
      // the duplicate input[name="username"]. It is not. Measured on the
      // real boot: the second field is backupCredentials in #settingsBody,
      // which app.js repopulates on EVERY render regardless of whether the
      // settings overlay is open (app.js:4263), so it sits in the DOM
      // permanently — display:none, but present — from the moment any
      // anonymous backup session exists. The gate was never rendering two
      // forms at once. What this split genuinely buys is that a COLD
      // ARRIVING MEMBER now has zero credential forms mounted instead of
      // one, so the collision needs a deliberate tap onto the login screen
      // to happen at all. The real fix is app.js's, and is reported there.
      if (!state.signupStarted && state.ui.gateView !== "login") {
        return `<div class="chart-card" style="padding:0;overflow:hidden;">

          <div style="padding:16px;">
          <div style="font-weight:800;font-size:20px;margin-bottom:8px;">קהילת המועדון</div>
          <div style="color:var(--chalk);font-size:15px;line-height:1.5;margin-bottom:12px;">${bidiText("כאן רואים מה קורה במועדון: אימונים ושיאים של חברי המועדון, ולוחות תוצאות.")}</div>
          <div style="color:var(--steel);font-size:14px;line-height:1.6;margin-bottom:18px;">${bidiText("הכניסה עם קוד הזמנה שמקבלים מחבר/ה במעגל. הקוד לא נוגע לרישום האימונים שלכם — הוא רק פותח את לשונית הקהילה.")}</div>
          <button class="save-btn" data-community-action="start-signup">יש לי קוד הזמנה</button>
          <div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:18px;">
            <span style="color:var(--steel);font-size:14px;">${bidiText("כבר יש לך חשבון קהילה?")}</span>
            <button class="gate-alt" data-community-action="show-login">התחברות</button>
          </div>
          ${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}
          </div>
        </div>`;
      }
      if (!state.signupStarted) {
        return `<div class="chart-card">
          <button class="gate-back" data-community-action="gate-back">‹ חזרה</button>
          <div style="font-weight:800;font-size:20px;margin:6px 0 8px;">התחברות לקהילה</div>
          <div style="color:var(--steel);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("התחברות מחזירה את הפרופיל שלך, את מי שאת/ה עוקב/ת אחריו ואת ההיסטוריה בקהילה — גם במכשיר חדש.")}</div>
          <form id="communityLogin">${field("communityLogin", "username", LOGIN_IDENTIFIER_LABEL, `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="${esc(LOGIN_IDENTIFIER_LABEL)}" required/>`)}${field("communityLogin", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="current-password" placeholder="סיסמה" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">התחברות</button></form>
          ${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}
          ${LOGIN_RECOVERY_NOTE}
        </div>`;
      }
      ensureAnonymousSession();
      return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">מתחברים לקהילה…</div><div style="color:var(--steel);font-size:13px;">שנייה אחת.</div>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    }
    // Launch-readiness audit, CQ-006. Neither loader has ever run
    // successfully yet (both null) but the last attempt errored - render a
    // retry screen instead of assuming "not joined", which is what the two
    // gates below this one would otherwise conclude for a returning member
    // on a flaky connection.
    if ((state.profileLoadError && !state.profile) || (state.redemptionLoadError && !state.redemption)) {
      return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">בעיה בטעינת הקהילה</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">לא הצלחנו לטעון את פרטי החשבון. ייתכן שזו בעיית רשת זמנית.</div><button class="save-btn" data-community-action="retry-join-load">ניסיון חוזר</button></div>`;
    }
    // The invite step. Two things landed here with the joining QR:
    //
    // 1. A prefilled note. captureInviteDeepLink() fills state.ui.inviteCodeDraft
    //    from ?invite=, so someone who scanned a flyer arrives with the field
    //    already full - and a form that fills itself, unexplained, reads as a
    //    bug rather than a convenience. The line says where it came from and
    //    is only rendered when there is genuinely a prefilled draft.
    // 2. A way back to the login form (see the back-to-login handler). The
    //    deep link sets signupStarted, which skips the neutral
    //    log-in-or-start-fresh screen - correct for a genuine new member,
    //    wrong for a returning one who scanned the same flyer, and this is
    //    their way out.
    // 3. Design spec 7.2: a `‹ חזרה` control at >=44px. Before it, the only
    //    button on this screen was `אישור קוד` — a member who tapped in by
    //    accident, or who wants to re-read what the community even is, had
    //    to leave via the bottom tab bar and lose their place. It is
    //    deliberately a SEPARATE control from "כבר יש לכם חשבון? התחברות"
    //    below it, because they go to different places and answer different
    //    questions: back to the choice screen, versus straight to the login
    //    form. Collapsing them would make one of the two labels a lie.
    if (!state.redemption) return `<div class="chart-card"><button class="gate-back" data-community-action="gate-back">‹ חזרה</button>${renderJoinProgress(0)}<div style="font-weight:800;font-size:18px;margin:0 0 6px;">קוד הזמנה למועדון</div><div style="color:var(--steel);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("הכניסה עם קוד הזמנה שמקבלים מחבר/ה במעגל. הקוד לא נוגע לרישום האימונים שלכם — הוא רק פותח את לשונית הקהילה.")}</div>${state.ui.inviteCodeDraft ? `<div class="footer-note" data-invite-prefilled="1" style="margin-bottom:10px;color:var(--brass);">${bidiText("הקוד מולא אוטומטית מהקישור שנסרק. אפשר להמשיך.")}</div>` : ""}<form id="communityInviteCode">${field("communityInviteCode", "code", "קוד הזמנה", `<input class="text-input" name="code" dir="ltr" inputmode="text" autocomplete="off" autocapitalize="off" maxlength="128" placeholder="קוד הזמנה" value="${esc(state.ui.inviteCodeDraft)}" data-invite-code required/>`)}<button class="save-btn" type="submit"${state.ui.redeemingCode ? " disabled" : ""} style="margin-top:12px;">${state.ui.redeemingCode ? "בודקים…" : "אישור קוד"}</button></form><div style="display:flex;justify-content:center;margin-top:16px;"><button class="gate-alt" data-community-action="back-to-login">כבר יש לכם חשבון? התחברות</button></div>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    // Right after the code, before anything else — this is what turns the
    // bootstrap anonymous session into a real, log-in-from-any-device
    // account. state.user.is_anonymous flips to false the moment
    // setCredentials() succeeds, so a returning user (who logged in with
    // real credentials to begin with) never sees this screen at all.
    if (state.user.is_anonymous) return `<div class="chart-card">${renderJoinProgress(1)}<div style="font-weight:800;font-size:18px;margin-bottom:6px;">יצירת חשבון</div><div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:14px;">${CREDENTIALS_INTRO_TEXT}</div><form id="communityCredentials">${field("communityCredentials", "username", LOGIN_NAME_LABEL, `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="${esc(USERNAME_RULE_TEXT)}" data-live-validate="username" data-live-validate-form="communityCredentials" required/>`)}${field("communityCredentials", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="${esc(PASSWORD_RULE_TEXT)}" data-live-validate="password" data-live-validate-form="communityCredentials" required/>`)}${field("communityCredentials", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" data-live-validate="passwordConfirm" data-live-validate-form="communityCredentials" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">יצירת חשבון</button></form>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    // Redesign, Phase 3. Three purely informational screens, shown once per
    // device, right where the mockup's own new-member flow put them: after
    // credentials exist (so is_anonymous is already false and this gate is
    // reached at all) but before profile completion, which is what makes
    // "המשך להשלמת הפרופיל" on the last screen an honest label rather than
    // a lie about what happens next.
    //
    // BOTH HALVES OF THE PREDICATE ARE LOAD-BEARING, and the first one was
    // missing until a launch-readiness re-audit reproduced it live. The
    // original comment here claimed "a returning member (who already has a
    // profile) never reaches this line at all", inferring it from the
    // credentials gate above. That inference was wrong: the gates above only
    // establish a session, a redemption and non-anonymity, all three of
    // which a returning member logging in ON A NEW DEVICE satisfies - and
    // the seen-flag is per-device localStorage, so it is unset for them.
    // They landed on all three intro screens and had to click through them
    // before reaching the club, and the last screen's "המשך להשלמת הפרופיל"
    // promised a profile form they were never going to see because they
    // already have a profile. !state.profile is what actually expresses
    // "brand-new member, has not completed signup yet" - the same condition
    // the profile-completion gate immediately below runs on, so the carousel
    // now precedes exactly the flow it was written for and nothing else.
    // Without this gate, a fresh code-redeemer landed straight on the Feed
    // sub-tab — mostly empty, nothing prompting them to the profile form
    // buried in Account — with no clear signal anything had actually been
    // saved. Now profile creation is unskippable, same pattern as the
    // gates above it: this screen is all there is until a profile exists,
    // and the whole screen changing to the real tabbed UI afterward is the
    // confirmation, not just a toast that's easy to miss.
    if (!state.profile) return `<div class="chart-card">${renderJoinProgress(3)}<div style="font-weight:800;font-size:18px;margin-bottom:6px;">השלמת פרופיל</div><div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:14px;">כמעט סיימתם — עוד רגע אחד ותהיו בפנים. ${CLUB_NAME_HINT_TEXT}</div><form id="communityProfile">${field("communityProfile", "displayName", CLUB_NAME_LABEL, `<input class="text-input" name="displayName" dir="auto" placeholder="למשל דנה כהן" required/>`)}<div class="footer-note" style="margin:6px 0 12px;">${CLUB_NAME_HINT_TEXT}</div><label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי"></textarea></label><button class="save-btn" type="submit" style="margin-top:12px;">שמירת פרופיל</button></form>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    // COMM-016. Credentials are set and the profile row exists, but the
    // account has not been stamped recoverable yet, so is_community_member()
    // still blocks every write. Try once automatically (guarded inside
    // verifyRecovery so it cannot loop), then leave a manual retry. The
    // invite is already redeemed here and is never re-attempted, so a
    // failed verification does not consume it - the member can retry or
    // sign in again later on any device.
    if (!state.profile.recovery_verified_at) {
      verifyRecovery();
      // "עד להשלמת האימות אפשר לצפות בקהילה בלבד" - what this sentence used
      // to promise - is not what happens. is_community_member() gates the
      // READS too: with recovery_verified_at unset, feed_page,
      // community_search and announcements_read all refuse with 'recovery
      // method required', exactly as post_create does. Checked against the
      // real stack, not inferred: signed in as a member whose stamp was
      // cleared, all four calls came back 400 with that same message.
      //
      // So the screen was describing a browse-only state that does not
      // exist, to the one member who is standing in it and can see for
      // themselves that the feed is empty. Replaced with what is actually
      // true, plus the bound that matters most here - this gate is the
      // COMMUNITY's, and the workout log it sits next to never depended on
      // it. That pairing is the invite-code screen's own shape: say what
      // the thing is, then say what it does not touch.
      return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">אבטחת החשבון</div>
        <div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:14px;">כדי להשתתף בקהילה — לפרסם, להגיב, לעודד ולהצטרף לאתגרים — נדרש חשבון שאפשר לשחזר. שם המשתמש והסיסמה שהגדרתם הם דרך השחזור: הם מאפשרים להתחבר לאותו פרופיל מכל מכשיר, גם אחרי החלפת טלפון או מחיקת נתונים. עד להשלמת האימות הקהילה כולה סגורה — גם הפיד וגם הפרסום — ולכן כדאי להשלים אותו עכשיו; רישום האימונים והגיבוי הפרטי לא מושפעים וממשיכים לעבוד כרגיל.</div>
        <button class="save-btn" data-community-action="verify-recovery" style="margin-top:2px;">אימות והמשך</button>
        ${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    }
    const p = state.profile || {};

    const account = `<form id="communityProfile" class="chart-card"><div style="font-weight:800;font-size:16px;margin-bottom:12px;">הפרופיל שלי</div>
      ${field("communityProfile", "displayName", CLUB_NAME_LABEL, `<input class="text-input" name="displayName" dir="auto" value="${esc(p.display_name || "")}" placeholder="למשל דנה כהן" required/>`)}
      <div class="footer-note" style="margin:6px 0 12px;">${CLUB_NAME_HINT_TEXT}</div>
      <label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי">${esc(p.bio || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn primary" type="submit">שמירת פרופיל</button><button class="chip-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button></div>
    </form>`;

    const privacyRows = state.profile
      ? PRIVACY_FIELDS.map((f) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;"><span style="font-size:13px;">${f.label}</span><input type="checkbox" data-privacy-field="${f.key}"${state.profile[f.key] ? " checked" : ""} aria-label="${esc(f.label)}"/></label>`).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:62%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    const privacyPanel = `<div class="ach-section" id="communityPrivacyPanel" style="margin-top:18px;">${sectionHead("var(--blue)", "פרטיות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">כל שינוי נשמר מיד ונאכף בשרת.</div>
      <div class="log-list">${privacyRows}</div>
    </div>`;
    const blockedMembersPanel = renderBlockedMembersPanel();

    const marksOn = termMarksSwitchOn();
    const marksRetired = marksOn && !termMarksVisible();
    const termMarkPanel = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "מונחים והסברים")}
      <label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
        <span style="font-size:13px;">סימוני הסבר על מונחים<span style="color:var(--steel);display:block;font-size:11px;line-height:1.5;">${bidiText(marksRetired ? "העיגול הקטן עם ? ליד מונחים כמו AMRAP. הוא מפסיק להופיע אחרי שפותחים שלושה הסברים, וזה כבר קרה — אפשר להחזיר אותו בכל רגע." : "העיגול הקטן עם ? ליד מונחים כמו AMRAP. הוא נעלם מעצמו אחרי שפותחים שלושה הסברים.")}</span></span>
        <input type="checkbox" data-term-marks="1"${marksOn ? " checked" : ""} aria-label="סימוני הסבר על מונחים"/>
      </label>
      <button class="chip-btn" data-community-action="term-glossary-open" style="margin-top:10px;">כל המונחים</button>
    </div>`;

    const accountTab = `<div class="chart-card" id="communityHead" style="margin-bottom:12px;"><div class="flex" style="justify-content:space-between;align-items:center;gap:10px;"><div style="font-weight:800;font-size:16px;">${bidiText(p.display_name || p.handle || "")}</div>${renderNotificationBell()}</div></div>`
      + renderHeldPosts() + account + renderMyAchievements() + privacyPanel + renderSharePromptPrefPanel() + blockedMembersPanel + renderNotifPrefsPanel() + termMarkPanel
      + selfExportButtonHtml("display:block;margin:20px auto 0;")
      + `<button class="link-btn" data-community-action="sign-out" style="display:block;margin:20px auto 0;">התנתקות</button>`
      + `<button class="link-btn" data-community-action="delete-account" style="display:block;margin:10px auto 8px;color:var(--red-text);">בקשת מחיקת חשבון</button>`;

    return `<section class="scene-page ${window.PAGE_SCENES.community.className}" aria-labelledby="pageTitle-community">
      <div class="scene-page__media" aria-hidden="true"></div>
      <div class="scene-page__scrim" aria-hidden="true"></div>
      <div class="scene-page__intro">
        <div class="scene-page__brand">${esc(brandWordmark())}</div>
        <h1 id="pageTitle-community" class="scene-page__title">קהילה</h1>
      </div>
      <div class="scene-sheet">
    <div class="stripe-ribbon" aria-hidden="true"></div>`
      + (state.ui.message ? `<div role="status" aria-live="polite" style="position:fixed;left:0;right:0;bottom:calc(var(--bottom-nav-reserve) - 118px);display:flex;justify-content:center;padding:0 16px;z-index:60;pointer-events:none;"><div style="max-width:448px;background:var(--surface);border:1px solid var(--brass);color:var(--brass);border-radius:14px;padding:11px 16px;font-size:13px;font-weight:700;line-height:1.45;box-shadow:var(--shadow-card);text-align:center;">${esc(state.ui.message)}</div></div>` : "")
      + renderOutboxBanner()
      + accountTab
      + `</div></section>`;
  };

  function outboxActionLabel(action) {
    return {
      post_create: "פוסט",
      add_post_comment: "תגובה",
      toggle_reaction: "לייק",
      event_rsvp: "הרשמה לאירוע",
      chal_record_progress: "עדכון התקדמות",
      pr_share: "שיתוף שיא",
      ach_share: "שיתוף מדליה",
      // Not an OUTBOX_ACTION - a table upsert with its own handler, see
      // registerOutboxHandlers() - but it reaches this banner the same way
      // every other member write does, so it needs a Hebrew noun here too.
      workout_share: "שיתוף אימון",
      // The queue's own actions are the five above, but a row queued by an
      // OLDER build can name an action this table has never heard of - the
      // same case outbox.js reports as "unsupported action". The fallback
      // used to be `action` itself, so that row labelled itself to the
      // member with a raw English identifier ("chal_record_progress"). A
      // generic Hebrew noun says no less: serverErrorText() on the line
      // below already explains that the op is from a retired version.
    }[action] || "פעולה";
  }
  function renderOutboxBanner() {
    const pending = state.outbox.pending || 0;
    const failed = state.outbox.failed || [];
    if (!pending && !failed.length) return "";
    let html = "";
    if (pending) {
      html += `<div class="chart-card" role="status" style="margin-bottom:10px;border-color:var(--brass);">
        <div class="flex items-center gap-8"><span class="icon-chip icon-chip-brass" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg></span><div style="font-weight:800;font-size:13.5px;">${pending} ${pending === 1 ? "פעולה ממתינה" : "פעולות ממתינות"} לשליחה</div></div>
        <div style="color:var(--steel);font-size:12.5px;margin-top:4px;">יישלחו אוטומטית כשהחיבור יחזור.</div>
      </div>`;
    }
    if (failed.length) {
      html += `<div class="chart-card" role="alert" style="margin-bottom:10px;border-color:var(--red);">
        <div class="flex items-center gap-8" style="margin-bottom:2px;"><span class="icon-chip" style="background:color-mix(in srgb, var(--red) 16%, transparent);color:var(--red-text);" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></span><div style="font-weight:800;font-size:13.5px;color:var(--red-text);">${failed.length} ${failed.length === 1 ? "פעולה נכשלה" : "פעולות נכשלו"}</div></div>
        <div style="color:var(--steel);font-size:12.5px;margin:4px 0 8px;">${failed.some((r) => serverErrorIsRetryable(r.lastError)) ? "אפשר לנסות שוב או להסיר מהתור." : "אף אחת מהן לא תעבור בניסיון חוזר — הסבר לכל פעולה למטה."}</div>
        ${failed.map((r) => `<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:8px;">
          <div style="font-weight:700;font-size:12.5px;">${bidiText(outboxActionLabel(r.action))}</div>
          <div style="color:var(--steel);font-size:12px;margin-top:2px;">${bidiText(serverErrorText(r.lastError))}</div>
          <div class="chip-row" style="margin-top:6px;">
            ${serverErrorIsRetryable(r.lastError) ? `<button class="chip-btn" data-community-action="outbox-retry" data-id="${esc(r.id)}">ניסיון חוזר</button>` : ""}
            <button class="chip-btn danger" data-community-action="outbox-discard" data-id="${esc(r.id)}">הסרה</button>
          </div>
        </div>`).join("")}
      </div>`;
    }
    return html;
  }
  // Sharing (see renderShareControl) can now be triggered from the
  // Calendar and Progress tabs, not just the Community tab, so the
  // confirm dialog can no longer live only inside renderCommunityApp()'s
  // own output - it has to render regardless of which top-level tab is
  // active. app.js's own render() appends this unconditionally after
  // every tab's content (see index.html/app.js render()).
  window.renderCloudConfirmDialog = renderConfirmDialog;
  // Fresh-eyes audit: the term glossary (WOD/AMRAP/Thruster/Snatch/...) was
  // only reachable from Community Settings, three taps deep and behind
  // Community membership entirely - useless to a trainee confused by
  // benchmark-WOD jargon in the OFFLINE catalogue (app.js), which loads and
  // is usable with no Community account at all. cloud.js's own IIFE runs
  // unconditionally regardless of Community configuration (see the many
  // other window.* exports around this one), so this is safe to call from
  // app.js any time - mirrors the "term-glossary-open" action exactly.
  window.openTermGlossary = function () {
    state.ui.termSheet = TERM_GLOSSARY[0].id;
    state.ui.termGlossaryOpen = true;
    rerender();
  };
  // app.js's stale-backup-export reminder (renderSettingsBody) reads this to
  // pick its threshold: someone already covered by automatic cloud sync
  // needs the local-export nudge far less urgently than someone who is not.
  // app.js's support sheet files its report here when Community is available.
  // Returns true only on a confirmed server write, so app.js can fall back to
  // the WhatsApp/mail handoff on ANY failure rather than telling a member
  // their report was received when it was not (2026-09-15).
  window.communitySubmitBugReport = async function (body, diagnostics) {
    if (!client || !state.user || !state.syncEnabled) return false;
    try {
      const { error } = await client.rpc("bug_report_submit", {
        p_body: String(body || ""),
        p_diagnostics: diagnostics && typeof diagnostics === "object" ? diagnostics : {},
      });
      return !error;
    } catch (e) { return false; }
  };
  window.cloudSyncActive = function () { return !!(state.user && state.syncEnabled); };
  window.cloudStorageStatusText = function () {
    if (!configured) return "נשמר במכשיר הזה בלבד, ללא שרת";
    if (backupOptedOut()) return "נשמר במכשיר הזה בלבד — גיבוי אוטומטי כבוי";
    // S15. "will be backed up with the next save" is true only once consent is
    // settled. While the card is still pending (backupConsent === null,
    // app.js) the next save does NOT start a backup - it shows the card and
    // waits for an answer. Promising otherwise told a member their data was
    // about to leave the device when it was not, which is the wrong direction
    // for a status line to be wrong in.
    if (!state.user) {
      return backupConsentPending()
        ? "נשמר במכשיר; נשאל אתכם על גיבוי לענן אחרי השמירה הבאה"
        : "נשמר במכשיר; יגובה אוטומטית ופרטית עם השמירה הבאה";
    }
    return state.syncEnabled ? "נשמר במכשיר ומגובה אוטומטית ופרטית לחשבון" : "נשמר במכשיר; סנכרון ענן ממתין לאישורכם";
  };
  // Settings > "נתונים וגיבוי" (window.renderSettingsBody in app.js embeds
  // this HTML directly, same cross-file pattern as cloudStorageStatusText
  // above and renderCloudConfirmDialog below). Deliberately outside the
  // Community tab's whole gated sequence - COMM-016 (invite code, profile,
  // recovery verification) never has to be reached just to keep a private
  // backup running. "join community" stays a fully separate, later,
  // optional decision on the Community tab, never blended into this one.
  // ---- Five-persona UX audit: two cards, one word, one contradiction -----
  //
  // Three personas flagged this panel, and two separate defects were tangled
  // together in it.
  //
  // ONE: "מתחילים להתגבות" is not Hebrew. There is no verb להתגבות - the
  // reflexive of לגבות does not exist in this sense - so the single sentence
  // introducing the whole backup feature was built on a made-up word. Now
  // "מתחילים להיות מגובים".
  //
  // TWO: this is the CLOUD card and app.js's export reminder is the LOCAL
  // FILE card, and both used to call themselves just "גיבוי". A member who
  // had cloud backup running was told a few lines away that they had never
  // backed up - two true statements about two different things, reading as
  // one self-contradicting screen. app.js has since taken the file side of
  // the split ("קובץ גיבוי להורדה" / "לא הורדתם קובץ גיבוי"); this is the
  // cloud side of the same split. Every branch below now opens with the
  // feature's full name, says the sync is automatic and runs in the
  // background, and names the OTHER card explicitly so a member who reads
  // both knows they are looking at two mechanisms and not one broken one.
  // The other card is referenced by its title rather than its position on
  // the screen, so re-ordering the settings pane cannot make this a lie.
  // S15. window.haimuniaBackupConsentPending (app.js) is the one owner of the
  // pending state; read through a wrapper so a missing app.js - the community
  // module is loaded on its own in some tests - degrades to "not pending"
  // rather than throwing inside a render.
  function backupConsentPending() {
    try {
      return typeof window.haimuniaBackupConsentPending === "function"
        && window.haimuniaBackupConsentPending() === true;
    } catch { return false; }
  }

  const BACKUP_PANEL_TITLE = `<div style="font-weight:800;font-size:13.5px;margin-bottom:4px;">גיבוי אוטומטי לענן</div>`;
  // The two facts a member switching this off almost certainly believes it
  // does, and does not. Both are stated plainly in PRIVACY.md ("כיבוי לא
  // מוחק... מהענן מה שכבר הועלה", and the anonymous account keeps existing
  // under its own 30-day rule), so leaving them out of the UI would leave
  // the screen quietly contradicting the policy. Shown on the opted-out
  // card, which is where the member lands the instant they tap - a durable
  // surface they can re-read, rather than a toast that is gone in five
  // seconds.
  const BACKUP_OPTOUT_TRUTHS = `<div class="footer-note" style="margin-bottom:8px;">הכיבוי עוצר העלאות מכאן והלאה בלבד: הוא לא מוחק מהענן את מה שכבר הועלה, ולא סוגר את החשבון שנפתח לגיבוי. למחיקת מה שכבר בענן צריך לבקש מחיקת חשבון.</div>`;
  // Launch-readiness audit B5. PRIVACY.md tells a backup-only member that
  // removing what was backed up means requesting account deletion, and the
  // only button for that lived in the Community account tab - which a member
  // with no profile never sees. This is the same request, from the card the
  // backup lives on. Confirmed inline rather than through the community
  // confirm sheet: that sheet is painted by the Community view, and this card
  // is in Settings. Two steps, the destructive one on a red-bordered panel
  // that says what goes, what stays, and when.
  function backupDeleteHtml() {
    if (!state.user) return "";
    if (!state.ui.backupDeleteConfirm) {
      return `<button class="link-btn" data-community-action="backup-delete" style="display:block;margin-top:10px;color:var(--red-text);">מחיקת הגיבוי מהענן</button>`;
    }
    const alsoProfile = state.profile ? " גם הפרופיל והשיתופים בקהילה יוסרו מיד." : "";
    return `<div class="footer-note" role="group" aria-labelledby="backupDeleteTitle" style="margin-top:12px;padding:10px;border-radius:8px;border:1px solid var(--red-text);">
      <h2 id="backupDeleteTitle" style="margin-top:0;margin-bottom:4px;font-size:13.5px;font-weight:800;color:var(--red-text);">מחיקת הגיבוי מהענן</h2>
      <div style="margin-bottom:10px;">כל מה שגובה לענן, יחד עם החשבון שנפתח לגיבוי, יימחק לצמיתות בתוך 30 יום.${esc(alsoProfile)} האימונים שבמכשיר הזה נשארים, והגיבוי האוטומטי ייכבה כדי שהשמירה הבאה לא תפתח גיבוי חדש.</div>
      <div class="chip-row" style="margin-top:0;">
        <button class="chip-btn" data-community-action="backup-delete-cancel">ביטול</button>
        <button class="chip-btn primary danger" data-community-action="backup-delete-confirm">מחיקה</button>
      </div>
    </div>`;
  }
  window.renderBackupSettingsPanel = function () {
    if (!configured) return "";
    if (backupOptedOut()) {
      return `${BACKUP_PANEL_TITLE}<div class="footer-note" style="margin-bottom:8px;">כבוי. מהשמירה הבאה האימונים נשמרים במכשיר הזה בלבד.</div>${BACKUP_OPTOUT_TRUTHS}<button class="link-btn" data-community-action="backup-enable">הפעלת גיבוי אוטומטי</button>${selfExportButtonHtml()}${backupDeleteHtml()}${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}`;
    }
    if (!state.user) {
      return `${BACKUP_PANEL_TITLE}<div class="footer-note" style="margin-bottom:8px;">${backupConsentPending() ? "אחרי השמירה הבאה נשאל אתכם אם לגבות את האימונים לענן. עד שתענו הכול נשאר במכשיר הזה בלבד." : "מהשמירה הראשונה האימונים שלכם מתחילים להיות מגובים לענן ברקע, אוטומטית ופרטית — רק אתם רואים אותם."} הסנכרון קורה מעצמו ואין כאן קובץ להוריד; „קובץ גיבוי להורדה" הוא דבר נפרד במסך הזה. אפשר לכבות בכל שלב.</div><button class="link-btn" data-community-action="backup-optout">כיבוי גיבוי אוטומטי</button>`;
    }
    // How much is actually at stake, and how loudly to say it. See
    // src/dormancy.js - the short version is that an anonymous account is
    // reachable ONLY by the refresh token in this browser, so clearing site
    // data or changing phones strands the cloud copy permanently. Never
    // phrased as a deletion threat: since 202609070001 these accounts are
    // RETAINED, and saying otherwise would be a promise the database does
    // not keep - the same defect the purge bug had, pointed the other way.
    const backupRisk = (function () {
      if (!window.HaimuniaDormancy || typeof window.haimuniaTrainingDataSummary !== "function") return { level: "soft" };
      let summary = { entryCount: 0, daysSinceExport: null };
      try { summary = window.haimuniaTrainingDataSummary() || summary; } catch (e) {}
      const created = state.user && state.user.created_at ? Date.parse(state.user.created_at) : NaN;
      return window.HaimuniaDormancy.assess({
        configured: true, optedOut: false, signedIn: true,
        isAnonymous: !!state.user.is_anonymous,
        hasRecovery: !!(state.profile && state.profile.recovery_verified_at),
        entryCount: summary.entryCount,
        daysSinceExport: summary.daysSinceExport,
        accountAgeDays: isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : 0,
      });
    })();
    const unreachableWarning = backupRisk.level === "urgent"
      ? `<div class="footer-note" role="status" style="margin:0 0 10px;padding:10px;border-radius:8px;border:1px solid var(--red-text);color:var(--red-text);">האימונים שלכם מגובים לחשבון אנונימי — אין אליו שם משתמש או סיסמה, והדרך היחידה אליו היא הדפדפן הזה. אם תנקו את נתוני האתר, תחליפו מכשיר או תאבדו את הטלפון, הגיבוי יישאר בשרת ולא תוכלו להגיע אליו. אף אחד לא ימחק אותו — פשוט לא תוכלו לפתוח אותו.<div style="margin-top:8px;"><button class="chip-btn" data-community-action="backup-download-copy">הורדת עותק עכשיו</button></div></div>`
      : "";
    const credentialsCta = state.user.is_anonymous
      ? `<div style="margin-top:12px;">${unreachableWarning}<div class="footer-note" style="margin-bottom:6px;">${backupRisk.level === "urgent" ? "הפתרון הקבוע: שם לכניסה וסיסמה. אחריהם אפשר להיכנס לאותם נתונים מכל מכשיר." : "גישה לאותם נתונים ממכשיר אחר דורשת שם לכניסה וסיסמה."}</div><form id="backupCredentials">${field("backupCredentials", "username", LOGIN_NAME_LABEL, `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="${esc(USERNAME_RULE_TEXT)}" data-live-validate="username" data-live-validate-form="backupCredentials" required/>`)}${field("backupCredentials", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="${esc(PASSWORD_RULE_TEXT)}" data-live-validate="password" data-live-validate-form="backupCredentials" required/>`)}${field("backupCredentials", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" data-live-validate="passwordConfirm" data-live-validate-form="backupCredentials" required/>`)}<button class="chip-btn primary" type="submit" style="margin-top:6px;">שמירת גישה ממכשיר אחר</button></form></div>`
      : "";
    return `${BACKUP_PANEL_TITLE}<div class="footer-note" style="margin-bottom:8px;">${esc(state.syncEnabled ? "פעיל. האימונים שלכם מגובים לענן ברקע, אוטומטית ופרטית — רק אתם רואים אותם. הסנכרון קורה מעצמו ואין כאן קובץ להוריד; „קובץ גיבוי להורדה\" הוא דבר נפרד במסך הזה." : "מוגדר אך טרם הופעל.")}</div><button class="link-btn" data-community-action="backup-optout">כיבוי גיבוי אוטומטי</button>${credentialsCta}${selfExportButtonHtml()}${backupDeleteHtml()}${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}`;
  };
  // ---- Shared Phase 1 dialog focus + keyboard management (COMM-190) -----
  // Every Phase 1 overlay dialog behaves the same way: focus moves in on
  // open, Tab / Shift+Tab cycle within it, Escape and a backdrop click both
  // close it, and focus returns to whatever opened it. Per-dialog Escape
  // wiring lives in the document keydown handler; this block owns focus-in,
  // the Tab trap, the backdrop, and focus restoration. Registry order is the
  // stacking order used when more than one state flag is set at once. It
  // matches the Escape handler's precedence: a sheet stacked over another
  // dialog is the one that closes and the one that traps Tab.
  //
  // COMM-365. `key` is the DOM key (the data-cloud-dialog attribute value on
  // the overlay, and the key cloudDialogOpeners is keyed by) and is unchanged
  // by the state namespacing - it is markup, not a state path. `isOpen` is how
  // this registry now reads the flag: before namespacing it could do
  // state[key], which only worked because every dialog flag happened to be a
  // top-level sibling. A getter per entry keeps the registry the single place
  // that knows where a dialog's flag lives, so a dialog whose state moves
  // domains needs a change here and nowhere else.
  const CLOUD_DIALOGS = [
    // Launch-readiness audit, A3. Must stay FIRST: askConfirm() is a
    // modal-on-modal confirmation that renders LAST, on top of whatever
    // triggered it (cloud.js:~10895's z-order fix is the mouse-side half of
    // this same fact) - currentCloudDialog() returns the first array match
    // whose isOpen() AND DOM element both exist, not the topmost dialog, so
    // when the confirm sheet is stacked on another open dialog it has to be
    // checked before that dialog or the Tab trap locks focus in the
    // (visually covered, non-interactive) dialog underneath and Escape
    // closes the wrong one. Before this entry existed, the confirm sheet
    // carried no data-cloud-dialog attribute at all and was invisible to
    // this registry, the Tab trap and the Escape chain - reachable by mouse
    // only, gating ~19 destructive actions including delete-account.
    { key: "confirmSheet", isOpen: () => state.ui.confirmDialog, close: function () { closeConfirm(); } },
    // Five-persona UX audit, outward sharing. SECOND for the same reason the
    // confirm sheet is first: this sheet is opened from inside the PR prompt
    // and the achievement celebration and renders on top of them, so it has
    // to be checked before either or the Tab trap locks focus into the
    // covered dialog underneath and Escape closes the wrong one.
    { key: "outwardShare", isOpen: () => state.posts.outwardShare, close: function () { closeOutwardShare(); } },
    // Design spec section 3, tier 3. THIRD, and for the same stacking reason
    // the two entries above it are first and second: a `?` marker can be
    // rendered inside the challenge, event, recap or profile overlay's own
    // content, so the term sheet opens ON TOP of those and has to be matched
    // before them or the Tab trap locks focus into the covered dialog
    // underneath and Escape closes the wrong one.
    //
    // It stays BELOW confirmSheet and outwardShare, and that ordering is not
    // arbitrary either: neither of those two can contain a term marker (one
    // is a title + message + two buttons, the other is a share preview), so
    // nothing can ever stack on top of the term sheet, while both of them
    // can still stack on top of it. Moving it above either would reintroduce
    // exactly the A3 defect this registry order exists to prevent.
    { key: "termSheet", isOpen: () => state.ui.termSheet, close: function () { closeTermSheet(); } },
    { key: "notifCenter", isOpen: () => state.notif.center, close: function () { closeNotifCenter(); } },
    { key: "achUnlock", isOpen: () => state.achievements.unlock, close: function () { dismissAchievementUnlock(); } },
    { key: "prPrompt", isOpen: () => state.posts.prPrompt, close: function () { dismissPrPrompt(); } },
    // Beside the PR prompt: same kind of surface, same moment, and the two
    // can never be open at once (offerSharePrompt(), share-prompt.js), so
    // their relative order settles nothing. Both stay below the three that
    // can stack on top of a prompt. See the pinned reasoning in
    // test/community-state-namespaces.test.mjs.
    { key: "workoutPrompt", isOpen: () => state.posts.workoutPrompt, close: function () { dismissWorkoutSharePrompt(); } },
    // 202609080002, the club WOD board. LAST, which is the mirror image of
    // its FIRST position in renderConfirmDialog()'s DOM order and follows the
    // same rule the three entries at the top of this list follow: this
    // registry returns the first array match, not the topmost dialog, so a
    // dialog that can have others stacked on top of it must be checked
    // AFTER them. Two can cover this one today - the confirm sheet (a coach
    // cancelling the session) and the term sheet (a `?` marker inside the
    // board's own score-type and Rx labels) - and NONE can ever be covered BY
    // it, since the board is only ever opened from the feed or the club-home
    // strip. Last is therefore the only position that cannot mis-trap focus,
    // and it stays correct if the rows later gain a tap that opens the
    // profile overlay: they already carry data-club-wod-user, the same
    // row-identity marker leaderboardRowHtml uses.
    //
    // WHY A DIALOG AT ALL, since this pin is a review trigger and not a
    // formality: the board is opened from a feed card and from the club-home
    // strip, exactly as challengeView and eventView are, and it has to sit
    // over the feed rather than replace it - a member taps a card, reads who
    // trained, attaches, and is back in the feed. The alternative considered
    // was a sixth sub-tab, which would have made "today's board" a
    // destination the member navigates TO, when the whole premise of the
    // feature is that it arrives in the feed they are already reading.
    // The "who reacted" list. LAST, beside the board, and for the identical
    // reason: it is only ever opened from a feed card, so nothing can be
    // covered BY it, while the confirm and term sheets can both cover it.
    { key: "reactors", isOpen: () => state.engagement.reactorsFor, close: function () { closeReactors(); } },
  ];
  const cloudDialogOpeners = {};
  let cloudOpenDialogKey = null;
  // The control a click is currently on, captured in the capture phase -
  // i.e. before the bubble-phase handler that opens a dialog runs and
  // re-renders #content, which would otherwise destroy that exact button
  // (every dialog opener lives inside #content and gets replaced by the
  // very render its own click triggers). One-shot: cleared at the end of
  // every syncCloudDialogFocus() call so a stale earlier click is never
  // mistaken for the one that just opened a dialog.
  let cloudDialogClickCandidate = null;
  // WHERE THE MEMBER'S FOCUS WAS INSIDE THE OPEN DIALOG, by position in its
  // own focusable order.
  //
  // Live bug hunt, fresh round 1 (2026-09-15). Surfaced by correcting a stale
  // test fixture, which let the club panel load analytics it had never loaded
  // in tests before - and a loader resolving while a modal is open triggers a
  // rerender that REBUILDS the dialog's DOM. The node holding focus stops
  // existing, document.activeElement falls back to <body>, and
  // syncCloudDialogFocus's "focus is no longer inside" branch does the only
  // thing it could: sends it to the first control.
  //
  // For anyone using a keyboard or a screen reader that is a real defect, not
  // a cosmetic one: you tab down to "confirm", an unrelated background load
  // lands, and you are silently back at the top of the sheet with the button
  // you were about to press no longer under you. It is invisible to a mouse
  // user, which is why it survived ten rounds of hunting.
  //
  // Tracked by INDEX rather than by element identity, because identity is
  // exactly what the rerender destroys. focusin rather than a pre-render hook,
  // so nothing has to remember to record it - the browser tells us.
  let cloudDialogFocusIndex = -1;
  document.addEventListener("focusin", function (e) {
    const key = currentCloudDialog();
    const el = key ? cloudDialogEl(key) : null;
    if (!el || !e.target || !el.contains(e.target)) { cloudDialogFocusIndex = -1; return; }
    cloudDialogFocusIndex = cloudDialogFocusables(el).indexOf(e.target);
  }, true);
  document.addEventListener("click", function (e) {
    const t = e.target;
    cloudDialogClickCandidate = (t && t.closest) ? t.closest("[data-community-action]") : null;
  }, true);
  // Real openers live inside #content and do not survive the render their
  // own click triggers, so what is remembered is a CSS selector built from
  // data-community-action plus every other data-* attribute the element
  // carries (id, decision, tab, status...) - specific enough in practice to
  // match exactly the one control that opened this dialog - re-resolved
  // against the live DOM when it is time to restore focus, rather than a
  // direct element reference that would already be detached by then.
  function cloudOpenerSelector(el) {
    if (!el || !el.getAttribute) return null;
    const action = el.getAttribute("data-community-action");
    if (!action) return null;
    let sel = '[data-community-action="' + action.replace(/"/g, '\\"') + '"]';
    Array.prototype.forEach.call(el.attributes, function (attr) {
      if (attr.name.indexOf("data-") === 0 && attr.name !== "data-community-action") {
        sel += "[" + attr.name + '="' + String(attr.value).replace(/"/g, '\\"') + '"]';
      }
    });
    return sel;
  }
  function cloudResolveOpener(info) {
    if (!info) return null;
    if (info.selector) {
      const bySel = document.querySelector(info.selector);
      if (bySel) return bySel;
    }
    return (info.el && document.contains(info.el)) ? info.el : null;
  }
  function cloudDialogEl(key) { return document.querySelector('[data-cloud-dialog="' + key + '"]'); }
  function cloudDialogFocusables(el) {
    if (!el) return [];
    return Array.prototype.slice.call(el.querySelectorAll(
      'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function (n) {
      return !n.disabled
        && n.getAttribute("aria-hidden") !== "true"
        && !/display:\s*none/.test(n.getAttribute("style") || "");
    });
  }
  function currentCloudDialog() {
    for (let i = 0; i < CLOUD_DIALOGS.length; i++) {
      const spec = CLOUD_DIALOGS[i];
      if (spec.isOpen() && cloudDialogEl(spec.key)) return spec.key;
    }
    return null;
  }
  // Same real-user report app.js's own history layer was built for (see its
  // comment above APP_DIALOGS's registrations: the Android back
  // gesture/button did nothing to close an open dialog, because this app
  // never pushed a history entry for one opening). That fix only reaches
  // APP_DIALOGS - CLOUD_DIALOGS is a wholly separate registry with its own
  // open/close plumbing, so it had the exact same gap independently: a
  // member with the composer, a challenge card, the notification centre,
  // etc. open, and no in-dialog Escape (a phone has none), had to
  // background or force-close the app to get out.
  //
  // app.js catches every transition with a MutationObserver on each
  // overlay's own `class` attribute, because its overlay elements are
  // permanent DOM nodes that toggle an "open" class. CLOUD_DIALOGS overlays
  // are not - render() only emits a dialog's markup at all while its state
  // flag says open (see cloudDialogEl() above: it queries for the element,
  // it does not toggle a class on one that is always present) - so there is
  // no permanent node for a MutationObserver to watch. syncCloudDialogFocus()
  // is the equivalent hook here: it already runs after every single render
  // this module can cause (afterRenderCommunity() for the Community tab,
  // and directly from app.js's render() for every other tab - see that
  // call's own comment: "the composer and PR/achievement prompts render in
  // the global cloud overlay and can show on any tab") and already computes
  // openKey fresh each time, so it sees every open/close transition exactly
  // once, the same guarantee the observer gives app.js.
  //
  // Same reserve-one-back-press contract as app.js: pushState() on open
  // claims exactly one history entry; closing the dialog any OTHER way (X,
  // Escape, backdrop) consumes that same entry via history.back() so a
  // later real back-press is never left pointing at a dead state that takes
  // two presses to get past.
  let cloudDialogHistoryPushed = false;
  let cloudDialogClosingViaHistory = false;
  function syncCloudDialogHistoryState(openKey) {
    if (openKey && !cloudDialogHistoryPushed) {
      try { history.pushState({ cloudDialog: true }, ""); cloudDialogHistoryPushed = true; } catch (e) { /* history API unavailable in this embedding */ }
    } else if (!openKey && cloudDialogHistoryPushed && !cloudDialogClosingViaHistory) {
      cloudDialogHistoryPushed = false;
      try { history.back(); } catch (e) {}
    }
  }
  window.addEventListener("popstate", () => {
    if (!cloudDialogHistoryPushed) return;
    cloudDialogHistoryPushed = false;
    const dk = currentCloudDialog();
    if (!dk) return;
    const spec = CLOUD_DIALOGS.find((d) => d.key === dk);
    if (spec) { cloudDialogClosingViaHistory = true; spec.close(); cloudDialogClosingViaHistory = false; }
  });

  // Run after every community render. Moves focus into a dialog the first
  // time it appears and hands focus back to the opener once the last dialog
  // is gone. While the same dialog stays open across a re-render, focus is
  // left exactly where it is - so typing in a field that patches the DOM
  // directly instead of re-rendering is never disturbed - unless the
  // control that held it was itself removed by that re-render (e.g. an
  // "add a note" button swapped for a textarea), which would otherwise
  // silently drop focus to <body> and defeat the trap; that case falls
  // back to the dialog's first control rather than leaving the user
  // outside it.
  function syncCloudDialogFocus() {
    const openKey = currentCloudDialog();
    syncCloudDialogHistoryState(openKey);
    // One-shot: whatever was just clicked only ever explains *this* render
    // cycle's dialog transition, never a later one.
    const clickCandidate = cloudDialogClickCandidate;
    cloudDialogClickCandidate = null;
    if (openKey === cloudOpenDialogKey) {
      if (openKey) {
        const el = cloudDialogEl(openKey);
        const active = document.activeElement;
        if (el && !(active && el.contains(active))) {
          const f = cloudDialogFocusables(el);
          // Back to where they were, when that position still exists. Falls
          // through to the first control otherwise - a dialog that genuinely
          // shrank has nowhere better to go, and that was the whole of this
          // branch before.
          const want = (cloudDialogFocusIndex >= 0 && cloudDialogFocusIndex < f.length)
            ? f[cloudDialogFocusIndex] : f[0];
          if (want) { try { want.focus(); } catch (e) {} }
        }
      }
      return;
    }
    if (!openKey) {
      const prev = cloudOpenDialogKey;
      cloudOpenDialogKey = null;
      const opener = cloudResolveOpener(cloudDialogOpeners[prev]);
      delete cloudDialogOpeners[prev];
      if (opener && typeof opener.focus === "function") {
        try { opener.focus(); } catch (e) {}
      }
      return;
    }
    const active = document.activeElement;
    // A NESTED DIALOG JUST CLOSED, and its parent is still open.
    //
    // Live bug hunt, fresh round 4 (2026-09-15) - HIGH. The opener-restore
    // path above only runs when openKey becomes NULL, i.e. when everything
    // closed. Close a dialog that was opened from inside another - the share
    // sheet on top of the PR celebration, say - and openKey becomes the
    // PARENT's key instead, so this fell through to the "a dialog is freshly
    // opening" branch below. The parent is already registered in
    // cloudDialogOpeners, so that branch skipped re-registering and simply
    // focused the parent's FIRST control.
    //
    // Which is not a cosmetic miss. On both surfaces where this stacking
    // exists the first control is the PUBLISH action: dismissing the share
    // sheet put focus on "שיתוף למועדון", so a keyboard or screen-reader user
    // who pressed Enter out of reflex published their PR to the club feed
    // without ever choosing to. Invisible to a mouse user, which is why it
    // survived every prior round.
    //
    // Restoring the CLOSED dialog's own opener is what the member expects and
    // what the all-closed branch above already does; this is the same rule
    // applied one level in.
    if (cloudOpenDialogKey && openKey !== cloudOpenDialogKey
        && (openKey in cloudDialogOpeners) && !cloudDialogEl(cloudOpenDialogKey)) {
      const closed = cloudOpenDialogKey;
      const opener = cloudResolveOpener(cloudDialogOpeners[closed]);
      delete cloudDialogOpeners[closed];
      cloudOpenDialogKey = openKey;
      if (opener && typeof opener.focus === "function") { try { opener.focus(); } catch (e) {} }
      return;
    }
    if (!(openKey in cloudDialogOpeners)) {
      // Prefer the control that was just clicked (re-resolved by selector,
      // since the render this same click triggered may already have
      // destroyed it) over document.activeElement, which for a click-driven
      // open has usually already reverted to <body> by the time this runs.
      // An event-bus-triggered dialog (a PR or achievement celebration) has
      // no click to go on, so activeElement - whatever the member had
      // focused when the celebration appeared - is the right fallback.
      const activeCandidate = (active && active !== document.body && document.contains(active)) ? active : null;
      const primary = clickCandidate || activeCandidate;
      cloudDialogOpeners[openKey] = { el: primary, selector: cloudOpenerSelector(primary) };
    }
    cloudOpenDialogKey = openKey;
    const el = cloudDialogEl(openKey);
    if (!(el && active && el.contains(active))) {
      const f = cloudDialogFocusables(el);
      if (f.length) { try { f[0].focus(); } catch (e) {} }
    }
  }
  window.syncCloudDialogFocus = syncCloudDialogFocus;

  window.afterRenderCommunity = function () {
    ensureCommunityDataLoaded();
    if (state.user && notifPushEnabled() && !state.notif.pushChecked) loadNotifPushStatus();
    document.querySelectorAll("[data-privacy-field]").forEach((el) => {
      el.addEventListener("change", () => savePrivacyField(el.dataset.privacyField, el.checked));
    });
    document.querySelectorAll("[data-share-prompt-pref]").forEach((el) => {
      el.addEventListener("change", () => setSharePromptsEnabled(el.checked));
    });
    document.querySelectorAll("[data-term-marks]").forEach((el) => {
      el.addEventListener("change", () => {
        try { localStorage.setItem(TERM_MARKS_KEY, el.checked ? "1" : "0"); } catch (e) {}
        rerender();
      });
    });
    syncCloudDialogFocus();
  };

  window.handleCommunityClick = function (el) {
    const action = el.dataset.communityAction;
    if (action === "migrate") askConfirm({ title: "סנכרון היסטוריה", message: "להעלות את היסטוריית האימונים הפרטית לחשבון? שום נתון לא יפורסם בקהילה.", confirmLabel: "העלאה", action: "migrate" });
    // Settings > "protect my data" (window.renderBackupSettingsPanel) - fully
    // separate from Community's own join flow: no invite code, no feed, no
    // profile. "enable" clears the opt-out and starts (or resumes) a
    // backup-only anonymous session; "optout" stops future syncing and
    // remembers the choice so maybeAutoStartBackup() leaves it alone.
    else if (action === "backup-enable") {
      localStorage.removeItem(BACKUP_OPTOUT_KEY);
      if (!state.user) ensureAnonymousSession();
      else enableSyncIfAllowed();
      // Mirror of the opt-out toast below - same reason, same placement
      // before rerender(). Confirming only one direction of a toggle would
      // leave the ON tap with exactly the silence that got the OFF tap
      // reported as broken. Worded as a promise about the NEXT save, because
      // that is when the first upload actually happens; enabling does not
      // retroactively push what was logged while it was off.
      if (typeof window.showToast === "function") window.showToast("גיבוי אוטומטי לענן הופעל. האימונים יגובו מהשמירה הבאה.");
      rerender();
    }
    else if (action === "self-export") exportMyServerData();
    else if (action === "backup-delete") { state.ui.backupDeleteConfirm = true; rerender(); }
    else if (action === "backup-delete-cancel") { state.ui.backupDeleteConfirm = false; rerender(); }
    else if (action === "backup-delete-confirm") { state.ui.backupDeleteConfirm = false; requestDeletion(); }
    else if (action === "backup-download-copy") {
      // The one action a member can take right now that survives losing this
      // browser. app.js owns the file, so this only reports the outcome -
      // and reports FAILURE honestly rather than claiming a download that a
      // browser without URL.createObjectURL never started.
      // Live bug hunt (2026-09-11): haimuniaExportBackup() is now async
      // (buildBackupPayload() reads session notes off IndexedDB) - wrapped
      // in an IIFE rather than making this whole click handler async.
      (async () => {
        const ok = typeof window.haimuniaExportBackup === "function" && await window.haimuniaExportBackup();
        if (typeof window.showToast === "function") {
          window.showToast(ok ? "ההורדה התחילה. שמרו את הקובץ במקום שתמצאו אותו." : "ההורדה נכשלה. אפשר לייצא גיבוי ממסך ההגדרות.");
        }
        rerender();
      })();
    }
    else if (action === "backup-optout") {
      localStorage.setItem(BACKUP_OPTOUT_KEY, "1");
      if (state.syncEnabled) { state.syncEnabled = false; localStorage.setItem("haimunia-demo:cloudSyncEnabled", "0"); }
      // Five-persona UX audit: an admin reported that turning cloud backup
      // off "didn't appear to take effect". It always did - the flag flips,
      // it persists, and the panel re-renders to the opted-out state - but
      // the tap produced NO acknowledgement of any kind. The panel is three
      // lines of small grey text near the bottom of a long settings screen,
      // so the one thing that changed was the thing least likely to be in
      // view at the moment of the tap. The member is left tapping a control
      // that answers by rearranging text they cannot see.
      //
      // showToast() is app.js's existing rail (bottom-anchored, role=status,
      // 5s), reached through window the same cross-file way this file
      // already calls renderTabHeader() and communityShareCandidateFor().
      // Guarded on typeof because cloud.js is loaded BEFORE app.js and a
      // handler that fires before app.js has executed must not throw.
      //
      // Short by design: the toast confirms the STATE CHANGE and the one
      // fact that answers "so where are my workouts now". The two things a
      // member wrongly assumes an opt-out also does - deleting what is
      // already uploaded, closing the account - are in BACKUP_OPTOUT_TRUTHS
      // on the card itself, because those need to outlive five seconds and
      // be re-readable. A toast is the wrong place to disclose something
      // someone may want to act on.
      //
      // This button was inert from 8ab7ca6 until ffb786e: app.js's delegation
      // only dispatched [data-community-action] when the click had no
      // [data-action] ancestor, and #settingsOverlay carries
      // data-action="close-settings", so every community control inside
      // Settings was dropped before reaching this handler. It now dispatches
      // unconditionally. test/community-error-copy.test.mjs covers it with a
      // real DOM click.
      //
      // Set BEFORE rerender(), not after: showToast() only stores the
      // pending toast and schedules its expiry - it never paints on its own,
      // and app.js composes renderToastBar() during render(). Called after
      // the rerender below, the confirmation would sit invisible until some
      // unrelated event happened to trigger the next paint, which is the
      // same "no feedback at the moment of the tap" this is fixing.
      if (typeof window.showToast === "function") window.showToast("גיבוי אוטומטי לענן כובה. האימונים ממשיכים להישמר במכשיר הזה.");
      rerender();
    }
    else if (action === "cheer") react(el.dataset.id);
    else if (action === "publish") {
      const fileInput = document.getElementById("photo-" + el.dataset.id);
      const file = fileInput && fileInput.files && fileInput.files[0];
      const item = typeof window.communityShareCandidateFor === "function" ? window.communityShareCandidateFor(el.dataset.type, el.dataset.id) : null;
      const audience = el.dataset.visibility === "public" ? "לכולם, פומבי" : "לעוקבים שלכם בלבד";
      const preview = item ? `"${item.title}" — ${item.resultText}${file ? " (כולל תמונה)" : ""}` : "";
      askConfirm({ title: "פרסום תוצאה", message: `לפרסם ${audience}?${preview ? " " + preview : ""}`, confirmLabel: "פרסום", action: "publish", payload: { type: el.dataset.type, id: el.dataset.id, visibility: el.dataset.visibility, file } });
    }
    // Opened from the member card's "⋯" menu as well as from a post's -
    // either way the menu has served its purpose once the confirm is up.
    else if (action === "block") { state.posts.openMenu = null; askConfirm({ title: "חסימת משתמש", message: "לחסום את {subject}? לא תראו זה את זה בקהילה.", subject: subjectNameFor(el.dataset.id), confirmLabel: "חסימה", destructive: true, action: "block", payload: { userId: el.dataset.id } }); }
    // Live bug hunt (2026-09-11): unblock()'s dispatch - no confirm sheet,
    // same "no confirm needed for a reversible toggle" shape the club-module
    // toggles already use (block() itself still confirms - it's the one
    // that actually cuts off interaction).
    else if (action === "unblock") unblock(el.dataset.id);
    else if (action === "delete-account") askConfirm({ title: "מחיקת חשבון", message: "הפרופיל והשיתופים יוסרו מיד, והגיבוי האוטומטי לענן ייכבה במכשיר הזה. המחיקה הסופית, כולל הגיבוי שבענן, תתבצע לאחר 30 יום. להמשיך?", confirmLabel: "מחיקה", destructive: true, action: "delete-account" });
    else if (action === "share-achievement") publishAchievement(el.dataset.id, el.dataset.title, el.dataset.rule);
    else if (action === "verify-recovery") verifyRecovery({ force: true });
    // A LINK, not a toggle. See rule 3 at the head of the club WOD section.
    else if (action === "open-privacy-settings") openPrivacySettings();
    else if (action === "confirm-yes") runConfirm();
    else if (action === "confirm-no") closeConfirm();
    // Design spec section 3, tiers 2 and 3.
    else if (action === "term-open") openTermSheet(el.dataset.term);
    else if (action === "term-close") closeTermSheet();
    else if (action === "term-glossary") { state.ui.termGlossaryOpen = true; rerender(); }
    // Opening the glossary DIRECTLY, from Settings rather than from a term.
    // termSheet still has to hold an id (it is what keeps the sheet mounted
    // and what the back control returns to), so it opens on the first entry -
    // but this deliberately does NOT go through openTermSheet(), because
    // browsing the glossary on purpose is not the same signal as tapping a
    // `?` you did not understand, and must not advance the auto-retire count.
    else if (action === "term-glossary-open") {
      state.ui.termSheet = TERM_GLOSSARY[0].id;
      state.ui.termGlossaryOpen = true;
      rerender();
    }
    else if (action === "term-glossary-back") { state.ui.termGlossaryOpen = false; rerender(); }
    else if (action === "start-signup") startSignup();
    // Design spec 7.1. The choice screen's secondary door.
    else if (action === "show-login") { state.ui.gateView = "login"; rerender(); }
    // Design spec 7.2. `‹ חזרה` from either the login form or the invite
    // step, back to the neutral choice screen. Clears BOTH flags: reached
    // from the invite step it has to undo signupStarted, and reached from
    // the login screen it has to undo gateView, and a member cannot tell
    // which of the two screens they are backing out of by looking.
    else if (action === "gate-back") { state.signupStarted = false; state.ui.gateView = ""; rerender(); }
    // The way back out of the invite step for someone who already has an
    // account. It matters most for the QR deep link: captureInviteDeepLink()
    // puts a scanner straight onto the code screen, so a returning member who
    // scanned a flyer out of curiosity needs the login form to still be ONE
    // tap away. Now that login has a screen of its own, that means setting
    // gateView too — without it this would land them on the choice screen and
    // quietly make 9c15214's escape hatch two taps instead of one, which is
    // the opposite of what this whole pass is for.
    else if (action === "back-to-login") { state.signupStarted = false; state.ui.gateView = "login"; rerender(); }
    else if (action === "retry-join-load") retryJoinFunnelLoad();
    else if (action === "outbox-retry") retryOutboxItem(el.dataset.id);
    else if (action === "outbox-discard") discardOutboxItem(el.dataset.id);
    else if (action === "sign-out") client.auth.signOut();
    else if (action === "toggle-share") toggleShare(el.dataset.type, el.dataset.id);
    else if (action === "toggle-post-menu") togglePostMenu(el.dataset.id);
    else if (action === "post-edit-caption") postStartCaptionEdit(el.dataset.id);
    else if (action === "caption-cancel") { state.posts.captionEdit = null; rerender(); }
    else if (action === "caption-save") postSaveCaption();
    // 202609220005 "התאמנו יחד".
    else if (action === "post-tag-partners") openTrainingPartners(el.dataset.id);
    else if (action === "partners-cancel") closeTrainingPartners();
    else if (action === "partners-save") saveTrainingPartners();
    else if (action === "partner-untag-self") removeOwnTrainingPartnerTag(el.dataset.id);
    // #40's copy, kept: deletion is undoable for a few seconds now, and the
    // confirm has to say so. This branch's four rows above are additive.
    else if (action === "post-delete") askConfirm({ title: "מחיקת פוסט", message: "הפוסט יוסר מהפיד. אפשר יהיה לבטל למשך כמה שניות.", confirmLabel: "מחיקה", destructive: true, action: "post-delete-rpc", payload: { postId: el.dataset.id } });
    else if (action === "workout-share") shareWorkoutSharePrompt();
    else if (action === "workout-not-now") dismissWorkoutSharePrompt();
    else if (action === "pr-share") sharePrPrompt();
    else if (action === "pr-not-now") dismissPrPrompt();
    else if (action === "pr-add-note") { if (state.posts.prPrompt) { state.posts.prPrompt.showNote = true; rerender(); } }
    else if (action === "ach-share") shareAchievementUnlock();
    else if (action === "ach-not-now") dismissAchievementUnlock();
    else if (action === "ach-add-note") { if (state.achievements.unlock) { state.achievements.unlock.showNote = true; rerender(); } }
    else if (action === "ach-share-later") shareEarnedAchievement(el.dataset.id, el.dataset.code);
    // Five-persona UX audit, outward sharing. Four openers and five sheet
    // controls. Every one of them is a tap - nothing on this list runs
    // without one, and nothing on it writes to the server.
    else if (action === "outward-pr") outwardShareCurrentPr();
    else if (action === "outward-ach") outwardShareCurrentAchievement();
    else if (action === "outward-ach-earned") outwardShareEarnedAchievement(el.dataset.id, el.dataset.code);
    else if (action === "outward-post") outwardSharePost(el.dataset.id);
    else if (action === "outward-go") outwardShareNow();
    else if (action === "outward-copy") outwardCopyText();
    else if (action === "outward-download") outwardDownloadImage();
    else if (action === "outward-retry") refreshOutwardShareCard();
    else if (action === "outward-close") closeOutwardShare();
    else if (action === "reactors") openReactors(el.dataset.id);
    else if (action === "reactors-close") closeReactors();
    // COMM-140..142 notification centre.
    else if (action === "feed-notifications") openNotifCenter();
    else if (action === "notif-close") closeNotifCenter();
    else if (action === "notif-retry") fetchNotifPage(true);
    else if (action === "notif-load-more") loadMoreNotifs();
    else if (action === "notif-show-older") notifShowOlder();
    else if (action === "notif-mark-all") markAllNotifsRead();
    else if (action === "notif-open") openNotif(el.dataset.id);
    else if (action === "notif-toggle-group") { const c = state.notif.center; if (c) { c.expanded[el.dataset.key] = !c.expanded[el.dataset.key]; rerender(); } }
    else if (action === "notif-push-disable") disableNotifPush();
    // The self-test is a click and nothing else reaches it, which is half of
    // what makes "never asked on first load" true of the permission prompt
    // it may raise.
    else if (action === "notif-push-self-test") runPushSelfTest();
  };
  window.isCommunitySignedIn = function () { return !!(state.user && state.profile); };
  // IS THE MEMBER MID-INVITE RIGHT NOW? Live bug hunt, fresh round 9
  // (2026-09-16). app.js's boot opens its own "what's your name" welcome sheet
  // whenever the local log has no name, knowing nothing about the fact that
  // cloud.js has just captured an invite deep link and routed the app to the
  // invite-code screen. Both rendered, and the welcome sheet - a focus-
  // trapping full-screen overlay - painted on top and INTERCEPTED the taps
  // meant for the invite form's own submit button underneath it.
  //
  // That is the first thing every member arriving from a shared link or QR
  // code would have hit: a gate about something else entirely, on top of the
  // screen they came for. Recoverable by tapping "דילוג", but nobody should
  // have to escape a modal to accept an invitation.
  //
  // cloud.js is deferred ahead of app.js, so captureInviteDeepLink() has
  // already run by the time app.js asks this.
  window.communityInviteFlowPending = function () {
    return !!(state.ui.inviteCodeDraft && !state.redemption);
  };
  // WHO OWNS A WRITE, at the moment it is made. app.js's queueSyncRecord()
  // needs this to stamp an outbox row with the member who created it - see
  // flushOutbox()'s identity check for why a row that does not know its own
  // owner is dangerous.
  window.communityMemberId = function () { return (state.user && state.user.id) || null; };
  // Fresh-eyes audit: the main header's always-visible bell used to be
  // wired to app.js's own offline "what's new" release notes only — a
  // member could have unread reactions/comments/achievement notifications
  // sitting behind the Community tab's own small bell chip and never see
  // any signal for it outside Community. These two let app.js's header
  // (which renders on every screen, not just Community) show and open the
  // real thing instead. rerender() already runs app.js's own render() (see
  // its definition above), so any state.notif.unread change already
  // reaches the header on the next paint with no new plumbing needed.
  window.communityUnreadCount = function () {
    return state.notif.unreadLoaded ? (Number(state.notif.unread) || 0) : 0;
  };
  window.openCommunityNotifCenter = function () {
    if (!window.isCommunitySignedIn()) return false;
    openNotifCenter("#notificationsBellBtn");
    return true;
  };
  // The privacy-screen link, so the log form's "hidden from the club" hint
  // routes to the same place the board's does. It NAVIGATES; it never writes
  // a privacy field.
  window.openCommunityPrivacySettings = openPrivacySettings;
  // READ-ONLY, and deliberately so. app.js's log form needs to know whether
  // the member's figure reaches the club, so it can say so and link to the
  // privacy screen. There is no matching setter and there must not be one:
  // show_workout_results defaults false, and no surface in this app flips a
  // member's disclosure ON for them. null while the profile is still loading,
  // which is neither true nor false and renders no hint at all.
  window.communityShowsWorkoutResults = function () {
    return state.profile ? !!state.profile.show_workout_results : null;
  };
  window.shareAchievementToCommunity = function (achievementId, title, rule) { publishAchievement(achievementId, title, rule); };
  document.addEventListener("submit", (event) => {
    if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); }
    else if (event.target.id === "communityInviteCode") { event.preventDefault(); redeemCode(event.target); }
    else if (event.target.id === "communityLogin") { event.preventDefault(); login(event.target); }
    else if (event.target.id === "communityCredentials") { event.preventDefault(); setCredentials(event.target); }
    else if (event.target.id === "backupCredentials") { event.preventDefault(); setCredentials(event.target); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user) loadNotifUnread();
  });
  window.addEventListener("focus", () => { if (state.user) loadNotifUnread(); });
  window.addEventListener("online", flushOutbox);
  window.addEventListener("online", () => { flushCommunityOutbox(); });
  window.addEventListener("haimunia-sync-needed", () => { maybeAutoStartBackup(); flushOutbox(); });
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      state.user = session ? session.user : null;
      if (state.user) {
        enableSyncIfAllowed();
        if (typeof window.haimuniaBindLogOwner === "function") {
          window.haimuniaBindLogOwner(state.user.id);
        }
        ensureAnalyticsConfigured();
        loadRedemption()
          .then(() => Promise.all([loadProfile(), flushOutbox(), flushCommunityOutbox()]))
          .then(pullPrivateRecords)
          .then(() => { if (typeof window.syncCommunityMilestones === "function") window.syncCommunityMilestones(); })
          .then(() => { state.communityDataLoaded = false; return ensureCommunityDataLoaded(); })
          .then(rerender);
      } else {
        state.communityDataLoaded = false; state.communityDataLoading = false;
        state.profile = null; state.redemption = null; state.signupStarted = false;
        state.profileLoadError = false; state.redemptionLoadError = false;
        state.ui.fieldErrors = {}; state.ui.confirmDialog = null;
        state.ui.gateView = ""; state.ui.termSheet = null; state.ui.termGlossaryOpen = false;
        state.posts.held = [];
        state.posts.openShare = {};
        state.posts.openMenu = null;
        state.posts.captionEdit = null; state.posts.prPrompt = null;
        state.posts.workoutPrompt = null; resetSharePromptQueue();
        state.posts.partners = {}; state.posts.partnersPanel = null;
        outwardRevokePreview(); state.posts.outwardShare = null;
        state.engagement.reactions = {};
        state.engagement.reactionError = null;
        state.engagement.reactorsFor = null;
        state.members.blockedIds = []; state.members.blocksLoaded = false;
        state.achievements.mine = []; state.achievements.unlock = null;
        state.notif.center = null; state.notif.unread = 0; state.notif.prefs = {}; state.notif.prefsLoaded = false;
        state.notif.prefSaving = {}; state.notif.pushSub = null; state.notif.pushChecked = false;
        anonSignInAttempted = false;
        recoveryVerifyAttempted = false;
        rerender();
      }
    });
    refreshSession();
  }

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if ("inviteCode" in t.dataset) { state.ui.inviteCodeDraft = t.value; return; }
    if ("liveValidate" in t.dataset) { liveValidateCredentialField(t); return; }
    if ("captionEdit" in t.dataset && state.posts.captionEdit) state.posts.captionEdit.body = t.value;
    else if ("prNote" in t.dataset && state.posts.prPrompt) state.posts.prPrompt.note = t.value;
    else if ("achNote" in t.dataset && state.achievements.unlock) state.achievements.unlock.note = t.value;
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if ("notifPrefSelect" in t.dataset) {
      Promise.resolve(setNotifPref(t.dataset.type, t.value)).then(() => rerender());
    }
    else if ("partnerPick" in t.dataset) toggleTrainingPartnerPick(t.dataset.partnerPick);
    else if ("outwardName" in t.dataset) setOutwardShareName(t.checked);
  });
  document.addEventListener("keydown", (e) => {
    if (state.posts.openMenu && !currentCloudDialog() && postMenuKeydown(e)) return;
    if (e.key === "Tab") {
      const dk = currentCloudDialog();
      if (dk) {
        const dlg = cloudDialogEl(dk);
        const nodes = cloudDialogFocusables(dlg);
        if (nodes.length) {
          const first = nodes[0], last = nodes[nodes.length - 1];
          const a = document.activeElement;
          if (e.shiftKey && (a === first || !dlg.contains(a))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (a === last || !dlg.contains(a))) { e.preventDefault(); first.focus(); }
        }
      }
      return;
    }
    if (e.key !== "Escape") return;
    for (const d of CLOUD_DIALOGS) {
      if (d.isOpen()) { e.preventDefault(); d.close(); return; }
    }
    if (state.posts.openMenu) { state.posts.openMenu = null; rerender(); }
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || typeof t.getAttribute !== "function") return;
    const key = t.getAttribute("data-cloud-dialog");
    if (!key) return;
    const spec = CLOUD_DIALOGS.find((d) => d.key === key);
    if (spec) spec.close();
  });
  registerOutboxHandlers();
  if (window.HaimuniaOutbox) {
    // Keep the banner's counts live when the queue changes underneath a
    // render (a background flush completing, a retry succeeding).
    window.HaimuniaOutbox.onChange(() => { refreshOutboxState().then(rerender); });
  }

  // Consume PR_CREATED from the product event bus (COMM-012). Detection is the
  // achievements agent's COMM-132; this only reacts to the record it passes.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.PR_CREATED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, onPrCreated);
  }
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, onAchievementUnlocked);
  }
