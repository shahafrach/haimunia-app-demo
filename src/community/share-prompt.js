"use strict";
// ---- Community: the share prompt after real training ----------------------
//
// THE PROBLEM THIS FILE EXISTS FOR. The feed only ever filled itself from
// the two moments the app already interrupted a member for: a personal
// record (posts.js's PR prompt) and an achievement unlock (achievements.js's
// celebration sheet). An ORDINARY logged workout - which is what almost
// every session is - reached the feed only if the member went looking for
// renderShareControl in Calendar or Progress and tapped it. So a club whose
// members trained five days a week had a feed that said nothing about
// training.
//
// WHAT IT ADDS, and deliberately nothing more: one short prompt after a save
// - "לשתף עם המועדון?" with a share control and a not-now control - and ONE
// COORDINATOR that all three prompts (workout, PR, achievement) now pass
// through, so the member is asked at most once per moment, only when every
// switch that governs the answer is on, and never without a tap.
//
// THE FOUR RULES, each with its own guard in
// test/community-share-prompt.test.mjs:
//
//   1. NEVER WITHOUT AN EXPLICIT TAP. Nothing in this file writes. Opening a
//      prompt is not sharing; only shareWorkoutSharePrompt(), reached from
//      data-community-action="workout-share", writes anything at all.
//   2. THE MEMBER CAN TURN IT OFF. renderSharePromptPrefPanel() (Account
//      tab, under the privacy panel) writes one localStorage key, and
//      sharePromptAllowed() - which every one of the three prompts asks
//      first - reads it. Off means no prompt after a workout, a PR or an
//      unlock; it never touches a share the member goes looking for.
//   3. EVERY PRIVACY TOGGLE IS RESPECTED. See sharePromptAllowed().
//   4. ONE RECORD, ONE POST. The workout share is an upsert on
//      (author_id, source_type, source_record_id) and the PR share is
//      pr_share(), which UPGRADES that same row in place (202609060025)
//      rather than writing a second card. Sharing the workout and then the
//      PR for one logged set leaves one post; a record is offered at most
//      once, ever; and the coordinator below never puts two questions about
//      one save on screen together.
//
// THE WRITE ITSELF IS NOT HERE. shareWorkoutRecord() lives in
// src/community/posts.js beside publishWorkout(), which is the share control's
// own entry point - one payload, one upsert, one measurement for both, which
// is what stops this file from becoming the second copy of a write that
// already existed (CLAUDE.md, "sibling drift").
//
// Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.

  // ---- The member's own switch (rule 2) --------------------------------
  //
  // localStorage, not a profiles column, for one reason that is not laziness:
  // a column needs a migration, and this branch adds none (CLAUDE.md,
  // "Parallel work" - one open branch adds a migration at a time). It is
  // also the right storage on its own merits: nothing server-side reads this,
  // no other member's view of this member changes, and it is a sibling of
  // haimunia-demo:prPromptDismissed, which posts.js has kept here since
  // COMM-105.
  //
  // Stored as the NEGATIVE ("off"), so a member who has never touched the
  // switch, a member on a fresh device and a member whose storage is
  // unreadable all get the same answer - prompts on - without a migration
  // step or a default row.
  const SHARE_PROMPT_OFF_KEY = "haimunia-demo:sharePromptsOff";
  function sharePromptsEnabled() {
    try { return localStorage.getItem(SHARE_PROMPT_OFF_KEY) !== "1"; } catch (e) { return true; }
  }
  function setSharePromptsEnabled(on) {
    try { localStorage.setItem(SHARE_PROMPT_OFF_KEY, on ? "0" : "1"); } catch (e) { /* private mode: the switch is this session's only */ }
    // Turning it OFF closes anything already on screen. A member who has just
    // said "stop asking me" and is then left looking at the question has been
    // told their switch does not work.
    if (!on) {
      state.posts.workoutPrompt = null;
      state.posts.prPrompt = null;
      state.achievements.unlock = null;
      sharePromptQueue.length = 0;
    }
    setMessage(on
      ? "נציע שיתוף אחרי אימון, שיא או מדליה."
      : "לא נציע יותר. אפשר לשתף בכל רגע מהיומן, מההתקדמות וממסך ההישגים.");
    rerender();
  }

  // ---- The gate every prompt passes (rules 2 and 3) --------------------
  //
  // WHICH PRIVACY TOGGLES GOVERN A PROMPT, and why none of the profile-wide
  // ones BLOCK it. This was the hardest call in the change and it is settled
  // by two decisions this repo had already made and written down:
  //
  //   * src/community/achievements.js, on the outward share: "the profile-wide
  //     privacy toggles - which are about what OTHER members may read - are
  //     deliberately not consulted".
  //   * test/community-outward-share.test.mjs: "[show_prs and
  //     show_workout_results] default FALSE and govern what OTHER members may
  //     read (can_view_profile_field). Gating on them would have shipped a
  //     feature that is dead for every member who never opened the privacy
  //     panel."
  //
  // Both are right, and the reasoning extends to visible_to_club and
  // show_achievements: all four answer "what may the club read ABOUT me",
  // which the SERVER decides, on every read, for every viewer. None of them
  // answers "may I publish", and a member whose profile is hidden still posts
  // into the same feed (feed_page has no visible_to_club clause - it redacts
  // a POST_WORKOUT's or POST_PR's figures under show_workout_results and
  // nothing else). Blocking on one here would be this client inventing a rule
  // the schema does not have, in one surface, while renderShareControl and
  // the outward sheet keep offering the same share two taps away - which is
  // the sibling drift CLAUDE.md is about, not respect for a toggle.
  //
  // So what "respect every privacy toggle" actually buys, and each half is
  // guarded in test/community-share-prompt.test.mjs:
  //
  //   1. THE ITEM-LEVEL FLAG BLOCKS. An achievement whose own visibility is
  //      "only_me" offers no share control at all - the member set that on
  //      this exact decoration, to mean this. That check predates this file
  //      and lives where it belongs, in achievements.js.
  //   2. THE CLUB'S MODULE SWITCHES BLOCK. 'feed' off means this club is not
  //      being offered a feed to post into; 'achievements' off means it is
  //      not being offered medals.
  //   3. THE REDACTION TOGGLE IS SAID OUT LOUD. show_workout_results defaults
  //      FALSE and strips result_text and the result metadata from a
  //      POST_WORKOUT or POST_PR server-side, for every viewer but the
  //      author. Silently producing a card with the number missing is the
  //      worse kind of respect for a toggle, so both prompts SAY so before
  //      the member taps, with a LINK to the privacy screen - never a control
  //      that flips someone's privacy setting for them.
  //   4. AND THE MEMBER'S OWN SWITCH BLOCKS EVERYTHING, which is the one
  //      control that is genuinely about being ASKED rather than about being
  //      read (see SHARE_PROMPT_OFF_KEY above).
  function sharePromptAllowed(kind) {
    if (typeof window.isCommunitySignedIn !== "function" || !window.isCommunitySignedIn()) return false;
    if (!state.user || !state.profile) return false;
    if (!sharePromptsEnabled()) return false;
    if (!isModuleEnabled("feed")) return false;
    if (kind === "achievement" && !isModuleEnabled("achievements")) return false;
    return true;
  }
  // Rule 3's own half: true when the club will be shown this member's card
  // with the figures stripped out of it. `=== false` and not a falsy test,
  // deliberately - a mock or a partially-loaded profile row that simply does
  // not carry the column must not be told its results are hidden.
  function workoutResultsHiddenFromClub() {
    return !!(state.profile && state.profile.show_workout_results === false);
  }
  // The sentence itself, shared by the workout prompt and the PR prompt
  // because the server rule behind it is one rule over both post types.
  function sharePromptPrivacyNoteHtml() {
    if (!workoutResultsHiddenFromClub()) return "";
    return `<div style="font-size:12px;color:var(--steel);margin-top:8px;line-height:1.6;">לפי הגדרות הפרטיות שלכם, חברי המועדון יראו שהתאמנתם אבל לא את התוצאה עצמה. <button class="link-btn" data-community-action="open-privacy-settings">הגדרות פרטיות</button></div>`;
  }

  // ---- One prompt at a time (rule 4's second half) ---------------------
  //
  // Three surfaces can want the member's attention in the same tick: a save
  // that is a PR, unlocks a medal AND is a shareable workout is one save, not
  // three questions. The offers are therefore funnelled through one place
  // that opens at most one and parks the rest.
  //
  // A QUEUE RATHER THAN A DROP, for the two that carry something the member
  // earned: an achievement unlock suppressed because the PR prompt happened
  // to be open is a celebration the member never gets. Capped at two parked
  // offers, because a third question about one save is not a queue problem,
  // it is a design problem; and re-gated on release, so a member who turns
  // the switch off (or signs out) while one is parked never sees it.
  const SHARE_PROMPT_QUEUE_MAX = 2;
  const sharePromptQueue = [];
  function anySharePromptOpen() {
    return !!(state.posts.workoutPrompt || state.posts.prPrompt || state.achievements.unlock);
  }
  // A STALE WORKOUT PROMPT IS SUPERSEDED, NOT QUEUED BEHIND. Found by walking
  // it: log a set, leave the prompt up, log another set that is a real PR -
  // and the PR prompt parked behind a question about the PREVIOUS set, which
  // is both the wrong thing on screen and the wrong thing first. The plain
  // workout offer is the weakest of the three and it is about an older
  // moment, so a newer offer replaces it. It keeps its entry in the
  // offered-once list on the way out, so superseding is not a second chance
  // to ask about that record.
  //
  // Only the workout prompt is replaceable. The PR prompt and the achievement
  // celebration are about something the member EARNED, and pulling one out
  // from under their thumb to show another is how a member misses a medal
  // they will never be shown again.
  //
  // `open` returns true when it actually opened something.
  function offerSharePrompt(kind, open) {
    if (!sharePromptAllowed(kind)) return false;
    if (anySharePromptOpen()) {
      if (state.posts.workoutPrompt && !state.posts.prPrompt && !state.achievements.unlock) {
        state.posts.workoutPrompt = null;
      } else {
        if (sharePromptQueue.length < SHARE_PROMPT_QUEUE_MAX) sharePromptQueue.push({ kind: kind, open: open });
        return false;
      }
    }
    return !!open();
  }
  // A parked offer must not outlive the session that earned it. Called from
  // the sign-out reset beside the state leaves it clears: sharePromptClosed()
  // re-gates on sharePromptAllowed() and so would refuse to open one for the
  // next member anyway, but an offer about somebody else's training has no
  // business still sitting in memory on a shared phone.
  function resetSharePromptQueue() { sharePromptQueue.length = 0; }
  // Called by every one of the six exits (share/not-now on each of the three
  // prompts). Not by a render: a prompt that closed because the member
  // answered it is the only thing that earns the next question.
  function sharePromptClosed() {
    while (sharePromptQueue.length) {
      const next = sharePromptQueue.shift();
      if (!sharePromptAllowed(next.kind)) continue;
      if (next.open()) return;
    }
  }

  // ---- The workout prompt ----------------------------------------------
  //
  // Offered once per record, ever, on this device. The same shape and the
  // same reasoning as posts.js's PR_PROMPT_DISMISSED_KEY: a member who said
  // "not now" about Tuesday's squats is not asked about Tuesday's squats
  // again on Wednesday, and a share that succeeded is not re-offered either
  // (both paths write the key). Capped the same way, oldest first.
  const WORKOUT_PROMPT_OFFERED_KEY = "haimunia-demo:workoutPromptOffered";
  const WORKOUT_PROMPT_OFFERED_MAX = 200;
  function workoutPromptOfferedList() {
    try {
      const parsed = JSON.parse(localStorage.getItem(WORKOUT_PROMPT_OFFERED_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (e) { return []; }
  }
  function workoutPromptAlreadyOffered(key) { return workoutPromptOfferedList().indexOf(String(key)) >= 0; }
  function rememberWorkoutPromptOffered(key) {
    try {
      const list = workoutPromptOfferedList().filter((k) => k !== String(key));
      list.push(String(key));
      localStorage.setItem(WORKOUT_PROMPT_OFFERED_KEY, JSON.stringify(list.slice(-WORKOUT_PROMPT_OFFERED_MAX)));
    } catch (e) { /* private mode: the member is asked once per session instead */ }
  }
  function workoutPromptKey(type, id) { return String(type) + ":" + String(id); }

  // THE ENTRY POINT app.js calls, once, at the end of a save that actually
  // landed on disk (saveSet/saveWod). On window for the same reason
  // claimCommunityAchievements and renderShareControl are: app.js must keep
  // working with cloud.js absent, and a bare identifier would be a
  // ReferenceError on a device that never opened the Community tab.
  //
  // WHY NOT THE PRODUCT EVENT BUS, which has a WORKOUT_COMPLETED type sitting
  // ready for exactly this. Because that type is not free: challenges.js
  // subscribes to it (onWorkoutCompletedForChallenges) and its handler WRITES
  // challenge_progress rows on every emit. Turning that on is a real change
  // to how challenges score, it belongs to the challenges ticket that owns
  // that consumer, and it is the opposite of this change's own rule - nothing
  // reaches the server without a tap. Raised rather than decided here; the
  // bus type stays unproduced, exactly as its own comment describes.
  function offerWorkoutSharePrompt(type, id) {
    if (!type || !id) return false;
    // A save that produced a full-screen celebration already has its moment,
    // and that moment is a PR or a medal - both of which bring their own,
    // richer prompt (and both of which can UPGRADE or replace the plain
    // workout card, so asking here would be asking twice about one record).
    if (appCelebrationOpen()) return false;
    return offerSharePrompt("workout", function () { return openWorkoutSharePrompt(type, id); });
  }
  // The one name this file puts on window, and the only one it needs to: it is
  // the seam between app.js (which knows what was saved) and the community
  // layer (which owns every decision about whether to ask). Everything else
  // here is a bare global shared with cloud.js through the one lexical scope
  // classic <script> tags get - see this file's header.
  window.offerWorkoutSharePrompt = offerWorkoutSharePrompt;
  function appCelebrationOpen() {
    const overlay = document.getElementById("celebrationOverlay");
    return !!(overlay && overlay.classList && overlay.classList.contains("open"));
  }
  function openWorkoutSharePrompt(type, id) {
    const key = workoutPromptKey(type, id);
    if (workoutPromptAlreadyOffered(key)) return false;
    // The entry is read from app.js's own log, which is the only place that
    // knows what was saved - and a record it cannot find is a record there is
    // nothing honest to put on a card about.
    if (typeof window.communityShareCandidateFor !== "function") return false;
    const item = window.communityShareCandidateFor(type, id);
    if (!item) return false;
    rememberWorkoutPromptOffered(key);
    state.posts.workoutPrompt = {
      type: type, id: id, title: item.title, resultText: item.resultText,
      publishing: false, error: "",
    };
    rerender();
    return true;
  }
  function dismissWorkoutSharePrompt() {
    state.posts.workoutPrompt = null;
    rerender();
    sharePromptClosed();
  }
  // THE ONE WRITE IN THIS FEATURE, and it is reached only from a tap on
  // data-community-action="workout-share". shareWorkoutRecord() (posts.js) is
  // the same function the share control in Calendar and Progress calls, so
  // the payload, the on-conflict target, the offline queueing and the
  // workout_shared measurement have exactly one definition between them.
  async function shareWorkoutSharePrompt() {
    const p = state.posts.workoutPrompt;
    if (!p || p.publishing) return;
    if (typeof window.communityShareCandidateFor !== "function") return;
    const item = window.communityShareCandidateFor(p.type, p.id);
    if (!item) { p.error = "לא ניתן למצוא את התוצאה במכשיר"; return rerender(); }
    p.publishing = true;
    p.error = "";
    rerender();
    const { queued, error } = await shareWorkoutRecord(item, "public", null);
    if (error) {
      p.publishing = false;
      p.error = serverErrorText(error);
      return rerender();
    }
    state.posts.workoutPrompt = null;
    if (queued) {
      setMessage("האימון יישלח למועדון כשהחיבור יחזור");
    } else {
      setMessage("האימון שותף למועדון");
      await loadFeed();
    }
    rerender();
    sharePromptClosed();
  }
  function renderWorkoutSharePrompt() {
    const p = state.posts.workoutPrompt;
    if (!p) return "";
    // Every rule here is built from existing tokens and existing classes
    // (.modal-overlay, .modal-sheet, .chip-btn, .chip-row, --chalk, --steel,
    // --brass), so it themes itself and adds nothing to either dark block -
    // CLAUDE.md's preferred way of not needing the duplicate at all.
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="workoutPromptTitle" data-cloud-dialog="workoutPrompt" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="workoutPrompt" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <h2 id="workoutPromptTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:6px;">לשתף עם המועדון?</h2>
          <div style="font-size:13px;color:var(--chalk);font-weight:700;">${esc(p.title || "")}</div>
          ${p.resultText ? `<div style="font-size:12.5px;color:var(--steel);margin-top:2px;"><span class="mono" style="color:var(--brass);">${esc(p.resultText)}</span></div>` : ""}
          ${sharePromptPrivacyNoteHtml()}
          ${p.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(p.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;">
            <button class="chip-btn primary" data-community-action="workout-share"${p.publishing ? " disabled" : ""}>${p.publishing ? "משתף…" : "שיתוף"}</button>
            <button class="chip-btn" data-community-action="workout-not-now">לא עכשיו</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---- The switch, on the Account tab ----------------------------------
  // Under the privacy panel, because it is the same question asked from the
  // other side: those toggles say what the club may read, this one says
  // whether the app may ask. Persists on change with no save button, the
  // pattern the privacy toggles beside it already use.
  function renderSharePromptPrefPanel() {
    if (!state.user || !state.profile) return "";
    if (!isModuleEnabled("feed")) return "";
    const on = sharePromptsEnabled();
    return `<div class="ach-section" id="sharePromptPrefPanel" style="margin-top:18px;">${sectionHead("var(--brass)", "הצעות שיתוף")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">אחרי אימון, שיא או מדליה נשאל פעם אחת אם לשתף. שום דבר לא מתפרסם בלי לחיצה שלכם.</div>
      <div class="log-list"><label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;"><span style="font-size:13px;">להציע לי לשתף אחרי אימון</span><input type="checkbox" data-share-prompt-pref${on ? " checked" : ""} aria-label="להציע לי לשתף אחרי אימון"/></label></div>
    </div>`;
  }
