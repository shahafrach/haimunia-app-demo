// src/progress.js: the numbers behind the post-workout moment and the Progress
// tab. Pure functions, so no browser: PR rules, the 10-rep ceiling on estimates,
// Sunday weeks, the ring's wording, the comparison to last time, and the Rx and
// scaled split.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = require("../src/progress.js");

let n = 0;
const set = (date, weight, reps, extra = {}) => ({ id: "s" + ++n, exerciseId: "back-squat", date, ts: Date.parse(date + "T08:00:00Z") + n, type: "reps", weight, reps, sets: 1, ...extra });

test("estimated 1RM exists only for sets of 10 reps or fewer", () => {
  assert.equal(P.E1RM_MAX_REPS, 10);
  assert.equal(P.e1rmEligible(set("2026-10-01", 100, 10)), true);
  assert.equal(P.e1rmEligible(set("2026-10-01", 100, 11)), false);
  assert.equal(P.e1rmEligible(set("2026-10-01", 100, 0)), false);
  assert.equal(P.e1rmEligible(set("2026-10-01", 0, 5)), false);
  assert.equal(P.e1rmEligible(set("2026-10-01", 20, 5, { type: "duration" })), false);
  const series = P.e1rmSeries([set("2026-10-01", 100, 5), set("2026-10-01", 60, 15), set("2026-10-08", 90, 20), set("2026-10-15", 110, 3)]);
  assert.deepEqual(series.map((p) => p.date), ["2026-10-01", "2026-10-15"], "a day with only 15+ rep sets has no point");
  assert.equal(series[0].e1rm, 116.7);
  assert.equal(series[0].real, false);
  assert.equal(P.e1rmSeries([set("2026-10-20", 130, 1)])[0].real, true, "a single is a tested max");
});

test("the best estimate of the day wins, not the last set", () => {
  const s = P.e1rmSeries([set("2026-10-01", 100, 5), set("2026-10-01", 80, 5)]);
  assert.equal(s.length, 1);
  assert.equal(s[0].weight, 100);
});

test("a PR is more weight than any earlier set at the same reps, with the percent over it", () => {
  const list = [set("2026-09-01", 100, 5), set("2026-09-08", 100, 5), set("2026-09-15", 102.5, 5), set("2026-09-22", 105, 5), set("2026-09-29", 90, 8), set("2026-10-06", 110, 5)];
  const prs = P.repMaxPrs(list);
  assert.deepEqual(prs.map((p) => [p.date, p.weight, p.prev, p.pct]), [["2026-09-22", 105, 102.5, 2.4], ["2026-10-06", 110, 105, 4.8]]);
});

test("nothing is a PR before there is history, or the first time at a rep count", () => {
  assert.deepEqual(P.repMaxPrs([set("2026-09-01", 100, 5), set("2026-09-08", 105, 5)]), [], "fewer than 3 earlier sets");
  const list = [set("2026-09-01", 100, 5), set("2026-09-02", 100, 5), set("2026-09-03", 100, 5), set("2026-09-04", 120, 3)];
  assert.deepEqual(P.repMaxPrs(list), [], "first set at 3 reps has nothing to beat");
  assert.equal(P.repMaxPrs([set("2026-09-01", 100, 5), set("2026-09-02", 105, 5)], { minPrior: 1 }).length, 1);
});

test("percentImprovement is null without an earlier value", () => {
  assert.equal(P.percentImprovement(0, 50), null);
  assert.equal(P.percentImprovement(100, 105), 5);
  assert.equal(P.percentImprovement(80, 82.5), 3.1);
});

test("weeks start on Sunday", () => {
  assert.equal(P.weekStartOf("2026-10-28"), "2026-10-25"); // a Wednesday
  assert.equal(P.weekStartOf("2026-10-25"), "2026-10-25"); // the Sunday itself
  assert.equal(P.weekStartOf("2026-10-24"), "2026-10-18"); // Saturday belongs to the week before
  assert.equal(P.daysInWeek(["2026-10-25", "2026-10-25", "2026-10-27", "2026-10-24"], "2026-10-25"), 2, "distinct days, this week only");
});

test("weeksYear: met, partial, empty, and a missed week resets nothing", () => {
  const days = ["2026-09-06", "2026-09-08", "2026-09-10", "2026-09-13", "2026-09-27", "2026-09-29", "2026-10-04", "2026-10-06", "2026-10-08", "2026-10-25"];
  const y = P.weeksYear(days, 3, "2026-10-28");
  assert.equal(y.weeks.length, 52);
  assert.equal(y.weeks.at(-1).current, true);
  const byStart = Object.fromEntries(y.weeks.map((w) => [w.weekStart, w]));
  assert.equal(byStart["2026-09-06"].met, true);
  assert.equal(byStart["2026-09-13"].met, false, "one day: partial");
  assert.equal(byStart["2026-09-13"].fraction.toFixed(2), "0.33");
  assert.equal(byStart["2026-09-20"].count, 0, "a missed week is just empty");
  assert.equal(byStart["2026-10-04"].met, true);
  assert.equal(y.metCount, 2);
  assert.equal(y.bestRun, 1);
  assert.equal(y.weeks[0].before, true, "weeks before the first log count toward nothing");
  assert.equal(byStart["2026-09-20"].before, false);
});

