// @ts-check
"use strict";
// ---- Circles: sheets, the post-save bar, and the click vocabulary ------------
//
// The dialogs a circle needs (create, owner settings, invite, the circles-for-
// this-workout picker, the medal picker), the small bar that confirms a
// workout was shared, and handleCirclesAction(): every data-community-action
// that starts with "c-" lands here, so cloud.js's big dispatcher gains one
// line instead of forty.
//
// One sheet is open at a time (state.circles.sheet) and it is one entry in
// cloud.js's CLOUD_DIALOGS, so the focus trap, Escape and backdrop-tap come
// from the machinery every other dialog already uses.
//
// Classic <script>, no IIFE, loaded before cloud.js.

  function sheetFrame(titleId, title, inner) {
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="${titleId}" data-cloud-dialog="circleSheet" style="align-items:flex-end;padding:0;">
      <div class="modal-sheet" style="border-radius:20px 20px 0 0;max-height:88vh;overflow:auto;width:100%;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="${titleId}" style="margin-top:0;font-weight:800;font-size:17px;margin-bottom:0;">${esc(title)}</h2>
            ${sheetCloseBtnHtml("c-sheet-close")}
          </div>
          ${inner}
        </div>
      </div>
    </div>`;
  }

  function createSheetHtml() {
    const type = uiDraft("circleCreate.type", "friends");
    const typeRow = (value, title, hint) => `<label class="log-row" style="gap:10px;cursor:pointer;align-items:flex-start;"><input type="radio" name="type" value="${value}" data-draft="circleCreate.type"${type === value ? " checked" : ""}/><span style="min-width:0;"><span style="font-weight:800;">${esc(title)}</span><span style="display:block;color:var(--color-text-muted);font-size:12px;line-height:1.5;">${esc(hint)}</span></span></label>`;
    return sheetFrame("circleCreateTitle", "יצירת מעגל", `<form id="circleCreate">
      <div class="field-label">סוג המעגל</div>
      <div class="log-list" role="radiogroup" aria-label="סוג המעגל">
        ${typeRow("friends", "חברים", "עד 20 חברים, בלי דירוג. אימונים נשלחים כספירה שבועית, שיאים ואחוזים מהיעד נראים.")}
        ${typeRow("couple", "זוג", "שניים, שניהם בעלי המעגל. רואים את השבוע זה של זו זה לצד זה, והאימונים מלאים. משקלים מוסתרים.")}
      </div>
      ${(state.ui.fieldErrors.circleCreate || {}).type ? `<span class="field-error" role="alert">${esc(state.ui.fieldErrors.circleCreate.type)}</span>` : ""}
      ${field("circleCreate", "name", "שם המעגל", `<input class="text-input" name="name" dir="auto" maxlength="40" value="${esc(uiDraft("circleCreate.name", ""))}" data-draft="circleCreate.name" placeholder="למשל החבר'ה מהקבוצה" required/>`)}
      ${field("circleCreate", "emoji", "אימוג'י", `<input class="text-input" name="emoji" dir="auto" maxlength="16" value="${esc(uiDraft("circleCreate.emoji", "🔥"))}" data-draft="circleCreate.emoji"/>`)}
      <div class="chip-row" role="group" aria-label="בחירת אימוג'י">${EMOJI_CHOICES.map((e) => `<button type="button" class="chip-btn" data-community-action="c-emoji-pick" data-emoji="${esc(e)}" data-form="circleCreate" aria-label="${esc(e)}">${e}</button>`).join("")}</div>
      <button class="save-btn" type="submit"${state.circles.busy.create ? " disabled" : ""} style="margin-top:14px;">${state.circles.busy.create ? "יוצרים…" : "יצירת המעגל"}</button>
    </form>`);
  }

  function settingsSheetHtml(c) {
    const mode = uiDraft("circleSettings.mode", c.mode);
    const policy = uiDraft("circleSettings.invite_policy", c.invite_policy);
    const bench = uiDraft("circleSettings.benchmark_enabled", c.benchmark_enabled);
    return sheetFrame("circleSettingsTitle", "הגדרות המעגל", `<form id="circleSettings">
      ${field("circleSettings", "name", "שם המעגל", `<input class="text-input" name="name" dir="auto" maxlength="40" value="${esc(uiDraft("circleSettings.name", c.name))}" data-draft="circleSettings.name" required/>`)}
      ${field("circleSettings", "emoji", "אימוג'י", `<input class="text-input" name="emoji" dir="auto" maxlength="16" value="${esc(uiDraft("circleSettings.emoji", c.emoji))}" data-draft="circleSettings.emoji"/>`)}
      <div class="chip-row" role="group" aria-label="בחירת אימוג'י">${EMOJI_CHOICES.map((e) => `<button type="button" class="chip-btn" data-community-action="c-emoji-pick" data-emoji="${esc(e)}" data-form="circleSettings" aria-label="${esc(e)}">${e}</button>`).join("")}</div>
      ${field("circleSettings", "mode", "מצב", `<select class="text-input" name="mode" data-draft="circleSettings.mode"><option value="together"${mode === "together" ? " selected" : ""}>ביחד (בלי דירוג)</option><option value="weekly_competition"${mode === "weekly_competition" ? " selected" : ""}>תחרות שבועית (אחוז מהיעד האישי)</option></select>`)}
      <label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;margin-top:8px;"><span style="font-size:13px;">בנצ'מרק של החודש</span><input type="checkbox" name="benchmark_enabled" data-draft="circleSettings.benchmark_enabled"${bench ? " checked" : ""} aria-label="בנצ'מרק של החודש"/></label>
      ${field("circleSettings", "invite_policy", "מי מזמין", `<select class="text-input" name="invite_policy" data-draft="circleSettings.invite_policy"><option value="owner"${policy === "owner" ? " selected" : ""}>רק בעלי המעגל</option><option value="any_member"${policy === "any_member" ? " selected" : ""}>כל חבר/ה במעגל</option></select>`)}
      ${field("circleSettings", "welcome_line", "שורת פתיחה (עד 200 תווים)", `<textarea class="text-input" name="welcome_line" maxlength="200" rows="2" data-draft="circleSettings.welcome_line">${esc(uiDraft("circleSettings.welcome_line", c.welcome_line))}</textarea>`)}
      <button class="save-btn" type="submit"${state.circles.busy.settings ? " disabled" : ""} style="margin-top:14px;">${state.circles.busy.settings ? "שומרים…" : "שמירה"}</button>
    </form>`);
  }

  function inviteSheetHtml(c, sheet) {
    const form = `<form id="circleInvite">
      <div style="color:var(--color-text-muted);font-size:13px;line-height:1.6;margin-bottom:10px;">${bidiText("הקישור תקף שבוע, ואפשר להשתמש בו " + (c.type === "couple" ? "פעם אחת" : "עד חמש פעמים כברירת מחדל") + ". הוא מוצג רק עכשיו.")}</div>
      ${field("circleInvite", "max_uses", "כמה אנשים יכולים להצטרף (אופציונלי)", `<input class="text-input" name="max_uses" inputmode="numeric" dir="ltr" maxlength="2" placeholder="${c.type === "couple" ? "1" : "5"}" value="${esc(uiDraft("circleInvite.max_uses", ""))}" data-draft="circleInvite.max_uses"/>`)}
      <button class="save-btn" type="submit"${state.circles.busy.invite ? " disabled" : ""} style="margin-top:12px;">${state.circles.busy.invite ? "יוצרים…" : "יצירת קישור הזמנה"}</button>
    </form>`;
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const made = `<div data-invite-ready="1">
      <label class="field"><span class="field-label">קישור ההזמנה</span><input class="text-input" id="circleInviteLink" dir="ltr" readonly value="${esc(sheet.link || "")}" onfocus="this.select()"/></label>
      <div class="footer-note" style="margin:6px 0 10px;">${esc("שלחו אותו רק למי שרוצים להזמין. מי שמקבל אותו יכול להצטרף למעגל.")}</div>
      <div class="chip-row">${canShare ? `<button class="chip-btn primary" data-community-action="c-invite-share">שיתוף</button>` : ""}<button class="chip-btn${canShare ? "" : " primary"}" data-community-action="c-invite-copy">${sheet.copied ? "הועתק" : "העתקה"}</button></div>
    </div>`;
    return sheetFrame("circleInviteTitle", "הזמנה למעגל " + c.name, (sheet.error ? `<div class="field-error" role="alert" style="margin-bottom:10px;">${esc(sheet.error)}</div>` : "") + (sheet.link ? made : form));
  }

  function founderSheetHtml(sheet) {
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const intro = `<div style="color:var(--color-text-muted);font-size:13px;line-height:1.6;margin-bottom:10px;">${bidiText(FOUNDER_EXPLAIN_TEXT)}</div>`;
    const err = sheet.error ? `<div class="field-error" role="alert" data-founder-error="1" style="margin-bottom:10px;">${esc(sheet.error)}</div>` : "";
    const body = sheet.link
      ? `<div data-founder-ready="1">
          <label class="field"><span class="field-label">הקישור לחבר/ה</span><input class="text-input" id="founderLink" dir="ltr" readonly value="${esc(sheet.link)}" onfocus="this.select()"/></label>
          <div class="footer-note" style="margin:6px 0 10px;">${esc("הקישור מוצג רק עכשיו, תקף 7 ימים ופועל פעם אחת.")}</div>
          <div class="chip-row">${canShare ? `<button class="chip-btn primary" data-community-action="c-founder-share">שיתוף</button>` : ""}<button class="chip-btn${canShare ? "" : " primary"}" data-community-action="c-founder-copy">${sheet.copied ? "הועתק" : "העתקה"}</button></div>
        </div>`
      : `<button class="save-btn" data-community-action="c-founder-create"${state.circles.busy.founder ? " disabled" : ""}>${state.circles.busy.founder ? "יוצרים…" : "יצירת קישור"}</button>`;
    return sheetFrame("circleFounderTitle", "קישור לחבר שרוצה מעגל משלו", intro + err + body);
  }

  function shareSheetHtml(sheet) {
    const day = sheet.day;
    const list = sheet.loading || !sheet.picked
      ? `<div class="empty" aria-busy="true">טוען…</div>`
      : circlePickListHtml(sheet.picked, "data-share-pick", (c) => {
        const d = CirclesCore.effectiveDefaults(c);
        return d.show_weights ? "עם משקלים" : "בלי משקלים מוחלטים";
      });
    return sheetFrame("circleShareTitle", "לאילו מעגלים האימון הזה?", `<div style="color:var(--color-text-muted);font-size:13px;line-height:1.6;">${bidiText("האימון של " + shortHebDate(day) + ". מעגל שמבטלים בו נמחק ממנו הפוסט של האימון הזה, ושום דבר אחר לא משתנה.")}</div>
      ${list}
      ${sheet.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(sheet.error)}</div>` : ""}
      <button class="save-btn" data-community-action="c-share-apply"${sheet.saving || sheet.loading ? " disabled" : ""} style="margin-top:14px;">${sheet.saving ? "שומרים…" : "שמירה"}</button>`);
  }

  function medalSheetHtml(sheet) {
    return sheetFrame("circleMedalTitle", "שיתוף מדליה", `<div style="font-size:14px;line-height:1.6;">${bidiText(sheet.body)}</div>
      ${circlePickListHtml(sheet.picked, "data-medal-circle")}
      ${sheet.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(sheet.error)}</div>` : ""}
      <button class="save-btn" data-community-action="c-medal-send"${sheet.saving ? " disabled" : ""} style="margin-top:14px;">${sheet.saving ? "משתפים…" : "שיתוף"}</button>`);
  }

  function joinSheetHtml() {
    const j = state.circles.join;
    return sheetFrame("circleJoinTitle", "הצטרפות למעגל", `<div style="color:var(--color-text-muted);font-size:13px;line-height:1.6;margin-bottom:10px;">${bidiText("הדביקו את קישור ההזמנה שקיבלתם. אפשר להיות עד 10 מעגלים.")}</div>
      ${j.error ? `<div class="field-error" role="alert" data-join-error="1" style="margin-bottom:10px;">${esc(j.error)}</div>` : ""}
      <form id="circleJoin">${field("circleJoin", "link", "קישור הזמנה", `<input class="text-input" name="link" dir="ltr" inputmode="url" autocomplete="off" autocapitalize="off" placeholder="https://…#invite=…" value="${esc(j.draft || "")}" data-circle-join-draft required/>`)}<button class="save-btn" type="submit"${j.busy ? " disabled" : ""} style="margin-top:12px;">${j.busy ? "מצטרפים…" : "הצטרפות"}</button></form>`);
  }

  function renderCircleSheet() {
    const sheet = state.circles.sheet;
    if (!sheet) return "";
    const c = circleById(sheet.clubId);
    if (sheet.kind === "create") return createSheetHtml();
    if (sheet.kind === "join") return joinSheetHtml();
    if (sheet.kind === "settings" && c) return settingsSheetHtml(c);
    if (sheet.kind === "invite" && c) return inviteSheetHtml(c, sheet);
    if (sheet.kind === "founder") return founderSheetHtml(sheet);
    if (sheet.kind === "share") return shareSheetHtml(sheet);
    if (sheet.kind === "medal") return medalSheetHtml(sheet);
    return "";
  }

  // ---- The bar after a save ----------------------------------------------------------
  function renderCircleShareBar() {
    const b = state.circles.shareBar;
    if (!b) return "";
    const where = b.names.length === 1 ? "ב" + b.names[0] : "ב-" + b.names.length + " מעגלים";
    const text = b.queued ? "האימון יישלח " + where + " כשהחיבור יחזור" : "האימון שותף " + where;
    return `<div role="status" aria-live="polite" data-share-bar="1" style="position:fixed;left:0;right:0;bottom:calc(var(--bottom-nav-reserve) - 108px);display:flex;justify-content:center;padding:0 16px;z-index:60;">
      <div style="max-width:448px;width:100%;background:var(--color-surface);border:1px solid var(--color-accent);border-radius:14px;padding:10px 14px;box-shadow:var(--card-shadow);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span style="font-size:13px;font-weight:700;flex:1 1 auto;min-width:0;">${bidiText(text)}</span>
        <button class="chip-btn" data-community-action="c-share-bar-change" data-day="${esc(b.day)}">שינוי</button>
        <button class="icon-btn" data-community-action="c-share-bar-close" aria-label="סגירה" style="color:var(--color-text-muted);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div></div>`;
  }

  // The share control Calendar and Progress draw beside a result: one icon, one
  // sheet, the circles for that day. (Replaces the per-record "publish" menu.)
  window.renderShareControl = function (type, id) {
    if (!window.isCommunitySignedIn || !window.isCommunitySignedIn() || !state.circles.list.length) return "";
    const item = typeof window.communityDayItemFor === "function" ? window.communityDayItemFor(type, id) : null;
    if (!item) return "";
    return `<button data-community-action="c-share-open" data-day="${esc(item.day)}" aria-label="לאילו מעגלים האימון הזה" style="color:var(--color-text-muted);padding:4px;line-height:0;">${SHARE_ICONS.club}</button>`;
  };

  function openMedalShareSheet(body) {
    state.circles.sheet = { kind: "medal", body: body, picked: state.circles.list.map((c) => c.id), saving: false, error: "" };
    rerender();
  }
  async function sendMedal() {
    const s = state.circles.sheet;
    if (!s || s.kind !== "medal" || s.saving) return;
    if (!s.picked.length) { s.error = "בחרו לפחות מעגל אחד"; return rerender(); }
    s.saving = true;
    s.error = "";
    rerender();
    const res = await postTextToCircles(s.picked.slice(), s.body);
    s.saving = false;
    if (res.failed && !res.sent && !res.queued) { s.error = failText("השיתוף נכשל, אפשר לנסות שוב", res.error); return rerender(); }
    state.circles.sheet = null;
    track(A.ACHIEVEMENT_SHARED, { member_achievement_id: null, code: null, source: "app_share_button" });
    for (const id of s.picked) delete state.circles.feed[id];
    setMessage(res.queued && !res.sent ? "המדליה תישלח למעגלים כשהחיבור יחזור" : "המדליה שותפה");
  }

  // ---- The click vocabulary -----------------------------------------------------------
  function openCircleSheetFor(kind, clubId) {
    const prefix = { create: "circleCreate.", settings: "circleSettings.", invite: "circleInvite." }[kind];
    if (prefix) for (const k of Object.keys(state.circles.drafts)) if (k.indexOf(prefix) === 0) delete state.circles.drafts[k];
    setFieldErrors(kind === "create" ? "circleCreate" : kind === "settings" ? "circleSettings" : "circleInvite", {});
    state.circles.sheet = { kind: kind, clubId: clubId || "", link: "", copied: false, error: "" };
    rerender();
  }
  function goToTab(name) {
    if (typeof window.switchAppTab === "function") window.switchAppTab(name);
    else rerender();
  }
  function handleCirclesAction(action, el) {
    const id = el.dataset.id;
    switch (action) {
      case "c-sheet-close": closeSheet(); return true;
      case "c-open-me": goToTab("me"); return true;
      case "c-open-circle": setCurrentCircle(id); state.circles.section = "feed"; goToTab("community"); ensureSectionLoaded(id); return true;
      case "c-pick": setCurrentCircle(id); ensureSectionLoaded(id); rerender(); return true;
      case "c-section": setSection(el.dataset.section); return true;
      case "c-create-open": openCircleSheetFor("create"); return true;
      case "c-join-open": state.circles.join.error = ""; state.circles.sheet = { kind: "join" }; rerender(); return true;
      case "c-settings-open": openCircleSheetFor("settings", id); return true;
      case "c-invite-open": openCircleSheetFor("invite", id); return true;
      case "c-founder-open": openFounderSheet(); return true;
      case "c-founder-create": createFounderLink(); return true;
      case "c-founder-share": shareFounderLink(); return true;
      case "c-founder-copy": copyFounderLink(); return true;
      case "c-invite-share": shareInvite(); return true;
      case "c-invite-copy": copyInvite(); return true;
      case "c-leave-ask": {
        const c = circleById(id);
        if (!c) return true;
        const count = circleMemberCount(id);
        const last = count === 1;
        askConfirm({
          title: "עזיבת המעגל",
          message: "אם תעזבו את \"" + c.name + "\", כל הפוסטים שלכם בו יימחקו: אימונים, שיאים, מדליות והתגובות שלכם. היומן הפרטי נשאר במכשיר."
            + (last ? " אתם החבר/ה האחרון/ה, אז המעגל יימחק."
              : circleIsOwner(c) && c.type !== "couple" ? " אתם הבעלים, והבעלות תעבור לחבר/ה הוותיק/ה ביותר." : ""),
          confirmLabel: "עזיבה ומחיקת הפוסטים", destructive: true, action: "leave-circle", payload: { clubId: id },
        });
        return true;
      }
      case "c-remove-ask":
        askConfirm({
          title: "הסרת חבר/ה", message: "להסיר את {subject} מהמעגל? הפוסטים שלו/ה במעגל יימחקו.", subject: el.dataset.name || "",
          confirmLabel: "הסרה", destructive: true, action: "remove-member", payload: { clubId: id, userId: el.dataset.user },
        });
        return true;
      case "c-feed-more": loadFeed(state.circles.currentId, true); return true;
      case "c-feed-retry": loadFeed(state.circles.currentId, false); return true;
      case "c-week-retry": { const c = currentCircle(); if (c) { delete state.circles.week[c.id]; loadWeek(c.id); } return true; }
      case "c-bench-pick": pickBenchmark(state.circles.currentId, id || null); return true;
      case "c-tag-confirm": confirmTag(id); return true;
      case "c-tag-decline": declineTag(id); return true;
      case "c-pause": savePause(Number(el.dataset.days) || 0); return true;
      case "c-share-open": openShareSheet(el.dataset.day); return true;
      case "c-share-bar-change": openShareSheet(el.dataset.day); return true;
      case "c-share-bar-close": dismissShareBar(); return true;
      case "c-share-apply": applySharePick(); return true;
      case "c-medal-send": sendMedal(); return true;
      case "c-emoji-pick": {
        state.circles.drafts[el.dataset.form + ".emoji"] = el.dataset.emoji;
        rerender();
        return true;
      }
      case "react": reactToPost(id, el.dataset.kind); return true;
      default: return false;
    }
  }

  // ---- Forms and inputs ------------------------------------------------------------------
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || !form.id) return;
    if (form.id === "circleJoin") { event.preventDefault(); joinFromForm(form); }
    else if (form.id === "circleCreate") { event.preventDefault(); createCircle(form); }
    else if (form.id === "circleSettings") { event.preventDefault(); saveCircleSettings(form); }
    else if (form.id === "circleInvite") { event.preventDefault(); createInvite(form); }
    else if (form.id === "circleBenchmark") { event.preventDefault(); logBenchmark(form); }
  });
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.draft) state.circles.drafts[t.dataset.draft] = t.type === "checkbox" ? t.checked : t.value;
    if ("circleJoinDraft" in t.dataset) state.circles.join.draft = t.value;
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.draft) {
      state.circles.drafts[t.dataset.draft] = t.type === "checkbox" ? t.checked : t.value;
      // Radios re-render so the chosen segment reads as chosen.
      if (t.type === "radio") rerender();
    }
    if ("shareSetting" in t.dataset) setShareSetting(t.dataset.circle, t.dataset.shareSetting, t.checked);
    else if ("weeklyTarget" in t.dataset) { if (t.value) saveWeeklyTarget(t.value); }
    else if ("shareProfile" in t.dataset) { /* reserved */ }
    else if ("prCircle" in t.dataset) togglePrCircle(t.dataset.prCircle);
    else if ("achCircle" in t.dataset) {
      const a = state.achievements.unlock;
      if (a) { const at = a.picked.indexOf(t.dataset.achCircle); if (at >= 0) a.picked.splice(at, 1); else a.picked.push(t.dataset.achCircle); a.error = ""; rerender(); }
    }
    else if ("sharePick" in t.dataset) toggleSharePick(t.dataset.sharePick);
    else if ("medalCircle" in t.dataset) {
      const s = state.circles.sheet;
      if (s && s.kind === "medal") { const at = s.picked.indexOf(t.dataset.medalCircle); if (at >= 0) s.picked.splice(at, 1); else s.picked.push(t.dataset.medalCircle); s.error = ""; rerender(); }
    }
  });
