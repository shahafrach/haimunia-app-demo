// The pure rules of the circles client (src/community/circles-core.js), run with
// no browser and no network: where an invite token may be read from, what a
// workout is allowed to send to each circle, how the week and the feed are
// shaped. The privacy rule is here because it is a function of its arguments
// and nothing else: "hidden fields are never sent" is checked on the row.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
new Function(readFileSync(new URL("../src/community/circles-core.js", import.meta.url), "utf8"))();
const C = globalThis.CirclesCore;

const TOKEN = "cd".repeat(32);

test("an invite token is read from the fragment, in three shapes, and from nowhere else", () => {
  assert.equal(C.parseInviteHash("#invite=" + TOKEN), TOKEN);
  assert.equal(C.parseInviteHash("#join=" + TOKEN.toUpperCase()), TOKEN);
  assert.equal(C.parseInviteHash("#" + TOKEN), TOKEN);
  assert.equal(C.parseInviteHash(""), null);
  assert.equal(C.parseInviteHash("#section=" + TOKEN), null, "an unknown key is not an invite");
  assert.equal(C.parseInviteHash("#invite=" + TOKEN.slice(2)), null, "63 hex characters is not a token");
  assert.equal(C.parseInviteHash("#invite=" + "zz".repeat(32)), null);
});

test("a pasted link yields its fragment token; a token in a query string is ignored", () => {
  assert.equal(C.extractInviteToken("https://box-log.example/app/#invite=" + TOKEN), TOKEN);
  assert.equal(C.extractInviteToken("  " + TOKEN + "  "), TOKEN);
  assert.equal(C.extractInviteToken("https://box-log.example/?invite=" + TOKEN), null, "the query string is never a source");
  assert.equal(C.extractInviteToken("hello"), null);
});

test("the shared link puts the token after #, never in the query", () => {
  const url = C.inviteUrl("https://box-log.example/app/?x=1#old", TOKEN);
  assert.equal(url, "https://box-log.example/app/?x=1#invite=" + TOKEN);
  assert.ok(!new URL(url).search.includes(TOKEN));
});

test("every join status has Hebrew copy, and an unknown one does not leak the raw string", () => {
  for (const s of ["invalid", "circle_full", "too_many_circles", "rate_limited", "already_member"]) {
    const t = C.joinStatusText(s);
    assert.match(t, /[א-ת]/, s);
    assert.ok(!t.includes(s), `${s} must not be printed to a member`);
  }
  assert.notEqual(C.joinStatusText("invalid"), C.joinStatusText("rate_limited"));
  assert.match(C.joinStatusText("whatever"), /[א-ת]/);
});

const friends = { id: "c1", type: "friends", share_defaults: {} };
const couple = { id: "c2", type: "couple", share_defaults: {} };
const day = {
  day: "2026-10-26",
  lines: [
    { title: "סקוואט", text: "100 ק״ג × 5 × 3", textNoWeight: "5 × 3", rx: null },
    { title: "Fran", text: "4:35", textNoWeight: "4:35", rx: true },
  ],
};

test("type defaults mirror the database: couples share workouts, friends share a count", () => {
  assert.deepEqual(C.defaultsFor("couple"), { share_workouts: true, share_prs: true, share_percent: true, share_weekly_count: true, show_weights: false });
  assert.equal(C.defaultsFor("friends").share_workouts, false);
  assert.equal(C.defaultsFor("friends").show_weights, false);
  assert.equal(C.effectiveDefaults({ type: "friends", share_defaults: { share_workouts: true } }).share_workouts, true);
});

test("a couple circle receives the workout, with no kilograms unless the member chose to show them", () => {
  const row = C.workoutPostRow(day, couple, C.effectiveDefaults(couple), "u1");
  assert.equal(row.club_id, "c2");
  assert.equal(row.source_record_id, "day:2026-10-26");
  assert.equal(row.title, "סקוואט ועוד 1");
  assert.ok(row.result_text.includes("5 × 3"));
  assert.ok(!/ק״ג/.test(row.result_text), "no absolute weight in the text");
  const shown = C.workoutPostRow(day, couple, Object.assign(C.effectiveDefaults(couple), { show_weights: true }), "u1");
  assert.ok(shown.result_text.includes("100 ק״ג"));
});

test("a friends circle receives a count-only post: no title, no result, nothing else", () => {
  const row = C.workoutPostRow(day, friends, C.effectiveDefaults(friends), "u1");
  assert.equal(row.title, null);
  assert.equal(row.result_text, null);
  assert.equal(row.rx, null);
  assert.deepEqual(Object.keys(row).sort(), ["author_id", "club_id", "occurred_on", "result_text", "rx", "source_record_id", "source_type", "title", "visibility"]);
});

test("absolute numbers, scores and body weight are not fields of any row", () => {
  for (const c of [friends, couple]) {
    for (const showWeights of [false, true]) {
      const row = C.workoutPostRow(day, c, Object.assign(C.effectiveDefaults(c), { show_weights: showWeights, share_workouts: true }), "u1");
      for (const k of ["score_value", "comparison_key", "score_direction", "body_weight", "bodyweight", "weight"]) {
        assert.ok(!(k in row), `${k} must never be sent`);
      }
    }
  }
});

