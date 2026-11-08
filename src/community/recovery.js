// @ts-check
"use strict";
// ---- Password recovery without email ------------------------------------------------
//
// Sign-in is a username mapped to a synthetic .invalid address, so Supabase's email
// reset can never reach anyone. A member holds a recovery code instead: four groups of
// four characters, shown once, with only its HMAC stored by the server
// (supabase/functions/issue-recovery-code, recover-password; docs/circles/decisions.md,
// "Home and recovery").
//
// The screens:
//   * login -> "שכחתי סיסמה": username, code, new password twice; then the NEW code,
//     once (the code that was just used is dead);
//   * right after the sign-up upgrade, and from Me ("קוד שחזור חדש", password first):
//     the code, once, with a copy button and a required "שמרתי" checkbox;
//   * Me, for a member who signed up before codes existed: a prompt to make one.
//
// The code lives in state.ui.recovery.code only while it is on screen and is wiped when
// the member continues. It is never written to localStorage and never sent anywhere but
// the screen. Classic <script>, no IIFE, loaded before cloud.js; it reads state, client,
// rerender, field, setFieldErrors, withCaptcha, esc and bidiText from the shared scope,
// from inside function bodies only.

  const RECOVERY_GENERIC_ERROR = "הפרטים לא תואמים, או שהיו יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות.";
  const RECOVERY_ISSUE_ERROR = "לא הצלחנו ליצור קוד שחזור. בדקו את החיבור ונסו שוב.";
  const RECOVERY_CODE_RE = /^[2-9A-HJ-NP-Z]{16}$/;

  /** Upper case, only the characters a code can contain (dashes, spaces and case do not matter). */
  function normalizeRecoveryCode(input) { return String(input == null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, ""); }

  function recoveryUi() { return state.ui.recovery; }
  function recoveryClear() {
    const r = recoveryUi();
    r.view = ""; r.busy = false; r.error = ""; r.code = ""; r.saved = false; r.copied = false; r.source = "";
    r.rotateOpen = false;
  }
  /** True while a code is waiting to be saved, or being made: the gate shows nothing else. */
  function recoveryShowing() { return recoveryUi().view === "show"; }

  /** The sign-in name behind this session: its auth email (the synthetic address for ordinary members). */
  function recoverySignInEmail() { return state.user && state.user.email ? String(state.user.email) : ""; }

  async function recoveryCallIssue() {
    if (!client) return { ok: false };
    try {
      const { data, error } = await client.functions.invoke("issue-recovery-code", { body: {} });
      if (error || !data || typeof data.recovery_code !== "string") return { ok: false };
      return { ok: true, code: data.recovery_code };
    } catch (e) { return { ok: false }; }
  }

  /** Make (or rotate) the signed-in member's code and show it. source: signup | rotate | existing. */
  async function recoveryIssueAndShow(source) {
    const r = recoveryUi();
    r.view = "show"; r.busy = true; r.error = ""; r.code = ""; r.saved = false; r.copied = false; r.source = source;
    rerender();
    const out = await recoveryCallIssue();
    if (recoveryUi().view !== "show") return;
    r.busy = false;
    if (out.ok) { r.code = out.code; r.has = true; } else r.error = RECOVERY_ISSUE_ERROR;
    rerender();
  }

  async function loadRecoveryStatus() {
    const r = recoveryUi();
    if (r.statusTried || !client || !state.user || state.user.is_anonymous) return;
    r.statusTried = true;
    const { data, error } = await client.rpc("my_recovery_code_created_at");
    if (error) { r.statusTried = false; return; }
    r.has = !!data;
    rerender();
  }

  // The "forgot password" form on the login screen.
  async function recoverPassword(form) {
    const r = recoveryUi();
    if (r.busy) return;
    const username = String(form.elements.username.value || "").trim().toLowerCase();
    const code = normalizeRecoveryCode(form.elements.code.value);
    const password = String(form.elements.password.value || "");
    const confirm = String(form.elements.passwordConfirm.value || "");
    const errors = {};
    const userErr = usernameRuleError(username);
    if (userErr) errors.username = userErr;
    if (!RECOVERY_CODE_RE.test(code)) errors.code = "הקוד הוא 16 תווים: אותיות באנגלית וספרות, בארבע קבוצות.";
    const passErr = passwordRuleError(password);
    if (passErr) errors.password = passErr;
    if (!errors.password && password !== confirm) errors.passwordConfirm = "הסיסמאות לא תואמות";
    if (Object.keys(errors).length) return setFieldErrors("communityRecover", errors);
    r.draftUsername = username;
    r.busy = true; r.error = "";
    setFieldErrors("communityRecover", {});
    let data = null;
    try {
      const res = await client.functions.invoke("recover-password", { body: { username, recovery_code: code, new_password: password } });
      data = res.error ? null : res.data;
    } catch (e) { data = null; }
    r.busy = false;
    if (!data || !data.ok || typeof data.recovery_code !== "string") { r.error = RECOVERY_GENERIC_ERROR; return rerender(); }
    // Every session of that account was ended by the server; this device is signed out too.
    r.view = "show"; r.source = "recover"; r.code = data.recovery_code; r.saved = false; r.copied = false; r.error = "";
    r.has = true;
    rerender();
  }

  // Me: the password is asked for again before a code is made or replaced.
  async function rotateRecoveryCode(form) {
    const r = recoveryUi();
    if (r.busy) return;
    const password = String(form.elements.password.value || "");
    const email = recoverySignInEmail();
    if (!password) return setFieldErrors("communityRecoveryRotate", { password: "יש להזין סיסמה" });
    if (!email) return setFieldErrors("communityRecoveryRotate", { password: "אי אפשר לאמת את הסיסמה כרגע" });
    r.busy = true;
    const { error } = await withCaptcha((captchaToken) =>
      client.auth.signInWithPassword(Object.assign({ email, password }, captchaToken ? { options: { captchaToken } } : {})));
    r.busy = false;
    if (error) return setFieldErrors("communityRecoveryRotate", { password: error.message === "captcha_failed" ? "אימות האבטחה נכשל, נסו שוב" : "הסיסמה שגויה" });
    setFieldErrors("communityRecoveryRotate", {});
    r.rotateOpen = false;
    await recoveryIssueAndShow(r.has ? "rotate" : "existing");
  }

  async function copyRecoveryCode() {
    const r = recoveryUi();
    if (!r.code) return;
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(r.code); ok = true; } } catch (e) { ok = false; }
    r.copied = ok;
    if (!ok) r.error = "ההעתקה לא הצליחה. אפשר לסמן את הקוד ולהעתיק אותו ידנית.";
    else r.error = "";
    rerender();
  }

  /** The member has saved the code (the checkbox) and continues. */
  function recoveryContinue() {
    const r = recoveryUi();
    if (r.code && !r.saved) return;
    const source = r.source;
    recoveryClear();
    if (source === "recover") state.ui.gateView = "login";
    rerender();
  }

  function recoveryAction(action, el) {
    const r = recoveryUi();
    switch (action) {
      case "recovery-open": r.view = "form"; r.error = ""; state.ui.fieldErrors = {}; rerender(); return true;
      case "recovery-close": recoveryClear(); state.ui.gateView = "login"; rerender(); return true;
      case "recovery-copy": copyRecoveryCode(); return true;
      case "recovery-continue": recoveryContinue(); return true;
      case "recovery-retry": recoveryIssueAndShow(r.source || "existing"); return true;
      case "recovery-skip": recoveryClear(); rerender(); return true;
      case "recovery-rotate-open": r.rotateOpen = true; rerender(); return true;
      case "recovery-rotate-cancel": r.rotateOpen = false; setFieldErrors("communityRecoveryRotate", {}); return true;
      default: return false;
    }
  }

  // ---- Screens ----------------------------------------------------------------------------
  function recoveryFormHtml() {
    const r = recoveryUi();
    return gateCard(`<button class="gate-back" data-community-action="recovery-close">‹ חזרה</button>
      <div style="font-weight:800;font-size:20px;margin:6px 0 8px;">איפוס סיסמה</div>
      <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("מקלידים את שם הכניסה, את קוד השחזור ששמרתם ואת הסיסמה החדשה. אחרי האיפוס מקבלים קוד שחזור חדש, והקוד הישן מפסיק לעבוד.")}</div>
      ${r.error ? `<div class="field-error" role="alert" data-recovery-error="1" style="margin-bottom:10px;">${esc(r.error)}</div>` : ""}
      <form id="communityRecover">${field("communityRecover", "username", LOGIN_NAME_LABEL, `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="${esc(LOGIN_NAME_LABEL)}" value="${esc(r.draftUsername || "")}" required/>`)}${field("communityRecover", "code", "קוד שחזור", `<input class="text-input mono" name="code" dir="ltr" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="24" placeholder="XXXX-XXXX-XXXX-XXXX" required/>`)}${field("communityRecover", "password", "סיסמה חדשה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="${esc(PASSWORD_RULE_TEXT)}" required/>`)}${field("communityRecover", "passwordConfirm", "אימות הסיסמה החדשה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" required/>`)}<button class="save-btn" type="submit"${r.busy ? " disabled" : ""} style="margin-top:12px;">${r.busy ? "מאפסים…" : "איפוס הסיסמה"}</button></form>`);
  }

  // The code, once. Shown after sign-up, after a recovery, and after a new code is asked for in Me.
  function recoveryShowHtml() {
    const r = recoveryUi();
    const title = r.source === "recover" ? "הסיסמה אופסה. זה קוד השחזור החדש שלך" : r.source === "mfa" ? "האימות הדו-שלבי כובה. זה קוד השחזור החדש שלך" : "קוד השחזור שלך";
    if (r.busy) return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">יוצרים קוד שחזור…</div><div style="color:var(--color-text-muted);font-size:13px;">שנייה אחת.</div>`);
    if (!r.code) {
      return gateCard(`<div style="font-weight:800;font-size:18px;margin-bottom:6px;">${esc(title)}</div>
        <div class="field-error" role="alert" data-recovery-error="1" style="margin:8px 0 14px;">${esc(r.error || RECOVERY_ISSUE_ERROR)}</div>
        <button class="save-btn" data-community-action="recovery-retry">ניסיון חוזר</button>
        <div style="display:flex;justify-content:center;margin-top:12px;"><button class="gate-alt" data-community-action="recovery-skip">להמשיך בלי קוד (אפשר ליצור ב"אני")</button></div>`);
    }
    return gateCard(`<div style="font-weight:800;font-size:20px;margin-bottom:8px;">${esc(title)}</div>
      <div style="color:var(--color-text-muted);font-size:14px;line-height:1.7;margin-bottom:14px;">${bidiText("אין אימייל לאפס איתו סיסמה, אז הקוד הזה הוא הדרך היחידה לחזור לחשבון אם תשכחו אותה. הוא מוצג פעם אחת בלבד. שמרו אותו במקום שאתם סומכים עליו: מנהל סיסמאות, או הודעה לעצמכם.")}</div>
      <div data-recovery-code="1" dir="ltr" class="mono" style="font-size:24px;font-weight:800;letter-spacing:.06em;text-align:center;padding:16px 8px;border:1px solid var(--color-border-strong);border-radius:14px;background:var(--color-surface-sunken);user-select:all;word-break:break-all;">${esc(r.code)}</div>
      <div style="display:flex;justify-content:center;margin:12px 0;"><button class="chip-btn" data-community-action="recovery-copy">${r.copied ? "הועתק" : "העתקת הקוד"}</button></div>
      ${r.error ? `<div class="field-error" role="alert" style="margin-bottom:10px;">${esc(r.error)}</div>` : ""}
      <label class="log-row" style="gap:12px;cursor:pointer;justify-content:flex-start;"><input type="checkbox" data-recovery-saved="1"${r.saved ? " checked" : ""}/><span style="font-weight:700;">שמרתי</span><span style="color:var(--color-text-muted);font-size:12.5px;">את הקוד במקום בטוח</span></label>
      <button class="save-btn" data-community-action="recovery-continue"${r.saved ? "" : " disabled"} style="margin-top:12px;">${r.source === "recover" ? "להתחברות" : "המשך"}</button>`);
  }

  // Me: whether there is a code, and the way to make a new one.
  function recoveryPanelHtml() {
    const r = recoveryUi();
    if (!state.user || state.user.is_anonymous) return "";
    // The status is asked for as soon as the session is up (afterRenderCommunity), not when
    // Me opens, so opening Me never repaints under a tap.
    if (r.has == null) return "";
    const rotate = r.rotateOpen
      ? `<form id="communityRecoveryRotate" style="margin-top:10px;">${field("communityRecoveryRotate", "password", "הסיסמה שלכם, לאישור", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="current-password" placeholder="סיסמה" required/>`)}<div class="chip-row" style="margin-top:8px;"><button class="chip-btn primary" type="submit"${r.busy ? " disabled" : ""}>${r.has ? "יצירת קוד חדש" : "יצירת קוד שחזור"}</button><button class="chip-btn" type="button" data-community-action="recovery-rotate-cancel">ביטול</button></div></form>`
      : `<button class="chip-btn${r.has ? "" : " primary"}" data-community-action="recovery-rotate-open" style="margin-top:8px;">${r.has ? "קוד שחזור חדש" : "יצירת קוד שחזור"}</button>`;
    return `<div class="ach-section" id="recoveryPanel" data-recovery-has="${r.has ? "1" : "0"}" style="margin-top:18px;">${sectionHead("var(--color-accent)", "קוד שחזור")}
      <div class="chart-card" ${r.has ? "" : `style="border-color:var(--color-accent);"`}>
        <div style="font-size:13.5px;line-height:1.7;">${bidiText(r.has ? "יש לך קוד שחזור. הוא מאפס את הסיסמה אם תשכחו אותה. קוד חדש מבטל את הקודם, ומוצג פעם אחת." : "עוד אין לך קוד שחזור. בלעדיו אי אפשר לאפס סיסמה שנשכחה, כי אין אימייל. יוצרים קוד, שומרים אותו, וזהו.")}</div>
        ${rotate}
      </div></div>`;
  }

  document.addEventListener("submit", (event) => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (!form || !form.id) return;
    if (form.id === "communityRecover") { event.preventDefault(); recoverPassword(form); }
    else if (form.id === "communityRecoveryRotate") { event.preventDefault(); rotateRecoveryCode(form); }
  });
  document.addEventListener("change", (event) => {
    const t = /** @type {HTMLInputElement} */ (event.target);
    if (t && t.dataset && "recoverySaved" in t.dataset) { recoveryUi().saved = !!t.checked; rerender(); }
  });
