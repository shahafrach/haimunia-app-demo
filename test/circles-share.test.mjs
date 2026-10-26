// Logging is sharing (docs/circles/decisions.md, Sharing): a saved workout goes
// to the circles in the member's share settings, a per-workout control changes
// the circles for that workout, hidden fields are never sent, body weight never
// leaves the device, and offline the posts queue and go when the connection
// returns. The PR and medal prompts choose circles and call pr_share/ach_share
// with p_club_id. Real app.js, cloud.js and src/community/*; a stubbed client.
import { test } from "node:test";
import assert from "node:assert";
import { createCirclesMock, bootCommunity, waitFor, tick, click, membership, ME, CIRCLE_A, CIRCLE_B } from "./helpers/circles.mjs";

const FRIENDS = () => membership({ id: CIRCLE_A, name: "החבר'ה", type: "friends" });
const COUPLE = (defaults) => membership({ id: CIRCLE_B, name: "הזוג", type: "couple", emoji: "💞" }, { share_defaults: defaults || {} });

// Spy on the one table write, and give every row an id the way Postgres would.
function spyOnPosts(mock) {
  const upserts = [];
  const from = mock.client.from;
  mock.client.from = (table) => {
    const b = from(table);
    if (table === "workout_posts") {
      const up = b.upsert;
      b.upsert = (payload, opts) => {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const p of list) p.id = p.id || `post-${p.club_id}-${p.source_record_id}`;
        upserts.push({ payload: JSON.parse(JSON.stringify(payload)), opts });
        return up.call(b, payload, opts);
      };
    }
    return b;
  };
  return upserts;
}

async function ready(mock, opts) {
  const window = await bootCommunity(mock, Object.assign({ syncEnabled: false }, opts || {}));
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityCircleIds().length === mock.db.circle_members.length, 3000);
  return window;
}
async function logSet(window, weight, reps = 5, sets = 1) {
  window.applyFieldValue("step", "weight", weight);
  window.applyFieldValue("step", "reps", reps);
  window.applyFieldValue("step", "sets", sets);
  await window.saveSet();
}
async function clearDecks(window, ms = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const overlay = window.document.getElementById("celebrationOverlay");
    if (overlay && overlay.classList.contains("open")) { window.closeCelebration(); continue; }
    const answer = window.document.querySelector('[data-community-action="ach-not-now"], [data-community-action="pr-not-now"]');
    if (answer) { answer.click(); continue; }
    await tick(20);
  }
}

test("a saved workout is posted to the circles in the member's share settings, with the new conflict key and a club_id", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS(), COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Share Deadlift", "Deadlift");
  await logSet(window, 100);
  await waitFor(() => upserts.length === 2, 4000);
  for (const u of upserts) assert.equal(u.opts.onConflict, "author_id,club_id,source_type,source_record_id");
  const byClub = Object.fromEntries(upserts.map((u) => [u.payload.club_id, u.payload]));
  assert.ok(byClub[CIRCLE_A] && byClub[CIRCLE_B], "one post per circle, each with its own club_id");
  assert.match(byClub[CIRCLE_A].source_record_id, /^day:\d{4}-\d{2}-\d{2}$/, "a workout is a day, so five lifts are one workout");
  assert.equal(byClub[CIRCLE_A].author_id, ME);
});

test("a friends circle gets a count only; a couple circle gets the lift without its kilograms", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS(), COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Hidden Deadlift", "Deadlift");
  await logSet(window, 123.5, 5, 3);
  await waitFor(() => upserts.length === 2, 4000);
  const friends = upserts.find((u) => u.payload.club_id === CIRCLE_A).payload;
  const couple = upserts.find((u) => u.payload.club_id === CIRCLE_B).payload;
  assert.equal(friends.title, null);
  assert.equal(friends.result_text, null);
  assert.equal(couple.title, "Hidden Deadlift");
  assert.match(couple.result_text, /5 × 3/);
  // The member's number is nowhere in what was sent, in any form.
  const wire = JSON.stringify(upserts.map((u) => u.payload));
  assert.ok(!wire.includes("123.5") && !wire.includes("123"), "the absolute weight is not sent where it is not shown");
  assert.ok(!/ק״ג/.test(wire));
  for (const u of upserts) for (const k of ["score_value", "comparison_key", "score_direction", "bodyweight", "body_weight"]) assert.ok(!(k in u.payload), k);
});

