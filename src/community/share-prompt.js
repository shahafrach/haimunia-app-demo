"use strict";
// ---- Community: the share prompts for PRs and medals -----------------------
//
// A workout is not asked about any more: logging is sharing, and the circles
// a workout goes to are the member's own share settings per circle
// (src/community/circles.js). What is left to ask about is the two things the
// member EARNED and may want to choose circles for: a personal record and a
// medal. This file is the coordinator both pass through, so the member is
// asked at most once per moment, only when every switch that governs the
// answer is on, and never without a tap.
//
// THE RULES, each with its own guard in test/community-share-prompt.test.mjs:
//
//   1. NEVER WITHOUT AN EXPLICIT TAP. Nothing in this file writes. Opening a
//      prompt is not sharing; only sharePrPrompt() (posts.js) and
//      shareAchievementUnlock() (achievements.js) write.
//   2. THE MEMBER CAN TURN IT OFF. renderSharePromptPrefPanel() (Me) writes one
//      localStorage key, and sharePromptAllowed() - which both prompts ask
//      first - reads it. Off means no prompt after a PR or an unlock; it never
//      touches a share the member goes looking for.
//   3. A PROMPT NEEDS A CIRCLE TO SHARE TO. A member who is in no circle has
//      nobody to tell, so nothing is offered.
//   4. ONE QUESTION AT A TIME. A save that is a PR and unlocks a medal is one
//      save, not two questions; the second is parked and released when the
//      first is answered.
//
// Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.

  // ---- The member's own switch (rule 2) --------------------------------
  //
  // localStorage, not a profiles column: a column needs a migration, and this
  // branch adds none (CLAUDE.md, "Parallel work"). It is also the right
  // storage on its own merits: nothing server-side reads this and no other
  // member's view of this member changes.
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
      state.posts.prPrompt = null;
      state.achievements.unlock = null;
      sharePromptQueue.length = 0;
    }
    setMessage(on
      ? "נציע שיתוף כשיש שיא או מדליה."
      : "לא נציע יותר. אפשר לשתף בכל רגע מההתקדמות וממסך ההישגים.");
    rerender();
  }

  // ---- The gate every prompt passes (rules 2 and 3) --------------------
  function sharePromptAllowed(kind) {
    if (typeof window.isCommunitySignedIn !== "function" || !window.isCommunitySignedIn()) return false;
    if (!state.user || !state.profile) return false;
    if (!state.circles.list.length) return false;
    if (!sharePromptsEnabled()) return false;
    return true;
  }

  // ---- One prompt at a time (rule 4) -----------------------------------
  //
  // A QUEUE RATHER THAN A DROP, for the two that carry something the member
  // earned: an achievement unlock suppressed because the PR prompt happened to
  // be open is a celebration the member never gets. Capped at two parked
  // offers, because a third question about one save is not a queue problem,
  // it is a design problem; and re-gated on release, so a member who turns the
  // switch off (or signs out) while one is parked never sees it.
  const SHARE_PROMPT_QUEUE_MAX = 2;
  const sharePromptQueue = [];
  function anySharePromptOpen() {
    return !!(state.posts.prPrompt || state.achievements.unlock);
  }
  // `open` returns true when it actually opened something.
  function offerSharePrompt(kind, open) {
    if (!sharePromptAllowed(kind)) return false;
    if (anySharePromptOpen()) {
      if (sharePromptQueue.length < SHARE_PROMPT_QUEUE_MAX) sharePromptQueue.push({ kind: kind, open: open });
      return false;
    }
    return !!open();
  }
  // A parked offer must not outlive the session that earned it. Called from
  // the sign-out reset beside the state leaves it clears.
  function resetSharePromptQueue() { sharePromptQueue.length = 0; }
  // Called by every exit of both prompts. Not by a render: a prompt that
  // closed because the member answered it is the only thing that earns the
  // next question.
  function sharePromptClosed() {
    while (sharePromptQueue.length) {
      const next = sharePromptQueue.shift();
      if (!sharePromptAllowed(next.kind)) continue;
      if (next.open()) return;
    }
  }

  // ---- The switch, in Me -------------------------------------------------
  // Persists on change with no save button.
  function renderSharePromptPrefPanel() {
    if (!state.user || !state.profile) return "";
    const on = sharePromptsEnabled();
    return `<div class="ach-section" id="sharePromptPrefPanel" style="margin-top:18px;">${sectionHead("var(--brass)", "הצעות שיתוף")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">אימון נשלח למעגלים לפי ההגדרות של כל מעגל. על שיא או מדליה נשאל פעם אחת איפה לשתף. שום דבר לא מתפרסם בלי לחיצה שלכם.</div>
      <div class="log-list"><label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;"><span style="font-size:13px;">להציע לי לשתף שיאים ומדליות</span><input type="checkbox" data-share-prompt-pref${on ? " checked" : ""} aria-label="להציע לי לשתף שיאים ומדליות"/></label></div>
    </div>`;
  }
