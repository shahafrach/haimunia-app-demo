"use strict";
// ---- Community: sign-in, sign-up and the session --------------------------
//
// Invite redemption, the username/password credentials, the CAPTCHA around
// them, the anonymous session the invite gate runs on, recovery
// verification, profile completion, and the session refresh that ties them
// together.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// THERE IS NO EMAIL ADDRESS IN THIS FILE, and that is the whole design.
// usernameToEmail() maps a username to a synthetic
// <name>@members.haimuniya.invalid address so that Supabase Auth has
// something shaped like an email to key on and this club has no real address
// to leak. Read CLAUDE.md's rule on member data before adding a field here.
//
// WHAT STAYED BEHIND, deliberately:
//
//   LOGIN_RECOVERY_NOTE. It is a top-level `const` that interpolates
//   bidiText() at evaluation time, and bidiText is declared in cloud.js —
//   which loads after this file. Moving it would throw at load. The
//   extraction refuses to move a const whose initialiser calls something
//   left behind, and this is the one it caught.
//
//   ensureCommunityDataLoaded(), which fans out into every feature's loader
//   and belongs with the core it coordinates.

  async function refreshSession() {
    if (!client) return;
    const { data } = await client.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (state.user) {
      enableSyncIfAllowed();
      // Bind the device's training log to this identity (round 10). Called on
      // BOTH session paths, not just at sign-in, because the case that matters
      // is the SECOND member to sign in on one phone - see app.js LOG_OWNER_KEY.
      if (typeof window.haimuniaBindLogOwner === "function") {
        window.haimuniaBindLogOwner(state.user.id);
      }
      // COMM-170. First thing in the session-ready path, so every track()
      // below it writes instead of dropping.
      ensureAnalyticsConfigured();
      await loadRedemption();
      // loadProfile() and loadChallenges() stay eager - see
      // ensureCommunityDataLoaded()'s own comment for exactly why (both
      // gate cross-tab flows triggered from the core training-log tabs,
      // not just from Community). loadClubFeatures() rides along with
      // loadChallenges() rather than living in the deferred batch: with
      // challenges data present but the club-feature gate not yet
      // resolved, a module the club has turned off would render (its
      // resolver defaults "on" until a row loads) for the brief window
      // before the deferred batch finishes - loading both together closes
      // that gap instead of leaving it to self-correct after a flash.
      // loadNotifUnread() joins this eager batch too (fresh-eyes audit):
      // the main header's notification badge (app.js, every tab, not only
      // Community) reads window.communityUnreadCount() and needs a real
      // number from the very first paint after a restored session, not
      // only once the member happens to visit Community and triggers
      // ensureCommunityDataLoaded()'s deferred batch. It is one cheap RPC
      // (notif_unread_count), not the ~15-call bundle PERF-1 deliberately
      // keeps deferred, so promoting only this one call here does not
      // reopen that tradeoff.
      await Promise.all([loadProfile(), loadNotifUnread()]);
      // Circles: the member's list, then any invite link that was waiting for
      // this session (join_circle), then their own target.
      await circlesAfterSession();
      // Push pending local edits before pulling the remote copy - without
      // this, reopening the app with an unflushed outbox (e.g. a set
      // logged offline seconds ago) pulls the still-stale server record
      // and silently overwrites the just-made local edit in IndexedDB.
      // The outbox row survives and re-pushes later, but the UI regresses
      // in the meantime. onAuthStateChange already flushes before
      // pulling; this is the far more common path (reopening an existing
      // session) and was missing it.
      await flushOutbox();
      // Same reasoning for the community queue: a post/comment/cheer made
      // offline in a previous session is still sitting in IndexedDB, and
      // reopening the app is the most common moment connectivity returns.
      await flushCommunityOutbox();
      await pullPrivateRecords();
      // COMM-130. Claim any non-attendance milestone this device already
      // crossed before the member joined the community.
      if (typeof window.syncCommunityMilestones === "function") window.syncCommunityMilestones();
      // If the Community tab happens to be the active one on this boot
      // (e.g. a manifest shortcut, a deep link, or the last-active tab),
      // render() calling afterRenderCommunity() below already triggers
      // ensureCommunityDataLoaded() - nothing further to do here.
    }
    rerender();
  }
  // recovery_verified_at drives the COMM-016 gate. A profile is a display name
  // and an emoji and nothing else (docs/circles/decisions.md): the privacy
  // toggles, the bio and the visibility flag no longer exist, and nothing here
  // selects them.
  const PROFILE_COLUMNS = "id,handle,display_name,emoji,recovery_verified_at";
  // Launch-readiness audit, CQ-006. loadProfile()/loadRedemption() used to
  // drop `error` and collapse "the fetch failed" into "the row doesn't
  // exist" (`data || null`, unconditionally). The join funnel below reads
  // state.profile/state.redemption as ground truth for "has this member
  // joined yet", so a transient failure on a returning member's flaky
  // connection re-ran the first-run intro carousel and then an unskippable
  // "complete your profile" form - which, submitted, tries to create a
  // profile that already exists. Every sibling loader in this file
  // (loadOnboardingStepContent, loadIntroCarouselContent, loadClubFeatures,
  // loadPermissions) already branches on error; these two were the outlier.
  // Fix: track a load-failure flag, and — critically — do NOT overwrite an
  // already-loaded profile/redemption with null just because a later
  // refresh failed, so a transient error during the session can never
  // downgrade "known joined" back to "appears not joined".
  async function loadProfile() {
    if (!state.user) return;
    const { data, error } = await client.from("profiles").select(PROFILE_COLUMNS).eq("id", state.user.id).maybeSingle();
    state.profileLoadError = !!error;
    if (error) return;
    state.profile = data || null;
  }
  // The bootstrap redemption: the one row redeem_invite_code leaves for the
  // first owner of a first circle. A member who joined by invite link has none
  // (join_circle writes a membership, not a redemption), so "no redemption"
  // no longer means "not a member" - the circle list does.
  async function loadRedemption() {
    if (!state.user) return;
    const { data, error } = await client.from("invite_redemptions").select("invite_id,role,redeemed_at").eq("user_id", state.user.id).maybeSingle();
    state.redemptionLoadError = !!error;
    if (error) return;
    state.redemption = data || null;
  }
  // The retry action for the join-funnel error screen below - re-runs both
  // loaders (either could be the one that failed) and rerenders either way.
  async function retryJoinFunnelLoad() {
    await Promise.all([loadProfile(), loadRedemption(), loadMyCircles()]);
    rerender();
  }
  // JOINING IS A THREE-STEP FLOW: the invite (join_circle), the account
  // (username and password), the profile (a name and an emoji). One indicator,
  // so a member can tell how far from the end they are; the screens
  // themselves are in src/community/circles-ui.js.
  const JOIN_STEPS = ["הזמנה", "חשבון", "פרופיל"];
  function renderJoinProgress(idx) {
    const dots = JOIN_STEPS.map((_, i) => `<span style="display:inline-block;height:6px;width:${i === idx ? "20px" : "6px"};border-radius:3px;background:${i <= idx ? "var(--color-accent)" : "var(--color-border)"};transition:width .2s;"></span>`).join(" ");
    return `<div style="margin-bottom:14px;">
      <div style="display:flex;gap:5px;align-items:center;margin-bottom:6px;">${dots}</div>
      <div class="footer-note" style="margin:0;">${esc(`שלב ${idx + 1} מתוך ${JOIN_STEPS.length} · ${JOIN_STEPS[idx]}`)}</div>
    </div>`;
  }
  // COMM-017. A stable per-client identifier the invite throttle keys on
  // in ADDITION to the Auth uid, so discarding an anonymous session and
  // signing in again does not reset the five-attempts-per-15-minutes
  // limit: the uid changes on every anonymous sign-in, this key does not,
  // because it lives in localStorage and a sign-out never touches it.
  // It is not a security boundary, only a cost floor against the trivial
  // "clear the session and retry" guessing loop - a determined attacker
  // rotates it, and the high-entropy codes remain the real protection.
  // A full browser site-data clear (NOT the in-app "delete all data",
  // which leaves this key alone) does reset it, which is acceptable:
  // redemption then restarts from a fresh anonymous session anyway.
  const ACTOR_KEY_STORAGE = "haimunia-demo:communityActorKey";
  function communityActorKey() {
    let key = null;
    try { key = localStorage.getItem(ACTOR_KEY_STORAGE); } catch (e) { key = null; }
    if (!key) {
      const rnd = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID() + window.crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      key = rnd.replace(/-/g, "").slice(0, 128);
      try { localStorage.setItem(ACTOR_KEY_STORAGE, key); } catch (e) {}
    }
    return key.slice(0, 128);
  }
  async function redeemCode(form) {
    // Was a bare `return` - a submit with no session did nothing at all,
    // with no error and no explanation, which is indistinguishable from the
    // app being broken. Same audit pass as the retry loop below.
    if (!state.user) return setFieldErrors("communityInviteCode", { code: "אין חיבור כרגע, נסו שוב בעוד רגע" });
    // Live bug hunt round 5 (2026-09-11): no in-flight guard existed at
    // all - a fast double-tap on submit fired redeem_invite_code twice
    // concurrently, confirmed live. The real RPC increments a shared
    // code's use_count before its invite_redemptions insert, so two
    // near-simultaneous calls risk burning an extra use off a limited-use
    // code for one real redemption. Same busy-guard shape as
    // reactionBusy/followBusy elsewhere in this file.
    if (state.ui.redeemingCode) return;
    // State first, DOM second: a render between the last keystroke and
    // this submit replaces form.elements.code with an empty one.
    //
    // Live bug hunt round 5: .toLowerCase() added. Codes are minted
    // lowercase-hex only (gen_random_bytes) and the server's format gate
    // is a lowercase-only regex - a code typed with any uppercase letter
    // (mobile autocapitalize on the first character; retyping a
    // spoken/printed code) hashed to a different string and was rejected
    // with the same generic "wrong/expired/used" message as a genuinely
    // bad code, no hint that case was the problem. The ?invite= deep-link
    // capture path (see loadRedemption() area) already normalized this
    // way - this was the asymmetry: manual entry, the far more common
    // path, did not.
    const code = String(state.ui.inviteCodeDraft || form.elements.code.value || "").trim().toLowerCase();
    if (!code) return setFieldErrors("communityInviteCode", { code: "יש להזין קוד פתיחה" });
    state.ui.redeemingCode = true;
    try {
    // Two-arg overload: passes the actor key so the throttle holds across
    // session replacement. The server returns the same generic answer and
    // applies the same increment whether or not this actor has been seen
    // before, so the message here must not hint at a remaining count.
    const { data, error } = await client.rpc("redeem_invite_code", { p_code: code, p_actor_key: communityActorKey() });
    if (error || data === "rate_limited") return setFieldErrors("communityInviteCode", { code: data === "rate_limited" ? "יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר" : "קוד ההזמנה שגוי או לא פעיל" });
    // COMM-380: the RPC now grants a per-person invite's own role, so a
    // successful redemption can return "coach" as well as "member"
    // (COMM-372). Checking for the literal "invalid" instead of the
    // literal "member" keeps this a generic success/failure branch, not
    // one hardcoded to the one role a shared code could ever grant.
    if (data === "invalid") return setFieldErrors("communityInviteCode", { code: "קוד הפתיחה שגוי, פג תוקף או נוצל" });
    setFieldErrors("communityInviteCode", {});
    state.ui.inviteCodeDraft = "";
    // Launch-readiness audit, RELIABILITY. THE BUG THIS FIXES: the
    // redemption has ALREADY SUCCEEDED server-side by this line - the RPC
    // returned a role. But the funnel below decides what to show from
    // state.redemption, which is populated by this follow-up READ. A single
    // failed or racing read therefore left the member staring at the invite
    // form for a code that had just been consumed, with no error and no way
    // forward: re-submitting the same code now returns "invalid" (it is
    // spent), so the account was permanently stuck at the gate.
    //
    // This was the intermittent browser-check failure the suite has carried
    // (previously attributed to CPU contention). Reproduced against
    // pristine HEAD, 1 run in 4, by instrumenting the redemption step: the
    // invite form was still on screen with the redemption already done.
    //
    // A read that is the sole gate on a completed write gets retried rather
    // than trusted once. If every attempt fails, loadRedemption() sets
    // redemptionLoadError and renderCommunityApp() shows its retry screen -
    // an honest "we could not load your account" the member can act on,
    // never the invite form again.
    for (let attempt = 0; attempt < 3 && !state.redemption; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 150 * attempt));
      await loadRedemption();
    }
    // COMM-222. This is the module's MEMBER_JOINED moment (mirrors the
    // server side: seed_onboarding_progress fires off the same
    // invite_redemptions insert). Emitting it lets the onboarding sequence
    // pick up the fresh row in this same tab instead of waiting for a
    // reload before the welcome step can render.
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.MEMBER_JOINED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.MEMBER_JOINED, { user_id: state.user.id }); } catch (e) {}
    }
    setMessage("קוד אושר, אפשר להשלים פרופיל");
    } finally {
      // Reset and render here (not left to whichever branch above happened
      // to return) so every exit path - success, error, rate-limited,
      // invalid - clears the busy state and repaints the button, not just
      // the ones that already called setFieldErrors/rerender themselves.
      state.ui.redeemingCode = false;
      rerender();
    }
  }

  // The owner's bootstrap link (bootstrap_owner_invite, docs/ops/FIRST_CIRCLE.md)
  // looks like any invite link, but join_circle does not know it: it is a
  // one-hour code for the first circle, spent by redeem_invite_code. Called
  // when join_circle answered "invalid". True only when the code was accepted
  // and the redemption row is loaded, so the sign-up screens can go on.
  async function redeemFirstOwnerToken(token) {
    const code = String(token || "").trim().toLowerCase();
    if (!client || !state.user || !/^[a-f0-9]{40,128}$/.test(code)) return false;
    try {
      const { data, error } = await client.rpc("redeem_invite_code", { p_code: code, p_actor_key: communityActorKey() });
      if (error || !data || data === "invalid" || data === "rate_limited") return false;
    } catch (e) { return false; }
    for (let attempt = 0; attempt < 3 && !state.redemption; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 150 * attempt));
      await loadRedemption();
    }
    return !!state.redemption;
  }

  // No real email is ever collected or sent - a synthetic, RFC 2606
  // "invalid" address is built locally from a username purely so
  // Supabase's password-auth provider (which requires an email-shaped
  // identifier) has something to key on. Login/signup are both a plain
  // in-app form submit, no redirect anywhere - the exact problem
  // magic-link email had (opening in the phone's default browser,
  // disconnected from the installed home-screen app) doesn't apply here.
  function usernameToEmail(username) { return `${username}@members.haimuniya.invalid`; }
  const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

  // ONE source of truth for the two credential rules, because the screen and
  // the validator had drifted into stating different ones. The password
  // placeholder promised "לפחות 8 תווים" while the check below demanded ten
  // characters plus three character classes, so eight characters - exactly
  // what the app asked for - came back rejected. Three separate audit
  // personas hit that on their first attempt, which is every member's first
  // attempt. The username field had the same defect in milder form: the
  // placeholder said "אותיות אנגליות" and the error added a case and a length
  // the member had never been shown.
  //
  // These constants are what the placeholders render AND what the messages
  // below quote, so the promise and the rule cannot come apart again.
  //
  // Phrasing note: the length is deliberately spelled "3 עד 24" rather than as
  // a "3–24" range. A numeric range joined by a neutral dash inside an RTL
  // sentence is reordered by the bidi algorithm and can paint as "24–3" - the
  // same class of defect bidiText() exists for, and one <bdi> around the whole
  // message cannot fix because the message's own base direction is still RTL.
  // Separating the two numbers with a Hebrew word removes the ambiguity at the
  // source instead of trying to mark it up afterwards.
  const USERNAME_RULE_TEXT = "3 עד 24 אותיות אנגליות קטנות, ספרות או קו תחתון";
  const PASSWORD_RULE_TEXT = "לפחות 10 תווים, עם אות גדולה, אות קטנה וספרה";

  // Signup asks for a name TWICE, three screens apart, and both fields used to
  // be labelled "שם משתמש" with contradictory rules behind them: stage one
  // accepts English only, stage two accepts Hebrew and even suggested it
  // ("למשל דנה_כהן"). Nothing on either screen said they were different
  // things, so a member could not tell which name the club would see, and the
  // login name and the roster handle drifted apart silently - which an admin
  // separately reported as making "find this member" harder.
  //
  // The fix is to stop calling them the same thing. Each label now says what
  // its field is FOR, in the same plain register the invite-code screen uses
  // ("הקוד לא נוגע לרישום האימונים עצמו — הוא רק פותח את לשונית הקהילה"), and
  // each screen names the other name so neither reads as a duplicate.
  const LOGIN_NAME_LABEL = "שם לכניסה";
  // The login field accepts an email too (see login()), and a field that
  // silently accepts something its own label denies is a field people do not
  // try. Only the LOGIN label says so - account CREATION still mints a
  // username-only account, so the signup form keeps LOGIN_NAME_LABEL.
  const LOGIN_IDENTIFIER_LABEL = "שם לכניסה או אימייל";
  const CLUB_NAME_LABEL = "השם שרואים במעגל";
  const CREDENTIALS_INTRO_TEXT = "שם וסיסמה לכניסה — כדי שתוכלו להיכנס לחשבון שוב מכל מכשיר. שם הכניסה הוא רק בשבילכם ואף אחד במעגל לא רואה אותו; את השם שחברי המעגל כן יראו בוחרים בשלב הבא, והוא יכול להיות אחר לגמרי.";
  const CLUB_NAME_HINT_TEXT = "זה השם שחברי המעגל יראו לידכם. אפשר שם מלא עם רווחים, בעברית או באנגלית. זה לא שם הכניסה לחשבון.";
  // The value setCredentials() will actually save, not the raw keystrokes: it
  // trims and lower-cases before validating, so "Dana_K" is accepted and
  // stored as "dana_k". The live check normalises identically, otherwise it
  // would flag a capital letter the submit goes on to accept - a validator
  // disagreeing with its own form is the defect being fixed here, not a
  // stricter version of it.
  function normalizeUsername(value) { return String(value || "").trim().toLowerCase(); }
  // Same shape as serverErrorText()/ghostReclaimErrorText(): a flat set of
  // answers, each saying what is wrong and what to do about it, and "" when
  // there is nothing to say. No "try again" anywhere - retyping the same
  // thing cannot succeed; the member has to change it.
  function usernameRuleError(value) {
    const username = normalizeUsername(value);
    if (!username) return "יש להזין שם לכניסה";
    if (username.length < 3) return `שם הכניסה קצר מדי. צריך ${USERNAME_RULE_TEXT}.`;
    if (username.length > 24) return `שם הכניסה ארוך מדי. צריך ${USERNAME_RULE_TEXT}.`;
    if (!USERNAME_RE.test(username)) return "בשם הכניסה אפשר להשתמש באותיות אנגליות, בספרות ובקו תחתון בלבד — בלי עברית, רווחים או סימנים.";
    return "";
  }
  function passwordRuleError(value) {
    const password = String(value || "");
    if (!password) return "יש להזין סיסמה";
    if (password.length < 10) return `הסיסמה קצרה מדי. צריך ${PASSWORD_RULE_TEXT}.`;
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return "הסיסמה צריכה לכלול אות גדולה, אות קטנה וספרה באנגלית.";
    return "";
  }
  // Live, as-you-type validation for the two credential-creation forms.
  //
  // Patched into the DOM IN PLACE rather than through setFieldErrors(), which
  // calls rerender(): this runs on every keystroke, and a full rerender
  // rebuilds the <input> and throws away focus and caret position mid-word.
  // The markup written here is byte-for-byte what field() writes on the next
  // full render, and state.ui.fieldErrors is updated alongside it, so a
  // rerender triggered from anywhere else paints exactly the same thing.
  //
  // textContent/setAttribute/createElement only. cloud.js has no innerHTML
  // sinks and this does not add one (test/app-innerhtml-sinks.test.mjs).
  function liveValidateCredentialField(input) {
    const rule = input.dataset.liveValidate;
    const formId = input.dataset.liveValidateForm || (input.form && input.form.id) || "";
    if (!formId || !input.name) return;
    // An empty field says nothing: an error that appears before the member has
    // typed a character is noise, and one that appears the moment they clear a
    // field to start over is worse. The submit check still catches empty.
    let message = "";
    if (input.value !== "") {
      if (rule === "username") message = usernameRuleError(input.value);
      else if (rule === "password") message = passwordRuleError(input.value);
      else if (rule === "passwordConfirm") message = passwordConfirmError(input.form, input.value);
    }
    setFieldErrorInPlace(input, formId, input.name, message);
    // Typing in the password field is also the moment a "passwords do not
    // match" error on the OTHER field can stop being true, so it is
    // re-evaluated here rather than waiting for the member to go back and
    // touch a field that is already correct.
    if (rule === "password" && input.form && input.form.elements.passwordConfirm) {
      const confirmEl = input.form.elements.passwordConfirm;
      if (confirmEl.value !== "") setFieldErrorInPlace(confirmEl, formId, "passwordConfirm", passwordConfirmError(input.form, confirmEl.value));
    }
  }
  function passwordConfirmError(form, value) {
    if (!form || !form.elements.password) return "";
    return form.elements.password.value === value ? "" : "הסיסמאות לא תואמות";
  }
  function setFieldErrorInPlace(input, formId, name, message) {
    const errors = state.ui.fieldErrors[formId] || (state.ui.fieldErrors[formId] = {});
    if (message) errors[name] = message;
    else delete errors[name];
    if (!Object.keys(errors).length) delete state.ui.fieldErrors[formId];
    // field() wraps every input in <label class="field"> and appends the error
    // span as that label's last child, so the label is the unit to patch and
    // ".field-error" inside it is unambiguous - one field per label.
    const label = input.closest ? input.closest("label.field") : null;
    if (!label) return;
    let errEl = label.querySelector(".field-error");
    if (!message) {
      if (errEl) errEl.remove();
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      return;
    }
    const errId = `err-${formId}-${name}`;
    if (!errEl) {
      errEl = document.createElement("span");
      errEl.className = "field-error";
      errEl.setAttribute("role", "alert");
      label.appendChild(errEl);
    }
    errEl.id = errId;
    errEl.textContent = message;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", errId);
  }

  // A brand-new member starts anonymous (zero typing) purely so
  // redeem_invite_code has a session to attach the redemption to - this
  // identity is upgraded to a real username+password account (same
  // auth.uid(), same redemption/profile - see setCredentials) before
  // profile completion, never left as the permanent identity.
  //
  // Two independent callers reach this now: startSignup() below (explicit
  // click), and maybeAutoStartBackup() (fires on the member's first local
  // write, no click at all - see that function's comment for why this
  // does not reopen the "nothing happens silently" concern the removed
  // on-load version raised). Both share the exact same session; whichever
  // fires first wins, the guard below makes the second call a no-op.
  // ---------------------------------------------------------------------
  // CAPTCHA (launch-readiness audit, SEC-004)
  // ---------------------------------------------------------------------
  // Anonymous sign-in costs an attacker nothing, which is what makes every
  // free identity a scraping/flooding primitive. Supabase verifies the
  // token server-side when a provider is configured in the dashboard; this
  // side's whole job is to obtain a token and attach it.
  //
  // OFF BY DEFAULT AND SAFE: with no captchaSiteKey configured,
  // captchaEnabled() is false and every path below is a no-op, so a project
  // that has not enabled the provider yet behaves exactly as before. There
  // is deliberately no "fail open if the widget errors" branch when it IS
  // enabled - a CAPTCHA that silently passes on script failure is not a
  // control, so a token failure surfaces as a refusal the member can retry.
  const CAPTCHA_SCRIPT_URL = {
    turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js",
  };
  let captchaScriptPromise = null;

  function captchaConfig() {
    const cfg = window.HAIMUNIA_CONFIG || {};
    return {
      provider: String(cfg.captchaProvider || "turnstile"),
      siteKey: String(cfg.captchaSiteKey || "").trim(),
    };
  }
  function captchaEnabled() { return !!captchaConfig().siteKey; }

  function loadCaptchaScript() {
    if (captchaScriptPromise) return captchaScriptPromise;
    const { provider } = captchaConfig();
    const url = CAPTCHA_SCRIPT_URL[provider];
    if (!url) return Promise.reject(new Error("unknown captcha provider"));
    captchaScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-captcha="${provider}"]`);
      if (existing) return resolve();
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.defer = true;
      s.dataset.captcha = provider;
      s.onload = () => resolve();
      s.onerror = () => { captchaScriptPromise = null; reject(new Error("captcha script failed to load")); };
      document.head.appendChild(s);
    });
    return captchaScriptPromise;
  }

  // Renders an invisible widget and resolves with a single-use token.
  // Rejects on load failure, on the provider reporting an error, and on a
  // timeout - each of which must block the sign-in rather than pass it.
  function getCaptchaToken() {
    if (!captchaEnabled()) return Promise.resolve(null);
    const { provider, siteKey } = captchaConfig();
    return loadCaptchaScript().then(() => new Promise((resolve, reject) => {
      const api = window.turnstile;
      if (!api || typeof api.render !== "function") return reject(new Error("captcha unavailable"));
      const host = document.createElement("div");
      host.style.display = "none";
      document.body.appendChild(host);
      let settled = false;
      const cleanup = () => { try { host.remove(); } catch (e) {} };
      // A token that never arrives must not hang the sign-in button
      // forever; 20s is well beyond a normal invisible challenge.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup(); reject(new Error("captcha timed out"));
      }, 20000);
      try {
        api.render(host, {
          sitekey: siteKey,
          size: "invisible",
          callback: (token) => {
            if (settled) return;
            settled = true; clearTimeout(timer); cleanup(); resolve(token);
          },
          "error-callback": () => {
            if (settled) return;
            settled = true; clearTimeout(timer); cleanup(); reject(new Error("captcha failed"));
          },
          "expired-callback": () => {
            if (settled) return;
            settled = true; clearTimeout(timer); cleanup(); reject(new Error("captcha expired"));
          },
        });
        if (typeof api.execute === "function") api.execute(host);
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); cleanup(); reject(e); }
      }
    }));
  }

  // Wraps a Supabase auth call that accepts { options: { captchaToken } }.
  // Returns { error } shaped like the underlying call so callers are
  // unchanged apart from awaiting this instead.
  async function withCaptcha(fn) {
    if (!captchaEnabled()) return fn(undefined);
    let token;
    try {
      token = await getCaptchaToken();
    } catch (e) {
      // Deliberately NOT falling through to an un-captcha'd call.
      return { error: { message: "captcha_failed" } };
    }
    return fn(token);
  }

  let anonSignInAttempted = false;
  async function ensureAnonymousSession() {
    if (!client || state.user || anonSignInAttempted) return;
    anonSignInAttempted = true;
    // Live bug hunt, round 10 (2026-09-11): a genuinely stalled connection
    // (the request neither resolves nor rejects) used to leave this awaiting
    // forever, with anonSignInAttempted stuck true - confirmed live, the
    // "מתחברים לקהילה…" screen hung with zero controls (no retry, no
    // cancel), and leaving/returning to the Community tab re-showed the
    // identical stuck screen, since the guard was only ever cleared inside
    // the `error` branch below. A 15s client-side timeout gives a stall the
    // same outcome an explicit error already has: the guard clears and the
    // existing retry message/screen takes over.
    // Read off window (not a bare const) so a test can shrink this to a
    // few ms instead of a real 15s wait.
    let timedOut = false;
    const timeout = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve({ error: { message: "timed_out" } }); }, window.ANON_SIGNIN_TIMEOUT_MS || 15000));
    const { error } = await Promise.race([
      withCaptcha((captchaToken) =>
        client.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined)),
      timeout,
    ]);
    if (error) {
      // A failed challenge is retryable: clear the one-shot guard so the
      // member can try again rather than being stuck for the session.
      anonSignInAttempted = false;
      setMessage(error.message === "captcha_failed" ? "אימות האבטחה נכשל, נסו שוב"
        : timedOut ? "החיבור לוקח יותר מדי זמן. בדקו את האינטרנט ונסו שוב"
        : "לא ניתן להתחבר כרגע, נסו לרענן את הדף");
      return;
    }
    // onAuthStateChange below picks up the new session and loads everything.
  }
  // gateView is cleared here so that backing out of the invite step later
  // lands on the choice screen rather than silently reopening the login form
  // a member had visited earlier in the same session.
  function startSignup() { state.signupStarted = true; state.ui.gateView = ""; ensureAnonymousSession(); rerender(); }

  // Private-backup-to-cloud is opt-out, not opt-in - see PRIVACY.md. Distinct
  // from cloudSyncEnabled (which is the actual on/off switch flushOutbox()
  // checks): this only remembers that the member explicitly declined, so
  // maybeAutoStartBackup()/enableSyncIfAllowed() never re-enable it behind
  // their back after they turned it off in Settings.
  const BACKUP_OPTOUT_KEY = "haimunia-demo:backupOptOut";
  function backupOptedOut() { return localStorage.getItem(BACKUP_OPTOUT_KEY) === "1"; }
  // Turns cloudSyncEnabled on the moment any session exists (anonymous
  // backup-only, or a real community member), unless the member opted out.
  // Only ever flips it on - going forward, never touches history already
  // sitting unsynced in IndexedDB. That's still what the "migrate"/"sync
  // private history" action is for.
  function enableSyncIfAllowed() {
    if (state.syncEnabled || backupOptedOut()) return;
    state.syncEnabled = true;
    localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");
  }
  // COMM sync-loss fix (iOS 7-day IndexedDB eviction). Fires on the
  // member's first local write (queueSyncRecord's haimunia-sync-needed
  // event), not on app load - creating a cloud account for a visit that
  // never records a workout has no upside and a real cost (an
  // auth.users row + a private_records writer that will never write
  // anything). By the time this fires there is real data to protect, and
  // the ensureAnonymousSession() guard makes it a no-op for anyone who
  // already has a session, backup-only or otherwise.
  function maybeAutoStartBackup() {
    if (!client || state.user || backupOptedOut()) return;
    // First-run sequence (c4cd505), S5. Backup consent is asked AFTER the
    // member's first saved entry, because asking before they have used the
    // app is asking about nothing. But this fires ON that same first write -
    // so without this line an anonymous account already exists by the time
    // the card appears, and "לא עכשיו" would be answering a question the app
    // had already answered for them. The screen would be making a promise
    // the code breaks, which is the exact defect class the audit kept
    // finding (see the account-security screen in a42f9d1).
    //
    // Deliberately a pending-consent CHECK rather than app.js writing this
    // file's own backupOptOut key: "not asked yet" and "asked and declined"
    // are different states, and collapsing them would make a member who has
    // not seen the card indistinguishable from one who said no.
    if (typeof window.haimuniaBackupConsentPending === "function" && window.haimuniaBackupConsentPending()) return;
    ensureAnonymousSession();
  }

  // COMM-016. Community RLS (is_community_member()) requires
  // profiles.recovery_verified_at, and mark_recovery_verified() is the
  // only client-reachable way to set it - the RPC refuses unless Supabase
  // Auth itself confirms a real email plus password on the user, so the
  // gate cannot be self-certified from the client. It is idempotent, so a
  // retry after a transient failure is safe. Called once the profile row
  // exists (the insert policy forces recovery_verified_at to null, so it
  // can only be stamped afterwards) and credentials are set. The one-shot
  // guard mirrors anonSignInAttempted so a render loop cannot hammer the
  // RPC while it is failing; the visible retry button passes { force }.
  let recoveryVerifyAttempted = false;
  async function verifyRecovery(opts) {
    if (!state.user || state.user.is_anonymous || !state.profile) return false;
    if (state.profile.recovery_verified_at) return true;
    if (!(opts && opts.force) && recoveryVerifyAttempted) return false;
    recoveryVerifyAttempted = true;
    const { data, error } = await client.rpc("mark_recovery_verified");
    if (error || !data) { setMessage("אימות החשבון נכשל, אפשר לנסות שוב"); return false; }
    await loadProfile();
    if (state.profile && state.profile.recovery_verified_at) setMessage("");
    rerender();
    return !!(state.profile && state.profile.recovery_verified_at);
  }
  // A returning member logs into the exact same account (same auth.uid(),
  // same profile/history/streak) from any device - the one thing
  // anonymous-only sign-in structurally couldn't offer.
  async function login(form) {
    if (!client) return;
    const identifier = String(form.elements.username.value || "").trim().toLowerCase();
    const password = String(form.elements.password.value || "");
    const errors = {};
    // A REAL email address is accepted here as well as a username (2026-09-15).
    //
    // Every ordinary member's account is username-only: usernameToEmail()
    // maps it onto <name>@members.haimuniya.invalid, a deliberately
    // non-routable domain, which is what lets this club run with no email
    // collection at all. That is unchanged and stays the default.
    //
    // The exception is an account that genuinely needs to be RECOVERABLE
    // without another admin - the club's own owner/admin account most of all,
    // because "an admin resets it for you" has no answer when the locked-out
    // person IS the only admin. Such an account is created with a real
    // address as its auth email, which makes Supabase's own password-reset
    // mail work; this branch is what lets it sign in, since its email is not
    // derivable from any username. Detection is deliberately just "contains
    // @" rather than a validating regex: the server is the authority on
    // whether an address exists, and a stricter client-side test could only
    // ever lock someone out of their own account over a technicality.
    const looksLikeEmail = identifier.includes("@");
    if (!identifier) errors.username = "יש להזין שם כניסה או אימייל";
    else if (!looksLikeEmail && !USERNAME_RE.test(identifier)) errors.username = "שם הכניסה לא תקין";
    if (!password) errors.password = "יש להזין סיסמה";
    if (Object.keys(errors).length) return setFieldErrors("communityLogin", errors);
    const { error } = await withCaptcha((captchaToken) =>
      client.auth.signInWithPassword(Object.assign(
        { email: looksLikeEmail ? identifier : usernameToEmail(identifier), password },
        captchaToken ? { options: { captchaToken } } : {},
      )));
    if (error) {
      // A failed challenge is not a wrong password, and saying so avoids
      // sending a member off to reset a password that was fine.
      if (error.message === "captcha_failed") return setFieldErrors("communityLogin", { password: "אימות האבטחה נכשל, נסו שוב" });
      return setFieldErrors("communityLogin", { password: "שם הכניסה או הסיסמה שגויים" });
    }
    setFieldErrors("communityLogin", {});
    // onAuthStateChange picks up the session and loads the existing account.
  }
  // Upgrades the bootstrap anonymous session to a permanent one by
  // linking real credentials to it (Supabase's supported anonymous-user
  // conversion path) - the underlying auth.uid() never changes, so the
  // redemption and profile already tied to it carry straight over with
  // no migration step.
  async function setCredentials(form) {
    if (!state.user) return;
    // Shared by two forms now: the Community-onboarding "communityCredentials"
    // screen, and the standalone backup-only "backupCredentials" form in
    // Settings (window.renderBackupSettingsPanel) - form.id keys the field
    // errors so both report inline on whichever one was actually submitted.
    const formId = form.id;
    const username = String(form.elements.username.value || "").trim().toLowerCase();
    const password = String(form.elements.password.value || "");
    const passwordConfirm = String(form.elements.passwordConfirm.value || "");
    const errors = {};
    // Same two validators the placeholders quote and the as-you-type check
    // runs, so submitting can no longer be the first time a member is told a
    // rule. The password rule still mirrors supabase/config.toml's
    // minimum_password_length/password_requirements (launch-readiness audit,
    // SEC-012) - checked client-side so a member gets this message rather than
    // a raw Supabase rejection.
    const usernameError = usernameRuleError(username);
    if (usernameError) errors.username = usernameError;
    const passwordError = passwordRuleError(password);
    if (passwordError) errors.password = passwordError;
    if (password !== passwordConfirm) errors.passwordConfirm = "הסיסמאות לא תואמות";
    if (Object.keys(errors).length) return setFieldErrors(formId, errors);
    // updateUser() is the account-creation step (it turns the bootstrap
    // anonymous session into a permanent, loggable-in account), so it is
    // gated by the same challenge as the other two auth entry points.
    const { data, error } = await withCaptcha((captchaToken) =>
      client.auth.updateUser(
        { email: usernameToEmail(username), password },
        captchaToken ? { captchaToken } : undefined,
      ));
    if (error) return setFieldErrors(formId, { username: /registered|exists|taken/i.test(error.message || "") ? "שם הכניסה הזה כבר תפוס. בחרו שם אחר." : "השמירה נכשלה, נסו שוב" });
    state.user = data.user;
    setFieldErrors(formId, {});
    setMessage("החשבון נוצר, אפשר להתחבר איתו מכל מכשיר");
    // For a member who already had a profile before setting a recovery
    // method (an existing anonymous account after the Phase 0 migration),
    // the method is verifiable the moment credentials exist. A brand-new
    // signup has no profile row yet, so this no-ops and the stamp happens
    // in saveProfile() instead.
    if (state.profile && !state.profile.recovery_verified_at) await verifyRecovery({ force: true });
    rerender();
  }
  // ONE NAME, ASKED ONCE (2026-09-16), at the owner's instruction: "there are
  // too many places a user needs to write his name - 3 different places - it
  // needs to be one, only community."
  //
  // The form used to ask twice, in adjacent fields, and the labels made it
  // worse: `handle` was labelled "השם שרואים במועדון" (the name people see in
  // the club) directly above a second field labelled "שם תצוגה". Both read as
  // "your display name". The one that sounded most like it was the handle,
  // which may not contain a space - so the owner typed his own real name into
  // it and was rejected, with a rule about underscores. And the label was not
  // merely confusing but FALSE: every name render in this file is
  // `display_name || handle`, so the display name is what the club sees
  // wherever it is set, and the handle only ever surfaces as an "@" fallback.
  //
  // So the club name is now the only thing a member types, spaces and all, and
  // the handle is derived from it. A handle is an identifier, not a question to
  // put to a person.
  function deriveHandle(name) {
    const base = String(name || "").toLowerCase().trim()
      .replace(/\s+/g, "_")
      // Everything the handle rule forbids, dropped rather than rejected - the
      // member never sees this string, so there is nobody to explain it to.
      .replace(/[^a-zא-ת0-9_]/g, "")
      .replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return base.slice(0, 24);
  }
  // A derived handle can collide (two members really can both be דנה כהן), and
  // a collision is OURS to resolve, not the member's - they typed their own
  // name and it is not wrong. Suffixes are tried in order so the first דנה כהן
  // keeps the clean handle and the second becomes דנה_כהן2.
  function handleCandidates(name) {
    const base = deriveHandle(name);
    // A name made entirely of characters the handle alphabet has no room for
    // (emoji, punctuation) strips to nothing. Padding that to "___" would pass
    // the 3-24 rule and mint a handle with no relation to the member at all, so
    // it returns empty and the caller asks for something typable instead.
    if (!/[a-zא-ת0-9]/.test(base)) return [];
    const seed = base.length >= 3 ? base : (base + "___").slice(0, 3);
    const out = [seed];
    for (let n = 2; n <= 9; n++) out.push(seed.slice(0, 23) + n);
    for (let n = 10; n <= 99; n += 7) out.push(seed.slice(0, 22) + n);
    return out;
  }
  async function saveProfile(form) {
    if (!state.user) return;
    const formId = form.id;
    const displayName = cleanStr(form.elements.displayName.value, 80).trim();
    const emoji = String(form.elements.emoji.value || "").trim();
    // The only rule a member can now break, and it is about THEIR name rather
    // than about an identifier's character set: it has to be long enough to be
    // a name and short enough to sit beside an avatar.
    if (displayName.length < 2 || displayName.length > 40) {
      return setFieldErrors(formId, { displayName: "השם שרואים במעגל צריך להיות באורך 2 עד 40 תווים." });
    }
    // The emoji is the member's avatar (there are no photos): one to sixteen
    // characters, and it has to be an emoji, not a letter that looks like one.
    if (!emoji || Array.from(emoji).length > 16 || !/\p{Extended_Pictographic}/u.test(emoji)) {
      return setFieldErrors(formId, { emoji: "בחרו אימוג'י אחד או שניים." });
    }
    // An existing member keeps the handle they already have: it is their
    // identity in @mentions and in every link already posted, so renaming
    // yourself must not silently rename that too.
    const existingHandle = state.profile && state.profile.handle ? state.profile.handle : null;
    const candidates = existingHandle ? [existingHandle] : handleCandidates(displayName);
    if (!candidates.length || !/^[a-zא-ת0-9_]{3,24}$/.test(candidates[0])) {
      // Only reachable when a name is made entirely of characters the handle
      // alphabet has no room for (emoji, punctuation). Ask for something
      // typable rather than inventing an identifier with no relation to them.
      return setFieldErrors(formId, { displayName: "השם צריך לכלול אותיות בעברית או באנגלית, או ספרות." });
    }
    // is_admin is deliberately never sent from here — a coach-code
    // redemption is a label only (invite_redemptions.role), not automatic
    // full admin access. Full admin stays a manual dashboard-only flip;
    // real coach-scoped permissions (their own classes/members) are a
    // separate piece of work, not built yet.
    const payload = { id: state.user.id, handle: candidates[0], display_name: displayName, emoji: emoji };
    // The ONE place an insert is genuinely possible: profile completion runs
    // before the row exists. Once it does, update - an upsert would evaluate
    // profiles_insert_self, which requires recovery_verified_at to be null,
    // so a member who has completed account recovery could no longer edit
    // their own profile at all.
    // Whether this is a FIRST profile or an edit of an existing one - read
    // before the write, because the write is what makes state.profile exist.
    const isFirstProfile = !state.profile;
    // Walk the candidates on 23505 rather than handing the collision back to
    // the member. Only a NEW profile can walk: an existing member has exactly
    // one candidate (their current handle), so a duplicate there is a genuine
    // conflict and still surfaces.
    let error = null;
    for (const candidate of candidates) {
      payload.handle = candidate;
      const res = state.profile
        ? (await client.from("profiles").update({ handle: candidate, display_name: payload.display_name, emoji: payload.emoji }).eq("id", state.user.id))
        : (await client.from("profiles").upsert(payload));
      error = res.error;
      if (!error || error.code !== "23505") break;
    }
    if (error) {
      if (error.code === "23505") setFieldErrors(formId, { displayName: "השם הזה כבר תפוס. נסו להוסיף שם משפחה או כינוי." });
      else setMessage("שמירת הפרופיל נכשלה");
      return;
    }
    setFieldErrors(formId, {});
    for (const k of Object.keys(state.circles.drafts)) if (k.indexOf(formId + ".") === 0) delete state.circles.drafts[k];
    await loadProfile();
    // Right after the first profile insert (which the RLS policy forces to
    // land with recovery_verified_at null), stamp the recovery method so
    // the new member is a full community_member and never sees the
    // COMM-016 gate. A returning member editing their profile from the
    // Account tab is already verified, so this no-ops for them.
    // Live bug hunt round 5 (2026-09-11): the unconditional setMessage()
    // below used to run regardless of verifyRecovery()'s own outcome,
    // clobbering its "אימות החשבון נכשל, אפשר לנסות שוב" failure message
    // with "הפרופיל נשמר" - on exactly the flaky-connection path every new
    // member's FIRST automatic verification attempt goes through. The gate
    // screen and its manual retry button still rendered correctly; only
    // the status text was wrong, making the dead failure message
    // effectively unreachable from this, the most common path to it.
    let recoveryVerified = true;
    if (!state.user.is_anonymous && state.profile && !state.profile.recovery_verified_at) recoveryVerified = await verifyRecovery({ force: true });
    // A BRAND-NEW MEMBER'S FIRST SCREEN OF THE CLUB IS THE FEED.
    //
    // Live bug hunt, fresh round 9 (2026-09-16): state.ui.tab is initialised
    // once at script load, so one member could open their own חשבון tab, sign
    // out, and the next person to complete a fresh signup on that device
    // landed on the Account form as their first impression of the club. A
    // coach handing over their phone to sign someone up is exactly how that
    // happens.
    //
    // Reset HERE rather than on sign-out, which was my first attempt and was
    // wrong: state.ui.tab surviving a sign-out is deliberate and documented -
    // a member who signs out and back in returns to where they were, and
    // community-state-namespaces.test.mjs enforces it by name. The bug is not
    // that the tab persists; it is that it persisted across a change of
    // PERSON. Completing a first profile is the one moment that is
    // unambiguously a new member.
    // The member has just told us their name. Do not ask again.
    //
    // app.js keeps its own userName for the offline log and community signup
    // never set it, so a member who joined by invite was destined to be asked
    // "איך נקרא לך?" a second time for the same answer. Adopted here only if
    // the local log has no name yet, so this can never overwrite a name
    // someone deliberately chose for their private log.
    if (typeof window.adoptCommunityDisplayName === "function") {
      window.adoptCommunityDisplayName(payload.display_name || handle || "");
    }
    if (recoveryVerified) setMessage("הפרופיל נשמר");
  }
  async function migrateLocalData() {
    if (!state.user || typeof window.queueAllLocalRecordsForSync !== "function") return;
    await window.queueAllLocalRecordsForSync();
    state.syncEnabled = true;
    localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");
    await flushOutbox();
    setMessage("ההיסטוריה הפרטית סונכרנה לחשבון");
  }
