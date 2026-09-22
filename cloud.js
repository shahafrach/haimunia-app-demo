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
  // The accessible name for a count badge. Kept as ONE function that both
  // sub-tab bars call, rather than a string built inline at each bar: the
  // visible badge text was singular-guarded long ago and these aria-labels were
  // not, which is exactly what happens when the same rule lives in two places.
  // Singular drops the numeral entirely — "דיווח אחד" reads naturally where
  // "1 דיווחים" does not, and dropping it also sidesteps the slashed form of
  // "one", which is not a word at all: the feminine is irregular, so a slash
  // cannot build it from the masculine the way it can for a regular pair.
  function badgeAria(t) {
    const n = t && t.badge;
    if (!n) return "";
    const many = (t && t.badgeLabel) || "דיווחים ממתינים";
    const one = (t && t.badgeLabelOne) || "דיווח אחד ממתין";
    return n === 1 ? one : `${n} ${many}`;
  }
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
  // =====================================================================
  // The management client - a SECOND, separate Supabase session
  // =====================================================================
  // "no, i want it to be seperate from the regular user" (2026-09-15), read
  // together with "because i also train and use the app". Those two together
  // are the whole specification, and neither one alone would have produced
  // this design:
  //
  //   SEPARATE means the management account is its own identity with its own
  //     credentials, not a re-check of whoever happens to be signed in. The
  //     owner's member account should not carry admin power just because the
  //     owner also administers.
  //   AND STILL TRAINING means signing into the management area must not cost
  //     them their own session. They log workouts on this phone. An admin
  //     login that signs them out of their training account, or worse writes
  //     their next workout to the admin account, is not acceptable.
  //
  // One client cannot hold two identities: supabase-js keeps one session and
  // every request carries that session's JWT, which is exactly what RLS reads
  // to decide what the request may see. So there are two clients.
  //
  //   `client`     - the member. persistSession: true, localStorage-backed,
  //                  survives reloads. Never touched by anything below.
  //   `mgmtClient` - the management account. Created on unlock, signed in
  //                  with credentials typed into the gate, held in MEMORY
  //                  ONLY, and destroyed on lock, sign-out or reload.
  //
  // persistSession:false is the important half of that second line. It keeps
  // the management session out of localStorage entirely, which means it
  // cannot outlive the tab, cannot be restored by a later visit, and cannot
  // be read off the device by anything that can read storage. A management
  // session that survived a reload would be a worse lock than the 15-minute
  // timer it sits behind. storageKey is set anyway so that if a future
  // supabase-js ever touches storage despite persistSession:false, it lands
  // on its own key instead of overwriting the member's session.
  //
  // autoRefreshToken:false: the unlock window is 15 minutes and a Supabase
  // access token is good for an hour, so there is nothing to refresh. It also
  // means no background timer keeps a management session alive unattended.
  let mgmtClient = null;
  function makeMgmtClient() {
    if (!configured || !window.supabase) return null;
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: {
        persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
        storageKey: "haimunia-mgmt-memory-only",
      },
    });
  }
  // WHICH CLIENT A MANAGEMENT CALL SHOULD USE.
  //
  // Returns the management client when a management session is live, and the
  // member client otherwise. The fallback is deliberate and is what makes
  // this refactor safe to land in one go: a management read that somehow runs
  // while nothing is unlocked behaves exactly as it did before this change
  // (as the member, subject to the member's own RLS), rather than throwing or
  // silently returning nothing. Boot-time loadRestrictions() is a real
  // instance - it runs for any member holding a moderation permission, long
  // before any panel is opened.
  //
  // The writes reached only from an unlocked panel therefore always run as
  // the management account, and nothing reachable outside a panel changes
  // behaviour at all.
  function mgmtDb() {
    if (!mgmtClient || !state.admin.mgmt) return client;
    // EXPIRY IS ENFORCED HERE, not only on the panel's render path.
    //
    // Live bug hunt, fresh round 1 (2026-09-15). This used to ask only whether
    // a management session OBJECT existed, and the only thing that ever
    // retired one was renderManagePanel() calling mgmtExpireIfStale() on its
    // way to deciding whether to draw a gate. So a session left idle well past
    // its window kept answering any mgmtDb() read fired from somewhere else -
    // reproduced live with a faked clock: unlock the panel, never go back to
    // it, open Community 35 minutes later, and loadRestrictions()' second
    // read went out on the management account's JWT.
    //
    // Only a read is reachable that way today, because every mgmtDb() WRITE
    // sits behind UI that renderManagePanel() has already expired. That is
    // luck, not design: mgmtDb() gives a caller no hint that it is supposed to
    // be panel-scoped, so the next one added outside a panel would inherit an
    // unenforced expiry silently. Asking here makes the guarantee true of the
    // accessor itself rather than of one of its callers.
    mgmtExpireIfStale();
    return (mgmtClient && state.admin.mgmt) ? mgmtClient : client;
  }
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
  // state.feed.scope, state.challenges.view, state.coach.celebrate,
  // state.admin.modQueueStatus. Two domains can both have `.loading` and
  // `.error` without either one having to invent a longer name.
  //
  // The ROOT of the object is deliberately NOT a domain. It holds only the
  // session/auth/config core that every domain reads and no domain owns:
  // `configured`/`client` (the Supabase wiring), `user`/`profile`/`redemption`
  // (who is signed in and what they are), `syncEnabled` and `featureFlags`
  // (localStorage-backed, read once at module init), the boot guard, the
  // cached permission set, and the caller's own avatar-upload status.
  // Namespacing those would only add a level of indirection to the most-read
  // keys in the file without separating anything.
  //
  // Sub-object identity matters: nothing ever replaces a whole namespace
  // (state.feed = {...} would silently drop keys the sign-out reset does not
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
    // COMM-150. permissions is the caller's permission set from
    // my_permissions(), cached once per session and read through hasPerm();
    // the server policy behind each control is the real authority and this
    // only decides what to render. Session-scoped, not admin-scoped - a
    // member with no permissions at all still has this pair.
    permissions: [], permissionsLoaded: false,
    // COMM-226 built the coach-engage section flag-gated and hidden, default
    // off, with no producer. COMM-304 is that producer
    // (coach_detect_engagement_decline(), the scheduled job in 202608310008)
    // and this is the ticket that flips the flag: default ON now (`!== "0"`,
    // not `=== "1"`), so a test that wants the pre-304 hidden state has to opt
    // into it explicitly the same localStorage-backed way a test always has.
    // featureFlags.coachEngage is still read once, synchronously, at this
    // module-level literal - before cloud.js's own module-load, not after - so
    // a test flips it via bootCommunity's localStorage hook, never by mutating
    // state post-boot.
    // COMM-229. Same localStorage-backed pattern as coachEngage above, so a
    // test can flip it before boot the same way. Stays default off in
    // production until VAPID keys are provisioned server-side (per the
    // plan's operator checklist) - this ticket does not flip that default.
    featureFlags: { coachEngage: localStorage.getItem("haimunia-demo:coachEngageFlag") !== "0", notifPush: localStorage.getItem("haimunia-demo:notifPushFlag") !== "0" },
    // COMM-318. { status: "idle"|"processing", error }, drives the avatar
    // control on the account profile form only.
    avatarUpload: { status: "idle", error: "" },

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
    ui: { tab: "feed", manageTab: "invites", manageScrollTo: "", loading: false, message: "", fieldErrors: {}, confirmDialog: null,
      // What was last copied to the clipboard, so the control that was
      // pressed can confirm on itself - see markCopied().
      copiedToken: "",
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

    // ---- feed (COMM-110..115) ----
    // items holds feed_page() rows in the exact order the function returned
    // them and is never re-sorted here.
    feed: {
      items: [], scope: "for_you", cursor: null, loading: false, error: false,
      loadingMore: false, moreError: false, end: false, pagesLoaded: 0,
      sessionId: null, seen: {}, pending: [],
    },

    // ---- posts: composing, own-post controls, sharing (COMM-100..108) ----
    // openMenu is the post id whose "..." menu is open; savedIds is the
    // caller's own saved-post set; comparison/comparisonForPostId are the
    // inline compare strip, scoped to the one post that asked for it.
    posts: {
      composer: null, composerTrigger: null, openMenu: null, savedIds: {},
      captionEdit: null, visibilityEdit: null, prPrompt: null, openShare: {},
      comparison: [], comparisonForPostId: null,
      // Five-persona UX audit, outward sharing. The share-outside-the-app
      // sheet: { subject, caption, showName, spec, status, previewUrl, blob,
      // sharing, result }. Lives in `posts` rather than a namespace of its
      // own because this domain is already "composing, own-post controls,
      // sharing" and every one of its subjects is a post or a post's source
      // record. Holds a Blob and an object URL, so closeOutwardShare() is the
      // only way it is cleared - it revokes the URL on the way out.
      outwardShare: null,
    },

    // ---- engagement: comments, replies, reactions, mentions (COMM-120..125) ----
    engagement: {
      comments: {}, openComments: {}, commentDrafts: {}, commentErrors: {},
      commentSending: null, commentEdit: null, openReplies: {}, replyTo: {},
      reactions: {}, reactionError: null, mentionPicker: null,
    },

    // ---- members: search results, directory, follow/block, profiles ----
    members: {
      // COMM-228. `people` is community_search()'s members group and keeps
      // its exact row shape - it is what the follow/block/profile controls
      // read. `search`/`results` are the older standalone member lookup.
      people: [], search: "", results: [],
      // COMM-124 / COMM-160. One batched, cached user-id -> server role map,
      // shared by the comment coach emphasis and the coach badge on every
      // other surface a member is shown.
      roles: {},
      blockedIds: [], blocksLoaded: false, profileView: null,
      // Live bug hunt (2026-09-11): blockedIds merges BOTH directions (who I
      // blocked AND who blocked me) into one set, by design, for the
      // comment/reaction-hiding check (isBlockedUser()) - it never needed to
      // distinguish direction before. Unblocking does: only a block I
      // initiated is mine to undo. blockedByMe is that subset, with names
      // fetched the same second-read way loadRestrictions() already does
      // ("a missing display name must degrade... rather than lose the row").
      blockedByMe: [], blockedByMeNames: {}, blockedByMeLoaded: false, unblocking: "",
      // Live bug hunt (2026-09-11): every follow button across the app
      // (directory, welcome post, classmates card, member row, profile
      // dialog) rendered unconditionally as "מעקב" with no notion of
      // whether the viewer already follows that person, and follow() had
      // no in-flight guard - a member's second, well-intentioned tap on a
      // button that never visibly changed silently unfollowed them (the
      // insert's 23505 conflict is deliberately turned into a delete),
      // with an identical toast either way. Same shape as blockedIds/
      // blocksLoaded just above, and followBusy mirrors suggestions.busy.
      followingIds: [], followingLoaded: false, followBusy: {},
      // COMM-231 members directory. items is the paginated roster loaded so
      // far (display_name order, cursor = the last row's own display_name,
      // page size DIRECTORY_PAGE_SIZE). query is what the member typed, kept
      // verbatim the same way search.query is. searchResults is
      // community_search's members group once the query reaches
      // SEARCH_MIN_CHARS, or null when the box is empty/under threshold (in
      // which case the visible rows are a client-side filter over items).
      directory: { items: [], loading: false, loadingMore: false, loaded: false, error: false, end: false, cursor: null, query: "", searchResults: null, searchLoading: false },
      // COMM-232. people_suggestions() output, rendered in the order returned
      // (the function already ranks by strongest signal). busy holds the ids
      // of in-flight follows. An error leaves the strip omitted entirely, so
      // there is deliberately no retry affordance keyed off `error` here.
      suggestions: { items: [], loading: false, loaded: false, error: false, busy: {} },
      // COMM-307. attendance_classmates_today() output - the members other than
      // the caller who logged a session today, in the order the function
      // returned them (most recently recorded first; it is a total order and the
      // client never re-sorts it). There is deliberately no `busy` map beside
      // this one, unlike suggestions: a classmate row is not a suggestion
      // card that disappears when followed, so the Follow control is the same
      // plain `follow` action the directory and the following lists use.
      //
      // `error` and "loaded with zero items" both mean exactly one thing to the
      // renderer - no card - so nothing downstream ever has to tell them apart.
      // Neither does the server: an empty set is what a member gets when they
      // did not train today, when they trained alone, and when their own
      // show_attendance is off, and that indistinguishability is the function's
      // own privacy answer (202608310005), not a gap here.
      classmatesToday: { items: [], loading: false, loaded: false, error: false },
    },

    // ---- club: the box itself and its club-wide surfaces ----
    // `row` is the caller's own club record. features/featuresLoaded is the
    // club_features module map; moduleBusy (COMM-321) is which module_key (if
    // any) has an in-flight toggle write, and configBusy (202609220002) the
    // same for a threshold save. Two fields rather than one because the two
    // writes disable different things: a toggle in flight greys every switch
    // on the panel, a threshold save greys only its own module's fields.
    club: {
      row: null, features: {}, featuresLoaded: false, moduleBusy: null, configBusy: null,
      announcements: [], announcementSaving: false, streaks: [],
      inactiveMembers: [], newMembers: [], activitySignal: null,
      weeklyChallenge: null, weeklyLeaderboard: [],
      // The active weekly_challenges ROW (with its comparison_key and a
      // computed `valid`), as distinct from weeklyChallenge above, which is
      // the leaderboard VIEW and is null whenever nobody has posted a matching
      // result yet. See loadWeeklyChallenge().
      weeklyChallengeRow: null,
      // The club WOD catalogue (202609060028), mirrored here so the community
      // layer has its own view of what it handed app.js. app.js owns the
      // merged catalogue (allWods()); this is the raw last-read list, which is
      // what the staff catalogue surfaces render from. Includes RETIRED rows -
      // club_wods_list() always returns them and the client must keep every id
      // resolvable.
      clubWods: [],
      // The coach's picked comparison key, kept in state so a rejected submit
      // (a missing title, a missing date) does not silently reset the picker.
      challengeKeyDraft: "",
      // ---- The feed writes itself (202609080002) --------------------------
      // Today's club WOD boards, exactly as club_wod_boards() returned them -
      // never re-sorted, never re-filtered and never re-derived from
      // (see renderClubWodBoardBody: `viewer` is the server's answer about
      // what this member may do, not something the client recomputes).
      //
      // These live in `club` rather than in a namespace of their own for the
      // same reason clubWods does: this is the box's programming, a club-wide
      // surface, and the namespace pin in community-state-namespaces.test.mjs
      // is a review trigger that a genuinely club-shaped feature should not
      // be spending.
      wodBoards: [], wodBoardsLoaded: false, wodBoardsLoading: false, wodBoardsError: false,
      // The desktop staff week strip. Separate from wodBoards above, which
      // is TODAY and is handed to app.js for the log form's attach control -
      // widening that one to a week would have changed what the phone means
      // by "today's board".
      weekBoards: [], weekBoardsLoaded: false, weekBoardsLoading: false, weekBoardsError: false,
      // The open board dialog: { sessionId, board, loading, error, busy,
      // errorText }. null - a dialog starts closed (CLOUD_DIALOGS).
      wodBoardView: null,
      // The staff publish form's draft, always present (it is a panel, not a
      // dialog): { wodId, date, note, saving }.
      wodSessionForm: { wodId: "", date: "", note: "", saving: false },
    },

    // ---- leaderboard (COMM-210/211/212) ----
    // The club-wide consistency board on the Boards sub-tab: rows are
    // feed_leaderboard() output in the exact order the function returned them
    // and are never re-sorted here (the rank column is the server's, not an
    // array index). scope is 'club' or 'friends' and is the only thing a scope
    // switch changes - it re-fetches, it does not reload the tab. The challenge
    // progress board lives on state.challenges.view.board instead, because it
    // is scoped to whichever challenge detail is open.
    //
    // COMM-212. hideMine is client-only, per-device, never a query parameter
    // and never a privacy setting: the server always returns the caller's own
    // row, and this only stops the client from drawing it. The real,
    // server-enforced opt-out is the in_leaderboards toggle in the Privacy
    // panel (COMM-018). Stored the same localStorage-backed way as
    // syncEnabled/coachEngage are, read once at module init, defaulting to
    // showing the row.
    leaderboard: {
      scope: "club", rows: [], loading: false, loaded: false, error: false,
      hideMine: localStorage.getItem("haimunia-demo:hideMyLeaderboardResult") === "1",
    },

    // ---- admin: moderation queue, reports, pins, audit log (COMM-150..156) ----
    // modQueue holds mod_queue() rows. pins holds pin rows for the club
    // strip. auditLog holds admin_actions_page() rows. The permission set
    // these controls are checked against lives at the root, not here - see
    // `permissions` above.
    admin: {
      reports: [],
      modQueue: [], modQueueStatus: "open", modQueueLoading: false, modQueueError: false, modQueueLoaded: false,
      // Live posting restrictions, for the panel that can lift them.
      restrictions: [], restrictionsLoading: false, restrictionsError: false, restrictionsLoaded: false, restrictionLifting: "",
      modAction: null, modContext: null, reportSheet: null,
      pins: [], pinsLoaded: false, pinError: "",
      // One-time password-reset reveal (2026-09-05), same shape as
      // invites.created/inviteCodes.created above: { userId, tempPassword }
      // shown once, cleared by close-password-reset-result.
      passwordResetResult: null,
      // Bug reports inbox (2026-09-15). Same lazy-load shape as modQueue
      // above: loaded the first time the area is opened, never on boot -
      // this is a rarely-read admin surface and paying for it on every
      // Community load would be a real cost for every member who is not
      // staff at all.
      bugs: [], bugsStatus: "open", bugsLoading: false, bugsError: false, bugsLoaded: false, bugsSaving: "",
      // STEP-UP LOCK on the admin panel (2026-09-15), at the owner's request:
      // "on ניהול מערכת there is need to be separate log in for admin,
      // because this is the area for that."
      //
      // IN MEMORY ONLY - deliberately not localStorage, not sessionStorage.
      // Persisting the unlock would defeat the thing it exists for: this
      // protects against someone holding an already-unlocked phone, and a
      // token that survives a reload hands them the panel anyway.
      //
      // WHAT IT IS AND IS NOT. It is not the security boundary - that is
      // is_admin() in the database, re-checked on every action regardless of
      // this flag, and nothing here can grant a non-admin anything. It is a
      // barrier against the physical-access case: an unattended phone in a
      // gym, a head coach who is also an admin, a member handed the device to
      // look at a photo. Saying that plainly matters, because a lock that is
      // described as more than it is becomes the reason nobody adds the real
      // one later.
      // Keyed by panel ("admin" | "club"), because the two are different jobs
      // held by different people: unlocking the club panel must not hand over
      // the app panel, and an account that holds both roles should still be
      // asked twice if it wants both. One shared flag would have made the
      // weaker of the two the effective lock on both.
      panelUnlockedUntil: { admin: 0, club: 0 }, panelUnlockBusy: "", panelUnlockError: "",
      // The signed-in management identity, or null when nothing is unlocked.
      // { email, userId, displayName, isAdmin, isStaff, role, perms[] } -
      // resolved from the MANAGEMENT account's own profile, redemption and
      // my_permissions() after it signs in, never from state.profile, which
      // describes the member using the app. Held here rather than on `state`
      // itself so that every existing member-facing read of state.profile /
      // state.permissions keeps answering about the member, which is what
      // every one of those call sites means.
      mgmt: null,
      // The management account changing its OWN password, from inside the
      // panel it has just authenticated into. Open/busy/error only - the
      // typed password lives in the form and is never copied into state,
      // which would put it in every subsequent render's closure for no
      // reason.
      mgmtPasswordOpen: false, mgmtPasswordBusy: false, mgmtPasswordError: "",
      auditLog: [], auditCursor: null, auditCursorId: null, auditLoading: false, auditError: false, auditLoaded: false, auditEnd: false, auditFilters: {},
      // Fresh-eyes audit: admin_id -> {display_name,handle,avatar_url},
      // batched by loadAuditLog() so renderAuditLog() can name an actor
      // instead of printing a raw uuid fragment. Keyed by id so entries
      // from earlier pages stay resolved as later pages load.
      auditAdminProfiles: {},
      // Fresh-eyes audit: manageAdminArea()'s five <details> sections used
      // to take their open/closed state from nothing but a caller-literal
      // default recomputed on every single render() - so any click INSIDE
      // one of them (a filter chip, a toggle, anything that calls
      // rerender()) rebuilt the whole tab and silently re-collapsed
      // whichever area the admin had open, mid-task. area id -> open
      // boolean, populated by a real `toggle` listener in
      // afterRenderManage() and read back by manageAdminArea() instead of
      // a hardcoded default - the same "state survives a render, the DOM
      // node does not" rule every other interactive control in this file
      // already follows.
      openAreas: {},

      // ---- COMM-376. Invite and code management ---------------------
      // invites is the per-person panel: items is admin_invite_list()'s
      // current page (cursor-paginated on created_at desc, the same
      // loading/loadingMore/loaded/error/end shape the audit log above
      // already uses), status is the active filter chip, created is the
      // one-time { id, code, role, label, created_at, expires_at, status }
      // reveal admin_invite_create() returned (the raw code is never
      // retrievable again after this - see contracts.md), and revoking is
      // the id of an invite whose admin_invite_revoke() call is in flight.
      invites: { items: [], status: "all", cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false, created: null, revoking: null },
      // inviteCodes is the shared-code panel: items is admin_invite_code_list()'s
      // full (unpaginated - a club has a handful) list, created is the same
      // kind of one-time reveal for a freshly minted shared code, busy is the
      // id of a code whose admin_invite_code_set_active() call is in flight.
      inviteCodes: { items: [], loading: false, loaded: false, error: false, created: null, busy: null },
      // The joining QR for whichever code was just created, and the only
      // place the plaintext of a live code is held after the reveal card
      // above. code/kind identify it, link is the deep link the QR encodes,
      // blob/previewUrl are the rendered PNG and its object URL (revoked on
      // close - see revokeInviteQrPreview), status is idle/rendering/ready/
      // failed, error names which of INVITE_QR_ERROR_TEXT's cases failed,
      // and sharing/result mirror the outward-share sheet's own in-flight
      // flag and its OUTWARD_SHARE_RESULTS outcome.
      inviteQr: { code: "", kind: "", link: "", status: "idle", previewUrl: "", blob: null, sharing: false, result: "", error: "" },

      // ---- COMM-377. Member roster ------------------------------------
      // items is admin_member_roster()'s accumulated pages, newest-joined
      // first. cursor is the last row's own sort_key - the coalesce(
      // redeemed_at, created_at) the RPC actually orders on, returned as its
      // own column since 202609180001. Before that column existed a member
      // with no invite_redemptions row ended pagination there, because the
      // only date the client could see for them was a null; see loadRoster()
      // for what still happens against an un-migrated server.
      roster: { items: [], cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false, search: "" },

      // ---- Five-persona UX audit, defect 3. Incomplete signups ---------
      // The accounts every roster surface is structurally blind to: a real
      // auth.users row that HAS redeemed an invite and has NO profiles row,
      // because the profile insert sits at the END of the intro carousel
      // (migration 202609060023's own header). items is
      // admin_incomplete_signups()'s accumulated pages, most-recently-
      // redeemed first; cursor/end/loading are the same shape as roster
      // above. reclaim is the open confirm sheet - the one that NAMES ITS
      // SUBJECT - and reclaimResult holds what admin_reclaim_invite()
      // actually did, so the admin reads it instead of a silent success;
      // same one-shot reveal shape as passwordResetResult above.
      incompleteSignups: { items: [], cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false },
      reclaim: null,
      reclaimResult: null,
    },

    // ---- analytics: the admin dashboards (COMM-310..313) ----
    analytics: {
      // COMM-310 admin community analytics dashboard, client half. THE
      // FOUNDATIONAL SHELL later Phase 3 admin tickets extend - COMM-311
      // (member segments), COMM-312 (health scores) and COMM-313 (retention
      // cohorts) each say "reusing COMM-310's dashboard shell" in their own
      // tickets. mode is "week" or "month", the two cadences metrics.md's own
      // 18 metric definitions are written in ("per week", "in a week"); start/
      // end are the resolved ISO dates for whichever period is currently
      // anchored, both inclusive - matching analytics_dashboard()'s own
      // p_period_start/p_period_end contract exactly, so they can be sent
      // straight back as RPC args with no reshaping. data is the raw jsonb
      // analytics_dashboard() returned, rendered as-is and never reshaped
      // here, the same "server is the one definition" posture COMM-309's
      // monthly recap figures already follow. A later ticket's own section
      // (a Segments card, a Health score card, a Retention card) reads
      // state.analytics.dashboard.start/end the same way and appends its render
      // call inside renderAdminAnalyticsDashboard() after the two
      // metrics.md-defined groups, rather than opening a second nav
      // destination or a second period selector.
      dashboard: { mode: "week", start: null, end: null, loading: false, loaded: false, error: false, errorText: "", data: null },
      // COMM-311 member engagement segmentation, client half. THE FIRST
      // ticket to actually extend COMM-310's shell, per that ticket's own
      // "reusing COMM-310's dashboard shell" instruction. Its own load fires
      // from inside loadAdminAnalyticsDashboard() itself (see that function),
      // never from a second period selector or a second lazy-load gate on the
      // account tab - see cloud.js's own comment there for why. data is the
      // RAW array member_segments() returned (one {user_id, display_name,
      // handle, segment} row per club member, already ordered by segment then
      // name server-side - never re-sorted here), grouped into the six named
      // buckets only at render time. asOf is the p_as_of this client actually
      // sent (COMM-310's own selected period end, capped at today - see
      // memberSegmentsAsOf()), shown so a reviewer can see what date a count
      // was computed for. expanded is a plain {segment: bool} map of which
      // segment cards are currently drilled into, reset never (a card a staff
      // member opened stays open across a period change, the same way
      // COMM-310's own period selector does not collapse anything else on
      // screen).
      segments: { loading: false, loaded: false, error: false, errorText: "", data: null, asOf: null, expanded: {} },
      // COMM-313 retention correlation views, client half. Gated STRICTLY on
      // real is_admin() - not the hasPerm(PERM.ANALYTICS_VIEW) || isAdmin()
      // pair every other section in this cluster (COMM-310/311) uses - per
      // that ticket's own "gated by real is_admin, matching COMM-312's
      // narrower bar" acceptance criterion. Because the gate is narrower than
      // COMM-310's shell gate, this section is rendered as its OWN top-level
      // ach-section (renderRetentionCorrelations(), wired in next to
      // renderAdminAnalyticsDashboard() in the account tab, not appended
      // inside it) - see that function's own comment for the full reasoning.
      // Three independent RPC results, all fetched together on one lazy load
      // (retention_cohorts/retention_onboarding_correlation/
      // retention_welcome_correlation take no shared period from COMM-310's
      // own selector - the two correlations do not even accept a parameter -
      // so there is no period selector to reuse here). cohorts/onboarding/
      // welcome are each the RAW array the matching RPC returned, never
      // reshaped here (grouped into series only at render time, the same
      // "server is the one definition" posture COMM-310/311 already follow).
      // onboardingStep is which of the five onboarding_progress columns the
      // onboarding overlay currently shows (one step at a time - all five at
      // once would be five pairs of curves on screen together). showOnboarding
      // / showWelcome are the two independent overlay toggles the ticket's own
      // "Populated" frontend state calls for.
      retention: {
        loading: false, loaded: false, error: false, errorText: "",
        cohorts: [], onboarding: [], welcome: [],
        onboardingStep: "welcomed_at", showOnboarding: false, showWelcome: false,
      },
      // COMM-312 community health score, client half. Same is_admin()-only bar
      // as COMM-313 (not the hasPerm(PERM.ANALYTICS_VIEW) || isAdmin() pair
      // COMM-310/311 use), for the same reason: community_health_history()
      // itself is gated on real is_admin() alone, per that function's own
      // migration comment. Its own top-level ach-section
      // (renderCommunityHealthScore(), wired in next to
      // renderRetentionCorrelations() in the account tab) and its own lazy
      // load (loadCommunityHealth()), not piggybacking on either COMM-310's or
      // COMM-313's load. weeks is the RAW array community_health_history()
      // returned - {week_start, score, components} per row, already ordered
      // OLDEST FIRST by the RPC itself, so it is drawn left-to-right with no
      // re-sort here (see renderCommunityHealthTrend()). There is no p_weeks
      // selector in state: COMMUNITY_HEALTH_WEEKS is a fixed constant passed on
      // every load, per the ticket's own "your call" on offering a selector -
      // this ticket's frontend states name no such control, and COMM-313's own
      // sibling section has none either.
      health: { loading: false, loaded: false, error: false, errorText: "", weeks: [] },
      // COMM-379 registration funnel analytics, client half. Same shape and
      // same precedent as COMM-311's segments just above: appended INSIDE
      // renderAdminAnalyticsDashboard()'s own populated branch, its own load
      // fired from inside loadAdminAnalyticsDashboard() once a.data is
      // truthy, reusing state.analytics.dashboard.start/end - no second nav
      // destination, no second period selector. Gated on the SAME pair as
      // the shell itself (community.analytics.view or real is_admin(), per
      // registration_funnel()'s own AUTH note - not is_staff(), so a coach
      // is refused here the same way COMM-310/311 already refuse one). data
      // is the raw jsonb registration_funnel() returned, rendered as-is.
      registrationFunnel: { loading: false, loaded: false, error: false, errorText: "", data: null },
    },

    // ---- challenges (COMM-201..207) ----
    // items holds every `challenges` row the caller may see (challenges_read
    // already scopes out a draft that is not theirs), sorted soonest end_at
    // first. participation is the caller's own challenge_participants row per
    // challenge_id, loaded alongside the list so a card can show Join/Joined
    // without a per-card round trip. aggregates is chal_progress() output
    // cached per challenge_id, fetched only for the types whose card needs an
    // aggregate figure (cooperative, team) - every other type's card reads
    // straight off participation. view is the open detail dialog (COMM-207);
    // form is the staff create/edit dialog (COMM-201).
    //
    // COMM-209. _rtId is the challenge id whose realtime channels are
    // currently open, so re-arming after a teardown is idempotent and
    // switching challenges closes the previous pair rather than stacking a
    // second one.
    //
    // In-memory only (COMM-205): _consistencyWeekLogged is which ISO week a
    // consistency challenge has already logged a "week hit" delta for on this
    // device this session, so a repeated WORKOUT_COMPLETED burst within the
    // same week cannot log twice. Never persisted - a real attendance source
    // replaces this client-side tally entirely (COMM-306, Phase 3).
    challenges: {
      items: [], loaded: false, loading: false, error: false,
      participation: {}, aggregates: {},
      view: null, form: null,
      _rtId: null,
      _consistencyWeekLogged: {}, _consistencySessionCounts: {},
      // 202609220002. The caller's own onboarding challenge, exactly as
      // onboarding_challenge_state() returns it - {state, goal_sessions,
      // window_days, progress, days_left, ...}. `state` is deliberately null
      // rather than "none" until the first read: "we have not asked" and "we
      // asked and they are not eligible" render differently, and defaulting
      // to the second would flash a decision at a member we had not made yet.
      onboarding: { data: null, loading: false, loaded: false, error: false, busy: false },
    },

    // ---- events (COMM-213..217) ----
    // items holds every `events` row the caller may see (events_read already
    // scopes out a draft that is not theirs), sorted soonest start_at first.
    // byId is the same rows keyed by id, read both by the POST_EVENT card
    // upgrade and by the feed top-area card. attendees is every
    // event_attendees row the caller may see (event_attendees_read's own
    // show_in_attendee_lists filter already applies), keyed by event_id, which
    // is what both the going count and the attendee list read. view is the
    // open detail dialog; form is the staff create/edit dialog.
    events: {
      items: [], byId: {}, loaded: false, loading: false, error: false,
      attendees: {}, view: null, form: null,
    },

    // ---- search (COMM-228) ----
    // One community_search() call fills all three groups; the members group
    // lands in state.members.people, which keeps its own name and row shape,
    // so widening the search did not change that existing caller. query is
    // what the member typed, kept verbatim so a re-render can put it back in
    // the box; only the request is sanitized.
    search: { events: [], challenges: [], query: "", loading: false },

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
      _rtUid: null, pushSub: null, pushChecked: false,
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

    // ---- onboarding (COMM-220..222, COMM-316) ----
    // progress is the caller's own onboarding_progress row (null = not loaded
    // yet; a real row always exists once loaded, seeded server-side at
    // MEMBER_JOINED). firstMonth is the lazily-computed first-month personal
    // summary (COMM-222's third step), fetched only once that step is due.
    //
    // COMM-316 (closing COMM-P07). attendance is the member's own
    // attendance_log row count, read directly under
    // attendance_log_self_select - the ONLY thing the two new onboarding steps
    // (first_class, third_class) need to decide eligibility. attendance_log is
    // unique on (user_id, occurred_on) (202608310001), so this plain row count
    // already IS the distinct-day count; no separate query. `loaded` false is
    // read by currentOnboardingStep() as "not due yet", never as "due" - see
    // that function for why an undetermined answer must never flash a step on
    // and then off.
    onboarding: {
      progress: null, firstMonth: null,
      attendance: { count: 0, loading: false, loaded: false, error: false },
      // COMM-373/378. stepContent is a plain {step: {step,title,body,
      // updated_at}} map read straight off onboarding_step_content, own-
      // audience select (RLS `using (true)`), loaded once for EVERY member
      // (not just staff) at boot alongside loadOnboardingProgress() -
      // renderOnboardingWelcomeStep() and its four siblings read title/body
      // from here instead of a literal string. stepContentLoaded/-Error
      // gate the loading/error frontend states of COMM-378's own editor;
      // every member-facing onboarding card falls back to today's exact
      // hardcoded copy while this is still in flight, so there is no flash
      // even before the first load resolves. editor is COMM-378's own
      // per-row form state: drafts (title/body, seeded from stepContent the
      // first time a row is touched and never re-seeded from a background
      // reload, so mid-edit typing survives a save landing on another row),
      // saving/saved are per-step busy/confirmation flags.
      stepContent: {}, stepContentLoaded: false, stepContentError: false,
      editor: { drafts: {}, saving: {}, saved: {} },
    },

    // ---- Redesign, Phase 3: the first-run intro carousel ----
    // A DELIBERATE SIBLING of onboarding above, not a slice of it - see
    // intro_carousel_content's own migration comment (202609050007) for why
    // the five-step recurring lifecycle system above and this three-step
    // one-time first-run system share no code path. step is which of the
    // three content screens is showing (0-2); content/contentLoaded/
    // contentError/editor mirror onboarding.stepContent/.../editor's own
    // shape exactly, one level up, so a reader who already knows that shape
    // already knows this one.
    intro: {
      step: 0,
      // contentLoading is the IN-FLIGHT flag, and it is load-bearing rather
      // than cosmetic - see loadIntroCarouselContent().
      content: {}, contentLoaded: false, contentError: false, contentLoading: false,
      editor: { drafts: {}, saving: {}, saved: {} },
    },

    // ---- recaps (COMM-220..222, COMM-309) ----
    // view is the open weekly recap dialog (COMM-221); its own
    // load/prev/next calls read straight off weekly_recaps, own row only.
    //
    // COMM-309. monthly is the member-facing monthly club recap, an inline
    // Account-tab card rather than a dialog (unlike view above) - there is one
    // club-wide row to browse, not a per-member history to page through. .row
    // is the newest PUBLISHED month only: the query behind loadMonthlyRecap()
    // filters `published_at is not null` itself rather than leaning on RLS, so
    // a draft can never surface here even before the row reaches this client.
    // Empty (no row yet) and error both mean "render nothing" - COMM-309's own
    // frontend states ask for the surface to simply not show a monthly recap
    // entry before a month is published, and there is no separate error
    // affordance specified for the member side (unlike the staff preview,
    // which does have one - see state.coach.monthlyRecap).
    recaps: {
      view: null,
      monthly: { loading: false, loaded: false, error: false, row: null },
    },

    // The member's own live posting restriction, for the Account-tab panel
    // (renderMyRestrictionPanel). `row` is the single ACTIVE restriction or
    // null - loadMyRestriction() collapses the candidate rows down to one
    // before it lands here, so nothing downstream has to re-derive "is this
    // one still in force".
    //
    // NO `error` LEAF, unlike every sibling namespace here, and that is the
    // whole design rather than an omission: a failed load and "you are not
    // restricted" render identically (nothing at all), so an error flag would
    // be state nobody reads. A member who is not restricted must never see a
    // card about restrictions, and a load that failed must not invent one -
    // the write path still refuses with the mapped error, so a restricted
    // member is never left with no channel. Named `myRestriction` rather than
    // `restriction` on purpose: this is the member's OWN row under the
    // `user_id = auth.uid()` select branch, and the name is what stops a
    // later ticket parking the moderation queue's restriction rows here.
    myRestriction: { loading: false, loaded: false, row: null },

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
    coach: {
      // celebrate.items holds coach_celebrate_feed() rows exactly as
      // returned (already sorted by recency - never re-sorted here).
      // congratulated is a client-only dedupe set keyed by celebrateItemKey()
      // (kind+user_id+occurred_at, since a feed row has no id of its own),
      // so a second tap on an already-congratulated item is a no-op even
      // before the server rate limit would catch it. busy holds the key of
      // whichever item's Congratulate is in flight, if any.
      celebrate: { items: [], loading: false, loaded: false, error: false, congratulated: {}, busy: null },
      // welcome.members holds the last 30 days of joiners. contactedIds
      // is a user_id -> true set built from member_contact_log (staff can
      // read any row, COMM-224), so "contacted or not" never depends on the
      // caller having been the one who logged it. assignDrafts/contactDrafts
      // hold the free-text inputs for the assign-by-handle and mark-contacted
      // note fields, keyed by member id, read only at click time (no rerender
      // on input, so typing never loses focus).
      welcome: { members: [], loading: false, loaded: false, error: false, contactedIds: {}, assignDrafts: {}, contactDrafts: {}, busy: {}, welcomed: {} },
      // COMM-226/304. Gated on featureFlags.coachEngage (see the root).
      // profiles is a batched user_id -> {display_name,handle,avatar_url} map
      // for the open flags in .items, read the same way welcome.contactedIds
      // is: a second, separate query rather than an embedded `profiles(...)`
      // select (see loadCoachEngageFlags for why). reachedOut is a client-only
      // dedupe set keyed by flag id, the same shape celebrate.congratulated
      // uses, so a second tap on an already-sent "reach out" - or a tap while
      // the first is still in flight - is a no-op. busy is { id, action } for
      // whichever flag row has a review/dismiss/reach-out in flight, if any -
      // all three actions on one row share it, so a row disables itself
      // entirely rather than only the one control that was tapped.
      engage: { items: [], loading: false, loaded: false, error: false, profiles: {}, reachedOut: {}, busy: null },
      // 202609220002. coach_tasks_refresh() rows exactly as returned, already
      // ordered as a work queue (overdue first) - never re-sorted here, the
      // same rule celebrate.items follows. busy holds the id of whichever
      // task has a close or a contact in flight. contactDrafts is the
      // optional note beside each task, keyed by MEMBER id rather than task
      // id, because one note is one contact even when it closes four tasks.
      tasks: { items: [], loading: false, loaded: false, error: false, busy: null, contactDrafts: {} },
      // COMM-315. Coach Dashboard's own recognition section: Member of the
      // Week, one rotating category a week (consistency streak -> most PRs ->
      // challenge completion -> coach's pick, member_of_week_category() -
      // never re-derived client-side). envelope holds
      // member_of_week_candidates()'s single jsonb row exactly as returned -
      // {week_start, category, category_label, rotation_index, free_selection,
      // published, previous_week_user_id, candidates[]} - never reshaped here.
      // publishedProfile/previousProfile are two small, separate profiles
      // reads (the same batched-read shape engage.profiles and
      // welcome.contactedIds already use) for the two ids the envelope
      // names but does not itself carry a display name for: the published
      // member once published is non-null, and last week's member so the
      // free-selection form can name them in its grey-out note rather than a
      // coach discovering the rule by hitting it. pickHandle/pickReason are
      // the free-selection ("coach's pick") form's two inputs, read only at
      // publish time - no rerender on input, the same no-focus-loss shape
      // welcome's assignDrafts/contactDrafts already use; the live
      // character counter under the reason field is DOM-patched directly on
      // input instead, the same way composerSetBody's own counter is. busy
      // holds the user_id of whichever candidate publish is in flight, or the
      // literal "pick" for the free-selection form's own publish.
      memberOfWeek: { loading: false, loaded: false, error: false, envelope: null, publishedProfile: null, previousProfile: null, pickHandle: "", pickReason: "", busy: null, publishErr: "" },
      // COMM-309. Coach Dashboard's sixth section: the monthly club recap
      // staff preview. row is a single monthly_club_recaps row - the newest
      // month, draft or published, exactly as RLS hands it to a staff/
      // community.analytics.view reader (monthly_club_recaps_staff_select),
      // never reshaped. null means no month has ever been generated (there is
      // no scheduler yet - see the migration's own note - so this is a real,
      // expected state, not a load failure). busy holds the row id whose
      // publish is in flight, the same single-flight shape
      // memberOfWeek.busy uses for its own publish action.
      monthlyRecap: { loading: false, loaded: false, error: false, row: null, busy: null, publishErr: "" },
    },
  };
  const photoUrlCache = {};
  // Same idea for avatars, since 202609060003 made avatar-photos a private
  // bucket. Keyed by the STORED profiles.avatar_url (cache-bust included),
  // valued with a signed URL for the storage path inside it. See avatarHtml()
  // for why the key is the url and not the path. avatarInFlight stops one
  // render pass from firing thirty identical sign requests for thirty cards
  // that all show the same coach.
  const avatarUrlCache = {};
  const avatarInFlight = {};

  // COMM-141. The notification badge refreshes on a realtime own-row
  // event. That subscription was written before public.notifications was
  // in the supabase_realtime publication, so it was a working no-op until
  // 202608290007 landed; COMM-227 is the ticket that made it live, with no
  // change to the subscription itself.
  if (client && window.HaimuniaRealtime && typeof window.HaimuniaRealtime.configure === "function") {
    window.HaimuniaRealtime.configure({ client });
  }

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

  // Coach and admin are both "staff" for the fixed set of powers every
  // coach gets (announcements, the weekly challenge, the new/inactive
  // member views) — matches public.is_staff() server-side, which is what
  // actually enforces this; this is only for deciding what to show.
  // COMM-150. Named permission strings, checked against the caller's cached
  // permission set. No community staff control branches on a role literal or
  // on is_admin any more; the server policy behind each control is the real
  // authority and this only decides what to render. The set is loaded once
  // per session by loadPermissions() from my_permissions(), dropped on
  // sign-out, and reloaded on the auth-state-change path so a role change
  // takes effect without a reload.
  const PERM = {
    POST_DELETE_ANY: "community.post.delete_any",
    COMMENT_MODERATE: "community.comment.moderate",
    CHALLENGE_CREATE: "community.challenge.create",
    EVENT_MANAGE: "community.event.manage",
    ANALYTICS_VIEW: "community.analytics.view",
    MEMBER_RESTRICT: "community.member.restrict",
    CONTENT_PIN: "community.content.pin",
    ANNOUNCEMENT_PUBLISH: "community.announcement.publish",
    CLUB_MANAGE_MODULES: "community.club.manage_modules",
    // Phase 4 (COMM-370/371/373). MEMBER_INVITE gates the per-person invite
    // half of COMM-376's screen and is held by coach and up (the server's
    // own admin_invite_create/list/revoke pair) - NOT the same tier as
    // MEMBER_RESTRICT, see contracts.md's own correction of that comparison.
    // INVITE_MANAGE_CODES gates the shared-code half, admin/owner only
    // (admin_invite_code_*). CONTENT_MANAGE_ONBOARDING gates COMM-378's
    // editor, matching community.announcement.publish's seeded role list.
    MEMBER_INVITE: "community.member.invite",
    INVITE_MANAGE_CODES: "community.invite.manage_codes",
    CONTENT_MANAGE_ONBOARDING: "community.content.manage_onboarding",
    // 202609160005. Removal used to be admin-only (a hardcoded is_admin()
    // inside admin_remove_member), which left the head coach - the role that
    // OWNS the invite surface, and the only one whose panel renders it -
    // able to add members and never take one off the roster. The server
    // pairs this permission with a rank guard, so holding it does not mean
    // "may remove anyone": you reach strictly below your own rank only.
    MEMBER_REMOVE: "community.member.remove",
  };
  // Mirrors public.roles.rank (202608280001). Used ONLY to decide what to
  // draw - admin_remove_member() re-derives both ranks server-side and is
  // the authority. Kept here so a head coach is not shown a remove button
  // against another head coach that the server would then refuse.
  const ROLE_RANK = { member: 10, coach: 20, head_coach: 30, staff: 40, admin: 50, owner: 60 };
  function myRoleRank() {
    if (inMgmtContext()) return mgmtIsAdmin() ? ROLE_RANK.admin : (mgmtIsStaff() ? ROLE_RANK.coach : 0);
    const redeemed = (state.redemption && ROLE_RANK[state.redemption.role]) || 0;
    const flagged = (state.profile && state.profile.is_admin) ? ROLE_RANK.admin : 0;
    return Math.max(redeemed, flagged);
  }
  // The client half of admin_remove_member()'s two gates: the permission,
  // and target rank strictly below mine. is_admin is checked on the row
  // itself because the flag outranks the redeemed role server-side too.
  function canRemoveMember(m) {
    if (!m || !m.id) return false;
    if (!(isAdmin() || hasPerm(PERM.MEMBER_REMOVE))) return false;
    if (state.user && m.id === state.user.id) return false;
    const target = Math.max((ROLE_RANK[m.role] || ROLE_RANK.member), m.is_admin ? ROLE_RANK.admin : 0);
    return target < myRoleRank();
  }
  // COMM-321 Club Modules, extended by the redesign's Phase 2 (202609050006).
  // Two groups now, matching the mockup's own "תכני קהילה" / "כלי מאמנים"
  // split, declared here ahead of both toggleClubFeature() and
  // renderClubModulesPanel() for the same load-order reason as before.
  //
  // clientOnly marks the one real asymmetry worth keeping visible at the
  // call site, not just in a comment: 'directory' has no RLS clause behind
  // it (profiles is too foundational a read policy to gate - the schema
  // migration's own reasoning, kept on purpose by 202609050006, not
  // revisited) and the four "כלי מאמנים" keys gate a coach-only UI SECTION,
  // not member-facing data - the RPCs behind them already carry their own
  // is_staff()/has_perm() check independent of this flag. Every other key
  // here is a real, server-enforced RLS gate. renderClubModulesPanel() reads
  // this flag to avoid making a blanket "enforced on the server" claim about
  // a row where that would be false.
  const CLUB_MODULE_TOGGLES = [
    { key: "announcements", label: "הודעות מועדון" },
    { key: "events", label: "אירועים" },
    { key: "challenges", label: "אתגרים" },
    { key: "achievements", label: "הישגים ומדליות" },
    { key: "feed", label: "פיד (כולל תגובות חיזוק)" },
    { key: "leaderboards", label: "טבלאות מובילים" },
    { key: "directory", label: "ספריית חברים", clientOnly: true },
    // Added 2026-09-15, on the owner's instruction that every function in the
    // app should be switchable from the admin panel. Each of these ran with
    // no off switch at all.
    //
    // weekly_recap is a straight sibling gap: the MONTHLY club recap has been
    // switchable since it shipped, while the WEEKLY one - the more frequent
    // of the two, and the one that reaches every member - never was.
    //
    // All five are clientOnly: they hide a control rather than being enforced
    // by RLS, so the panel must not claim otherwise. A member who forges the
    // request still reaches the same server-side permission checks these
    // surfaces always had; what the toggle buys is that the club stops being
    // OFFERED the feature, which is what an owner switching it off means.
    { key: "weekly_recap", label: "סיכום שבועי לחברים", clientOnly: true },
    { key: "comments", label: "תגובות על פוסטים", clientOnly: true },
    { key: "post_photos", label: "תמונות בפוסטים", clientOnly: true },
    { key: "mentions", label: "תיוג חברים (@)", clientOnly: true },
    { key: "outward_share", label: "שיתוף מחוץ לאפליקציה", clientOnly: true },
    // The owner's kill switch for push, 2026-09-17. Deliberately NOT
    // clientOnly: the check is inside notif_push_pending (202609170003), so
    // switching it off stops delivery even for a device already subscribed,
    // a notification already written and a cron already running. A kill
    // switch that only hides a button is not a kill switch.
    //
    // PUSH ONLY, by the owner's explicit choice. The bell, the notification
    // centre and every in-app notification are untouched - this stops the
    // delivery that leaves the app and interrupts somebody.
    { key: "push_notifications", label: "התראות דחיפה למכשיר" },
    // Real device feedback: this whole feature (a coach schedules a
    // catalogue WOD for today; it gets one card on the feed and one board
    // members attach their own logged results to) had no toggle at all -
    // renderClubWodTodayStrip() rendered unconditionally, every day, for
    // every club, with no way to turn it off. clientOnly because turning
    // it off only stops the ONGOING prompt/today-card - past feed posts
    // and boards a WOD already generated stay exactly as reachable as any
    // other history, the same "off hides new, not old" rule achievements/
    // challenges already follow; there is no RLS clause to pair with this
    // one (club_wod_boards/club_wods_list carry their own auth checks,
    // independent of this flag, same asymmetry 'directory' documents).
    { key: "club_wod", label: "אימון יומי למועדון", clientOnly: true },
    // 202609100002. Not clientOnly: gated inside notif_streak_at_risk()
    // itself (club_feature_enabled('streak_risk_nudges')), a real
    // server-enforced off switch on a scheduled job, not a UI hide.
    { key: "streak_risk_nudges", label: "תזכורות רצף אימונים לחברים" },
    // ------------------------------------------------------------------
    // SWITCHES THAT ARRIVE BEFORE THEIR FEATURES (202609190002).
    //
    // Everything above this line gates a surface that exists. These four,
    // and the three at the end of COACH_MODULE_TOGGLES, name features a
    // later branch will build; the key and the club_features row are here
    // first so that branch wires one isModuleEnabled() gate and adds no
    // migration of its own - supabase/migrations/ being the directory two
    // open branches cannot both touch (CLAUDE.md, "Parallel work").
    //
    // planned: true is the honest half of that. Every other row in these
    // arrays turns something off; these turn nothing off, because there is
    // nothing behind them yet, and the panel says so on the row rather than
    // leaving an admin to discover it by flipping the switch and watching
    // the app not change. The branch that builds the feature clears the
    // flag in the same commit that adds its gate.
    //
    // clientOnly: true for all seven, for the same reason: there is no RLS
    // clause behind any of them, so the panel must not claim server
    // enforcement. Whichever of the two a feature turns out to need, its
    // own branch sets it then - that is a decision about a feature that
    // exists, and cannot be made here.
    //
    // desc is new with these rows and deliberately optional. A one-line
    // Hebrew sentence matters far more for a switch whose feature nobody
    // has seen than for "אירועים", and clubModuleRow() renders it only when
    // a row carries one, so no existing row changed.
    // BUILT 2026-09-22 (202609220002). planned came off with the feature, and
    // so did clientOnly: onboarding_challenge_state()/_respond() refuse while
    // the key is off, and onboarding_challenge_offers' own SELECT policy
    // carries club_feature_enabled('onboarding_challenge'). That is a real
    // server gate, so the panel may say so.
    //
    // The description no longer says "אוטומטית". It is offered automatically
    // and ACCEPTED deliberately, and the distinction is the whole feature -
    // an admin reading this row must not switch on something they think
    // enrolls their members.
    { key: "onboarding_challenge", label: "אתגר כניסה לחבר/ה חדש/ה", desc: "אתגר קצר שמוצע לכל מי שהצטרף/ה זה עתה, ומתחיל רק אם בחרו לקבל אותו.",
      settings: [
        { id: "goal_sessions", label: "מספר אימונים ליעד", def: 8, min: 1, max: 60 },
        { id: "window_days", label: "אורך האתגר בימים", def: 30, min: 1, max: 365 },
        { id: "offer_within_days", label: "עד כמה ימים מההצטרפות מציעים", def: 30, min: 1, max: 365 },
      ] },
    // planned: true came off with the feature (2026-09-22), the same handover
    // 202609190002 set up and strength_percentages below went through first:
    // the marker comes off in the commit that adds the gate. The benchmark
    // section on the progress screen reads this key (benchmarksOn() in
    // app.js), so "בפיתוח" would now be a lie. clientOnly STAYS - the gate is
    // a display hide in app.js over the member's OWN training log, there is
    // no RLS clause behind the key (attempts are ordinary private_records
    // rows, protected by that table's own self-only policies, not by this
    // switch), and the row must not claim enforcement it does not have.
    { key: "benchmarks", label: "אימוני בנצ'מרק", desc: "האימונים המוכרים בשמם (Fran, Grace ודומיהם) ומעקב אחרי השיפור בהם לאורך זמן.", clientOnly: true },
    // planned: true came off with the feature (2026-09-21). The percentage
    // chips on the log screen read this key, so "בפיתוח" would now be a lie -
    // which is exactly the handover 202609190002 set up: the marker comes off
    // in the same change that adds the gate. clientOnly STAYS: the gate is a
    // display hide in app.js, there is no RLS clause behind this key, and the
    // row must not start claiming enforcement it does not have.
    { key: "strength_percentages", label: "אחוזים ממשקל מקסימלי", desc: "חישוב משקלי עבודה לפי אחוז מהמקסימום האישי (1RM) של כל חבר/ה.", clientOnly: true },
    { key: "gym_display", label: "מסך תצוגה במועדון", desc: "מסך לצפייה בלבד שנתלה בחדר האימון ומציג את אימון היום ואת לוחות המובילים.", clientOnly: true, planned: true },
  ];
  const COACH_MODULE_TOGGLES = [
    { key: "coach_tools", label: "לוח מאמנים (הכל)", clientOnly: true },
    { key: "member_of_week", label: "חבר/ת השבוע", clientOnly: true },
    { key: "welcome_flow", label: "קבלת פנים", clientOnly: true },
    // 202609160004. NOT clientOnly, deliberately: this one is enforced inside
    // post_new_member_on_join(), the trigger that writes the card. It used to
    // be folded into welcome_flow above - which IS clientOnly - so turning that
    // off hid a coach section while the server kept posting a "welcome our new
    // member" card into everyone's feed. They are separate questions: that one
    // is the coach's tool for greeting a newcomer personally, this one is an
    // automatic card in front of the whole club.
    { key: "new_member_posts", label: "פוסט הצטרפות בפיד" },
    { key: "monthly_recap", label: "סיכום חודשי", clientOnly: true },
    // 202609100002. Not clientOnly: gated inside coach_notify_engagement_flags()
    // itself (club_feature_enabled('engagement_alerts')) - coach_engagement_flags
    // detection keeps running either way (coach-engagement-decline is a
    // separate, untouched job), this only silences the push/in-app alert.
    { key: "engagement_alerts", label: "התראות ירידה במעורבות חבר/ה לצוות" },
    // The coach-side three of 202609190002's seven. See the block in
    // CLUB_MODULE_TOGGLES above for what planned/clientOnly mean here and
    // why the keys exist before the features do.
    // BUILT 2026-09-22 (202609220002). Both markers come off: coach_tasks'
    // own SELECT and UPDATE policies carry club_feature_enabled('coach_tasks'),
    // so switching it off stops a coach reading a task even with a hand-made
    // request - which is what "נאכף בשרת" means and what clientOnly would
    // have denied.
    { key: "coach_tasks", label: "משימות למאמן/ת", desc: "רשימת משימות שהמאמן/ת עובר/ת עליהן - לברך, לקלוט או לחזור אל מי שנעלם/ה.",
      settings: [
        { id: "welcome_by_day", label: "ברכה עד יום", def: 7, min: 1, max: 180 },
        { id: "first_class_followup_days", label: "מעקב אחרי אימון ראשון (ימים)", def: 3, min: 0, max: 60 },
        { id: "low_attendance_window_days", label: "חלון בדיקת נוכחות (ימים)", def: 21, min: 1, max: 180 },
        { id: "low_attendance_min_sessions", label: "מינימום אימונים בחלון", def: 2, min: 1, max: 30 },
        { id: "checkin_day", label: "שיחת מעקב ביום", def: 60, min: 1, max: 365 },
        { id: "no_contact_days", label: "התראה אחרי ימים ללא קשר", def: 30, min: 1, max: 365 },
        { id: "onboarding_window_days", label: "חלון קליטה (ימים)", def: 90, min: 1, max: 730 },
      ] },
    { key: "owner_report", label: "דוח לבעלי המועדון", desc: "סיכום תקופתי על פעילות המועדון למי שמנהל/ת אותו.", clientOnly: true, planned: true },
    { key: "arbox_attendance", label: "נוכחות מ-Arbox", desc: "משיכת נוכחות בשיעורים מ-Arbox במקום הסתמכות על דיווח עצמי בלבד.", clientOnly: true, planned: true },
  ];
  const CLUB_MODULE_KEYS = CLUB_MODULE_TOGGLES.concat(COACH_MODULE_TOGGLES).map((m) => m.key);
  // PERMISSION QUESTIONS HAVE TWO SUBJECTS NOW.
  //
  // Everywhere in the app, "may I?" means the member who is signed in. On the
  // two management tabs it means the management account that signed into the
  // gate - a different identity entirely (see makeMgmtClient()). Since the
  // owner's training account deliberately holds no admin power, asking about
  // the member inside a management panel would answer "no" to every section
  // on a screen they had just proved they were entitled to open.
  //
  // Scoped by CURRENT TAB rather than by a flag set around the render call,
  // on purpose. The same three questions are asked from three places - the
  // render pass, the after-render pass that decides which loaders to fire,
  // and the action handlers - and a stack-scoped flag would have covered the
  // first and silently missed the other two, which is the kind of gap that
  // renders a panel and then refuses to fill it. "Which tab is this?" is true
  // in all three places without anyone having to remember to wrap anything.
  function inMgmtContext() {
    if (!state.admin.mgmt) return false;
    // window.haimuniaActiveTab, NOT state.ui.tab. state.ui.tab is this file's
    // COMMUNITY SUB-TAB (feed / boards / directory / ...) and never holds
    // "manage" - an earlier version of this function read it and every
    // section of an unlocked panel rendered "no permission" while the panel
    // itself opened perfectly. app.js sets this on every render pass, before
    // it dispatches, so it is already right for the render, the after-render
    // loaders and the click handlers alike.
    const t = window.haimuniaActiveTab;
    return t === "manage" || t === "clubmanage";
  }
  function hasPerm(code) {
    const src = inMgmtContext() ? state.admin.mgmt.perms : state.permissions;
    return !!src && src.indexOf(code) >= 0;
  }
  async function loadPermissions() {
    if (!state.user) { state.permissions = []; state.permissionsLoaded = false; return; }
    const { data, error } = await client.rpc("my_permissions");
    state.permissions = error ? [] : (data || []);
    state.permissionsLoaded = !error;
  }
  // COMM-321 Club Modules. club_features has select open to authenticated
  // (no RLS role gate) - every member, not just staff, needs to know which
  // modules are on, same as permissions itself.
  async function loadClubFeatures() {
    if (!state.user) { state.club.features = {}; state.club.featuresLoaded = false; return; }
    const { data, error } = await client.from("club_features").select("module_key,enabled,config");
    if (error) { state.club.features = {}; state.club.featuresLoaded = false; return; }
    const next = {};
    for (const row of (data || [])) next[row.module_key] = { enabled: row.enabled, config: row.config || {} };
    state.club.features = next;
    state.club.featuresLoaded = true;
    // Hands the map to app.js, the same way setClubWods() hands it the
    // catalogue. app.js keeps its OWN cached copy because what it gates
    // (the percentage chips on the log screen) has to render offline, with
    // no session and with this function never having run - see
    // CLUB_FEATURES_CACHE_KEY there, and note its default is off, not on.
    if (typeof window.setClubFeatureFlags === "function") window.setClubFeatureFlags(next);
  }
  // Defaults to true while not yet loaded and for any key with no row at
  // all - deliberately not mirroring notifPrefsLoaded's skeleton-row
  // pattern: this gates whether content renders at all across many call
  // sites, not one section's own loading state, and RLS (club_feature_enabled
  // in every extended policy) is the real backstop regardless of what
  // renders here during the brief pre-load window. Must never be reached
  // before isCommunitySignedIn() gates rendering, same as hasPerm().
  function isModuleEnabled(key, subKey) {
    if (!state.club.featuresLoaded) return true;
    const row = state.club.features[key];
    if (!row) return true;
    if (!row.enabled) return false;
    if (subKey && row.config && Object.prototype.hasOwnProperty.call(row.config, subKey)) return !!row.config[subKey];
    return true;
  }
  // A thin convenience over the role model: coach rank or above, mirroring
  // the server's public.is_staff(). Kept for the fixed coach powers
  // (announcements, the weekly challenge, the new/inactive member views)
  // whose policies bind to is_staff() rather than a named permission; the
  // server is the authority, this only decides what to show. head_coach
  // reads as staff here the same way it does server-side.
  function isStaff() {
    if (inMgmtContext()) return mgmtIsStaff();
    return !!(state.profile && (state.profile.is_admin || (state.redemption && (state.redemption.role === "coach" || state.redemption.role === "head_coach"))));
  }
  // Real is_admin only. Kept for the handful of server functions that still
  // check the profiles.is_admin column inline rather than a permission:
  // review_report(), the posts_select_admin_review RLS bypass, and the
  // admin_* member-management RPCs. Every other gate uses hasPerm().
  function isAdmin() {
    if (inMgmtContext()) return mgmtIsAdmin();
    return !!(state.profile && state.profile.is_admin);
  }
  // COACH-TIER, deliberately narrower than isStaff() (2026-09-15): "coach area
  // will be visible only for coach."
  //
  // isStaff() means "coach and above", which includes an admin - and since the
  // panels were split, an admin's job is the app, not the floor. The coach
  // board is a working surface for whoever actually coaches the classes:
  // congratulate this member, welcome that one, chase the one who has not been
  // in. Showing it to an account that runs the app is clutter at best and an
  // invitation to act on people you are not coaching at worst.
  //
  // head_coach counts - a head coach is a coach. An admin who ALSO redeemed a
  // coach role counts too, because then they really are one; what does not
  // count is the is_admin flag on its own.
  function isCoachTier() {
    return !!(state.redemption && (state.redemption.role === "coach" || state.redemption.role === "head_coach"));
  }
  // COMM-152, consolidated. The one place this count is computed - it used
  // to be duplicated inline at the old Community "חשבון" badge and at
  // getCommunityNavPreview(), which is exactly how the badge staying on
  // that pill after moderation moved to Manage went unnoticed (two call
  // sites drifting from a third, the real one, is what the redesign's own
  // getCommunityNavPreview bug already showed once). Exposed on window so
  // app.js's getNavItems() can badge the Manage bottom-tab nav item.
  function pendingModerationCount() {
    return (hasPerm(PERM.COMMENT_MODERATE) || isAdmin())
      ? state.admin.modQueue.filter((r) => r.status === "open").length : 0;
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
  // Live bug hunt (2026-09-11): this returned the UTC calendar date, not the
  // local one. Israel is always ahead of UTC (+2 winter / +3 DST summer), so
  // for the first 2-3 hours after LOCAL midnight every night this returned
  // YESTERDAY's date. Confirmed live (Playwright, timezoneId
  // "Asia/Jerusalem", clock fixed to 01:00 local): the feed's "pinned note
  // for today" showed a stale note pinned for the day before while today's
  // real pin sat in the archive, and the Club WOD board labeled today's own
  // session "מחר" (tomorrow) while app.js's board panel simultaneously
  // labeled the same session "today" - because app.js's todayISO()
  // (src/format.js) already builds the date from local Y/M/D and was never
  // affected. Matches that same local-date construction instead of
  // reimplementing a UTC-based one.
  // Live bug hunt (2026-09-11): every "${n} משתתפים" site rendered "1
  // משתתפים" for the single most common real case - a challenge/event's
  // first joiner. One shared helper instead of six separately-typed
  // ternaries, matching relativeTime()'s own singular-branch fix above.
  // Hebrew does not pluralise the way the template did. Live bug hunt, fresh
  // round 2 (2026-09-15): the club header hardcoded `${n} חברי מועדון`, so a
  // club with one member read "1 חברי מועדון" - a plural noun with the number
  // one. Every fixture-seeded club in the suite has two or more members, so
  // this string had never been rendered with 1 until production was emptied
  // and the first real member arrived alone. It is the first line of the
  // first tab they land on.
  //
  // Same shape as participantsLabel() right below, which already solved this
  // exact problem for challenges - reused rather than re-invented.
  function clubMembersLabel(n) {
    const count = Number(n) || 0;
    // The slash form of "one" was wrong here, and it was mine - introduced
    // this same session while fixing "1 חברי מועדון". The feminine of אחד is
    // the irregular אחת: the ד BECOMES ת, so the two cannot be joined by a
    // slash without spelling a non-word. That is exactly the class this
    // project already bans for the welcome-greeting pair (see
    // test/hebrew-copy-rules.test.mjs), whose own note says the patched form
    // is still wrong and the string has to be REPHRASED.
    //
    // So this drops the numeral rather than trying to gender it.
    // "חבר/ה במועדון" is valid either way, reads naturally, and still says
    // what the line needs to say. test/hebrew-copy-rules.test.mjs now blocks
    // the bad form by name so it cannot come back.
    return count === 1 ? "חבר/ה במועדון" : `${count} חברי מועדון`;
  }
  // Two more counts that render a plural noun beside the number one. Live bug
  // hunt, fresh round 3 (2026-09-15), found by looking for siblings of the
  // club-header bug round 2 turned up - "1 ימים נותרו" on a cooperative
  // challenge in its last day, and "1 אימונים בשבוע" on a consistency
  // challenge a coach set to once a week, which the create form's own min="1"
  // explicitly allows.
  //
  // Both are reachable by ordinary configuration, not edge cases: a challenge
  // is in its final day exactly once, every time, and once-a-week is the
  // gentlest setting a coach can pick.
  function daysRemainingLabel(n) {
    const count = Number(n) || 0;
    return count === 1 ? "יום אחד נותר" : `${count} ימים נותרו`;
  }
  function sessionsPerWeekLabel(n) {
    const count = Number(n) || 0;
    return count === 1 ? "אימון אחד בשבוע" : `${count} אימונים בשבוע`;
  }
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
  // COMM-318. avatarUrl is optional and always the third argument, so every
  // pre-existing 2-arg call keeps rendering the initials badge unchanged. A
  // real photo replaces the badge outright rather than sitting behind it -
  // there is nothing to blend, an avatar is either a photo or initials.
  function avatarHtml(name, size, avatarUrl) {
    const px = size || 36;
    if (avatarUrl) {
      // The avatar-photos bucket is PRIVATE (202609060003 flipped it; while
      // it was public the object URL served every member's face to the open
      // internet with no session at all). profiles.avatar_url still stores
      // the /object/public/ form, but that form is now an IDENTIFIER, not a
      // fetchable URL - it 400s if anyone hits it directly, which is the
      // point. The bytes come from a short-lived signed URL instead, the
      // same photoUrlCache/resolvePhotoUrl shape post-photos has always
      // used.
      //
      // The cache is keyed by the STORED url, cache-bust and all, not by the
      // storage path: an avatar is overwritten in place (upsert:true), so
      // two uploads share one path and only the ?t= stamp distinguishes
      // them. Keying by path would pin the first upload's signed URL
      // forever.
      const cached = avatarSignedUrl(avatarUrl);
      if (cached) {
        return `<img alt="" aria-hidden="true" class="avatar-badge" src="${esc(cached)}" style="width:${px}px;height:${px}px;object-fit:cover;"/>`;
      }
      // Not one of ours (nothing writes such a value today, but the column
      // is plain text with only a scheme CHECK on it) - render it directly,
      // exactly as before.
      if (!avatarPathFromUrl(avatarUrl)) {
        return `<img alt="" aria-hidden="true" class="avatar-badge" src="${esc(avatarUrl)}" style="width:${px}px;height:${px}px;object-fit:cover;"/>`;
      }
      // Ours, not resolved yet: kick off the signing and fall through to the
      // initials badge for this one paint. resolveAvatarUrl() rerenders when
      // it lands, the same way resolvePhotoUrl() does for a feed photo.
      resolveAvatarUrl(avatarUrl);
    }
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
    { id: "wod", term: "WOD", gloss: "אימון היום", body: "האימון המשותף שכל המועדון עושה באותו יום. ראשי תיבות של Workout Of the Day." },
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
  // Shared batch profile lookup - the shape loadCoachEngage(), loadCoachMemberOfWeek()
  // and loadFollowList() each independently hand-rolled. Consolidated after
  // finding real drift between the copies (a missing avatar_url column in
  // one, ad-hoc dedup in another): every caller now gets the same base
  // columns for free, and adding one going forward can't silently miss a
  // field the way a fourth hand-written copy could. extraCols appends
  // caller-specific columns (e.g. loadFollowList's allow_follows) - never
  // subtracts from the shared base.
  async function loadProfilesById(ids, extraCols) {
    const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
    const map = {};
    if (!uniqueIds.length) return { map, error: null };
    const cols = "id,handle,display_name,avatar_url" + (extraCols ? "," + extraCols : "");
    const { data, error } = await client.from("profiles").select(cols).in("id", uniqueIds);
    if (error) return { map, error };
    for (const p of (data || [])) map[p.id] = p;
    return { map, error: null };
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

  // COMM-331. The feed/streaks/announcements/weekly-challenge/club-summary/
  // blocked-ids/achievements/notifications/pins/events/onboarding-progress/
  // staff/mod-queue cascade used to run unconditionally inside
  // refreshSession() (and again in onAuthStateChange below) on every cold
  // boot - ~16 parallel requests fired before a member who only ever opens
  // the training-log tabs had touched the Community tab once. It now runs
  // once per session, gated by the communityDataLoaded/communityDataLoading
  // pair, the first time the Community tab actually renders - see the
  // afterRenderCommunity() call below, the same once-per-session lazy
  // pattern already used there for the audit log and analytics dashboard.
  //
  // What this function deliberately does NOT cover, and why: loadProfile(),
  // loadRedemption(), loadChallenges() and loadClubFeatures() stay eager in
  // refreshSession()/onAuthStateChange instead of moving here, along with
  // pingActivity() and the syncCommunityMilestones() trigger that depend on
  // profile being loaded. A first attempt at this ticket deferred all of
  // them and broke real, cross-tab behavior (18 test failures) that a
  // static read of the call sites did not surface: window.isCommunitySignedIn()
  // - a global gate consumed by the PR-share prompt and achievement-claim
  // flows, both triggered from the core training-log tabs, not just the
  // Community tab - depends on state.profile. onPrCreatedForChallenges()
  // (also triggered from a core-tab save, via the PR_CREATED bus event)
  // reads state.challenges.items/state.challenges.participation to auto-log a
  // challenge delta, which is why loadChallenges() is eager here too - and
  // loadClubFeatures() rides along with it: isModuleEnabled() defaults a
  // module "on" until its row loads, so with challenges data present but
  // the feature gate still pending, a module the club actually turned off
  // would render for the gap between the two (caught by a real test, not
  // static analysis, and closed by loading both together rather than
  // leaving it to self-correct after a visible flash). Every other loader
  // below was traced against every top-level event-bus listener and every
  // window.*-exposed function app.js calls before being
  // judged safe to defer - see the reverted attempt's own writeup
  // (docs/community/tickets/COMM-331.md) for the full trace.
  async function ensureCommunityDataLoaded() {
    // Also gated on recovery_verified_at: renderCommunityApp() returns the
    // recovery gate's own content and nothing else while it's pending (see
    // that check's own comment, COMM-016), so there's no UI yet for any of
    // this to feed. Loading it anyway raced loadFeed()'s state.ui.message
    // reset (on success, loadFeed sets it to "") against verifyRecovery()'s
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
      await Promise.all([loadPermissions(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge(), loadClubWods(), loadClubWodBoards(), loadClubSummary(), loadBlockedIds(), loadFollowingIds(), loadMyAchievements(), loadNotifUnread(), loadNotifPrefs(), loadPins(), loadEvents(), loadOnboardingProgress(), loadOnboardingStepContent()]);
      if (isStaff()) await Promise.all([loadInactiveMembers(), loadNewMembers(), loadActivitySignal()]);
      if (hasPerm(PERM.COMMENT_MODERATE) || isAdmin()) await loadModQueue();
      if (hasPerm(PERM.MEMBER_RESTRICT) || hasPerm(PERM.COMMENT_MODERATE) || isAdmin()) await loadRestrictions();
      // COMM-141. Arm the own-row notification channel for this session.
      ensureNotifRealtime();
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

  // ---- COMM-378. Onboarding step content editor ------------------------
  // Admin-console content management (same cluster as pinned content and
  // the announcement/analytics admin surfaces), not a coach-tools member-
  // relationship action - see backlog.md's own placement note. Gated on
  // community.content.manage_onboarding or real is_admin(), matching
  // onboarding_step_content's own write policy exactly - a coach without
  // that permission never sees the entry point at all, per this ticket's
  // own criterion.
  // The composer's own label, defined once because TWO screens say it: the
  // fake-input row at the top of the feed, and the welcome onboarding card
  // that tells a brand-new member to tap it. Those two drifted apart once
  // already - the feed redesign renamed the control and the onboarding copy
  // kept pointing at the old name - and the only thing that noticed was a
  // pre-launch read-through. One constant, plus a test that the card's
  // sentence contains it, is what keeps them honest.
  const POST_COMPOSER_PLACEHOLDER = "מה קורה היום?";
  // WHAT TO DO WHEN THE PASSWORD IS GONE. Pre-launch review, 2026-09-15.
  //
  // This screen offered a username, a password and a button, and nothing else
  // - no "forgot my password", not even a sentence. There is no email reset
  // and there is never going to be one: email delivery is permanently out of
  // scope for this project, which is a deliberate decision and not a gap.
  //
  // But the consequence of that decision was never written down anywhere a
  // member could read it. So a member who forgot their password met a form
  // that refused them with no route out at all. With one member that never
  // came up. With a club of thirty it happens in the first week, and the
  // realistic outcome is not that they ask - it is that they quietly stop
  // opening the app, and nobody ever learns why.
  //
  // The route exists and works: an admin resets the password from the roster
  // and hands over the temporary one in person. That is a perfectly good
  // answer for a gym, where the staff see these people twice a week. It only
  // needed saying.
  const LOGIN_RECOVERY_NOTE = `<div class="footer-note" style="margin-top:14px;">${bidiText("שכחתם את הסיסמה? פנו למאמן/ת או לצוות המועדון — אפשר לאפס אותה עבורכם ולקבל סיסמה חדשה ביד.")}</div>`;

  // The link that replaces the toggle this file will not offer. It closes the
  // board first - the privacy panel lives under #content, which an open
  // modal-overlay covers - and rides the one-shot scroll setManageTab()
  // already uses, consumed in the same afterRenderCommunity() pass by a plain
  // getElementById that does not care which tab set it.
  function openPrivacySettings() {
    closeClubWodBoard();
    if (typeof window.switchToCommunityTopTab === "function") window.switchToCommunityTopTab();
    state.ui.manageScrollTo = "communityPrivacyPanel";
    setCommunityTab("account");
  }

  // ==========================================================================
  // COMM-150..156  admin-moderation cluster.
  // The moderation queue, its actions, the pinned strip and the admin audit
  // view. Every queue action routes through mod_review(), a trusted
  // security-definer function that stamps the reviewer id and timestamp,
  // applies the decision (content removal, warning, posting restriction,
  // dismissal) and writes admin_actions in the same transaction. The client
  // never writes reports, posting_restrictions, pins or admin_actions
  // directly - it has no grant to - so the audit trail is a property of the
  // schema, not of this file.
  // ==========================================================================

  // ==========================================================================
  // THE JOINING QR
  //
  // The box owner's objection, in his words: the invite code is a 48-character
  // hex string that "cannot be printed on a flyer". His front desk was reading
  // it aloud, or typing it into WhatsApp, once per member. At 150 members that
  // is the support load he refused to take on.
  //
  // A SHORT HUMAN CODE IS NOT AVAILABLE. redeem_invite_code's own signature
  // constrains p_code to ^[a-f0-9]{40,128}$, so "make the code sayable" is a
  // schema change, not a client change, and is deliberately not attempted
  // here. What IS available is removing the need to say it at all: a QR of a
  // deep link that opens the app with the code already in the field.
  //
  // WHY THIS ENCODER RATHER THAN A VENDORED LIBRARY. vendor/supabase.js is the
  // precedent for vendoring, and it was weighed. The smallest maintained
  // general-purpose QR library (qrcode-generator, MIT) ships 56KB of
  // unminified JS covering all 40 versions, 4 error-correction levels, 4
  // encoding modes, Shift-JIS tables and its own GIF/HTML renderers. This app
  // has no build step, so none of that is tree-shaken away - all 56KB would
  // ship, be precached by the service worker, and sit unreviewed in a
  // codebase whose whole security posture (strict CSP, zero innerHTML sinks,
  // one shared escape) rests on the code being readable. What this feature
  // actually needs is one mode (byte), one error-correction level (M, the
  // 15% print default) and one payload shape (a short ASCII URL). That is the
  // ~200 lines below, all of it reviewable, and it is proved correct rather
  // than assumed: test/community-invite-qr.test.mjs decodes the finished
  // matrix back with an independent reader that shares no code with this
  // encoder, and the encoder was diffed module-for-module against
  // qrcode-generator's output over 588 payloads before it landed.
  //
  // Structure per ISO/IEC 18004: encode to codewords, add Reed-Solomon parity
  // per block, interleave, lay out on the matrix, then pick the mask that
  // scores best under the four penalty rules.
  // ==========================================================================

  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { QR_EXP[i] = x; QR_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
  })();
  captureInviteDeepLink();

  // ==========================================================================
  // COMM-110..115  feed cluster.
  // Ranking, diversity and the page boundary all live in public.feed_page()
  // (migration 202608280019). Everything below consumes that function: it
  // renders the rows in the order they arrived, asks for the next page with
  // the opaque cursor the function handed back, and measures what was shown.
  // It never re-scores and never re-sorts - a client that re-sorted a ranked
  // list would be disagreeing with the server about what the member has
  // already seen, which is exactly what the impression stream is for.
  // ==========================================================================

  // ==========================================================================
  // COMM-120..125  engagement cluster: reactions, comments, replies, mentions,
  // coach comment emphasis, block effects. The post card (posts cluster) only
  // exposes the `cheer` / `toggle-comments` hooks and a slot that renders
  // renderComments(post); everything below is engagement-owned.
  // ==========================================================================

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
  const OUTBOX_ACTIONS = ["post_create", "add_post_comment", "toggle_reaction", "event_rsvp", "chal_record_progress"];
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
    "cannot remove a member at or above your own role": "אפשר להסיר רק חבר/ה בדרגה נמוכה משלכם. מאמן/ת ראשי/ת, מנהל/ת או בעל/ת המועדון מוסרים/ות על ידי מנהל/ת המערכת.",
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
    posting_restricted: "צוות המועדון הגביל את הפרסום מהחשבון הזה, ולכן פוסטים ותגובות חדשים לא נשלחים. אפשר להמשיך לקרוא את הפיד ולעודד אחרים כרגיל. הסיבה שנרשמה ומועד סיום ההגבלה מופיעים בטאב \"חשבון\", וההגבלה נפתחת רק על ידי הצוות — כדאי לפנות למאמן/ת.",
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
  const SERVER_ERROR_GENERIC = "הפעולה לא הושלמה. אפשר לנסות שוב, ואם זה חוזר כדאי לפנות לצוות המועדון.";
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
  }

  async function flushCommunityOutbox() {
    if (!window.HaimuniaOutbox || !client || !state.user) return;
    // Security hunt (2026-09-11): userId here is what lets flush() refuse to
    // send a row that was queued under a different member's session - see
    // src/outbox.js's own flush() comment.
    const result = await window.HaimuniaOutbox.flush({ userId: state.user.id });
    if (result && (result.sent || result.failed)) {
      await refreshOutboxState();
      // A queued post/comment/cheer that has now landed should appear.
      if (result.sent) { loadFeed(); }
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
    if (!state.posts.openShare[key]) return `<button data-community-action="toggle-share" data-type="${esc(type)}" data-id="${esc(id)}" aria-label="שיתוף לקהילה" style="color:var(--steel);padding:4px;">📤</button>`;
    return `<div class="flex items-center gap-6" style="flex-wrap:wrap;">
      ${isModuleEnabled("post_photos") ? `<input type="file" id="photo-${esc(id)}" accept="image/jpeg,image/png,image/webp" class="file-input-hidden"/>
      <label class="chip-btn" for="photo-${esc(id)}" style="cursor:pointer;padding:5px 9px;font-size:11px;">📷</label>` : ""}
      <button class="chip-btn" data-community-action="publish" data-type="${esc(type)}" data-id="${esc(id)}" data-visibility="followers" style="padding:5px 9px;font-size:11px;">לעוקבים</button>
      <button class="chip-btn primary" data-community-action="publish" data-type="${esc(type)}" data-id="${esc(id)}" data-visibility="public" style="padding:5px 9px;font-size:11px;">לכולם</button>
      <button class="link-btn" data-community-action="toggle-share" data-type="${esc(type)}" data-id="${esc(id)}" aria-label="ביטול שיתוף" style="padding:5px;">✕</button>
    </div>`;
  };
  // Renders directly under the post whose "השוואה" button was tapped
  // (see feed rendering below) instead of in one spot at the top of the
  // whole feed - tapping compare on a post scrolled far down used to
  // produce a result the viewer had to scroll back up to find, with no
  // visual link back to which post triggered it. A second tap on the
  // same post's button closes it again.
  async function compare(comparisonKey, postId) {
    if (state.posts.comparisonForPostId === postId) { state.posts.comparisonForPostId = null; state.posts.comparison = []; return rerender(); }
    if (!comparisonKey) return;
    const { data, error } = await client.from("community_feed").select("id,handle,display_name,result_text,score_value,score_direction,occurred_on").eq("comparison_key", comparisonKey).limit(50);
    state.posts.comparison = error ? [] : (data || []).sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
    state.posts.comparisonForPostId = postId;
    setMessage(error ? "השוואת התוצאות נכשלה" : "");
  }
  async function requestDeletion() {
    if (!state.user) return;
    const { error } = await client.rpc("request_account_deletion");
    if (error) return setMessage(failText("בקשת המחיקה נכשלה", error));
    await client.auth.signOut();
  }
  // COMM-014. Every realtime channel is scoped to the sub-tab that
  // opened it, so leaving that sub-tab closes all of them here rather
  // than in each feature. COMM-209 and COMM-227 are the first tickets
  // with live channels behind this call: the challenge detail's two
  // filtered channels, the feed's two shared ones, and the own-row
  // notification channel all close here and re-arm from
  // afterRenderCommunity() if the new tab still wants them.
  function setCommunityTab(tab) {
    if (state.ui.tab !== tab) {
      // COMM-209. The challenge detail belongs to the view that opened it.
      // Leaving that view closes it, so its two channels stay closed after
      // the teardown below instead of being re-armed by the next render
      // for a dialog nobody can see behind the new tab.
      state.challenges.view = null;
      if (window.HaimuniaRealtime) window.HaimuniaRealtime.teardownAll();
      // Both flags describe channels that no longer exist. Clearing them
      // is what lets the arm points above open a fresh channel instead of
      // trusting a stale "already subscribed" memory.
      state.challenges._rtId = null;
      state.notif._rtUid = null;
      clearRealtimeDebounces();
    }
    // COMM-114: "flushed once per feed session, or on view change, whichever
    // comes first". Leaving the Feed sub-tab is a view change.
    if (state.ui.tab !== tab) flushFeedImpressions();
    state.ui.tab = tab;
    rerender();
  }
  // Where the four retired sub-tab ids land now. The operator-depth rework
  // collapsed Manage's seven sub-tabs into three (see renderManageApp), and
  // these are the four whose id no longer names a tab. They are kept as
  // aliases rather than deleted because setManageTab() is reachable from
  // outside this file's own markup - a cross-tab jump, a stale render, or a
  // caller written against the old ids - and silently landing on the first
  // tab because the lookup missed is worse than landing where the content
  // actually went.
  const MANAGE_TAB_ALIASES = Object.freeze({
    dashboard: "members",   // the health score and the club's own numbers
    onboarding: "moderation",
    settings: "moderation",
    analytics: "moderation",
  });
  // The Manage tab's own sub-tab switch. No realtime teardown and no feed-
  // impression flush like setCommunityTab above - none of Manage's sub-tabs
  // opens a realtime channel or a feed session, so there is nothing to tear
  // down when moving between them.
  //
  // scrollTo is the second half of the collapse: with five former sub-tabs
  // now stacked inside one "ניהול" tab, a control that only switched the tab
  // would drop a manager at the top of a long page and leave them to hunt.
  // Every caller that knows which SECTION it means names it, and
  // afterRenderManage() scrolls there once the new markup exists.
  function setManageTab(tab, scrollTo) {
    state.ui.manageTab = MANAGE_TAB_ALIASES[tab] || tab;
    state.ui.manageScrollTo = String(scrollTo || "");
    // Load the restrictions panel's data when its screen is actually opened,
    // not only at boot. The boot path runs once, BEFORE permissions can
    // change - a moderator who signs in afterwards, or whose role is granted
    // during the session, would otherwise see an empty panel forever with no
    // way to tell it apart from "nobody is restricted". loadRestrictions()
    // carries its own in-flight flag, so reopening the tab cannot stack reads.
    if (state.ui.manageTab === "moderation") loadRestrictions();
    rerender();
  }

  // COMM-170. One club_tab_viewed per entry into a sub-tab, never one per
  // render. afterRenderCommunity() runs on every re-render of the Community
  // tab - a reaction, a comment, a photo URL resolving - so the sub-tab
  // that was last counted is remembered and a repeat render of the same one
  // records nothing. Leaving the Community tab clears that memory (the
  // capture-phase listener further down), so coming back counts as a new
  // view, which is the honest reading of "viewed" and the only signal
  // cloud.js can see without app.js telling it which top-level tab is up.
  let lastClubTabView = null;
  // The announcements and monthly_recap modules' own once-per-entry guards.
  // Both surfaces render INLINE - an announcement archive and a published
  // month's figures are on the screen, never opened - so there is no open to
  // hook and the view is the only honest thing to record. They ride
  // lastClubTabView's own lifecycle rather than a loader's: leaving the
  // Community tab ends the visit, coming back is a new one, and a re-render
  // in between (a follow toggling, a realtime comment arriving) records
  // nothing.
  let announcementsViewLogged = false;
  let monthlyRecapViewLogged = false;
  // COMM-233. Where the member came from when they land on the roster. Set
  // by the one control that routes there from somewhere else (COMM-232's
  // "find people" call to action on the leaderboard), consumed by the next
  // directory view and reset, so a later plain tab tap is not still
  // attributed to it.
  let directoryEntrySource = "club_tab";
  function resetClubTabView() { lastClubTabView = null; announcementsViewLogged = false; monthlyRecapViewLogged = false; }
  // The announcements module's one event. Recorded from afterRenderCommunity
  // for the same reason noteClubTabView and noteClassmatesCardView are: that
  // hook is the only place cloud.js learns the archive is actually in the
  // document rather than merely fetched. It never fires for an empty archive
  // - renderAnnouncementsArchive emits the marker only on its non-empty
  // branch - so "how often were there club notices to read" and "how often
  // did somebody see them" are the same number by construction.
  //
  // `rows` is a count and `source` says which of the two identical renders it
  // was (the member feed, or the desktop staff home). Never a title: an
  // announcement is club-authored text, and this table is not where text
  // goes.
  //
  // NOT a WCAM event. The WCAM definition in docs/community/metrics.md lists
  // "opened an announcement" among the qualifying acts; that clause still has
  // no producer and this is not it, because nothing in this app opens an
  // announcement. Recorded here so the next reader does not assume otherwise.
  function noteAnnouncementsView() {
    if (announcementsViewLogged) return;
    if (!state.user || !state.profile) return;
    const el = document.querySelector('[data-announcements-archive="ready"]');
    if (!el) return;
    announcementsViewLogged = true;
    track(A.ANNOUNCEMENT_VIEWED, {
      rows: Math.max(0, Number(el.getAttribute("data-announcements-rows")) || 0),
      source: el.getAttribute("data-announcements-source") || "feed",
    });
  }
  // The monthly_recap module's one event, same hook and same shape. The
  // member-facing card renders only once a month has actually been published
  // (renderMonthlyRecapMemberSection returns "" otherwise), so this cannot
  // fire on an empty month, and the staff DRAFT preview carries no marker at
  // all - a coach checking a draft is not a member reading the recap, and
  // folding the two together would make the number unreadable.
  function noteMonthlyRecapView() {
    if (monthlyRecapViewLogged) return;
    if (!state.user || !state.profile) return;
    if (!document.querySelector("[data-monthly-recap-section]")) return;
    monthlyRecapViewLogged = true;
    track(A.MONTHLY_RECAP_VIEWED, { source: "account" });
  }
  function noteClubTabView() {
    if (!state.user || !state.profile) return;
    const tab = state.ui.tab || "feed";
    if (lastClubTabView === tab) return;
    lastClubTabView = tab;
    track(A.CLUB_TAB_VIEWED, { tab });
    // The feed and the boards are surfaces in their own right, measured
    // separately from the tab that happens to contain them. Two different
    // event names on one action is not double counting.
    if (tab === "feed") track(A.FEED_VIEWED, { scope: state.feed.scope, source: "club_tab" });
    if (tab === "boards") {
      // Only when there is one. An empty board is not a challenge view.
      if (state.club.weeklyChallenge) {
        track(A.CHALLENGE_VIEWED, { challenge_id: null, challenge_key: state.club.weeklyChallenge.comparisonKey || null, source: "boards" });
      }
      track(A.LEADERBOARD_VIEWED, { board: "weekly_challenge", rows: (state.club.weeklyLeaderboard || []).length, source: "boards" });
    }
    // COMM-233. The roster is a surface in its own right, measured
    // separately from the sub-tab that contains it, the same way the feed
    // and the boards already are. It rides this same once-per-entry guard,
    // so the directory's own re-renders (a page of members arriving, a
    // follow toggling) record nothing.
    if (tab === "directory") {
      track(A.DIRECTORY_OPENED, { source: directoryEntrySource });
      directoryEntrySource = "club_tab";
    }
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
  function personDisplayName(p) {
    if (!p) return "";
    return p.display_name || (p.handle ? "@" + p.handle : "");
  }
  // One lookup for every surface that can open a confirmation about a person,
  // keyed by id so it cannot return a different member than the row clicked.
  // Ordered admin-first: the member-management search and the roster are the
  // lists these dialogs are actually opened from, and they carry the freshest
  // role column too (subjectRecordFor is what tells "downgrade" from "grant").
  function subjectRecordFor(userId) {
    if (!userId) return null;
    const lists = [
      state.members.results,
      state.admin.roster.items,
      state.members.people,
      state.members.directory.items,
      state.members.suggestions.items,
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((p) => p && (p.id === userId || p.user_id === userId));
      if (hit) return hit;
    }
    const pv = state.members.profileView;
    if (pv && pv.userId === userId && pv.data) return pv.data;
    return null;
  }
  // Feed authors are the other entry point (the post menu's "block"), and
  // there the name lives on the post rather than on a profile row.
  function subjectNameFor(userId) {
    const name = personDisplayName(subjectRecordFor(userId));
    if (name) return name;
    if (userId && Array.isArray(state.feed.items)) {
      const post = state.feed.items.find((p) => p && p.author_id === userId);
      if (post) { const n = postAuthorName(post); if (n) return n; }
    }
    return "";
  }
  // The challenge's own title, for the two confirmations that name it. Both
  // the list and the open detail can be the source: archiving from the
  // detail toolbar is the common case, but the list is the only source once
  // a card gains its own control, and a dialog that says "{subject}" with an
  // empty subject is the failure subjectSentenceHtml() exists to prevent.
  function challengeTitleFor(id) {
    const v = state.challenges.view;
    if (v && v.id === id && v.challenge && v.challenge.title) return v.challenge.title;
    const row = (state.challenges.items || []).find((c) => c && c.id === id);
    return (row && row.title) || "";
  }
  // Shared by renderConfirmSheet() and renderModActionSheet(): the same
  // sentence-with-a-name rendering, so the two dialogs cannot drift into
  // naming their subject two different ways.
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
    else if (c.action === "delete-post") deletePost(c.payload.postId);
    else if (c.action === "publish") publishWorkout(c.payload.type, c.payload.id, c.payload.visibility, c.payload.file);
    else if (c.action === "publish-club-wod") doPublishClubWod(c.payload.wod);
    else if (c.action === "admin-grant-coach") adminGrantCoach(c.payload.userId);
    // Defect 1: revoking used to fire straight off the click handler, with no
    // dialog at all, while GRANTING the same permission asked first. The
    // destructive direction now runs from here like every other one.
    else if (c.action === "admin-revoke-coach") adminRevokeCoach(c.payload.userId);
    else if (c.action === "admin-set-role") adminSetRole(c.payload.userId, c.payload.role);
    else if (c.action === "admin-remove-member") adminRemoveMember(c.payload.userId);
    else if (c.action === "challenge-archive") archiveChallenge(c.payload.id);
    else if (c.action === "challenge-delete") deleteChallenge(c.payload.id, c.payload.draft);
    else if (c.action === "admin-reset-password") adminResetPassword(c.payload.userId);
    else if (c.action === "admin-invite-revoke") revokeInvite(c.payload.inviteId);
    else if (c.action === "post-delete-rpc") postDeleteViaMenu(c.payload.postId);
    else if (c.action === "delete-comment") deleteComment(c.payload.commentId, c.payload.postId);
    else if (c.action === "composer-discard") closeComposer();
    else if (c.action === "leave-challenge") leaveChallenge(c.payload.challengeId);
    else if (c.action === "challenge-team-delete-confirm") deleteChallengeTeam(c.payload.teamId);
    else if (c.action === "event-cancel") cancelEvent(c.payload.eventId);
    else if (c.action === "club-wod-cancel") cancelClubWodSession(c.payload.sessionId);
    else rerender();
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
  // ==========================================================================
  // Five-persona UX audit, defect 2. <input type="date"> in a Hebrew RTL app.
  //
  // A native date control renders its segments in the BROWSER/OS locale, not
  // the document's - Chromium on an en-US profile paints mm/dd/yyyy no matter
  // what dir or lang the page declares. The beginner persona typed
  // 01/06/2026 meaning 1 June; the app stored 6 January.
  //
  // THE VALUE IS NOT THE BUG. type="date" always submits ISO yyyy-mm-dd and
  // always round-trips correctly - there is nothing wrong with what gets
  // stored, only with what the member reads while typing it. That makes this
  // a DISAMBIGUATION problem, not a parsing one, and it is what decides the
  // shape of the fix below.
  //
  // TWO THINGS THIS DELIBERATELY DOES NOT DO:
  //
  //  1. It does not hand-roll a date picker. Six native inputs swapped for
  //     custom widgets is a far larger regression surface - keyboard entry,
  //     mobile pickers, form validation, min/max, RTL, screen readers - than
  //     a display ambiguity justifies. The audit says so outright, and a
  //     custom widget would have to solve this exact same question anyway.
  //
  //  2. It does not print a literal "dd/mm/yyyy" order hint, even though the
  //     finding offers that as an option. We cannot read back the order the
  //     browser chose to paint, so such a hint is a claim about the control
  //     that is WRONG for precisely the member this finding is about: the one
  //     whose field is showing mm/dd/yyyy. Telling her "dd/mm/yyyy" next to a
  //     control that is doing the opposite trades one wrong belief for
  //     another. Asserting nothing about the order beats asserting it wrongly.
  //
  // What it does instead is echo the value back in words - "1 ביוני 2026" -
  // which is unambiguous under every locale the control might be rendering
  // in, and which the member can check against what she meant. Before a date
  // exists the same line says the echo is coming, so the slot is never an
  // empty frame that reads as broken (the same rule §2 applies to empty
  // states).
  const HEB_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
  const DATE_ECHO_PENDING_TEXT = "אחרי הבחירה יופיע כאן התאריך במילים, לבדיקה.";
  // Parsed off the ISO string with a regex, NEVER through `new Date(value)`.
  // `new Date("2026-06-01")` is specified to parse as UTC midnight and then
  // reads back in local time: in Israel that is still 1 June, but the echo
  // whose entire job is to be unambiguous must not itself be a function of
  // the device's timezone. There is no Date object anywhere in this path.
  function hebrewDateEchoText(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!m) return DATE_ECHO_PENDING_TEXT;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return DATE_ECHO_PENDING_TEXT;
    return `התאריך שנבחר: ${day} ב${HEB_MONTHS[month - 1]} ${Number(m[1])}`;
  }
  // ==========================================================================
  // The same defect, in <input type="datetime-local">. Four of them: the
  // announcement expiry and the event form's start/end/registration-deadline.
  //
  // They were deliberately left out of the type="date" pass, and the reason
  // given was a good one: "a datetime echo raises timezone questions the
  // date-only echo doesn't, and getting that wrong would be a new correctness
  // bug." That was right to pause on. It is answered here rather than
  // inherited, because the pause was about a question, and the question has
  // an answer.
  //
  // FIRST, THE DEFECT IS STRICTLY WORSE HERE, NOT MERELY EQUAL. A
  // datetime-local control paints BOTH halves in the browser/OS locale. An
  // en-US profile renders `06/01/2026, 06:00 PM`, which carries the original
  // dd/mm ambiguity AND a second one the date fields never had: a 12-hour
  // clock with an AM/PM segment, in an app whose members read and write 24h.
  // A coach who means 18:00 and types 6 into an hour segment she reads as
  // 24-hour schedules the event for six in the morning. So the case for an
  // echo is stronger here, not weaker.
  //
  // NOW THE TIMEZONE QUESTION, WHICH IS THE WHOLE OF WHY THIS WAS DEFERRED.
  //
  // The worry is real: an event at 18:00 means 18:00 at the box, and
  // datetime-local's value is deliberately zone-less, so an echo that names
  // the wrong zone would be a new false statement rather than a fix. What
  // saves this is that the echo does NOT have to know where the box is. It
  // only has to state which clock the app itself reads the number against,
  // and that is a fact about this file, verified at both ends:
  //
  //   WRITE. submitEventForm does `new Date(startAt).toISOString()` and
  //   submitAnnouncement does `new Date(expiresAtRaw)`. A date-time string
  //   with no offset is specified to parse in the runtime's LOCAL zone, so
  //   the instant that reaches the server is the typed wall-clock read
  //   against the composing device's clock.
  //
  //   READ. eventLocalParts() rebuilds the control's value with
  //   getFullYear/getHours/getMinutes - local getters - so what is painted
  //   back is the stored instant on the VIEWING device's clock.
  //
  // Both ends agree, so "לפי שעון המכשיר" is true of this code, not a guess
  // about geography. For the overwhelming case - a device set to Israel time
  // - the device clock IS the box clock, and the clause costs that member
  // nothing. For the coach scheduling from abroad, whose device clock is NOT
  // the box's, it is exactly the sentence that stops her storing the wrong
  // instant, which is the correctness bug the deferral was worried about and
  // which shipping nothing left in place.
  //
  // What the echo therefore refuses to say is "שעון ישראל". That would be
  // the same class of error the date pass refused when it declined to print
  // "dd/mm/yyyy": an assertion about something we cannot read back, wrong for
  // precisely the member the finding is about.
  //
  // MECHANISM UNCHANGED, and this matters as much as the wording. Parsed by
  // regex off the ISO-shaped value, never `new Date()`. The echo restates the
  // member's own digits and derives no instant, so it cannot itself shift
  // under a device timezone - which is what lets it be the stable reference
  // the member checks the control against. Seconds are optional in the
  // grammar (a `step` under 60 makes Chromium emit them) and are dropped from
  // the echo: nothing in this app schedules to the second.
  const DATETIME_ECHO_PENDING_TEXT = "אחרי הבחירה יופיעו כאן התאריך והשעה במילים, לבדיקה.";
  function hebrewDateTimeEchoText(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ""));
    if (!m) return DATETIME_ECHO_PENDING_TEXT;
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return DATETIME_ECHO_PENDING_TEXT;
    if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return DATETIME_ECHO_PENDING_TEXT;
    // m[4]/m[5] rather than the Numbers: the zero-padded 24-hour pair is the
    // half that disambiguates 06:00 from 6:00 PM, so it is printed exactly as
    // the value holds it.
    return `המועד שנבחר: ${day} ב${HEB_MONTHS[month - 1]} ${Number(m[1])}, בשעה ${m[4]}:${m[5]} לפי שעון המכשיר`;
  }
  // field() plus the echo line, for the six type="date" inputs in this file.
  // Not folded into field() itself: every other control it renders is a
  // text, number, select or textarea with no locale ambiguity to resolve.
  //
  // The echo is rendered INSIDE the <label class="field">, not after it, for
  // two concrete layout reasons. `.field + .field{margin-top:10px}` keys off
  // adjacency, so a sibling div between two fields silently kills the second
  // one's top margin; and the weekly-challenge setter puts its two date
  // fields in a `.flex.gap-16` row where `.flex:not(.col) > .field{flex:1}`
  // makes every direct child a column - an echo appended there would have
  // become a third column between them.
  //
  // BIDI, which this codebase has been bitten by twice. The echo is a Hebrew
  // month name sitting between two Latin-digit runs inside an RTL paragraph -
  // exactly the mixed-script shape bidiText's own header describes. The <bdi>
  // is emitted ONCE here and the live patch below writes textContent INTO it,
  // never around it, so the isolation survives every update and no markup is
  // ever built from a value at patch time.
  function dateField(formId, name, labelText, inputHtml) {
    return echoField(formId, name, labelText, inputHtml, false);
  }
  // The datetime-local sibling. Same element, same attributes, same live
  // patch - only the formatter differs, which is why this is one shared
  // builder rather than a second near-copy that could drift the way the
  // eleven empty states did.
  function dateTimeField(formId, name, labelText, inputHtml) {
    return echoField(formId, name, labelText, inputHtml, true);
  }
  function echoField(formId, name, labelText, inputHtml, withTime) {
    const echoId = `date-echo-${formId}-${name}`;
    const value = /\svalue="([^"]*)"/.exec(inputHtml);
    // data-date-echo-time is what updateDateEcho() branches on. Deliberately
    // a dataset flag rather than a read of `input.type`: jsdom does not
    // reflect an unsupported input type, so a type-sniffing branch would
    // silently take the date-only path under the very harness these fields
    // are verified in.
    const tagged = inputHtml.replace(/^<input/, `<input data-date-echo="${esc(echoId)}"${withTime ? ` data-date-echo-time="1"` : ""}`);
    // aria-live rather than aria-describedby: field() rewrites the input's
    // aria-describedby to point at the error span whenever there is a field
    // error, so a describedby set here would either be duplicated or lost
    // depending on validation state. The line is inside the label, so it is
    // part of the control's accessible name and is read on focus; aria-live
    // covers the case where it changes while focus is already in the field.
    const echoText = withTime ? hebrewDateTimeEchoText(value ? value[1] : "") : hebrewDateEchoText(value ? value[1] : "");
    const echo = `<span class="footer-note" data-date-echo-line="${esc(name)}" style="display:block;margin:5px 0 0;font-size:11.5px;line-height:1.5;" aria-live="polite"><bdi id="${esc(echoId)}">${esc(echoText)}</bdi></span>`;
    return field(formId, name, labelText, tagged + echo);
  }
  // Patched straight into the DOM, never through rerender(): re-rendering a
  // focused native date control mid-entry costs it the segment the caret is
  // in, which is the same reason the member-of-the-week counter and the
  // coach note drafts are DOM-patched rather than re-rendered.
  //
  // textContent, not innerHTML - cloud.js keeps zero innerHTML sinks and
  // test/app-innerhtml-sinks.test.mjs enforces it.
  function updateDateEcho(input) {
    if (!input || !input.dataset) return;
    const el = document.getElementById(input.dataset.dateEcho);
    if (!el) return;
    el.textContent = ("dateEchoTime" in input.dataset) ? hebrewDateTimeEchoText(input.value) : hebrewDateEchoText(input.value);
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
  function sectionHead(color, title, adminTag) {
    return `<div class="ach-section-head"><span class="ach-section-dot" style="background:${color};"></span><h2 class="ach-section-title">${title}</h2>${adminTag ? `<span class="admin-tag">ניהול</span>` : ""}</div>`;
  }
  // ==========================================================================
  // Five-persona UX audit, defect 1. Empty states.
  //
  // The designer's four-slot pattern (design spec §2.1), factored into one
  // helper so the eleven call sites below cannot drift apart the way the bare
  // one-liners did:
  //
  //   1. icon         28px, var(--steel). Never red, never a warning glyph -
  //                   absence is not an error (spec §2.1 tone rule 2).
  //   2. headline     15px/700 var(--chalk). Says what WILL be here, present
  //                   or future tense. May not OPEN with אין / עדיין לא /
  //                   מעולם לא, and never names what is missing (tone rule 1).
  //   3. explanation  13px var(--steel), one line at 390px. Says what the
  //                   space is built FROM - the app's own best habit, the one
  //                   the leaderboard-provenance and invite-explainer lines
  //                   the spec holds up as exemplars already practise.
  //   4. action       a real >=44px primary button that genuinely fills this
  //                   state - OR, where no such button exists, a `when` line
  //                   naming what will fill it and when. Never both, and
  //                   never a button that goes nowhere: inventing a dead
  //                   button is worse than shipping none, and the judgement
  //                   about which of the two a given state gets is recorded
  //                   at each call site rather than here.
  //
  // The pattern already shipped for the error branches and for
  // renderIncompleteSignups(); this is that same shape, extracted, and that
  // function's own good instinct - "this is the GOOD outcome and it should
  // read like one" - is why two of the states below open positively rather
  // than apologetically.
  //
  // WHY THE max-width, i.e. the half of this finding that only reproduces at
  // desktop width. `.empty` (index.html:358) is text-align:center with no
  // width bound. That is fine in a 390px phone column. Centred in the 940px
  // staff column it lays one short sentence across the middle of ~900px of
  // nothing, with no icon, no block edge and nothing under it - which is
  // precisely why a coach reads it as a pane that failed to load rather than
  // as a calm "nothing here yet". 34ch holds every string below to two lines
  // at 390px and stops the block stretching at 940px.
  const EMPTY_STATE_ICONS = {
    // Deliberately local to this file rather than reaching for app.js's
    // ICONS: cloud.js is loaded BEFORE app.js (index.html:1591 vs 1596), and
    // while a top-level `const` in a classic script is readable across
    // scripts by the time any of this renders, borrowing it would couple the
    // community module's empty states to a table another file owns and
    // another agent is editing. Five glyphs, drawn to match ICONS' existing
    // 24-box / 1.8-weight / round-cap language so they read as the same set.
    trophy: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v6a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v1a4 4 0 0 0 3 3.9M17 6h3v1a4 4 0 0 1-3 3.9"/><path d="M12 15v3M9 21h6M10.5 18h3"/></svg>',
    people: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.6 3-6.2 6.5-6.2s6.5 2.6 6.5 6.2"/><circle cx="17.5" cy="9.5" r="2.3"/><path d="M17 14.2c2.7.2 4.6 2.2 5 5"/></svg>',
    star: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z"/></svg>',
    // The "everyone is fine" glyph. A check inside a circle, NOT a warning
    // triangle or an exclamation: renderCoachEngageSection's empty state is
    // good news about the club, and tone rule 2 forbids dressing it as a
    // fault.
    check: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/></svg>',
    chart: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17V11M12 17V5M20 17v-4"/><path d="M3 20.5h18"/></svg>',
  };
  // `opts.attr` is a raw attribute string and is therefore only ever passed a
  // LITERAL from this file - it exists solely so renderCommunityHealthScore()
  // can keep the data-community-health-empty hook COMM-312's own tests pin.
  // Nothing derived from server data or member input goes near it; everything
  // that does (headline, body, when, action label) goes through bidiText/esc
  // below without exception.
  function emptyStateHtml(opts) {
    const o = opts || {};
    const icon = EMPTY_STATE_ICONS[o.icon] || EMPTY_STATE_ICONS.chart;
    const slot4 = o.action
      ? `<div class="chip-row" style="justify-content:center;margin-top:2px;"><button class="chip-btn primary" data-community-action="${esc(o.action)}" style="min-height:44px;">${esc(o.actionLabel || "")}</button></div>`
      : o.when
      ? `<div style="font-size:12.5px;color:var(--steel);line-height:1.6;max-width:34ch;">${bidiText(o.when)}</div>`
      : "";
    return `<div class="empty" data-empty-state="${esc(o.key || "")}"${o.attr ? ` ${o.attr}` : ""} style="padding:32px 20px;display:flex;flex-direction:column;align-items:center;gap:10px;">
      <span aria-hidden="true" style="display:inline-flex;color:var(--steel);">${icon}</span>
      <div style="max-width:34ch;display:flex;flex-direction:column;gap:6px;">
        <div style="font-size:15px;font-weight:700;color:var(--chalk);line-height:1.5;">${bidiText(o.headline)}</div>
        <div style="font-size:13px;color:var(--steel);line-height:1.6;">${bidiText(o.body)}</div>
      </div>
      ${slot4}
    </div>`;
  }

  // ==========================================================================
  // COMM-101..108, COMM-180  posts cluster.
  // Structured post_type cards, the composer, the per-post action menu, the PR
  // share prompt, and the member profile community section. Everything here is
  // card RENDER and post COMPOSE only. Feed ranking and pagination (COMM-110),
  // reaction and comment internals (COMM-120..125), the achievement engine
  // (COMM-130..134) and notifications are owned elsewhere and only consumed.
  // The card markup contract for feed and engagement is in
  // docs/community/contracts.md, "Client card contract (renderPostCard)".
  // ==========================================================================

  window.renderPostCardSkeleton = renderPostCardSkeleton;

  // ---- COMM-221 weekly recap surface + share ---------------------------
  // Reachable from (a) the weekly_recap notification's deep link
  // (resolveNotifTarget below) and (b) the "View Week" entry point in the
  // Account tab. weekStart === null means "the member's most recent
  // available week"; the notification always supplies an explicit one.
  // RLS is what actually enforces "only my own recaps" - weekly_recaps has
  // an own-row select policy and nothing else, so there is nothing for a
  // client-side check to add here beyond that enforced boundary.
  async function openRecap(weekStart, source) {
    if (!state.user || !client) return;
    // COMM-233. Recorded at the moment of the open, before the row is
    // fetched, for the same reason profile_opened is: the member asked to
    // see their week whether or not the read behind it answers. Which week,
    // and what was in it, is not a prop - the recap row itself is the
    // record of that, and the figures are the member's own numbers.
    track(A.WEEKLY_RECAP_OPENED, { source: source || "account" });
    state.recaps.view = { weekStart: weekStart || null, loading: true, error: false, row: null, olderWeekStart: null, newerWeekStart: null, sharing: null };
    rerender();
    await refreshRecapView(weekStart || null);
  }
  function closeRecapView() { state.recaps.view = null; rerender(); }
  // weekStart === null asks for the most recent row; otherwise a specific
  // ISO week. Either way, once the row is known, the two adjacent-week
  // existence checks (COMM-221: "past weeks are browsable") run off its
  // real week_start, not the possibly-null argument this call started
  // with.
  async function refreshRecapView(weekStart) {
    const v = state.recaps.view;
    if (!v) return;
    v.loading = true; v.error = false; rerender();
    let row = null, err = null;
    if (weekStart) {
      const res = await client.from("weekly_recaps").select("*").eq("user_id", state.user.id).eq("week_start", weekStart).maybeSingle();
      row = res.data; err = res.error;
    } else {
      const res = await client.from("weekly_recaps").select("*").eq("user_id", state.user.id).order("week_start", { ascending: false });
      err = res.error;
      row = (!err && Array.isArray(res.data) && res.data.length) ? res.data[0] : null;
    }
    if (!state.recaps.view || state.recaps.view !== v) return; // closed/reopened mid-flight
    if (err) { v.loading = false; v.error = true; return rerender(); }
    v.row = row;
    v.weekStart = row ? row.week_start : weekStart;
    v.olderWeekStart = null; v.newerWeekStart = null;
    if (row) {
      const [olderRes, newerRes] = await Promise.all([
        client.from("weekly_recaps").select("week_start").eq("user_id", state.user.id).lt("week_start", row.week_start).order("week_start", { ascending: false }),
        client.from("weekly_recaps").select("week_start").eq("user_id", state.user.id).gt("week_start", row.week_start).order("week_start", { ascending: true }),
      ]);
      if (!state.recaps.view || state.recaps.view !== v) return;
      v.olderWeekStart = (!olderRes.error && olderRes.data && olderRes.data[0]) ? olderRes.data[0].week_start : null;
      v.newerWeekStart = (!newerRes.error && newerRes.data && newerRes.data[0]) ? newerRes.data[0].week_start : null;
    }
    v.loading = false;
    rerender();
  }
  function recapGoOlder() { const v = state.recaps.view; if (v && v.olderWeekStart) refreshRecapView(v.olderWeekStart); }
  function recapGoNewer() { const v = state.recaps.view; if (v && v.newerWeekStart) refreshRecapView(v.newerWeekStart); }
  function recapWeekRangeLabel(weekStart) {
    if (!weekStart) return "";
    const start = new Date(weekStart + "T00:00:00Z");
    const end = new Date(start.getTime() + 6 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return `${fmt(start)} – ${fmt(end)}`;
  }
  // "Pick one figure" (COMM-221) - a small, fixed set of true, already-
  // generated figures from this exact row, never anything invented on the
  // client. Sessions and streak are always offered; a PR or an
  // achievement is only offered when the week actually produced one.
  function recapShareOptions(row) {
    const opts = [
      { key: "sessions", label: "מספר האימונים", body: `התאמנתי ${row.sessions_completed} פעם${row.sessions_completed === 1 ? "" : "ים"} השבוע! 💪` },
      { key: "streak", label: "רצף האימונים", body: `הרצף שלי עומד על ${row.streak} ${row.streak === 1 ? "יום" : "ימים"} ברצף! 🔥` },
    ];
    if (Array.isArray(row.prs) && row.prs.length) {
      const pr = row.prs[0];
      opts.push({ key: "pr", label: "שיא חדש", body: `שיא חדש השבוע${pr.movement ? " ב" + pr.movement : ""}${pr.result ? ": " + pr.result : ""}! 🏆` });
    }
    if (Array.isArray(row.achievements) && row.achievements.length) {
      const ach = row.achievements[0];
      opts.push({ key: "achievement", label: "הישג חדש", body: `פתחתי השבוע הישג חדש: ${ach.title || ""}${ach.badge_icon ? " " + ach.badge_icon : ""}`.trim() });
    }
    return opts;
  }
  async function shareRecapFigure(key) {
    const v = state.recaps.view;
    if (!v || !v.row || v.sharing) return;
    const opt = recapShareOptions(v.row).find((o) => o.key === key);
    if (!opt) return;
    v.sharing = key; rerender();
    // post_create itself enforces the 1000-char cap and the post rate
    // limit (COMM-221) - every generated figure body here is a short,
    // fixed template, well under the cap either way.
    const { data, error } = await client.rpc("post_create", { body: opt.body, visibility: "club", media: [], links: null });
    v.sharing = null;
    if (error || !data) { setMessage("שיתוף הסיכום נכשל, אפשר לנסות שוב"); return rerender(); }
    setMessage("הסיכום שותף לקהילה");
    // COMM-233. After the write, like every other write-backed event: a
    // failed share is not a share. `figure` is the option key, one of a
    // fixed four - never the generated sentence, which carries the member's
    // own PR movement and achievement title. post_created rides the bus off
    // the same action; two names for one action is not double counting.
    track(A.WEEKLY_RECAP_SHARED, { figure: key, post_id: data });
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_TEXT" }); } catch (e) {}
    }
    rerender();
  }
  function renderRecapBody(v) {
    const row = v.row;
    const isQuiet = Number(row.sessions_completed) === 0 && Number(row.streak) === 0
      && !(Array.isArray(row.prs) && row.prs.length) && !(Array.isArray(row.achievements) && row.achievements.length);
    const quietNote = isQuiet ? `<div class="empty">שבוע שקט - בלי אימונים שנרשמו. השבוע הבא הוא הזדמנות חדשה.</div>` : "";
    const prsHtml = Array.isArray(row.prs) && row.prs.length
      ? `<div class="log-list">${row.prs.map((pr) => `<div class="log-row"><span>${esc(pr.movement)}</span><span class="mono" style="color:var(--brass);">${esc(pr.result)}</span></div>`).join("")}</div>`
      : `<div class="empty">אין שיאים חדשים השבוע</div>`;
    const achHtml = Array.isArray(row.achievements) && row.achievements.length
      ? `<div class="log-list">${row.achievements.map((a) => `<div class="log-row"><span>${esc(a.badge_icon || "🏅")} ${esc(a.title)}</span></div>`).join("")}</div>`
      : `<div class="empty">אין הישגים חדשים השבוע</div>`;
    const challengeHtml = Array.isArray(row.challenge_progress) && row.challenge_progress.length
      ? `<div class="log-list">${row.challenge_progress.map((c) => `<div class="log-row"><span>${bidiText(c.title)}</span><span class="mono" style="color:var(--brass);">${esc(c.progress)}${c.target != null ? ` / ${esc(c.target)}` : ""}</span></div>`).join("")}</div>`
      : `<div class="empty">לא נרשמה השתתפות באתגר השבוע</div>`;
    // COMM-316 (closing COMM-P06). weekly_recaps.classmates is up to 5
    // {user_id, display_name, handle, avatar_url} objects, already fully
    // privacy-gated server-side by recap_weekly_classmates() (both this
    // row's own show_attendance AND each named candidate's) - nothing here
    // re-filters or re-sorts, the same "render in the order returned"
    // discipline classmateRowHtml() uses for attendance_classmates_today().
    // A recap is an own-row surface (weekly_recaps' only RLS policy is
    // own-row SELECT), which is exactly why naming individuals is safe HERE
    // and never in the club-wide monthly recap (COMM-309).
    //
    // QUIET-WEEK CHOICE, this ticket's own call: an empty array renders a
    // message rather than being omitted. Every other section in this
    // function (PRs, achievements, challenge progress, the upcoming event)
    // already renders an `.empty` line instead of disappearing when there
    // is nothing to show, and a recap that is browsed week to week (COMM-
    // 221's prev/next) would otherwise look inconsistent - some weeks with
    // six labelled sections, some with five and no visible reason why.
    const classmatesList = Array.isArray(row.classmates) ? row.classmates : [];
    const classmatesHtml = classmatesList.length
      ? `<div data-recap-classmates="ready">${classmatesList.map((m) => {
          const name = m.display_name || (m.handle ? "@" + m.handle : "חבר/ה");
          return `<button class="link-btn" data-community-action="view-profile" data-id="${esc(m.user_id)}" style="padding:0;color:inherit;font-weight:700;text-decoration:underline;">${esc(name)}</button>`;
        }).join(", ")} ${classmatesList.length === 1 ? "התאמן/ה" : "התאמנו"} איתכם השבוע.</div>`
      : `<div class="empty" data-recap-classmates="empty">אין חברים משותפים השבוע</div>`;
    const club = row.club_challenge_progress && row.club_challenge_progress.title
      ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">${esc(row.club_challenge_progress.title)}</div><div class="mono" style="color:var(--brass);">${esc(row.club_challenge_progress.total)}${row.club_challenge_progress.target != null ? ` / ${esc(row.club_challenge_progress.target)}` : ""}</div>${row.club_challenge_progress.participants != null ? `<div style="color:var(--steel);font-size:12px;">${participantsLabel(row.club_challenge_progress.participants)}</div>` : ""}</div>`
      : "";
    const event = row.upcoming_event
      ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">האירוע הקרוב</div><button class="link-btn" data-community-action="open-event" data-id="${esc(row.upcoming_event.id)}" data-source="recap" style="padding:0;text-align:right;display:block;">${esc(row.upcoming_event.title)}</button>${row.upcoming_event.start_at ? `<div style="color:var(--steel);font-size:12px;">${esc(formatChallengeDate(row.upcoming_event.start_at))}</div>` : ""}</div>`
      : `<div class="empty">אין אירוע קרוב לציין</div>`;
    const shareOptions = recapShareOptions(row);
    const shareHtml = `<h3 class="field-label" style="margin:10px 0 4px;">שיתוף הסיכום</h3><div class="chip-row" style="flex-wrap:wrap;">${shareOptions.map((o) => `<button class="chip-btn" data-community-action="share-recap" data-figure="${o.key}"${v.sharing === o.key ? " disabled" : ""}>${v.sharing === o.key ? "משתף…" : "שיתוף " + esc(o.label)}</button>`).join("")}</div>`;
    return `${quietNote}
      <div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">אימונים השבוע</div><div class="mono" style="color:var(--brass);font-size:18px;">${esc(row.sessions_completed)}</div></div>
      <div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">רצף נוכחי</div><div class="mono" style="color:var(--brass);font-size:18px;">🔥 ${esc(row.streak)}</div></div>
      <h3 class="field-label" style="margin:10px 0 4px;">שיאים</h3>${prsHtml}
      <h3 class="field-label" style="margin:10px 0 4px;">הישגים</h3>${achHtml}
      <h3 class="field-label" style="margin:10px 0 4px;">ההתקדמות שלי באתגר</h3>${challengeHtml}
      <h3 class="field-label" style="margin:10px 0 4px;">מי עוד התאמן איתכם השבוע</h3>${classmatesHtml}
      ${club}
      ${event}
      ${shareHtml}`;
  }
  function renderRecapViewOverlay() {
    const v = state.recaps.view;
    if (!v) return "";
    const weekLabel = v.weekStart ? recapWeekRangeLabel(v.weekStart) : "";
    // COMM-221 frontend states: empty ("אין עדיין סיכום שבועי"), loading
    // skeleton, error ("לא ניתן היה לטעון את הסיכום השבועי. נסו שוב."),
    // populated (renderRecapBody, including the quiet-week variant it
    // renders inline off the same row).
    const bodyHtml = v.loading ? `<div class="log-list" aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : v.error ? `<div class="empty">לא ניתן היה לטעון את הסיכום השבועי. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="recap-retry">ניסיון חוזר</button></div></div>`
      : !v.row ? `<div class="empty">אין עדיין סיכום שבועי.</div>`
      : renderRecapBody(v);
    const nav = (v.row && !v.loading && !v.error) ? `<div class="chip-row" style="margin-bottom:10px;">
        <button class="chip-btn" data-community-action="recap-older"${v.olderWeekStart ? "" : " disabled"}>שבוע קודם</button>
        <button class="chip-btn" data-community-action="recap-newer"${v.newerWeekStart ? "" : " disabled"}>שבוע הבא</button>
      </div>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="recapViewTitle" data-cloud-dialog="recapView" style="align-items:center;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="recapViewTitle" style="margin-top:0;font-weight:800;font-size:17px;margin-bottom:0;">${weekLabel ? "סיכום השבוע · " + esc(weekLabel) : "סיכום שבועי"}</h2>
            <button class="chip-btn" data-community-action="close-recap-view" aria-label="סגירה">✕</button>
          </div>
          ${nav}
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // ---- Achievement engine client wiring + unlock celebration ----------
  // COMM-130/131/134. The offline app detects non-attendance milestones
  // (session count, week streak, PR count, first Rx, tenure) and hands the
  // crossed codes to claimCommunityAchievements(). That records them with the
  // ach_claim RPC (service-role ach_evaluate is unreachable from the browser
  // and never fires for a privately logged lift), then announces each row it
  // actually wrote on the product bus. onAchievementUnlocked() turns that
  // into a small in-app celebration with an optional share through ach_share.
  // Nothing here ever auto-posts.

  // --- COMM-209 / COMM-227 realtime wiring ---------------------------
  // Every channel below is opened through HaimuniaRealtime (COMM-014), never
  // by reaching past it to the raw client, so setCommunityTab's single
  // teardownAll() closes all of them on a view change. Each handler
  // re-fetches through the surface's existing load path instead of applying
  // the payload row: the payload is one raw table row with no profile join,
  // no block filtering and no server-side aggregation, so applying it
  // directly would render a different (and sometimes wrong) view than a
  // manual refresh of the same screen. Re-fetching keeps exactly one
  // rendering path per surface.
  //
  // Every re-fetch is debounced, so a burst of rows (a coach entering ten
  // members' progress, a post getting twenty reactions) costs one query,
  // not one per row.
  const REALTIME_DEBOUNCE_MS = 400;
  const realtimeTimers = {};
  function realtimeDebounce(key, fn, wait) {
    if (realtimeTimers[key]) clearTimeout(realtimeTimers[key]);
    realtimeTimers[key] = setTimeout(function () {
      delete realtimeTimers[key];
      try { fn(); } catch (err) { console.error("[realtime] refresh failed for " + key, err); }
    }, wait == null ? REALTIME_DEBOUNCE_MS : wait);
  }
  // Teardown has to cancel pending refreshes too. A timer that survives a
  // view change would fire a query against a screen nobody is looking at,
  // which is the same leak the channel registry exists to prevent.
  function clearRealtimeDebounces() {
    for (const key of Object.keys(realtimeTimers)) { clearTimeout(realtimeTimers[key]); delete realtimeTimers[key]; }
  }
  function realtimeChannelOpen(name) {
    if (!window.HaimuniaRealtime || typeof window.HaimuniaRealtime.list !== "function") return false;
    return window.HaimuniaRealtime.list().some((ch) => ch.name === name);
  }

  // COMM-209. Two channels per open challenge detail, both filtered to that
  // challenge id (postgres_changes supports eq filters, and a detail screen
  // is one id), well under MAX_SUBSCRIPTIONS = 10. Closing the detail or
  // opening a different one closes the previous pair.
  function challengeRealtimeNames(id) { return ["chal-progress-" + id, "chal-participants-" + id]; }
  function ensureChallengeRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    const openId = state.challenges.view && state.challenges.view.id;
    if (state.challenges._rtId && state.challenges._rtId !== openId) {
      for (const name of challengeRealtimeNames(state.challenges._rtId)) window.HaimuniaRealtime.unsubscribe(name);
      state.challenges._rtId = null;
    }
    if (!openId) return;
    const [progressName, participantsName] = challengeRealtimeNames(openId);
    // Re-arm after teardownAll() the same way the notification channel
    // does: the registry, not a local flag, is the source of truth for
    // whether a channel is actually open.
    if (state.challenges._rtId === openId && realtimeChannelOpen(progressName) && realtimeChannelOpen(participantsName)) return;
    window.HaimuniaRealtime.subscribe(progressName,
      { table: "challenge_progress", event: "INSERT", filter: "challenge_id=eq." + openId },
      function () { onChallengeRealtime(openId); });
    // Launch-readiness audit item 3. This used to filter to UPDATE only, so
    // another member joining or leaving this challenge (an INSERT or DELETE
    // on challenge_participants) while this detail was open never triggered
    // a live refresh - the participant list/count went stale until the
    // viewer closed and reopened the dialog. src/realtime.js's bind()
    // already defaults `event` to "*" (the postgres_changes wildcard
    // covering INSERT/UPDATE/DELETE in one binding on one channel) whenever
    // no event is passed - the same shape the feed's shared reactions
    // channel already relies on (see the "*" `event` COMM-227's
    // feed-reactions binding uses) - so this only has to stop passing
    // "UPDATE" rather than add a second subscribe call per event.
    window.HaimuniaRealtime.subscribe(participantsName,
      { table: "challenge_participants", filter: "challenge_id=eq." + openId },
      function () { onChallengeRealtime(openId); });
    state.challenges._rtId = openId;
  }
  function onChallengeRealtime(id) {
    realtimeDebounce("chal-" + id, function () {
      // The detail may have closed between the event and this timer.
      if (!state.challenges.view || state.challenges.view.id !== id) return;
      // chal_progress() is the server's aggregation; re-reading it is what
      // keeps the bar and the leaderboard equal to what a refresh shows,
      // rather than a client-side sum of deltas that drifts.
      refreshChallengeView(id);
    });
  }

  // COMM-227. Two shared channels per feed session, not one per card:
  // postgres_changes filters only support eq, and a feed page is twenty
  // posts, so twenty filtered channels would blow the ten-channel cap.
  // Incoming rows are filtered here against what is actually rendered.
  //
  // Re-checked for a 200-user launch: a server-side `filter` on club_id
  // was considered and rejected, not overlooked. Neither table carries a
  // club_id column (reactions/post_comments only have post_id, user_id,
  // kind/body, created_at), and this product is one club by deliberate
  // decision (docs/community/backlog.md, "Club model... approved. Keep
  // club_id, one club row, no multi-tenant") - every one of the 200 users
  // is in the same club, so a club-level filter would not reduce fanout at
  // all even if the column existed. There is no column on either table
  // that both exists and would narrow broadcast without recreating the
  // per-post-channel problem this comment already rejected. The real lever
  // here is confirming the actual Supabase plan's realtime message-volume
  // and concurrent-connection limits against real usage, not a code change -
  // see 2026-09-05 launch-readiness audit.
  function ensureFeedRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    if (state.ui.tab !== "feed") return;
    if (!realtimeChannelOpen("feed-comments")) {
      window.HaimuniaRealtime.subscribe("feed-comments", { table: "post_comments", event: "INSERT" }, onFeedCommentRealtime);
    }
    if (!realtimeChannelOpen("feed-reactions")) {
      window.HaimuniaRealtime.subscribe("feed-reactions", { table: "reactions", event: "*" }, onFeedReactionRealtime);
    }
  }
  // A postgres_changes payload carries `new` on INSERT/UPDATE and `old` on
  // DELETE; a reaction removal is a DELETE, so both are read here.
  function realtimePostId(payload) {
    const rec = payload && (payload.new || payload.record || payload.old || payload.old_record);
    const postId = rec && rec.post_id;
    return postId && findFeedPost(postId) ? postId : null;
  }
  function onFeedCommentRealtime(payload) {
    const postId = realtimePostId(payload);
    // Only a thread the member has open. A closed thread has nothing to
    // append to and re-fetching it would be a query nobody asked for.
    if (!postId || !state.engagement.openComments[postId]) return;
    realtimeDebounce("comments-" + postId, function () {
      if (!state.engagement.openComments[postId] || !findFeedPost(postId)) return;
      // loadCommentsFor() is the initial load path, so the new rows get the
      // same block-edge and moderation-status handling (and the same author
      // profile join and coach-role lookup) the first render applied.
      loadCommentsFor(postId);
    });
  }
  function onFeedReactionRealtime(payload) {
    const postId = realtimePostId(payload);
    if (!postId) return;
    realtimeDebounce("reactions-" + postId, function () {
      if (!findFeedPost(postId)) return;
      // A card whose strip was never loaded (no reactions yet) needs the
      // first load; one already loaded needs a re-read of the same query.
      if (state.engagement.reactions[postId]) loadReactionsFor(postId);
      else ensureReactionsLoaded(postId);
    });
  }

  // --- COMM-141 realtime own-row refresh ----------------------------
  function ensureNotifRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    const name = "notif-" + state.user.id;
    const listed = typeof window.HaimuniaRealtime.list === "function"
      ? window.HaimuniaRealtime.list().some((ch) => ch.name === name) : false;
    if (state.notif._rtUid === state.user.id && listed) return;
    window.HaimuniaRealtime.subscribe(name,
      { table: "notifications", event: "*", filter: "user_id=eq." + state.user.id },
      onNotifRealtime);
    state.notif._rtUid = state.user.id;
  }
  function onNotifRealtime(payload) {
    const evt = payload && (payload.eventType || payload.type);
    const rec = payload && (payload.new || payload.record);
    if (evt === "INSERT" && rec) {
      if (!rec.read_at) state.notif.unread = (Number(state.notif.unread) || 0) + 1;
      const c = state.notif.center;
      if (c && !c.rows.some((r) => r.id === rec.id)) { rec._wasUnread = !rec.read_at; c.rows.unshift(rec); }
      rerender();
      return;
    }
    // UPDATE or DELETE or an unknown shape: reconcile against the server.
    loadNotifUnread();
  }

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
    return renderClubWodBoardOverlay()
      + renderPostComposer() + renderPrSharePrompt() + renderAchievementUnlockCelebration() + renderCommunityProfileOverlay() + renderNotificationCenter()
      + renderReportSheet() + renderModActionSheet() + renderGhostReclaimSheet() + renderModContextOverlay() + renderChallengeViewOverlay() + renderEventViewOverlay() + renderRecapViewOverlay()
      // Third-to-last, for the same DOM-order/z-order reason as the two
      // below it: a `?` marker can sit inside a challenge, event or recap
      // overlay's own content, so the term sheet has to paint AFTER those or
      // it opens underneath the thing it is explaining.
      + renderTermSheet()
      // Second-to-last, immediately under the confirm sheet: the outward
      // share sheet is opened FROM the PR prompt and the achievement
      // celebration, so it stacks on top of them and must paint after them
      // for the same z-order reason renderConfirmSheet() paints last.
      + renderOutwardShareSheet()
      + renderConfirmSheet();
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
          <button class="chip-btn" data-community-action="term-close" aria-label="סגירה">✕</button>
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

  // ==========================================================================
  // The two Account-tab coach lists (202609060020).
  //
  // WHAT WAS WRONG, because it is not visible from the code that replaced it.
  // Both lists were one-liners built on `activity_pings`, whose only writer
  // anywhere in this app is pingActivity() above - today only, from a live
  // browser session. There is no trigger, no backfill and no server-side
  // producer, and 202609060002 states what a row in it means: one row per day
  // the member OPENED THE APP.
  //
  // Measured against a seeded, visibly active club - 41 posts, reactions,
  // comments, several members posting - the inactive list returned 8 of 8
  // members as never active, INCLUDING THE COACH WHO HAD POSTED MOMENTS
  // EARLIER, each rendered with the literal string "מעולם לא" ("never"). That
  // string was an assertion about a person manufactured out of an absence of
  // data, and it is the single reason this section could not be shown to a
  // club: software that is confidently wrong in front of staff is worse than
  // software that does nothing.
  //
  // Three rules the two functions below exist to hold, none of them optional:
  //
  //   1. NEVER present missing data as a finding. A member we have recorded
  //      nothing about ('no_data') and a member who was active and stopped
  //      ('lapsed') are different facts and must not render identically.
  //   2. NEVER claim the club is fine when the signal is empty. "No lapsed
  //      members" and "no data at all" are different answers.
  //   3. NEVER describe app activity as training. The label says what is
  //      actually measured, and names Arbox as where class attendance lives.
  //
  // Kept as separate functions rather than inline template literals so the
  // branching above is readable, and defined OUTSIDE renderCommunityApp() so
  // its staff-gate count (asserted at exactly 5 in community-coach-tier
  // .test.mjs) is unchanged - the two `staff ?` ternaries still live there
  // and now call these.

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
      // copy — "הכניסה עם קוד הזמנה שמקבלים מהמאמן/ת" and "הקוד לא נוגע
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
          <div style="color:var(--chalk);font-size:15px;line-height:1.5;margin-bottom:12px;">${bidiText("כאן רואים מה קורה במועדון: אימונים ושיאים של חברי המועדון, הודעות מהמאמנים ולוחות תוצאות.")}</div>
          <div style="color:var(--steel);font-size:14px;line-height:1.6;margin-bottom:18px;">${bidiText("הכניסה עם קוד הזמנה שמקבלים מהמאמן/ת. הקוד לא נוגע לרישום האימונים שלכם — הוא רק פותח את לשונית הקהילה.")}</div>
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
    if (!state.redemption) return `<div class="chart-card"><button class="gate-back" data-community-action="gate-back">‹ חזרה</button>${renderJoinProgress(0)}<div style="font-weight:800;font-size:18px;margin:0 0 6px;">קוד הזמנה למועדון</div><div style="color:var(--steel);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("הכניסה עם קוד הזמנה שמקבלים מהמאמן/ת. הקוד לא נוגע לרישום האימונים שלכם — הוא רק פותח את לשונית הקהילה.")}</div>${state.ui.inviteCodeDraft ? `<div class="footer-note" data-invite-prefilled="1" style="margin-bottom:10px;color:var(--brass);">${bidiText("הקוד מולא אוטומטית מהקישור שנסרק. אפשר להמשיך.")}</div>` : ""}<form id="communityInviteCode">${field("communityInviteCode", "code", "קוד הזמנה", `<input class="text-input" name="code" dir="ltr" inputmode="text" autocomplete="off" autocapitalize="off" maxlength="128" placeholder="קוד הזמנה" value="${esc(state.ui.inviteCodeDraft)}" data-invite-code required/>`)}<button class="save-btn" type="submit"${state.ui.redeemingCode ? " disabled" : ""} style="margin-top:12px;">${state.ui.redeemingCode ? "בודקים…" : "אישור קוד"}</button></form><div style="display:flex;justify-content:center;margin-top:16px;"><button class="gate-alt" data-community-action="back-to-login">כבר יש לכם חשבון? התחברות</button></div>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
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
    if (!state.profile && !hasSeenIntroCarousel()) return renderIntroCarousel();
    // Without this gate, a fresh code-redeemer landed straight on the Feed
    // sub-tab — mostly empty, nothing prompting them to the profile form
    // buried in Account — with no clear signal anything had actually been
    // saved. Now profile creation is unskippable, same pattern as the
    // gates above it: this screen is all there is until a profile exists,
    // and the whole screen changing to the real tabbed UI afterward is the
    // confirmation, not just a toast that's easy to miss.
    if (!state.profile) return `<div class="chart-card">${renderJoinProgress(3)}<div style="font-weight:800;font-size:18px;margin-bottom:6px;">השלמת פרופיל</div><div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:14px;">כמעט סיימתם — עוד רגע אחד ותהיו בפנים. ${CLUB_NAME_HINT_TEXT}</div><form id="communityProfile">${field("communityProfile", "displayName", CLUB_NAME_LABEL, `<input class="text-input" name="displayName" dir="auto" placeholder="למשל דנה כהן" required/>`)}<div class="footer-note" style="margin:-6px 0 12px;">${CLUB_NAME_HINT_TEXT}</div><label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי"></textarea></label><button class="save-btn" type="submit" style="margin-top:12px;">שמירת פרופיל</button></form>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
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
    const staff = isStaff();

    // ---- Feed tab: announcements (+ today's pinned note), the social
    // feed with comments, sharing, comparisons ----
    // COMM-218. Defensive mirror of announcements_read's expiry predicate -
    // see isAnnouncementExpired(). RLS is the real boundary; this only
    // keeps a long-open session from showing a since-expired row without a
    // refetch.
    const liveAnnouncements = state.club.announcements.filter((a) => !isAnnouncementExpired(a));
    const pinnedToday = liveAnnouncements.find((a) => a.pinned_date === todayIso());
    // data-announcement-id on both this card and each otherAnnouncements
    // row below is the scrollIntoView anchor a `target.announcement`
    // notification tap (navigateToNotifTarget) needs - the same pattern
    // data-post-id already gives the `target.post` branch. Without it, a
    // tap on an announcement notification switched to the Feed tab (via
    // setCommunityTab) and did nothing further.
    const pinnedHtml = pinnedToday ? `<div class="chart-card admin-card" data-announcement-id="${esc(pinnedToday.id)}" style="margin-bottom:12px;${announcementAccentStyle(pinnedToday)}"><div style="font-weight:800;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">📌 הערת האימון להיום${announcementPriorityBadge(pinnedToday)}</div><div style="font-weight:700;">${bidiText(pinnedToday.title)}</div><div style="color:var(--steel);font-size:13px;margin-top:4px;">${bidiText(pinnedToday.body)}</div></div>` : "";
    // COMM-321. announcements_read already empties liveAnnouncements above
    // once the module is off; the composer form has no data of its own to
    // fall silent through, so it needs its own explicit gate.
    const announceComposer = staff ? (!isModuleEnabled("announcements") ? "" : `<form id="communityAnnouncement" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">הודעה חדשה למועדון<span class="admin-tag">ניהול</span></div>${field("communityAnnouncement", "title", "כותרת", `<input class="text-input" name="title" placeholder="כותרת" required/>`)}${field("communityAnnouncement", "body", "תוכן", `<textarea class="text-input" name="body" maxlength="${POST_BODY_MAX}" placeholder="תוכן ההודעה" required></textarea>`)}<label class="field"><span class="field-label">רמת חשיבות</span><select class="text-input" name="priority">${ANNOUNCEMENT_PRIORITY_OPTIONS.map((o) => `<option value="${o.value}"${o.value === "normal" ? " selected" : ""}>${o.label}</option>`).join("")}</select></label>${dateTimeField("communityAnnouncement", "expiresAt", "תפוגה (אופציונלי)", `<input class="text-input" name="expiresAt" type="datetime-local" placeholder="ללא תפוגה"/>`)}<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="pinToday"/><span style="font-size:12.5px;color:var(--steel);">סמן כהערת האימון להיום</span></label><button class="chip-btn primary" type="submit"${state.club.announcementSaving ? " disabled" : ""} style="margin-top:10px;">${state.club.announcementSaving ? "מפרסם…" : "פרסום הודעה"}</button></form>`) : "";
    const otherAnnouncements = liveAnnouncements.filter((a) => a !== pinnedToday);
    // COMM-155. A staff holder of community.content.pin gets a pin toggle on
    // each announcement. Post, challenge and event pin affordances live on
    // their own surfaces (posts and Phase 2 clusters); the strip and unpin
    // control render for every one of the four target types.
    // Real device feedback ("the feed is getting too long"): this archive
    // used to render every live announcement in full (up to 20, the cap
    // announcements_read's own query carries) with no collapse - a club
    // that posts regularly turned "reference material below the feed"
    // into another long scroll. The most recent ANNOUNCEMENTS_ARCHIVE_
    // VISIBLE render as before; the rest sit behind the same <details>
    // disclosure renderAuditLog()'s "עוד סינונים" already uses, so nothing
    // is hidden, only de-prioritized past the first screenful.
    const announcementsList = renderAnnouncementsArchive(otherAnnouncements, !!pinnedToday, "feed");
    // ONE RAIL. pinnedHtml has moved OUT of this section and into the rail
    // above the feed, where it competes for a slot on merit like everything
    // else. What is left here is the archive: older announcements and the
    // staff composer, which are reference material rather than the thing a
    // member opened the app to see - so this section now renders BELOW the
    // feed instead of above it. See the rail construction further down.
    // No inline photo header here anymore (2026-09-08 immersive redesign):
    // the whole Community screen is now a full-bleed scene
    // (window.PAGE_SCENES.community), so a second decorative photo nested
    // inside this de-emphasized "reference material" section would be
    // redundant on top of it, not additive.
    const announcementsHtml = `<div class="ach-section">${sectionHead("var(--brass)", "הודעות מהמועדון")}${announcementsList}${announceComposer}</div>`;

    // Sharing itself no longer lives here - it was a standing list of the
    // 8 most recent shareable results eating vertical space at the top of
    // the feed you open to see *other* people's posts. It's now
    // triggered from wherever a specific result actually lives (Calendar,
    // Progress) via renderShareControl(), collapsed to a single icon
    // until tapped.

    // COMM-115. The club strip: mark, name, member count, the active
    // challenge shortcut and the notification bell. Every value comes from
    // club_summary(); a failed read degrades to the compose button alone,
    // which is why this whole block is behind `state.club.row`.
    const club = state.club.row || null;
    const clubMark = club && club.image_url
      ? `<img src="${esc(club.image_url)}" alt="" style="width:44px;height:44px;border-radius:14px;object-fit:cover;"/>`
      : avatarHtml((club && club.name) || "המועדון", 44);
    // club_summary() returns whichever challenge is active, from either of two
    // sources: a real Phase 2 `challenges` row (source "challenge") or, as the
    // fallback that actually fires today, a weekly_challenges row (source
    // "weekly"). Both used to render the same bright orange hero button, and
    // both were wrong in their own way:
    //
    //  - A weekly one is not a `challenges` row, so tapping it sent
    //    openChallenge() after an id that table does not have. It 400'd and
    //    showed the member nothing at all.
    //  - A weekly one whose comparison key is malformed can never match a
    //    single post, so the club home advertised a challenge as its
    //    front-page call to action while the Boards tab - the place you would
    //    go to join it - said "אין אתגר פעיל כרגע". A coach's typo became the
    //    club's headline.
    //
    // So the hero renders only for something a member can actually open and
    // actually join: a real challenge row, or a weekly one that passed
    // activeWeeklyChallenge()'s validity check.
    const summaryChallenge = club && club.active_challenge ? club.active_challenge : null;
    const weeklyHero = summaryChallenge && summaryChallenge.source === "weekly";
    const activeChallenge = !summaryChallenge ? null
      : weeklyHero ? (activeWeeklyChallenge() ? summaryChallenge : null)
      : summaryChallenge;
    const clubTopHtml = club ? `<div class="chart-card" id="communityClubTop" style="margin-bottom:12px;">
      <div class="flex" style="justify-content:space-between;align-items:center;gap:10px;">
        <div class="flex gap-10" style="align-items:center;min-width:0;">
          ${clubMark}
          <div style="min-width:0;">
            <div style="font-weight:800;font-size:16px;">${bidiText(club.name || "המועדון")}</div>
            <div style="color:var(--steel);font-size:12px;">${clubMembersLabel(club.member_count)}</div>
          </div>
        </div>
        ${renderNotificationBell()}
      </div>
      ${activeChallenge ? `<div class="chip-row" style="margin-top:10px;"><button class="chip-btn primary" data-community-action="open-active-challenge"${weeklyHero ? "" : ` data-id="${esc(activeChallenge.id || "")}"`}>🏆 ${bidiText(activeChallenge.title || "אתגר פעיל")}</button></div>` : ""}
    </div>` : "";
    // COMM-217: the soonest published, non-cancelled upcoming event, or
    // nothing at all - never an empty placeholder.
    const upcomingEventHtml = renderUpcomingEventCard();
    // COMM-307: who else logged a session today, or - far more often -
    // nothing at all. Same chart-card shell and same "renders nothing"
    // omission style as the upcoming-event card above; it sits ABOVE the feed
    // list rather than beside that card because it is a post-class moment
    // ("right after logging a session, a member sees who else trained today")
    // and a moment buried under twenty ranked posts is not a moment.
    // renderClassmatesTodayCard() is the only thing that decides whether it
    // exists, so there is no branch here.
    const classmatesTodayHtml = renderClassmatesTodayCard();

    const clubWodTodayHtml = renderClubWodTodayStrip();

    // ---- ONE RAIL (see railInterleave) ----
    // Priority order, and the reasoning for it:
    //   1. onboarding - a member who has not finished joining cannot use any
    //      of the rest, so it outranks everything while it exists at all.
    //   2. the pinned note - a coach deliberately marked ONE thing as today's
    //      note. That is the strongest signal on the screen and the only one
    //      a human explicitly chose.
    //   3. today's programming - what the box is doing today, the question
    //      most members open the app to answer.
    //   4. the upcoming event - time-sensitive, and useless once it passes.
    //   5. who else trained today - a post-class moment, valuable but only to
    //      the member who just logged.
    //   6. other pinned targets - staff bookkeeping, lowest claim on a member's
    //      first screen.
    // Only the first two with content render above the feed; the rest are
    // interleaved a few posts in rather than dropped.
    const clubRail = [
      renderOnboardingStep(),
      pinnedHtml,
      clubWodTodayHtml,
      upcomingEventHtml,
      classmatesTodayHtml,
      renderPinnedStrip(pinnedToday && pinnedToday.id),
    ].filter(Boolean);
    const railAbove = clubRail.slice(0, RAIL_ABOVE_FEED).join("");
    const railRest = clubRail.slice(RAIL_ABOVE_FEED);

    // The club header stays first and alone: it is identity and the bell, not
    // content, and it is the one thing that should never compete for a slot.
    // Announcements are now the ARCHIVE and sit below the feed.
    // COMM-111 filter chips. Every chip here is now selectable - the parked
    // "השיעורים שלי" chip was removed (see FEED_SCOPES). setFeedScope still
    // refuses a `parked` scope on the way in; nothing sets that flag today,
    // and the guard stays for a future one. The real protection against a
    // scope this client no longer offers is feedScopeDef(), which falls back
    // to for_you for any id it does not know - so a crafted data-scope can
    // never put an unknown scope on the wire.
    // Launch-readiness audit, A5 (axe, aria-required-children - CRITICAL).
    // The PARKED chips were plain <button aria-disabled>, with no role="tab",
    // while the live ones had it. A role="tablist" whose children are not all
    // tabs is a broken ARIA structure: assistive tech is told "this is a set
    // of tabs" and then handed something that is not one, so the whole set
    // can be mis-announced or skipped. A disabled tab is still a tab -
    // aria-disabled is the right way to say "not selectable yet", not
    // dropping the role.
    // No parked branch any more: every chip in FEED_SCOPES is a scope a member
    // can actually select. The aria-required-children fix that branch carried
    // (a role="tablist" whose children were not all tabs) is moot now that
    // there is nothing disabled left to render, but the note above stays as
    // the reason the live chips each carry role="tab".
    const filterHtml = `<div class="chip-row" id="communityFeedFilters" role="tablist" aria-label="סינון הפיד" style="margin:0 0 10px;">${FEED_SCOPES.map((s) => `<button class="chip-btn${state.feed.scope === s.id ? " selected" : ""}" id="feedScope-${s.id}" data-community-action="feed-scope" data-scope="${s.id}" role="tab" aria-controls="communityFeedPanel" aria-selected="${state.feed.scope === s.id ? "true" : "false"}" tabindex="${state.feed.scope === s.id ? "0" : "-1"}">${esc(s.label)}</button>`).join("")}</div>`;

    const feed = state.feed.loading && !state.feed.items.length
      ? `<div class="log-list" aria-busy="true">${renderPostCardSkeleton().repeat(3)}</div>`
      : state.feed.error && !state.feed.items.length
      ? `<div class="empty">לא ניתן לטעון את פיד המועדון.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="feed-retry">ניסיון חוזר</button></div></div>`
      : state.feed.items.length ? `<div class="log-list" id="communityFeedList">${railInterleave(state.feed.items.map((post) => post && post.post_type ? renderPostCard(post) : `<article class="chart-card post-card">
      <div class="post-head">${avatarHtml(post.display_name || post.handle, 36, (post.author && post.author.avatar_url) || post.avatar_url)}<div class="post-head-text"><div class="post-author">${nameHtml(post.display_name, post.handle)}</div><div class="post-time">${relativeTime(post.published_at)}</div></div></div>
      <div class="post-title">${bidiText(post.title)}</div>
      <div class="mono post-result">${esc(post.result_text)}</div>
      ${post.photo_path && signedCacheGet(photoUrlCache, post.photo_path) ? `<img src="${signedCacheGet(photoUrlCache, post.photo_path)}" alt="" class="post-photo" onerror="window.__haimuniaEvictSignedUrl&&window.__haimuniaEvictSignedUrl('photo',this.dataset.k)" data-k="${esc(post.photo_path)}"/>` : ""}
      <div class="chip-row post-actions">
        <button class="chip-btn" data-community-action="cheer" data-id="${esc(post.id)}" aria-label="עידוד, ${Number(post.cheer_count || 0)} עידודים">🔥 ${Number(post.cheer_count || 0)}</button>
        ${isModuleEnabled("comments") ? `<button class="chip-btn" data-community-action="toggle-comments" data-id="${esc(post.id)}" aria-label="תגובות, ${Number(post.comment_count || 0)}">💬 ${Number(post.comment_count || 0)}</button>` : ""}
        ${post.comparison_key ? `<button class="chip-btn${state.posts.comparisonForPostId === post.id ? " selected" : ""}" data-community-action="compare" data-key="${esc(post.comparison_key)}" data-id="${esc(post.id)}">השוואה</button>` : ""}
        ${post.author_id === (state.user && state.user.id) ? `<button class="chip-btn" data-community-action="delete-post" data-id="${esc(post.id)}">הסרה</button>` : `<button class="chip-btn" data-community-action="report" data-id="${esc(post.id)}">דיווח</button>`}
      </div>
      ${state.posts.comparisonForPostId === post.id ? `<div class="log-list" style="margin-top:10px;">${state.posts.comparison.length ? state.posts.comparison.map((item, index) => `<div class="log-row"><span>${index + 1}. ${nameHtml(item.display_name, item.handle)}</span><span class="mono" style="color:var(--brass);">${esc(item.result_text)}</span></div>`).join("") : `<div class="empty">אין עדיין תוצאות להשוואה</div>`}</div>` : ""}
      ${renderComments(post)}</article>`), railRest)}</div>` : `${emptyStateHtml({ key: "feed-empty", icon: "people", headline: "עדיין אין כאן פעילות", body: feedScopeDef(state.feed.scope).empty || "פעילות המועדון תופיע כאן." })}${railRest.join("")}`;
    // COMM-113. The sentinel is what IntersectionObserver watches; the
    // button under it is the same call for keyboard and for anywhere the
    // observer is unavailable. Reaching the end is a quiet marker, never an
    // error.
    const feedMoreHtml = !state.feed.items.length ? ""
      : state.feed.end ? `<div class="footer-note" style="text-align:center;margin-top:10px;">הגעתם לסוף. הכול מעודכן.</div>`
      : `<div id="communityFeedSentinel" style="height:1px;"></div>
        ${state.feed.moreError ? `<div class="footer-note" role="alert" style="text-align:center;color:var(--red-text);">לא ניתן היה לטעון עוד.</div>` : ""}
        <div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="feed-load-more"${state.feed.loadingMore ? " disabled" : ""}>${state.feed.loadingMore ? "טוען…" : state.feed.moreError ? "ניסיון חוזר" : "טעינת עוד"}</button></div>`;
    // Feed polish pass. Was a plain .chip-btn reading "כתיבת פוסט" - the
    // same weight as "טעינת עוד" below the feed, easy to miss as the one
    // thing on this screen that starts something rather than continues it.
    // Now the standard "fake input row" every social feed uses for the same
    // tap target: the member's own avatar (avatarHtml, same helper every
    // other identity in this file uses - no new photo-loading path) beside
    // a greyed placeholder that reads like an unfilled text field. Same
    // data-action, so open-composer's own handler is untouched.
    const composeBtn = `<button class="post-composer-trigger" data-community-action="open-composer">
      ${avatarHtml(selfDisplayName(), 40, state.profile && state.profile.avatar_url)}
      <span class="post-composer-trigger-text">${esc(POST_COMPOSER_PLACEHOLDER)}</span>
    </button>`;
    // classmatesTodayHtml and upcomingEventHtml are no longer concatenated
    // here. Both are now rail cards. The event card in particular used to
    // render AFTER ${feed} - the one time-sensitive item on the screen sat
    // underneath an infinite list, so a member who kept scrolling passed it
    // and a member who did not never saw it at all.
    // Launch-readiness audit follow-up (COMM-329). The scope chips were
    // already declared role="tab" inside a role="tablist", but there was no
    // element for them to control: the list they swap is rendered under three
    // different ids depending on state (loading / error / items), and the
    // empty state has no container of its own at all. One stable wrapper is
    // what completes the pattern - a plain block div inside a plain block
    // .ach-section, so nothing about the layout moves.
    const feedPanel = `<div id="communityFeedPanel" role="tabpanel" aria-labelledby="feedScope-${state.feed.scope}">${feed}${feedMoreHtml}</div>`;
    const feedHtml = `<div class="ach-section">${sectionHead("var(--blue)", "הפיד שלי")}${composeBtn}${filterHtml}${feedPanel}</div>`;

    // COMM-155. The pinned strip sits above everything else on the Club home.
    // 202609080002. Directly under the club header and ABOVE the feed list:
    // "what is the box doing today" is the first thing a member opens the app
    // for, and it is the one card that is worth reading at zero member
    // contributions. Same renders-nothing-when-empty style as the upcoming
    // event and classmates-today cards, with the one deliberate exception
    // renderClubWodTodayStrip() documents.
    const feedTab = clubTopHtml + railAbove + feedHtml + announcementsHtml;

    // ---- Boards tab: weekly challenge + streaks, top-3-plus-your-rank ----
    const challengeSetter = staff ? `<form id="communityWeeklyChallenge" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">קביעת אתגר שבועי<span class="admin-tag">ניהול</span></div>${field("communityWeeklyChallenge", "title", "שם האתגר", `<input class="text-input" name="title" placeholder="שם האתגר" required/>`)}${field("communityWeeklyChallenge", "comparisonKey", "על מה מתחרים", renderChallengeKeyPicker())}<div style="color:var(--steel);font-size:11px;margin:-6px 0 10px;">רק תרגילים ואימונים שקיימים באפליקציה — כך התוצאות שחברי המועדון משתפים נספרות לאתגר מעצמן.</div><div class="flex gap-16 field">${dateField("communityWeeklyChallenge", "startsOn", "תאריך התחלה", `<input class="text-input" name="startsOn" type="date" required/>`)}${dateField("communityWeeklyChallenge", "endsOn", "תאריך סיום", `<input class="text-input" name="endsOn" type="date" required/>`)}</div><button class="chip-btn primary" type="submit" style="margin-top:10px;">קביעת אתגר</button></form>` : "";
    // Three states, not two. state.club.weeklyChallenge comes from the
    // leaderboard VIEW, which is empty until someone posts a matching result,
    // so treating "no rows" as "no challenge" told every member there was
    // nothing on while the club home was advertising a hero button for it.
    // activeWeeklyChallenge() answers the question the heading is actually
    // asking - is a challenge running - and the ranked list answers the
    // separate one, who is on it yet.
    const runningChallenge = activeWeeklyChallenge();
    const weeklyLeaderboardList = state.club.weeklyChallenge
      ? renderRankedList(state.club.weeklyLeaderboard, (it) => it.author_id, (it) => esc(it.result_text))
      : runningChallenge
        ? `<div class="empty">האתגר פתוח ועדיין אין תוצאות. תוצאה שתשתפו מהאימון תיכנס לטבלה מעצמה.</div>`
        : `<div class="empty">אין אתגר פעיל כרגע</div>`;
    // COMM-018. A quick "hide my result" affordance right on the board.
    // It flips in_leaderboards, the same column the Privacy panel toggles;
    // full removal from the ranked views is enforced server-side once the
    // leaderboard views filter on the column (see report notes).
    const hideMyResult = state.profile && state.profile.in_leaderboards
      ? `<button class="link-btn" data-community-action="hide-my-leaderboard-result" style="display:block;margin:8px auto 0;">הסתרת התוצאה שלי מהטבלאות</button>`
      : (state.profile ? `<div class="footer-note" style="margin:8px 0 0;">התוצאה שלך מוסתרת מהטבלאות. אפשר להחזיר אותה בהגדרות הפרטיות.</div>` : "");
    // A coach who typo'd a key before this shipped still has that challenge
    // sitting active in the table, invisible to everyone. Staff - and only
    // staff - get told why their challenge is not on any screen, since they
    // are the only ones who can fix it by setting a new one.
    const brokenChallenge = staff && state.club.weeklyChallengeRow && !weeklyChallengeIsValid(state.club.weeklyChallengeRow) ? state.club.weeklyChallengeRow : null;
    const brokenChallengeNote = brokenChallenge
      ? `<div class="footer-note" style="margin:0 0 10px;color:var(--brass);">האתגר „${bidiText(brokenChallenge.title || "")}" לא מוצג לחברי המועדון: הוא מצביע על ${bidiText(brokenChallenge.comparisonKey || "")}, שלא קיים באפליקציה, ולכן אף תוצאה לא יכולה להיספר אליו. קבעו אתגר חדש מהרשימה למטה.</div>`
      : "";
    const weeklyChallengeHtml = `<div class="ach-section">${sectionHead("var(--teal)", state.club.weeklyChallenge ? `אתגר השבוע: ${bidiText(state.club.weeklyChallenge.title)}` : "אתגר השבוע")}${brokenChallengeNote}${weeklyLeaderboardList}${hideMyResult}${challengeSetter}</div>`;

    // COMM-210/212. The consistency board, server-ranked through
    // feed_leaderboard, replaces the old community_streaks strip that used to
    // sit here (see renderConsistencyLeaderboardSection for why).
    const streaksHtml = renderConsistencyLeaderboardSection();

    // Redesign, Phase 2: the mockup's own empty state for this tab -
    // challenges, events and leaderboards are the three modules that can go
    // fully dark here (each already self-gates and returns "" above), and
    // when all three are off there is otherwise nothing on the page
    // explaining why. Placed above weeklyChallengeHtml rather than
    // replacing it: the legacy weekly-challenge board (state.club.weeklyChallenge)
    // predates and is independent of the Phase-2 club_features module set
    // and always renders something (a live challenge or "אין אתגר פעיל
    // כרגע"), so this tab is never truly blank the way the mockup's
    // simpler 3-module model assumes - the note supplements it rather than
    // standing in for a genuinely empty tab.
    const boardsAllOffHtml = (!isModuleEnabled("challenges") && !isModuleEnabled("events") && !isModuleEnabled("leaderboards"))
      ? `<div class="chart-card" data-boards-all-off="1">כל המודולים בלוח זה כבויים כרגע. הפעילו אותם ב"ניהול › הגדרות".</div>`
      : "";
    const boardsTab = boardsAllOffHtml + renderChallengesListSection() + renderEventsListSection() + weeklyChallengeHtml + streaksHtml;

    // ---- Account tab: profile, member search, admin member management ----
    // COMM-318. Uploading/failed states mirror the composer photo-attach
    // flow's own state machine and error copy - not a new pattern.
    const au = state.avatarUpload;
    const avatarBusy = au.status === "processing";
    const avatarControl = `<div class="flex gap-10" style="align-items:center;margin-bottom:14px;">
      ${avatarHtml(p.display_name || p.handle, 56, p.avatar_url)}
      <div class="flex gap-6" style="align-items:center;flex-wrap:wrap;">
        <label class="chip-btn" style="cursor:pointer;display:inline-block;${avatarBusy ? "opacity:.6;pointer-events:none;" : ""}">${avatarBusy ? "מעלה…" : "העלאת תמונה"}<input type="file" accept="image/*" data-avatar-file class="file-input-hidden"${avatarBusy ? " disabled" : ""}/></label>
        ${p.avatar_url ? `<button class="chip-btn" type="button" data-community-action="avatar-remove"${avatarBusy ? " disabled" : ""}>הסרת תמונה</button>` : ""}
      </div>
    </div>
    ${au.error ? `<div class="field-error" role="alert" style="margin-bottom:10px;">${esc(au.error)}</div>` : ""}`;
    const account = `<form id="communityProfile" class="chart-card"><div style="font-weight:800;font-size:16px;margin-bottom:12px;">הפרופיל שלי</div>
      ${avatarControl}
      ${field("communityProfile", "displayName", CLUB_NAME_LABEL, `<input class="text-input" name="displayName" dir="auto" value="${esc(p.display_name || "")}" placeholder="למשל דנה כהן" required/>`)}
      <div class="footer-note" style="margin:-6px 0 12px;">${CLUB_NAME_HINT_TEXT}</div>
      <label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי">${esc(p.bio || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn primary" type="submit">שמירת פרופיל</button><button class="chip-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button></div>
    </form>`;

    // COMM-018 Privacy panel. Values render straight off state.profile;
    // each toggle change is persisted by savePrivacyField() as a direct
    // own-row RLS upsert (listener wired in afterRenderCommunity). The
    // skeleton branch is a formality - the gates above guarantee a loaded
    // profile before this tab renders.
    const privacyRows = state.profile
      ? PRIVACY_FIELDS.map((f) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;"><span style="font-size:13px;">${f.label}</span><input type="checkbox" data-privacy-field="${f.key}"${state.profile[f.key] ? " checked" : ""} aria-label="${esc(f.label)}"/></label>`).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:62%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    // The id is the scroll anchor for open-privacy-settings - the club WOD
    // board's "your result is hidden from the club" hint LINKS here rather
    // than offering to flip show_workout_results, which is the only correct
    // affordance for a toggle that must stay the member's own decision.
    const privacyPanel = `<div class="ach-section" id="communityPrivacyPanel" style="margin-top:18px;">${sectionHead("var(--blue)", "פרטיות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">כל שינוי נשמר מיד ונאכף בשרת. הגדרות הנוכחות והרישום לשיעור ייכנסו לתוקף כשמודול הנוכחות יעלה.</div>
      <div class="log-list">${privacyRows}</div>
    </div>`;
    // Live bug hunt (2026-09-11): unblock()'s own client surface - see its
    // comment above. Renders nothing at all when the member hasn't blocked
    // anyone (the common case), same "additive, not a permanent empty
    // section" shape monthlyRecapEntry just below already uses.
    const blockedMembersPanel = renderBlockedMembersPanel();

    // Design spec section 3.5 — the one explicit switch over the `?` markers.
    //
    // The markers already auto-retire after three sheets have been opened, so
    // this is NOT the primary control; it is the escape hatch for the member
    // the counter gets wrong in either direction. An expert who wants them
    // gone on day one, and a returning beginner who wants them back months
    // after the counter retired them, both need a way to say so, and neither
    // can be served by a counter.
    //
    // It lives on the community Account tab rather than app.js's Settings
    // sheet for the plain reason that app.js is not this pass's to edit — the
    // switch is per-device localStorage either way, so moving it later is a
    // markup change with no data migration. Spec 3.5 asks for it under
    // Settings, and that is noted in the handover rather than faked here.
    //
    // The status line states which of the two mechanisms is currently in
    // effect, because "on" is not the whole truth once the counter has
    // retired the markers on its own.
    const marksOn = termMarksSwitchOn();
    const marksRetired = marksOn && !termMarksVisible();
    const termMarkPanel = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "מונחים והסברים")}
      <label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
        <span style="font-size:13px;">סימוני הסבר על מונחים<span style="color:var(--steel);display:block;font-size:11px;line-height:1.5;">${bidiText(marksRetired ? "העיגול הקטן עם ? ליד מונחים כמו AMRAP. הוא מפסיק להופיע אחרי שפותחים שלושה הסברים, וזה כבר קרה — אפשר להחזיר אותו בכל רגע." : "העיגול הקטן עם ? ליד מונחים כמו AMRAP. הוא נעלם מעצמו אחרי שפותחים שלושה הסברים.")}</span></span>
        <input type="checkbox" data-term-marks="1"${marksOn ? " checked" : ""} aria-label="סימוני הסבר על מונחים"/>
      </label>
      <button class="chip-btn" data-community-action="term-glossary-open" style="margin-top:10px;">כל המונחים</button>
    </div>`;

    // COMM-221. The "View Week" entry point into the recap surface.
    const recapEntry = isModuleEnabled("weekly_recap")
      ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--teal)", "הסיכום השבועי שלי")}<button class="chip-btn primary" data-community-action="open-recap">צפייה בשבוע</button></div>`
      : "";
    // COMM-309. The monthly club recap's member-facing card, right beside
    // its weekly sibling above - see renderMonthlyRecapMemberSection's own
    // comment for why this is an inline card rather than a new dialog or a
    // wholly new nav destination. Renders to "" (nothing at all) until a
    // published month actually exists.
    const monthlyRecapEntry = renderMonthlyRecapMemberSection();

    // COMM-228. One box, three labeled groups (members, events, challenges).
    const people = renderCommunitySearch();

    // Post-Phase-3 Hebrew copy fix: "חברים חדשים" - the exact phrase COMM-107's
    // welcome post and the coach-tools "Welcome" section already use for the
    // same concept (מתאמנים was this list's own one-off).
    const newMembersHtml = staff ? renderCoachNewMembersSection() : "";
    const inactiveHtml = staff ? renderCoachAppActivitySection() : "";

    // Redesign (Manage tab): moderation, member/role management, invites,
    // onboarding-content editing, the feature-flag panel, and every
    // analytics/health surface used to render inline here, one after
    // another on this one scrolling tab. They now live in their own "ניהול"
    // bottom-tab (renderManageApp, staff-only) instead - moved verbatim,
    // same functions, same permission gates, just a different mount point.
    // newMembersHtml/inactiveHtml stay here on purpose (out of that phase's
    // scope) and staff still sees a pointer to where the rest went. Both are
    // now one call each - see renderCoachNewMembersSection() and
    // renderCoachAppActivitySection() above, which are defined outside this
    // function so its staff-gate count stays at the asserted 5.
    const movedToManageNote = staff ? `<div class="footer-note" style="color:var(--steel);text-align:center;margin:16px 0 4px;">כלי ניהול עברו ל"ניהול" בתפריט התחתון</div>` : "";
    // COMM-153's member-facing surface, deliberately FIRST - see
    // renderMyRestrictionPanel() for why it outranks the profile form. It is
    // not staff-gated and adds no sixth staff-conditional slice to this
    // function (community-coach-tier.test.mjs counts those, and counts the
    // literal in prose too): a restriction is the member's own business, and
    // staff read restrictions in Manage › מודרציה, not here.
    const restrictionPanel = renderMyRestrictionPanel();
    // Usability pass: achievements and notification prefs used to render
    // dead last, after profile/recaps/privacy/glossary/search and (for
    // staff) two more sections - a headline feature reading as a 22nd
    // setting. Achievements now sits right after the profile form, same
    // "order states priority" idiom restrictionPanel's own placement above
    // already uses. Notification prefs moves up next to its nearer thematic
    // neighbour (privacy), ahead of the glossary/search/staff sections
    // rather than trailing all of them - still a settings-style panel, just
    // no longer the very last thing on the screen.
    const accountTab = restrictionPanel + account + renderMyAchievements() + recapEntry + monthlyRecapEntry + privacyPanel + blockedMembersPanel + renderNotifPrefsPanel() + termMarkPanel + people + newMembersHtml + inactiveHtml + movedToManageNote
      + `<button class="link-btn" data-community-action="sign-out" style="display:block;margin:20px auto 0;">התנתקות</button>`
      + `<button class="link-btn" data-community-action="delete-account" style="display:block;margin:10px auto 8px;color:var(--red-text);">בקשת מחיקת חשבון</button>`;

    // ---- Directory tab: the club roster (COMM-231) -----------------------
    const directoryTab = renderDirectorySection();

    // Redesign, Phase 2: feed and directory are now conditional pushes, same
    // shape as the staff-only "coach" push just below - a module that's off
    // removes its PILL entirely, not just its content, matching the
    // mockup's own behaviour and the "account" tab's own historical
    // treatment (never one more `if (staff)` ternary slice). boards and
    // account are never flag-gated at the pill level: boards' own three
    // modules (challenges/events/leaderboards) gate their CONTENT inside
    // boardsTab (with an empty-state pointing back to Settings when all
    // three are off - see boardsTab's own composition), and account is
    // profile/settings, nobody's content to hide.
    const tabs = [];
    if (isModuleEnabled("feed")) tabs.push({ id: "feed", label: "פיד", html: feedTab });
    // Community structure research, 2026-09-10: the ranked-opportunities
    // list's #1 item - challenges/the leaderboard are real, working "fun"
    // mechanics, but the Boards pill carried no ambient signal at all,
    // unlike Manage's own pendingReports badge two tabs over, so a member
    // has to already think to tap it. state.challenges.items is loaded
    // eagerly at boot (loadChallenges() inside the same Promise.all as
    // loadProfile/loadClubFeatures) regardless of which sub-tab is active,
    // so this is a zero-new-fetch count: active challenges ending within
    // 48h, the same window chal_notify_ending_soon() (202608290006) already
    // uses server-side, so the badge and the notification a member may
    // already have received agree on what "ending soon" means. Gated on
    // isModuleEnabled("challenges") implicitly - a disabled module means
    // loadChallenges() itself returns nothing to count.
    const boardsBadgeCount = (state.challenges.items || [])
      .filter((c) => c.status === "active" && daysRemaining(c.end_at) !== null && daysRemaining(c.end_at) <= 2).length;
    tabs.push({ id: "boards", label: "לוחות", html: boardsTab, badge: boardsBadgeCount || undefined, badgeLabel: "אתגרים מסתיימים בקרוב", badgeLabelOne: "אתגר אחד מסתיים בקרוב" });
    if (isModuleEnabled("directory")) tabs.push({ id: "directory", label: "חברים", html: directoryTab });
    // Redesign, Phase 1 fix: the pendingReports badge used to sit here
    // because moderation itself lived in this Account pill. It moved to
    // Manage's own bottom-tab nav item and its מודרציה sub-tab (see
    // getNavItems() and manageTabs below) - a badge on a pill with no
    // moderation content in it any more was a dead end for the exact
    // person it was meant to help.
    tabs.push({ id: "account", label: "חשבון", html: accountTab });
    // COMM-223. A dedicated 4th sub-tab, added only for isStaff(), as an
    // `if (staff)` push rather than an inline ternary render gate (that
    // literal ternary pattern is what community-coach-tier.test.mjs counts
    // as "the 4 staff-only render gates"; this is a whole sub-tab rather
    // than a slice of one, so it stays out of that count on purpose) - so a
    // non-staff caller's tabs array has no "coach" entry at all, and the
    // activeTab lookup below falls back to the feed tab even if something
    // forced state.ui.tab to "coach" directly.
    // Redesign, Phase 2: also requires isModuleEnabled("coach_tools") - the
    // mockup's "לוח מאמנים (הכל)" master switch. Off removes the whole
    // sub-tab for every coach, same as a role downgrade would.
    // isCoachTier(), not `staff`: an admin who does not coach has no use for
    // this board and should not be offered it.
    if (isCoachTier() && isModuleEnabled("coach_tools")) tabs.push({ id: "coach", label: "לוח מאמנים", html: renderCoachTab() });
    const activeTab = tabs.find((t) => t.id === state.ui.tab) || tabs[0];
    // Redesign, Phase 2 fix: a module toggled off (or a stale value from
    // getCommunityNavPreview()'s desktop-sidebar preview drifting from this
    // same array) used to leave state.ui.tab pointing at a pill that no
    // longer exists, while the fallback above only fixed what's DISPLAYED.
    // Every reader of state.ui.tab elsewhere (ensureFeedRealtime,
    // club_tab_viewed/feed_viewed/directory_opened analytics, the feed/
    // boards lazy loads in afterRenderCommunity) kept reading the stale
    // name, so - among other things - live feed comment/reaction updates
    // silently died while the feed was genuinely on screen. Reconciling
    // here, once, fixes every one of those readers at the source.
    state.ui.tab = activeTab.id;
    // role="tablist"/"tab" + aria-selected + roving tabindex, same
    // convention app.js's own WOD subtabbar already carries (see
    // tablistTabs()'s own comment, COMM-358) - this bar was missed the
    // first time that shared keyboard handler landed, leaving Community's
    // own sub-tabs (and Manage's, see manageTabBar below) with no
    // Arrow/Home/End support even though the generic listener already
    // covers any group shaped this way for free.
    // Launch-readiness audit, A1. Each tab now carries a stable id and
    // aria-controls pointing at the panel it actually swaps (#content, the
    // one role="tabpanel" in index.html). Without aria-controls the tab
    // pattern is only half-declared: a screen reader announces "tab" but
    // has no way to move to the region it governs, and the panel itself
    // had no accessible name at all. afterRenderCommunity() completes the
    // pair by pointing #content's aria-labelledby back at the active tab.
    // t.badgeLabel (202609100002): the count on this bar is no longer only
    // ever "pending reports" (Boards now carries "challenges ending soon"
    // too) - defaults to the original string so every existing badge-less
    // or unlabelled producer keeps reading exactly as before.
    const tabBar = `<div class="subtabbar" role="tablist" aria-label="ניווט בקהילה">${tabs.map((t) => `<button class="subtabbtn${t.id === activeTab.id ? " active" : ""}" id="commTab-${t.id}" aria-controls="content" data-community-action="set-tab" data-tab="${t.id}" role="tab" aria-selected="${t.id === activeTab.id}" tabindex="${t.id === activeTab.id ? "0" : "-1"}">${t.label}${t.badge ? `<span class="tab-badge" aria-label="${esc(badgeAria(t))}">${t.badge}</span>` : ""}</button>`).join("")}</div>`;

    // COMM-329 (remaining scope). The Community tab was the one solo tab
    // with no top-level <h1> of its own - it never calls renderTabHeader(),
    // the shared function the other 4 solo tabs already use. "קהילה" is the
    // same label getNavItems() already gives this tab everywhere else
    // (bottom-bar/nav-menu icon caption); this just reads that one
    // registry entry instead of inventing a second name (e.g. the club's
    // own name, which is a per-club value, not this screen's identity).
    // renderTabHeader lives in app.js, loaded after cloud.js in index.html -
    // safe here since this whole function body only runs on an actual
    // render(), well after both scripts have executed.
    // Immersive club redesign: same .scene-page/.scene-sheet wrapper as
    // every other primary tab, keyed off window.PAGE_SCENES.community
    // (app.js's registry - read off window since cloud.js is its own IIFE
    // and this function only ever runs post-boot, same load-order
    // reasoning documented on photoHeaderHtml()). renderTabHeader()'s own
    // output is dropped in favor of the scene's own title in the photo
    // zone - same substitution every other scene-mapped tab already made.
    return `<section class="scene-page ${window.PAGE_SCENES.community.className}" aria-labelledby="pageTitle-community">
      <div class="scene-page__media" aria-hidden="true"></div>
      <div class="scene-page__scrim" aria-hidden="true"></div>
      <div class="scene-page__intro">
        <div class="scene-page__brand">${esc(brandWordmark())}</div>
        <h1 id="pageTitle-community" class="scene-page__title">קהילה</h1>
      </div>
      <div class="scene-sheet">
    <div class="stripe-ribbon" aria-hidden="true"></div>`
      + tabBar
      // Anchored to the viewport, not the document - see setMessage().
      // pointer-events:none so a toast can never swallow a tap meant for the
      // control underneath it, which would trade an invisible-feedback bug
      // for an unreachable-control one.
      + (state.ui.message ? `<div role="status" aria-live="polite" style="position:fixed;left:0;right:0;bottom:calc(var(--bottom-nav-reserve) - 118px);display:flex;justify-content:center;padding:0 16px;z-index:60;pointer-events:none;"><div style="max-width:448px;background:var(--surface);border:1px solid var(--brass);color:var(--brass);border-radius:14px;padding:11px 16px;font-size:13px;font-weight:700;line-height:1.45;box-shadow:var(--shadow-card);text-align:center;">${esc(state.ui.message)}</div></div>` : "")
      + renderOutboxBanner()
      + activeTab.html
      + `</div></section>`;
  };

  // Launch-readiness audit, RELIABILITY: "never lose a queued action
  // silently". This banner is the visibility half of that promise - a
  // pending count while things are waiting to go out, and one row per
  // permanently-failed op with its own error, retry and discard. Without
  // it, a write that exhausted its retries would be sitting in IndexedDB
  // that nobody ever sees, which is the same as losing it.
  function outboxActionLabel(action) {
    return {
      post_create: "פוסט",
      add_post_comment: "תגובה",
      toggle_reaction: "לייק",
      event_rsvp: "הרשמה לאירוע",
      chal_record_progress: "עדכון התקדמות",
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
  // ==========================================================================
  // Redesign, Phase 1: the "ניהול" (Manage) top-level tab.
  //
  // Every function this composes already existed and was already correctly
  // permission-gated (each returns "" on its own if the viewer doesn't
  // qualify) - this is a relocation out of the Community "חשבון" (Account)
  // sub-tab into its own bottom-bar tab, not a rewrite. The tab itself is
  // visible to any coach-and-up (isStaff()), same access Account already
  // gave these sections; nothing here narrows or widens who can do what.
  //
  // renderRegistrationFunnel() renders from INSIDE
  // renderAdminAnalyticsDashboard(), not as a sibling call - it sits next to
  // the numbers it explains. Its own data loader (loadRegistrationFunnel)
  // gates on the same permission the dashboard does, so it carries a second,
  // matching gate for a tidy empty state rather than the only one.
  //
  // ---- The three-tab Manage screen ----------------------------------------
  //
  // WHAT CHANGED AND WHY. Manage opened onto seven sub-tabs - דשבורד, חברים,
  // קליטה, מודרציה, הגדרות, אנליטיקס, הזמנות - with 38 sections spread across
  // them, and the single most common thing a gym manager does (add a member)
  // was behind the last pill. The box owner scored member experience 8/10 and
  // operator depth 3/10, and this screen is most of that 3.
  //
  // Now three, ordered by how often a manager actually does the thing:
  //
  //   1. הוספת חבר/ה - the joining QR, the code, share and print, and the
  //      signups that stalled halfway. Done weekly.
  //   2. המועדון     - the roster, who is new, who is drifting. Read weekly.
  //   3. ניהול       - moderation, club settings, analytics, the audit log,
  //      onboarding content. Rare, and administrative.
  //
  // NOTHING WAS DELETED. Every section that rendered before still renders,
  // behind the same permission it always had; the five sections whose sub-tab
  // id disappeared are stacked inside tab 3 with a jump row above them
  // labelled with their OLD names, so a manager who knows where something was
  // can still get to it in one tap. MANAGE_TAB_ALIASES (see setManageTab)
  // covers the same ground for anything navigating by the retired ids.
  //
  // The ids of the three surviving tabs are deliberately the old
  // invites/members/moderation, not fresh names matching the new labels. Those
  // three strings are load-bearing outside this file - two browser-check
  // scripts and a dozen test files select on
  // [data-community-action="set-manage-tab"][data-tab="..."], and
  // index.html's own desktop-width rule keys off #manageTab-moderation.
  // Keeping them is what makes this a re-home rather than a rename with a
  // trail of collateral edits.

  // The five areas stacked inside tab 3, in render order. `label` is the name
  // each one had when it was its own sub-tab - that is the whole point of the
  // jump row, so it must stay the old wording, not the new heading.
  const MANAGE_ADMIN_AREAS = [
    { id: "manageArea-moderation", label: "מודרציה" },
    // Second, directly under moderation, because it is the other "someone is
    // waiting for a human" queue on this screen and the two are read in the
    // same sitting. Before the audit log, which is a record rather than a
    // queue (2026-09-15).
    //
    // notInJumpRow: the jump row below exists for ONE reason - a manager who
    // remembers where something lived when these were seven sub-tabs. This
    // area was never a sub-tab, so nobody is looking for it under an old
    // name, and adding it would dilute the row into a generic table of
    // contents (which is what the <details> headings already are). It is
    // discoverable instead by opening itself whenever a report is waiting -
    // see openBugReportsByDefault().
    { id: "manageArea-bugs", label: "דיווחי תקלות", notInJumpRow: true },
    // notInJumpRow for the same reason as the bug inbox directly above: the
    // jump row is a memory aid for the seven sub-tabs this screen used to
    // have, and password resets were never one of them - they were never on
    // this panel at all until COMM-379 put them here. Nobody is looking for
    // this area under an old name.
    { id: "manageArea-passwords", label: "איפוס סיסמאות", notInJumpRow: true },
    { id: "manageArea-audit", label: "יומן פעולות" },
    { id: "manageArea-settings", label: "הגדרות" },
    { id: "manageArea-analytics", label: "אנליטיקס" },
    { id: "manageArea-onboarding", label: "קליטה" },
  ];
  // One plain Hebrew line per tab, saying what the tab is FOR. A manager has
  // to be able to understand the screen before using it, and three unlabelled
  // pills do not do that on their own - the same register d540a34's empty
  // states set.
  const MANAGE_TAB_INTRO = Object.freeze({
    invites: "יצירת קוד הצטרפות למועדון, שליחה או הדפסה שלו, ומעקב אחרי מי שהתחיל להירשם ולא סיים.",
    // Deliberately describes what is ON this tab and no more. An earlier
    // draft promised "ומי לא נכנס כבר הרבה זמן" - the drifting list, which
    // lives on the Community coach tab, not here. What is here is the
    // roster (newest-joined first), the club's own health number and the
    // role controls; the drifting SIGNAL is the attention strip above the
    // tab bar, which is a count and a shortcut, not a list.
    members: "רשימת חברי המועדון לפי סדר ההצטרפות, ותמונת המצב הכללית של הקהילה.",
    moderation: "כלים שמשתמשים בהם לעיתים רחוקות: דיווחים, הגדרות המועדון, נתונים, יומן פעולות ותוכן הקליטה.",
  });
  function manageTabIntro(id) {
    const text = MANAGE_TAB_INTRO[id];
    return text ? `<div class="footer-note" data-manage-intro="${esc(id)}" style="margin:0 0 12px;line-height:1.7;">${bidiText(text)}</div>` : "";
  }
  // A titled wrapper so each stacked area inside tab 3 is a real scroll
  // target for the jump row above it.
  function manageArea(id, html) {
    return `<div id="${esc(id)}" data-manage-area="${esc(id)}">${html}</div>`;
  }
  // Usability pass: the five MANAGE_ADMIN_AREAS below used to all be plain
  // manageArea() divs, stacked one after another with nothing separating
  // them - moderation queue, audit log, club settings, analytics, onboarding
  // content, one continuous ~5000px scroll. A real sub-tab bar for these
  // five was tried and rejected once already (see this whole section's
  // "WHAT CHANGED AND WHY" comment above - that is exactly the seven-tab
  // problem the operator-depth rework fixed). <details> gets the same
  // "work on one thing at a time" result without adding a second tab layer:
  // native, keyboard- and screen-reader-operable with no extra JS, and the
  // jump row's data-scroll still lands on this element's own id (see
  // afterRenderManage, which now also flips `open` before scrolling).
  // openByDefault is true only for moderation - the one area carrying a
  // time-sensitive count (pendingReports) - so arriving on this tab still
  // shows something rather than five closed rows.
  function manageAdminArea(area, html, openByDefault) {
    // state.admin.openAreas is the real source of truth once it has an
    // opinion (the admin has toggled this area, or a jump-row tap opened
    // it - see afterRenderManage()); openByDefault only governs the very
    // first render, before either has happened.
    const open = Object.prototype.hasOwnProperty.call(state.admin.openAreas, area.id) ? state.admin.openAreas[area.id] : !!openByDefault;
    return `<details id="${esc(area.id)}" class="manage-area" data-manage-area="${esc(area.id)}"${open ? " open" : ""}>
      <summary>${esc(area.label)}</summary>
      <div class="manage-area-body">${html}</div>
    </details>`;
  }
  function renderManageAttention() {
    // Redesign, Phase 3 fix: this row used to be gated on canModerate alone
    // (truthy for any moderator regardless of the actual count), so a
    // moderator with a genuinely empty queue permanently saw a red
    // "0 דיווחים ממתינים למודרציה" row, and the green all-clear empty state
    // below was unreachable for the exact people it was written for. Gated
    // on the real count now, same shape as the inactiveCount row right
    // after it.
    const pendingReports = pendingModerationCount();
    // Only the members we have real evidence about. This row used to count
    // the whole result set, which included every member the club had never
    // recorded anything for - so a club with no activity data at all was told
    // on its own landing screen that every one of its members was inactive.
    // A 'no_data' member is not an alert; they are the absence of one.
    const inactiveCount = state.club.inactiveMembers.filter((m) => m.state === "lapsed").length;
    // Both shortcuts now carry a data-scroll as well as a data-tab. They used
    // to live on a "dashboard" sub-tab of their own and only had to switch
    // tabs; this strip sits ABOVE the tab bar and is visible from all three
    // tabs, so "go to Members" tapped while already on Members would have
    // been a control that does nothing. Naming the section makes it land
    // somewhere either way - see setManageTab()'s scrollTo.
    const attentionRows = [
      pendingReports ? `<button class="log-row" data-community-action="set-manage-tab" data-tab="moderation" data-scroll="manageArea-moderation" style="width:100%;text-align:right;border:1px solid var(--red);border-radius:10px;padding:10px 12px;background:transparent;cursor:pointer;">
          <span>${pendingReports === 1 ? "דיווח אחד ממתין למודרציה" : `${pendingReports} דיווחים ממתינים למודרציה`}</span><span aria-hidden="true">‹</span>
        </button>` : "",
      inactiveCount ? `<button class="log-row" data-community-action="set-manage-tab" data-tab="members" data-scroll="manageArea-roster" style="width:100%;text-align:right;border:1px solid var(--yellow);border-radius:10px;padding:10px 12px;background:transparent;cursor:pointer;">
          <span>${bidiText(inactiveCount === 1 ? "יש חבר/ה שלא נכנס/ה לאפליקציה לאחרונה" : `${inactiveCount} חברים לא נכנסו לאפליקציה לאחרונה`)}</span><span aria-hidden="true">‹</span>
        </button>` : "",
    ].filter(Boolean);
    // Moved out of the retired "דשבורד" sub-tab to sit above the tab bar,
    // where it is on screen whichever of the three tabs is open. An alert
    // that only exists on the tab nobody opens is not an alert; the pending-
    // reports count is the one thing on this screen that is genuinely
    // time-sensitive, and it now shares the drawing-attention job with the
    // moderation badge on tab 3 rather than being hidden behind it.
    return attentionRows.length
      ? `<div class="ach-section" style="margin-top:0;">${sectionHead("var(--red)", "דורש תשומת לב")}<div class="log-list">${attentionRows.join("")}</div></div>`
      : `<div class="ach-section" style="margin-top:0;">${sectionHead("var(--green)", "דורש תשומת לב")}<div class="empty">אין דבר שדורש תשומת לב כרגע ✓</div></div>`;
  }
  // SPLIT INTO TWO PANELS (2026-09-15), at the club owner's request: the
  // admin's screen and the head coach's screen are separate destinations for
  // separate people, not one screen with things greyed out on it.
  //
  //   mode "admin" - is_admin() only. Everything the club panel has, PLUS the
  //     four areas that stay with the account answering for the club: bug
  //     report triage, the audit log, role changes and password resets. An
  //     admin therefore never has to switch screens to do a club task.
  //   mode "club"  - is_staff() (coach and head coach). Running the club:
  //     invites, the roster, moderation, club modules, onboarding content and
  //     the club's own numbers. 202609150004 granted head_coach the four
  //     permissions this needs, so these controls are backed by real grants
  //     rather than rendering and then failing on use.
  //
  // Every inner panel still self-gates exactly as it did - renderMemberManagement()
  // is its own isAdmin() check, renderClubModulesPanel() its own hasPerm() -
  // so this split decides what is OFFERED, never what is ALLOWED. The server
  // is unchanged and remains the only real boundary.
  function renderManagePanel(mode) {
    const isAdminMode = mode === "admin";
    // Redesign, Phase 3 fix: renderTabHeader("manage") resolves through
    // getNavItems(), which omits the "manage" entry entirely for a
    // non-staff caller (by design - see app.js) - so this deny branch used
    // to render with no heading at all for the exact caller who reaches
    // it. The label is stated directly here instead of round-tripping
    // through a registry that deliberately doesn't know this page exists
    // for them.
    const panelTitle = isAdminMode ? "ניהול מערכת" : "ניהול המועדון";
    const panelKey = isAdminMode ? "admin" : "club";
    // ORDER MATTERS, and it is the reverse of what it was.
    //
    // This used to refuse the page outright unless the MEMBER held admin (or
    // staff), and only then offer the lock. That was right while the lock was
    // a re-check of the signed-in member. It is wrong now that management is a
    // separate identity: the person who may open this panel is generally NOT
    // an admin on the account they train with - that separation is the whole
    // point - so a member-permission check in front of the gate would refuse
    // the page to exactly the people it is for, and there would be no way in.
    //
    // So the gate comes first and is the only thing standing here. The
    // permission decision moved inside panelUnlock(), where it is made against
    // the account that signed in, and is re-asserted below for the rendered
    // panel. Nothing is weakened by showing the gate to anyone: it grants
    // nothing without management credentials, and every RPC behind it is
    // RLS-gated server-side against the management account's own JWT.
    mgmtExpireIfStale();
    if (!panelUnlocked(panelKey)) {
      return `<h1 class="page-title">${esc(panelTitle)}</h1>${renderPanelUnlockGate(panelKey)}`;
    }
    // Every render of an unlocked panel is a sign somebody is still working in
    // it, so the idle clock starts again here.
    mgmtTouch();
    // Belt and braces. panelUnlock() will not set the unlock for a panel the
    // account may not run, so this is unreachable by the normal path - but it
    // means the rendered panel states its own requirement rather than relying
    // on the gate having checked, which is what makes the gate safe to change.
    if (isAdminMode ? !mgmtIsAdmin() : !mgmtIsStaff()) {
      return `<h1 class="page-title">${esc(panelTitle)}</h1><div class="empty">אין הרשאה לצפות בעמוד זה.</div>`;
    }
    // Tab 3's five areas, each still self-gated exactly as it was. The two
    // permission fallbacks below are the same strings the retired "הגדרות"
    // and "אנליטיקס" sub-tabs carried: a coach who is staff enough to be
    // here but holds neither community.club.manage_modules nor
    // community.analytics.view still gets told why the space is empty
    // instead of finding nothing at all. Kept per-area rather than merged
    // into one notice so that what a given coach sees is byte-identical to
    // what they saw on the old sub-tabs.
    //
    // renderAdminAnalyticsDashboard() still includes renderRegistrationFunnel()
    // nested inside itself (see that function's own comment).
    const [areaModeration, areaBugs, areaPasswords, areaAudit, areaSettings, areaAnalytics, areaOnboarding] = MANAGE_ADMIN_AREAS;
    const adminAreas = [
      // FULLY DISJOINT, not a superset (2026-09-15, second revision).
      //
      // The first split made the admin panel a superset of the club panel, on
      // the reasoning that an admin should never have to switch screens. The
      // owner's correction is a different and clearer division of labour:
      //
      //   HEAD COACH runs the CLUB - adds members, manages the roster,
      //     moderates, edits what new members read, reads the club's numbers.
      //   ADMIN runs the APP - bug reports, the audit log, who holds which
      //     role, password resets, and which modules are switched on.
      //
      // So these two lists no longer overlap. An admin who wants to invite
      // someone is doing a head coach's job and should hold that role too;
      // the roles are additive on one account, and my_role_code() already
      // resolves the highest one. That is a cleaner answer than one screen
      // that quietly contains both jobs.
      isAdminMode ? "" : manageAdminArea(areaModeration, renderRestrictionsPanel() + renderModeration(), true),
      isAdminMode ? manageAdminArea(areaBugs, renderBugReports(), true) : "",
      // COMM-379. "who holds which role, password resets" is in this
      // panel's own charter three comments up, and the reset half had no
      // screen here - see renderPasswordResetPanel()'s comment. Admin
      // panel only: the club panel keeps reaching the same control through
      // renderMemberManagement(), unchanged, so nothing an admin could do
      // yesterday moved.
      isAdminMode ? manageAdminArea(areaPasswords, renderPasswordResetPanel()) : "",
      isAdminMode ? manageAdminArea(areaAudit, renderAuditLog()) : "",
      // Module toggles decide which FEATURES of the app exist for this club -
      // that is app administration, not club running, so it moves to admin.
      isAdminMode ? manageAdminArea(areaSettings, renderClubModulesPanel() || `<div class="empty">אין לך הרשאה לצפות בהגדרות המודולים.</div>`) : "",
      // The club's own numbers are about the club, so they stay with the head
      // coach.
      isAdminMode ? "" : manageAdminArea(areaAnalytics, (renderAdminAnalyticsDashboard() + renderRetentionCorrelations()) || `<div class="empty">אין לך הרשאה לצפות באנליטיקס.</div>`),
      // What a new member reads on their first open is club content.
      isAdminMode ? "" : manageAdminArea(areaOnboarding, renderOnboardingContentEditor() + renderIntroCarouselContentEditor()),
    ].join("");
    // The "I know where this used to be" row. Old sub-tab names, one tap,
    // scrolls to the section. Every button here is a real destination - the
    // areas are unconditionally in the DOM above, including the two
    // permission notices, so none of these can scroll to nothing.
    // Only the areas THIS panel actually renders - a chip that scrolls to
    // nothing is the "button that goes nowhere" the original jump-row comment
    // was written to prevent.
    const jumpAreaIds = isAdminMode
      ? ["manageArea-audit", "manageArea-settings"]
      : ["manageArea-moderation", "manageArea-analytics", "manageArea-onboarding"];
    const adminJumpRow = `<div class="chip-row" data-manage-jump-row="1" style="margin:0 0 12px;">${MANAGE_ADMIN_AREAS.filter((a) => !a.notInJumpRow && jumpAreaIds.includes(a.id)).map((a) =>
      `<button class="chip-btn" data-community-action="set-manage-tab" data-tab="moderation" data-scroll="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div>`;

    const manageTabs = [
      // 1. The weekly job. The QR panel comes first because creating a code
      // is what a manager came here to do; the code/invite lists are the
      // record of what they have created; and the unfinished signups sit
      // last because "who tried to join and did not finish" is the same
      // question as "who did I invite", asked from the other end. That
      // pairing is why the incomplete signups moved off the roster tab
      // (five-persona UX audit, defect 3, which put them under the roster
      // for the same reasoning applied to the tabs as they were then).
      // Order matters here: the invite form itself comes first (the actual
      // action), the QR panel second (its own empty state explains "a code
      // will appear here" - true once you look at the form right above it,
      // confusing when it was the first thing on the screen instead).
      // "head coach will add users" - so the invite surface is theirs, and is
      // absent from the admin panel entirely rather than duplicated onto it.
      ...(isAdminMode ? [] : [{ id: "invites", label: "הוספת חבר/ה", html: renderInviteManagement() + renderInviteQrPanel() + renderIncompleteSignups() }]),
      // 2. The weekly read. renderCommunityHealthScore() came off the
      // retired dashboard sub-tab to sit at the top of it: the club's own
      // health number is the headline for "how is the club doing", which is
      // this tab's question, not an analytics card.
      // The roster and the club's health are the club. renderMemberManagement()
      // keeps its own isAdmin() gate for the role/password controls inside it,
      // so a head coach sees the roster without the app-level controls.
      ...(isAdminMode ? [] : [{ id: "members", label: "המועדון", html: renderCommunityHealthScore() + renderMemberManagement() + manageArea("manageArea-roster", renderMemberRoster()) }]),
      // 3. The rare and the administrative. Keeps the moderation badge: it
      // is the one number on this screen that means "someone is waiting",
      // and burying it inside a tab without it would have been the
      // regression this rework is supposed to fix.
      { id: "moderation", label: isAdminMode ? "האפליקציה" : "ניהול", html: adminJumpRow + adminAreas, badge: isAdminMode ? 0 : pendingModerationCount() },
    ];
    // Same reconciliation renderCommunityApp() does for state.ui.tab, and
    // for the same reason: afterRenderManage() reads state.ui.manageTab to
    // decide which lazy loads to fire, so a stale value (a retired id from a
    // previous build's persisted state, say) that only the DISPLAY corrects
    // would render one tab while loading another's data.
    const activeManageTab = manageTabs.find((t) => t.id === state.ui.manageTab) || manageTabs[0];
    state.ui.manageTab = activeManageTab.id;
    // Same role="tablist"/"tab" convention as the Community sub-tab bar
    // above - see that bar's own comment (COMM-358).
    const manageTabBar = `<div class="subtabbar" role="tablist" aria-label="ניווט בניהול">${manageTabs.map((t) => `<button class="subtabbtn${t.id === activeManageTab.id ? " active" : ""}" id="manageTab-${t.id}" aria-controls="content" data-community-action="set-manage-tab" data-tab="${t.id}" role="tab" aria-selected="${t.id === activeManageTab.id}" tabindex="${t.id === activeManageTab.id ? "0" : "-1"}">${t.label}${t.badge ? `<span class="tab-badge" aria-label="${esc(badgeAria(t))}">${t.badge}</span>` : ""}</button>`).join("")}</div>`;
    // Redesign, Phase 3 fix: the notification bell used to live only inside
    // feedTab's club-strip - unreachable from Manage entirely. A staff
    // member who now lives primarily on Manage had no unread indicator at
    // all while there, even though the underlying realtime count kept
    // updating correctly the whole time.
    // WHO IS MANAGING, and a way to stop. Two small things that were missing
    // and that both matter more here than on any other screen.
    //
    // Naming the account answers a question the separation itself creates: the
    // app is signed in as one person and this panel is acting as another, and
    // nothing on screen said so. On a club where the owner holds both logins,
    // "which of my two accounts is this" is a real question with real
    // consequences - every action taken here is recorded against whoever this
    // says it is.
    //
    // The lock button is the missing counterpart to the gate. Before this the
    // only ways out were to wait for the idle window, reload, or sign out of
    // the app entirely - so somebody handing their phone to a member had no
    // way to close the panel first. A control that takes one tap is the
    // difference between a lock people use and one they work around.
    const mgmtWho = state.admin.mgmt ? (state.admin.mgmt.displayName || state.admin.mgmt.email) : "";
    const mgmtBar = mgmtWho
      ? `<div class="chart-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;margin-bottom:12px;flex-wrap:wrap;">
           <div style="color:var(--steel);font-size:12px;line-height:1.5;">${bidiText(`מנהלים כרגע כ-${mgmtWho}`)}</div>
           <div class="chip-row" style="margin:0;">
             <button class="chip-btn" data-community-action="mgmt-password-open">שינוי סיסמה</button>
             <button class="chip-btn" data-community-action="panel-lock">נעילה</button>
           </div>
         </div>${renderMgmtPasswordChange()}`
      : "";
    // The bell belongs to the MEMBER, so it only renders when there is one.
    // A management session opened on a signed-out phone has no notification
    // centre to link to, and a bell reading 0 for nobody is furniture.
    const bell = (state.user && state.profile) ? renderNotificationBell() : "";
    return `<h1 class="page-title" style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span>${esc(panelTitle)}</span>${bell}</h1>`
      + mgmtBar
      + renderManageAttention()
      + manageTabBar
      + manageTabIntro(activeManageTab.id)
      // Anchored to the viewport, not the document - see setMessage().
      // pointer-events:none so a toast can never swallow a tap meant for the
      // control underneath it, which would trade an invisible-feedback bug
      // for an unreachable-control one.
      + (state.ui.message ? `<div role="status" aria-live="polite" style="position:fixed;left:0;right:0;bottom:calc(var(--bottom-nav-reserve) - 118px);display:flex;justify-content:center;padding:0 16px;z-index:60;pointer-events:none;"><div style="max-width:448px;background:var(--surface);border:1px solid var(--brass);color:var(--brass);border-radius:14px;padding:11px 16px;font-size:13px;font-weight:700;line-height:1.45;box-shadow:var(--shadow-card);text-align:center;">${esc(state.ui.message)}</div></div>` : "")
      + activeManageTab.html;
  }
  // Two entry points, one builder. app.js's nav registry routes tab "manage"
  // to the first and tab "clubmanage" to the second.
  window.renderManageApp = function () { return renderManagePanel("admin"); };
  window.renderClubManageApp = function () { return renderManagePanel("club"); };
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
  // app.js's hamburger staff section (2026-09-15). Two facts it cannot derive
  // itself: whether the coach board exists for this member at all (staff AND
  // the coach_tools module switched on - the same pair renderCommunityApp()
  // uses to decide whether to build the tab), and how to land on it.
  window.communityCoachBoardEnabled = function () {
    return !!(state.user && isCoachTier() && isModuleEnabled("coach_tools"));
  };
  window.communityOpenCoachBoard = function () {
    if (!window.communityCoachBoardEnabled()) return false;
    setCommunityTab("coach");
    return true;
  };
  window.cloudSyncActive = function () { return !!(state.user && state.syncEnabled); };
  window.cloudStorageStatusText = function () {
    if (!configured) return "נשמר במכשיר הזה בלבד, ללא שרת";
    if (backupOptedOut()) return "נשמר במכשיר הזה בלבד — גיבוי אוטומטי כבוי";
    if (!state.user) return "נשמר במכשיר; יגובה אוטומטית ופרטית עם השמירה הבאה";
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
  window.renderBackupSettingsPanel = function () {
    if (!configured) return "";
    if (backupOptedOut()) {
      return `${BACKUP_PANEL_TITLE}<div class="footer-note" style="margin-bottom:8px;">כבוי. מהשמירה הבאה האימונים נשמרים במכשיר הזה בלבד.</div>${BACKUP_OPTOUT_TRUTHS}<button class="link-btn" data-community-action="backup-enable">הפעלת גיבוי אוטומטי</button>`;
    }
    if (!state.user) {
      return `${BACKUP_PANEL_TITLE}<div class="footer-note" style="margin-bottom:8px;">מהשמירה הראשונה האימונים שלכם מתחילים להיות מגובים לענן ברקע, אוטומטית ופרטית — רק אתם רואים אותם. הסנכרון קורה מעצמו ואין כאן קובץ להוריד; „קובץ גיבוי להורדה" הוא דבר נפרד במסך הזה. אפשר לכבות בכל שלב.</div><button class="link-btn" data-community-action="backup-optout">כיבוי גיבוי אוטומטי</button>`;
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
    return `${BACKUP_PANEL_TITLE}<div class="footer-note" style="margin-bottom:8px;">${esc(state.syncEnabled ? "פעיל. האימונים שלכם מגובים לענן ברקע, אוטומטית ופרטית — רק אתם רואים אותם. הסנכרון קורה מעצמו ואין כאן קובץ להוריד; „קובץ גיבוי להורדה\" הוא דבר נפרד במסך הזה." : "מוגדר אך טרם הופעל.")}</div><button class="link-btn" data-community-action="backup-optout">כיבוי גיבוי אוטומטי</button>${credentialsCta}${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}`;
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
    { key: "reportSheet", isOpen: () => state.admin.reportSheet, close: function () { closeReportSheet(); } },
    { key: "modAction", isOpen: () => state.admin.modAction, close: function () { closeModAction(); } },
    { key: "reclaimInvite", isOpen: () => state.admin.reclaim, close: function () { closeGhostReclaim(); } },
    { key: "modContext", isOpen: () => state.admin.modContext, close: function () { closeModContext(); } },
    { key: "notifCenter", isOpen: () => state.notif.center, close: function () { closeNotifCenter(); } },
    { key: "achUnlock", isOpen: () => state.achievements.unlock, close: function () { dismissAchievementUnlock(); } },
    { key: "prPrompt", isOpen: () => state.posts.prPrompt, close: function () { dismissPrPrompt(); } },
    { key: "composer", isOpen: () => state.posts.composer, close: function () { tryCloseComposer(); } },
    { key: "profileView", isOpen: () => state.members.profileView, close: function () { closeCommunityProfile(); } },
    { key: "challengeView", isOpen: () => state.challenges.view, close: function () { closeChallengeView(); } },
    { key: "eventView", isOpen: () => state.events.view, close: function () { closeEventView(); } },
    { key: "recapView", isOpen: () => state.recaps.view, close: function () { closeRecapView(); } },
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
    { key: "clubWodBoard", isOpen: () => state.club.wodBoardView, close: function () { closeClubWodBoard(); } },
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
    // COMM-331. The one place the deferred feed/streaks/etc. cascade gets
    // kicked off - the first time the Community tab actually renders (boot
    // straight into it, or navigating to it later), not on every cold
    // boot. See ensureCommunityDataLoaded()'s own comment for what it does
    // and does not cover.
    ensureCommunityDataLoaded();
    // Launch-readiness audit, A1. Completes the tab/tabpanel pair: the tabs
    // point at #content via aria-controls, and #content points back at
    // whichever tab is currently selected. index.html declares
    // role="tabpanel" on #content but could never name it, because the tab
    // that labels it is rendered here, not there. Without this the panel is
    // an unlabelled region and a screen reader announces no context for
    // what it just moved into.
    const panel = document.getElementById("content");
    const selectedTab = document.querySelector('.subtabbar [role="tab"][aria-selected="true"]');
    if (panel) {
      if (selectedTab && selectedTab.id) panel.setAttribute("aria-labelledby", selectedTab.id);
      else panel.removeAttribute("aria-labelledby");
    }
    const input = document.getElementById("communityPeopleSearch");
    if (input) input.addEventListener("input", () => searchPeople(input.value));
    // COMM-228. A render replaces the box the member is typing into, which
    // drops focus and the caret. Restoring is safe only when nothing else
    // holds focus (a render triggered by the search itself leaves
    // activeElement on <body>), so this can never steal focus from another
    // control on the same tab.
    if (input && input.value && (!document.activeElement || document.activeElement === document.body)) {
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* not a text input in this browser */ }
    }
    // COMM-231. Same restore-focus-and-caret pattern as communityPeopleSearch
    // above, for the directory's own search box.
    const dirInput = document.getElementById("communityDirectorySearch");
    // Debounced, like the main search box beside it. Live bug hunt, fresh
    // round 7: searchPeople() was explicitly debounced under PERF-3, with a
    // comment noting a typed word "used to be 8 round trips... now costs
    // one" - and this box, which calls the SAME community_search RPC, was
    // never given the same treatment. Measured live: four characters cost one
    // request through the main box and three through this one, each with its
    // own full re-render.
    if (dirInput) dirInput.addEventListener("input", () => directorySearchDebounced(dirInput.value));
    if (dirInput && dirInput.value && (!document.activeElement || document.activeElement === document.body)) {
      try { dirInput.focus(); dirInput.setSelectionRange(dirInput.value.length, dirInput.value.length); } catch (e) { /* not a text input in this browser */ }
    }
    // COMM-309. The monthly club recap's member-facing card: fetched the
    // first time a member lands on the Account tab, same lazy pattern as
    // the audit view just above (and every other tab-scoped load in this
    // block) rather than in refreshSession()'s boot Promise.all - most
    // months this answers "nothing published yet", so it is not worth a
    // boot round-trip for every session.
    if (state.ui.tab === "account" && state.user && !state.recaps.monthly.loaded && !state.recaps.monthly.loading) loadMonthlyRecap();
    // COMM-153. The member's own restriction row, on the same lazy Account-tab
    // pattern as the recap card above. Not in refreshSession()'s boot batch on
    // purpose: for all but a handful of members this query answers "no rows",
    // and the surface it feeds is not first-paint content. The member who IS
    // restricted is routed here by the 'posting_restricted' error text, which
    // now names this tab (see SERVER_ERROR_TEXT), so the lazy load always
    // fires before the person who needs it arrives to read it.
    if (state.ui.tab === "account" && state.user && !state.myRestriction.loaded && !state.myRestriction.loading) loadMyRestriction();
    // COMM-229. Same lazy pattern: this device's push subscription status
    // is only worth checking once the flag is on and a member actually
    // lands on the Account tab where the preferences panel lives - never
    // on every session, and never at all while the flag is off (the V1
    // default), so no serviceWorker.ready wait is introduced for anyone
    // who cannot act on it anyway.
    if (state.ui.tab === "account" && state.user && notifPushEnabled() && !state.notif.pushChecked) loadNotifPushStatus();
    // COMM-210. Same lazy pattern for the consistency board: one
    // feed_leaderboard() call the first time a member lands on the Boards
    // sub-tab, not on every session boot.
    if (state.ui.tab === "boards" && state.user && !state.leaderboard.loaded && !state.leaderboard.loading) loadConsistencyLeaderboard();
    // 202609220002. The member's own onboarding challenge, fetched the first
    // time they open the sub-tab its card lives on - the same lazy shape the
    // leaderboard above uses, and the same reason: a member who never opens
    // Boards costs the server nothing. onboarding_challenge_state() is the
    // call that CREATES the offer, so this is also where an eligible new
    // member is first offered it.
    if (state.ui.tab === "boards" && state.user && !state.challenges.onboarding.loaded && !state.challenges.onboarding.loading) loadOnboardingChallenge();
    // COMM-231. The directory's own paginated roster, fetched the first time
    // a member lands on the Directory sub-tab.
    if (state.ui.tab === "directory" && state.user && !state.members.directory.loaded && !state.members.directory.loading) loadDirectory(true);
    // COMM-232. The suggestions strip now renders on the Directory sub-tab -
    // see the PLACEMENT NOTE above renderPeopleSuggestions().
    if (state.ui.tab === "directory" && state.user && !state.members.suggestions.loaded && !state.members.suggestions.loading) loadPeopleSuggestions();
    // COMM-307. The trained-with-you card, on the same lazy sub-tab pattern
    // as the four loads above rather than in refreshSession()'s boot
    // Promise.all beside loadEvents(). Three reasons, all of them about this
    // particular call: show_attendance defaults to false, so for most of the
    // club the answer is an empty set and a boot round-trip buys nothing;
    // the boot batch is what first paint waits on, and this card is not
    // first-paint content; and the member's own attendance row for today is
    // written by the private_records trigger behind flushOutbox(), which
    // runs AFTER that batch, so asking during boot could ask before the row
    // that anchors the whole join exists. Asking when the Feed sub-tab is
    // actually on screen asks once, late enough, and only of members looking
    // at the surface the card lives on.
    if (state.ui.tab === "feed" && state.user && !state.members.classmatesToday.loaded && !state.members.classmatesToday.loading) loadClassmatesToday();
    // COMM-316. Same lazy, same-subtab, same after-boot-batch pattern as
    // loadClassmatesToday just above, and for the identical reason: this
    // reads the member's own attendance_log rows, which the private_records
    // trigger behind flushOutbox() only finishes writing after the boot
    // Promise.all. Only the two attendance-tied onboarding steps depend on
    // this; welcome/first_week/first_month never look at it.
    if (state.ui.tab === "feed" && state.user && !state.onboarding.attendance.loaded && !state.onboarding.attendance.loading) loadOnboardingAttendance();
    // COMM-212. The hide-my-result checkbox persists per device on change,
    // the same no-save-button pattern the privacy toggles below use - except
    // this one writes localStorage, never the server.
    document.querySelectorAll("[data-leaderboard-hide-self]").forEach((el) => {
      el.addEventListener("change", () => setHideMyLeaderboardResult(el.checked));
    });
    // COMM-223..226. Same lazy pattern for the Coach Dashboard's own three
    // loads: fetched the first time a staff member actually lands on the
    // sub-tab, not on every session, and Engage only once its flag is on
    // too (COMM-226: no code path reaches coach_engagement_flags outside
    // the flag-gated staff surface).
    if (state.ui.tab === "coach" && isStaff()) {
      // 202609220002. Same lazy shape as the three below it. The module gate
      // is inside loadCoachTasks() rather than here, so there is one place
      // that decides whether this feature reads anything.
      if (!state.coach.tasks.loaded && !state.coach.tasks.loading) loadCoachTasks();
      if (!state.coach.celebrate.loaded && !state.coach.celebrate.loading) loadCoachCelebrate();
      if (!state.coach.welcome.loaded && !state.coach.welcome.loading) loadCoachWelcome();
      if (!state.coach.memberOfWeek.loaded && !state.coach.memberOfWeek.loading) loadCoachMemberOfWeek();
      // COMM-309. The staff preview, same lazy sub-tab pattern as the three
      // loads above it. NO FLAG GATE HERE, and since Redesign Phase 2 that
      // is a deliberate asymmetry rather than the "there is no flag" it
      // originally described: renderCoachMonthlyRecapSection() now returns
      // "" unless isModuleEnabled("monthly_recap"), exactly as
      // renderCoachMemberOfWeekSection() (loaded one line up) already did.
      // The gate stays on the SECTION and off the loader for the same
      // reason it is a clientOnly toggle in the first place - it hides a
      // coach-facing preview, it is not a data boundary - so a club can
      // flip it on and see the current month immediately, and the cost of
      // being wrong is one unrendered query rather than a stale screen.
      // Nothing server-side consults it: the 'recap_monthly' cron job
      // (202609050005) is plain SQL calling recap_monthly_generate(), so
      // drafts keep accruing month after month whether or not any club
      // chose to show the preview section.
      if (!state.coach.monthlyRecap.loaded && !state.coach.monthlyRecap.loading) loadCoachMonthlyRecap();
      if (state.featureFlags.coachEngage && !state.coach.engage.loaded && !state.coach.engage.loading) loadCoachEngageFlags();
    }
    // COMM-224. The assign-by-handle and mark-contacted note fields are
    // read only at click time (coachAssignByHandle/coachMarkContacted), so
    // this only stores the draft - never rerenders - which is what keeps
    // typing from losing focus or the caret on every keystroke.
    document.querySelectorAll("[data-coach-assign-handle]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.welcome.assignDrafts[el.dataset.coachAssignHandle] = el.value; });
    });
    document.querySelectorAll("[data-coach-contact-note]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.welcome.contactDrafts[el.dataset.coachContactNote] = el.value; });
    });
    // 202609220002. The task list's own note field, same no-rerender-on-input
    // shape and for the same reason. Keyed by MEMBER id, not task id: one
    // note is one contact even when that contact closes four tasks.
    document.querySelectorAll("[data-coach-task-note]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.tasks.contactDrafts[el.dataset.coachTaskNote] = el.value; });
    });
    // COMM-315. Same no-rerender-on-input shape as the two listeners just
    // above. The reason field's live 500-char counter is DOM-patched
    // directly on the same input event, the same way composerSetBody's own
    // counter is - a full rerender here would cost the textarea its focus
    // and caret position on every keystroke, exactly what those two
    // listeners already avoid.
    document.querySelectorAll("[data-mow-pick-handle]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.memberOfWeek.pickHandle = el.value; });
    });
    document.querySelectorAll("[data-mow-pick-reason]").forEach((el) => {
      el.addEventListener("input", () => {
        state.coach.memberOfWeek.pickReason = el.value;
        const counter = document.querySelector("[data-mow-pick-counter]");
        if (counter) counter.textContent = `${el.value.length}/500`;
      });
    });
    // COMM-222. Same lazy pattern: the first-month summary is only worth
    // fetching once that onboarding step is actually due.
    if (currentOnboardingStep() === "first_month" && !state.onboarding.firstMonth) loadOnboardingFirstMonthSummary();
    // COMM-018. Each privacy toggle persists on change, no save button.
    document.querySelectorAll("[data-privacy-field]").forEach((el) => {
      el.addEventListener("change", () => savePrivacyField(el.dataset.privacyField, el.checked));
    });
    // Design spec 3.5. Per-device and localStorage-backed, so unlike the
    // privacy toggles above it there is no server write and nothing to roll
    // back on failure.
    document.querySelectorAll("[data-term-marks]").forEach((el) => {
      el.addEventListener("change", () => {
        try { localStorage.setItem(TERM_MARKS_KEY, el.checked ? "1" : "0"); } catch (e) {}
        rerender();
      });
    });
    // COMM-113/114. Both observers are rebuilt here because rerender()
    // replaces every card element, so the previous ones point at nodes that
    // are no longer in the document.
    observeFeedImpressions();
    observeFeedSentinel();
    // COMM-170. This hook is the only place cloud.js learns that the
    // Community tab is actually on screen, so the club_tab_viewed event is
    // recorded from here rather than from setCommunityTab - which also
    // runs when a notification routes to a tab the member never looked at.
    // noteClubTabView() de-dupes, so running on every render is harmless.
    noteClubTabView();
    // COMM-307. Same hook, same reason, same de-duping shape: the card is
    // "viewed" when it is in the document with rows in it, which is a fact
    // only this hook can see. Runs on every render and records at most once
    // per load of the card.
    noteClassmatesCardView();
    // The announcements and monthly_recap modules, same hook, same de-duping
    // shape, same reason: an inline surface is "viewed" when it is in the
    // document, which is a fact only this hook can see.
    noteAnnouncementsView();
    noteMonthlyRecapView();
    // COMM-141. Re-arm the own-row notification channel; setCommunityTab
    // tears every channel down, so this self-heals the same way the feed
    // observers above do.
    ensureNotifRealtime();
    // COMM-209 / COMM-227. Same self-healing arm point for the challenge
    // detail's two filtered channels and the feed's two shared ones. Both
    // are idempotent: they check the registry before subscribing, so
    // running on every render costs nothing.
    ensureChallengeRealtime();
    ensureFeedRealtime();
    // COMM-190. Shared dialog focus management for every Phase 1 overlay:
    // focus-in on open, focus restored to the opener on close. Replaces the
    // notification centre's one-off focus-in.
    syncCloudDialogFocus();
  };
  // Redesign, Phase 1: the Manage tab's own after-render hook, called by
  // app.js's render() when tab === "manage" - the exact same "lazy-load the
  // first time a member actually lands on the sub-tab that needs it" pattern
  // afterRenderCommunity() uses above, just keyed on state.ui.manageTab
  // instead of state.ui.tab, since Manage is a separate top-level tab with
  // its own sub-tab state (kept separate on purpose - see the ui state
  // literal's own comment - so leaving Manage and coming back doesn't lose
  // either tab's place). Every one of these gates is moved, not duplicated,
  // from afterRenderCommunity(): each of these sections used to render (and
  // lazy-load) only on Community's "account" sub-tab, and does not any more.
  window.afterRenderManage = function () {
    // COMM-331's own cascade (permissions, the mod queue, inactive/new
    // members and a dozen other loads) has always been kicked off only
    // from afterRenderCommunity() - a staff member who boots straight into
    // Manage (their new home tab) without ever touching Community first
    // must still get it, or hasPerm() has nothing loaded to check and every
    // permission-gated section here renders as if signed out. Idempotent
    // (state.communityDataLoaded guards it), so calling it from both hooks
    // is exactly as safe as calling it from either one alone.
    ensureCommunityDataLoaded();
    // The bug inbox loads itself (2026-09-15). Reported directly: "it need to
    // tap טעינת דיווחים for seeing it, so its not good." An inbox that hides
    // its contents behind a button is an inbox nobody reads, and the point of
    // collecting reports at all is that somebody sees them without going
    // looking. loadBugReports() is idempotent and guards on bugsLoading, so
    // calling it from every Manage render costs one request per session.
    if (document.getElementById("manageArea-bugs")) loadBugReports();
    const mt = state.ui.manageTab;
    const adminInput = document.getElementById("adminMemberSearch");
    if (adminInput) adminInput.addEventListener("input", () => searchMembers(adminInput.value));
    // COMM-379. The system admin panel's own reset-only member lookup. Same
    // searchMembers(), same state.members slice, same debounce - a second id
    // rather than a second search, because the two boxes belong to two
    // panels and renderManagePanel() draws exactly one of them per render,
    // so they never coexist in the DOM and never fight over the state they
    // share. Kept beside adminMemberSearch rather than near the panel it
    // serves so a third one cannot be added without seeing these two.
    const pwInput = document.getElementById("adminPasswordResetSearch");
    if (pwInput) {
      pwInput.addEventListener("input", () => searchMembers(pwInput.value));
      // searchMembers() debounces the RPC but rerenders on its own for a
      // query under two characters, and rerendering replaces the box being
      // typed into. Same restore as rosterSearch below, and for the same
      // reason: without it the third character of a search cannot be typed.
      if (pwInput.value && (!document.activeElement || document.activeElement === document.body)) {
        try { pwInput.focus(); pwInput.setSelectionRange(pwInput.value.length, pwInput.value.length); } catch (e) {}
      }
    }
    // Fresh-eyes audit: a pure client-side filter over already-loaded
    // roster items, no RPC and so no debounce needed - see
    // renderMemberRoster()'s own comment for why this is separate from
    // adminMemberSearch/admin_search_members just above.
    const rosterInput = document.getElementById("rosterSearch");
    if (rosterInput) rosterInput.addEventListener("input", () => { state.admin.roster.search = rosterInput.value; rerender(); });
    // COMM-228's own restore-focus-and-caret pattern (communityPeopleSearch,
    // afterRenderCommunity()): a rerender replaces the box being typed
    // into, dropping focus and the caret. This filters on every keystroke
    // rather than debouncing, so without this a second character could
    // never be typed - the first keystroke's rerender leaves the input
    // unfocused before the next one lands.
    if (rosterInput && rosterInput.value && (!document.activeElement || document.activeElement === document.body)) {
      try { rosterInput.focus(); rosterInput.setSelectionRange(rosterInput.value.length, rosterInput.value.length); } catch (e) {}
    }
    // COMM-321. Same per-element wiring shape as the privacy toggles in
    // afterRenderCommunity() - persists on change, no save button. Moved
    // here (not duplicated) since renderClubModulesPanel() only renders on
    // the Manage tab's "settings" sub-tab now.
    document.querySelectorAll("[data-club-feature]").forEach((el) => {
      el.addEventListener("change", () => toggleClubFeature(el.dataset.clubFeature, el.checked));
    });
    // COMM-154. The audit view is lazy: fetched the first time an analytics
    // holder lands on the tab renderAuditLog() lives on. Every one of the
    // four gates below moved with its section in the three-tab rework - the
    // sub-tab NAMES changed, the permissions and the RPCs did not.
    if (mt === "moderation" && hasPerm(PERM.ANALYTICS_VIEW) && !state.admin.auditLoaded && !state.admin.auditLoading) loadAuditLog(true);
    // COMM-310. Same lazy pattern: the dashboard's default period (this ISO
    // week) is fetched the first time an analytics holder or real admin
    // lands on the tab the analytics area now sits in.
    if (mt === "moderation" && (hasPerm(PERM.ANALYTICS_VIEW) || isAdmin()) && !state.analytics.dashboard.loaded && !state.analytics.dashboard.loading) loadAdminAnalyticsDashboard();
    // COMM-313. Same lazy pattern, its OWN gate: real is_admin() alone, not
    // the ANALYTICS_VIEW-or-admin pair the load just above uses - so a
    // community.analytics.view holder who is not an admin never even
    // triggers the three retention RPCs, matching that this section must
    // not render for them at all.
    if (mt === "moderation" && isAdmin() && !state.analytics.retention.loaded && !state.analytics.retention.loading) loadRetentionCorrelations();
    // COMM-312. Same lazy pattern and same is_admin()-only gate as COMM-313's
    // load just above, its own independent trigger. Fires on "members" now:
    // the health score is the headline of the club-overview tab.
    if (mt === "members" && isAdmin() && !state.analytics.health.loaded && !state.analytics.health.loading) loadCommunityHealth();
    // COMM-376. Same lazy pattern, each panel gated on the exact permission
    // its own RPC needs - a coach who only holds community.member.invite
    // triggers the per-person load and never the shared-code one.
    if (mt === "invites" && (hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin()) && !state.admin.inviteCodes.loaded && !state.admin.inviteCodes.loading) loadInviteCodes();
    if (mt === "invites" && (hasPerm(PERM.MEMBER_INVITE) || isAdmin()) && !state.admin.invites.loaded && !state.admin.invites.loading) loadInvites(true);
    // COMM-377. is_staff(), matching admin_member_roster's own looser AUTH.
    if (mt === "members" && isStaff() && !state.admin.roster.loaded && !state.admin.roster.loading) loadRoster(true);
    // Five-persona UX audit, defect 3. Same lazy pattern, same is_staff()
    // gate as the roster above - admin_incomplete_signups shares that AUTH
    // exactly, so a coach triggers this load and simply gets no reclaim
    // controls in the rows it renders.
    // Follows renderIncompleteSignups() onto the "הוספת חבר/ה" tab; same
    // is_staff() gate as the roster above, which admin_incomplete_signups
    // shares exactly, so a coach triggers this load and simply gets no
    // reclaim controls in the rows it renders.
    if (mt === "invites" && isStaff() && !state.admin.incompleteSignups.loaded && !state.admin.incompleteSignups.loading) loadIncompleteSignups(true);
    // The one-shot scroll set by setManageTab(tab, scrollTo). Consumed here,
    // after the new markup exists, and cleared whether or not the target was
    // found so a section that failed to render cannot leave a scroll pending
    // for the next unrelated re-render. scrollIntoView is feature-detected:
    // jsdom does not implement it.
    if (state.ui.manageScrollTo) {
      const target = document.getElementById(state.ui.manageScrollTo);
      state.ui.manageScrollTo = "";
      // manageAdminArea()'s five areas are now <details>, closed by default
      // except moderation - a jump-row tap has to open its target before
      // scrolling to it, or it lands on a collapsed row showing nothing.
      // `"open" in target` is false for the plain manageArea() divs
      // (roster, on the "members" tab), so this is a no-op there. Also
      // recorded into state.admin.openAreas (fresh-eyes audit) - setting
      // only the DOM property here left the very next unrelated rerender()
      // free to collapse it straight back, since manageAdminArea() had no
      // record that a jump had opened it.
      if (target && "open" in target) { target.open = true; state.admin.openAreas[target.id] = true; }
      if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
    }
    // Fresh-eyes audit: captures every native open/close (a direct summary
    // click, not only the jump row above) into state.admin.openAreas so
    // manageAdminArea() can honor it on the next render - see that
    // function's own comment and state.admin.openAreas' declaration for
    // why this has to exist at all. One delegated listener per re-render
    // is deliberate and cheap: there are at most five of these elements,
    // and the alternative (a module-level listener with no element to
    // remove it from between renders) risks firing against a detached node.
    document.querySelectorAll(".manage-area").forEach((el) => {
      el.addEventListener("toggle", () => { state.admin.openAreas[el.id] = el.open; });
    });
    // 202609220002. The per-module threshold disclosures, same persistence
    // and the same store. Without it, saving a value rerenders the panel and
    // the fields an admin is working in fold shut under them.
    document.querySelectorAll(".club-module-settings").forEach((el) => {
      el.addEventListener("toggle", () => { state.admin.openAreas[el.id] = el.open; });
    });
    // Same persistence, deliberately NOT the .manage-area class - see
    // renderInviteManagement()'s own comment for why this one disclosure
    // keeps its own styling instead of adopting that system's look.
    const sharedCodeDetails = document.getElementById(SHARED_CODE_DISCLOSURE_ID);
    if (sharedCodeDetails) sharedCodeDetails.addEventListener("toggle", () => { state.admin.openAreas[sharedCodeDetails.id] = sharedCodeDetails.open; });
  };
  // ===================================================================
  // THE DESKTOP STAFF COLUMNS
  // ===================================================================
  // Two exported renderers - the centre column and the "needs attention"
  // rail - and one loader. Everything they draw is an existing section
  // renderer or an existing RPC; nothing here adds a table, a column, a
  // policy or a screen. The point of the desktop shell is that a coach can
  // see at once what a phone makes them tab between, not that there is more
  // to see.
  //
  // WHY THESE LIVE IN cloud.js. Every one of them reads state and the
  // Supabase client, both private to this file's IIFE. app.js owns where the
  // columns go; this owns what is in them.

  // ---- The week strip -------------------------------------------------
  // club_wod_boards(p_from, p_to) ALREADY takes a range - it is the same
  // function the club home's today-strip calls with no arguments - and it
  // clamps anything wider than 14 days itself. So a week costs one call to a
  // function that already exists, and a day with no board is simply a day
  // the answer does not mention.
  //
  // SUNDAY-FIRST, because that is the week an Israeli gym programmes
  // against. The ISO week starts on Monday and would file a Sunday session
  // in the week that just ended.
  function staffWeekDates() {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const sunday = new Date(base);
    sunday.setDate(sunday.getDate() - sunday.getDay());
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    return out;
  }
  async function loadStaffWeekBoards() {
    if (!state.user || !isStaff() || !isModuleEnabled("club_wod")) return;
    const dates = staffWeekDates();
    state.club.weekBoardsLoading = true;
    const { data, error } = await client.rpc("club_wod_boards", { p_from: dates[0], p_to: dates[6] });
    state.club.weekBoardsLoading = false;
    state.club.weekBoardsLoaded = true;
    // A FAILED READ IS NOT AN EMPTY WEEK - the same rule
    // renderClubWodTodayStrip() already states for a single day. On failure
    // the previous answer is left alone and the strip says so.
    state.club.weekBoardsError = !!error;
    if (!error) state.club.weekBoards = data || [];
    rerender();
  }
  function renderStaffWeekStrip() {
    if (!isModuleEnabled("club_wod")) return "";
    const dates = staffWeekDates();
    const today = todayIso();
    const byDate = {};
    for (const b of state.club.weekBoards || []) {
      if (b && b.session_date) (byDate[b.session_date] = byDate[b.session_date] || []).push(b);
    }
    if (state.club.weekBoardsError) {
      return `<div class="chart-card" style="margin-bottom:12px;"><div class="empty" role="alert">לא ניתן היה לטעון את השבוע.<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="chip-btn" data-community-action="staff-week-retry">ניסיון חוזר</button></div></div></div>`;
    }
    const cells = dates.map((iso) => {
      const boards = byDate[iso] || [];
      const published = boards.length > 0;
      const d = new Date(`${iso}T00:00:00`);
      const dayName = isNaN(d.getTime()) ? "" : d.toLocaleDateString("he-IL", { weekday: "short" });
      const dayNum = isNaN(d.getTime()) ? iso : d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
      // The state word is rendered, not only the colour: a strip that says
      // what it means is legible to a colour-blind coach and to a screen
      // reader alike.
      const label = published ? (boards[0].wod ? boards[0].wod.name : "פורסם") : "אין אימון";
      return `<div class="staff-week-day${published ? " is-published" : ""}"${iso === today ? ' aria-current="date"' : ""}>
        <span class="staff-week-when">${esc(dayName)} · ${esc(dayNum)}</span>
        <span class="staff-week-what">${published ? bidiText(String(label)) : esc(label)}</span>
      </div>`;
    }).join("");
    const published = dates.filter((iso) => byDate[iso]).length;
    return `<div class="chart-card" style="margin-bottom:12px;">
      <div class="flex" style="justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <span style="font-weight:800;">השבוע</span>
        <span style="color:var(--steel);font-size:12px;">${esc(`${published} מתוך 7 ימים`)}</span>
      </div>
      <div class="staff-week">${cells}</div>
    </div>`;
  }

  // ---- The centre column ----------------------------------------------
  // Today's board and the publish form, the week, the roster, the
  // announcements - in that order, because it is the order a coach opening a
  // laptop in the gym asks about them.
  window.renderStaffHome = function () {
    if (!isStaff()) return `<div class="empty">אין הרשאה</div>`;
    const liveAnnouncements = state.club.announcements.filter((a) => !isAnnouncementExpired(a));
    const announcements = isModuleEnabled("announcements")
      ? `<div class="ach-section">${sectionHead("var(--brass)", "הודעות מהמועדון")}${renderAnnouncementsArchive(liveAnnouncements, false, "staff_home")}</div>`
      : "";
    return `<div class="staff-home">
      <h1 class="page-title">לוח המכון</h1>
      ${renderClubWodTodayStrip()}
      ${renderStaffWeekStrip()}
      <div class="ach-section">${sectionHead("var(--teal)", "חברי המועדון")}${renderDirectorySection()}</div>
      ${announcements}
    </div>`;
  };

  // ---- The context column ---------------------------------------------
  // "דורש תשומת לב" - the rail is the one place on this screen that is
  // allowed to be a to-do list, so everything in it is something a coach can
  // act on today: a member the engagement flags have noticed, someone to
  // congratulate, someone new to welcome, and a moderation queue with
  // anything open in it.
  //
  // Every section here is the SAME renderer the coach dashboard uses on a
  // phone, so an action taken in the rail and the same action taken on the
  // phone go through one code path, not two.
  window.renderStaffContextColumn = function () {
    if (!isStaff()) return "";
    // pendingModerationCount() consults has_perm(community.comment.moderate)
    // itself and answers 0 for anyone without it, so a coach who does not
    // moderate simply has one fewer row rather than a forbidden link.
    const open = pendingModerationCount();
    const queue = open
      ? `<button class="log-row" data-action="switch-tab" data-tab="manage" style="width:100%;text-align:start;">
           <span style="font-weight:700;">תורי דיווחים</span>
           <span class="nav-badge" aria-hidden="true">${open}</span>
           <span class="sr-only">${esc(open === 1 ? "דיווח אחד פתוח" : open + " דיווחים פתוחים")}</span>
         </button>`
      : "";
    const sections = [
      // 202609220002, first in the rail. "דורש תשומת לב" is the one place on
      // this screen allowed to be a to-do list, and this is the only section
      // in it that literally is one.
      renderCoachTasksSection(),
      state.featureFlags.coachEngage ? renderCoachEngageSection() : "",
      renderCoachCelebrateSection(),
      renderCoachWelcomeSection(),
    ].filter(Boolean).join("");
    return `<h2 class="context-col-head">דורש תשומת לב</h2>${queue}${sections}`;
  };

  // The lazy loads the rail needs, in the same shape afterRenderCommunity()
  // uses for the coach sub-tab: fetched the first time a coach actually
  // lands on the screen, never on a session that does not open it. Called by
  // app.js after it renders the staff home.
  window.staffHomeAfterRender = function () {
    if (!state.user || !isStaff()) return;
    if (!state.coach.tasks.loaded && !state.coach.tasks.loading) loadCoachTasks();
    if (!state.coach.celebrate.loaded && !state.coach.celebrate.loading) loadCoachCelebrate();
    if (!state.coach.welcome.loaded && !state.coach.welcome.loading) loadCoachWelcome();
    if (state.featureFlags.coachEngage && !state.coach.engage.loaded && !state.coach.engage.loading) loadCoachEngageFlags();
    if (!state.club.weekBoardsLoaded && !state.club.weekBoardsLoading) loadStaffWeekBoards();
    if (!state.members.directory.loaded && !state.members.directory.loading) loadDirectory(true);
  };

  window.handleCommunityClick = function (el) {
    const action = el.dataset.communityAction;
    // COMM-114. Measured before the action runs, so a click that navigates
    // away or re-renders the card still records. Nothing here can throw into
    // the action itself and nothing awaits it.
    trackFeedClick(el);
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
    else if (action === "avatar-remove") removeAvatarPhoto();
    else if (action === "cheer") react(el.dataset.id);
    else if (action === "report") report(el.dataset.id);
    else if (action === "publish") {
      const fileInput = document.getElementById("photo-" + el.dataset.id);
      const file = fileInput && fileInput.files && fileInput.files[0];
      const item = typeof window.communityShareCandidateFor === "function" ? window.communityShareCandidateFor(el.dataset.type, el.dataset.id) : null;
      const audience = el.dataset.visibility === "public" ? "לכולם, פומבי" : "לעוקבים שלכם בלבד";
      const preview = item ? `"${item.title}" — ${item.resultText}${file ? " (כולל תמונה)" : ""}` : "";
      askConfirm({ title: "פרסום תוצאה", message: `לפרסם ${audience}?${preview ? " " + preview : ""}`, confirmLabel: "פרסום", action: "publish", payload: { type: el.dataset.type, id: el.dataset.id, visibility: el.dataset.visibility, file } });
    }
    else if (action === "follow") follow(el.dataset.id);
    // COMM-231 members directory.
    else if (action === "directory-retry") loadDirectory(true);
    else if (action === "directory-more") loadDirectory(false);
    else if (action === "block") askConfirm({ title: "חסימת משתמש", message: "לחסום את {subject}? לא תראו זה את זה בקהילה.", subject: subjectNameFor(el.dataset.id), confirmLabel: "חסימה", destructive: true, action: "block", payload: { userId: el.dataset.id } });
    // Live bug hunt (2026-09-11): unblock()'s dispatch - no confirm sheet,
    // same "no confirm needed for a reversible toggle" shape the club-module
    // toggles already use (block() itself still confirms - it's the one
    // that actually cuts off interaction).
    else if (action === "unblock") unblock(el.dataset.id);
    else if (action === "delete-post") askConfirm({ title: "הסרת שיתוף", message: "להסיר את השיתוף מהפיד? הפעולה לא ניתנת לביטול.", confirmLabel: "הסרה", destructive: true, action: "delete-post", payload: { postId: el.dataset.id } });
    else if (action === "compare") compare(el.dataset.key, el.dataset.id);
    else if (action === "delete-account") askConfirm({ title: "מחיקת חשבון", message: "הפרופיל והשיתופים יוסרו מיד. המחיקה הסופית תתבצע לאחר 30 יום. להמשיך?", confirmLabel: "מחיקה", destructive: true, action: "delete-account" });
    else if (action === "share-achievement") publishAchievement(el.dataset.id, el.dataset.title, el.dataset.rule);
    else if (action === "toggle-comments") toggleComments(el.dataset.id);
    else if (action === "delete-comment") askConfirm({ title: "מחיקת תגובה", message: "למחוק את התגובה? הפעולה לא ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "delete-comment", payload: { commentId: el.dataset.id, postId: el.dataset.post } });
    else if (action === "comment-reply") { const p = el.dataset.post; state.engagement.replyTo[p] = state.engagement.replyTo[p] === el.dataset.id ? null : el.dataset.id; if (state.engagement.replyTo[p]) state.engagement.openReplies[el.dataset.id] = true; rerender(); }
    else if (action === "toggle-replies") { const id = el.dataset.id; if (state.engagement.openReplies[id]) delete state.engagement.openReplies[id]; else state.engagement.openReplies[id] = true; rerender(); }
    else if (action === "comment-edit") startCommentEdit(el.dataset.id, el.dataset.post);
    else if (action === "comment-edit-save") saveCommentEdit();
    else if (action === "comment-edit-cancel") cancelCommentEdit();
    else if (action === "comment-retry") retryComment(el.dataset.post, el.dataset.parent || null);
    else if (action === "report-comment") reportComment(el.dataset.id);
    else if (action === "report-profile") reportProfile(el.dataset.id);
    else if (action === "mention-pick") mentionPick(el.dataset.key, el.dataset.id, el.dataset.name);
    else if (action === "set-tab") setCommunityTab(el.dataset.tab);
    else if (action === "set-manage-tab") setManageTab(el.dataset.tab, el.dataset.scroll);
    else if (action === "verify-recovery") verifyRecovery({ force: true });
    else if (action === "hide-my-leaderboard-result") savePrivacyField("in_leaderboards", false);
    // COMM-210/211/212 leaderboards. Note the deliberate split from the line
    // above: that one is the real, server-enforced opt-out (in_leaderboards);
    // these only change what this device fetches and draws.
    else if (action === "leaderboard-scope") setLeaderboardScope(el.dataset.scope);
    else if (action === "leaderboard-retry") loadConsistencyLeaderboard();
    else if (action === "challenge-board-scope") setChallengeBoardScope(el.dataset.scope);
    else if (action === "challenge-board-retry") { if (state.challenges.view) loadChallengeBoard(state.challenges.view.id, { rerender: true }); }
    else if (action === "challenge-board-full") expandChallengeBoard();
    // COMM-212 / COMM-231. The friends-scope empty state routes to the
    // members directory now that it exists, rather than the Account tab's
    // bare search box.
    else if (action === "leaderboard-find-people") { directoryEntrySource = "leaderboard"; setCommunityTab("directory"); }
    // COMM-232 suggestions strip.
    else if (action === "suggestion-follow") followSuggestion(el.dataset.id);
    // ---- Club WOD sessions and boards (202609080002) --------------------
    else if (action === "open-club-wod-board") openClubWodBoard(el.dataset.id);
    else if (action === "close-club-wod-board") closeClubWodBoard();
    // The one retry in this feature that CAN succeed - a dropped read, not a
    // refused write. Every refusal below is a stable state and offers no such
    // button; see SERVER_ERROR_TEXT's club WOD block.
    else if (action === "club-wod-retry") loadClubWodBoards().then(rerender);
    // The record id and the entry both come from app.js's own log, which is
    // the only place that knows whether this member logged this WOD.
    else if (action === "club-wod-attach") {
      const entry = clubWodEntryById(el.dataset.record);
      attachClubWodResult(el.dataset.id, el.dataset.record, entry);
    }
    else if (action === "club-wod-detach") detachClubWodResult(el.dataset.id);
    else if (action === "club-wod-cancel-confirm") askConfirm({
      title: "ביטול האימון של היום",
      message: "הכרטיס יוסר מהפיד והלוח ייסגר לצירוף תוצאות. שום תוצאה לא נמחקת — מי שכבר צירף נשאר על הלוח, ואם תקבעו את האימון מחדש הלוח חוזר איתו.",
      confirmLabel: "ביטול האימון", destructive: true,
      action: "club-wod-cancel", payload: { sessionId: el.dataset.id },
    });
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
    // COMM-151 report sheet.
    else if (action === "report-close") closeReportSheet();
    else if (action === "report-submit") submitReportSheet();
    // COMM-152/153 moderation queue.
    else if (action === "mod-queue-status") setModQueueStatus(el.dataset.status);
    else if (action === "mod-queue-retry") loadModQueue();
    else if (action === "mod-context") openModContext(el.dataset.id);
    else if (action === "mod-context-close") closeModContext();
    else if (action === "mod-context-open-feed") { closeModContext(); if (typeof window.switchToCommunityTopTab === "function") window.switchToCommunityTopTab(); setCommunityTab("feed"); }
    else if (action === "mod-action") openModAction(el.dataset.id, el.dataset.decision);
    else if (action === "mod-action-cancel") closeModAction();
    else if (action === "mod-action-run") runModAction();
    else if (action === "mod-action-days") { if (state.admin.modAction) { state.admin.modAction.days = Number(el.dataset.days) || 7; rerender(); } }
    // COMM-154 audit view.
    else if (action === "audit-filter") setAuditFilter("action_type", el.dataset.type || "");
    else if (action === "audit-more") loadAuditLog(false);
    else if (action === "audit-retry") loadAuditLog(true);
    // COMM-310 admin community analytics dashboard.
    else if (action === "admin-analytics-mode") setAdminAnalyticsMode(el.dataset.mode);
    else if (action === "admin-analytics-shift") shiftAdminAnalyticsPeriod(Number(el.dataset.dir) || 1);
    else if (action === "admin-analytics-retry") loadAdminAnalyticsDashboard();
    // COMM-311 member engagement segmentation.
    else if (action === "member-segments-toggle") toggleMemberSegment(el.dataset.segment);
    else if (action === "member-segments-retry") loadMemberSegments();
    // COMM-313 retention correlation views.
    else if (action === "retention-retry") loadRetentionCorrelations();
    else if (action === "retention-toggle-onboarding") toggleRetentionOnboardingOverlay();
    else if (action === "retention-toggle-welcome") toggleRetentionWelcomeOverlay();
    else if (action === "retention-onboarding-step") setRetentionOnboardingStep(el.dataset.step);
    // COMM-312 community health score.
    else if (action === "community-health-retry") loadCommunityHealth();
    // Closes the management session by hand - see the lock button in
    // renderManagePanel(). Tears down BOTH panels and the second Supabase
    // client with them, because the session is the thing being ended, not one
    // screen's view of it.
    else if (action === "panel-lock") { mgmtTeardown(); setMessage("ננעל"); rerender(); }
    else if (action === "mgmt-password-open") { state.admin.mgmtPasswordOpen = true; state.admin.mgmtPasswordError = ""; setFieldErrors("mgmtPassword", {}); }
    else if (action === "mgmt-password-cancel") { state.admin.mgmtPasswordOpen = false; state.admin.mgmtPasswordError = ""; setFieldErrors("mgmtPassword", {}); }
    // COMM-379 registration funnel analytics.
    else if (action === "registration-funnel-retry") loadRegistrationFunnel();
    // COMM-378 onboarding step content editor.
    else if (action === "onboarding-content-retry") loadOnboardingStepContent().then(rerender);
    else if (action === "onboarding-content-save") saveOnboardingContent(el.dataset.step);
    // Redesign, Phase 3.
    else if (action === "intro-content-retry") loadIntroCarouselContent();
    else if (action === "intro-content-save") saveIntroCarouselContent(el.dataset.step);
    else if (action === "intro-carousel-next") introCarouselNext();
    else if (action === "intro-carousel-back") introCarouselBack();
    // COMM-376 invite and code management.
    else if (action === "invite-code-toggle-active") setInviteCodeActive(el.dataset.id, el.dataset.active === "1");
    else if (action === "copy-invite-code") copyInviteCode(el.dataset.code);
    // A WAY BACK TO THE QR. openInviteQr() used to be reachable from exactly
    // two moments - the instant a shared code or a per-person invite was
    // created - and from nowhere else. The card those buttons sit on says
    // "זו הפעם היחידה שהוא יוצג", so a coach who closed the QR sheet before
    // sending it had no route back: the only recovery was to issue a second
    // invite and leave a stray one behind. A one-shot, unrecoverable moment
    // is a poor thing to put between a coach and a new member.
    else if (action === "reopen-invite-qr") openInviteQr(el.dataset.code, el.dataset.kind);
    else if (action === "lift-restriction") liftRestriction(el.dataset.id);
    else if (action === "restrictions-retry") loadRestrictions();
    // The joining QR. Every one of these reads the code/link off state rather
    // than off the element, except the two copy actions, which need the
    // exact string the button is sitting next to.
    else if (action === "copy-invite-link") copyInviteLink(el.dataset.link);
    else if (action === "invite-qr-share") shareInviteQr();
    else if (action === "invite-qr-print") printInviteQr();
    else if (action === "invite-qr-download") downloadInviteQr();
    else if (action === "invite-qr-retry") refreshInviteQr();
    else if (action === "invite-qr-close") closeInviteQr();
    else if (action === "dismiss-invite-code-created") dismissInviteCodeCreated();
    else if (action === "dismiss-invite-created") dismissInviteCreated();
    else if (action === "invite-status-filter") setInviteStatusFilter(el.dataset.status);
    else if (action === "invite-list-retry") loadInvites(true);
    // Its sibling's retry. loadInviteCodes() marks itself loaded even on
    // failure, so the lazy-load guard will not re-fire: the reset has to be
    // explicit or the button would do nothing.
    else if (action === "invite-codes-retry") { state.admin.inviteCodes.loaded = false; loadInviteCodes(); }
    else if (action === "invite-list-more") loadInvites(false);
    else if (action === "invite-revoke") askConfirm({ title: "ביטול הזמנה", message: "לבטל את ההזמנה של {subject}? היא לא תהיה ניתנת עוד למימוש.", subject: inviteSubjectName(el.dataset.id), confirmLabel: "ביטול ההזמנה", destructive: true, action: "admin-invite-revoke", payload: { inviteId: el.dataset.id } });
    // COMM-377 member roster.
    else if (action === "roster-retry") loadRoster(true);
    else if (action === "roster-more") loadRoster(false);
    // Five-persona UX audit, defect 3. ghost-reclaim opens the sheet rather
    // than acting: it is the only control here that changes anything, and it
    // is the one that has to name its subject first.
    else if (action === "ghosts-retry") loadIncompleteSignups(true);
    else if (action === "ghosts-more") loadIncompleteSignups(false);
    else if (action === "ghost-reclaim") openGhostReclaim(el.dataset.id);
    else if (action === "reclaim-cancel") closeGhostReclaim();
    else if (action === "reclaim-run") runGhostReclaim();
    else if (action === "reclaim-result-close") { state.admin.reclaimResult = null; rerender(); }
    // COMM-155 pins.
    else if (action === "unpin") unpinTarget(el.dataset.type, el.dataset.id);
    else if (action === "pin") pinTarget(el.dataset.type, el.dataset.id, el.dataset.note || "");
    // COMM-156 role management.
    else if (action === "admin-set-role") {
      const role = el.dataset.role;
      const label = { member: "חבר/ה", coach: "מאמן/ת", head_coach: "מאמן/ת ראשי/ת" }[role] || role;
      // Defect 1, second asymmetry in the same control set: head_coach ->
      // coach is a DOWNGRADE, and it used to open the same "להעניק הרשאת…"
      // ("grant") dialog as a promotion, non-destructive styling included.
      // The current role decides which sentence and which styling is shown.
      const current = (subjectRecordFor(el.dataset.id) || {}).role || memberRole(el.dataset.id) || "member";
      const isDowngrade = role === "coach" && current === "head_coach";
      if (role === "member") askRevokeCoachConfirm(el.dataset.id);
      else if (isDowngrade) askConfirm({ title: "הורדת הרשאה", message: "להוריד את {subject} ממאמן/ת ראשי/ת למאמן/ת?", subject: subjectNameFor(el.dataset.id), confirmLabel: "הורדה", destructive: true, action: "admin-set-role", payload: { userId: el.dataset.id, role } });
      else askConfirm({ title: "שינוי הרשאה", message: `להעניק ל{subject} הרשאת ${label}?`, subject: subjectNameFor(el.dataset.id), confirmLabel: "הענקה", action: "admin-set-role", payload: { userId: el.dataset.id, role } });
    }
    else if (action === "admin-grant-coach") askConfirm({ title: "הענקת הרשאת מאמן/ת", message: "להעניק ל{subject} הרשאת מאמן/ת?", subject: subjectNameFor(el.dataset.id), confirmLabel: "הענקה", action: "admin-grant-coach", payload: { userId: el.dataset.id } });
    else if (action === "admin-revoke-coach") askRevokeCoachConfirm(el.dataset.id);
    else if (action === "admin-remove-member") askConfirm({ title: "הסרת חבר/ה", message: "להסיר את {subject} מהמועדון? הפרופיל והשיתופים יוסרו מיד, והמחיקה הסופית תתבצע לאחר 30 יום.", subject: subjectNameFor(el.dataset.id), confirmLabel: "הסרה", destructive: true, action: "admin-remove-member", payload: { userId: el.dataset.id } });
    else if (action === "admin-reset-password") askConfirm({ title: "איפוס סיסמה", message: "לאפס את הסיסמה של {subject}? הסיסמה הנוכחית תפסיק לעבוד מיד, ותיווצר סיסמה זמנית שתוצג פעם אחת בלבד - יש למסור אותה לחבר/ה ישירות (לא דרך האפליקציה).", subject: subjectNameFor(el.dataset.id), confirmLabel: "איפוס", destructive: true, action: "admin-reset-password", payload: { userId: el.dataset.id } });
    else if (action === "close-password-reset-result") { state.admin.passwordResetResult = null; rerender(); }
    else if (action === "toggle-share") toggleShare(el.dataset.type, el.dataset.id);
    else if (action === "open-composer") openComposer(el);
    else if (action === "composer-cancel") tryCloseComposer();
    else if (action === "composer-publish") publishComposer();
    else if (action === "composer-remove-photo") composerRemovePhoto(el.dataset.id);
    else if (action === "composer-retry-photo") composerRetryPhoto(el.dataset.id);
    else if (action === "toggle-post-menu") togglePostMenu(el.dataset.id);
    else if (action === "post-save") postSaveToggle(el.dataset.id);
    else if (action === "post-hide") postHide(el.dataset.id);
    else if (action === "post-edit-caption") postStartCaptionEdit(el.dataset.id);
    else if (action === "caption-cancel") { state.posts.captionEdit = null; rerender(); }
    else if (action === "caption-save") postSaveCaption();
    else if (action === "post-change-visibility") postStartVisibilityEdit(el.dataset.id);
    else if (action === "visibility-pick") postApplyVisibility(el.dataset.value);
    else if (action === "visibility-cancel") { state.posts.visibilityEdit = null; rerender(); }
    else if (action === "post-delete") askConfirm({ title: "מחיקת פוסט", message: "הפוסט יוסר מהפיד. הפעולה אינה ניתנת לביטול מיידי.", confirmLabel: "מחיקה", destructive: true, action: "post-delete-rpc", payload: { postId: el.dataset.id } });
    else if (action === "welcome-member") welcomeNewMember(el.dataset.id, "feed_card");
    else if (action === "view-profile") viewCommunityProfile(el.dataset.id);
    else if (action === "close-profile") closeCommunityProfile();
    else if (action === "profile-tab") setProfileViewTab(el.dataset.tab);
    // COMM-230 following surface.
    else if (action === "following-toggle") toggleFollowListSection(el.dataset.side);
    else if (action === "following-retry") retryFollowList(el.dataset.side);
    else if (action === "following-unfollow") unfollowFromFollowingList(el.dataset.id);
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
    else if (action === "feed-scope") setFeedScope(el.dataset.scope);
    else if (action === "feed-load-more") loadMoreFeed();
    else if (action === "feed-retry") { state.feed.pagesLoaded = 0; loadFeed().then(rerender); rerender(); }
    // COMM-140..142 notification centre.
    else if (action === "feed-notifications") openNotifCenter();
    else if (action === "notif-close") closeNotifCenter();
    else if (action === "notif-retry") fetchNotifPage(true);
    else if (action === "notif-load-more") loadMoreNotifs();
    else if (action === "notif-show-older") notifShowOlder();
    else if (action === "notif-mark-all") markAllNotifsRead();
    else if (action === "bugs-retry") loadBugReports(true);
    else if (action === "bugs-filter") { state.admin.bugsStatus = el.dataset.status || "open"; state.admin.bugsLoaded = false; loadBugReports(true); }
    else if (action === "bugs-set-status") setBugReportStatus(el.dataset.id, el.dataset.status);
    else if (action === "notif-open") openNotif(el.dataset.id);
    else if (action === "notif-toggle-group") { const c = state.notif.center; if (c) { c.expanded[el.dataset.key] = !c.expanded[el.dataset.key]; rerender(); } }
    else if (action === "notif-pref") setNotifPref(el.dataset.type, el.dataset.channel);
    else if (action === "notif-push-disable") disableNotifPush();
    // The self-test is a click and nothing else reaches it, which is half of
    // what makes "never asked on first load" true of the permission prompt
    // it may raise.
    else if (action === "notif-push-self-test") runPushSelfTest();
    // COMM-201/207. The club-top shortcut opens the real challenge detail
    // when club_summary handed back an id; a missing id (an older/failed
    // club_summary read) still lands the member on the Boards sub-tab
    // rather than a broken dialog.
    // No data-id means a WEEKLY challenge, which lives on the Boards tab and
    // has no `challenges` row for openChallenge() to fetch - sending one there
    // is what produced the 400 with nothing on screen. See the club-strip
    // comment in renderCommunityFeed for why the attribute is omitted.
    else if (action === "open-active-challenge") { if (el.dataset.id) openChallenge(el.dataset.id, "club_top"); else setCommunityTab("boards"); }
    // COMM-201/207. openChallenge() itself records CHALLENGE_VIEWED, so the
    // POST_CHALLENGE link card's own tap passes "post_card" through.
    // COMM-228. A search result carries data-source="search" so the same
    // action records where the member came from; anything without one is
    // the POST_CHALLENGE link card it was written for.
    // COMM-233. Which is why the Boards list cards now carry an explicit
    // data-source="boards": they had none, so every challenge opened from
    // the Boards sub-tab was recorded as a post_card open. Only the link
    // card inside a feed post is allowed to rely on the default.
    else if (action === "open-challenge") { if (el.dataset.id) openChallenge(el.dataset.id, el.dataset.source || "post_card"); }
    else if (action === "close-challenge-view") closeChallengeView();
    else if (action === "join-challenge") joinChallenge(el.dataset.id, "boards");
    else if (action === "leave-challenge") confirmLeaveChallenge(el.dataset.id);
    else if (action === "challenge-pick-team") pickChallengeTeam(el.dataset.id, el.dataset.team);
    // COMM-308. Team management: create/rename/delete direct-RLS on
    // challenge_teams (renameChallengeTeam/deleteChallengeTeam read the
    // team id off data-id, the same shape challenge-coach-submit already
    // uses to pick one row out of a roster). Reassign and set-captain are
    // wired off the "change" listener below (their controls are <select>s,
    // not buttons), the same immediate-on-change shape composerVisibility
    // already uses for its own <select>.
    else if (action === "challenge-team-create") createChallengeTeam();
    else if (action === "challenge-team-rename") renameChallengeTeam(el.dataset.id);
    else if (action === "challenge-team-delete") confirmDeleteChallengeTeam(el.dataset.id);
    else if (action === "challenge-log-submit") submitChallengeLog();
    else if (action === "challenge-log-week-hit") logConsistencyWeekHit();
    else if (action === "challenge-coach-submit") submitCoachEntry(el.dataset.id);
    else if (action === "share-challenge-progress") shareChallengeProgress();
    else if (action === "challenges-retry") loadChallenges();
    else if (action === "open-challenge-form") openChallengeForm(null);
    else if (action === "challenge-edit") { const existing = state.challenges.items.find((x) => x.id === el.dataset.id) || (state.challenges.view && state.challenges.view.challenge); openChallengeForm(existing); }
    else if (action === "challenge-form-cancel") closeChallengeForm();
    else if (action === "challenge-form-type") setChallengeFormType(el.dataset.type);
    else if (action === "challenge-publish") publishChallengeDraft(el.dataset.id);
    // Archiving used to fire straight off the click with no dialog, the same
    // defect the coach-revoke button had: the destructive direction asked
    // nothing while the harmless ones asked. Both run through askConfirm now.
    else if (action === "challenge-archive") askConfirm({ title: "סיום האתגר", message: "לסיים את \"{subject}\"? האתגר יעבור ל\"אתגרים שהסתיימו\", וההתקדמות של כל המשתתפים נשמרת.", subject: challengeTitleFor(el.dataset.id), confirmLabel: "סיום", action: "challenge-archive", payload: { id: el.dataset.id } });
    else if (action === "challenge-delete") askConfirm({ title: "מחיקת האתגר", message: "למחוק את \"{subject}\" לצמיתות? כל ההרשמות, הקבוצות וההתקדמות שנרשמה באתגר יימחקו איתו ואי אפשר לשחזר. כדי לסגור אתגר בלי לאבד נתונים יש להשתמש ב\"סיום האתגר\".", subject: challengeTitleFor(el.dataset.id), confirmLabel: "מחיקה", destructive: true, action: "challenge-delete", payload: { id: el.dataset.id } });
    // THIS BRANCH WAS UNREACHABLE. Both it and the one above tested
    // `action === "challenge-delete"`, so a draft's delete button hit the
    // first: a coach deleting an unpublished draft was warned that "every
    // registration, team and progress entry will be deleted with it" - a
    // draft has none - and pointed at "end the challenge instead", which an
    // unpublished challenge cannot do. Its own copy, written for exactly
    // this case, had never once been shown.
    //
    // It dispatches challenge-delete, not challenge-delete-draft: the delete
    // itself was duplicated too, and deleteChallenge() is the strict superset
    // (same row delete, plus the permission check and the view/cache cleanup
    // that stop the detail screen rendering an error over a deletion that
    // worked). Same gate either way - both routes into this form are already
    // behind CHALLENGE_CREATE.
    else if (action === "challenge-delete-draft") askConfirm({ title: "מחיקת טיוטה", message: "למחוק את הטיוטה? הפעולה אינה ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "challenge-delete", payload: { id: el.dataset.id, draft: true } });
    // COMM-213/217/228. openEvent() itself records EVENT_VIEWED (source
    // defaults to "post_card", and COMM-233 labelled the Boards list cards
    // explicitly for the same reason the challenge ones needed it), the
    // same pattern openChallenge() uses -
    // this used to only track and never actually open anything (the gap
    // the realtime+search cluster's handoff notes flagged for COMM-228's
    // search result), now closed by COMM-213's detail dialog existing.
    else if (action === "open-event") { if (el.dataset.id) openEvent(el.dataset.id, el.dataset.source || "post_card"); }
    else if (action === "close-event-view") closeEventView();
    else if (action === "event-rsvp") rsvpEvent(el.dataset.id, el.dataset.response);
    else if (action === "events-retry") loadEvents();
    else if (action === "open-event-form") openEventForm(null);
    else if (action === "event-edit") {
      // The edit button lives inside the eventView overlay, which
      // renderConfirmDialog() mounts globally so an event can be opened
      // from a feed card, search, a recap, or a notification while the
      // Boards sub-tab (or even the Community top-level tab) isn't
      // active - but the form itself only renders inside Boards'
      // section, so opening it from anywhere else was a silent no-op.
      const existing = state.events.byId[el.dataset.id] || (state.events.view && state.events.view.event);
      state.events.view = null;
      if (typeof window.switchToCommunityTopTab === "function") window.switchToCommunityTopTab();
      setCommunityTab("boards");
      openEventForm(existing);
    }
    else if (action === "event-form-cancel") closeEventForm();
    else if (action === "event-form-type") setEventFormType(el.dataset.type);
    else if (action === "event-publish") publishEventDraft(el.dataset.id);
    else if (action === "event-companion-retry") retryEventCompanionPost(el.dataset.id);
    else if (action === "event-cancel-confirm") confirmCancelEvent(el.dataset.id);
    else if (action === "event-ics") downloadEventIcs(el.dataset.id);
    // COMM-222 onboarding sequence.
    else if (action === "onboarding-dismiss") dismissOnboardingStep(el.dataset.step);
    // COMM-221 weekly recap surface + share.
    else if (action === "open-recap") openRecap(el.dataset.week || null, el.dataset.source || "account");
    else if (action === "close-recap-view") closeRecapView();
    else if (action === "recap-older") recapGoOlder();
    else if (action === "recap-newer") recapGoNewer();
    else if (action === "recap-retry") refreshRecapView(state.recaps.view && state.recaps.view.weekStart);
    else if (action === "share-recap") shareRecapFigure(el.dataset.figure);
    // COMM-223..226 coach-tools cluster.
    else if (action === "coach-celebrate-retry") loadCoachCelebrate();
    else if (action === "coach-congratulate") {
      const item = state.coach.celebrate.items.find((it) => celebrateItemKey(it) === el.dataset.key);
      if (item) congratulateCelebrateItem(item);
    }
    // 202609220002 the onboarding challenge. Two taps, and they are the only
    // two things in the app that can enrol a member in it.
    else if (action === "save-club-feature-config") saveClubFeatureConfig(el.dataset.key);
    else if (action === "onboarding-challenge-accept") onboardingChallengeRespond(true);
    else if (action === "onboarding-challenge-decline") onboardingChallengeRespond(false);
    // 202609220002 coach tasks.
    else if (action === "coach-tasks-retry") { state.coach.tasks.loaded = false; loadCoachTasks(); }
    else if (action === "coach-task-contact") coachTaskContact(el.dataset.id);
    else if (action === "coach-task-dismiss") coachTaskDismiss(el.dataset.id);
    else if (action === "coach-welcome-retry") loadCoachWelcome();
    else if (action === "coach-welcome-member") coachWelcomeMember(el.dataset.id);
    else if (action === "coach-assign-self") coachAssignCoach(el.dataset.id, state.user && state.user.id);
    else if (action === "coach-assign-clear") coachAssignCoach(el.dataset.id, null);
    else if (action === "coach-assign-handle") coachAssignByHandle(el.dataset.id);
    else if (action === "coach-mark-contacted") coachMarkContacted(el.dataset.id);
    // COMM-315 member of the week.
    else if (action === "coach-mow-retry") loadCoachMemberOfWeek();
    else if (action === "coach-mow-publish-candidate") memberOfWeekPublishCandidate(el.dataset.id);
    else if (action === "coach-mow-publish-pick") memberOfWeekPublishPick();
    else if (action === "coach-engage-retry") loadCoachEngageFlags();
    else if (action === "coach-engage-reach-out") coachEngageReachOut(el.dataset.id);
    else if (action === "coach-engage-review") coachEngageResolveFlag(el.dataset.id, "reviewed");
    else if (action === "coach-engage-dismiss") coachEngageResolveFlag(el.dataset.id, "dismissed");
    // COMM-309 monthly club recap.
    else if (action === "staff-week-retry") { state.club.weekBoardsLoaded = false; loadStaffWeekBoards(); }
    else if (action === "coach-monthly-recap-retry") loadCoachMonthlyRecap();
    else if (action === "coach-monthly-recap-publish") publishMonthlyRecap(el.dataset.id);
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
  // Redesign, Phase 1: app.js's getNavItems() needs to know whether to emit
  // the "ניהול" (Manage) bottom-tab item at all - the same isStaff() check
  // renderManageApp() itself re-checks internally (defense in depth against
  // a forced ?tab=manage), just exposed for the nav-item decision.
  window.communityIsStaff = function () { return isStaff(); };
  // app.js's nav registry needs the admin/staff distinction to decide WHICH
  // of the two management destinations to offer (2026-09-15). Navigation
  // only - the real boundary is is_admin()/is_staff() in the database, which
  // every action on either panel goes through regardless of what this says.
  window.communityIsAdmin = function () { return isAdmin(); };
  // The club WOD catalogue's write surface. publishClubWod is what app.js's
  // staff affordance calls; the other three are the correction paths, exposed
  // the same way so the catalogue has one callable API rather than three
  // functions only reachable from inside this closure. All four are
  // staff-gated here and permission-gated again in the database, which is the
  // boundary that actually counts.
  window.publishClubWod = publishClubWod;
  // 202609080002. The club WOD board's write surface, exposed for the same
  // reason publishClubWod is: the control belongs INSIDE the WOD log form,
  // which app.js owns, and attaching has to cost less than composing - so it
  // cannot be a trip to another tab. app.js decides WHETHER to offer it (only
  // it knows whether this member logged this WOD); these decide what happens.
  window.attachClubWodResult = attachClubWodResult;
  window.detachClubWodResult = detachClubWodResult;
  window.openClubWodBoard = openClubWodBoard;
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
  window.editClubWod = editClubWod;
  window.retireClubWod = retireClubWod;
  window.restoreClubWod = restoreClubWod;
  // Redesign, Phase 3 fix: app.js's getNavItems() needs this to badge the
  // Manage bottom-tab nav item - see pendingModerationCount()'s own comment.
  window.communityPendingModerationCount = function () { return pendingModerationCount(); };
  window.shareAchievementToCommunity = function (achievementId, title, rule) { publishAchievement(achievementId, title, rule); };
  // Exported for app.js's Community sub-nav (the UI-restructuring track) so
  // it can switch cloud.js's own sub-tab without re-deriving any of the
  // teardown/analytics logic setCommunityTab already does internally.
  window.setCommunityTab = setCommunityTab;
  // Same track, same reason: the sub-tab ids and labels a non-staff/staff
  // caller actually sees, without app.js re-deriving the staff/module gates
  // itself. Mirrors the real `tabs` array built inline in
  // renderCommunityApp() - same ids, same order, same conditions - but
  // computed standalone (no render bodies) so it is cheap to call on every
  // nav-menu open, not just once per Community render.
  //
  // Redesign, Phase 2 fix: this used to push feed/directory/coach
  // unconditionally (or coach on isStaff() alone), which drifted the
  // instant the real array grew module-flag conditions - the desktop
  // sidebar could then offer a "חברים" entry that does not exist,
  // producing the exact stale-state.ui.tab bug fixed above. Every
  // condition here must stay byte-identical to renderCommunityApp()'s own
  // tabs-array construction.
  window.getCommunityNavPreview = function () {
    const staff = isStaff();
    const tabs = [];
    if (isModuleEnabled("feed")) tabs.push({ id: "feed", label: "פיד" });
    // 202609100002/what's-next follow-up: the real tabs array's own Boards
    // badge (challenges ending within 48h) was missing here, so a member on
    // a 900px+ desktop viewport saw no signal in the sidebar preview until
    // they actually clicked into Community - same computation, byte-for-byte,
    // as renderCommunityApp()'s own boardsBadgeCount just below in this file.
    const boardsBadgeCount = (state.challenges.items || [])
      .filter((c) => c.status === "active" && daysRemaining(c.end_at) !== null && daysRemaining(c.end_at) <= 2).length;
    tabs.push({ id: "boards", label: "לוחות", badge: boardsBadgeCount || undefined });
    if (isModuleEnabled("directory")) tabs.push({ id: "directory", label: "חברים" });
    tabs.push({ id: "account", label: "חשבון" });
    if (isCoachTier() && isModuleEnabled("coach_tools")) tabs.push({ id: "coach", label: "לוח מאמנים" });
    return tabs;
  };
  document.addEventListener("submit", (event) => {
    if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); }
    else if (event.target.id === "communityAnnouncement") { event.preventDefault(); postAnnouncement(event.target); }
    else if (event.target.id === "communityWeeklyChallenge") { event.preventDefault(); setWeeklyChallenge(event.target); }
    else if (event.target.id === "communityInviteCodeCreate") { event.preventDefault(); createInviteCode(event.target); }
    else if (event.target.id === "communityInviteCreate") { event.preventDefault(); createInvite(event.target); }
    else if (event.target.id === "communityChallengeForm") { event.preventDefault(); submitChallengeForm(event.target); }
    else if (event.target.id === "communityEventForm") { event.preventDefault(); submitEventForm(event.target); }
    else if (event.target.id === "communityClubWodSession") { event.preventDefault(); publishClubWodSession(event.target); }
    else if (event.target.id === "communityInviteCode") { event.preventDefault(); redeemCode(event.target); }
    else if (event.target.id === "communityLogin") { event.preventDefault(); login(event.target); }
    else if (event.target.id === "panelUnlock") { event.preventDefault(); panelUnlock(event.target); }
    else if (event.target.id === "mgmtPassword") { event.preventDefault(); mgmtChangePassword(event.target); }
    else if (event.target.id === "communityCredentials") { event.preventDefault(); setCredentials(event.target); }
    else if (event.target.id === "backupCredentials") { event.preventDefault(); setCredentials(event.target); }
    else if (event.target.dataset && event.target.dataset.commentPostId) {
      event.preventDefault();
      // COMM-114. The comment interaction is recorded here rather than
      // inside addComment(), which belongs to the engagement cluster.
      // COMM-121. A reply form carries data-comment-parent-id.
      trackFeedInteraction(event.target.dataset.commentPostId, "comment");
      addComment(event.target.dataset.commentPostId, event.target, event.target.dataset.commentParentId || null);
    }
  });
  // COMM-114. "flushed once per feed session, or on view change, whichever
  // comes first" - backgrounding the app is the last chance to write.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushFeedImpressions();
    // COMM-141. The unread count refreshes on app focus.
    else if (document.visibilityState === "visible" && state.user) loadNotifUnread();
  });
  window.addEventListener("focus", () => { if (state.user) loadNotifUnread(); });
  // COMM-170. Leaving the Community tab ends the current club_tab_viewed,
  // so returning to the same sub-tab later counts as a new view instead of
  // being swallowed by the de-dupe. Capture phase, because app.js's own
  // click handler re-renders and this has to have run first. It reads two
  // stable ids and never touches the event.
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".tabbtn") : null;
    if (btn && btn.id !== "tabCommunityBtn") resetClubTabView();
  }, true);
  window.addEventListener("pagehide", flushFeedImpressions);
  window.addEventListener("online", flushOutbox);
  // Reconnection drains BOTH queues. Registered separately from the
  // private_records one so a failure in either cannot stop the other.
  window.addEventListener("online", () => { flushCommunityOutbox(); });
  window.addEventListener("haimunia-sync-needed", () => { maybeAutoStartBackup(); flushOutbox(); pingActivity(); });
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      state.user = session ? session.user : null;
      if (state.user) {
        enableSyncIfAllowed();
        // Bind the device's training log to this identity (round 10). Called on
        // BOTH session paths, not just at sign-in, because the case that matters
        // is the SECOND member to sign in on one phone - see app.js LOG_OWNER_KEY.
        if (typeof window.haimuniaBindLogOwner === "function") {
          window.haimuniaBindLogOwner(state.user.id);
        }
        // COMM-170. Same reason as refreshSession: configure before the
        // first track(). Idempotent, so whichever path arrives first wins.
        ensureAnalyticsConfigured();
        // COMM-331. A fresh sign-in only happens from within the Community
        // tab's own auth UI, so - unlike refreshSession()'s boot path -
        // this loads community data immediately via ensureCommunityDataLoaded()
        // rather than waiting for another afterRenderCommunity() pass; the
        // member is already looking at it. communityDataLoaded is cleared
        // first so a new session's sign-in isn't skipped by a stale flag
        // left over from whoever was signed in before (or from a
        // not-yet-loaded boot). loadProfile()/loadChallenges() stay eager
        // here too, same reasoning as refreshSession().
        loadRedemption()
          .then(() => Promise.all([loadProfile(), loadChallenges(), loadClubFeatures(), flushOutbox(), flushCommunityOutbox()]))
          .then(pullPrivateRecords)
          .then(pingActivity)
          .then(() => { if (typeof window.syncCommunityMilestones === "function") window.syncCommunityMilestones(); })
          .then(() => { state.communityDataLoaded = false; return ensureCommunityDataLoaded(); })
          .then(rerender);
      } else {
        // COMM-114. Whatever the signed-out member had seen is written
        // before the session id is dropped, not discarded with it.
        flushFeedImpressions();
        // COMM-170. The next session starts its own club_tab_viewed.
        resetClubTabView();
        // COMM-233. A search whose debounce window had not closed when the
        // session ended is dropped rather than written against whoever
        // signs in next (or against no one at all).
        cancelSearchTracking();
        // COMM-209 / COMM-227. Sign-out closes every open channel, the
        // other half of the teardown contract src/realtime.js documents.
        // Until this cluster there was nothing live to close; now the
        // own-row notification channel and the feed's shared channels
        // would otherwise outlive the session that opened them.
        if (window.HaimuniaRealtime) window.HaimuniaRealtime.teardownAll();
        clearRealtimeDebounces();
        state.feed.scope = "for_you"; state.feed.cursor = null; state.feed.end = false; state.feed.pagesLoaded = 0;
        state.feed.sessionId = null; state.feed.seen = {}; state.feed.pending = []; state.club.row = null;
        state.feed.loading = false; state.feed.error = false; state.feed.loadingMore = false; state.feed.moreError = false;
        state.communityDataLoaded = false; state.communityDataLoading = false;
        // The sign-out reset, one namespace per group since COMM-365 (it was
        // one 2.4KB line before). Deliberately NOT a wholesale
        // `state.<ns> = { ...defaults }` per namespace: this list is not the
        // full state literal, and several keys are meant to SURVIVE a sign-out
        // (state.ui.tab, state.leaderboard.hideMine, the two localStorage-
        // backed switches, featureFlags). Assign leaves, never a namespace.
        state.profile = null; state.redemption = null; state.signupStarted = false;
        state.profileLoadError = false; state.redemptionLoadError = false;
        state.avatarUpload = { status: "idle", error: "" }; state.permissions = []; state.permissionsLoaded = false;
        // The management session dies with the member's. Leaving it up would
        // hand the next person to sign in on this device a live, already
        // unlocked management account - precisely the case the lock exists
        // for. mgmtTeardown() clears the unlock windows too, and signs the
        // second client out rather than merely dropping the reference, so the
        // refresh token is revoked server-side and not just forgotten here.
        mgmtTeardown();
        state.admin.panelUnlockError = ""; state.admin.panelUnlockBusy = "";
        state.ui.fieldErrors = {}; state.ui.confirmDialog = null;
        // Back to the neutral choice screen, not to whichever gate screen the
        // member happened to be on before. Signing out on a shared phone and
        // being handed back a login form pre-framed as "the way in" is the
        // exact ordering design spec 7 exists to undo.
        state.ui.gateView = ""; state.ui.termSheet = null; state.ui.termGlossaryOpen = false;
        // hideMine is per-device and outlives the session - see the literal.
        state.leaderboard.scope = "club"; state.leaderboard.rows = []; state.leaderboard.loading = false;
        state.leaderboard.loaded = false; state.leaderboard.error = false;
        state.feed.items = [];
        // The club WOD board is a signed-in surface: today's boards, the open
        // dialog and the coach's publish draft all go, and app.js is told the
        // list is empty so the attach control in the log form disappears with
        // the session rather than lingering as a dead button.
        state.club.wodBoards = []; state.club.wodBoardsLoaded = false;
        state.club.wodBoardsLoading = false; state.club.wodBoardsError = false;
        state.club.wodBoardView = null;
        state.club.wodSessionForm = { wodId: "", date: "", note: "", saving: false };
        clubWodSessionsToApp();
        state.posts.openShare = {}; state.posts.comparisonForPostId = null; state.posts.comparison = [];
        state.posts.composer = null; state.posts.composerTrigger = null; state.posts.openMenu = null; state.posts.savedIds = {};
        state.posts.captionEdit = null; state.posts.visibilityEdit = null; state.posts.prPrompt = null;
        // Five-persona UX audit, outward sharing. Through the closer rather
        // than a bare null: the sheet owns an object URL over a Blob, and a
        // sign-out that only dropped the reference would leak it for the life
        // of the document.
        outwardRevokePreview(); state.posts.outwardShare = null;
        state.engagement.comments = {}; state.engagement.openComments = {}; state.engagement.commentDrafts = {};
        state.engagement.commentErrors = {}; state.engagement.commentSending = null; state.engagement.commentEdit = null;
        state.engagement.openReplies = {}; state.engagement.replyTo = {}; state.engagement.reactions = {};
        state.engagement.reactionError = null; state.engagement.mentionPicker = null;
        state.members.search = ""; state.members.results = []; state.members.profileView = null; state.members.roles = {};
        state.members.blockedIds = []; state.members.blocksLoaded = false;
        state.members.suggestions = { items: [], loading: false, loaded: false, error: false, busy: {} };
        state.members.directory = { items: [], loading: false, loadingMore: false, loaded: false, error: false, end: false, cursor: null, query: "", searchResults: null, searchLoading: false };
        state.members.classmatesToday = { items: [], loading: false, loaded: false, error: false };
        state.club.streaks = []; state.club.announcements = []; state.club.announcementSaving = false;
        state.club.weeklyChallenge = null; state.club.weeklyLeaderboard = []; state.club.inactiveMembers = [];
        state.club.newMembers = []; state.club.activitySignal = null; state.club.moduleBusy = null; state.club.configBusy = null; state.club.features = {}; state.club.featuresLoaded = false;
        state.admin.reports = []; state.admin.modQueue = []; state.admin.modQueueLoaded = false;
        state.admin.modQueueStatus = "open"; state.admin.modQueueLoading = false; state.admin.modQueueError = false;
        state.admin.modAction = null; state.admin.modContext = null; state.admin.reportSheet = null; state.admin.pins = [];
        state.admin.pinsLoaded = false; state.admin.pinError = ""; state.admin.auditLog = []; state.admin.auditCursor = null;
        state.admin.auditLoaded = false; state.admin.auditLoading = false; state.admin.auditError = false;
        state.admin.auditEnd = false; state.admin.auditFilters = {};
        // COMM-376/377. The next session on this device (a different member
        // signing in) gets fresh panels, never a stale one-time code reveal
        // or another admin's roster page left on screen.
        state.admin.invites = { items: [], status: "all", cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false, created: null, revoking: null };
        state.admin.inviteCodes = { items: [], loading: false, loaded: false, error: false, created: null, busy: null };
        state.admin.roster = { items: [], cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false };
        // Five-persona UX audit, defect 3. Same reason as the two panels
        // above, and one more: reclaimResult names a specific person, and it
        // must not still be on screen for whoever signs in next on this
        // device.
        state.admin.incompleteSignups = { items: [], cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false };
        state.admin.reclaim = null; state.admin.reclaimResult = null;
        state.challenges.items = []; state.challenges.loaded = false; state.challenges.loading = false;
        state.challenges.error = false; state.challenges.participation = {}; state.challenges.aggregates = {};
        state.challenges.view = null; state.challenges.form = null; state.challenges._rtId = null;
        state.challenges._consistencyWeekLogged = {}; state.challenges._consistencySessionCounts = {};
        state.events.items = []; state.events.byId = {}; state.events.loaded = false; state.events.loading = false;
        state.events.error = false; state.events.attendees = {}; state.events.view = null; state.events.form = null;
        state.search.events = []; state.search.challenges = []; state.search.query = ""; state.search.loading = false;
        state.achievements.mine = []; state.achievements.unlock = null;
        state.notif.center = null; state.notif.unread = 0; state.notif.prefs = {}; state.notif.prefsLoaded = false;
        state.notif.prefSaving = {}; state.notif._rtUid = null; state.notif.pushSub = null; state.notif.pushChecked = false;
        state.onboarding.progress = null; state.onboarding.firstMonth = null;
        state.onboarding.attendance = { count: 0, loading: false, loaded: false, error: false }; /* COMM-316: same reset reasoning as members.classmatesToday above - the next member on this device gets a fresh count, never the previous member's. */
        state.onboarding.stepContent = {}; state.onboarding.stepContentLoaded = false; state.onboarding.stepContentError = false;
        state.onboarding.editor = { drafts: {}, saving: {}, saved: {} };
        // Redesign, Phase 3: same reset reasoning as onboarding's own
        // stepContent/editor just above - the next member on this device
        // gets a fresh load and a fresh editor, never a stale copy or an
        // in-progress edit left over from whoever was signed in before.
        //
        // `step` IS reset, and the original decision not to reset it was
        // wrong. That decision reasoned that hasSeenIntroCarousel() alone
        // gates the carousel and is per-device, so the step index could not
        // matter. It does matter in exactly the case where the flag is still
        // unset: member A starts the carousel, reaches screen 2, ABANDONS
        // (which is precisely why the flag was never stamped - it is only
        // written by the final Next) and signs out. Member B signs up on the
        // same device, the unset flag correctly shows them the carousel, and
        // A's leftover index put them on screen 2 with screen 1 skipped and
        // no way to reach it except the Back button they have no reason to
        // press. Reproduced live against the real gate cascade before this
        // line was added.
        state.intro.step = 0;
        state.intro.content = {}; state.intro.contentLoaded = false; state.intro.contentError = false;
        state.intro.editor = { drafts: {}, saving: {}, saved: {} };
        state.analytics.registrationFunnel = { loading: false, loaded: false, error: false, errorText: "", data: null };
        state.recaps.view = null; state.recaps.monthly = { loading: false, loaded: false, error: false, row: null };
        state.coach.celebrate = { items: [], loading: false, loaded: false, error: false, congratulated: {}, busy: null };
        state.coach.welcome = { members: [], loading: false, loaded: false, error: false, contactedIds: {}, assignDrafts: {}, contactDrafts: {}, busy: null, welcomed: {} };
        state.coach.engage = { items: [], loading: false, loaded: false, error: false, profiles: {}, reachedOut: {}, busy: null };
        state.coach.memberOfWeek = { loading: false, loaded: false, error: false, envelope: null, publishedProfile: null, previousProfile: null, pickHandle: "", pickReason: "", busy: null, publishErr: "" };
        state.coach.monthlyRecap = { loading: false, loaded: false, error: false, row: null, busy: null, publishErr: "" };
        announcementsViewLogged = false; monthlyRecapViewLogged = false; /* Same reason as the classmates guard on the next line: the next member to sign in on this device gets their own first view of each inline surface, never the previous session's already-counted one. */
        classmatesCardViewLogged = false; /* COMM-307: the next member to sign in on this device gets a fresh card and a fresh classmates_card_viewed, never the previous session's rows or its already-counted view. */
        anonSignInAttempted = false;
        recoveryVerifyAttempted = false;
        rerender();
      }
    });
    refreshSession();
  }

  // COMM-102/103/105. The composer, caption editor and PR prompt render in the
  // global cloud overlay (renderCloudConfirmDialog), which is outside the
  // Community tab's afterRenderCommunity() hook, so their inputs are wired here
  // by delegation instead.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if ("inviteCode" in t.dataset) { state.ui.inviteCodeDraft = t.value; return; }
    // Credential fields check themselves as the member types, so the rule is
    // learned while there is still something to fix rather than announced
    // after a rejected submit. liveValidateCredentialField() patches the field
    // in place and never rerenders - see its header for why.
    if ("liveValidate" in t.dataset) { liveValidateCredentialField(t); return; }
    // Five-persona UX audit, defect 2. Same patch-in-place-never-rerender
    // shape as liveValidateCredentialField just above, and for the sharper
    // version of the same reason: a rerender would rebuild a native date
    // control while the member is part-way through typing into it.
    // Live bug hunt (2026-09-11): this form's own render pulls its values
    // FROM state.club.wodSessionForm (the wodId <select>'s "selected"
    // option, the date input's and note textarea's own value= /
    // textContent), but nothing wrote a member's live typing back into
    // that state - only publishClubWodSession() did, at submit time. Any
    // unrelated rerender() in the meantime (setMessage()'s own 6s auto-
    // clear timer is the confirmed live repro: cancel a session, start
    // filling in the republish form, wait past 6s) replaces #content
    // wholesale and rebuilds this form from the STALE, still-default state
    // - silently wiping whatever had been typed. Same patch-in-place-
    // never-rerender shape as inviteCodeDraft/dateEcho just below; checked
    // BEFORE dateEcho and without an early return, since the date field
    // carries BOTH data attributes (dateField() tags every date input with
    // its own data-date-echo) and needs both handlers to run, not just the
    // first match. Also handled in the "change" listener below for the
    // same reason dateEcho is (a native date-picker commit, or a <select>
    // choice, is not guaranteed to fire "input" on every engine).
    if ("clubWodField" in t.dataset) state.club.wodSessionForm[t.dataset.clubWodField] = t.value;
    if ("dateEcho" in t.dataset) { updateDateEcho(t); return; }
    if ("composerBody" in t.dataset) composerSetBody(t.value);
    else if ("commentInput" in t.dataset) onCommentInput(t);
    else if ("commentEditInput" in t.dataset && state.engagement.commentEdit) state.engagement.commentEdit.body = t.value;
    else if ("composerAlt" in t.dataset) composerSetAlt(t.dataset.composerAlt, t.value);
    else if ("captionEdit" in t.dataset && state.posts.captionEdit) state.posts.captionEdit.body = t.value;
    else if ("prNote" in t.dataset && state.posts.prPrompt) state.posts.prPrompt.note = t.value;
    else if ("prAlt" in t.dataset && state.posts.prPrompt && state.posts.prPrompt.photo) state.posts.prPrompt.photo.altText = t.value;
    else if ("achNote" in t.dataset && state.achievements.unlock) state.achievements.unlock.note = t.value;
    // COMM-151 / COMM-153. Free-text notes on the report and moderation
    // sheets. Kept in state, not read off the DOM at submit, so a rerender
    // never drops what was typed.
    else if ("reportNote" in t.dataset && state.admin.reportSheet) state.admin.reportSheet.note = t.value;
    else if ("modNote" in t.dataset && state.admin.modAction) state.admin.modAction.note = t.value;
    // Five-persona UX audit, defect 3. Same reasoning as modNote above, and
    // it matters more here: admin_reclaim_invite writes this note into the
    // admin_actions row, so anything a rerender drops is lost from the audit
    // log rather than just from the screen.
    else if ("reclaimNote" in t.dataset && state.admin.reclaim) state.admin.reclaim.note = t.value;
    // COMM-378. onboardingEditorDraft() lazily seeds the draft the first
    // time either field is touched, same "kept in state, not read off the
    // DOM at submit" reasoning as every note/body field above - a rerender
    // triggered by a sibling row's own save never drops what was typed here.
    else if ("onboardingEditTitle" in t.dataset) onboardingEditorDraft(t.dataset.onboardingEditTitle).title = t.value;
    else if ("onboardingEditBody" in t.dataset) onboardingEditorDraft(t.dataset.onboardingEditBody).body = t.value;
    // Redesign, Phase 3. Same "seeded lazily, kept in state" shape as the
    // two onboarding fields just above, for the intro-carousel editor.
    else if ("introEditTitle" in t.dataset) introEditorDraft(t.dataset.introEditTitle).title = t.value;
    else if ("introEditBody" in t.dataset) introEditorDraft(t.dataset.introEditBody).body = t.value;
    // COMM-202..206. The manual progress form and the coach entry roster,
    // both inside the challenge detail dialog. Kept in state, not read off
    // the DOM at submit, same reasoning as every other note/body field
    // above: a rerender (a progress refresh, a sibling row's own submit)
    // never drops what was already typed here.
    else if ("challengeLogDelta" in t.dataset && state.challenges.view) state.challenges.view.logForm.delta = t.value;
    else if ("challengeLogNote" in t.dataset && state.challenges.view) state.challenges.view.logForm.note = t.value;
    else if ("challengeCoachDelta" in t.dataset && state.challenges.view) {
      const uid = t.dataset.challengeCoachDelta;
      const d = state.challenges.view.coachEntry.drafts[uid] || (state.challenges.view.coachEntry.drafts[uid] = { delta: "", note: "" });
      d.delta = t.value;
    }
    else if ("challengeCoachNote" in t.dataset && state.challenges.view) {
      const uid = t.dataset.challengeCoachNote;
      const d = state.challenges.view.coachEntry.drafts[uid] || (state.challenges.view.coachEntry.drafts[uid] = { delta: "", note: "" });
      d.note = t.value;
    }
    // COMM-308. The team-rename text input's own draft, same shape as
    // challengeLogDelta/challengeCoachDelta above - kept in state so a
    // sibling row's own save (which re-renders the whole management block)
    // never drops what was already typed here.
    else if ("challengeTeamRenameName" in t.dataset && state.challenges.view) {
      state.challenges.view.teamMgmt.renameDrafts[t.dataset.challengeTeamRenameName] = t.value;
    }
    else if ("challengeTeamCreateName" in t.dataset && state.challenges.view) {
      state.challenges.view.teamMgmt.createName = t.value;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    // Both `input` (above) and `change` (here) for the date echo, on purpose
    // rather than by accident: Chromium fires input as each segment
    // completes, but a value committed through the OS/native calendar popup
    // is not guaranteed to fire input on every engine, and an echo that
    // silently stops matching the field is worse than no echo at all.
    // updateDateEcho() is idempotent, so the double delivery costs nothing.
    if ("clubWodField" in t.dataset) state.club.wodSessionForm[t.dataset.clubWodField] = t.value;
    if ("dateEcho" in t.dataset) { updateDateEcho(t); return; }
    if ("composerFile" in t.dataset) { const f = t.files && t.files[0]; if (f) composerAddPhoto(f); try { t.value = ""; } catch (err) {} }
    else if ("avatarFile" in t.dataset) { const f = t.files && t.files[0]; if (f) avatarPhotoSelected(f); try { t.value = ""; } catch (err) {} }
    else if ("composerDecorative" in t.dataset) composerToggleDecorative(t.dataset.composerDecorative, t.checked);
    else if ("composerVisibility" in t.dataset) composerSetVisibility(t.value);
    // The weekly-challenge picker, kept in state so a rejected submit (missing
    // title or dates) re-renders the form with the coach's choice still made.
    else if ("challengeKey" in t.dataset) state.club.challengeKeyDraft = t.value;
    else if ("prFile" in t.dataset) { const f = t.files && t.files[0]; if (f) prPromptAddPhoto(f); }
    // Five-persona UX audit, outward sharing. The name switch repaints the
    // card rather than only remembering the choice, because the preview IS
    // the payload - a member must be able to see that the name is gone.
    else if ("outwardName" in t.dataset) setOutwardShareName(t.checked);
    // COMM-151. The report reason radio.
    else if ("reportReason" in t.dataset && t.checked) setReportReason(t.dataset.reportReason);
    // COMM-308. The captain and reassign <select>s act immediately on
    // change, the same shape composerVisibility already uses above - no
    // extra "save" button, since a <select> only fires change when its
    // value actually moved.
    else if ("challengeTeamCaptainSelect" in t.dataset) setChallengeTeamCaptain(t.dataset.challengeTeamCaptainSelect, t.value || null);
    else if ("challengeTeamReassignSelect" in t.dataset && state.challenges.view && state.challenges.view.challenge) {
      reassignChallengeParticipant(state.challenges.view.challenge.id, t.dataset.challengeTeamReassignSelect, t.value || null);
    }
  });
  document.addEventListener("keydown", (e) => {
    // COMM-123. Mention picker keyboard navigation while a comment input has
    // focus and its picker is open.
    if (state.engagement.mentionPicker) {
      const t = e.target;
      if (t && t.dataset && "commentInput" in t.dataset && t.dataset.commentKey === state.engagement.mentionPicker.key) {
        const items = state.engagement.mentionPicker.results || [];
        if (e.key === "ArrowDown") { e.preventDefault(); state.engagement.mentionPicker.index = Math.min(Math.max(items.length - 1, 0), (state.engagement.mentionPicker.index || 0) + 1); rerender(); restoreCommentFocus(state.engagement.mentionPicker.key, t.selectionStart); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); state.engagement.mentionPicker.index = Math.max(0, (state.engagement.mentionPicker.index || 0) - 1); rerender(); restoreCommentFocus(state.engagement.mentionPicker.key, t.selectionStart); return; }
        if (e.key === "Enter" && items.length) { e.preventDefault(); const m = items[state.engagement.mentionPicker.index || 0]; mentionPick(state.engagement.mentionPicker.key, m.id, m.display_name || m.handle); return; }
        if (e.key === "Escape") { e.preventDefault(); const k = state.engagement.mentionPicker.key; state.engagement.mentionPicker = null; rerender(); restoreCommentFocus(k, t.selectionStart); return; }
      }
    }
    // COMM-190. Every Phase 1 overlay dialog traps Tab within itself.
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
    // DERIVED FROM CLOUD_DIALOGS, not a second copy of it.
    //
    // Live bug hunt, fresh round 9 (2026-09-16). This was a hand-maintained
    // if/else chain listing fifteen dialogs in the same order as the registry
    // - the comments on the first three even said so, explaining that
    // confirmSheet, outwardShare and termSheet must come first because each
    // stacks on top of the dialog below it. The backdrop-click handler forty
    // lines down ALREADY read the registry directly.
    //
    // So when clubWodBoard was added to the registry (202609080002, with its
    // own long comment about why it must sit last), clicking the backdrop
    // closed it and Escape did nothing. Every other dialog in the app closes
    // on Escape; that one silently did not, for keyboard and screen-reader
    // users only.
    //
    // Iterating the registry in order reproduces the old behaviour exactly -
    // same list, same order, same first-match-wins - and a dialog added later
    // is covered by existing in the registry rather than by someone
    // remembering there are two lists. The ORDER of CLOUD_DIALOGS is now
    // load-bearing for Escape as well as for paint order, which is what its
    // own comments already assumed.
    for (const d of CLOUD_DIALOGS) {
      if (d.isOpen()) { e.preventDefault(); d.close(); return; }
    }
    if (state.posts.openMenu) { state.posts.openMenu = null; rerender(); }
  });
  // COMM-190. A click on the dim backdrop - the overlay element itself, not
  // its sheet or any control inside - closes the dialog, same as Escape.
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || typeof t.getAttribute !== "function") return;
    const key = t.getAttribute("data-cloud-dialog");
    if (!key) return;
    const spec = CLOUD_DIALOGS.find((d) => d.key === key);
    if (spec) spec.close();
  });
  // Launch-readiness audit, RELIABILITY. Registered at module load, before
  // any flush can run, so a queue drained on the very first `online` event
  // already knows how to send every action it might be holding from a
  // previous session.
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
    // COMM-202. A second, independent handler on the same event: an
    // individual_performance challenge the caller has joined logs a delta
    // from the same PR, alongside (not instead of) the Share This PR prompt.
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, onPrCreatedForChallenges);
  }
  // COMM-202/205. WORKOUT_COMPLETED has no producer anywhere in this
  // codebase yet (see the comment on onWorkoutCompletedForChallenges) - the
  // subscription is wired now so a future workout-logging surface needs no
  // client change to start feeding individual_target and consistency
  // challenges the moment it starts emitting this event.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.WORKOUT_COMPLETED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.WORKOUT_COMPLETED, onWorkoutCompletedForChallenges);
  }
  // COMM-134. Consume ACHIEVEMENT_UNLOCKED from the product bus (COMM-012).
  // The producer is claimCommunityAchievements() above for client-detected
  // milestones, or ach_evaluate server-side for community and challenge
  // unlocks once that path lands. Either way this shows one celebration.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, onAchievementUnlocked);
  }
  // COMM-222. A fresh redemption in this same tab should not have to wait
  // for a reload before its onboarding_progress row (seeded server-side by
  // the same invite_redemptions insert) is fetched and the welcome step
  // can render.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.MEMBER_JOINED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.MEMBER_JOINED, () => { loadOnboardingProgress().then(rerender); });
  }
