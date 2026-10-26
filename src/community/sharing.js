// @ts-check
"use strict";
// ---- Sharing pipeline: cards, the in-app browser screen, Add to Home Screen --
//
// The side of sharing that has a screen and a tap. What goes ON a card, and when
// an offer is due, is decided in sharing-core.js (pure, tested without a
// browser); the drawing is src/share-cards.js (window.boxlogShareCards). This
// file is the glue between them and the circles screens:
//
//   * PR card      - built when the PR prompt opens, so the File exists before
//                    the tap and navigator.share() runs inside the user gesture
//                    (iOS drops the activation across an await).
//   * Week card    - built when circle_week loads; the button on the week view
//                    shares it. The first open on a Sunday (Asia/Jerusalem)
//                    offers last week's card once, from the snapshot of that
//                    week this device saved (circle_week answers only for the
//                    current week).
//   * In-app browser - an invite opened inside WhatsApp, Instagram or Facebook
//                    shows Hebrew steps to open it in Safari or Chrome. The
//                    token stays in the URL fragment (the URL is left alone) so
//                    it survives the switch; nothing is stored, the WebView
//                    forgets it.
//   * Install steps - once, after the member's first circle: the native prompt
//                    on Android, short illustrated steps on iOS Safari. Any way
//                    of closing it counts as "no", and no is permanent.
//
// Nothing here writes to the server; a card is a File that lives in this tab.
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, esc, track,
// rerender and the circles helpers from the shared scope, from inside function
// bodies only.

  // ---- The two share glyphs, one definition each ---------------------------------
  // Stroke icons on currentColor, so they take their button's colour in both
  // themes. `club` shares into the circles, `outward` out of the app.
  const SHARE_ICONS = {
    club: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/></svg>',
    outward: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v11"/><path d="M8.5 6.5 12 3l3.5 3.5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  };

  const SHARING_INSTALL_DONE_KEY = "haimunia-demo:circleInstallDone";
  const SHARING_WEEK_OFFERED_KEY = "haimunia-demo:weekCardOffered";
  const SHARING_SNAPSHOTS_KEY = "haimunia-demo:weekSnapshots";

  /**
   * Module state: Files and a held token, dropped by sharingReset() on sign-out.
   * The open sheet itself is state.circles.sharingSheet, so the dialog registry
   * in cloud.js can read it like every other dialog.
   * @type {{pr: any, week: Record<string, any>, inApp: any}}
   */
  const sharingState = { pr: null, week: {}, inApp: null };

  function sharingGet(/** @type {string} */ key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function sharingSet(/** @type {string} */ key, /** @type {string} */ value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode: this session only */ } }
  function sharingCards() { return /** @type {any} */ (window).boxlogShareCards || null; }
  function sharingToday() { return window.CirclesCore.jerusalemDay(new Date()); }

  function sharingReset() {
    if (sharingInstallWait) { clearInterval(sharingInstallWait); sharingInstallWait = null; }
    sharingState.pr = null;
    sharingState.week = {};
    state.circles.sharingSheet = null;
  }

  // ---- Sharing a finished card ------------------------------------------------------
  const SHARING_RESULT_TEXT = Object.freeze({
    shared: "התמונה נשלחה לאפליקציה שבחרתם.",
    cancelled: "השיתוף בוטל. שום דבר לא יצא מהמכשיר.",
    downloaded: "התמונה נשמרה במכשיר, אפשר לצרף אותה ידנית.",
    failed: "לא הצלחנו לשתף את התמונה במכשיר הזה.",
  });
  /**
   * The File is already built, so the first thing shareCard does is call
   * navigator.share(): still inside the tap that got us here.
   * @param {"pr"|"week"} kind @param {File} file
   */
  async function sharingShareFile(kind, file) {
    const cards = sharingCards();
    if (!cards || !file) return "failed";
    const result = await cards.shareCard(file);
    track(A.OUTWARD_SHARE_COMPLETED, { kind: kind, result: result });
    const text = SHARING_RESULT_TEXT[/** @type {keyof typeof SHARING_RESULT_TEXT} */ (result)] || SHARING_RESULT_TEXT.failed;
    setMessage(text);
    if (typeof window.showToast === "function") window.showToast(text);
    return result;
  }

  // ---- PR card -----------------------------------------------------------------------
  /** @param {any} record the PR_CREATED record the prompt was opened for */
  async function sharingPreparePrCard(record) {
    const slot = { recordId: String(record && record.record_id), status: "preparing", file: /** @type {File|null} */ (null) };
    sharingState.pr = slot;
    try {
      const cards = sharingCards();
      if (!cards) throw new Error("no_cards");
      await cards.ensureFonts();
      const data = window.SharingCore.prCardData(record, { profile: state.profile, circles: state.circles.list, today: sharingToday() });
      slot.file = await cards.canvasToFile(cards.renderPrCard(data));
      slot.status = "ready";
    } catch (e) {
      slot.status = "failed";
    }
    if (sharingState.pr === slot) rerender();
  }
  /** The button inside the PR prompt: absent when the card cannot be drawn. */
  function sharingPrCardButtonHtml() {
    const p = sharingState.pr;
    if (!p || p.status === "failed") return "";
    if (p.status !== "ready") return `<button class="chip-btn" type="button" disabled aria-busy="true" data-pr-card="preparing">מכינים תמונה…</button>`;
    return `<button class="chip-btn" type="button" data-community-action="sh-pr-card" data-pr-card="ready">${SHARE_ICONS.outward} שיתוף כתמונה</button>`;
  }
  function sharingSharePrCard() {
    const p = sharingState.pr;
    if (!p || !p.file) return Promise.resolve("failed");
    return sharingShareFile("pr", p.file);
  }

  // ---- Week card ---------------------------------------------------------------------
  function sharingReadSnapshots() {
    try {
      const v = JSON.parse(sharingGet(SHARING_SNAPSHOTS_KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (e) { return {}; }
  }
  /** The weeks a card draws for a circle, newest first, from the saved snapshots. @param {any} circle @param {string} newest */
  function sharingWeeksFromSnapshots(circle, newest) {
    const snaps = sharingReadSnapshots()[circle.id] || {};
    const out = [];
    for (let i = 0; i < 2; i++) {
      const ws = window.SharingCore.addDays(newest, -7 * i);
      if (snaps[ws]) out.push({ weekStart: ws, rows: snaps[ws] });
    }
    return out;
  }
  /** Draw a week card into a File; resolves null when there is nothing to draw. @param {any} circle @param {{weekStart: string, rows: any[]}[]} weeks */
  async function sharingBuildWeekFile(circle, weeks) {
    const cards = sharingCards();
    if (!cards) throw new Error("no_cards");
    const data = window.SharingCore.weekCardData(circle, weeks);
    if (!window.SharingCore.weekCardHasContent(data)) return null;
    await cards.ensureFonts();
    return cards.canvasToFile(cards.renderWeekCard(data));
  }
  /** Called when circle_week loads: save the snapshot, then build this week's card before the tap. @param {string} clubId */
  async function sharingAfterWeekLoaded(clubId) {
    const circle = circleById(clubId);
    const w = state.circles.week[clubId];
    if (!circle || !w || !w.loaded) return;
    const weekStart = window.CirclesCore.weekStartOf(sharingToday());
    const snaps = window.SharingCore.recordSnapshot(sharingReadSnapshots(), clubId, weekStart, w.rows);
    sharingSet(SHARING_SNAPSHOTS_KEY, JSON.stringify(snaps));
    const slot = { status: "preparing", file: /** @type {File|null} */ (null) };
    sharingState.week[clubId] = slot;
    try {
      // The live rows for this week; a couple also shows the week before.
      const weeks = [{ weekStart: weekStart, rows: w.rows }];
      const prev = sharingWeeksFromSnapshots(circle, window.SharingCore.addDays(weekStart, -7))[0];
      if (prev && circle.type === "couple") weeks.push(prev);
      slot.file = await sharingBuildWeekFile(circle, weeks);
      slot.status = slot.file ? "ready" : "empty";
    } catch (e) {
      slot.status = "failed";
    }
    if (sharingState.week[clubId] === slot) rerender();
  }
  /** The button on the circle's week view. @param {any} circle */
  function sharingWeekButtonHtml(circle) {
    const slot = sharingState.week[circle.id];
    if (!slot || slot.status === "failed" || slot.status === "empty") return "";
    const note = `<div class="footer-note" style="margin-top:6px;">בתמונה מופיעים שמות החברים והאחוז של כל אחד מהיעד שלו. בלי דירוג ובלי משקלים.</div>`;
    if (slot.status !== "ready") return `<div style="margin-top:12px;"><button class="chip-btn" type="button" disabled aria-busy="true" data-week-card="preparing">מכינים תמונה…</button></div>`;
    return `<div style="margin-top:12px;"><button class="chip-btn" type="button" data-community-action="sh-week-card" data-id="${esc(circle.id)}" data-week-card="ready">${SHARE_ICONS.outward} שיתוף כרטיס השבוע</button>${note}</div>`;
  }
  function sharingShareWeekCard(/** @type {string} */ clubId) {
    const slot = sharingState.week[clubId];
    if (!slot || !slot.file) return Promise.resolve("failed");
    return sharingShareFile("week", slot.file);
  }

  // ---- Sunday: last week's card, once ------------------------------------------------
  /** Called once the circles are loaded. Consumes the week's offer even when there is nothing to show. */
  async function sharingMaybeOfferLastWeek() {
    if (!state.circles.list.length || state.circles.sharingSheet) return;
    const offer = window.SharingCore.lastWeekOffer({ today: sharingToday(), lastOffered: sharingGet(SHARING_WEEK_OFFERED_KEY) });
    if (!offer) return;
    sharingSet(SHARING_WEEK_OFFERED_KEY, offer.thisWeek);
    const snaps = sharingReadSnapshots();
    const candidates = [currentCircle()].concat(state.circles.list).filter(Boolean);
    const circle = candidates.find((c) => snaps[c.id] && snaps[c.id][offer.offerWeek]);
    if (!circle) return;
    const weeks = sharingWeeksFromSnapshots(circle, offer.offerWeek);
    const sheet = { kind: "week-offer", clubId: circle.id, label: window.SharingCore.weekLabel(offer.offerWeek), status: "preparing", file: /** @type {File|null} */ (null) };
    state.circles.sharingSheet = sheet;
    rerender();
    try {
      sheet.file = await sharingBuildWeekFile(circle, weeks.slice(0, circle.type === "couple" ? 2 : 1));
      sheet.status = sheet.file ? "ready" : "empty";
    } catch (e) { sheet.status = "failed"; }
    if (state.circles.sharingSheet !== sheet) return;
    if (sheet.status !== "ready") state.circles.sharingSheet = null;
    rerender();
  }

  // ---- Add to Home Screen, once after the first circle --------------------------------
  function sharingStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || /** @type {any} */ (window.navigator).standalone === true;
  }
  function sharingInstallMode() {
    return window.SharingCore.installOffer({
      ua: navigator.userAgent,
      standalone: sharingStandalone(),
      dismissed: !!sharingGet(SHARING_INSTALL_DONE_KEY),
      hasNativePrompt: typeof window.appHasInstallPrompt === "function" && window.appHasInstallPrompt(),
    });
  }
  /** @param {boolean} wasFirst true when this join/create took the member from no circle to one */
  function sharingAfterCircleJoined(wasFirst) {
    if (!wasFirst || sharingInstallWait) return;
    if (!sharingInstallMode()) return;
    sharingInstallWait = setInterval(sharingTryShowInstall, 400);
    sharingTryShowInstall();
  }
  // The install steps never open under another dialog (the first-run welcome
  // sheet, a PR prompt, any circle sheet). Until the screen is clear they wait,
  // and the wait is not a dismissal: only closing the steps themselves is.
  /** @type {any} */
  let sharingInstallWait = null;
  function sharingOtherDialogOpen() {
    return !!document.querySelector('.modal-overlay.open, [data-cloud-dialog]:not([data-cloud-dialog="sharingSheet"])');
  }
  // Runs until the steps are answered (closed, installed) or the member signs out.
  // If something else opens while the steps are up (the welcome sheet can open a
  // moment after the join), the steps step back and return when it is gone.
  function sharingTryShowInstall() {
    if (!sharingInstallWait) return;
    const mode = sharingInstallMode(); // re-read: dismissed or installed meanwhile
    if (!mode) { clearInterval(sharingInstallWait); sharingInstallWait = null; return; }
    const sheet = state.circles.sharingSheet;
    if (sheet && sheet.kind !== "install") return;
    const busy = sharingOtherDialogOpen();
    if (sheet && busy) { state.circles.sharingSheet = null; rerender(); return; }
    if (!sheet && !busy) { state.circles.sharingSheet = { kind: "install", mode: mode }; rerender(); }
  }
  function sharingInstallNative() {
    sharingSet(SHARING_INSTALL_DONE_KEY, "1");
    state.circles.sharingSheet = null;
    // Inside the tap: prompt() needs the user gesture. app.js owns the held event.
    if (typeof window.appInstall === "function") window.appInstall();
    rerender();
  }
  function closeSharingSheet() {
    const s = state.circles.sharingSheet;
    if (!s) return;
    if (s.kind === "install") sharingSet(SHARING_INSTALL_DONE_KEY, "1");
    state.circles.sharingSheet = null;
    rerender();
  }

  function sharingStepIcon(/** @type {string} */ path) {
    return `<span aria-hidden="true" style="flex:none;width:44px;height:44px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);color:var(--brass);display:flex;align-items:center;justify-content:center;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${path}</svg></span>`;
  }
  function sharingStepRow(/** @type {string} */ icon, /** @type {string} */ text) {
    return `<li class="log-row" style="gap:12px;align-items:center;list-style:none;">${icon}<span style="font-size:14px;line-height:1.5;">${text}</span></li>`;
  }
  function sharingFrame(/** @type {string} */ titleId, /** @type {string} */ title, /** @type {string} */ inner) {
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="${titleId}" data-cloud-dialog="sharingSheet" style="align-items:flex-end;padding:0;">
      <div class="modal-sheet" style="border-radius:20px 20px 0 0;max-height:88vh;overflow:auto;width:100%;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="${titleId}" style="margin-top:0;font-weight:800;font-size:17px;margin-bottom:0;">${esc(title)}</h2>
            ${sheetCloseBtnHtml("sh-close")}
          </div>
          ${inner}
        </div>
      </div>
    </div>`;
  }
  function sharingInstallSheetHtml(/** @type {any} */ s) {
    if (s.mode === "native") {
      return sharingFrame("sharingInstallTitle", "להוסיף למסך הבית?", `<div data-install-steps="native">
        <div style="color:var(--steel);font-size:14px;line-height:1.7;margin-bottom:14px;">${bidiText("כך המעגלים נפתחים בלחיצה אחת, כמו כל אפליקציה, והיומן שלכם נשמר במכשיר.")}</div>
        <div class="chip-row"><button class="save-btn" type="button" data-community-action="sh-install-native">התקנה</button><button class="chip-btn" type="button" data-community-action="sh-close">לא עכשיו</button></div>
      </div>`);
    }
    const shareIcon = sharingStepIcon('<path d="M12 3v12"/><path d="M8.5 6.5 12 3l3.5 3.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>');
    const plusIcon = sharingStepIcon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>');
    const doneIcon = sharingStepIcon('<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10v9h12v-9"/><path d="m9.5 14 2 2 3.5-3.5"/>');
    return sharingFrame("sharingInstallTitle", "להוסיף למסך הבית", `<div data-install-steps="ios">
      <div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:10px;">${bidiText("שלושה צעדים ב-Safari, ואחר כך פותחים את " + brandName() + " מהמסך הבית.")}</div>
      <ol class="log-list" style="padding:0;margin:0;">
        ${sharingStepRow(shareIcon, bidiText("לוחצים על כפתור השיתוף בסרגל התחתון של Safari."))}
        ${sharingStepRow(plusIcon, bidiText("גוללים ובוחרים ״הוספה למסך הבית״."))}
        ${sharingStepRow(doneIcon, bidiText("לוחצים ״הוספה״. האייקון מופיע עם שאר האפליקציות."))}
      </ol>
      <div class="chip-row" style="margin-top:14px;"><button class="chip-btn" type="button" data-community-action="sh-close">הבנתי</button></div>
    </div>`);
  }
  function sharingWeekOfferHtml(/** @type {any} */ s) {
    const c = circleById(s.clubId);
    const body = s.status === "ready"
      ? `<div style="color:var(--steel);font-size:14px;line-height:1.7;margin-bottom:6px;">${bidiText("כרטיס השבוע שעבר (" + s.label + ") מוכן לשיתוף ב-WhatsApp.")}</div>
         <div class="footer-note" style="margin-bottom:12px;">בתמונה מופיעים שמות החברים והאחוז של כל אחד מהיעד שלו. בלי דירוג ובלי משקלים.</div>
         <div class="chip-row"><button class="save-btn" type="button" data-community-action="sh-week-offer-share">${SHARE_ICONS.outward} שיתוף</button><button class="chip-btn" type="button" data-community-action="sh-close">לא עכשיו</button></div>`
      : `<div class="empty" aria-busy="true">מכינים את הכרטיס…</div>`;
    return sharingFrame("sharingWeekTitle", "השבוע שעבר ב" + (c ? c.name : "המעגל"), `<div data-week-offer="${esc(s.status)}">${body}</div>`);
  }
  /** Rendered with the other dialogs (cloud.js renderConfirmDialog). */
  function renderSharingSheet() {
    const s = state.circles.sharingSheet;
    if (!s) return "";
    return s.kind === "install" ? sharingInstallSheetHtml(s) : s.kind === "week-offer" ? sharingWeekOfferHtml(s) : "";
  }

  // ---- The invite message -------------------------------------------------------------
  /** @param {any} circle */
  function sharingInviteText(circle) {
    return window.SharingCore.inviteShareText({
      circleName: circle ? circle.name : "",
      inviterName: state.profile ? state.profile.display_name : "",
      appName: brandName(),
    });
  }

  // ---- Invites opened inside an in-app browser ---------------------------------------------
  /**
   * Called by captureInviteFromUrl BEFORE it touches the address bar. True means
   * the invite is held here and the URL, fragment included, must be left exactly
   * as it is: that is what carries the token into Safari or Chrome.
   * @param {string} token
   */
  function sharingHoldInviteForInApp(token) {
    const found = window.SharingCore.detectInAppBrowser(navigator.userAgent);
    if (!found || !token) return false;
    sharingState.inApp = { id: found.id, label: found.label, token: token, platform: window.SharingCore.platform(navigator.userAgent) };
    return true;
  }
  function sharingInAppHeld() { return !!sharingState.inApp; }
  function sharingInAppGateHtml() {
    const h = sharingState.inApp;
    if (!h) return "";
    const how = h.platform === "ios"
      ? ["לוחצים על סמל המצפן, או על ⋯ בפינת המסך.", "בוחרים ״פתיחה ב-Safari״.", "ההזמנה נפתחת שם, ושם מצטרפים."]
      : h.platform === "android"
        ? ["לוחצים על ⋮ בפינה העליונה.", "בוחרים ״פתיחה ב-Chrome״ או ״פתיחה בדפדפן״.", "ההזמנה נפתחת שם, ושם מצטרפים."]
        : ["לוחצים על ״העתקת הקישור״.", "פותחים את Safari או Chrome ומדביקים בשורת הכתובת.", "ההזמנה נפתחת שם, ושם מצטרפים."];
    const steps = how.map((t, i) => `<li class="log-row" style="gap:12px;align-items:center;list-style:none;"><span aria-hidden="true" class="mono" style="flex:none;width:30px;height:30px;border-radius:50%;background:var(--surface2);border:1px solid var(--border);color:var(--brass);display:flex;align-items:center;justify-content:center;font-weight:800;">${i + 1}</span><span style="font-size:14px;line-height:1.5;">${bidiText(t)}</span></li>`).join("");
    return gateCard(`<div data-inapp-browser="${esc(h.id)}">
      <div style="font-weight:800;font-size:20px;margin-bottom:8px;">${bidiText("ההזמנה צריכה להיפתח בדפדפן")}</div>
      <div style="color:var(--steel);font-size:14px;line-height:1.7;margin-bottom:14px;">${bidiText("הדפדפן שבתוך " + h.label + " לא שומר מידע ולא מאפשר הוספה למסך הבית, אז ההצטרפות והיומן שלכם לא יישארו. הקישור שלכם כבר מכיל את ההזמנה.")}</div>
      <ol class="log-list" style="padding:0;margin:0 0 14px;">${steps}</ol>
      <div class="chip-row"><button class="save-btn" type="button" data-community-action="sh-inapp-copy">העתקת הקישור</button></div>
      <div style="display:flex;justify-content:center;margin-top:16px;"><button class="gate-alt" type="button" data-community-action="sh-inapp-continue">להמשיך כאן בכל זאת</button></div>
      ${uiMessageHtml()}
    </div>`);
  }
  async function sharingInAppCopy() {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(window.location.href); ok = true; }
    } catch (e) { ok = false; }
    setMessage(ok ? "הקישור הועתק. פתחו את הדפדפן והדביקו אותו בשורת הכתובת." : "ההעתקה לא הצליחה. אפשר ללחוץ ארוכות על הכתובת ולהעתיק אותה.");
  }
  /** "Continue here anyway": now the token may be read and cleared from the bar, as outside an in-app browser. */
  function sharingInAppContinue() {
    const h = sharingState.inApp;
    if (!h) return;
    sharingState.inApp = null;
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState(null, "", url.pathname + (url.search || ""));
    } catch (e) { /* the bar keeps the fragment; harmless */ }
    state.circles.join.token = h.token;
    if (typeof circlesAfterSession === "function" && state.user) circlesAfterSession();
    else rerender();
  }

  // ---- Click vocabulary ("sh-..."), dispatched from cloud.js --------------------------------
  function handleSharingAction(/** @type {string} */ action, /** @type {HTMLElement} */ el) {
    switch (action) {
      case "sh-pr-card": sharingSharePrCard(); return true;
      case "sh-week-card": sharingShareWeekCard(el.dataset.id || ""); return true;
      case "sh-week-offer-share": {
        const s = state.circles.sharingSheet;
        if (s && s.kind === "week-offer" && s.file) sharingShareFile("week", s.file);
        state.circles.sharingSheet = null;
        rerender();
        return true;
      }
      case "sh-install-native": sharingInstallNative(); return true;
      case "sh-close": closeSharingSheet(); return true;
      case "sh-inapp-copy": sharingInAppCopy(); return true;
      case "sh-inapp-continue": sharingInAppContinue(); return true;
      default: return false;
    }
  }

  // Entry points other files and the tests reach for.
  window.boxlogSharing = {
    maybeOfferLastWeek: sharingMaybeOfferLastWeek,
    afterCircleJoined: sharingAfterCircleJoined,
  };
