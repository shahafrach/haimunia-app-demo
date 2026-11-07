// @ts-check
"use strict";
// ---- Two-step login with an authenticator app (TOTP) ---------------------------------
//
// Optional, per member, switched on in Me. The sign-in stays a username and a password;
// a member with the second step gets a password-only (aal1) session first, and the
// database refuses everything until the code is proven (migration 202611070002:
// public.aal_satisfied(), the aal2_required policies, is_community_member()). This file
// is the screens and the calls; it is not what protects the data.
//
//   * Me > "אבטחת חשבון": turn it on (QR code and typed key, then one code to confirm),
//     turn it off (the current code again), and sign out of every device;
//   * login: after the password, a gate asks for the 6-digit code;
//   * a lost phone: the recovery code the member already keeps removes the second step
//     (Edge Function mfa-recovery) and a NEW recovery code is shown once.
//
// Nothing here stores a secret: the key lives in state.ui.mfa.enroll only while the
// enrolment screen is open. Anonymous sessions have no second step (nothing to protect).
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, client, rerender,
// field, setFieldErrors, gateCard, esc, bidiText, brandName, recoveryIssueAndShow,
// removeDevicePushSubscription from the shared scope, from inside function bodies only.

  const MFA_CODE_RE = /^[0-9]{6}$/;
  const MFA_BAD_CODE = "הקוד לא נכון או שפג תוקפו. נסו את הקוד הנוכחי באפליקציה.";
  const MFA_FAILED = "הפעולה לא הצליחה. בדקו את החיבור ונסו שוב.";

  function mfaUi() { return state.ui.mfa; }
  function mfaResetUi() {
    const m = mfaUi();
    m.challenge = false; m.recover = false; m.busy = false; m.error = ""; m.enroll = null;
    m.has = null; m.statusTried = false; m.disableOpen = false; m.signOutAllOpen = false;
  }
  /** The gate: a password-only session of a member with the second step shows nothing else. */
  function mfaChallengeShowing() { return !!state.user && !state.user.is_anonymous && mfaUi().challenge; }

  /** True when this session passed the password but still owes the code. Fails open only on "no factor". */
  async function mfaCheck() {
    const m = mfaUi();
    if (!client || !state.user || state.user.is_anonymous) { m.challenge = false; return false; }
    try {
      const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error || !data) { m.challenge = false; return false; }
      m.has = data.nextLevel === "aal2";
      m.challenge = data.nextLevel === "aal2" && data.currentLevel !== "aal2";
    } catch (e) { m.challenge = false; }
    return m.challenge;
  }

  async function mfaVerifiedFactorId() {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    return data && data.totp && data.totp[0] ? data.totp[0].id : null;
  }

  async function loadMfaStatus() {
    const m = mfaUi();
    if (m.statusTried || !client || !state.user || state.user.is_anonymous || m.challenge) return;
    m.statusTried = true;
    try { m.has = (await mfaVerifiedFactorId()) !== null; } catch (e) { m.statusTried = false; return; }
    rerender();
  }

  // Login: the 6-digit code.
  async function mfaSubmitChallenge(form) {
    const m = mfaUi();
    if (m.busy) return;
    const code = String(form.elements.code.value || "").replace(/\s/g, "");
    if (!MFA_CODE_RE.test(code)) return setFieldErrors("communityMfaChallenge", { code: "הקוד הוא 6 ספרות" });
    m.busy = true;
    let ok = false;
    try {
      const id = await mfaVerifiedFactorId();
      if (id) { const r = await client.auth.mfa.challengeAndVerify({ factorId: id, code }); ok = !r.error; }
    } catch (e) { ok = false; }
    m.busy = false;
    if (!ok) return setFieldErrors("communityMfaChallenge", { code: navigator.onLine === false ? "אין חיבור. נסו שוב כשיש רשת." : MFA_BAD_CODE });
    m.challenge = false;
    // supabase-js announces MFA_CHALLENGE_VERIFIED; the auth handler in cloud.js loads the account.
    setFieldErrors("communityMfaChallenge", {});
  }

  // Login: a lost phone. The recovery code removes the second step and is replaced.
  async function mfaSubmitRecover(form) {
    const m = mfaUi();
    if (m.busy) return;
    const code = normalizeRecoveryCode(form.elements.code.value);
    if (!RECOVERY_CODE_RE.test(code)) return setFieldErrors("communityMfaRecover", { code: "הקוד הוא 16 תווים: אותיות באנגלית וספרות, בארבע קבוצות." });
    m.busy = true; m.error = "";
    let data = null;
    try {
      const res = await client.functions.invoke("mfa-recovery", { body: { recovery_code: code } });
      data = res.error ? null : res.data;
    } catch (e) { data = null; }
    m.busy = false;
    if (!data || !data.ok || typeof data.recovery_code !== "string") {
      return setFieldErrors("communityMfaRecover", { code: "הקוד לא תואם, או שהיו יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות." });
    }
    m.challenge = false; m.recover = false; m.has = false; m.statusTried = false;
    const r = state.ui.recovery;
    r.view = "show"; r.source = "mfa"; r.code = data.recovery_code; r.saved = false; r.copied = false; r.error = ""; r.has = true;
    // The server removed the factors; a fresh token no longer asks for the second step.
    await client.auth.refreshSession().catch(() => undefined); // if it fails, the next load asks again
    rerender();
  }

  // Me: turn it on.
  async function mfaBeginEnroll() {
    const m = mfaUi();
    if (m.busy) return;
    m.busy = true; m.error = ""; rerender();
    try {
      const all = await client.auth.mfa.listFactors();
      for (const f of (all.data && all.data.all) || []) {
        if (f.status === "unverified") await client.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: brandName() });
      if (error || !data) throw error || new Error("enroll");
      m.enroll = { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    } catch (e) { m.error = MFA_FAILED; }
    m.busy = false;
    rerender();
  }
  function mfaCancelEnroll() {
    const m = mfaUi();
    if (m.enroll) client.auth.mfa.unenroll({ factorId: m.enroll.factorId }).catch(() => undefined);
    m.enroll = null; m.error = ""; setFieldErrors("communityMfaEnroll", {});
  }
  async function mfaSubmitEnroll(form) {
    const m = mfaUi();
    if (m.busy || !m.enroll) return;
    const code = String(form.elements.code.value || "").replace(/\s/g, "");
    if (!MFA_CODE_RE.test(code)) return setFieldErrors("communityMfaEnroll", { code: "הקוד הוא 6 ספרות" });
    m.busy = true;
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: m.enroll.factorId, code });
    m.busy = false;
    if (error) return setFieldErrors("communityMfaEnroll", { code: MFA_BAD_CODE });
    m.enroll = null; m.has = true; m.error = "";
    setFieldErrors("communityMfaEnroll", {});
    // The way back from a lost phone is the recovery code: a member with none makes one now.
    if (!state.ui.recovery.has) recoveryIssueAndShow("existing");
  }

  // Me: turn it off. The current code is asked for again.
  async function mfaSubmitDisable(form) {
    const m = mfaUi();
    if (m.busy) return;
    const code = String(form.elements.code.value || "").replace(/\s/g, "");
    if (!MFA_CODE_RE.test(code)) return setFieldErrors("communityMfaDisable", { code: "הקוד הוא 6 ספרות" });
    m.busy = true;
    let ok = false;
    try {
      const id = await mfaVerifiedFactorId();
      if (id) {
        const v = await client.auth.mfa.challengeAndVerify({ factorId: id, code });
        ok = !v.error && !(await client.auth.mfa.unenroll({ factorId: id })).error;
      }
    } catch (e) { ok = false; }
    m.busy = false;
    if (!ok) return setFieldErrors("communityMfaDisable", { code: MFA_BAD_CODE });
    m.has = false; m.disableOpen = false;
    setFieldErrors("communityMfaDisable", {});
  }

  // Me: end every session of this account, on every device (this one too).
  async function mfaSignOutAll() {
    const m = mfaUi();
    if (m.busy) return;
    m.busy = true; m.error = ""; rerender();
    try {
      if (typeof removeDevicePushSubscription === "function") await removeDevicePushSubscription({ everyDevice: true });
      const { error } = await client.auth.signOut({ scope: "global" });
      if (error) throw error;
    } catch (e) { m.error = MFA_FAILED; }
    m.busy = false; m.signOutAllOpen = false;
    rerender();
  }

  function mfaAction(action) {
    const m = mfaUi();
    switch (action) {
      case "mfa-enroll-start": mfaBeginEnroll(); return true;
      case "mfa-enroll-cancel": mfaCancelEnroll(); return true;
      case "mfa-disable-open": m.disableOpen = true; rerender(); return true;
      case "mfa-disable-cancel": m.disableOpen = false; setFieldErrors("communityMfaDisable", {}); return true;
      case "mfa-recover-open": m.recover = true; setFieldErrors("communityMfaRecover", {}); return true;
      case "mfa-recover-close": m.recover = false; setFieldErrors("communityMfaChallenge", {}); return true;
      case "mfa-cancel-login": client.auth.signOut(); return true;
      case "mfa-signout-all-open": m.signOutAllOpen = true; rerender(); return true;
      case "mfa-signout-all-cancel": m.signOutAllOpen = false; rerender(); return true;
      case "mfa-signout-all": mfaSignOutAll(); return true;
      default: return false;
    }
  }

  // ---- Screens ----------------------------------------------------------------------------
  const MFA_CODE_INPUT = `<input class="text-input" name="code" dir="ltr" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="123456" required/>`;

  function mfaChallengeHtml() {
    const m = mfaUi();
    if (m.recover) {
      return gateCard(`<button class="gate-back" data-community-action="mfa-recover-close">‹ חזרה</button>
        <div style="font-weight:800;font-size:20px;margin:6px 0 8px;">אין גישה לאפליקציית האימות</div>
        <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("מקלידים את קוד השחזור ששמרתם. האימות הדו-שלבי יכבה, ותקבלו קוד שחזור חדש. אחר כך אפשר להפעיל אימות דו-שלבי מחדש ב״אני״.")}</div>
        <form id="communityMfaRecover">${field("communityMfaRecover", "code", "קוד שחזור", `<input class="text-input" name="code" dir="ltr" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" required/>`)}
        <button class="save-btn" type="submit"${m.busy ? " disabled" : ""}>${m.busy ? "בודקים…" : "כיבוי האימות הדו-שלבי"}</button></form>`);
    }
    return gateCard(`<div style="font-weight:800;font-size:20px;margin-bottom:8px;">אימות דו-שלבי</div>
      <div style="color:var(--color-text-muted);font-size:14px;line-height:1.6;margin-bottom:14px;">${bidiText("פותחים את אפליקציית האימות ומקלידים את הקוד בן 6 הספרות של " + brandName() + ".")}</div>
      <form id="communityMfaChallenge">${field("communityMfaChallenge", "code", "קוד מהאפליקציה", MFA_CODE_INPUT)}
      <button class="save-btn" type="submit"${m.busy ? " disabled" : ""}>${m.busy ? "בודקים…" : "אישור"}</button></form>
      <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;margin-top:14px;">
        <button class="gate-alt" data-community-action="mfa-recover-open">אין לי גישה לאפליקציה</button>
        <button class="gate-alt" data-community-action="mfa-cancel-login">חזרה להתחברות</button>
      </div>`);
  }

  // Me: one panel for the second step and for ending every session.
  function mfaPanelHtml() {
    const m = mfaUi();
    if (!state.user || state.user.is_anonymous) return "";
    if (m.has == null) return "";
    let body;
    if (m.enroll) {
      body = `<div style="font-size:13.5px;line-height:1.7;">${bidiText("1. פותחים אפליקציית אימות (Google Authenticator, Microsoft Authenticator, Authy…) וסורקים את הקוד. אם אי אפשר לסרוק, מקלידים את המפתח.")}</div>
        <div style="display:flex;justify-content:center;margin:12px 0;"><img src="${esc(m.enroll.qr)}" alt="קוד QR לאפליקציית האימות" width="176" height="176" style="border-radius:12px;"/></div>
        <div style="font-size:12px;color:var(--color-text-muted);">מפתח להקלדה</div>
        <code dir="ltr" data-mfa-secret="1" class="mono" style="display:block;word-break:break-all;margin:4px 0 12px;user-select:all;">${esc(m.enroll.secret)}</code>
        <div style="font-size:13.5px;line-height:1.7;margin-bottom:6px;">${bidiText("2. מקלידים את הקוד שהאפליקציה מציגה כדי לאשר.")}</div>
        <form id="communityMfaEnroll">${field("communityMfaEnroll", "code", "קוד מהאפליקציה", MFA_CODE_INPUT)}
        <div style="display:flex;gap:10px;flex-wrap:wrap;"><button class="save-btn" type="submit"${m.busy ? " disabled" : ""}>${m.busy ? "בודקים…" : "הפעלה"}</button>
        <button class="chip-btn" type="button" data-community-action="mfa-enroll-cancel">ביטול</button></div></form>`;
    } else if (m.has && m.disableOpen) {
      body = `<form id="communityMfaDisable">${field("communityMfaDisable", "code", "הקוד הנוכחי מהאפליקציה, לאישור הכיבוי", MFA_CODE_INPUT)}
        <div style="display:flex;gap:10px;flex-wrap:wrap;"><button class="save-btn" type="submit"${m.busy ? " disabled" : ""}>כיבוי</button>
        <button class="chip-btn" type="button" data-community-action="mfa-disable-cancel">ביטול</button></div></form>`;
    } else if (m.has) {
      body = `<div style="font-size:13.5px;line-height:1.7;">${bidiText("האימות הדו-שלבי פעיל. בכל כניסה צריך סיסמה וגם קוד מהאפליקציה.")}</div>
        <button class="chip-btn" data-community-action="mfa-disable-open" style="margin-top:8px;">כיבוי אימות דו-שלבי</button>`;
    } else {
      body = `<div style="font-size:13.5px;line-height:1.7;">${bidiText("שכבת הגנה נוספת לחשבון: אחרי הסיסמה מקלידים קוד מאפליקציית אימות בטלפון. אופציונלי.")}</div>
        <button class="chip-btn primary" data-community-action="mfa-enroll-start"${m.busy ? " disabled" : ""} style="margin-top:8px;">הפעלת אימות דו-שלבי</button>`;
    }
    const signOutAll = m.signOutAllOpen
      ? `<div style="margin-top:14px;font-size:13.5px;line-height:1.7;">${bidiText("יוצאים מהחשבון בכל המכשירים, כולל זה. בכניסה הבאה צריך שם כניסה וסיסמה.")}</div>
         <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;"><button class="save-btn" data-community-action="mfa-signout-all"${m.busy ? " disabled" : ""}>יציאה מכל המכשירים</button>
         <button class="chip-btn" data-community-action="mfa-signout-all-cancel">ביטול</button></div>`
      : `<button class="chip-btn" data-community-action="mfa-signout-all-open" style="margin-top:14px;">יציאה מכל המכשירים</button>`;
    return `<div class="ach-section" id="mfaPanel" data-mfa-has="${m.has ? "1" : "0"}" style="margin-top:18px;">${sectionHead("var(--color-accent)", "אבטחת חשבון")}
      <div class="chart-card">${body}
      ${m.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(m.error)}</div>` : ""}
      ${m.enroll ? "" : signOutAll}</div></div>`;
  }

  document.addEventListener("submit", (event) => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (!form || !form.id) return;
    if (form.id === "communityMfaChallenge") { event.preventDefault(); mfaSubmitChallenge(form); }
    else if (form.id === "communityMfaRecover") { event.preventDefault(); mfaSubmitRecover(form); }
    else if (form.id === "communityMfaEnroll") { event.preventDefault(); mfaSubmitEnroll(form); }
    else if (form.id === "communityMfaDisable") { event.preventDefault(); mfaSubmitDisable(form); }
  });

  // The screens and actions, for the jsdom tests (the app reaches them by name inside the shared scope).
  window.haimuniaMfa = {
    ui: mfaUi, panel: mfaPanelHtml, check: mfaCheck, beginEnroll: mfaBeginEnroll,
    submitEnroll: mfaSubmitEnroll, submitDisable: mfaSubmitDisable, signOutAll: mfaSignOutAll,
  };
