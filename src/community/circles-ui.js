// @ts-check
"use strict";
// ---- Circles: the screens --------------------------------------------------
//
// The three places a member lives, per docs/design/decisions.md: Home, Circle
// and Me (Me opens from the avatar on Home), plus the gate every one of them
// sits behind until the member has an account, a profile and a circle. Sheets
// (create, settings, invite, share) are in circles-sheets.js.
//
// Everything here is built from the existing components and tokens
// (.chart-card, .chip-btn, .save-btn, .subtabbar, .log-row, var(--color-accent)...).
// No palette, no new colour: the visual redesign is the Design session's.
//
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, esc,
// bidiText, field, sectionHead and the account helpers from the shared scope,
// from inside function bodies only.

  const EMOJI_CHOICES = ["🔥", "💪", "🏋️", "🤸", "🏃", "🚴", "🧗", "🥇", "🌟", "🐺", "🦁", "🌿"];

  function uiDraft(key, fallback) {
    const d = state.circles.drafts;
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : fallback;
  }
  function uiMessageHtml() {
    return state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--color-accent);">${esc(state.ui.message)}</div>` : "";
  }
  // A floating status line, the same one the old Community tab drew, for the
  // screens that are full pages rather than a card.
  function uiToastHtml() {
    return state.ui.message
      ? `<div role="status" aria-live="polite" data-dock="1" style="position:fixed;left:0;right:0;bottom:calc(var(--bottom-nav-reserve) - 108px);display:flex;justify-content:center;padding:0 16px;z-index:60;pointer-events:none;"><div style="max-width:448px;background:var(--color-surface);border:1px solid var(--color-accent);color:var(--color-accent);border-radius:14px;padding:11px 16px;font-size:13px;font-weight:700;line-height:1.45;box-shadow:var(--card-shadow);text-align:center;">${esc(state.ui.message)}</div></div>`
      : "";
  }
  // One page frame for Home, Circle and Me.
  function circleScene(tabKey, title, inner) {
    return `<section class="scene-page ${(window.PAGE_SCENES[tabKey] || window.PAGE_SCENES.community).className}" aria-labelledby="pageTitle-${tabKey}">
      <div class="scene-page__intro">
        <h1 id="pageTitle-${tabKey}" class="scene-page__title">${esc(title)}</h1>
      </div>
      <div class="scene-sheet">
${uiToastHtml()}${renderOutboxBanner()}${inner}</div></section>`;
  }

  // The list of circles with a checkbox each, used wherever the member picks
  // where something goes (a PR, a medal, a medal-as-text, a workout).
  function circlePickListHtml(picked, dataAttr, noteFn) {
    const on = new Set(picked || []);
    const rows = state.circles.list.map((c) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
        <span style="min-width:0;"><span aria-hidden="true">${esc(c.emoji)}</span> ${bidiText(c.name)}${noteFn ? `<span style="display:block;color:var(--color-text-muted);font-size:11.5px;">${esc(noteFn(c))}</span>` : ""}</span>
        <input type="checkbox" ${dataAttr}="${esc(c.id)}"${on.has(c.id) ? " checked" : ""} aria-label="${esc(c.name)}"/>
      </label>`).join("");
    return `<div class="field-label" style="margin:12px 0 4px;">למעגלים</div><div class="log-list">${rows}</div>`;
  }

  // ---- The gate -----------------------------------------------------------------
  function gateNotConfigured() {
    return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:8px;">המעגלים מוכנים לחיבור</div><div style="color:var(--color-text-muted);font-size:13px;line-height:1.7;">יש ליצור פרויקט Supabase ולמלא את cloud-config.js (ראו COMMUNITY_SETUP.md). עד אז היומן הפרטי עובד במלואו, והמעגלים יופיעו כאן.</div></div>`;
  }
  function gateCard(inner) { return `<div class="chart-card">${inner}</div>`; }
  // What signing up involves, said before it starts (shown on both pre-signup screens).
  function signupExplainerHtml() {
    return `<div data-signup-explainer="1" style="border:1px solid var(--color-border-strong);border-radius:var(--radius-control);padding:12px 14px;margin-bottom:16px;font-size:13.5px;line-height:1.7;">
      <div style="font-weight:800;margin-bottom:4px;">איך ההרשמה עובדת</div>
      <ul style="margin:0;padding-inline-start:18px;">
        <li>${bidiText("בוחרים שם כניסה וסיסמה. בלי אימייל ובלי מספר טלפון.")}</li>
        <li>${bidiText("מקבלים קוד שחזור אחד, ושומרים אותו. הוא הדרך היחידה לאפס סיסמה שנשכחה.")}</li>
        <li>${bidiText("אפשר להוסיף אימות דו-שלבי באפליקציית אימות, ב״אני״. זה אופציונלי.")}</li>
        <li>${bidiText("נשארים מחוברים במכשיר עד שמתנתקים.")}</li>
      </ul></div>`;
  }

  // Whatever stands between the member and their circles, or "" when nothing
  // does. One function for Home, Circle and Me: they all need an account, a
  // profile and a circle before they have anything to show.
  function renderCircleGate(opts) {
    if (!configured) return gateNotConfigured();
    // Two-step login: a password-only session owes the code, and nothing else shows until it is given.
    if (mfaChallengeShowing()) return mfaChallengeHtml();
    // A recovery code on screen (after sign-up, after a recovery, after "קוד שחזור חדש")
    // comes before everything: it is shown once and must be saved before anything else.
    if (recoveryShowing()) return recoveryShowHtml();
    // An invite opened inside WhatsApp, Instagram or Facebook: steps to open it in the real browser.
    const inApp = sharingInAppGateHtml();
    if (inApp && !state.circles.list.length) return inApp;
    const j = state.circles.join;
    const inAny = state.circles.list.length > 0;
    if (!state.user || (state.user.is_anonymous && !state.signupStarted && !state.redemption && !inAny)) {
      // An invite link opened by someone with no session: say what they were
      // invited to and give both doors (join, or "I already have an account").
      if (j.token && !state.signupStarted && state.ui.gateView !== "login") {
        return gateCard(`<div style="font-weight:800;font-size:20px;margin-bottom:8px;">הוזמנת להצטרף למעגל</div>
          <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:18px;">${bidiText("מעגל הוא קבוצה קטנה וסגורה של חברים שרואים זה את האימונים והשיאים של זה. היומן הפרטי שלך נשאר במכשיר.")}</div>
          ${signupExplainerHtml()}
          <button class="save-btn" data-community-action="start-signup">הצטרפות למעגל</button>
          <div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:18px;">
            <span style="color:var(--color-text-muted);font-size:14px;">${bidiText("כבר יש לך חשבון?")}</span>
            <button class="gate-alt" data-community-action="show-login">התחברות</button>
          </div>${uiMessageHtml()}`);
      }
      if (!state.signupStarted && state.ui.recovery.view === "form") return recoveryFormHtml();
      if (!state.signupStarted && state.ui.gateView !== "login") {
        return gateCard(`<div style="font-weight:800;font-size:20px;margin-bottom:8px;">המעגלים שלך</div>
          <div style="color:var(--color-text);font-size:15px;line-height:1.5;margin-bottom:12px;">${bidiText("מעגל הוא קבוצה קטנה של חברים או זוג, שרואים זה את האימונים, השיאים והשבוע של זה.")}</div>
          <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:18px;">${bidiText("הכניסה בקישור הזמנה שמקבלים מחבר/ה במעגל. הקישור לא נוגע ליומן האימונים הפרטי שלכם.")}</div>
          ${signupExplainerHtml()}
          <button class="save-btn" data-community-action="start-signup">יש לי קישור הזמנה</button>
          <div style="display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:18px;">
            <span style="color:var(--color-text-muted);font-size:14px;">${bidiText("כבר יש לך חשבון?")}</span>
            <button class="gate-alt" data-community-action="show-login">התחברות</button>
          </div>${uiMessageHtml()}`);
      }
      if (!state.signupStarted) {
        return gateCard(`<button class="gate-back" data-community-action="gate-back">‹ חזרה</button>
          <div style="font-weight:800;font-size:20px;margin:6px 0 8px;">התחברות</div>
          <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("התחברות מחזירה את הפרופיל והמעגלים שלך, גם במכשיר חדש.")}</div>
          <form id="communityLogin">${field("communityLogin", "username", LOGIN_IDENTIFIER_LABEL, `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="${esc(LOGIN_IDENTIFIER_LABEL)}" required/>`)}${field("communityLogin", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="current-password" placeholder="סיסמה" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">התחברות</button></form>
          ${uiMessageHtml()}${LOGIN_RECOVERY_NOTE}`);
      }
      ensureAnonymousSession();
      return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">מתחברים…</div><div style="color:var(--color-text-muted);font-size:13px;">שנייה אחת.</div>${uiMessageHtml()}`);
    }
    if ((state.profileLoadError && !state.profile) || (state.redemptionLoadError && !state.redemption) || (state.circles.loadError && !state.circles.loaded)) {
      return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">בעיה בטעינת החשבון</div><div style="color:var(--color-text-muted);font-size:13px;margin-bottom:14px;">לא הצלחנו לטעון את פרטי החשבון והמעגלים. ייתכן שזו בעיית רשת זמנית.</div><button class="save-btn" data-community-action="retry-join-load">ניסיון חוזר</button>`);
    }
    if (!state.circles.loaded && (state.circles.loading || !state.redemption)) {
      return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">טוענים את המעגלים…</div><div style="color:var(--color-text-muted);font-size:13px;">שנייה אחת.</div>`);
    }
    // No circle and no bootstrap code: the only way in is an invite.
    // Me needs no circle: a member who has left their last one must still be
    // able to reach sign-out, export and account deletion.
    const meWithoutCircle = !!(opts && opts.allowNoCircle && !state.user.is_anonymous && state.profile && String(state.profile.display_name || "").trim());
    if (!inAny && !state.redemption && !meWithoutCircle) return renderJoinStep();
    if (state.user.is_anonymous) {
      return gateCard(`${renderJoinProgress(1)}<div style="font-weight:800;font-size:18px;margin-bottom:6px;">יצירת חשבון</div><div style="color:var(--color-text-muted);font-size:13px;line-height:1.7;margin-bottom:14px;">${CREDENTIALS_INTRO_TEXT}</div><form id="communityCredentials">${field("communityCredentials", "username", LOGIN_NAME_LABEL, `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="${esc(USERNAME_RULE_TEXT)}" data-live-validate="username" data-live-validate-form="communityCredentials" required/>`)}${field("communityCredentials", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="${esc(PASSWORD_RULE_TEXT)}" data-live-validate="password" data-live-validate-form="communityCredentials" required/>`)}${field("communityCredentials", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" data-live-validate="passwordConfirm" data-live-validate-form="communityCredentials" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">יצירת חשבון</button></form>${uiMessageHtml()}`);
    }
    if (!state.profile || !String(state.profile.display_name || "").trim()) {
      return gateCard(`${renderJoinProgress(2)}<div style="font-weight:800;font-size:18px;margin-bottom:6px;">איך יקראו לך במעגל?</div><div style="color:var(--color-text-muted);font-size:13px;line-height:1.7;margin-bottom:14px;">${CLUB_NAME_HINT_TEXT}</div>${profileFormHtml("communityProfile", {}, false)}${uiMessageHtml()}`);
    }
    if (!state.profile.recovery_verified_at) {
      verifyRecovery();
      return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">אבטחת החשבון</div>
        <div style="color:var(--color-text-muted);font-size:13px;line-height:1.7;margin-bottom:14px;">כדי להשתתף במעגלים נדרש חשבון שאפשר לשחזר. עד האימות המעגלים סגורים בפניו, גם לקריאה וגם לשיתוף. שם המשתמש והסיסמה שהגדרתם הם דרך השחזור: הם מאפשרים להתחבר לאותו פרופיל מכל מכשיר, גם אחרי החלפת טלפון. רישום האימונים והגיבוי הפרטי לא מושפעים וממשיכים לעבוד כרגיל.</div>
        <button class="save-btn" data-community-action="verify-recovery" style="margin-top:2px;">אימות והמשך</button>${uiMessageHtml()}`);
    }
    if (!inAny && !meWithoutCircle) return renderFirstCircle();
    return "";
  }

  // The invite step: paste a link (or arrive with one). Errors are the Hebrew
  // for the server's status, never the raw string.
  function renderJoinStep() {
    const j = state.circles.join;
    const waiting = j.token && !j.error;
    return gateCard(`<button class="gate-back" data-community-action="gate-back">‹ חזרה</button>${renderJoinProgress(0)}
      <div style="font-weight:800;font-size:18px;margin:0 0 6px;">${waiting ? "מצטרפים למעגל…" : "קישור הזמנה"}</div>
      <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("הדביקו את קישור ההזמנה שקיבלתם מחבר/ה במעגל. הקישור לא נוגע ליומן האימונים הפרטי שלכם.")}</div>
      ${j.error ? `<div class="field-error" role="alert" data-join-error="1" style="margin-bottom:10px;">${esc(j.error)}</div>` : ""}
      <form id="circleJoin">${field("circleJoin", "link", "קישור הזמנה", `<input class="text-input" name="link" dir="ltr" inputmode="url" autocomplete="off" autocapitalize="off" placeholder="https://…#invite=…" value="${esc(j.draft || "")}" data-circle-join-draft required/>`)}<button class="save-btn" type="submit"${j.busy ? " disabled" : ""} style="margin-top:12px;">${j.busy ? "מצטרפים…" : "הצטרפות"}</button></form>
      <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:16px;">
        <button class="gate-alt" data-community-action="back-to-login">כבר יש לכם חשבון? התחברות</button>
        ${meLinkHtml()}
      </div>
      <form id="communityInviteCode" style="margin-top:18px;border-top:1px solid var(--color-border);padding-top:14px;">${field("communityInviteCode", "code", "קוד פתיחה (למי שפותח את המעגל הראשון, בלי קישור)", `<input class="text-input" name="code" dir="ltr" inputmode="text" autocomplete="off" autocapitalize="off" maxlength="128" placeholder="קוד פתיחה" value="${esc(state.ui.inviteCodeDraft)}" data-invite-code required/>`)}<button class="save-btn" type="submit"${state.ui.redeemingCode ? " disabled" : ""} style="margin-top:12px;">${state.ui.redeemingCode ? "בודקים…" : "אישור קוד"}</button></form>
      ${uiMessageHtml()}`);
  }

  // The way to Me from a screen that has no avatar: for a member with an
  // account and a profile, whose circles are gone.
  function meLinkHtml() {
    return state.user && !state.user.is_anonymous && state.profile && String(state.profile.display_name || "").trim()
      ? `<button class="gate-alt" data-community-action="c-open-me">הפרופיל וההגדרות שלי</button>` : "";
  }

  // Signed in, a profile, but in no circle (a member who opened a first-owner
  // code, or one who left their last circle).
  function renderFirstCircle() {
    // A friend who arrived with a founder link (or the owner's first-circle
    // link) lands on the create-circle sheet, once. Closing it leaves the
    // button below.
    if (state.circles.founderLanding) {
      state.circles.founderLanding = false;
      if (!state.circles.sheet && typeof openCircleSheetFor === "function") openCircleSheetFor("create");
    }
    return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">עוד אין לך מעגל</div>
      <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("אפשר ליצור מעגל ולהזמין אליו חברים, או להצטרף למעגל קיים עם קישור הזמנה.")}</div>
      <button class="save-btn" data-community-action="c-create-open">יצירת מעגל</button>
      <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:12px;"><button class="gate-alt" data-community-action="c-join-open">יש לי קישור הזמנה</button>${meLinkHtml()}</div>
      ${state.circles.join.error ? `<div class="field-error" role="alert" style="margin-top:10px;">${esc(state.circles.join.error)}</div>` : ""}${uiMessageHtml()}`);
  }

  // The profile: display name and emoji, nothing else (decisions.md).
  function profileFormHtml(formId, p, showExtras) {
    const name = uiDraft(formId + ".displayName", p.display_name || "");
    const emoji = uiDraft(formId + ".emoji", p.emoji || "🙂");
    return `<form id="${formId}"${showExtras ? ' class="chart-card"' : ""}>
      ${showExtras ? `<div style="font-weight:800;font-size:16px;margin-bottom:12px;">הפרופיל שלי</div>` : ""}
      ${field(formId, "displayName", CLUB_NAME_LABEL, `<input class="text-input" name="displayName" dir="auto" value="${esc(name)}" data-draft="${formId}.displayName" placeholder="למשל דנה כהן" maxlength="40" required/>`)}
      ${field(formId, "emoji", "האימוג'י שלך", `<input class="text-input" name="emoji" dir="auto" value="${esc(emoji)}" data-draft="${formId}.emoji" maxlength="16" required/>`)}
      <div class="chip-row" role="group" aria-label="בחירת אימוג'י">${EMOJI_CHOICES.map((e) => `<button type="button" class="chip-btn" data-community-action="c-emoji-pick" data-emoji="${esc(e)}" data-form="${formId}" aria-label="${esc(e)}">${e}</button>`).join("")}</div>
      <button class="${showExtras ? "chip-btn primary" : "save-btn"}" type="submit" style="margin-top:12px;">${showExtras ? "שמירת פרופיל" : "המשך"}</button>
    </form>`;
  }

  // ---- Pending "trained together" tags ---------------------------------------------
  function pendingTagsHtml() {
    const tags = state.circles.pendingTags || [];
    if (!tags.length) return "";
    return `<div class="chart-card" data-pending-tags="1" style="margin-bottom:12px;border-color:var(--color-accent);">
      <div style="font-weight:800;font-size:15px;margin-bottom:6px;">התאמנו יחד?</div>
      ${tags.map((t) => {
        const day = t.day ? shortHebDate(t.day) : "";
        return `<div class="log-row" style="flex-wrap:wrap;gap:8px;"><span style="min-width:0;"><span aria-hidden="true">${esc(t.emoji)}</span> ${bidiText(t.by)} <span style="color:var(--color-text-muted);">${esc("תייג/ה אותך באימון" + (day ? " מ-" : ""))}${day ? `<bdi>${esc(day)}</bdi>` : ""}</span></span>
          <span class="chip-row" style="margin:0;"><button class="chip-btn primary" data-community-action="c-tag-confirm" data-id="${esc(t.post_id)}"${state.circles.busy["tag:" + t.post_id] ? " disabled" : ""}>התאמנו יחד</button><button class="chip-btn" data-community-action="c-tag-decline" data-id="${esc(t.post_id)}">לא</button></span></div>`;
      }).join("")}
      <div class="footer-note" style="margin-top:8px;">${esc("רק אחרי האישור האימון נספר גם לשבוע שלך.")}</div>
    </div>`;
  }

  // ---- Home ---------------------------------------------------------------------------
  //
  // Home is about me, Circle is about us (docs/circles/decisions.md, "Home and
  // recovery"). Everything on Home except the last card comes from the private log on
  // this device, so it draws the same for someone signed out, signed in with no circle,
  // and signed in with circles. The circle gate, feed, week and invites are the Circle
  // tab's: Home never calls renderCircleGate.
  function homeSignedIn() {
    return !!(state.user && !state.user.is_anonymous && state.profile && String(state.profile.display_name || "").trim());
  }
  function homeCard(inner, attrs) { return `<div class="chart-card" ${attrs || ""} style="margin-bottom:12px;">${inner}</div>`; }

  // This week against the personal weekly target, as the ring. With no target set the
  // ring uses the default of 3 (weeklyTargetForRing in app.js) and says so.
  function myTargetCardHtml(sum) {
    const mine = state.circles.mine;
    const signedIn = homeSignedIn();
    const days = typeof window.communityTrainingDays === "function" ? window.communityTrainingDays() : [];
    const done = CirclesCore.daysThisWeek(days, CirclesCore.jerusalemDay(new Date()));
    if (signedIn && isPausedNow()) {
      return homeCard(`<div style="font-weight:800;font-size:15px;">השבוע שלי</div><div style="color:var(--color-text-muted);font-size:13px;margin-top:4px;">${esc("את/ה בהפסקה עד " + shortHebDate(mine.pausedUntil) + ". המעגל רואה \"בהפסקה\" ולא אחוז.")}</div>`);
    }
    // The ring says what is smaller: what is done early in the week, what is left
    // late in it, and "target met" once it is. Same wording as the screen after a workout.
    const target = sum.target;
    const own = window.communityWeeklyTarget() > 0;
    const pct = Math.round((100 * done) / target);
    const copy = window.BoxLogProgress.ringCopy(done, target);
    const C = 326.73;
    const weeks = sum.weeksMet === 1 ? "שבוע אחד ביעד" : sum.weeksMet + " שבועות ביעד";
    const setTarget = signedIn
      ? (own ? "" : `<button class="chip-btn" data-community-action="c-open-me" style="margin-top:8px;">קביעת יעד</button>`)
      : "";
    const note = own ? "" : `<div style="color:var(--color-text-muted);font-size:12px;margin-top:4px;">יעד ברירת מחדל: ${target} בשבוע.</div>`;
    return homeCard(`<div class="week-card">
      <div class="week-ring" role="img" aria-label="${esc(copy.title + ", " + copy.sub + ", " + pct + "% מהיעד")}">
        <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52" stroke-width="12"/><circle class="ring-fill" cx="60" cy="60" r="52" stroke-width="12" stroke-dasharray="${C}" stroke-dashoffset="${(C * (1 - copy.fraction)).toFixed(2)}"/></svg>
        <div class="week-ring-label"><span class="big num">${esc(copy.big)}</span><span class="small">${esc(copy.small)}</span></div>
      </div>
      <div style="min-width:0;"><div style="font-weight:800;font-size:15px;">השבוע שלי</div>
        <div style="font-weight:800;margin-top:4px;">${esc(copy.title)}</div>
        <div style="color:var(--color-text-muted);font-size:12.5px;margin-top:2px;">${esc(done + " מתוך " + target + " אימונים השבוע")}</div>
        <div class="mono" style="color:var(--color-accent);font-weight:800;margin-top:6px;"><bdi>${pct}%</bdi> <span style="font-weight:600;color:var(--color-text-muted);">מהיעד</span></div>
        <div data-weeks-met="${sum.weeksMet}" style="color:var(--color-text-muted);font-size:12.5px;margin-top:4px;">${esc(weeks)}</div>${note}${setTarget}</div>
    </div>`, `data-week-ring="${esc(copy.framing)}"`);
  }

  // The last session, with one tap to log the same lift again (the Log tab, prefilled).
  function homeLastSessionHtml(sum) {
    if (!sum.last) return "";
    return homeCard(`<div class="flex" style="justify-content:space-between;align-items:center;gap:10px;">
      <div style="min-width:0;"><div style="color:var(--color-text-muted);font-size:12px;">האימון האחרון${sum.last.date ? " · " + esc(shortHebDate(sum.last.date)) : ""}</div>
        <div style="font-weight:800;margin-top:2px;">${bidiText(sum.last.name)}</div>
        <div style="color:var(--color-text-muted);font-size:13px;">${bidiText(sum.last.text)}</div></div>
      <button class="chip-btn primary" data-action="log-same-lift" data-id="${esc(sum.last.id)}" style="flex-shrink:0;">לרשום שוב</button></div>`, 'data-last-session="1"');
  }

  // The latest PRs with the percent improvement, from the log on this device.
  function homePrsHtml(sum) {
    if (!sum.prs.length) return "";
    const star = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="m12 2 3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z"/></svg>`;
    return `<div class="ach-section" data-home-prs="1" style="margin-top:6px;">${sectionHead("var(--color-accent)", "השיאים האחרונים")}<div class="log-list">${sum.prs.map((p) => `<div class="log-row home-pr-row" data-last-pr="1" style="justify-content:space-between;gap:10px;">
        <span style="display:flex;align-items:center;gap:10px;min-width:0;"><span class="pr-badge" aria-hidden="true">${star}<span>שיא</span></span><span style="min-width:0;"><span style="font-weight:800;display:block;">${bidiText(p.name)}</span><span style="color:var(--color-text-muted);font-size:12.5px;">${esc(p.text)}</span></span></span>
        <span class="mono" style="color:var(--color-accent);font-weight:800;"><bdi class="num">+${esc(String(p.pct))}%</bdi></span></div>`).join("")}</div></div>`;
  }

  // The way back into logging.
  function homeLogCtaHtml(sum) {
    const sub = sum.last ? `הפעם האחרונה: ${sum.last.name}, ${sum.last.text}` : "בוחרים תרגיל ורושמים סט";
    return `<button class="home-log-cta" data-action="switch-tab" data-tab="add"><span><span class="home-log-cta-title">${sum.last ? "רישום סט" : "רישום האימון הראשון"}</span><span class="home-log-cta-sub" style="display:block;">${bidiText(sub)}</span></span>
      <span class="tab-log-disc" aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:999px;background:var(--btn-primary-bg);color:var(--btn-primary-fg);flex-shrink:0;">${typeof ICONS !== "undefined" ? ICONS.logIcon : "+"}</span></button>`;
  }

  // First run: nothing logged yet.
  function homeFirstRunHtml() {
    return homeCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">מתחילים כאן</div>
      <div style="color:var(--color-text);font-size:14px;line-height:1.7;">${bidiText("בוחרים תרגיל, רושמים סט אחד, ושומרים. השבוע, השיאים והשבועות ביעד יופיעו כאן. הכול נשאר במכשיר שלך, בלי חשבון.")}</div>`, 'data-home-first-run="1"');
  }

  // The recent posts on Home: the circle the Circle tab opens on, three at most.
  function homeRecentPostsHtml() {
    const c = currentCircle();
    const f = c && state.circles.feed[c.id];
    if (!f || !f.loaded) return "";
    const posts = CirclesCore.feedOrder(f.rows).slice(0, 3).map((r) => CirclesCore.feedPost(r));
    if (!posts.length) return `<div style="color:var(--color-text-muted);font-size:12.5px;margin-top:8px;" data-home-empty-posts="1">עוד אין פוסטים במעגלים.</div>`;
    return `<div class="log-list" data-home-posts="1" style="margin-top:8px;">${posts.map((p) => {
      const what = String(p.title || p.result_text || p.body || "").trim();
      return `<div class="log-row" style="gap:8px;justify-content:flex-start;min-width:0;"><span aria-hidden="true">${esc(p.author.emoji || "🙂")}</span><span style="min-width:0;"><span style="font-weight:700;">${bidiText(p.author.display_name || "חבר/ה")}</span>${what ? ` <span style="color:var(--color-text-muted);font-size:13px;">${bidiText(what.length > 80 ? what.slice(0, 80) + "…" : what)}</span>` : ""}</span></div>`;
    }).join("")}</div>`;
  }

  // Circles on Home: one compact card. The full gate, feed, week and invites are on the
  // Circle tab.
  function homeCirclesCardHtml() {
    if (!configured) return "";
    const list = state.circles.list;
    const head = sectionHead("var(--color-accent)", "המעגלים שלי");
    if (homeSignedIn() && list.length) {
      const rows = list.map((c) => `<button class="log-row" data-community-action="c-open-circle" data-id="${esc(c.id)}" style="width:100%;text-align:inherit;">
        <span style="display:flex;gap:10px;align-items:center;min-width:0;"><span aria-hidden="true" style="font-size:22px;">${esc(c.emoji)}</span><span style="min-width:0;"><span style="font-weight:700;">${bidiText(c.name)}</span><span style="display:block;color:var(--color-text-muted);font-size:12px;">${esc(c.type === "couple" ? "זוג" : "חברים")}${c.role === "owner" && c.type !== "couple" ? " · בעלות" : ""}</span></span></span>
        <span style="color:var(--color-text-muted);transform:scaleX(-1);display:inline-flex;" aria-hidden="true">${ICONS_CHEVRON()}</span></button>`).join("");
      return `<div class="ach-section" data-home-circles="list" style="margin-top:6px;">${head}<div class="log-list">${rows}</div>${homeRecentPostsHtml()}
        <div class="chip-row" style="margin-top:10px;"><button class="chip-btn" data-community-action="c-create-open">יצירת מעגל</button><button class="chip-btn" data-community-action="c-join-open">הצטרפות עם קישור</button></div></div>`;
    }
    // No account, or no circle yet: one line and the two doors. Signed out, both go to
    // the Circle tab, which has the sign-up and login screens; signed in, they open the
    // create and join sheets right here.
    const here = homeSignedIn();
    const create = here ? `data-community-action="c-create-open"` : `data-action="switch-tab" data-tab="community"`;
    const join = here ? `data-community-action="c-join-open"` : `data-action="switch-tab" data-tab="community"`;
    const line = here ? "עוד אין לך מעגל. אפשר ליצור אחד או להצטרף עם קישור." : "מעגל הוא קבוצה קטנה של חברים שרואים זה את האימונים של זה.";
    return `<div class="ach-section" data-home-circles="none" style="margin-top:6px;">${head}<div style="color:var(--color-text-muted);font-size:13.5px;line-height:1.6;">${bidiText(line)}</div>
      <div class="chip-row" style="margin-top:10px;"><button class="chip-btn" ${create}>יצירת מעגל</button><button class="chip-btn" ${join}>הצטרפות עם קישור</button></div></div>`;
  }

  function renderHomeScreen() {
    const sum = typeof window.homeSummary === "function" ? window.homeSummary() : null;
    const signedIn = homeSignedIn();
    const p = state.profile || {};
    const who = signedIn ? bidiText(p.display_name || "") : "";
    const avatar = signedIn
      ? `<button class="avatar-badge" data-community-action="c-open-me" aria-label="הפרופיל וההגדרות שלי" style="width:44px;height:44px;font-size:22px;background:var(--color-surface);border:1px solid var(--color-border);">${esc(p.emoji || "🙂")}</button>`
      : `<span class="avatar-badge" aria-hidden="true" style="width:44px;height:44px;font-size:22px;background:var(--color-surface);border:1px solid var(--color-border);">🙂</span>`;
    const header = `<div class="chart-card"${signedIn ? ' id="communityHead"' : ' data-home-head="1"'} style="margin-bottom:12px;"><div class="flex" style="justify-content:space-between;align-items:center;gap:10px;">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        ${avatar}
        <div style="min-width:0;"><div style="color:var(--color-text-muted);font-size:12px;">שלום</div><div style="font-weight:800;font-size:16px;">${who || "וברוכים הבאים"}</div></div>
      </div>${signedIn ? renderNotificationBell() : ""}</div></div>`;
    const own = !sum ? `<div class="empty">טוען…</div>`
      : !sum.hasData ? homeFirstRunHtml() + myTargetCardHtml(sum) + homeLogCtaHtml(sum)
      : myTargetCardHtml(sum) + homeLastSessionHtml(sum) + homeLogCtaHtml(sum) + homePrsHtml(sum);
    return circleScene("home", "בית", header + (signedIn ? pendingTagsHtml() : "") + own + homeCirclesCardHtml());
  }
  function ICONS_CHEVRON() { return typeof ICONS !== "undefined" && ICONS.chevron ? ICONS.chevron : "›"; }

  // ---- Circle ---------------------------------------------------------------------------
  function circleSwitcherHtml(c) {
    const chips = state.circles.list.map((x) => `<button class="subtabbtn${x.id === c.id ? " active" : ""}" style="flex:0 0 auto;min-width:72px;padding:8px 12px;" data-community-action="c-pick" data-id="${esc(x.id)}" aria-pressed="${x.id === c.id ? "true" : "false"}"><span aria-hidden="true">${esc(x.emoji)}</span> ${esc(x.name)}</button>`).join("");
    const add = `<button class="subtabbtn" style="flex:0 0 auto;min-width:44px;padding:8px 12px;" data-community-action="c-create-open" aria-label="מעגל חדש">+</button>`;
    return `<div class="subtabbar" role="group" aria-label="המעגלים שלי" style="overflow-x:auto;gap:4px;">${chips}${add}</div>`;
  }
  function circleHeaderHtml(c) {
    const count = circleMemberCount(c.id);
    const actions = [
      canInvite(c) ? `<button class="chip-btn primary" data-community-action="c-invite-open" data-id="${esc(c.id)}">הזמנה</button>` : "",
      circleIsOwner(c) ? `<button class="chip-btn" data-community-action="c-settings-open" data-id="${esc(c.id)}">הגדרות המעגל</button>` : "",
      `<button class="chip-btn danger" data-community-action="c-leave-ask" data-id="${esc(c.id)}">עזיבת המעגל</button>`,
    ].join("");
    return `<div class="chart-card" id="communityHead" style="margin-bottom:12px;">
      <div class="flex" style="align-items:center;gap:12px;"><span aria-hidden="true" style="font-size:30px;">${esc(c.emoji)}</span><div style="min-width:0;"><div style="font-weight:800;font-size:18px;">${bidiText(c.name)}</div><div style="color:var(--color-text-muted);font-size:12.5px;">${esc((c.type === "couple" ? "מעגל זוגי" : "מעגל חברים") + (c.mode === "weekly_competition" ? " · תחרות שבועית" : "") + (count ? " · " + (count === 1 ? "חבר/ה אחד" : count + " חברים") : ""))}</div></div></div>
      ${c.welcome_line ? `<div style="margin-top:10px;font-size:14px;line-height:1.6;" data-welcome-line="1">${bidiText(c.welcome_line)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">${actions}</div></div>`;
  }
  function circleSectionTabsHtml(c) {
    const secs = [["feed", "הפיד"], ["week", "השבוע"]];
    if (c.benchmark_enabled) secs.push(["benchmark", "בנצ'מרק"]);
    secs.push(["members", "חברים"]);
    const cur = secs.some((s) => s[0] === state.circles.section) ? state.circles.section : "feed";
    return `<div class="subtabbar" role="tablist" aria-label="תצוגת המעגל">${secs.map((s) => `<button class="subtabbtn${cur === s[0] ? " active" : ""}" id="circleTab-${s[0]}" role="tab" aria-selected="${cur === s[0]}" aria-controls="circlePanel" tabindex="${cur === s[0] ? "0" : "-1"}" data-community-action="c-section" data-section="${s[0]}">${esc(s[1])}</button>`).join("")}</div>`;
  }

  function feedSectionHtml(c) {
    const f = state.circles.feed[c.id] || { rows: [], done: true, loaded: false, loading: false, error: false };
    // The cards are the posts the client holds (state.posts.held): loadFeed()
    // fills it from circle_feed, in the order they are drawn, and window.holdPosts
    // is the one other way in.
    const held = Array.isArray(state.posts.held) ? state.posts.held : [];
    if (held.length) {
      const cards = held.map((p) => renderPostCard(p)).join("");
      return `<div class="log-list" id="communityHeldPosts">${cards}</div>${f.done ? "" : `<button class="chip-btn" data-community-action="c-feed-more" style="margin:10px auto;display:block;"${f.loading ? " disabled" : ""}>${f.loading ? "טוען…" : "עוד"}</button>`}`;
    }
    if (!state.circles.feed[c.id] || (!f.loaded && f.loading)) return `<div class="empty" aria-busy="true">טוען…</div>`;
    if (f.error && !f.loaded) return `<div class="chart-card"><div style="color:var(--color-text-muted);font-size:13px;margin-bottom:10px;">לא הצלחנו לטעון את הפיד.</div><button class="chip-btn" data-community-action="c-feed-retry">ניסיון חוזר</button></div>`;
    return `<div class="empty" data-empty="feed">${esc(c.type === "couple" ? "עוד אין כלום כאן. אימון שתשמרו יופיע אצל שניכם." : "עוד אין כלום בפיד. שיא שתשתפו, או אימון בהגדרת שיתוף מלאה, יופיעו כאן.")}</div>`;
  }

  // The week: each member's percent of their OWN target, paused marked, weeks
  // met. Never a ranking, never an absolute number. Couples see their two
  // weeks side by side.
  function weekCardHtml(m) {
    let figure;
    if (m.paused) figure = `<div style="color:var(--color-text-muted);font-weight:700;" data-week-paused="1">בהפסקה</div>`;
    else if (m.hidden) figure = `<div style="color:var(--color-text-muted);">לא משתף/ת</div>`;
    else if (m.percent == null) figure = `<div style="color:var(--color-text-muted);">${esc(m.workouts != null ? m.workouts + " אימונים" : "")}</div>`;
    else figure = `<div class="mono" style="color:var(--color-accent);font-weight:800;font-size:22px;"><bdi>${m.percent}%</bdi></div>`;
    const bar = m.paused || m.percent == null ? "" : `<div class="week-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.barPercent}" aria-label="${esc("אחוז מהיעד של " + m.name)}"><span style="width:${m.barPercent}%;"></span></div>`;
    const met = m.weeksMet != null ? `<div style="color:var(--color-text-muted);font-size:12px;margin-top:4px;">${esc(m.weeksMet === 1 ? "שבוע אחד עמד ביעד" : m.weeksMet + " שבועות עמדו ביעד")}</div>` : "";
    return `<div class="chart-card" data-week-member="${esc(m.userId)}"${m.isMe ? ' data-week-me="1"' : ""} style="margin:0;">
      <div class="flex" style="align-items:center;gap:8px;margin-bottom:6px;"><span aria-hidden="true" style="font-size:22px;">${esc(m.emoji)}</span><span style="font-weight:800;min-width:0;">${bidiText(m.name)}${m.isMe ? ` <span style="color:var(--color-text-muted);font-weight:600;">(אני)</span>` : ""}</span></div>
      ${figure}${bar}${met}</div>`;
  }
  function weekSectionHtml(c) {
    const w = state.circles.week[c.id];
    if (!w || (!w.loaded && w.loading)) return `<div class="empty" aria-busy="true">טוען…</div>`;
    if (w.error && !w.loaded) return `<div class="chart-card"><div style="color:var(--color-text-muted);font-size:13px;margin-bottom:10px;">לא הצלחנו לטעון את השבוע.</div><button class="chip-btn" data-community-action="c-week-retry">ניסיון חוזר</button></div>`;
    const view = CirclesCore.weekView(w.rows, state.user.id);
    const grid = c.type === "couple"
      ? `<div class="week-pair" data-week-layout="pair">${view.map(weekCardHtml).join("")}</div>`
      : `<div class="week-list" data-week-layout="list">${view.map(weekCardHtml).join("")}</div>`;
    const note = c.mode === "weekly_competition"
      ? "תחרות שבועית: משווים אחוז מהיעד האישי, אף פעם לא מספרים מוחלטים."
      : "כל אחד מול היעד של עצמו. אין דירוג. השבוע מתחיל ביום ראשון.";
    return grid + `<div class="footer-note" style="margin-top:10px;">${esc(note)}</div>` + sharingWeekButtonHtml(c);
  }

  function circleBenchmarkSectionHtml(c) {
    const ownerPick = circleIsOwner(c)
      ? `<div class="chart-card" style="margin-bottom:12px;"><div style="font-weight:800;margin-bottom:8px;">הבנצ'מרק של החודש</div>
          <div class="chip-row" role="group" aria-label="בחירת הבנצ'מרק של החודש">${CirclesCore.BENCHMARK_IDS.map((id) => `<button class="chip-btn${c.benchmark === id && benchmarkIsCurrent(c) ? " primary" : ""}" data-community-action="c-bench-pick" data-id="${id}" aria-pressed="${c.benchmark === id && benchmarkIsCurrent(c) ? "true" : "false"}">${esc(benchmarkName(id))}</button>`).join("")}</div>
          ${benchmarkIsCurrent(c) ? `<button class="link-btn" data-community-action="c-bench-pick" data-id="" style="margin-top:8px;">הסרת הבחירה</button>` : ""}</div>`
      : "";
    if (!benchmarkIsCurrent(c)) {
      return ownerPick + `<div class="empty" data-empty="benchmark">${esc(circleIsOwner(c) ? "בחרו בנצ'מרק לחודש הזה." : "בעל/ת המעגל עוד לא בחר/ה בנצ'מרק לחודש הזה.")}</div>`;
    }
    const b = state.circles.benchmark[c.id];
    if (!b || (!b.loaded && b.loading)) return ownerPick + `<div class="empty" aria-busy="true">טוען…</div>`;
    const mineRow = b.rows.find((r) => r.user_id === state.user.id);
    const level = uiDraft("circleBenchmark.level", mineRow ? mineRow.rx_or_scaled : "rx");
    const form = `<form id="circleBenchmark" class="chart-card" style="margin-bottom:12px;">
        <div style="font-weight:800;margin-bottom:2px;">${bidiText(benchmarkName(c.benchmark))}</div>
        <div style="color:var(--color-text-muted);font-size:12.5px;line-height:1.6;margin-bottom:10px;">${esc(benchmarkDesc(c.benchmark))}</div>
        ${field("circleBenchmark", "result", mineRow ? "התוצאה שלי (אפשר לעדכן)" : "התוצאה שלי", `<input class="text-input" name="result" dir="auto" maxlength="40" value="${esc(uiDraft("circleBenchmark.result", mineRow ? mineRow.result : benchmarkPrefill(c.benchmark)))}" data-draft="circleBenchmark.result" placeholder="למשל 4:35 או 12 סבבים" required/>`)}
        <div class="subtabbar" role="radiogroup" aria-label="רמת הביצוע"><label class="subtabbtn${level === "rx" ? " active" : ""}" style="display:flex;align-items:center;justify-content:center;gap:6px;"><input type="radio" name="level" value="rx" data-draft="circleBenchmark.level"${level === "rx" ? " checked" : ""}/> Rx</label><label class="subtabbtn${level === "scaled" ? " active" : ""}" style="display:flex;align-items:center;justify-content:center;gap:6px;"><input type="radio" name="level" value="scaled" data-draft="circleBenchmark.level"${level === "scaled" ? " checked" : ""}/> Scaled</label></div>
        <button class="save-btn" type="submit"${state.circles.busy.bench ? " disabled" : ""} style="margin-top:10px;">${mineRow ? "עדכון התוצאה" : "שמירת התוצאה"}</button></form>`;
    if (!mineRow) {
      return ownerPick + form + `<div class="empty" data-empty="benchmark-locked">${esc("התוצאות של האחרים יופיעו אחרי שתשמרו את שלכם.")}</div>`;
    }
    const split = CirclesCore.splitBenchmarkResults(b.rows);
    const list = (title, rows) => `<div class="ach-section" style="margin-top:12px;">${sectionHead("var(--color-accent)", esc(title))}${rows.length ? `<div class="log-list">${rows.map((r) => `<div class="log-row"><span><span aria-hidden="true">${esc(r.emoji)}</span> ${bidiText(r.name)}${r.user_id === state.user.id ? " (אני)" : ""}</span><span class="mono" style="color:var(--color-accent);"><bdi>${esc(r.result)}</bdi></span></div>`).join("")}</div>` : `<div class="empty">אין עדיין תוצאות</div>`}</div>`;
    return ownerPick + form + list("Rx", split.rx) + list("Scaled", split.scaled);
  }
  function benchmarkName(id) {
    const w = typeof wodById === "function" ? wodById(id) : null;
    return w && w.name ? w.name : (id ? id.charAt(0).toUpperCase() + id.slice(1) : "");
  }
  function benchmarkDesc(id) {
    const w = typeof wodById === "function" ? wodById(id) : null;
    return w && w.desc ? w.desc : "";
  }
  function benchmarkPrefill(id) {
    try { const best = typeof formatWodBest === "function" ? formatWodBest(id) : "—"; return best && best !== "—" ? best : ""; } catch (e) { return ""; }
  }

  function membersSectionHtml(c) {
    const list = state.circles.members[c.id];
    if (!list) return `<div class="empty" aria-busy="true">טוען…</div>`;
    const owner = circleIsOwner(c);
    return `<div class="log-list">${list.map((m) => `<div class="log-row" data-member="${esc(m.user_id)}"><span style="min-width:0;"><span aria-hidden="true">${esc(m.emoji)}</span> ${bidiText(m.display_name || "חבר/ה")}${m.role === "owner" ? ` <span class="badge-tag">${esc(c.type === "couple" ? "בעלות משותפת" : "בעלות")}</span>` : ""}${m.user_id === state.user.id ? " (אני)" : ""}</span>
        ${owner && m.role !== "owner" && m.user_id !== state.user.id ? `<button class="chip-btn danger" data-community-action="c-remove-ask" data-id="${esc(c.id)}" data-user="${esc(m.user_id)}" data-name="${esc(m.display_name || "")}">הסרה</button>` : ""}</div>`).join("")}</div>`;
  }

  function renderCircleScreen() {
    const gate = renderCircleGate();
    if (gate) return circleScene("community", "מעגל", gate);
    const c = currentCircle();
    if (!c) return circleScene("community", "מעגל", renderFirstCircle());
    const sec = state.circles.section;
    let body;
    if (sec === "week") body = weekSectionHtml(c);
    else if (sec === "benchmark" && c.benchmark_enabled) body = circleBenchmarkSectionHtml(c);
    else if (sec === "members") body = membersSectionHtml(c);
    else body = feedSectionHtml(c);
    const titles = { feed: "הפיד", week: "השבוע", benchmark: "בנצ'מרק החודש", members: "חברים" };
    const shown = sec === "benchmark" && !c.benchmark_enabled ? "feed" : (titles[sec] ? sec : "feed");
    const inner = circleSwitcherHtml(c) + circleHeaderHtml(c) + pendingTagsHtml() + circleSectionTabsHtml(c)
      + `<div role="tabpanel" id="circlePanel" aria-labelledby="circleTab-${shown}"><div class="ach-section">${sectionHead("var(--color-accent)", esc(titles[shown]))}</div>${body}</div>`;
    return circleScene("community", "מעגל", inner);
  }

  // ---- Me ---------------------------------------------------------------------------------
  function shareSettingsHtml() {
    const labels = [
      ["share_workouts", "לשתף אימונים (מה עשיתי)"],
      ["share_prs", "לשתף שיאים"],
      ["share_percent", "לשתף אחוז מהיעד"],
      ["share_weekly_count", "לשתף את מספר האימונים השבועי"],
      ["show_weights", "להראות משקלים מוחלטים"],
    ];
    if (!state.circles.list.length) return "";
    return `<div class="ach-section" id="circleShareSettings" style="margin-top:18px;">${sectionHead("var(--color-accent)", "מה אני משתף")}
      <div style="color:var(--color-text-muted);font-size:12px;line-height:1.6;margin-bottom:8px;">ההגדרה שלכם תמיד קובעת. מה שמוסתר לא נשלח לשרת בכלל. משקל הגוף נשאר במכשיר.</div>
      ${state.circles.list.map((c) => {
        const d = CirclesCore.effectiveDefaults(c);
        return `<div class="chart-card" style="margin-bottom:10px;"><div style="font-weight:800;margin-bottom:6px;"><span aria-hidden="true">${esc(c.emoji)}</span> ${bidiText(c.name)}</div>
          <div class="log-list">${labels.map((l) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;min-height:44px;align-items:center;"><span style="font-size:13px;">${esc(l[1])}</span><input type="checkbox" data-share-setting="${l[0]}" data-circle="${esc(c.id)}"${d[l[0]] ? " checked" : ""} aria-label="${esc(l[1] + " ב" + c.name)}"/></label>`).join("")}</div></div>`;
      }).join("")}
    </div>`;
  }
  function targetAndPauseHtml() {
    if (!state.circles.list.length) return "";
    const mine = state.circles.mine;
    const targetField = (c) => {
      const cur = mine.targets[c.id] || 0;
      const opts = [];
      for (let n = 1; n <= 21; n++) opts.push(`<option value="${n}"${cur === n ? " selected" : ""}>${n}</option>`);
      return `<label class="field"><span class="field-label"><span aria-hidden="true">${esc(c.emoji)}</span> ${bidiText(c.name)}: כמה אימונים בשבוע</span><select class="text-input" data-weekly-target="1" data-circle="${esc(c.id)}" aria-label="${esc("יעד שבועי ב" + c.name)}"><option value=""${cur ? "" : " selected"}>עוד לא נקבע</option>${opts.join("")}</select></label>`;
    };
    const paused = isPausedNow();
    return `<div class="ach-section" id="circleTargetPanel" style="margin-top:18px;">${sectionHead("var(--color-accent)", "יעד שבועי והפסקה")}
      ${state.circles.list.map(targetField).join("")}
      <div class="footer-note" style="margin:6px 0 10px;">כל אימון נספר. כל מעגל רואה כמה אחוז מהיעד שלו עשיתם. שבוע שלא עמדתם בו לא מאפס כלום. ההפסקה אחת לכל המעגלים.</div>
      ${paused
        ? `<div style="font-size:13px;margin-bottom:8px;">${esc("את/ה בהפסקה עד " + shortHebDate(mine.pausedUntil) + ". המעגל רואה \"בהפסקה\".")}</div><button class="chip-btn primary" data-community-action="c-pause" data-days="0">חזרה מהפסקה</button>`
        : `<div class="field-label" style="margin-bottom:4px;">הפסקה (נפגעתי, חופשה)</div><div class="chip-row"><button class="chip-btn" data-community-action="c-pause" data-days="7">שבוע</button><button class="chip-btn" data-community-action="c-pause" data-days="14">שבועיים</button><button class="chip-btn" data-community-action="c-pause" data-days="30">חודש</button></div>`}
    </div>`;
  }
  // Any member can send a friend a link to start a circle of their own.
  const FOUNDER_EXPLAIN_TEXT = "החבר/ה מקבלים קישור, נרשמים ופותחים מעגל משלהם. הם לא מצטרפים למעגלים שלך, ואתם לא רואים שום דבר ממה שהם עושים. הקישור תקף 7 ימים, לשימוש אחד.";
  function founderLinkPanelHtml() {
    return `<div class="ach-section" id="founderLinkPanel" style="margin-top:18px;">${sectionHead("var(--color-accent)", "חבר שרוצה מעגל משלו")}
      <div class="footer-note" style="margin:0 0 10px;">${bidiText(FOUNDER_EXPLAIN_TEXT)}</div>
      <button class="chip-btn" data-community-action="c-founder-open">קישור לחבר שרוצה מעגל משלו</button>
    </div>`;
  }
  function renderMeScreen() {
    const gate = renderCircleGate({ allowNoCircle: true });
    if (gate) return circleScene("me", "אני", gate);
    const p = state.profile || {};
    const marksOn = termMarksSwitchOn();
    const marksRetired = marksOn && !termMarksVisible();
    const termMarkPanel = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--color-text-muted)", "מונחים והסברים")}
      <label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
        <span style="font-size:13px;">סימוני הסבר על מונחים<span style="color:var(--color-text-muted);display:block;font-size:11px;line-height:1.5;">${bidiText(marksRetired ? "העיגול הקטן עם ? ליד מונחים כמו AMRAP. הוא מפסיק להופיע אחרי שפותחים שלושה הסברים, וזה כבר קרה — אפשר להחזיר אותו בכל רגע." : "העיגול הקטן עם ? ליד מונחים כמו AMRAP. הוא נעלם מעצמו אחרי שפותחים שלושה הסברים.")}</span></span>
        <input type="checkbox" data-term-marks="1"${marksOn ? " checked" : ""} aria-label="סימוני הסבר על מונחים"/>
      </label>
      <button class="chip-btn" data-community-action="term-glossary-open" style="margin-top:10px;">כל המונחים</button>
    </div>`;
    const head = `<div class="chart-card" id="communityHead" style="margin-bottom:12px;"><div class="flex" style="justify-content:space-between;align-items:center;gap:10px;"><div style="font-weight:800;font-size:16px;"><span aria-hidden="true">${esc(p.emoji || "🙂")}</span> ${bidiText(p.display_name || "")}</div>${renderNotificationBell()}</div></div>`;
    const profile = profileFormHtml("communityProfile", p, true);
    const inner = head + profile + `<div class="chip-row" style="margin:-4px 0 8px;"><button class="chip-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button></div>`
      + `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--color-accent)", "מראה")}<div class="chart-card">${typeof renderAppearanceSection === "function" ? renderAppearanceSection("me") : ""}</div></div>`
      + targetAndPauseHtml() + shareSettingsHtml() + renderMyAchievements() + renderSharePromptPrefPanel() + renderBlockedMembersPanel() + renderNotifPrefsPanel() + termMarkPanel
      + recoveryPanelHtml()
      + mfaPanelHtml()
      + founderLinkPanelHtml()
      + `<button class="chip-btn" data-action="open-support" style="display:block;margin:20px auto 0;">פנייה</button>`
      + selfExportButtonHtml("display:block;margin:20px auto 0;")
      + `<button class="link-btn link-btn--tap" data-community-action="sign-out" style="display:block;margin:20px auto 0;">התנתקות</button>`
      + `<button class="link-btn link-btn--tap" data-community-action="delete-account" style="display:block;margin:10px auto 8px;color:var(--color-danger);">בקשת מחיקת חשבון</button>`;
    return circleScene("me", "אני", inner);
  }

  window.renderCommunityApp = function () { resetTermMarkBudget(); return renderCircleScreen(); };
  window.renderHomeApp = function () { resetTermMarkBudget(); return renderHomeScreen(); };
  window.renderMeApp = function () { resetTermMarkBudget(); return renderMeScreen(); };
  /** The member's weekly target in a circle, or 0 when none is set. The ring on Home and after a workout reads it. */
  window.communityWeeklyTarget = function () {
    const c = state && state.circles;
    const cur = c && c.mine && c.mine.targets ? currentCircle() : null;
    const t = cur ? c.mine.targets[cur.id] : 0;
    return typeof t === "number" && t > 0 ? t : 0;
  };
