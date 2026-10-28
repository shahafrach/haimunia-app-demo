// @ts-check
"use strict";
// ---- Progress: the numbers behind the post-workout moment and the Progress tab
//
// Pure: arrays in, plain objects out. No DOM, no storage, no clock (callers pass
// `today`), so test/progress.test.mjs runs it with no browser. app.js draws what
// this returns.
//
// The rules it keeps (docs/circles/decisions.md, docs/design/research.md):
//   * A PR is a real rep-max record: more weight than any earlier set at the
//     same rep count. A first time at a rep count is not a PR (nothing to beat),
//     and nothing is a PR before there is history (minPrior sets of that lift).
//   * An estimated 1RM exists only for sets of 10 reps or fewer, and is always
//     called an estimate. Above 10 reps the formulas stop being trustworthy.
//   * The week starts on Sunday. Counting weeks met never resets anything and a
//     missed week is just a neutral empty square.
//   * A lower result is "flat or lower", never bad: no word or color of failure.
//
// Classic <script>, wrapped in an IIFE; publishes window.BoxLogProgress and, for
// the Node tests, module.exports.

(function () {
  const E1RM_MAX_REPS = 10;
  const DAY_MS = 86400000;

  /** @typedef {{id?: string, exerciseId?: string, date: string, ts?: number, type?: string, weight: number, reps: number, sets?: number, est1RM?: number, isPR?: boolean}} SetEntry */

  /** @param {unknown} n */
  const num = (n) => (typeof n === "number" && isFinite(n) ? n : 0);
  /** @param {number} x */
  const round1 = (x) => Math.round(x * 10) / 10;

  /** Epley, the formula the log screen already uses. @param {number} weight @param {number} reps */
  function epley(weight, reps) {
    if (reps <= 1) return weight;
    return Math.round(weight * (1 + reps / 30) * 10) / 10;
  }

  /** A set an estimate may be made from: weighted, reps mode, 1 to 10 reps. @param {SetEntry} e */
  function e1rmEligible(e) {
    return !!e && e.type !== "duration" && num(e.weight) > 0 && num(e.reps) >= 1 && num(e.reps) <= E1RM_MAX_REPS;
  }

  /** @param {SetEntry} a @param {SetEntry} b */
  function byTime(a, b) {
    return String(a.date).localeCompare(String(b.date)) || num(a.ts) - num(b.ts);
  }

  /**
   * One point per day for one lift: the best estimate of that day, from eligible
   * sets only. `real` is true when the day's best set was a single (reps = 1), a
   * tested max rather than an estimate.
   * @param {SetEntry[]} list every entry of ONE exercise
   * @returns {{date: string, e1rm: number, weight: number, reps: number, real: boolean}[]}
   */
  function e1rmSeries(list) {
    /** @type {Map<string, {date: string, e1rm: number, weight: number, reps: number, real: boolean}>} */
    const byDay = new Map();
    for (const e of list) {
      if (!e1rmEligible(e)) continue;
      const est = epley(e.weight, e.reps);
      const cur = byDay.get(e.date);
      if (!cur || est > cur.e1rm) byDay.set(e.date, { date: e.date, e1rm: est, weight: e.weight, reps: e.reps, real: e.reps === 1 });
    }
    return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** (now - prev) / prev as a percent with one decimal. null when there is no earlier value. @param {number} prev @param {number} now */
  function percentImprovement(prev, now) {
    if (!(prev > 0) || !isFinite(now)) return null;
    return Math.round(((now - prev) / prev) * 1000) / 10;
  }

  /**
   * Every real rep-max PR of one lift, oldest first. Each carries the previous
   * record at the same rep count and the percent improvement over it.
   * @param {SetEntry[]} list every entry of ONE exercise
   * @param {{minPrior?: number}} [opts] sets that must exist before anything can be a PR
   * @returns {{id: string, date: string, ts: number, weight: number, reps: number, prev: number, pct: number}[]}
   */
  function repMaxPrs(list, opts) {
    const minPrior = opts && typeof opts.minPrior === "number" ? opts.minPrior : 3;
    const sorted = list.filter((e) => e.type !== "duration" && num(e.reps) >= 1 && num(e.weight) > 0).slice().sort(byTime);
    /** @type {Record<number, number>} */
    const best = {};
    const out = [];
    sorted.forEach((e, idx) => {
      const prev = best[e.reps] || 0;
      if (prev > 0 && e.weight > prev && idx >= minPrior) {
        out.push({ id: String(e.id || ""), date: e.date, ts: num(e.ts), weight: e.weight, reps: e.reps, prev, pct: /** @type {number} */ (percentImprovement(prev, e.weight)) });
      }
      if (e.weight > prev) best[e.reps] = e.weight;
    });
    return out;
  }

  // ---- Weeks (Sunday start) ---------------------------------------------------
  /** @param {string} iso */
  function parseDay(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  }
  /** @param {Date} d */
  function dayISO(d) { return d.toISOString().slice(0, 10); }
  /** The Sunday on or before a day. @param {string} iso */
  function weekStartOf(iso) {
    const d = parseDay(iso);
    return dayISO(new Date(d.getTime() - d.getUTCDay() * DAY_MS));
  }
  /** @param {string} iso @param {number} n */
  function addDays(iso, n) { return dayISO(new Date(parseDay(iso).getTime() + n * DAY_MS)); }

  /** Days trained in the week that starts at `weekStart`. @param {string[]} days distinct ISO days @param {string} weekStart */
  function daysInWeek(days, weekStart) {
    const end = addDays(weekStart, 6);
    return new Set(days.filter((d) => d >= weekStart && d <= end)).size;
  }

  /**
   * The year of weeks, oldest first. A week before the first logged day is
   * "before": an empty outline that counts toward nothing. A week below target is
   * "partial" and carries its fraction. Nothing here ever goes negative.
   * @param {string[]} days every training day
   * @param {number} target workouts per week (0 or less: no target)
   * @param {string} today ISO
   * @param {number} [weeks]
   */
  function weeksYear(days, target, today, weeks) {
    const n = weeks || 52;
    const distinct = [...new Set(days)].sort();
    const first = distinct[0] || null;
    const thisWeek = weekStartOf(today);
    /** @type {{weekStart: string, count: number, met: boolean, fraction: number, before: boolean, current: boolean}[]} */
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const ws = addDays(thisWeek, -7 * i);
      const count = daysInWeek(distinct, ws);
      const before = !first || addDays(ws, 6) < first;
      const met = target > 0 && count >= target;
      out.push({ weekStart: ws, count, met, fraction: target > 0 ? Math.min(1, count / target) : 0, before, current: i === 0 });
    }
    let metCount = 0, run = 0, bestRun = 0;
    for (const w of out) {
      if (w.met) { metCount++; run++; if (run > bestRun) bestRun = run; } else if (!w.current) run = 0;
    }
    return { weeks: out, metCount, bestRun };
  }

  /**
   * The ring's wording. Show whichever share is smaller (Koo and Fishbach): early
   * in the week what is done, near the end what is left. Never a deficit word.
   * @param {number} done @param {number} target
   * @returns {{big: string, small: string, title: string, sub: string, met: boolean, fraction: number, framing: "none"|"fresh"|"done"|"left"|"met"}}
   */
  function ringCopy(done, target) {
    const d = Math.max(0, Math.floor(done));
    if (!(target > 0)) {
      return { big: String(d), small: d === 1 ? "אימון" : "אימונים", title: d === 1 ? "אימון אחד השבוע" : `${d} אימונים השבוע`, sub: "אפשר לקבוע יעד שבועי בהגדרות המעגל", met: false, fraction: 0, framing: "none" };
    }
    const fraction = Math.min(1, d / target);
    if (d >= target) {
      return { big: String(d), small: "היעד הושג", title: "היעד השבועי הושג", sub: `${d} מתוך ${target} אימונים`, met: true, fraction: 1, framing: "met" };
    }
    if (d === 0) {
      return { big: "0", small: `מתוך ${target}`, title: "שבוע חדש", sub: `היעד: ${target} אימונים`, met: false, fraction: 0, framing: "fresh" };
    }
    if (d * 2 <= target) {
      return { big: String(d), small: d === 1 ? "בוצע" : "בוצעו", title: d === 1 ? "אימון אחד בוצע" : `${d} אימונים בוצעו`, sub: `מתוך ${target} אימונים`, met: false, fraction, framing: "done" };
    }
    const left = target - d;
    return { big: String(left), small: left === 1 ? "נשאר" : "נשארו", title: left === 1 ? "נשאר אימון אחד" : `נשארו ${left} אימונים`, sub: `${d} מתוך ${target} אימונים`, met: false, fraction, framing: "left" };
  }

  // ---- The moment -----------------------------------------------------------------
  /** The heaviest set, ties to more reps. @param {SetEntry[]} sets */
  function topSet(sets) {
    const list = sets.filter((e) => e.type !== "duration" && num(e.reps) > 0);
    if (!list.length) return null;
    return list.reduce((best, e) => (e.weight !== best.weight ? (e.weight > best.weight ? e : best) : (e.reps > best.reps ? e : best)));
  }

  /**
   * Today against the last time, per lift.
   * @param {SetEntry[]} todays sets of one lift, logged on `date`
   * @param {SetEntry[]} earlier every earlier set of that lift (any date before `date`)
   */
  function compareToLast(todays, earlier) {
    const now = topSet(todays);
    if (!now) return null;
    const lastDate = earlier.filter((e) => e.date < now.date).map((e) => e.date).sort().pop() || null;
    const prevSets = lastDate ? earlier.filter((e) => e.date === lastDate) : [];
    const prev = topSet(prevSets);
    if (!prev) return { now: { weight: now.weight, reps: now.reps }, prev: null, deltaKg: 0, trend: /** @type {"new"} */ ("new") };
    const deltaKg = round1(now.weight - prev.weight);
    const trend = deltaKg > 0 || (deltaKg === 0 && now.reps > prev.reps) ? "up" : deltaKg === 0 && now.reps === prev.reps ? "flat" : "lower";
    return { now: { weight: now.weight, reps: now.reps }, prev: { weight: prev.weight, reps: prev.reps, date: prev.date }, deltaKg, trend };
  }

  /**
   * Everything the post-workout screen shows, in the order it shows it.
   * @param {{entries: SetEntry[], date: string, target: number, trainingDays: string[], nameOf?: (id: string) => string, benchmarkPr?: boolean, minPrior?: number}} input
   */
  function workoutMoment(input) {
    const { entries, date, target, trainingDays } = input;
    const nameOf = input.nameOf || ((id) => id);
    const todays = entries.filter((e) => e.date === date && e.type !== "duration");
    const ids = [...new Set(todays.map((e) => String(e.exerciseId)))];
    const lifts = ids.map((id) => {
      const mine = entries.filter((e) => String(e.exerciseId) === id);
      const t = todays.filter((e) => String(e.exerciseId) === id);
      const earlier = mine.filter((e) => e.date < date);
      const prs = repMaxPrs(mine, { minPrior: input.minPrior }).filter((p) => p.date === date);
      const bestPr = prs.length ? prs.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
      return { id, name: nameOf(id), cmp: compareToLast(t, earlier), pr: bestPr, sets: t.length };
    });
    const prs = lifts.filter((l) => l.pr).map((l) => ({ id: l.id, name: l.name, ...(/** @type {NonNullable<typeof l.pr>} */ (l.pr)) })).sort((a, b) => b.pct - a.pct);
    const allDays = [...new Set([...trainingDays, date])];
    const weekStart = weekStartOf(date);
    const done = daysInWeek(allDays, weekStart);
    const before = daysInWeek(allDays.filter((d) => d !== date), weekStart);
    const weekJustMet = target > 0 && done >= target && before < target;
    const level = weekJustMet || input.benchmarkPr ? 2 : prs.length ? 1 : 0;
    const volume = todays.reduce((sum, e) => sum + num(e.weight) * num(e.reps) * Math.max(1, num(e.sets)), 0);
    return {
      date,
      level: /** @type {0|1|2} */ (level),
      prs,
      lifts,
      sessionNumber: allDays.length,
      sets: todays.reduce((s, e) => s + Math.max(1, num(e.sets)), 0),
      volume: Math.round(volume),
      week: Object.assign({ done, target, weekJustMet }, ringCopy(done, target)),
    };
  }

  // ---- Benchmarks: Rx and scaled never share a list ------------------------------------
  /**
   * @param {{effort: unknown}[]} attempts newest or oldest first, kept as given
   * @returns {{rx: any[], scaled: any[]}} Rx+ rides with Rx (it is Rx, and more); scaled stands alone
   */
  function splitBenchmarkAttempts(attempts) {
    const rx = [], scaled = [];
    for (const a of attempts) (a.effort === false ? scaled : rx).push(a);
    return { rx, scaled };
  }

  const api = {
    E1RM_MAX_REPS, epley, e1rmEligible, e1rmSeries, percentImprovement, repMaxPrs,
    weekStartOf, addDays, daysInWeek, weeksYear, ringCopy, topSet, compareToLast, workoutMoment, splitBenchmarkAttempts,
  };
  if (typeof window !== "undefined") /** @type {any} */ (window).BoxLogProgress = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