test("ringCopy shows what is done early and what is left late", () => {
  assert.deepEqual([P.ringCopy(2, 5).framing, P.ringCopy(2, 5).title], ["done", "2 אימונים בוצעו"]);
  assert.deepEqual([P.ringCopy(4, 5).framing, P.ringCopy(4, 5).title], ["left", "נשאר אימון אחד"]);
  assert.equal(P.ringCopy(3, 5).title, "נשארו 2 אימונים");
  assert.equal(P.ringCopy(1, 5).title, "אימון אחד בוצע");
  assert.equal(P.ringCopy(0, 4).framing, "fresh");
  assert.equal(P.ringCopy(5, 5).met, true);
  assert.equal(P.ringCopy(6, 5).fraction, 1);
  assert.equal(P.ringCopy(2, 0).framing, "none");
  for (const [d, t] of [[0, 3], [1, 3], [2, 3], [3, 3], [1, 7], [4, 7]]) {
    const c = P.ringCopy(d, t);
    assert.ok(!/חסר|פיגור|החמצ|נכשל/.test(c.title + c.sub + c.small), "no deficit word");
  }
});

test("compareToLast: up, flat, lower (never worse), and a first time", () => {
  const prevSets = [set("2026-10-01", 100, 5), set("2026-10-01", 90, 8)];
  assert.equal(P.compareToLast([set("2026-10-08", 105, 5)], prevSets).trend, "up");
  assert.equal(P.compareToLast([set("2026-10-08", 105, 5)], prevSets).deltaKg, 5);
  assert.equal(P.compareToLast([set("2026-10-08", 100, 5)], prevSets).trend, "flat");
  assert.equal(P.compareToLast([set("2026-10-08", 100, 6)], prevSets).trend, "up", "same weight, more reps");
  const lower = P.compareToLast([set("2026-10-08", 97.5, 5)], prevSets);
  assert.equal(lower.trend, "lower");
  assert.equal(lower.deltaKg, -2.5);
  assert.equal(P.compareToLast([set("2026-10-08", 60, 5)], []).trend, "new");
});

test("workoutMoment: level 1 for a PR, level 2 when the week is met, level 0 otherwise", () => {
  const history = [set("2026-10-01", 100, 5), set("2026-10-02", 100, 5), set("2026-10-04", 102.5, 5), set("2026-10-06", 105, 5)];
  const names = (id) => (id === "back-squat" ? "Back Squat" : id);
  const days = [...new Set(history.map((e) => e.date))];
  const quiet = P.workoutMoment({ entries: [...history, set("2026-10-28", 100, 5)], date: "2026-10-28", target: 3, trainingDays: days, nameOf: names });
  assert.equal(quiet.level, 0);
  assert.equal(quiet.prs.length, 0);
  assert.equal(quiet.week.done, 1);
  assert.equal(quiet.week.framing, "done");

  const pr = P.workoutMoment({ entries: [...history, set("2026-10-28", 107.5, 5)], date: "2026-10-28", target: 3, trainingDays: days, nameOf: names });
  assert.equal(pr.level, 1);
  assert.equal(pr.prs[0].name, "Back Squat");
  assert.equal(pr.prs[0].pct, 2.4);
  assert.equal(pr.lifts[0].cmp.trend, "up");
  assert.equal(pr.sessionNumber, 5);

  const week = P.workoutMoment({ entries: [...history, set("2026-10-28", 100, 5)], date: "2026-10-28", target: 2, trainingDays: [...days, "2026-10-26"], nameOf: names });
  assert.equal(week.week.weekJustMet, true);
  assert.equal(week.level, 2);

  const already = P.workoutMoment({ entries: [...history, set("2026-10-28", 100, 5)], date: "2026-10-28", target: 2, trainingDays: [...days, "2026-10-26", "2026-10-27"], nameOf: names });
  assert.equal(already.week.weekJustMet, false, "the burst is for the set that completes the week, once");
  assert.equal(already.level, 0);

  assert.equal(P.workoutMoment({ entries: [set("2026-10-28", 50, 5)], date: "2026-10-28", target: 0, trainingDays: [], benchmarkPr: true }).level, 2, "a benchmark PR is level 2");
});

test("Rx and scaled are separate lists; Rx+ rides with Rx", () => {
  const a = [{ id: 1, effort: true }, { id: 2, effort: false }, { id: 3, effort: "plus" }, { id: 4, effort: false }];
  const { rx, scaled } = P.splitBenchmarkAttempts(a);
  assert.deepEqual(rx.map((x) => x.id), [1, 3]);
  assert.deepEqual(scaled.map((x) => x.id), [2, 4]);
});
