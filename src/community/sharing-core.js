// @ts-check
"use strict";
// ---- Sharing pipeline: the pure half ---------------------------------------
//
// What reaches a share card, and when each share offer appears, as functions of
// their arguments only: no session, no DOM, no storage, no network. That is what
// lets test/sharing-pipeline.test.mjs run it with no browser, and what makes
// "an absolute weight is on the card only if the member chose to show it" a
// property of one function (prCardData) instead of a habit of its callers.
//
//   * prCardData / weekCardData  - the exact object handed to
//     boxlogShareCards.renderPrCard / renderWeekCard. Nothing else is passed.
//   * detectInAppBrowser         - WhatsApp, Instagram and Facebook WebViews,
//     where storage and home-screen install do not persist.
//   * installOffer               - which "add to home screen" help applies.
//   * inviteShareText            - the Hebrew message that travels with a link.
//   * snapshot helpers and lastWeekOffer - the Sunday offer. circle_week answers
//     only for the CURRENT week, so last week's card is drawn from the last
//     snapshot of that week this device saw.
//
// Published on window.SharingCore, like src/community/circles-core.js, and
// loaded after it: the week helpers read window.CirclesCore from inside
// function bodies only.

  /** @type {any} */
  const sharingRoot = typeof window !== "undefined" ? window : globalThis;

  const SHARING_INVITE_DAYS = 7;
  const SHARING_SNAPSHOT_WEEKS = 2;
  const SHARING_FSI = "⁨", SHARING_PDI = "⁩";

  /** @param {unknown} v */
  function sharingIso(v) { return String(v == null ? "" : v).replace(/[⁦-⁩]/g, "").trim(); }
  /** A name inside Hebrew prose keeps its own direction. @param {string} s */
  function sharingIsolate(s) { return s ? SHARING_FSI + s + SHARING_PDI : ""; }

  // ---- Where the app is running ------------------------------------------------
  const SHARING_IN_APP = Object.freeze([
    Object.freeze({ id: "whatsapp", label: "WhatsApp", re: /WhatsApp/i }),
    Object.freeze({ id: "instagram", label: "Instagram", re: /Instagram/i }),
    Object.freeze({ id: "facebook", label: "Facebook", re: /FBAN|FBAV|FB_IAB|FBIOS|FB4A|FBSV/ }),
  ]);
  /** @param {unknown} ua @returns {{id: string, label: string}|null} */
  function sharingDetectInAppBrowser(ua) {
    const s = String(ua || "");
    for (const b of SHARING_IN_APP) if (b.re.test(s)) return { id: b.id, label: b.label };
    return null;
  }
  /** @param {unknown} ua @returns {"ios"|"android"|"other"} */
  function sharingPlatform(ua) {
    const s = String(ua || "");
    if (/iPad|iPhone|iPod/.test(s)) return "ios";
    if (/Android/i.test(s)) return "android";
    return "other";
  }
  /** Safari proper: iOS, not another iOS browser, not a WebView. @param {unknown} ua */
  function sharingIsIosSafari(ua) {
    const s = String(ua || "");
    return sharingPlatform(s) === "ios" && /Safari/.test(s) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(s) && !sharingDetectInAppBrowser(s);
  }

  /**
   * Which install help to show once, after the first circle. The native prompt
   * only where the browser handed the page one; short illustrated steps on iOS
   * Safari; nothing elsewhere (an in-app browser cannot install at all).
   * @param {{ua?: string, standalone?: boolean, dismissed?: boolean, hasNativePrompt?: boolean}} o
   * @returns {"native"|"ios"|null}
   */
  function sharingInstallOffer(o) {
    if (!o || o.standalone || o.dismissed) return null;
    if (sharingDetectInAppBrowser(o.ua)) return null;
    if (sharingPlatform(o.ua) === "android" && o.hasNativePrompt) return "native";
    if (sharingIsIosSafari(o.ua)) return "ios";
    return null;
  }

  // ---- The invite message ------------------------------------------------------
  /**
   * The text that goes with an invite link. Names the circle and the inviter and
   * says the link lives 7 days. The token is NOT in the text: it stays after the
   * # of the link, which travels as the share `url`.
   * @param {{circleName?: string, inviterName?: string, appName?: string}} o
   */
  function sharingInviteShareText(o) {
    const circle = sharingIsolate(sharingIso(o && o.circleName));
    const inviter = sharingIsolate(sharingIso(o && o.inviterName));
    const app = sharingIso(o && o.appName);
    const inApp = app ? " ב-" + app : "";
    const head = inviter
      ? inviter + " מזמין/ה אותך להצטרף למעגל " + circle + inApp + "."
      : "הוזמנת להצטרף למעגל " + circle + inApp + ".";
    return head + " הקישור תקף " + SHARING_INVITE_DAYS + " ימים:";
  }

  // ---- The PR card -------------------------------------------------------------
  /**
   * Exactly what renderPrCard receives. Absolute weight (`weight`, and
   * showWeight: true) is present only when some circle of the member shows
   * weights and the figure is a real rep-max, not an estimate. The percent is
   * derived here from the two numbers, so the previous weight never travels.
   * @param {any} record the PR_CREATED record
   * @param {{profile?: any, circles?: any[], today?: string}} ctx
   */
  function sharingPrCardData(record, ctx) {
    const r = record || {};
    const c = ctx || {};
    const circles = Array.isArray(c.circles) ? c.circles : [];
    const core = sharingRoot.CirclesCore;
    const chose = circles.some((x) => core.effectiveDefaults(x).show_weights);
    const nv = Number(r.new_value_numeric);
    const pv = Number(r.previous_value_numeric);
    /** @type {Record<string, any>} */
    const data = {
      memberName: String((c.profile && c.profile.display_name) || "").trim(),
      memberEmoji: String((c.profile && c.profile.emoji) || ""),
      lift: String(r.movement || r.movement_name || ""),
      date: String(c.today || ""),
    };
    if (nv > 0 && pv > 0 && nv > pv) data.percent = Math.round((nv / pv - 1) * 1000) / 10;
    if (chose && !r.estimated && nv > 0 && nv <= 2000) {
      data.weight = Math.round(nv * 10) / 10;
      data.showWeight = true;
    }
    return data;
  }

  // ---- The week card -----------------------------------------------------------
  /** 'YYYY-MM-DD' shifted by whole days, no timezone involved. @param {string} day @param {number} delta */
  function sharingAddDays(day, delta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!m) return "";
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * 86400000);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }
  /** "2026-10-18" -> "18.10 - 24.10". @param {string} weekStart */
  function sharingWeekLabel(weekStart) {
    const a = sharingAddDays(weekStart, 0), b = sharingAddDays(weekStart, 6);
    if (!a || !b) return "";
    const f = (/** @type {string} */ d) => d.slice(8, 10) + "." + d.slice(5, 7);
    return f(a) + " - " + f(b);
  }

  /**
   * circle_week rows reduced to what a card may carry: no user id, no target.
   * @param {any[]} rows
   */
  function sharingSnapshotRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      display_name: String(r.display_name || ""),
      emoji: r.emoji || "",
      percent: r.percent == null ? null : Number(r.percent),
      workouts: r.workouts == null ? null : Number(r.workouts),
      paused: !!r.paused,
      weeks_met: r.weeks_met == null ? null : Number(r.weeks_met),
    }));
  }
  /**
   * Store this week's rows under the circle, keeping the newest two weeks.
   * @param {Record<string, Record<string, any[]>>} store
   * @param {string} clubId @param {string} weekStart @param {any[]} rows
   */
  function sharingRecordSnapshot(store, clubId, weekStart, rows) {
    const out = Object.assign({}, store || {});
    if (!clubId || !weekStart) return out;
    const weeks = Object.assign({}, out[clubId] || {});
    weeks[weekStart] = sharingSnapshotRows(rows);
    const keep = Object.keys(weeks).sort().slice(-SHARING_SNAPSHOT_WEEKS);
    /** @type {Record<string, any[]>} */
    const trimmed = {};
    for (const k of keep) trimmed[k] = weeks[k];
    out[clubId] = trimmed;
    return out;
  }

  /**
   * Exactly what renderWeekCard receives. `weeks` is newest first: [{weekStart,
   * rows}]. A friends circle draws one week, a couple up to two. A member who
   * shares no weekly count is left off the image (their setting wins); nobody is
   * ranked, the server's order is kept.
   * @param {{name?: string, emoji?: string, type?: string}} circle
   * @param {{weekStart: string, rows: any[]}[]} weeks
   */
  function sharingWeekCardData(circle, weeks) {
    const core = sharingRoot.CirclesCore;
    const couple = !!circle && circle.type === "couple";
    const list = (Array.isArray(weeks) ? weeks : []).slice(0, couple ? 2 : 1);
    return {
      circleName: String((circle && circle.name) || ""),
      circleEmoji: String((circle && circle.emoji) || ""),
      type: couple ? "couple" : "friends",
      weeks: list.map((w) => ({
        label: sharingWeekLabel(w.weekStart),
        members: core.weekView(w.rows, "")
          .filter((m) => !m.hidden)
          .map((m) => ({ name: m.name, emoji: m.emoji, percent: m.percent == null ? undefined : m.percent, paused: m.paused, weeksMet: m.weeksMet == null ? undefined : m.weeksMet })),
      })),
    };
  }
  /** True when a week has someone worth drawing. @param {any} data */
  function sharingWeekCardHasContent(data) {
    return !!(data && Array.isArray(data.weeks) && data.weeks.some((w) => w.members.length > 0));
  }

  // ---- The Sunday offer --------------------------------------------------------
  /**
   * First open on a Sunday (Asia/Jerusalem) offers last week's card, once per
   * week. `today` is the Jerusalem day, 'YYYY-MM-DD'; `lastOffered` is the
   * Sunday the offer was last consumed. Returns the week to mark consumed and
   * the week whose card is offered, or null on any other day or after the offer.
   * @param {{today: string, lastOffered?: string|null}} o
   * @returns {{thisWeek: string, offerWeek: string}|null}
   */
  function sharingLastWeekOffer(o) {
    const core = sharingRoot.CirclesCore;
    const today = String((o && o.today) || "");
    const ws = core.weekStartOf(today);
    if (!ws || ws !== today) return null;
    if (o.lastOffered === ws) return null;
    return { thisWeek: ws, offerWeek: sharingAddDays(ws, -7) };
  }

  sharingRoot.SharingCore = Object.freeze({
    INVITE_DAYS: SHARING_INVITE_DAYS,
    detectInAppBrowser: sharingDetectInAppBrowser,
    platform: sharingPlatform,
    isIosSafari: sharingIsIosSafari,
    installOffer: sharingInstallOffer,
    inviteShareText: sharingInviteShareText,
    prCardData: sharingPrCardData,
    weekCardData: sharingWeekCardData,
    weekCardHasContent: sharingWeekCardHasContent,
    weekLabel: sharingWeekLabel,
    addDays: sharingAddDays,
    snapshotRows: sharingSnapshotRows,
    recordSnapshot: sharingRecordSnapshot,
    lastWeekOffer: sharingLastWeekOffer,
  });
