// @ts-check
"use strict";
// ---- When the personal reminders fire ---------------------------------------------------
//
// The on/off switch for each reminder is an ordinary notification preference (notifications.js:
// notification_preferences, off until turned on). This file is only the schedule beside it:
// which days and at what time, kept in reminder_prefs (own-row RLS, migration 202611080001) and
// read by the pg_cron job reminder_push_due. Times are Asia/Jerusalem on a 15-minute grid.
// The server never sees the private training log, so a reminder cannot know you already trained;
// it is a nudge at the time you chose, nothing more.
//
// Classic <script>, no IIFE, loaded before cloud.js; reads state, client, esc, rerender, setMessage
// from the shared scope, from inside function bodies only.

  const REMINDER_DAY_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  const REMINDER_DAY_LONG = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"];
  const REMINDER_MINUTES = [0, 15, 30, 45];
  /** One entry per scheduled reminder: its notification type and its columns in reminder_prefs. */
  const REMINDER_KINDS = {
    workout_reminder: { days: "workout_days", hour: "workout_hour", minute: "workout_minute", multi: true, defaults: { days: [], hour: 18, minute: 0 } },
    // One day a week (Friday 10:00 until the member chooses).
    weekly_digest: { days: "digest_day", hour: "digest_hour", minute: "digest_minute", multi: false, defaults: { days: 5, hour: 10, minute: 0 } },
  };

  function reminderState() {
    return state.notif.reminder;
  }
  function reminderValue(kind, part) {
    const k = REMINDER_KINDS[kind];
    const row = reminderState().row;
    const v = row && row[k[part]];
    return v == null ? k.defaults[part] : v;
  }

  async function loadReminderPrefs() {
    const r = reminderState();
    if (r.loaded || !client || !state.user || state.user.is_anonymous) return;
    r.loaded = true;
    const { data, error } = await client.from("reminder_prefs").select("*").eq("user_id", state.user.id).maybeSingle();
    if (error) { r.loaded = false; return; }
    r.row = data || {};
    rerender();
  }

  async function saveReminder(kind, part, value) {
    const k = REMINDER_KINDS[kind];
    const r = reminderState();
    if (!k || !client || !state.user || r.saving) return;
    const prev = r.row ? Object.assign({}, r.row) : {};
    const next = Object.assign({}, prev, { [k[part]]: value });
    r.row = next; r.saving = true; rerender();
    const payload = { user_id: state.user.id, updated_at: new Date().toISOString() };
    for (const key of ["days", "hour", "minute"]) { const col = k[key]; if (col) payload[col] = next[col] == null ? k.defaults[key] : next[col]; }
    const { error } = await client.from("reminder_prefs").upsert(payload, { onConflict: "user_id" });
    r.saving = false;
    if (error) { r.row = prev; setMessage("לא ניתן לשמור את התזמון"); return; }
    rerender();
  }

  function reminderToggleDay(kind, day) {
    const k = REMINDER_KINDS[kind];
    const rawCur = reminderValue(kind, "days");
    const cur = /** @type {number[]} */ (Array.isArray(rawCur) ? rawCur : [rawCur]);
    const next = k.multi ? (cur.includes(day) ? cur.filter((d) => d !== day) : cur.concat(day).sort()) : day;
    saveReminder(kind, "days", next);
  }

  function reminderAction(action, el) {
    if (action !== "reminder-day") return false;
    const kind = el.dataset.kind; const day = Number(el.dataset.day);
    if (REMINDER_KINDS[kind] && day >= 0 && day <= 6) reminderToggleDay(kind, day);
    return true;
  }

  /** The schedule under a reminder's switch, or "" while it is off. */
  function reminderScheduleHtml(kind) {
    const k = REMINDER_KINDS[kind];
    if (!k || !reminderState().loaded) return "";
    const raw = reminderValue(kind, "days");
    const days = /** @type {number[]} */ (Array.isArray(raw) ? raw : [raw]);
    const hour = reminderValue(kind, "hour"); const minute = reminderValue(kind, "minute");
    const busy = reminderState().saving ? " disabled" : "";
    const dayLabel = k.multi ? "ימים" : "יום";
    const chips = REMINDER_DAY_SHORT.map((s, d) =>
      `<button type="button" class="chip-btn" data-community-action="reminder-day" data-kind="${kind}" data-day="${d}" aria-pressed="${days.includes(d)}" aria-label="${esc(REMINDER_DAY_LONG[d])}" style="min-width:44px;min-height:44px;"${busy}>${s}</button>`).join("");
    const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === hour ? " selected" : ""}>${String(h).padStart(2, "0")}</option>`).join("");
    const mins = REMINDER_MINUTES.map((m) => `<option value="${m}"${m === minute ? " selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("");
    const none = k.multi && !days.length ? `<div role="status" style="color:var(--color-text-muted);font-size:12px;margin-top:6px;">בחרו לפחות יום אחד, אחרת לא תגיע תזכורת.</div>` : "";
    return `<div data-reminder-schedule="${kind}" style="padding:4px 0 10px;">
      <div role="group" aria-label="${dayLabel}" class="chip-row" style="gap:6px;flex-wrap:wrap;">${chips}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;" dir="ltr">
        <select data-reminder-field="hour" data-kind="${kind}" aria-label="שעה" class="text-input" style="min-height:44px;width:auto;"${busy}>${hours}</select>
        <span aria-hidden="true">:</span>
        <select data-reminder-field="minute" data-kind="${kind}" aria-label="דקות" class="text-input" style="min-height:44px;width:auto;"${busy}>${mins}</select>
      </div>${none}</div>`;
  }

  document.addEventListener("change", (event) => {
    const t = /** @type {HTMLSelectElement} */ (event.target);
    if (!t || !t.dataset || !t.dataset.reminderField) return;
    const kind = t.dataset.kind;
    if (REMINDER_KINDS[kind]) saveReminder(kind, t.dataset.reminderField, Number(t.value));
  });

  window.haimuniaReminders = { load: loadReminderPrefs, scheduleHtml: reminderScheduleHtml, save: saveReminder };
