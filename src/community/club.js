"use strict";
// ---- Community: club management -------------------------------------------
//
// What the club programmes and publishes to its own members: the WOD
// catalogue and the boards it writes into the feed, announcements with their
// priority and expiry, the weekly comparison challenge, the new-member
// onboarding sequence, the first-run intro carousel, and the two content
// editors a coach uses to rewrite either one's copy.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// The WEEKLY challenge lives here rather than in src/community/challenges.js,
// despite the name. It is one comparison lift a coach sets for the week; it
// shares neither the challenges table nor a line of that module's code, and
// grouping the two on the strength of a shared word is how two unrelated
// features end up entangled.
//
// WHAT STAYED BEHIND, deliberately:
//
//   CLUB_MODULE_TOGGLES, COACH_MODULE_TOGGLES, CLUB_MODULE_KEYS,
//   loadClubFeatures() and isModuleEnabled(). Every module in the layer asks
//   isModuleEnabled() whether its own surface is switched on, exactly as it
//   asks hasPerm() — that is a gate, like the permission set it sits beside
//   in cloud.js, not a club-management feature.
//
//   toggleClubFeature() and renderClubModulesPanel(), which are the admin
//   panel that writes those flags rather than anything that reads them.
//
//   openPrivacySettings(), which sits in the middle of the club WOD block
//   but belongs to the member's own privacy surface.

  // COMM-222. Own-row select; seed_onboarding_progress (202608290011) seeds
  // exactly one row per member at MEMBER_JOINED, so null here means "not
  // loaded yet" or a real fetch error, never "no row for this member."
  async function loadOnboardingProgress() {
    if (!state.user) return;
    const { data, error } = await client.from("onboarding_progress").select("*").eq("user_id", state.user.id).maybeSingle();
    state.onboarding.progress = error ? null : (data || null);
  }
  // COMM-373/378. All five rows, open to every signed-in member under
  // onboarding_step_content's own `using (true)` read policy - not staff-
  // gated, since every member's own onboarding cards read from here, not
  // only COMM-378's editor. Loaded once at boot alongside
  // loadOnboardingProgress(); the editor's own retry re-runs this same
  // function rather than a second loader.
  async function loadOnboardingStepContent() {
    if (!state.user) return;
    const { data, error } = await client.from("onboarding_step_content").select("step,title,body,updated_at");
    if (error) { state.onboarding.stepContentError = true; return; }
    const map = {};
    for (const row of (data || [])) map[row.step] = row;
    state.onboarding.stepContent = map;
    state.onboarding.stepContentLoaded = true;
    state.onboarding.stepContentError = false;
  }
  // Redesign, Phase 3. Same read audience and shape as
  // loadOnboardingStepContent() just above (every authenticated member,
  // `using (true)`), a sibling table, loaded lazily the first time the
  // carousel or its editor is about to render, not at boot: a returning
  // member (the overwhelming majority of sessions once launch has passed)
  // never reaches either. Explicit rerender() at the end, unlike
  // loadOnboardingStepContent() above - that one is always called from
  // inside afterRenderCommunity(), which rerenders nothing itself but runs
  // right after a render already happened; this one is called directly
  // from inside a render function (renderIntroCarousel/
  // renderIntroCarouselContentEditor, the same "render triggers its own
  // one-shot lazy load" shape verifyRecovery() already uses a few hundred
  // lines below), so it has to trigger the follow-up render itself.
  // WHY THE IN-FLIGHT GUARD. renderIntroCarousel() calls this DURING RENDER
  // when the content has not loaded, and the only conditions it could check
  // - contentLoaded / contentError - are both set when the request RETURNS.
  // So while one read was in flight every subsequent render started another
  // one, and each of those ended in its own rerender(), replacing #content.
  //
  // That is not merely wasteful. A member who taps "הבא" in that window can
  // have the tap land on a node a redundant rerender is about to destroy, and
  // the tap does nothing at all - the same defect class as COMM-234's
  // confirm sheet, where a control existed but could not be reached. It
  // surfaced as an intermittently failing release gate
  // (community-intro-carousel.mjs timing out waiting for step 2 under
  // run-all's load, passing every time the file ran alone), which is the
  // mildest symptom of a real bug rather than a test problem: a flaky gate
  // teaches people to re-run until green, and the bug it was reporting is one
  // a member feels as "the button did not work".
  //
  // One read, one rerender. Cleared in a finally so a thrown request cannot
  // wedge the flag and leave the carousel on its fallback copy forever.
  async function loadIntroCarouselContent() {
    if (!state.user || state.intro.contentLoading) return;
    state.intro.contentLoading = true;
    let data, error;
    try {
      ({ data, error } = await client.from("intro_carousel_content").select("step,title,body,updated_at"));
    } finally {
      state.intro.contentLoading = false;
    }
    if (error) { state.intro.contentError = true; return rerender(); }
    const map = {};
    for (const row of (data || [])) map[row.step] = row;
    state.intro.content = map;
    state.intro.contentLoaded = true;
    state.intro.contentError = false;
    rerender();
  }
  const INTRO_CAROUSEL_STEPS = ["welcome_intro", "club_rules", "getting_started"];
  // Byte-identical to intro_carousel_content's own seed (202609050007) -
  // first deploy, and any moment before the table has loaded, shows exactly
  // this, so there is no flash once the real (identical, until a staff
  // member edits it) row arrives.
  const INTRO_CAROUSEL_FALLBACK = {
    welcome_intro: { title: "ברוכים הבאים", body: "אנחנו שמחים שהצטרפתם אלינו. בואו נכיר את המועדון בכמה מסכים קצרים." },
    club_rules: { title: "כללי המועדון", body: "שעות הפעילות, קוד הלבוש, כללי הציוד האישי ומדיניות הביטולים - כל המידע הזה זמין תמיד בלשונית הקהילה." },
    getting_started: { title: "איך מתחילים", body: "קבעו אימון היכרות עם מאמן/ת, וקבלו התאמה אישית לתוכנית האימונים שלכם." },
  };
  function introStepTitle(step) {
    const c = state.intro.content[step];
    return (c && c.title) || INTRO_CAROUSEL_FALLBACK[step].title;
  }
  function introStepBody(step) {
    const c = state.intro.content[step];
    return (c && c.body) || INTRO_CAROUSEL_FALLBACK[step].body;
  }
  // One-time, per DEVICE (not per member - the same "cross-device sync is
  // explicitly out of scope" call already made for this module elsewhere),
  // same localStorage-flag shape as every other one-time client-side flag
  // in this file (e.g. backupOptedOut() below). Never replays once seen,
  // matching app.js's own openOnboarding()/hasOnboarded tour for the exact
  // same reason: a member who already sat through it once must not see it
  // again on a later visit from the same browser.
  const INTRO_CAROUSEL_SEEN_KEY = "haimunia-demo:seenIntroCarousel";
  function hasSeenIntroCarousel() {
    try { return localStorage.getItem(INTRO_CAROUSEL_SEEN_KEY) === "1"; } catch (e) { return false; }
  }
  function introCarouselNext() {
    if (state.intro.step < INTRO_CAROUSEL_STEPS.length - 1) { state.intro.step += 1; return rerender(); }
    try { localStorage.setItem(INTRO_CAROUSEL_SEEN_KEY, "1"); } catch (e) {}
    rerender();
  }
  function introCarouselBack() {
    if (state.intro.step > 0) { state.intro.step -= 1; rerender(); }
  }

  function renderIntroCarousel() {
    if (!state.intro.contentLoaded && !state.intro.contentError) loadIntroCarouselContent();
    const stepIdx = state.intro.step;
    const step = INTRO_CAROUSEL_STEPS[stepIdx];
    const isLast = stepIdx === INTRO_CAROUSEL_STEPS.length - 1;
    const dots = INTRO_CAROUSEL_STEPS.map((_, i) => `<span style="display:inline-block;height:8px;width:${i === stepIdx ? "22px" : "8px"};border-radius:4px;background:${i === stepIdx ? "var(--brass)" : "var(--border)"};transition:width .2s;"></span>`).join(" ");
    return `<div class="chart-card" data-intro-carousel="1" data-intro-step="${step}" style="text-align:center;padding:0;overflow:hidden;">
      <div style="padding:16px 16px 0;text-align:start;">${renderJoinProgress(2)}</div>

      <div style="padding:0 16px 16px;">
      <div style="display:flex;justify-content:center;gap:6px;margin-bottom:16px;">${dots}</div>
      <div style="font-weight:800;font-size:20px;margin-bottom:10px;">${esc(introStepTitle(step))}</div>
      <div style="color:var(--steel);font-size:14px;line-height:1.7;margin-bottom:20px;">${esc(introStepBody(step))}</div>
      <button class="save-btn" data-community-action="intro-carousel-next">${isLast ? "המשך להשלמת הפרופיל" : "הבא"}</button>
      ${stepIdx > 0 ? `<button class="link-btn" data-community-action="intro-carousel-back" style="display:block;margin:12px auto 0;">חזרה</button>` : ""}
      </div>
    </div>`;
  }

  // ---- COMM-222 onboarding sequence -----------------------------------
  // COMM-316 (closing COMM-P07) added the two steps tied to the member's
  // first and third class, once attendance existed to tie them to.
  const ONBOARDING_STEP_COLUMNS = { welcome: "welcomed_at", first_week: "first_week_shown_at", first_month: "first_month_shown_at", first_class: "first_class_shown_at", third_class: "third_class_shown_at" };
  // Which single step (if any) is due right now. THE ORDER, and why it is
  // safe:
  //
  //   welcome -> first_week -> first_month -> first_class -> third_class
  //
  // The first three are COMM-222, UNCHANGED - same columns, same elapsed-
  // time conditions, checked first and in the same order they always were.
  // That is what makes COMM-316's own acceptance criterion ("these two
  // steps do not block or reorder the three already-shipped steps") true
  // STRUCTURALLY rather than by convention: the two attendance checks below
  // only run once none of the three time-based steps is due, so a first or
  // third class landing early, late, or never cannot move welcome's Day-1
  // firing, first_week's 7-day firing or first_month's 30-day firing by so
  // much as a render.
  //
  // JUDGMENT CALL (the ticket names this as one, not fully specified):
  // first-class ranks below all three existing steps rather than between
  // welcome and first-week. The tempting alternative - an eager member who
  // logs a class on day one seeing "first class" before or instead of
  // "welcome" - was rejected because the single onboarding slot can only
  // show one card, and letting an attendance milestone occupy that slot
  // ahead of (or instead of) welcome/first_week would be exactly the
  // "reorder" effect the ticket's own criterion asks this file to avoid.
  // Appending the two new checks after the three, rather than interleaving
  // them, is the version where that claim can be verified by reading the
  // first three lines below and stopping - they are byte-for-byte what
  // COMM-222 shipped. first-class ranks above third-class for the obvious
  // reason: three classes cannot happen before one.
  //
  // Only one step shows at a time, the same COMM-222 shape: a later step
  // becoming due never hides an earlier one still undismissed, and
  // dismissing one lets whichever step is due next - by this same order -
  // show on the very next render.
  function currentOnboardingStep() {
    const row = state.onboarding.progress;
    const redeemedAtRaw = state.redemption && state.redemption.redeemed_at;
    if (!row || !redeemedAtRaw) return null;
    const redeemedAt = new Date(redeemedAtRaw).getTime();
    if (!Number.isFinite(redeemedAt)) return null;
    const DAY_MS = 86400000;
    const elapsed = Date.now() - redeemedAt;
    if (row.welcomed_at == null) return "welcome";
    if (row.first_week_shown_at == null && elapsed >= 7 * DAY_MS) return "first_week";
    if (row.first_month_shown_at == null && elapsed >= 30 * DAY_MS) return "first_month";
    // COMM-316. Eligibility here is attendance, not elapsed time - "do I
    // have at least one attendance_log row" / "...at least three distinct
    // occurred_on days" - read client-side under attendance_log_self_select
    // (202608310001) by loadOnboardingAttendance(), never a server column or
    // RPC (the schema migration's own comment: "the client asks the table
    // it already reads"). `!loaded` reads as "not due yet", the same as any
    // step whose data has not arrived - never as "due", which would risk a
    // step flashing on before its real eligibility is known and then off
    // once the real answer turns out to be "not yet".
    if (!state.onboarding.attendance.loaded) return null;
    if (row.first_class_shown_at == null && state.onboarding.attendance.count >= 1) return "first_class";
    if (row.third_class_shown_at == null && state.onboarding.attendance.count >= 3) return "third_class";
    return null;
  }
  // COMM-316. Own-row attendance count - the only input the two new steps'
  // eligibility needs. attendance_log is unique on (user_id, occurred_on)
  // (202608310001), so a plain row count already IS the distinct-day count;
  // there is no separate "distinct days" query to write. Lazy, and fetched
  // from the Feed sub-tab rather than the boot Promise.all, for the exact
  // reason renderClassmatesTodayCard's own loader documents for the same
  // table: the member's own attendance row for a class taken today is
  // written by the private_records trigger behind flushOutbox(), which runs
  // AFTER the boot batch, so asking during boot could ask before that row
  // exists and read a stale "not eligible yet" answer for an entire
  // session.
  async function loadOnboardingAttendance() {
    if (!client || !state.user) return;
    const s = state.onboarding.attendance;
    s.loading = true;
    rerender();
    const { data, error } = await client.from("attendance_log").select("occurred_on").eq("user_id", state.user.id);
    s.loading = false; s.loaded = true;
    if (error) { s.error = true; s.count = 0; return rerender(); }
    s.error = false;
    s.count = Array.isArray(data) ? data.length : 0;
    rerender();
  }
  // The write only ever happens from a Dismiss click inside the card that
  // is already on screen (COMM-222: "shown" means actually rendered, not
  // merely scheduled) - there is no eligibility-computation path that ever
  // calls this on its own. Fire-and-forget per contracts.md's note on this
  // table: the BEFORE UPDATE pin trigger makes a repeat or a retried
  // failed write harmless, so a failed write here surfaces no error - the
  // next full load re-reads the row, finds the stamp still null, and the
  // step simply becomes due again.
  async function dismissOnboardingStep(step) {
    const col = ONBOARDING_STEP_COLUMNS[step];
    if (!col || !state.onboarding.progress || !state.user || !client) return;
    state.onboarding.progress[col] = new Date().toISOString();
    rerender();
    // Same real bug pingActivity() had, found in the same front-end review
    // pass: .catch() chained directly on a PostgrestFilterBuilder throws
    // synchronously against the real client (its builder has no .catch
    // method, only .then), so this write has never actually reached the
    // server. Real impact here is worse than a missing ping: the optimistic
    // local update above always makes the dismiss LOOK like it worked this
    // session, but the server-side stamp never lands - so on the member's
    // very next load, onboarding_progress reads the column back as still
    // null and the exact same step shows again. Fire-and-forget is the
    // right shape here (the optimistic update above already rerendered;
    // this must not block on the network) - Promise.resolve() wraps the
    // builder in a real Promise instance so .catch() is a genuine method
    // rather than being called on the bare thenable, the same fix
    // feed_record_impressions/feed_record_interaction already use a few
    // hundred lines below.
    Promise.resolve(client.from("onboarding_progress").update({ [col]: new Date().toISOString() }).eq("user_id", state.user.id)).catch(() => {});
  }
  // Lazy, same pattern the audit log already uses (afterRenderCommunity):
  // fetched once, only when the step it feeds is actually due, not on
  // every session. Built from the same aggregation weekly_recaps uses
  // (COMM-220) over the member's own first month - not the Phase 3
  // club-wide monthly recap.
  // Live bug hunt (2026-09-11): weekly_recaps.week_start is always the
  // MONDAY of that ISO week (DB check constraint, extract(isodow from
  // week_start) = 1) - a member who joins on any day but Monday has a join
  // week whose week_start falls BEFORE redeemedAt, so filtering
  // `week_start &gt;= redeemedAt` silently dropped their entire join-week row,
  // sessions/PRs/achievements included, even though every session in it
  // genuinely happened on or after the day they joined. Confirmed live: a
  // Wednesday join with 3 real sessions/1 PR/1 achievement that same week
  // rendered "0 שיאים ו-0 הישגים" and undercounted sessions by those 3 -
  // most real signups aren't on a Monday, so this hit the majority case,
  // not an edge one. Fixed by lower-bounding at the MONDAY of the join
  // week instead of the join instant itself, matching the DB's own
  // week_start convention.
  function mondayOnOrBeforeIso(dateIso) {
    const d = new Date(dateIso + "T00:00:00Z");
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    d.setUTCDate(d.getUTCDate() - ((day + 6) % 7)); // back up to Monday
    return d.toISOString().slice(0, 10);
  }
  async function loadOnboardingFirstMonthSummary() {
    if (!state.user || !client || !state.redemption || !state.redemption.redeemed_at) return;
    state.onboarding.firstMonth = { loading: true, error: false, sessions: 0, prs: 0, achievements: 0 };
    const redeemedAt = new Date(state.redemption.redeemed_at);
    const monthEnd = new Date(redeemedAt.getTime() + 30 * 86400000);
    // READ THE MEMBER'S OWN ROWS, not last week's recap.
    //
    // Live bug hunt, fresh round 6 (2026-09-15) - HIGH. This used to sum
    // weekly_recaps, which the Monday cron writes for the most recently
    // COMPLETED ISO week. The card fires the moment 30 days elapse, and that
    // moment is always inside an in-progress week - so up to six days of the
    // member's most recent and most relevant training was invisible to it.
    //
    // At its worst it was not an undercount but a falsehood: a member who
    // started training three days ago, including that morning, had no recap
    // row at all and was told "0 אימונים, 0 שיאים ו-0 הישגים חדשים. כל הכבוד!"
    // That is the RECAP-1 failure this project already fixed once for the
    // weekly push - congratulating someone for doing nothing - except here it
    // also states something untrue, and it is the COMMON case rather than an
    // edge one, since day 30 almost never lands on a freshly-recapped Monday.
    //
    // attendance_log and member_achievements are both the member's own rows,
    // readable under their own self-select policies, and both are complete up
    // to this instant.
    //
    // THE PR COUNT IS GONE, deliberately. There is no complete client-side
    // source for it: weekly_recaps.prs is computed inside the recap Edge
    // Function and carries the same completed-week-only cutoff. Reporting two
    // true numbers is better than three where one is quietly wrong, and a
    // figure that is right for three weeks out of four is the kind of thing
    // nobody ever notices is broken.
    const startIso = redeemedAt.toISOString().slice(0, 10);
    const endIso = monthEnd.toISOString().slice(0, 10);
    const [att, ach] = await Promise.all([
      client.from("attendance_log").select("occurred_on").eq("user_id", state.user.id)
        .gte("occurred_on", startIso).lte("occurred_on", endIso),
      client.from("member_achievements").select("id").eq("user_id", state.user.id)
        .gte("unlocked_at", redeemedAt.toISOString()).lte("unlocked_at", monthEnd.toISOString()),
    ]);
    if (!state.onboarding.firstMonth) return; // dismissed/torn down mid-flight
    if (att.error || ach.error) { state.onboarding.firstMonth = { loading: false, error: true, sessions: 0, achievements: 0 }; return rerender(); }
    state.onboarding.firstMonth = {
      loading: false, error: false,
      sessions: Array.isArray(att.data) ? att.data.length : 0,
      achievements: Array.isArray(ach.data) ? ach.data.length : 0,
    };
    rerender();
  }
  function renderOnboardingCard(title, bodyHtml, step, extraActionHtml) {
    return `<div class="chart-card admin-card" style="margin-bottom:12px;" data-onboarding-step="${step}">
      <div style="font-weight:800;margin-bottom:6px;">${bidiText(title)}</div>
      <div style="font-size:13px;line-height:1.6;color:var(--steel);margin-bottom:10px;">${bodyHtml}</div>
      <div class="chip-row">${extraActionHtml || ""}<button class="chip-btn primary" data-community-action="onboarding-dismiss" data-step="${step}">הבנתי</button></div>
    </div>`;
  }
  // COMM-378. Every one of the five card renderers below now reads its
  // title/body from state.onboarding.stepContent (COMM-373's table) instead
  // of a literal string, falling back to today's exact hardcoded copy while
  // that table has not loaded yet - the two are byte-identical on first
  // deploy (COMM-373's own seed), so there is no flash either way. welcome/
  // first_class/third_class have no dynamic line at all: the table's body IS
  // the whole card, editable end to end. first_week/first_month are the two
  // COMM-373 seeded with an EMPTY body on purpose (their bodies are entirely
  // computed today) - this function prepends the table's body (once a staff
  // member fills one in) before that same computed sentence, never after,
  // per COMM-378's own "appended after the editable lead sentence" criterion
  // read from the other direction (the lead comes first, the computed line
  // follows it).
  function onboardingStepTitle(step, fallback) {
    const c = state.onboarding.stepContent[step];
    return (c && c.title) || fallback;
  }
  // Raw (unescaped) body text, or "" when the table has not loaded yet or
  // the row's own body is empty (first_week/first_month's own seed) - every
  // caller below decides for itself when and how to escape it, since the
  // static-body cards (welcome/first_class/third_class) need it escaped
  // alone while the computed-line cards (first_week/first_month) need it
  // escaped and then concatenated with ALREADY-RAW computed HTML.
  function onboardingStepBodyRaw(step) {
    const c = state.onboarding.stepContent[step];
    return (c && typeof c.body === "string") ? c.body : "";
  }
  // EVERY LABEL THE COMPOSER HAS EVER CARRIED, newest first.
  //
  // The welcome card's body is STORED (onboarding_step_content, seeded by
  // 202609150007) and the composer's label is a constant in cloud.js, so a
  // rename moves one and not the other. That is not a hypothetical: it is the
  // exact defect this card was already fixed for once - "the first card a new
  // member saw pointed at a button not on the screen" - and the social feed
  // pass, which renamed the label to "מה עשית היום?", would have recreated it
  // for every club whose row still carries the seeded sentence.
  //
  // So a stored body is corrected AT RENDER TIME, and no member reads an
  // instruction naming a control that is not there.
  //
  // THIS LIST IS A STOPGAP AND SHOULD NOT SURVIVE. The real repair is one
  // UPDATE on onboarding_step_content, guarded on `updated_by is null`
  // exactly as 202609150007's own correction is, so a club that has written
  // its own words keeps them. This branch deliberately adds no migration
  // (CLAUDE.md, "Parallel work": one open branch adds a migration at a time),
  // so that UPDATE and the deletion of this list are one follow-up commit.
  const RETIRED_COMPOSER_LABELS = ["מה קורה היום?", "כתיבת פוסט"];
  function withCurrentComposerLabel(body) {
    let out = String(body || "");
    for (const retired of RETIRED_COMPOSER_LABELS) out = out.split(retired).join(POST_COMPOSER_PLACEHOLDER);
    return out;
  }
  function renderOnboardingWelcomeStep() {
    // Names the composer by the label it ACTUALLY carries - in the fallback
    // below through POST_COMPOSER_PLACEHOLDER, which is the single definition
    // of that label, and in a stored body through withCurrentComposerLabel()
    // above. first-run-copy.test.mjs asserts both.
    const bodyRaw = withCurrentComposerLabel(onboardingStepBodyRaw("welcome")) || `כאן רואים מה קורה במועדון, ואפשר לשתף אימונים ושיאים ולהגיב לחברים אחרים. השורה "${POST_COMPOSER_PLACEHOLDER}" בראש הפיד פותחת את השיתוף הראשון שלכם.`;
    return renderOnboardingCard(onboardingStepTitle("welcome", "ברוכים הבאים לקהילה!"), bidiText(bodyRaw), "welcome");
  }
  function renderOnboardingFirstWeekStep() {
    // COMM-207's own list, sorted the same soonest-end-first order the
    // Boards tab already uses - just the first entry.
    const active = state.challenges.items.filter((c) => c.status === "active").slice().sort((a, b) => new Date(a.end_at) - new Date(b.end_at))[0];
    const computed = active
      ? `יש אתגר פעיל במועדון עכשיו: <strong>${bidiText(active.title)}</strong>.`
      : `אין כרגע אתגר פעיל במועדון, אבל שווה להציץ בלוח האתגרים מדי פעם.`;
    const leadRaw = onboardingStepBodyRaw("first_week");
    const lead = leadRaw ? bidiText(leadRaw) + " " : "";
    const openBtn = active ? `<button class="chip-btn" data-community-action="open-challenge" data-id="${esc(active.id)}" data-source="onboarding">פתיחת האתגר</button>` : "";
    return renderOnboardingCard(onboardingStepTitle("first_week", "השבוע הראשון שלכם מאחוריכם"), lead + computed, "first_week", openBtn);
  }
  function renderOnboardingFirstMonthStep() {
    const summary = state.onboarding.firstMonth;
    const computed = (!summary || summary.loading)
      ? `<span aria-hidden="true" style="display:inline-block;height:12px;width:70%;background:var(--border);border-radius:6px;"></span>`
      : summary.error
      ? `החודש הראשון שלכם הסתיים - לא הצלחנו לטעון את הסיכום כרגע.`
      // Live bug hunt (2026-09-11): missing singular branches - a real
      // 1-session/1-PR/1-achievement first month (test/community-
      // onboarding.test.mjs's own seed data) rendered "1 שיאים"/"1 הישגים".
      // NOTHING TO CONGRATULATE IS NOT A REASON TO CONGRATULATE. A member who
      // joined a month ago and has not trained gets an invitation, not praise
      // for a zero - the same rule RECAP-1 established for the weekly push.
      : summary.sessions === 0
      ? `החודש הראשון שלכם במועדון עבר. עוד לא רשמתם אימון — האימון הראשון הוא תמיד הכי קשה להתחיל, ואנחנו כאן בשבילו.`
      : `החודש הראשון שלכם: ${summary.sessions === 1 ? "אימון אחד" : `${summary.sessions} אימונים`}${summary.achievements ? ` ו-${summary.achievements === 1 ? "הישג חדש אחד" : `${summary.achievements} הישגים חדשים`}` : ""}. כל הכבוד!`;
    const leadRaw = onboardingStepBodyRaw("first_month");
    const lead = leadRaw ? bidiText(leadRaw) + " " : "";
    return renderOnboardingCard(onboardingStepTitle("first_month", "החודש הראשון שלכם במועדון"), lead + computed, "first_month");
  }
  // COMM-316. Static copy, same shape as welcome above - no dependent data
  // to load beyond the attendance count that already decided the step is
  // due (currentOnboardingStep), so there is no loading/error variant here
  // the way first_month's summary needs one.
  function renderOnboardingFirstClassStep() {
    const bodyRaw = onboardingStepBodyRaw("first_class") || `האימון הראשון שלכם כבר נרשם במערכת. ממשיכים באותו הקצב?`;
    return renderOnboardingCard(onboardingStepTitle("first_class", "הגעתם לאימון הראשון!"), bidiText(bodyRaw), "first_class");
  }
  function renderOnboardingThirdClassStep() {
    const bodyRaw = onboardingStepBodyRaw("third_class") || `שלושה אימונים כבר מאחוריכם. ככה בונים הרגל אימונים.`;
    return renderOnboardingCard(onboardingStepTitle("third_class", "אימון שלישי — אתם כבר בקצב!"), bidiText(bodyRaw), "third_class");
  }
  function renderOnboardingStep() {
    const step = currentOnboardingStep();
    // NOTHING while progress is unknown - not a skeleton.
    //
    // A skeleton is a promise that something IS coming, and here that promise
    // is usually false: every member who has finished onboarding resolves to
    // no step at all, so the grey box was reserving space for a card that
    // would never arrive, on the screen they open most. It also cost real
    // money under the rail budget (RAIL_ABOVE_FEED): the placeholder occupied
    // one of only two slots above the feed and pushed out the coach's pinned
    // note or today's programming - actual content, displaced by a box with
    // nothing in it.
    //
    // This is the same "renders nothing when empty, never an empty
    // placeholder" rule the upcoming-event and classmates-today cards already
    // follow. The step appears when it is real.
    if (!state.onboarding.progress) return "";
    if (!step) return "";
    if (step === "welcome") return renderOnboardingWelcomeStep();
    if (step === "first_week") return renderOnboardingFirstWeekStep();
    if (step === "first_month") return renderOnboardingFirstMonthStep();
    if (step === "first_class") return renderOnboardingFirstClassStep();
    return renderOnboardingThirdClassStep();
  }

  const ONBOARDING_STEPS_ORDER = ["welcome", "first_week", "first_month", "first_class", "third_class"];
  const ONBOARDING_STEP_LABELS = {
    welcome: "ברוכים הבאים", first_week: "השבוע הראשון", first_month: "החודש הראשון",
    first_class: "אימון ראשון", third_class: "אימון שלישי",
  };
  // Seeded from the loaded row the first time a step is touched, and never
  // re-seeded from a background reload afterward - so a save landing on one
  // row (which triggers loadOnboardingStepContent() again) can never clobber
  // an in-progress, unsaved edit on a sibling row.
  function onboardingEditorDraft(step) {
    const drafts = state.onboarding.editor.drafts;
    if (!drafts[step]) {
      const c = state.onboarding.stepContent[step];
      drafts[step] = { title: (c && c.title) || "", body: (c && c.body) || "" };
    }
    return drafts[step];
  }
  async function saveOnboardingContent(step) {
    if (!state.user || !(hasPerm(PERM.CONTENT_MANAGE_ONBOARDING) || isAdmin())) return;
    const e = state.onboarding.editor;
    if (e.saving[step]) return;
    const draft = onboardingEditorDraft(step);
    const title = String(draft.title || "").trim().slice(0, 120);
    const body = String(draft.body || "").slice(0, 2000);
    const formId = "onboardingEdit_" + step;
    if (!title) { setFieldErrors(formId, { title: "יש למלא כותרת" }); return; }
    setFieldErrors(formId, {});
    e.saving[step] = true; e.saved[step] = false; rerender();
    const { error } = await mgmtDb().from("onboarding_step_content").update({ title, body }).eq("step", step);
    e.saving[step] = false;
    if (error) { setFieldErrors(formId, { title: "השמירה נכשלה, נסו שוב." }); rerender(); return; }
    // contracts.md's own COMM-373 note: a refused UPDATE against this table
    // never raises - a failing RLS USING clause on UPDATE just matches zero
    // rows - so a client that only checks `error` cannot tell a real save
    // from a silently-dropped one. Reading the row back is the only honest
    // check; a mismatch means the write did not really land.
    await loadOnboardingStepContent();
    const saved = state.onboarding.stepContent[step];
    if (!saved || saved.title !== title || (saved.body || "") !== body) {
      setFieldErrors(formId, { title: "השמירה לא בוצעה - ייתכן שאין הרשאה מספקת." });
      rerender();
      return;
    }
    delete e.drafts[step]; // next read reflects the fresh server row
    e.saved[step] = true;
    rerender();
  }
  function renderOnboardingContentEditor() {
    if (!(hasPerm(PERM.CONTENT_MANAGE_ONBOARDING) || isAdmin())) return "";
    let body;
    if (!state.onboarding.stepContentLoaded && !state.onboarding.stepContentError) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="log-list" aria-busy="true" data-onboarding-editor-skeleton="1">${skRow.repeat(5)}</div>`;
    } else if (state.onboarding.stepContentError) {
      body = `<div class="empty">לא ניתן היה לטעון את תוכן ההיכרות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="onboarding-content-retry">ניסיון חוזר</button></div></div>`;
    } else {
      body = ONBOARDING_STEPS_ORDER.map((step) => {
        const draft = onboardingEditorDraft(step);
        const formId = "onboardingEdit_" + step;
        const saving = !!state.onboarding.editor.saving[step];
        const saved = !!state.onboarding.editor.saved[step];
        return `<div class="chart-card" style="margin-bottom:10px;" data-onboarding-editor-row="${step}">
          <h3 class="field-label" style="margin-bottom:6px;">${esc(ONBOARDING_STEP_LABELS[step] || step)}</h3>
          ${field(formId, "title", "כותרת", `<input class="text-input" maxlength="120" data-onboarding-edit-title="${step}" value="${esc(draft.title)}"/>`)}
          ${field(formId, "body", "משפט פתיחה", `<textarea class="text-input" maxlength="2000" rows="3" data-onboarding-edit-body="${step}">${esc(draft.body)}</textarea>`)}
          <div class="chip-row" style="margin-top:6px;">
            <button class="chip-btn primary" data-community-action="onboarding-content-save" data-step="${step}"${saving ? " disabled" : ""}>${saving ? "שומר…" : "שמירה"}</button>
            ${saved ? `<span class="footer-note" role="status">נשמר</span>` : ""}
          </div>
        </div>`;
      }).join("");
    }
    return `<div class="ach-section" style="margin-top:18px;" data-onboarding-editor-section="1">${sectionHead("var(--teal)", "עריכת תוכן היכרות", true)}${body}</div>`;
  }
  // Redesign, Phase 3. The intro-carousel's own editor, right beside
  // renderOnboardingContentEditor() above in the Manage tab's "קליטה"
  // sub-tab - same permission, same skeleton/error/populated shape, same
  // per-row draft/saving/saved state, one level up (state.intro.editor
  // instead of state.onboarding.editor), pointed at intro_carousel_content
  // instead of onboarding_step_content. Kept as a second function rather
  // than parameterizing the one above: the two tables are a deliberate
  // sibling pair, not a shared abstraction (see intro_carousel_content's
  // own migration comment), and duplicating ~25 lines of straightforward
  // render logic is cheaper to read correctly than a generalized editor
  // threading a table name and a state-slice reference through every call.
  const INTRO_CAROUSEL_LABELS = { welcome_intro: "1. ברוכים הבאים", club_rules: "2. כללי המועדון", getting_started: "3. איך מתחילים" };
  function introEditorDraft(step) {
    const drafts = state.intro.editor.drafts;
    if (!drafts[step]) drafts[step] = { title: introStepTitle(step), body: introStepBody(step) };
    return drafts[step];
  }
  async function saveIntroCarouselContent(step) {
    if (!state.user || !(hasPerm(PERM.CONTENT_MANAGE_ONBOARDING) || isAdmin())) return;
    const e = state.intro.editor;
    if (e.saving[step]) return;
    const draft = introEditorDraft(step);
    const title = String(draft.title || "").trim().slice(0, 120);
    const body = String(draft.body || "").slice(0, 2000);
    const formId = "introEdit_" + step;
    if (!title) { setFieldErrors(formId, { title: "יש למלא כותרת" }); return; }
    setFieldErrors(formId, {});
    e.saving[step] = true; e.saved[step] = false; rerender();
    const { error } = await mgmtDb().from("intro_carousel_content").update({ title, body }).eq("step", step);
    e.saving[step] = false;
    if (error) { setFieldErrors(formId, { title: "השמירה נכשלה, נסו שוב." }); rerender(); return; }
    // Same honest read-back check onboarding_step_content's own editor
    // uses just above - an UPDATE this table's RLS refuses also just
    // matches zero rows rather than raising.
    await loadIntroCarouselContent();
    const saved = state.intro.content[step];
    if (!saved || saved.title !== title || (saved.body || "") !== body) {
      setFieldErrors(formId, { title: "השמירה לא בוצעה - ייתכן שאין הרשאה מספקת." });
      rerender();
      return;
    }
    delete e.drafts[step];
    e.saved[step] = true;
    rerender();
  }
  function renderIntroCarouselContentEditor() {
    if (!(hasPerm(PERM.CONTENT_MANAGE_ONBOARDING) || isAdmin())) return "";
    if (!state.intro.contentLoaded && !state.intro.contentError) loadIntroCarouselContent();
    let body;
    if (!state.intro.contentLoaded && !state.intro.contentError) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="log-list" aria-busy="true" data-intro-editor-skeleton="1">${skRow.repeat(3)}</div>`;
    } else if (state.intro.contentError) {
      body = `<div class="empty">לא ניתן היה לטעון את תוכן מסך הפתיחה.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="intro-content-retry">ניסיון חוזר</button></div></div>`;
    } else {
      body = INTRO_CAROUSEL_STEPS.map((step) => {
        const draft = introEditorDraft(step);
        const formId = "introEdit_" + step;
        const saving = !!state.intro.editor.saving[step];
        const saved = !!state.intro.editor.saved[step];
        return `<div class="chart-card" style="margin-bottom:10px;" data-intro-editor-row="${step}">
          <h3 class="field-label" style="margin-bottom:6px;">${esc(INTRO_CAROUSEL_LABELS[step] || step)}</h3>
          ${field(formId, "title", "כותרת", `<input class="text-input" maxlength="120" data-intro-edit-title="${step}" value="${esc(draft.title)}"/>`)}
          ${field(formId, "body", "תוכן", `<textarea class="text-input" maxlength="2000" rows="3" data-intro-edit-body="${step}">${esc(draft.body)}</textarea>`)}
          <div class="chip-row" style="margin-top:6px;">
            <button class="chip-btn primary" data-community-action="intro-content-save" data-step="${step}"${saving ? " disabled" : ""}>${saving ? "שומר…" : "שמירה"}</button>
            ${saved ? `<span class="footer-note" role="status">נשמר</span>` : ""}
          </div>
        </div>`;
      }).join("");
    }
    return `<div class="ach-section" style="margin-top:18px;" data-intro-editor-section="1">${sectionHead("var(--purple)", "עריכת מסך פתיחה לחברים חדשים", true)}${body}</div>`;
  }
  // COMM-218. The three-tier client-facing control that replaces the plain
  // `important` boolean; `announcements.important` still exists server-side
  // as a trigger-maintained mirror (202608290010) but is never written or
  // read directly from here. Order matters: it drives the <select> option
  // order in the composer.
  const ANNOUNCEMENT_PRIORITY_OPTIONS = [
    { value: "normal", label: "רגילה" },
    { value: "important", label: "חשובה" },
    { value: "urgent", label: "דחופה" },
  ];
  // COMM-218. Icon + Hebrew label, never colour alone: `urgent` reads as a
  // stronger, more alarming badge than `important`; `normal` gets no badge
  // at all. Shared by the feed top area and the "today's note" card.
  function announcementPriorityBadge(a) {
    const priority = (a && a.priority) || "normal";
    if (priority === "urgent") return `<span class="admin-tag" role="status" style="color:var(--red-text);background:color-mix(in srgb, var(--red) 16%, transparent);border-color:var(--red);">🚨 דחוף</span>`;
    if (priority === "important") return `<span class="admin-tag" role="status" style="color:var(--brass);background:color-mix(in srgb, var(--brass) 14%, transparent);border-color:var(--brass);">❗ חשוב</span>`;
    return "";
  }
  // The accent that goes with the badge above, applied to the wrapping
  // card/row rather than the badge itself: `urgent` gets a full tinted
  // border + background (a banner, not just a chip), `important` gets only
  // the border, so the two tiers stay visually distinct beyond the badge.
  function announcementAccentStyle(a) {
    const priority = (a && a.priority) || "normal";
    if (priority === "urgent") return "border:1px solid var(--red);background:color-mix(in srgb, var(--red) 7%, transparent);";
    if (priority === "important") return "border:1px solid var(--brass);";
    return "";
  }
  // COMM-218. `announcements_read` RLS already drops an expired row for a
  // non-staff member at query time - this is a defensive mirror only, for a
  // session that has had the feed open across the expiry moment without a
  // refetch. Never the boundary itself.
  function isAnnouncementExpired(a) { return !!(a && a.expires_at && new Date(a.expires_at).getTime() <= Date.now()); }
  async function loadAnnouncements() {
    if (!state.user) return;
    const { data, error } = await client.from("announcements").select("id,title,body,created_at,pinned_date,priority,expires_at,profiles(handle,display_name)").order("created_at", { ascending: false }).limit(20);
    state.club.announcements = error ? [] : (data || []);
  }
  async function postAnnouncement(form) {
    if (!state.user || !isStaff()) return;
    // Live bug hunt (2026-09-11): same cleanStr gap as saveProfile() - a
    // staff-only surface, but the same control-char/bidi-override class of
    // input was still accepted and stored raw.
    const title = cleanStr(form.elements.title.value, 120);
    // Live bug hunt (2026-09-11): this used to slice at 2000, but the
    // announcement's OWN feed card (POST_ANNOUNCEMENT, produced server-side
    // from this row) renders through the same postBodyHtml() every other
    // post type does, hard-capped at POST_BODY_MAX (1000) with no ellipsis
    // and no "read more" - anything past 1000 was silently invisible to
    // every member reading the card, mid-word, with zero indication
    // anything was missing. Capped at input time instead, matching every
    // other post-composing surface in this file (the main composer's own
    // textarea already uses maxlength="${POST_BODY_MAX}") - an admin now
    // gets immediate feedback from the textarea's own maxlength (updated
    // alongside this) rather than typing content that quietly vanishes.
    const body = String(form.elements.body.value || "").trim().slice(0, POST_BODY_MAX);
    const priorityRaw = String((form.elements.priority && form.elements.priority.value) || "normal");
    const priority = ANNOUNCEMENT_PRIORITY_OPTIONS.some((o) => o.value === priorityRaw) ? priorityRaw : "normal";
    const expiresAtRaw = String((form.elements.expiresAt && form.elements.expiresAt.value) || "").trim();
    const errors = {};
    if (!title) errors.title = "יש למלא כותרת";
    if (!body) errors.body = "יש למלא תוכן להודעה";
    // Client-side only, no server CHECK: a staff member correcting an
    // already-posted announcement's expiry is legitimate (COMM-218). For a
    // brand-new announcement created_at is "now", so "after created_at"
    // means after the moment of submission.
    let expiresAtIso = null;
    if (expiresAtRaw) {
      const expiresAtDate = new Date(expiresAtRaw);
      if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
        errors.expiresAt = "תאריך התפוגה חייב להיות אחרי מועד הפרסום";
      } else {
        expiresAtIso = expiresAtDate.toISOString();
      }
    }
    if (Object.keys(errors).length) return setFieldErrors("communityAnnouncement", errors);
    setFieldErrors("communityAnnouncement", {});
    const payload = { author_id: state.user.id, title, body, priority };
    if (expiresAtIso) payload.expires_at = expiresAtIso;
    if (form.elements.pinToday && form.elements.pinToday.checked) payload.pinned_date = todayIso();
    state.club.announcementSaving = true; rerender();
    const { error } = await client.from("announcements").insert(payload);
    state.club.announcementSaving = false;
    if (error) return setMessage(failText("לא ניתן היה לשמור את ההודעה. נסו שוב.", error));
    form.reset(); await loadAnnouncements(); setMessage("ההודעה פורסמה"); rerender();
  }
  // The comparison key a challenge is built on is a DATABASE key
  // ("movement:back-squat:est1rm"), and until now a coach had to type it into
  // a free-text box from memory. The audit typed six malformed keys and all
  // six were accepted and stored: Hebrew free text, a missing prefix, a
  // misspelled movement id, a bare "movement:". A key that matches nothing
  // produces a challenge no member can ever appear on - and, worse, one that
  // still advertises itself as a hero button on every member's club home.
  //
  // The field is a <select> now, built from the same catalogs app.js builds a
  // key from when someone shares a real result (communityShareCandidateFor:
  // `movement:${entry.exerciseId}:${duration ? "duration" : "est1rm"}` and
  // `wod:${entry.wodId}:${entry.scoreType}:${entry.rx ? "rx" : "scaled"}`), so
  // an invalid key cannot be produced by typing at all, and the two sides
  // cannot drift. The box owner's own words were that being asked to type a
  // database key by hand is why he would not use the feature.
  //
  // CUSTOM movements and WODs are deliberately excluded even though
  // allMovements()/allWods() include them. A custom id is generated per device
  // (uid()), so the coach's own "custom" back squat variant carries a
  // different id from every member's, and a challenge on it could never match
  // anybody's post - exactly the dead leaderboard this is fixing, just
  // reached by a different route.
  //
  // Reached through window.*, not as bare identifiers: allMovements/allWods
  // are function declarations in app.js and so are real properties of the
  // global object, while MOVEMENTS/WOD_LIBRARY are top-level `const`s, which
  // live in a lexical environment cloud.js's own script does not share under
  // the jsdom test harness (see test/helpers/boot.mjs).
  function challengeKeyChoices() {
    const out = [];
    const movements = typeof window.allMovements === "function" ? window.allMovements() : [];
    for (const m of movements) {
      if (!m || !m.id || m.category === "Custom") continue;
      out.push({ group: "תרגילים", key: `movement:${m.id}:est1rm`, label: `${m.name} · 1RM` });
      out.push({ group: "תרגילים", key: `movement:${m.id}:duration`, label: `${m.name} · Time` });
    }
    const wods = typeof window.allWods === "function" ? window.allWods() : [];
    for (const w of wods) {
      // EMOM is the one score type communityShareCandidateFor() refuses to
      // build a key for (it returns null), so there is nothing for an EMOM
      // challenge to ever compare against.
      if (!w || !w.id || w.category === "Custom" || !w.scoreType || w.scoreType === "emom") continue;
      // A retired club WOD stays in allWods() so that history and feed posts
      // keep resolving its id — but the box has stopped programming it, so it
      // must not be offerable as the subject of a NEW challenge.
      //
      // This DOES flow through into challengeKeyExists() below, which is
      // built on this list, and that is correct rather than a leak: the
      // database refuses to retire a WOD while any challenge referencing it
      // has not yet ENDED (club_wod_retire, 'wod is used by a live
      // challenge'), and loadWeeklyChallenge() only ever reads a row whose
      // window contains today. So a currently-active challenge can never be
      // on a retired WOD, and the only thing this skip can turn away is a
      // coach trying to open a NEW challenge on programming the box has
      // retired — which is the intent, not a side effect.
      if (w.category === "Club" && w.retiredAt) continue;
      out.push({ group: "אימונים", key: `wod:${w.id}:${w.scoreType}:rx`, label: `${w.name} · Rx` });
      out.push({ group: "אימונים", key: `wod:${w.id}:${w.scoreType}:scaled`, label: `${w.name} · Scaled` });
    }
    return out;
  }
  function challengeKeyExists(comparisonKey) {
    return challengeKeyChoices().some((c) => c.key === comparisonKey);
  }
  // Option labels are deliberately pure LTR ("Back Squat · 1RM", "Fran · Rx"):
  // the movement and WOD names are English, and <option> text cannot carry a
  // <bdi>, so a Hebrew metric word appended to an English name would be at the
  // mercy of the bidi algorithm with no way to isolate it. Rx/Scaled/1RM are
  // already this app's own vocabulary - app.js prints them untranslated on
  // every WOD entry. The Hebrew that explains the field lives in the label and
  // the hint underneath, where it can be written properly.
  function renderChallengeKeyPicker() {
    const choices = challengeKeyChoices();
    // app.js publishes its catalogs at load; if they are somehow not there
    // yet, a disabled control that says so is honest, and - unlike the free
    // text box this replaces - cannot be used to store a key that means
    // nothing.
    if (!choices.length) return `<select class="text-input" name="comparisonKey" disabled><option value="">רשימת התרגילים והאימונים עדיין נטענת…</option></select>`;
    const selected = state.club.challengeKeyDraft || "";
    const groups = [];
    for (const c of choices) {
      let group = groups.find((g) => g.label === c.group);
      if (!group) groups.push(group = { label: c.group, items: [] });
      group.items.push(c);
    }
    const optgroups = groups.map((g) => `<optgroup label="${esc(g.label)}">${g.items.map((c) => `<option value="${esc(c.key)}"${c.key === selected ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</optgroup>`).join("");
    return `<select class="text-input" name="comparisonKey" data-challenge-key required><option value=""${selected ? "" : " selected"}>בחרו תרגיל או אימון…</option>${optgroups}</select>`;
  }
  // The shape the inline hint under the field has always described. Kept as a
  // separate check from the existence check above so the two failures can say
  // different things: "that is not a key" and "that key names something this
  // app has never heard of" are different mistakes with different fixes.
  const COMPARISON_KEY_SHAPE_RE = /^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$/;
  async function loadWeeklyChallenge() {
    if (!state.user) return;
    // TWO reads, because they answer two different questions and conflating
    // them is what let the club home and the Boards tab contradict each other.
    //
    // weekly_challenge_leaderboard only returns rows where a real post ALREADY
    // matches the challenge key, so a challenge with no entries yet - whether
    // it is brand new or permanently unmatchable because its key is malformed
    // - comes back empty, and the Boards tab reported that as "אין אתגר פעיל
    // כרגע" while the club home was simultaneously showing a bright hero
    // button for that very challenge. The weekly_challenges row is what says
    // whether a challenge EXISTS; the view says who is on it.
    const today = todayIso();
    const { data: rows } = await client.from("weekly_challenges")
      .select("id,title,comparison_key,starts_on,ends_on")
      .lte("starts_on", today).gte("ends_on", today)
      .order("ends_on", { ascending: true }).limit(1);
    const row = rows && rows.length ? rows[0] : null;
    state.club.weeklyChallengeRow = row
      ? { id: row.id, title: row.title, comparisonKey: row.comparison_key, startsOn: row.starts_on, endsOn: row.ends_on }
      : null;
    const { data, error } = await client.from("weekly_challenge_leaderboard").select("*").limit(50);
    if (error || !data || !data.length) { state.club.weeklyChallenge = null; state.club.weeklyLeaderboard = []; return; }
    state.club.weeklyChallenge = { title: data[0].title, comparisonKey: data[0].comparison_key, startsOn: data[0].starts_on, endsOn: data[0].ends_on };
    state.club.weeklyLeaderboard = data.sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
  }
  // The one answer to "is there a weekly challenge a member can actually join
  // right now" - an active row whose key names something real. Anything that
  // advertises a challenge has to go through this, not through the mere
  // existence of a row.
  //
  // DERIVED AT READ TIME, NOT FROZEN AT LOAD TIME (202609060028). It used to
  // be computed once inside loadWeeklyChallenge() and stored as `row.valid`,
  // which was fine while every catalogue allWods() draws on was a compile-time
  // constant shipped inside src/constants.js. The club WOD catalogue is not:
  // it arrives over the network, and on a cold start it also arrives out of
  // IndexedDB on app.js's own boot timeline. Freezing `valid` therefore made
  // the answer depend on which of three independent async paths happened to
  // finish first, and losing that race stamped a perfectly good club
  // challenge invalid FOR THE WHOLE SESSION - no later load could correct it.
  //
  // The alternative considered was ordering the loads (awaiting the catalogue
  // before the challenge read). That fixes the one ordering inside this file
  // and none of the others: app.js's cached-catalogue hydration and a
  // publish made later in the same session are both outside it. Deriving
  // here removes the dependency instead of sequencing it, and costs one
  // catalogue walk on a path that already walks the catalogue to render.
  function weeklyChallengeIsValid(row) {
    if (!row) return false;
    return COMPARISON_KEY_SHAPE_RE.test(String(row.comparisonKey || "")) && challengeKeyExists(row.comparisonKey);
  }
  function activeWeeklyChallenge() {
    const row = state.club.weeklyChallengeRow;
    return weeklyChallengeIsValid(row) ? row : null;
  }
  async function setWeeklyChallenge(form) {
    if (!state.user || !isStaff()) return;
    // Live bug hunt (2026-09-11): same cleanStr gap as saveProfile().
    const title = cleanStr(form.elements.title.value, 120);
    const comparisonKey = String(form.elements.comparisonKey.value || "").trim().slice(0, 160);
    const startsOn = form.elements.startsOn.value, endsOn = form.elements.endsOn.value;
    const errors = {};
    if (!title) errors.title = "יש למלא שם לאתגר";
    // The <select> above cannot produce an invalid key, but a <select> is a UI
    // affordance and not a guarantee - this is the check that actually keeps a
    // dead challenge out of the database.
    if (!comparisonKey) errors.comparisonKey = "יש לבחור תרגיל או אימון לאתגר";
    else if (!COMPARISON_KEY_SHAPE_RE.test(comparisonKey)) errors.comparisonKey = "פורמט לא תקין — movement:שם-תרגיל:est1rm או wod:שם-אימון:סוג-תוצאה:rx";
    // An empty catalog means app.js has not finished loading its data, not
    // that nothing is valid - refusing everything then would be its own lie.
    // The shape check above still stands in that window.
    else if (challengeKeyChoices().length && !challengeKeyExists(comparisonKey)) errors.comparisonKey = "התרגיל או האימון הזה לא קיים באפליקציה, אז אף תוצאה לא תוכל להיספר לאתגר. בחרו מהרשימה.";
    if (!startsOn) errors.startsOn = "יש לבחור תאריך התחלה";
    if (!endsOn) errors.endsOn = "יש לבחור תאריך סיום";
    if (Object.keys(errors).length) return setFieldErrors("communityWeeklyChallenge", errors);
    setFieldErrors("communityWeeklyChallenge", {});
    const { error } = await client.from("weekly_challenges").insert({ title, comparison_key: comparisonKey, starts_on: startsOn, ends_on: endsOn, created_by: state.user.id });
    if (error) return setMessage(failText("קביעת האתגר נכשלה", error));
    state.club.challengeKeyDraft = "";
    form.reset(); await loadWeeklyChallenge(); setMessage("האתגר השבועי עודכן"); rerender();
  }

  // =====================================================================
  // The club WOD catalogue (202609060028)
  // =====================================================================
  // What this is for, in one sentence: a weekly challenge is a
  // comparison_key, and a key of the form wod:<id>:... is only joinable when
  // EVERY member's client can resolve that id. WOD_LIBRARY ships in
  // src/constants.js so a built-in works for free; a custom WOD is local data
  // (IndexedDB plus a private_records row nobody else can read), so a
  // challenge on a coach's own programming resolved on exactly one device and
  // was dead on arrival for the rest of the box. This is the read that makes
  // those ids mean the same thing everywhere.
  //
  // Note what is NOT here: challengeKeyExists() is untouched. Merging the
  // catalogue into app.js's allWods() is the entire fix - the existing
  // one-liner then resolves a club WOD for every member with no special case
  // and, importantly, without being relaxed to accept ids it cannot resolve.
  async function loadClubWods() {
    if (!state.user) return;
    const { data, error } = await client.rpc("club_wods_list");
    // On failure the previously-loaded catalogue is LEFT ALONE rather than
    // blanked. app.js may be holding a cached copy from a previous session
    // that is resolving a member's own history right now; replacing it with
    // [] because one request failed would break exactly the offline case the
    // cache exists for.
    if (error) return;
    state.club.clubWods = data || [];
    if (typeof window.setClubWods === "function") window.setClubWods(state.club.clubWods);
  }
  // Publishing is staff-gated HERE only so a member is never shown a control
  // that can only fail - the real boundary is club_wod_publish() itself,
  // which checks has_perm('community.challenge.create') server-side (not
  // is_staff(): 202609060005 deliberately moved the challenge surface off
  // is_staff(), which also admits the `staff` role, and that role holds no
  // challenge permission at all).
  function publishClubWod(wod) {
    if (!state.user || !isStaff()) return;
    // Only a member's OWN custom WOD is publishable. A club WOD arriving here
    // would mean the affordance is being shown on something already published.
    if (!wod || !wod.id || wod.category !== "Custom" || !wod.name) return;
    askConfirm({
      title: "פרסום אימון לקטלוג המועדון",
      message: "האימון {subject} יהיה זמין לכל חברי המועדון, ויהיה אפשר לקבוע עליו אתגר שבועי. מה שמתפרסם הוא צילום מצב של האימון כפי שהוא עכשיו — עריכה שלו כאן אחר כך לא תעבור לעותק של המועדון.",
      subject: wod.name,
      confirmLabel: "פרסום",
      action: "publish-club-wod",
      payload: { wod },
    });
  }
  async function doPublishClubWod(wod) {
    if (!state.user || !isStaff() || !wod || !wod.id) return;
    // The definition travels in the CALL. The server deliberately does not
    // read it back out of private_records: cloud backup is opt-out, so a
    // coach who switched it off - or whose outbox simply has not flushed the
    // WOD they built two minutes ago - has no server copy to read, and those
    // are the coaches most likely to be publishing.
    const args = {
      p_wod_id: wod.id,
      p_name: wod.name,
      p_score_type: wod.scoreType,
      p_description: wod.desc || "",
      p_time_cap_seconds: wod.timeCapSeconds || null,
    };
    // EMOM is publishable (members can log the box's programming) even though
    // it can never be a challenge - communityShareCandidateFor() returns a
    // null comparison key for it and challengeKeyChoices() skips it.
    if (wod.scoreType === "emom") {
      args.p_emom_movements = wod.emomMovements || [];
      args.p_emom_target_reps = wod.emomTargetReps || [];
      args.p_emom_minutes = wod.emomMinutes || null;
    }
    const { error } = await client.rpc("club_wod_publish", args);
    if (error) return setMessage(serverErrorText(error));
    // Only this. loadWeeklyChallenge() is deliberately NOT called after a
    // publish: it used to be needed because the active challenge's `valid`
    // was frozen at load time, and re-reading the row was the only way to
    // recompute it. activeWeeklyChallenge() derives that at read time now
    // (see weeklyChallengeIsValid), so the next render picks the new
    // catalogue up on its own and a second round trip would buy nothing.
    await loadClubWods();
    setMessage("האימון פורסם לקטלוג המועדון"); rerender();
  }
  // The three corrections. Thin on purpose: every rule about what may change
  // and when lives in the database (score type and the EMOM rotation are
  // immutable because they are what the comparison key and the log form are
  // built from; retiring a WOD out from under a live challenge is refused;
  // there is no delete at all), and duplicating any of it here would only
  // create somewhere for the two to disagree. Each one re-reads the
  // catalogue so app.js's merged view matches the server.
  async function editClubWod(wodId, name, description) {
    if (!state.user || !isStaff() || !wodId) return false;
    const { error } = await client.rpc("club_wod_edit", { p_wod_id: wodId, p_name: name, p_description: description || "" });
    if (error) { setMessage(serverErrorText(error)); return false; }
    await loadClubWods(); setMessage("האימון עודכן"); rerender(); return true;
  }
  async function retireClubWod(wodId, reason) {
    if (!state.user || !isStaff() || !wodId) return false;
    const { error } = await client.rpc("club_wod_retire", { p_wod_id: wodId, p_reason: reason || null });
    if (error) { setMessage(serverErrorText(error)); return false; }
    await loadClubWods(); setMessage("האימון הוסר מהקטלוג"); rerender(); return true;
  }
  async function restoreClubWod(wodId) {
    if (!state.user || !isStaff() || !wodId) return false;
    const { error } = await client.rpc("club_wod_restore", { p_wod_id: wodId });
    if (error) { setMessage(serverErrorText(error)); return false; }
    await loadClubWods(); setMessage("האימון הוחזר לקטלוג"); rerender(); return true;
  }

  // ==========================================================================
  // THE FEED WRITES ITSELF - club WOD sessions and boards (202609080002)
  // ==========================================================================
  // The community layer competes with WhatsApp on typed posts and loses, so
  // the only content it can win with is what the app already knows: today's
  // programming, and who did it. A coach programs one catalogue WOD to one
  // day; that is ONE card and ONE board. A member who has ALREADY LOGGED the
  // workout attaches their own result with a single tap from the log form
  // they were filling in anyway - no composing, no feed slot.
  //
  // THREE RULES THIS CLIENT DOES NOT GET TO RE-DECIDE, each of them a
  // rejection recorded in the migration rather than a preference:
  //
  //   1. THE UI IS BUILT OFF `viewer`, NOT OFF A RE-DERIVATION. Every one of
  //      the six RPCs returns the same board object with every key present,
  //      including viewer.can_attach, viewer.can_detach and
  //      viewer.closed_reason. Recomputing "is this board open" from
  //      session_date and cancelled_at here would create a second, drifting
  //      copy of a rule the write path already enforces - and the board and
  //      the refusal would disagree the first time one of them changed.
  //      Nothing below reads session_date to decide what a member may do.
  //
  //   2. IT IS NOT A LEADERBOARD AND CANNOT BECOME ONE. `results` arrives
  //      ordered by attached_at - the order people trained in - and is
  //      rendered in exactly that order. Nothing here sorts, ranks, numbers
  //      or positions a row, and rx and scaled sit in ONE list. The table has
  //      no score_value, score_direction or rank column BY DESIGN, asserted
  //      in pgTAP, so there is nothing to sort by even if this file wanted to.
  //      renderRankedList()/leaderboardRowHtml() are deliberately NOT reused:
  //      they are the ranked convention (trophy, position, brass tint) and
  //      wearing them here would say the opposite of what this board is.
  //
  //   3. show_workout_results IS NEVER FLIPPED FROM HERE, AND NEVER OFFERED.
  //      It defaults FALSE, so the honest shipped first state is a board of
  //      names with few numbers - which the beginner persona's finding says
  //      is arguably the better one: "eight people did this today" is a roll
  //      call, not a leaderboard. The only correct affordance is a LINK to
  //      the privacy screen the member already owns (open-privacy-settings),
  //      and the hint that carries it states the fact without asking for a
  //      change. Compare hide-my-leaderboard-result, which DOES write a
  //      privacy field from a board - that one turns a disclosure OFF; this
  //      one would turn it ON, on the member's behalf, which is the direction
  //      no surface in this app gets to take.
  //
  // AND THE ONE FACT THE SERVER CANNOT KNOW: whether this member has logged
  // this WOD. The training log is local-first and cloud backup is opt-OUT, so
  // private_records may simply not hold it. viewer.attached answers "is your
  // result on the board", never "did you do it" - so the attach CTA is driven
  // from app.js's OWN log through clubWodLoggedEntries() below. That is also
  // why nothing here auto-attaches a logged entry that happens to match the
  // day or the WOD: inferring participation is decision 2's central rejection.

  function clubWodCanProgram() { return hasPerm(PERM.CHALLENGE_CREATE); }

  // app.js's log, asked for by WOD. Returns [] rather than throwing when the
  // bridge is absent - cloud.js is loaded BEFORE app.js, and a board rendered
  // in that window must degrade to "no attach control", never to a broken
  // render. Same feature-detected shape as window.allWods()/
  // window.communityShareCandidateFor().
  function clubWodLoggedEntries(wodId) {
    if (!wodId || typeof window.communityWodLogFor !== "function") return [];
    try { return window.communityWodLogFor(wodId) || []; } catch (e) { return []; }
  }
  // The entry behind one record id, for p_entry. Sent so a member with cloud
  // backup OFF still gets a figure on the board; the server prefers its own
  // private_records copy when it has one and re-formats either source from
  // clamped structured fields, so this is a fallback, never a claim.
  function clubWodEntryById(recordId) {
    if (!recordId || typeof window.communityWodEntryForAttach !== "function") return null;
    try { return window.communityWodEntryForAttach(recordId) || null; } catch (e) { return null; }
  }

  // ---- Reads ---------------------------------------------------------------
  // club_wod_boards() WITH NO ARGUMENTS MEANS TODAY. That is the club-home
  // call, and it is what this loader wants: the strip is "what is the club
  // doing today". A wider range is available (p_from/p_to) and deliberately
  // not used - a member who logs Thursday's WOD on Saturday reaches that
  // board from its feed card, which is still in the feed, rather than through
  // a fourteen-day fetch on every boot.
  async function loadClubWodBoards() {
    // Real device feedback: this feature had no toggle at all. Skipping the
    // fetch (not just the render) when it is off means a club that
    // doesn't use it stops paying for the round trip on every feed load,
    // not just for the card on screen.
    if (!state.user || !isModuleEnabled("club_wod")) {
      state.club.wodBoards = []; state.club.wodBoardsLoaded = false;
      state.club.wodBoardsLoading = false; state.club.wodBoardsError = false;
      clubWodSessionsToApp();
      return;
    }
    state.club.wodBoardsLoading = true;
    const { data, error } = await client.rpc("club_wod_boards");
    state.club.wodBoardsLoading = false;
    state.club.wodBoardsLoaded = true;
    state.club.wodBoardsError = !!error;
    // Kept in the server's order. Cancelled sessions are already excluded by
    // club_wod_boards itself, so there is nothing to filter here either.
    state.club.wodBoards = error ? [] : (data || []);
    clubWodSessionsToApp();
  }

  // Hands today's boards to app.js, the same way setClubWods() hands it the
  // catalogue - because the attach control has to render inside the WOD log
  // form, which app.js owns, and that form must not have to know how to talk
  // to Supabase. Called after every read AND after every write, so the log
  // form's CTA and the board can never disagree about what is attached.
  function clubWodSessionsToApp() {
    if (typeof window.setClubWodSessions === "function") window.setClubWodSessions(state.club.wodBoards);
  }

  // A board that came back from any of the six RPCs, folded into both places
  // it can be on screen at once: the today strip and the open dialog. One
  // function so a write cannot refresh one and leave the other stale.
  function applyClubWodBoard(board) {
    if (!board || !board.session_id) return;
    const idx = state.club.wodBoards.findIndex((b) => b && b.session_id === board.session_id);
    // Order is the server's. A board already in the list is replaced IN
    // PLACE; a new one (a fresh publish) is appended rather than unshifted,
    // so the strip does not reorder itself under a coach mid-publish.
    if (idx >= 0) state.club.wodBoards[idx] = board;
    else if (board.session_date === todayIso() && !board.cancelled_at) state.club.wodBoards.push(board);
    // A cancelled board leaves the today strip (club_wod_boards excludes
    // them) but stays fully readable by id in the dialog, because a member
    // holding a result on a withdrawn board must still be able to detach.
    if (board.cancelled_at && idx >= 0) state.club.wodBoards.splice(idx, 1);
    const v = state.club.wodBoardView;
    if (v && v.sessionId === board.session_id) { v.board = board; v.loading = false; v.error = false; }
    clubWodSessionsToApp();
  }

  async function openClubWodBoard(sessionId) {
    if (!sessionId) return;
    const known = state.club.wodBoards.find((b) => b && b.session_id === sessionId) || null;
    // Opens on the board already in hand when there is one, so the dialog
    // paints filled rather than as a skeleton, and re-reads underneath.
    state.club.wodBoardView = { sessionId, board: known, loading: !known, error: false, busy: false, errorText: "" };
    rerender();
    const { data, error } = await client.rpc("club_wod_board", { p_session_id: sessionId });
    const v = state.club.wodBoardView;
    if (!v || v.sessionId !== sessionId) return;
    if (error || !data) { v.loading = false; v.error = true; v.errorText = error ? serverErrorText(error) : ""; return rerender(); }
    applyClubWodBoard(data);
    rerender();
  }
  function closeClubWodBoard() { state.club.wodBoardView = null; rerender(); }

  // THE FEED CARD'S OWN BOARD READ. The session card groups a whole day's
  // results into one card, and to do that it needs the board: a count, the
  // faces and the viewer's own row. club_wod_boards() only ever returns
  // TODAY (see loadClubWodBoards' comment), so a card for Thursday sitting
  // in Saturday's feed had no board at all and used to render a bare title.
  //
  // Same shape as ensureReactionsLoaded(): asked from the render and fetched
  // once per session id, never once per post. The ceiling is the
  // four-sessions-per-day cap times the days in the loaded feed pages.
  // ASKED, not "in flight". A board that comes back null or errored must not
  // be asked for again on the next render, and the next render is one
  // reaction or one resolved photo URL away - deleting the flag on failure
  // would turn a single unreadable session into one RPC per frame for as long
  // as that card is on screen. So the key is set on the way OUT and never
  // cleared here; loadFeed() clears the whole map, which is the retry path
  // (the pull gesture, the new-posts pill, a scope change and the error
  // state's own button all go through it).
  const clubWodBoardAsked = {};
  function resetClubWodBoardAsks() {
    for (const k of Object.keys(clubWodBoardAsked)) delete clubWodBoardAsked[k];
  }
  function ensureClubWodBoardLoaded(sessionId) {
    if (!sessionId || !client || !state.user) return;
    if (!isModuleEnabled("club_wod")) return;
    if (clubWodBoardAsked[sessionId]) return;
    if (state.club.wodBoards.some((b) => b && b.session_id === sessionId)) return;
    clubWodBoardAsked[sessionId] = true;
    client.rpc("club_wod_board", { p_session_id: sessionId }).then(function (res) {
      if (res && !res.error && res.data) {
        // NOT applyClubWodBoard(): that function is the today-strip's own
        // fold and would append a past day's board to the strip, putting
        // Thursday's programming under a "היום" eyebrow. This cache is the
        // feed's, and the two stay separate.
        state.club.wodBoardsById[sessionId] = res.data;
        scheduleRerender();
      }
    }, function () { /* asked and failed; loadFeed() is the retry */ });
  }
  // One lookup, both caches: the today strip's list first (it is the fresher
  // of the two - every write folds into it) and the feed's own by-id cache
  // second.
  function clubWodBoardFor(sessionId) {
    if (!sessionId) return null;
    return state.club.wodBoards.find((b) => b && b.session_id === sessionId)
      || state.club.wodBoardsById[sessionId]
      || null;
  }

  // ---- The member's two writes ---------------------------------------------
  // Neither is queued through HaimuniaOutbox, and that is a decision rather
  // than an omission: an attach that leaves the device now and lands tomorrow
  // could land on a board that has since been cancelled or expired, and the
  // member would have been told it succeeded. Attaching is cheap to repeat
  // and worthless once the board is closed, so it fails honestly instead.
  // communityRpc() is still used for the idempotency key and for its
  // un-migrated-server fallback (PGRST202), which is what stops a client
  // deployed ahead of these migrations from killing the feature outright.
  async function attachClubWodResult(sessionId, recordId, entry) {
    if (!state.user || !sessionId || !recordId) return false;
    const v = state.club.wodBoardView;
    if (v && v.sessionId === sessionId) { v.busy = true; v.errorText = ""; rerender(); }
    // p_entry: the entry the client already holds, sent so a member with
    // cloud backup OFF still gets a figure. It is a fallback, never a claim -
    // the server prefers its own copy of the record when it has one and
    // re-formats either source from clamped structured fields, so nothing
    // typed here can reach the board.
    const { data, error } = await communityRpc("club_wod_attach_result", {
      p_session_id: sessionId, p_record_id: recordId, p_entry: entry || null,
    });
    if (v && v.sessionId === sessionId) v.busy = false;
    if (error) {
      const text = serverErrorText(error);
      if (v && v.sessionId === sessionId) { v.errorText = text; rerender(); } else setMessage(text);
      return false;
    }
    if (data) applyClubWodBoard(data);
    // The club_wod module's one event. Attaching a logged result to the
    // club's board is the module's whole point - a coach programs a day and
    // members put their own results on it - and it is the only thing on that
    // surface a member does rather than reads. After the RPC succeeds, like
    // every other write-backed name.
    //
    // The session id is deliberately absent. It identifies one day's
    // programming for the whole club, which makes any row carrying it a
    // roster of who trained on a named day, in a table read under
    // community.analytics.view. `source` says which of the two entry points
    // the member used and nothing else.
    //
    // Not a WCAM event: the training this attaches was already counted, once,
    // as attendance_recorded.
    track(A.CLUB_WOD_RESULT_ATTACHED, { source: (v && v.sessionId === sessionId) ? "board" : "log_form" });
    setMessage("התוצאה צורפה ללוח של המועדון");
    rerender();
    return true;
  }

  async function detachClubWodResult(sessionId) {
    if (!state.user || !sessionId) return false;
    const v = state.club.wodBoardView;
    if (v && v.sessionId === sessionId) { v.busy = true; v.errorText = ""; rerender(); }
    const { data, error } = await client.rpc("club_wod_detach_result", { p_session_id: sessionId });
    if (v && v.sessionId === sessionId) v.busy = false;
    if (error) {
      const text = serverErrorText(error);
      if (v && v.sessionId === sessionId) { v.errorText = text; rerender(); } else setMessage(text);
      return false;
    }
    if (data) applyClubWodBoard(data);
    setMessage("התוצאה הוסרה מהלוח");
    rerender();
    return true;
  }

  // ---- Staff: program a day, and withdraw one ------------------------------
  // Gated on has_perm('community.challenge.create') - the same permission
  // club_wod_publish uses, and NOT isStaff(), which also admits the `staff`
  // role that holds no such permission. THE DATABASE IS THE REAL BOUNDARY:
  // both RPCs check it themselves, so what follows is a display rule that
  // keeps a control nobody can use off the screen, never the enforcement.
  async function publishClubWodSession(form) {
    if (!state.user || !clubWodCanProgram() || !form) return;
    const wodId = String((form.elements.wodId && form.elements.wodId.value) || "");
    const date = String((form.elements.sessionDate && form.elements.sessionDate.value) || "");
    const note = String((form.elements.note && form.elements.note.value) || "");
    const errors = {};
    if (!wodId) errors.wodId = "בחרו אימון מקטלוג המועדון";
    if (Object.keys(errors).length) return setFieldErrors("communityClubWodSession", errors);
    setFieldErrors("communityClubWodSession", {});
    state.club.wodSessionForm.wodId = wodId;
    state.club.wodSessionForm.date = date;
    state.club.wodSessionForm.note = note;
    state.club.wodSessionForm.saving = true;
    rerender();
    const { data, error } = await communityRpc("club_wod_session_publish", {
      p_wod_id: wodId, p_session_date: date || null, p_note: note,
    });
    state.club.wodSessionForm.saving = false;
    if (error) { setMessage(serverErrorText(error)); return rerender(); }
    if (data) applyClubWodBoard(data);
    state.club.wodSessionForm.wodId = ""; state.club.wodSessionForm.note = "";
    setMessage("האימון של היום פורסם למועדון");
    rerender();
  }

  async function cancelClubWodSession(sessionId) {
    if (!state.user || !clubWodCanProgram() || !sessionId) return;
    const { data, error } = await client.rpc("club_wod_session_cancel", { p_session_id: sessionId });
    if (error) { setMessage(serverErrorText(error)); return rerender(); }
    // Cancelling DELETES NOTHING: the card is withdrawn and the board closes,
    // and every attached result survives a re-publish. The message says so,
    // because "ביטול" on its own reads like a delete.
    if (data) applyClubWodBoard(data);
    setMessage("האימון הוסר מהפיד. התוצאות שכבר צורפו נשמרו.");
    rerender();
  }

  // ---- Render --------------------------------------------------------------
  function clubWodDateLabel(iso) {
    const d = String(iso || "").slice(0, 10);
    if (!d) return "";
    const today = todayIso();
    if (d === today) return "היום";
    // Live bug hunt (2026-09-11): now that "today" is local (see todayIso()
    // above), yesterday/tomorrow have to be computed the same local way too
    // - the old UTC ms-shift stayed correct for "today" but drifted a day
    // out of step with it right at the same local-midnight boundary.
    // setDate() on a local Date is DST-safe by construction.
    const shift = (days) => {
      const base = new Date();
      base.setDate(base.getDate() + days);
      return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
    };
    if (d === shift(-1)) return "אתמול";
    if (d === shift(1)) return "מחר";
    return d;
  }
  // The programming itself - the half of this card WhatsApp cannot produce.
  // bidiText on every human string: a WOD is wall-to-wall mixed script
  // (Hebrew beside `21-15-9`, `Fran`, `@ 30 ק״ג`), which is exactly the case
  // where an unisolated LTR run paints a DIFFERENT, plausible workout.
  function clubWodProgrammingHtml(wod) {
    if (!wod) return "";
    const bits = [];
    if (wod.scoreType) bits.push(scoreTypeHtml(wod.scoreType));
    if (wod.timeCapSeconds) bits.push(bidiText("מגבלת זמן: " + Math.round(Number(wod.timeCapSeconds) / 60) + " דקות"));
    if (wod.emomMinutes) bits.push(bidiText("EMOM " + Number(wod.emomMinutes)));
    const emom = Array.isArray(wod.emomMovements) && wod.emomMovements.length
      ? `<div class="log-list" style="margin-top:6px;">${wod.emomMovements.map((m, i) => `<div class="log-row"><span>${bidiText(String(m))}</span><span class="mono" style="color:var(--steel);">${Number((wod.emomTargetReps || [])[i] || 0)}</span></div>`).join("")}</div>`
      : "";
    return `${wod.desc ? `<div class="mono" style="white-space:pre-wrap;line-height:1.6;font-size:13px;margin-top:6px;">${bidiText(String(wod.desc))}</div>` : ""}
      ${bits.length ? `<div style="color:var(--steel);font-size:12px;margin-top:6px;">${bits.join(" · ")}</div>` : ""}
      ${emom}`;
  }

  // THE FEED CARD (COMM / 202609080001).
  //
  // Registered in POST_CARD_RENDERERS so renderPostCard's ONE dispatch picks
  // it up BEFORE renderWorkoutPostCard can - which is the whole point and the
  // trap the schema flagged. POST_CLUB_WOD rows carry source_type and
  // source_id NULL ON PURPOSE, and renderWorkoutPostCard's deep link falls
  // back to `data-source-type="workout"`, so a card that reached that
  // renderer would offer to open a workout that does not exist. This card
  // opens the BOARD, off metadata.club_wod_session_id, and emits no
  // data-source-type attribute at all.
  function renderClubWodPostCard(post) {
    const m = (post && post.metadata) || {};
    const sessionId = m.club_wod_session_id || "";
    const name = post.title || "אימון היום";
    const when = m.session_date || post.occurred_on || "";
    // The catalogue is already in hand (loadClubWods), so the card can show
    // the actual programming rather than a bare name. A wod_id this device
    // has never seen simply renders without it - club_wods_list() returns
    // retired rows precisely so this stays resolvable.
    const wod = (state.club.clubWods || []).find((w) => w && w.id === m.club_wod_id) || null;
    if (sessionId) ensureClubWodBoardLoaded(sessionId);
    const board = clubWodBoardFor(sessionId);
    const result = `<div class="post-result-block">
      <div class="post-title">${bidiText(name)}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${esc(clubWodDateLabel(when))}</div>` : ""}
      ${clubWodProgrammingHtml(wod)}
      ${clubWodSessionRollupHtml(board, sessionId)}</div>`;
    const extra = sessionId
      ? `<button class="chip-btn primary" data-community-action="open-club-wod-board" data-id="${esc(sessionId)}" data-source="feed">${board && Number(board.result_count || 0) > 0 ? "הלוח המלא" : "פתיחת הלוח"}</button>`
      : "";
    return postCardShell(post, postCardBody(post, result), { extra });
  }

  // ---- ONE CARD PER SESSION (the feed's club-WOD roll-up) ------------------
  //
  // The club's results for one day used to reach the feed twice: as this
  // session card, which said only how many people had attached, and again as
  // one ordinary workout card per member who had ALSO shared their own result
  // - so a busy morning pushed everything else off the screen with fifteen
  // near-identical cards for the same WOD. Now the session card carries the
  // day and those individual cards are folded into it (feedGroupedPostIds,
  // src/community/feed.js).
  //
  // WHAT THIS CARD SHOWS, and one thing it deliberately does NOT.
  //
  // It shows the count, the faces, three results and the viewer's own row.
  // The three are THE FIRST THREE THE BOARD RETURNS, which is attach order -
  // who got there first - and the card says so in as many words ("הראשונים
  // שצירפו"). It is NOT a top three by score, and that is a data fact before
  // it is a product one: club_wod_board_json returns no score column at all
  // ("Ordered by attached_at, never by score: there is no ranking here and no
  // column to build one from"), result_text is free text whose shape depends
  // on the score type, and it is null for every member whose
  // show_workout_results is off - which is the DEFAULT. Ranking what is left
  // would rank a self-selected subset and present it as the club's top three,
  // and the gaps in it would themselves disclose who had chosen to hide a
  // figure. A real score-ranked board needs a score column on
  // club_wod_results and a migration to add it; this branch adds no
  // migrations. Same reasoning governs the viewer's own line below.
  const CLUB_WOD_FACES_SHOWN = 6;
  const CLUB_WOD_RESULTS_SHOWN = 3;
  function clubWodSessionRollupHtml(board, sessionId) {
    if (!board) return sessionId ? `<div class="footer-note" style="margin:6px 0 0;">טוען את הלוח…</div>` : "";
    const results = Array.isArray(board.results) ? board.results : [];
    const total = Number(board.result_count || 0);
    if (!total && !results.length) {
      return `<div style="color:var(--steel);font-size:12px;margin-top:8px;">עדיין לא צורפו תוצאות — אפשר להיות הראשון/ה</div>`;
    }
    const faces = results.slice(0, CLUB_WOD_FACES_SHOWN)
      .map((r) => `<span class="stacked-avatar">${avatarHtml(r.display_name || r.handle || "חבר/ה", 28, r.avatar_url)}</span>`).join("");
    const extraFaces = total - Math.min(results.length, CLUB_WOD_FACES_SHOWN);
    const facesHtml = `<div class="stacked-avatars">${faces}${extraFaces > 0 ? `<span class="stacked-avatar stacked-avatar-more">+${extraFaces}</span>` : ""}</div>`;
    const top = results.slice(0, CLUB_WOD_RESULTS_SHOWN).map((r) => {
      const figure = r.result_text
        ? `<span class="mono" style="color:var(--brass);font-weight:700;">${esc(r.result_text)}</span>`
        : r.result_hidden
        ? `<span style="color:var(--steel);font-size:12px;">התוצאה מוסתרת</span>`
        : `<span style="color:var(--steel);font-size:12px;">השתתפ/ה</span>`;
      return `<div class="log-row"${r.is_viewer ? ` style="border-color:var(--energy);"` : ""}>
        <span class="flex gap-8" style="align-items:center;min-width:0;">${avatarHtml(r.display_name || r.handle || "חבר/ה", 24, r.avatar_url)}<span style="font-weight:700;font-size:13px;">${nameHtml(r.display_name, r.handle)}${r.is_viewer ? " (את/ה)" : ""}</span></span>
        <span style="text-align:left;">${figure}</span>
      </div>`;
    }).join("");
    return `<div class="club-wod-rollup" style="margin-top:10px;">
      <div class="flex gap-8" style="align-items:center;flex-wrap:wrap;">
        ${facesHtml}
        <span style="color:var(--steel);font-size:12px;">${/* The singular is written about the RESULT, not about the member, and
              that is grammar rather than taste: the feminine of אחד is the
              irregular אחת, so "one member" cannot be written as a slash form
              at all (test/hebrew-copy-rules.test.mjs, rule 2). A sentence
              about the result needs no gender, so there is nothing to join. */ ""}${esc(total === 1 ? "תוצאה אחת צורפה" : total + " מהמועדון צירפו תוצאה")}</span>
      </div>
      ${top ? `<div class="field-label" style="margin:10px 0 4px;">הראשונים שצירפו</div><div class="log-list">${top}</div>` : ""}
      ${clubWodViewerLineHtml(board)}
    </div>`;
  }

  // THE VIEWER'S OWN RESULT AND PLACE, on the card, once they have logged
  // one - the sixth thing asked for, and the honest form of it. "Place" here
  // is the board's own order, which is the order people attached in, so the
  // line says "צירפת שלישי/ת מתוך 8" rather than dressing that up as a rank
  // among results. See the block comment above for why a score-ranked place
  // is not computable from what the server returns.
  function clubWodViewerLineHtml(board) {
    const viewer = board.viewer || {};
    if (!viewer.attached) return "";
    const results = Array.isArray(board.results) ? board.results : [];
    const idx = results.findIndex((r) => r && r.is_viewer);
    const total = Number(board.result_count || 0) || results.length;
    const figure = viewer.result_text
      ? `<span class="mono" style="color:var(--brass);font-weight:800;">${esc(viewer.result_text)}</span>`
      : `<span style="color:var(--steel);">בלי תוצאה מספרית</span>`;
    const place = idx >= 0 && total
      ? `<span style="color:var(--steel);font-size:12px;">${esc("צירפת במקום " + (idx + 1) + " מתוך " + total)}</span>`
      : "";
    return `<div class="club-wod-viewer-line log-row" style="margin-top:10px;border-color:var(--energy);">
      <span style="font-weight:700;font-size:13px;">התוצאה שלך</span>
      <span class="flex gap-8" style="align-items:center;">${place}${figure}</span>
    </div>`;
  }

  // ONE result row. No index, no position, no trophy - see rule 2 above.
  function renderClubWodResultRow(r, sessionDate) {
    const name = r.display_name || (r.handle ? "@" + r.handle : "חבר/ה");
    const tags = [];
    if (r.score_type) tags.push(scoreTypeHtml(r.score_type));
    if (r.rx === true || r.rx === false) tags.push(effortHtml(r.rx ? "rx" : "scaled"));
    // "logged Thursday" when the entry's own date differs from the session's.
    // Attaching is not tied to when the entry was made - a member may log
    // Thursday's WOD on Saturday - and the row carries its own occurred_on
    // precisely so the client can say so instead of implying everybody
    // trained on the session date.
    if (r.occurred_on && sessionDate && String(r.occurred_on).slice(0, 10) !== String(sessionDate).slice(0, 10)) {
      tags.push(bidiText("נרשם " + clubWodDateLabel(r.occurred_on)));
    }
    // THREE figure states, which are three different facts about a member:
    //   a result_text        - the member allows the club to see the number;
    //   result_hidden        - there IS a number and it is not this viewer's
    //                          to read (show_workout_results, default false);
    //   neither              - they took part and no figure was recorded
    //                          (cloud backup off and no local copy to send).
    const figure = r.result_text
      ? `<span class="mono" style="color:var(--brass);font-weight:700;">${esc(r.result_text)}</span>`
      : r.result_hidden
      ? `<span style="color:var(--steel);font-size:12px;">התוצאה מוסתרת</span>`
      : `<span style="color:var(--steel);font-size:12px;">השתתפ/ה</span>`;
    return `<div class="log-row" data-club-wod-user="${esc(r.user_id)}"${r.is_viewer ? ` data-club-wod-self="1"` : ""}${r.is_viewer ? ` style="border-color:var(--energy);"` : ""}>
      <span class="flex gap-8" style="align-items:center;min-width:0;">
        ${avatarHtml(r.display_name || r.handle, 28, r.avatar_url)}
        <span style="min-width:0;">
          <span style="font-weight:700;font-size:13px;">${nameHtml(r.display_name, r.handle)}${r.is_viewer ? " (את/ה)" : ""}</span>
          ${tags.length ? `<span style="color:var(--steel);font-size:11px;display:block;">${tags.join(" · ")}</span>` : ""}
        </span>
      </span>
      <span style="text-align:left;">${figure}</span>
    </div>`;
  }

  // The viewer's own block: what they may do, and why not when they may not.
  // EVERY branch below reads `viewer`, never session_date or cancelled_at.
  function renderClubWodViewerPanel(board, v) {
    const viewer = board.viewer || {};
    const wodId = board.wod ? board.wod.id : "";
    const sid = board.session_id;
    const busy = !!(v && v.busy);
    const parts = [];

    if (viewer.attached) {
      const mine = viewer.result_text
        ? `<span class="mono" style="color:var(--brass);font-weight:800;">${esc(viewer.result_text)}</span>`
        : `<span style="color:var(--steel);">בלי תוצאה מספרית</span>`;
      parts.push(`<div style="font-size:13px;margin-bottom:6px;">התוצאה שלך על הלוח: ${mine}</div>`);
      // THE HINT, and the whole of what this client does about
      // show_workout_results. It states the fact and links; it does not
      // offer, suggest or provide a way to change the setting from here.
      if (viewer.result_text && state.profile && state.profile.show_workout_results === false) {
        parts.push(`<div class="footer-note" style="margin:0 0 8px;">חברי המועדון רואים שהשתתפת, אבל לא את התוצאה עצמה — כך מוגדר אצלך „הצגת תוצאות אימון". <button class="link-btn" data-community-action="open-privacy-settings">להגדרות הפרטיות</button></div>`);
      }
      // can_detach, not "attached && open": detaching works on a cancelled
      // and on an expired board too, deliberately, because taking your own
      // result off a club surface must never be blocked.
      if (viewer.can_detach) {
        parts.push(`<div class="chip-row"><button class="chip-btn" data-community-action="club-wod-detach" data-id="${esc(sid)}"${busy ? " disabled" : ""}>${busy ? "מסיר…" : "הסרת התוצאה שלי מהלוח"}</button></div>`);
      }
      return parts.join("");
    }

    if (!viewer.can_attach) {
      // closed_reason, so the board SAYS why instead of hiding a control.
      // 202609080004 added restricted/not_permitted. Note what this branch
      // does NOT do: it never hides the board, and detach is rendered above
      // this, so a restricted member who is already attached still sees their
      // result and can still remove it. A sanction on adding content is not a
      // sanction on withdrawing it.
      const why = { restricted: "בזמן הגבלת הפרסום אי אפשר לצרף תוצאה ללוח. אפשר לראות את הלוח, ולהסיר תוצאה שכבר צורפה.",
                    not_permitted: "לחשבון שלך אין הרשאה לפרסם תוכן במועדון, ולכן אי אפשר לצרף תוצאה ללוח.",
                    future: "האימון הזה נקבע למחר. אפשר לצרף תוצאה מהיום שהוא נקבע אליו.",
                    expired: "הלוח הזה נסגר לצירוף תוצאות אחרי 14 יום. מה שכבר צורף נשאר.",
                    cancelled: "האימון בוטל, ולכן הלוח סגור לצירוף תוצאות." }[viewer.closed_reason] || "";
      return why ? `<div class="footer-note" style="margin:0;">${esc(why)}</div>` : "";
    }

    // OPEN, AND NOT ATTACHED. The one question left is one the SERVER CANNOT
    // ANSWER: has this member logged it? The log is local-first and backup is
    // opt-out, so it is asked of app.js's own log - and a member who has not
    // logged it is offered the log, not a way onto the board.
    const entries = clubWodLoggedEntries(wodId);
    if (!entries.length) {
      return emptyStateHtml({
        key: "club-wod-not-logged", icon: "chart",
        headline: "עוד לא רשמת את האימון הזה",
        body: "אחרי שתרשמו אותו ביומן האימונים אפשר יהיה לצרף את התוצאה ללוח בלחיצה אחת. הצירוף תמיד יזום — שום רישום לא מגיע ללוח מעצמו.",
      });
    }
    // Explicit, per entry. Nothing is pre-selected and nothing is attached
    // because it happens to match the day - the member chooses which of their
    // attempts the club sees.
    const rows = entries.slice(0, 5).map((e) => `<button class="chip-btn" data-community-action="club-wod-attach" data-id="${esc(sid)}" data-record="${esc(e.id)}"${busy ? " disabled" : ""}>${esc(clubWodDateLabel(e.date))}${e.resultText ? " · " + esc(e.resultText) : ""}</button>`).join("");
    return `<div style="font-size:13px;margin-bottom:6px;">${entries.length === 1 ? "לצרף את הרישום שלך ללוח?" : "איזה מהרישומים שלך לצרף ללוח?"}</div>
      <div class="chip-row" style="flex-wrap:wrap;">${rows}</div>`;
  }

  function renderClubWodBoardBody(board, v) {
    const wodName = board.wod ? board.wod.name : "אימון היום";
    const by = board.published_by;
    const meta = [clubWodDateLabel(board.session_date)];
    if (by) meta.push("פורסם על ידי " + (by.display_name || (by.handle ? "@" + by.handle : "")));
    const cancelled = board.cancelled_at
      ? `<div class="footer-note" role="status" style="margin:0 0 10px;color:var(--brass);">האימון הזה בוטל והכרטיס הוסר מהפיד. התוצאות שכבר צורפו נשמרו, ואפשר להסיר את שלך מכאן.</div>`
      : "";
    const note = board.note ? `<div class="post-body" style="white-space:pre-wrap;margin:8px 0;">${bidiText(String(board.note))}</div>` : "";
    // Nobody yet. The card is worth opening at zero results - that is what
    // breaks the log-adoption circularity - so this is a real four-slot state
    // and not a dash.
    const list = (board.results || []).length
      ? `<div class="log-list">${board.results.map((r) => renderClubWodResultRow(r, board.session_date)).join("")}</div>`
      : emptyStateHtml({
          key: "club-wod-board-empty", icon: "people",
          headline: "עוד אף אחד לא צירף תוצאה",
          body: "זה האימון של המועדון להיום. מי שרשם אותו ביומן יכול לצרף את התוצאה שלו לכאן, וזה מה שיבנה את הלוח.",
        });
    const countLine = `<div style="color:var(--steel);font-size:12px;margin:10px 0 6px;">${Number(board.result_count || 0)} מהמועדון על הלוח</div>`;
    const staffTools = clubWodCanProgram() && !board.cancelled_at
      ? `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn danger" data-community-action="club-wod-cancel-confirm" data-id="${esc(board.session_id)}">ביטול האימון של היום</button></div>`
      : "";
    const err = v && v.errorText ? `<div class="field-error" role="alert">${esc(v.errorText)}</div>` : "";
    return `<div style="color:var(--steel);font-size:12px;margin-bottom:6px;">${meta.map(bidiText).join(" · ")}</div>
      ${cancelled}
      ${clubWodProgrammingHtml(board.wod)}
      ${note}
      ${staffTools}
      <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;">${renderClubWodViewerPanel(board, v)}${err}</div>
      ${countLine}
      ${list}
      <div class="footer-note" style="margin-top:10px;">הרשימה מסודרת לפי סדר הצירוף — אין כאן דירוג, ואימון מלא ומותאם יושבים באותה רשימה.</div>`;
  }

  function renderClubWodBoardOverlay() {
    const v = state.club.wodBoardView;
    if (!v) return "";
    const board = v.board;
    const title = board && board.wod ? board.wod.name : "אימון היום";
    const bodyHtml = v.loading ? `<div class="empty">טוען את הלוח…</div>`
      : (v.error || !board) ? `<div class="empty">${esc(v.errorText || "לא ניתן היה לטעון את הלוח.")}</div>`
      : renderClubWodBoardBody(board, v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="clubWodBoardTitle" data-cloud-dialog="clubWodBoard" style="align-items:center;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="clubWodBoardTitle" style="margin-top:0;font-weight:800;font-size:17px;margin-bottom:0;">${bidiText(title)}</h2>
            ${sheetCloseBtnHtml("close-club-wod-board")}
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // The club-home strip: what the box is doing today, above the feed. Same
  // "renders nothing rather than an empty placeholder" style as the upcoming
  // event and classmates-today cards - with one exception, and it is the
  // point of the whole feature: a coach who can program sees the door even on
  // a day with nothing on it, because an empty feed is the problem being
  // solved and they are the only person who can fix it.
  // "יום ג׳ · 8.9" - the way a date is written on a whiteboard, not the way a
  // timestamp is written in a log. Falls back to the raw value rather than
  // rendering "Invalid Date" if the server ever sends something unexpected.
  function boardDateLabel(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return String(iso);
    const day = d.toLocaleDateString("he-IL", { weekday: "short" });
    return `${day} · ${d.getDate()}.${d.getMonth() + 1}`;
  }
  function renderClubWodTodayStrip() {
    if (!state.user || !isModuleEnabled("club_wod")) return "";
    const boards = state.club.wodBoards;
    const canProgram = clubWodCanProgram();
    if (!boards.length) {
      if (!canProgram) return "";
      if (!state.club.wodBoardsLoaded) return "";
      // A FAILED READ IS NOT AN EMPTY DAY. Without this the strip would tell
      // a coach nothing is programmed - and invite them to publish a second
      // session - on the strength of a request that never landed.
      if (state.club.wodBoardsError) {
        return `<div class="chart-card" style="margin-bottom:12px;"><div class="empty">לא ניתן היה לטעון את האימון של היום.<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="chip-btn" data-community-action="club-wod-retry">ניסיון חוזר</button></div></div></div>`;
      }
      return `<div class="chart-card" style="margin-bottom:12px;">${emptyStateHtml({
        key: "club-wod-today-none", icon: "chart",
        headline: "לא נקבע אימון למועדון היום",
        body: "אימון מהקטלוג שנקבע ליום מסוים מייצר כרטיס אחד בפיד ולוח אחד, וחברי המועדון מצרפים אליו תוצאות שהם כבר רשמו — בלי לכתוב פוסט.",
      })}${renderClubWodSessionForm()}</div>`;
    }
    // THE BOARD (design direction C). Today's programming is the one thing on
    // this screen that exists physically in the gym, so it is drawn as the
    // board on the wall rather than as another card in the stack. The
    // programming itself is the content - it used to be hidden behind a row
    // you had to tap - and the names of who has trained are read straight off
    // the board, exactly as they are read off the real one.
    const rows = boards.map((b) => {
      const name = b.wod ? b.wod.name : "אימון היום";
      const viewer = b.viewer || {};
      // Only members this viewer may see are in `results` at all - the RPC
      // filters on visible_to_club before it ever reaches here - so listing
      // the names discloses nothing the board itself would not.
      const people = Array.isArray(b.results) ? b.results : [];
      const shown = people.slice(0, 6);
      const extra = people.length - shown.length;
      const namesHtml = shown.length
        ? shown.map((r) => `<span>${bidiText(r.display_name || r.handle || "")}</span>`).join(`<span class="wod-board-sep">/</span>`)
          + (extra > 0 ? `<span class="wod-board-sep">/</span><span style="opacity:.6;">${esc("עוד " + extra)}</span>` : "")
        : `<span style="opacity:.6;">${esc("עדיין אף אחד — אפשר להיות הראשון/ה")}</span>`;
      // The WOD's own description carries the movements. Falls back to the
      // name alone rather than printing an empty board.
      const lines = b.wod && b.wod.desc ? b.wod.desc : "";
      return `<div class="wod-board">
        <div class="flex" style="justify-content:space-between;align-items:baseline;">
          <span class="wod-board-eyebrow">היום</span>
          <span class="wod-board-date">${esc(boardDateLabel(b.session_date))}</span>
        </div>
        <div class="wod-board-title">${bidiText(name)}</div>
        ${lines ? `<div class="wod-board-lines">${esc(lines)}</div>` : ""}
        <div class="wod-board-rule"></div>
        <div class="wod-board-label">מי כבר עשה</div>
        <div class="wod-board-names">${namesHtml}</div>
        <div class="chip-row" style="margin-top:18px;">
          ${viewer.attached
            ? `<button class="chip-btn wod-board-ghost" data-community-action="open-club-wod-board" data-id="${esc(b.session_id)}" data-source="strip">התוצאה שלך על הלוח</button>`
            : `<button class="chip-btn primary" data-community-action="open-club-wod-board" data-id="${esc(b.session_id)}" data-source="strip">אני עשיתי</button>`}
          <button class="chip-btn wod-board-ghost" data-community-action="open-club-wod-board" data-id="${esc(b.session_id)}" data-source="strip">הלוח המלא</button>
        </div>
      </div>`;
    }).join("");
    return `${rows}${canProgram ? `<div class="chart-card" style="margin-bottom:12px;">${renderClubWodSessionForm()}</div>` : ""}`;
  }

  function renderClubWodSessionForm() {
    if (!clubWodCanProgram()) return "";
    const f = state.club.wodSessionForm;
    const today = todayIso();
    const shift = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    // Only live catalogue rows are offerable: club_wod_session_publish
    // refuses a retired WOD ('wod is retired'), so listing one would be an
    // option that can only fail.
    const choices = (state.club.clubWods || []).filter((w) => w && !w.retiredAt);
    if (!choices.length) {
      return `<div class="footer-note" style="margin-top:10px;">אין עדיין אימונים בקטלוג המועדון. אפשר לפרסם אימון לקטלוג ממסך רישום האימון, ואז לקבוע אותו ליום.</div>`;
    }
    const options = choices.map((w) => `<option value="${esc(w.id)}"${f.wodId === w.id ? " selected" : ""}>${esc(w.name)}</option>`).join("");
    return `<form id="communityClubWodSession" class="admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">קביעת האימון של היום<span class="admin-tag">ניהול</span></div>
      ${field("communityClubWodSession", "wodId", "אימון מהקטלוג", `<select class="text-input" name="wodId" data-club-wod-field="wodId"><option value="">בחירת אימון</option>${options}</select>`)}
      ${dateField("communityClubWodSession", "sessionDate", "ליום", `<input class="text-input" name="sessionDate" type="date" value="${esc(f.date || today)}" min="${esc(shift(-1))}" max="${esc(shift(1))}" data-club-wod-field="date"/>`)}
      ${field("communityClubWodSession", "note", "מילה מהמאמן/ת (אופציונלי)", `<textarea class="text-input" name="note" maxlength="500" rows="2" data-club-wod-field="note">${esc(f.note || "")}</textarea>`)}
      <div class="footer-note" style="margin:-4px 0 8px;">אפשר לקבוע לאתמול, להיום או למחר בלבד, ועד ארבעה אימונים ליום — כך הפיד נשאר מה שקורה עכשיו. הטקסט נשמר כפי שהוא ברגע הפרסום; לשינוי שלו צריך לבטל ולקבוע מחדש.</div>
      <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "מפרסם…" : "פרסום למועדון"}</button>
    </form>`;
  }