test("a circle that takes neither workouts nor the weekly count gets nothing", () => {
  const off = Object.assign(C.effectiveDefaults(friends), { share_workouts: false, share_weekly_count: false });
  assert.equal(C.workoutPostRow(day, friends, off, "u1"), null);
  const circles = [
    { id: "a", type: "friends", share_defaults: { share_weekly_count: false } },
    { id: "b", type: "couple", share_defaults: {} },
    { id: "c", type: "friends", share_defaults: {} },
  ];
  assert.deepEqual(C.defaultWorkoutCircles(circles, []).map((c) => c.id), ["b", "c"]);
  assert.deepEqual(C.defaultWorkoutCircles(circles, ["b"]).map((c) => c.id), ["c"], "a skipped circle is left out");
});

test("a WOD whose only result is a weight loses it, and the line keeps its name", () => {
  const wod = { day: "2026-10-26", lines: [{ title: "Max clean", text: "90 ק״ג", textNoWeight: "", rx: true }] };
  const row = C.workoutPostRow(wod, couple, C.effectiveDefaults(couple), "u1");
  assert.equal(row.result_text, "Max clean");
  assert.equal(row.rx, true);
});

test("pr_share carries p_weight only where weights are shown, and only to circles that take PRs", () => {
  const record = { record_id: "e1", new_value_numeric: 102.5 };
  const hidden = C.prShareArgs(record, friends, "");
  assert.deepEqual(hidden, { p_club_id: "c1", record_id: "e1", note: "" });
  assert.ok(!("p_weight" in hidden));
  const shown = C.prShareArgs(record, { id: "c1", type: "friends", share_defaults: { show_weights: true } }, "יפה");
  assert.equal(shown.p_weight, 102.5);
  assert.equal(shown.note, "יפה");
  assert.equal(C.prShareArgs(record, { id: "c1", type: "friends", share_defaults: { share_prs: false } }, ""), null);
});

test("the week view never ranks, marks paused members and shows weeks met", () => {
  const rows = [
    { user_id: "u2", display_name: "בן", emoji: "🦁", workouts: 2, target: null, percent: 67, paused: false, weeks_met: 3 },
    { user_id: "u1", display_name: "אני", emoji: "💪", workouts: 5, target: 3, percent: 167, paused: false, weeks_met: 1 },
    { user_id: "u3", display_name: "גל", emoji: "🌿", workouts: null, target: null, percent: null, paused: true, weeks_met: null },
    { user_id: "u4", display_name: "נועה", emoji: "🐺", workouts: null, target: null, percent: null, paused: false, weeks_met: null },
  ];
  const v = C.weekView(rows, "u1");
  assert.deepEqual(v.map((m) => m.userId), ["u2", "u1", "u3", "u4"], "the server's order is kept");
  assert.equal(v[1].isMe, true);
  assert.equal(v[1].percent, 167);
  assert.equal(v[1].barPercent, 100, "the bar stops at full, the number does not");
  assert.equal(v[2].paused, true);
  assert.equal(v[2].percent, null);
  assert.equal(v[3].hidden, true, "a member who shares no count is 'not shared', not 0%");
  assert.equal(v[0].weeksMet, 3);
});

test("this week is counted in days, Sunday first", () => {
  assert.equal(C.weekStartOf("2026-10-25"), "2026-10-25", "25 October 2026 is a Sunday");
  assert.equal(C.weekStartOf("2026-10-31"), "2026-10-25");
  assert.equal(C.weekStartOf("2026-11-01"), "2026-11-01");
  assert.equal(C.daysThisWeek(["2026-10-25", "2026-10-25", "2026-10-28", "2026-10-24"], "2026-10-30"), 2);
  assert.equal(C.benchmarkMonth(new Date("2026-10-31T23:30:00Z")), "2026-11-01", "Jerusalem is already in November");
});

test("the feed lifts unreacted PRs and hides count-only workouts", () => {
  const rows = [
    { post_id: "1", post_type: "POST_WORKOUT", title: "אימון", unreacted_pr: false },
    { post_id: "2", post_type: "POST_WORKOUT", title: null, unreacted_pr: false },
    { post_id: "3", post_type: "POST_PR", title: "סקוואט", unreacted_pr: true },
    { post_id: "4", post_type: "POST_PR", title: "מתח", unreacted_pr: false },
  ];
  assert.deepEqual(C.feedOrder(rows).map((r) => r.post_id), ["3", "1", "4"]);
  const post = C.feedPost({ post_id: "3", author_id: "u", author_name: "דנה", author_emoji: "🦁", post_type: "POST_PR", reaction_counts: { fist_bump: 2, clap: 1 }, my_reactions: ["clap"], published_at: "2026-10-26T10:00:00Z", unreacted_pr: true });
  assert.equal(post.reaction_count, 3);
  assert.deepEqual(post.my_reactions, ["clap"]);
  assert.equal(post.author.emoji, "🦁");
});

test("there are exactly three reaction kinds, in the order the decisions give", () => {
  assert.deepEqual([...C.REACTION_KINDS], ["fist_bump", "fire", "clap"]);
  assert.deepEqual(Object.keys(C.REACTION_META), ["fist_bump", "fire", "clap"]);
});
