// @ts-check
"use strict";
// ---- Circles: the pure half -----------------------------------------------
//
// Everything about circles that needs no session, no DOM and no network:
// reading an invite token out of a URL fragment, what a join status means in
// Hebrew, which circles a workout goes to and exactly what is allowed to
// leave the device for each of them, how circle_week rows become a view, and
// how circle_feed rows become the post objects the card renderers draw.
//
// It is a function of its arguments and nothing else, which is what lets
// test/circles-core.test.mjs run it with no browser at all, and what makes
// "hidden fields are never sent" checkable: circlesWorkoutPostRow() below is the one
// place a workout becomes a database row, so the privacy rule has one
// definition and one test.
//
// Published on window.CirclesCore, like src/shared/safe-helpers.js, because
// classic scripts share a global scope only in a real browser (see
// test/helpers/community-src.mjs).
  /** @type {any} */
  const circlesRoot = typeof window !== "undefined" ? window : globalThis;

  // ---- Reactions: exactly three kinds (decisions.md, Sharing) ----------------
  const CIRCLES_REACTION_KINDS = Object.freeze(["fist_bump", "fire", "clap"]);
  const CIRCLES_REACTION_META = Object.freeze({
    fist_bump: Object.freeze({ emoji: "🤜", label: "פיסט באמפ" }),
    fire: Object.freeze({ emoji: "🔥", label: "אש" }),
    clap: Object.freeze({ emoji: "👏", label: "מחיאות כפיים" }),
  });

  // ---- The invite token ------------------------------------------------------
  // 32 random bytes, hex. The server stores only its hash; the client holds the
  // raw token once, in memory, from the moment the page opens until join_circle.
  const CIRCLES_TOKEN_RE = /^[0-9a-f]{64}$/;
  const CIRCLES_TOKEN_ANYWHERE_RE = /[0-9a-f]{64}/i;

  /**
   * The token in a URL fragment, or null. The fragment never reaches a server,
   * a proxy or an access log; a query string reaches all three, so a token in a
   * query string is deliberately NOT read (an old ?invite= link is ignored).
   * Accepted shapes: "#invite=<token>", "#join=<token>", "#<token>".
   * @param {string} hash
   * @returns {string|null}
   */
  function circlesParseInviteHash(hash) {
    let h = String(hash == null ? "" : hash).trim();
    if (h.charAt(0) === "#") h = h.slice(1);
    if (!h) return null;
    let candidate = h;
    const eq = h.indexOf("=");
    if (eq >= 0) {
      const key = h.slice(0, eq).toLowerCase();
      if (key !== "invite" && key !== "join") return null;
      candidate = h.slice(eq + 1);
    }
    candidate = candidate.trim().toLowerCase();
    return CIRCLES_TOKEN_RE.test(candidate) ? candidate : null;
  }

  /**
   * A token out of whatever a member pasted: the whole link, or the bare
   * token. Only the fragment of a link is read; a token in its query string is
   * not accepted.
   * @param {string} text
   * @returns {string|null}
   */
  function circlesExtractInviteToken(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return null;
    const hashAt = raw.indexOf("#");
    if (hashAt >= 0) return circlesParseInviteHash(raw.slice(hashAt));
    const bare = raw.toLowerCase();
    if (CIRCLES_TOKEN_RE.test(bare)) return bare;
    return null;
  }

  /**
   * The link a member shares. The token is after #, so it is not sent when the
   * link is opened, only read by the page.
   * @param {string} base origin + pathname of the app
   * @param {string} token
   */
  function circlesInviteUrl(base, token) {
    return String(base || "").replace(/#.*$/, "") + "#invite=" + token;
  }

  // ---- What the server said, in Hebrew ---------------------------------------
  // join_circle returns a status instead of raising, on purpose (rpcs.md).
  // "invalid" is unknown, expired and used-up together: the server does not say
  // which, so the message must not either.
  const CIRCLES_JOIN_STATUS_TEXT = Object.freeze({
    invalid: "ההזמנה לא תקפה: היא פגה, נוצלה במלואה או שהקישור לא נכון. אפשר לבקש קישור חדש ממי ששלח/ה אותו.",
    circle_full: "המעגל הזה מלא ואין בו מקום לעוד חברים. אפשר לבקש מבעל/ת המעגל מקום או להצטרף למעגל אחר.",
    too_many_circles: "את/ה כבר ב-10 מעגלים, וזה המקסימום. כדי להצטרף לעוד אחד צריך לעזוב מעגל.",
    rate_limited: "ניסיתם יותר מדי פעמים בשעה האחרונה. אפשר לנסות שוב בעוד שעה.",
    already_member: "את/ה כבר חבר/ה במעגל הזה.",
  });
  /** @param {string} status */
  function circlesJoinStatusText(status) {
    return CIRCLES_JOIN_STATUS_TEXT[/** @type {keyof typeof CIRCLES_JOIN_STATUS_TEXT} */ (status)] || "ההצטרפות לא הושלמה. אפשר לנסות שוב.";
  }

  const CIRCLES_CIRCLE_ERROR_TEXT = Object.freeze({
    too_many_circles: "את/ה כבר ב-10 מעגלים, וזה המקסימום.",
    circle_full: "המעגל מלא, אי אפשר להזמין עוד חברים.",
    invite_limit: "נוצרו היום 20 הזמנות למעגל הזה. אפשר ליצור עוד מחר.",
    rate_limited: "יותר מדי פעולות בזמן קצר. אפשר לנסות שוב בעוד כמה דקות.",
    "not authorized": "אין לך הרשאה לפעולה הזו במעגל הזה.",
    "a circle needs a name": "למעגל צריך שם.",
    "circle name is too long": "שם המעגל ארוך מדי (עד 40 תווים).",
    "emoji is too long": "האימוג'י ארוך מדי.",
    "unknown circle type": "סוג המעגל לא מוכר.",
  });
  // create_founder_invite (rpcs.md): the "start your own circle" link a member
  // sends a friend. 3 a day per member; the friend's side of a refused link is
  // join_circle / redeem_invite_code, whose "invalid" text already covers
  // expired and used, because the server does not say which.
  const CIRCLES_FOUNDER_ERROR_TEXT = Object.freeze({
    rate_limited: "יצרת היום 3 קישורים לחברים, וזה המקסימום ליום. אפשר ליצור עוד מחר.",
    "not authorized": "אפשר ליצור קישור רק מחשבון עם פרופיל.",
  });
  /** @param {any} error */
  function circlesFounderErrorText(error) {
    const msg = String((error && error.message) || error || "").trim();
    return /** @type {any} */ (CIRCLES_FOUNDER_ERROR_TEXT)[msg] || "יצירת הקישור נכשלה. אפשר לנסות שוב.";
  }
  /** @param {any} error @param {string} [fallback] */
  function circlesCircleErrorText(error, fallback) {
    const msg = String((error && error.message) || error || "").trim();
    return /** @type {any} */ (CIRCLES_CIRCLE_ERROR_TEXT)[msg] || fallback || "הפעולה לא הושלמה. אפשר לנסות שוב.";
  }

  // ---- Circle types and what each shares by default (mirrors SQL) ------------
  /** @param {string} type */
  function circlesDefaultsFor(type) {
    return type === "couple"
      ? { share_workouts: true, share_prs: true, share_percent: true, share_weekly_count: true, show_weights: false }
      : { share_workouts: false, share_prs: true, share_percent: true, share_weekly_count: true, show_weights: false };
  }
  const CIRCLES_SHARE_KEYS = Object.freeze(["share_workouts", "share_prs", "share_percent", "share_weekly_count", "show_weights"]);
  /**
   * The member's share settings for one circle: the circle type's defaults,
   * overlaid with what circle_members.share_defaults holds.
   * @param {any} circle {type, share_defaults}
   */
  function circlesEffectiveDefaults(circle) {
    const out = /** @type {Record<string, boolean>} */ (Object.assign({}, circlesDefaultsFor(circle && circle.type)));
    const mine = (circle && circle.share_defaults) || {};
    for (const k of CIRCLES_SHARE_KEYS) if (typeof mine[k] === "boolean") out[k] = mine[k];
    return out;
  }

  // ---- The week --------------------------------------------------------------
  /** Sunday-first, Asia/Jerusalem (decisions.md). 'YYYY-MM-DD' of the week's Sunday. */
  function circlesJerusalemParts(/** @type {Date} */ now) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (/** @type {string} */ t) => Number((parts.find((p) => p.type === t) || { value: "0" }).value);
    return { y: get("year"), m: get("month"), d: get("day") };
  }
  function circlesPad2(/** @type {number} */ n) { return String(n).padStart(2, "0"); }
  /** First day of the current month in Asia/Jerusalem, 'YYYY-MM-01'. */
  function circlesBenchmarkMonth(/** @type {Date} */ now) {
    const p = circlesJerusalemParts(now || new Date());
    return p.y + "-" + circlesPad2(p.m) + "-01";
  }
  /** 'YYYY-MM-DD' of the Jerusalem calendar day. */
  function circlesJerusalemDay(/** @type {Date} */ now) {
    const p = circlesJerusalemParts(now || new Date());
    return p.y + "-" + circlesPad2(p.m) + "-" + circlesPad2(p.d);
  }

  /** 'YYYY-MM-DD' of the Sunday on or before a 'YYYY-MM-DD'. */
  function circlesWeekStartOf(/** @type {string} */ day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!m) return "";
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const dow = new Date(t).getUTCDay();
    const d = new Date(t - dow * 86400000);
    return d.getUTCFullYear() + "-" + circlesPad2(d.getUTCMonth() + 1) + "-" + circlesPad2(d.getUTCDate());
  }
  /**
   * How many of the member's training days fall in the week of `today`, on the
   * device, from the private log. Days, not sets: five lifts in one session are
   * one workout.
   * @param {string[]} days
   * @param {string} today
   */
  function circlesDaysThisWeek(days, today) {
    const ws = circlesWeekStartOf(today);
    if (!ws) return 0;
    return new Set((days || []).filter((d) => circlesWeekStartOf(d) === ws)).size;
  }

  /**
   * circle_week rows as a view. Nothing here ranks anyone: the order is the
   * server's (by name), the caller's own row is flagged, never moved.
   * @param {any[]} rows
   * @param {string} myId
   */
  function circlesWeekView(rows, myId) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const paused = !!r.paused;
      const percent = r.percent == null ? null : Number(r.percent);
      const workouts = r.workouts == null ? null : Number(r.workouts);
      return {
        userId: r.user_id,
        name: String(r.display_name || "").trim() || "חבר/ה",
        emoji: r.emoji || "🙂",
        isMe: r.user_id === myId,
        paused: paused,
        percent: paused ? null : percent,
        // The bar never passes full, the number may: 120% is a good week.
        barPercent: paused || percent == null ? 0 : Math.max(0, Math.min(100, percent)),
        workouts: workouts,
        target: r.target == null ? null : Number(r.target),
        weeksMet: r.weeks_met == null ? null : Number(r.weeks_met),
        // A member who shares no weekly count: every number is null and they are
        // not paused. Shown as "not shared", never as 0%.
        hidden: !paused && percent == null && workouts == null,
        noTarget: !paused && percent == null && workouts != null,
      };
    });
  }

  // ---- The feed --------------------------------------------------------------
  /**
   * A circle_feed row as the post object posts.js's card renderers draw.
   * @param {any} row
   */
  function circlesFeedPost(row) {
    const counts = row.reaction_counts && typeof row.reaction_counts === "object" ? row.reaction_counts : {};
    let total = 0;
    for (const k of CIRCLES_REACTION_KINDS) total += Number(counts[k] || 0);
    return {
      id: row.post_id,
      author_id: row.author_id,
      author: { display_name: row.author_name || "", emoji: row.author_emoji || "" },
      post_type: row.post_type,
      title: row.title,
      result_text: row.result_text,
      body: row.body,
      metadata: row.metadata || {},
      occurred_on: row.occurred_on,
      published_at: row.published_at,
      created_at: row.published_at,
      reaction_counts: counts,
      reaction_count: total,
      my_reactions: Array.isArray(row.my_reactions) ? row.my_reactions.slice() : [],
      unreacted_pr: !!row.unreacted_pr,
    };
  }
  /**
   * A workout post with no title is the count-only post a circle that shares
   * "a weekly count" receives (see circlesWorkoutPostRow): it exists so circle_week
   * can count the workout, and is not a card.
   * @param {any} row
   */
  function circlesIsCountOnlyWorkout(row) {
    return !!row && row.post_type === "POST_WORKOUT" && !String(row.title || "").trim();
  }
  /**
   * The feed a circle shows: count-only workouts dropped, and PRs the circle
   * has not reacted to for a day lifted to the top, in the order they came.
   * @param {any[]} rows
   */
  function circlesFeedOrder(rows) {
    const shown = (Array.isArray(rows) ? rows : []).filter((r) => !circlesIsCountOnlyWorkout(r));
    const lifted = shown.filter((r) => r.unreacted_pr);
    const rest = shown.filter((r) => !r.unreacted_pr);
    return lifted.concat(rest);
  }

  // ---- Logging is sharing: which circles, and what leaves the device ----------
  /**
   * What a workout day becomes in ONE circle, or null when that circle gets
   * nothing. The member's setting for that circle always wins and a hidden
   * field is not merely blanked, it is absent: the row below is the entire
   * payload.
   *
   *   share_workouts  -> the lifts and results are sent
   *   else if share_weekly_count -> a count-only post: no title, no result, so
   *                     circle_week can count the day and nothing else is told
   *   else            -> nothing is sent to this circle
   *   show_weights false -> no kilograms anywhere in the text; no score_value,
   *                     comparison_key (absolute numbers are never sent at all)
   *
   * Body weight is not a field of a workout and has no path here.
   *
   * @param {{day: string, lines: Array<{title: string, text: string, textNoWeight: string, rx?: boolean|null}>}} dayItem
   * @param {{id: string}} circle
   * @param {Record<string, boolean>} defaults circlesEffectiveDefaults(circle)
   * @param {string} userId
   */
  function circlesWorkoutPostRow(dayItem, circle, defaults, userId) {
    if (!dayItem || !dayItem.day || !circle || !userId) return null;
    if (!defaults.share_workouts && !defaults.share_weekly_count) return null;
    const row = /** @type {Record<string, any>} */ ({
      author_id: userId,
      club_id: circle.id,
      source_type: "strength_entry",
      source_record_id: "day:" + dayItem.day,
      visibility: "club",
      occurred_on: dayItem.day,
      title: null,
      result_text: null,
      rx: null,
    });
    if (!defaults.share_workouts) return row;
    const lines = (dayItem.lines || []).filter((l) => l && l.title);
    if (!lines.length) return row;
    row.title = lines.length === 1 ? lines[0].title.slice(0, 120) : (lines[0].title + " ועוד " + (lines.length - 1)).slice(0, 120);
    const text = lines.map((l) => {
      const t = defaults.show_weights ? l.text : l.textNoWeight;
      return t ? l.title + " " + t : l.title;
    }).join(" · ");
    row.result_text = text.slice(0, 240) || null;
    row.rx = lines.length === 1 && typeof lines[0].rx === "boolean" ? lines[0].rx : null;
    return row;
  }

  /**
   * The circles a day's workout goes to by default (circlesWorkoutPostRow is not
   * null), minus the ones the member skipped for this day.
   * @param {any[]} circles
   * @param {string[]} skippedIds
   */
  function circlesDefaultWorkoutCircles(circles, skippedIds) {
    const skip = new Set(skippedIds || []);
    return (circles || []).filter((c) => {
      if (skip.has(c.id)) return false;
      const d = circlesEffectiveDefaults(c);
      return d.share_workouts || d.share_weekly_count;
    });
  }

  /**
   * The arguments of pr_share for one circle, or null when this circle does not
   * get PRs. p_weight is present ONLY when the member chose to show weights in
   * this circle; otherwise the post carries the lift and the percent only.
   * @param {{record_id: string, new_value_numeric?: number}} record
   * @param {any} circle
   * @param {string} note
   */
  function circlesPrShareArgs(record, circle, note) {
    const d = circlesEffectiveDefaults(circle);
    if (!d.share_prs || !record || !record.record_id) return null;
    const args = /** @type {Record<string, any>} */ ({ p_club_id: circle.id, record_id: String(record.record_id), note: String(note || "") });
    const w = Number(record.new_value_numeric);
    if (d.show_weights && isFinite(w) && w > 0 && w <= 2000) args.p_weight = Math.round(w * 10) / 10;
    return args;
  }

  /**
   * A benchmark result row list split into Rx and scaled, never ranked.
   * @param {any[]} rows
   */
  function circlesSplitBenchmarkResults(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return {
      rx: list.filter((r) => r.rx_or_scaled === "rx"),
      scaled: list.filter((r) => r.rx_or_scaled === "scaled"),
    };
  }

  const CIRCLES_BENCHMARK_IDS = Object.freeze(["fran", "grace", "helen", "diane", "cindy", "murph", "isabel", "karen"]);

  circlesRoot.CirclesCore = Object.freeze({
    REACTION_KINDS: CIRCLES_REACTION_KINDS,
    REACTION_META: CIRCLES_REACTION_META,
    BENCHMARK_IDS: CIRCLES_BENCHMARK_IDS,
    SHARE_KEYS: CIRCLES_SHARE_KEYS,
    parseInviteHash: circlesParseInviteHash,
    extractInviteToken: circlesExtractInviteToken,
    inviteUrl: circlesInviteUrl,
    joinStatusText: circlesJoinStatusText,
    circleErrorText: circlesCircleErrorText,
    founderErrorText: circlesFounderErrorText,
    JOIN_STATUS_TEXT: CIRCLES_JOIN_STATUS_TEXT,
    defaultsFor: circlesDefaultsFor,
    effectiveDefaults: circlesEffectiveDefaults,
    benchmarkMonth: circlesBenchmarkMonth,
    jerusalemDay: circlesJerusalemDay,
    weekStartOf: circlesWeekStartOf,
    daysThisWeek: circlesDaysThisWeek,
    weekView: circlesWeekView,
    feedPost: circlesFeedPost,
    isCountOnlyWorkout: circlesIsCountOnlyWorkout,
    feedOrder: circlesFeedOrder,
    workoutPostRow: circlesWorkoutPostRow,
    defaultWorkoutCircles: circlesDefaultWorkoutCircles,
    prShareArgs: circlesPrShareArgs,
    splitBenchmarkResults: circlesSplitBenchmarkResults,
  });