test("weights are sent only to a circle where the member chose to show them", async () => {
  const mock = createCirclesMock({ circles: [COUPLE({ show_weights: true })] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Shown Deadlift", "Deadlift");
  await logSet(window, 123.5);
  await waitFor(() => upserts.length === 1, 4000);
  assert.match(upserts[0].payload.result_text, /123\.5 ק״ג/);
});

test("body weight never leaves the device: saving it posts nothing", async () => {
  const mock = createCirclesMock({ circles: [COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  window.applyFieldValue("bw-step", "bwWeight", 81.2);
  await window.saveBodyweight();
  await tick(150);
  assert.equal(upserts.length, 0);
  assert.ok(!JSON.stringify(mock.rpcCalls).includes("81.2"));
  await window.addMovement("Bw Deadlift", "Deadlift");
  await logSet(window, 100);
  await waitFor(() => upserts.length === 1, 4000);
  assert.ok(!JSON.stringify(upserts).includes("81.2"), "no post carries it");
});

test("a circle that takes neither workouts nor the weekly count gets nothing", async () => {
  const mock = createCirclesMock({ circles: [membership({ id: CIRCLE_A }, { share_defaults: { share_workouts: false, share_weekly_count: false } }), COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Off Deadlift", "Deadlift");
  await logSet(window, 100);
  await waitFor(() => upserts.length === 1, 4000);
  await tick(100);
  assert.deepEqual(upserts.map((u) => u.payload.club_id), [CIRCLE_B]);
});

test("a second set on the same day updates the day's post instead of making another", async () => {
  const mock = createCirclesMock({ circles: [COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Day Deadlift", "Deadlift");
  await logSet(window, 100);
  await waitFor(() => upserts.length === 1, 4000);
  await clearDecks(window);
  await logSet(window, 105);
  await waitFor(() => upserts.length === 2, 4000);
  assert.equal(upserts[0].payload.source_record_id, upserts[1].payload.source_record_id);
  assert.equal(mock.db.workout_posts.length, 1, "one row for the day in that circle");
});

test("after a save a bar says where it went, and 'change' opens the circles for this workout", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS(), COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Bar Deadlift", "Deadlift");
  await logSet(window, 100);
  await waitFor(() => !!window.document.querySelector("[data-share-bar]"), 4000);
  assert.match(window.document.querySelector("[data-share-bar]").textContent, /האימון שותף ב-2 מעגלים/);
  click(window, '[data-community-action="c-share-bar-change"]');
  await waitFor(() => window.document.querySelectorAll("[data-share-pick]").length === 2, 4000);
  // Both ticked, because both hold it.
  await waitFor(() => [...window.document.querySelectorAll("[data-share-pick]")].every((c) => c.checked), 4000);
  // Take it out of the friends circle only.
  const box = window.document.querySelector(`[data-share-pick="${CIRCLE_A}"]`);
  box.checked = false;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick(20);
  click(window, '[data-community-action="c-share-apply"]');
  await waitFor(() => mock.callsTo("post_delete").length === 1, 4000);
  assert.deepEqual(mock.callsTo("post_delete")[0], { post_id: upserts.find((u) => u.payload.club_id === CIRCLE_A).payload.id });
  // And a later set that day does not put it back: one tap skips one workout.
  await clearDecks(window);
  const before = upserts.length;
  await logSet(window, 105);
  await waitFor(() => upserts.length > before, 4000);
  assert.ok(upserts.slice(before).every((u) => u.payload.club_id === CIRCLE_B), "the skipped circle stays skipped for that day");
});

test("offline, the day's posts queue locally and go out when the connection returns", async () => {
  const mock = createCirclesMock({ circles: [COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.addMovement("Offline Deadlift", "Deadlift");
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
  await logSet(window, 100);
  await waitFor(() => !!window.document.querySelector("[data-share-bar]"), 4000);
  assert.equal(upserts.length, 0, "nothing is sent while offline");
  const rows = await window.HaimuniaOutbox.list();
  assert.equal(rows.filter((r) => r.action === "workout_share").length, 1, "it is queued on the device");
  assert.match(window.document.querySelector("[data-share-bar]").textContent, /כשהחיבור יחזור/);
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.dispatchEvent(new window.Event("online"));
  await waitFor(() => upserts.length === 1, 5000);
  assert.equal(upserts[0].payload.club_id, CIRCLE_B);
  assert.equal(upserts[0].opts.onConflict, "author_id,club_id,source_type,source_record_id");
});

test("a queued post from before circles, with no club_id, fails visibly instead of guessing a circle", async () => {
  const mock = createCirclesMock({ circles: [COUPLE()] });
  const upserts = spyOnPosts(mock);
  const window = await ready(mock);
  await window.HaimuniaOutbox.enqueue("workout_share", { row: { author_id: ME, source_type: "strength_entry", source_record_id: "x", title: "t" } }, { userId: ME });
  window.dispatchEvent(new window.Event("online"));
  await waitFor(async () => (await window.HaimuniaOutbox.list()).some((r) => r.status === "failed"), 5000);
  assert.equal(upserts.length, 0);
});

// ---- PRs and medals -----------------------------------------------------------------

async function prPrompt(window, mock, name) {
  await window.addMovement(name, "Deadlift");
  for (const kg of [100, 105, 110]) { await logSet(window, kg); await clearDecks(window, 150); }
  await logSet(window, 140);
  await waitFor(() => !!window.document.getElementById("prPrompt"), 4000);
}

test("the PR prompt lists my circles, ticked where PRs are shared, and sends one pr_share per circle with p_club_id", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS(), COUPLE({ share_prs: false })] });
  const window = await ready(mock);
  await prPrompt(window, mock, "Pr Deadlift");
  const boxes = [...window.document.querySelectorAll("[data-pr-circle]")];
  assert.equal(boxes.length, 2);
  assert.equal(boxes.find((b) => b.dataset.prCircle === CIRCLE_A).checked, true);
  assert.equal(boxes.find((b) => b.dataset.prCircle === CIRCLE_B).checked, false, "a circle whose settings say no PRs starts unticked");
  assert.match(window.document.getElementById("prPrompt").textContent, /בלי משקל מוחלט/);
  click(window, '[data-community-action="pr-share"]');
  await waitFor(() => mock.callsTo("pr_share").length === 1, 4000);
  const call = mock.callsTo("pr_share")[0];
  assert.equal(call.p_club_id, CIRCLE_A);
  assert.ok(call.record_id);
  assert.ok(!("p_weight" in call), "weights are hidden in this circle, so none is sent");
  assert.ok(!("media" in call), "pr_share lost its media argument");
});

test("p_weight goes only to a circle where weights are shown", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS(), membership({ id: CIRCLE_B, name: "הזוג", type: "couple" }, { share_defaults: { show_weights: true } })] });
  const window = await ready(mock);
  await prPrompt(window, mock, "Weight Deadlift");
  // A couple circle takes PRs by default, so both are ticked already.
  assert.ok([...window.document.querySelectorAll("[data-pr-circle]")].every((b) => b.checked));
  click(window, '[data-community-action="pr-share"]');
  await waitFor(() => mock.callsTo("pr_share").length === 2, 4000);
  const calls = mock.callsTo("pr_share");
  assert.ok(!("p_weight" in calls.find((c) => c.p_club_id === CIRCLE_A)));
  assert.equal(calls.find((c) => c.p_club_id === CIRCLE_B).p_weight, 140);
});

test("a PR share made offline is queued once per circle and drains with p_club_id intact", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS()] });
  const window = await ready(mock);
  await prPrompt(window, mock, "Queue Deadlift");
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
  click(window, '[data-community-action="pr-share"]');
  await waitFor(async () => (await window.HaimuniaOutbox.list()).filter((r) => r.action === "pr_share").length === 1, 4000);
  assert.equal(mock.callsTo("pr_share").length, 0);
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.dispatchEvent(new window.Event("online"));
  await waitFor(() => mock.callsTo("pr_share").length === 1, 5000);
  assert.equal(mock.callsTo("pr_share")[0].p_club_id, CIRCLE_A);
  assert.ok(mock.callsTo("pr_share")[0].p_idempotency_key, "the replay is safe: it carries its key");
});

test("the medal sheet shares to the circles picked with ach_share and p_club_id", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS(), COUPLE()] });
  const window = await ready(mock);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-1", visibility: "club" });
  await waitFor(() => !!window.document.getElementById("achUnlock"), 4000);
  const boxes = [...window.document.querySelectorAll("[data-ach-circle]")];
  assert.equal(boxes.length, 2);
  const off = boxes.find((b) => b.dataset.achCircle === CIRCLE_B);
  off.checked = false;
  off.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick(20);
  click(window, '[data-community-action="ach-share"]');
  await waitFor(() => mock.callsTo("ach_share").length === 1, 4000);
  const call = mock.callsTo("ach_share")[0];
  assert.equal(call.p_club_id, CIRCLE_A);
  assert.equal(call.member_achievement_id, "ma-1");
  assert.ok(!("media" in call));
});

test("sharing an offline medal from the log posts a text via post_create with p_club_id", async () => {
  const mock = createCirclesMock({ circles: [FRIENDS()] });
  const window = await ready(mock);
  window.shareAchievementToCommunity("first_pr", "השיא הראשון", "שיא אישי ראשון");
  await waitFor(() => !!window.document.querySelector("[data-medal-circle]"), 4000);
  click(window, '[data-community-action="c-medal-send"]');
  await waitFor(() => mock.callsTo("post_create").length === 1, 4000);
  const call = mock.callsTo("post_create")[0];
  assert.equal(call.p_club_id, CIRCLE_A);
  assert.match(call.body, /השיא הראשון/);
  assert.ok(!("visibility" in call) && !("media" in call) && !("links" in call), "post_create lost visibility, media and links");
});
