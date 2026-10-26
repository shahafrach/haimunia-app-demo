// What a member sees of a circle: the feed (circle_feed) with its three
// reactions and the gentle lift for unreacted PRs, "trained together" tags that
// stay pending until confirmed, the week (circle_week) as percent of each
// member's OWN target with paused members marked, and the benchmark of the
// month with its results locked until the member has logged theirs.
import { test } from "node:test";
import assert from "node:assert";
import { createCirclesMock, bootCircle, waitFor, tick, click, membership, club, ME, FRIEND, CIRCLE_A, CIRCLE_B } from "./helpers/circles.mjs";

const text = (w) => w.document.getElementById("content").textContent;
const has = (w, s) => text(w).includes(s);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));

function feedRow(over = {}) {
  return Object.assign({
    post_id: "p1", author_id: FRIEND, author_name: "דנה", author_emoji: "🦁", post_type: "POST_WORKOUT",
    title: "סקוואט", result_text: "סקוואט 5 × 3", body: null, metadata: {}, occurred_on: "2026-10-26",
    published_at: "2026-10-26T10:00:00Z", reaction_counts: {}, my_reactions: [], unreacted_pr: false,
  }, over);
}

test("the feed is circle_feed for the circle on screen, newest first, with the author's emoji", async () => {
  const mock = createCirclesMock({ feed: [feedRow(), feedRow({ post_id: "p2", post_type: "POST_PR", title: "מתח", result_text: null, published_at: "2026-10-25T10:00:00Z" })] });
  const window = await bootCircle(mock);
  await waitFor(() => window.document.querySelectorAll("article.post-card").length === 2, 4000);
  assert.deepEqual(mock.callsTo("circle_feed")[0].p_club_id, CIRCLE_A);
  assert.equal(mock.callsTo("circle_feed")[0].p_limit, 30);
  assert.ok(has(window, "🦁"));
  assert.ok(has(window, "דנה"));
});

test("a count-only workout post is not a card", async () => {
  const mock = createCirclesMock({ feed: [feedRow({ post_id: "c1", title: null, result_text: null }), feedRow({ post_id: "p2" })] });
  const window = await bootCircle(mock);
  await waitFor(() => window.document.querySelectorAll("article.post-card").length === 1, 4000);
  assert.ok(!window.document.querySelector('[data-post-id="c1"]'));
});

test("reactions are exactly three, each a toggle, and a member can hold all three", async () => {
  const mock = createCirclesMock({ feed: [feedRow({ reaction_counts: { fist_bump: 2 }, my_reactions: ["fist_bump"] })] });
  const window = await bootCircle(mock);
  await waitFor(() => window.document.querySelectorAll('[data-community-action="react"]').length === 3, 4000);
  const kinds = [...window.document.querySelectorAll('[data-community-action="react"]')].map((b) => b.dataset.kind);
  assert.deepEqual(kinds, ["fist_bump", "fire", "clap"]);
  assert.equal(window.document.querySelector('[data-kind="fist_bump"]').getAttribute("aria-pressed"), "true", "my fist bump from circle_feed is shown as mine");
  assert.match(window.document.querySelector('[data-kind="fist_bump"]').textContent, /2/);
  for (const kind of ["fire", "clap"]) {
    click(window, `[data-community-action="react"][data-kind="${kind}"]`);
    await waitFor(() => mock.callsTo("toggle_reaction").some((a) => a.p_kind === kind), 4000);
    await tick(20);
  }
  const calls = mock.callsTo("toggle_reaction");
  assert.deepEqual(calls.map((c) => c.p_kind), ["fire", "clap"]);
  assert.ok(calls.every((c) => c.p_post_id === "p1" && c.p_idempotency_key));
  assert.ok(["fist_bump", "fire", "clap"].every((k) => window.document.querySelector(`[data-kind="${k}"]`).getAttribute("aria-pressed") === "true"), "all three held at once");
  // Tapping again takes it back.
  click(window, '[data-community-action="react"][data-kind="fire"]');
  await waitFor(() => window.document.querySelector('[data-kind="fire"]').getAttribute("aria-pressed") === "false", 4000);
});

test("nothing in the client reads the old 'cheer' kind", async () => {
  const mock = createCirclesMock({ feed: [feedRow({ reaction_counts: { fist_bump: 1 } })] });
  const window = await bootCircle(mock);
  await waitFor(() => window.document.querySelector('[data-community-action="react"]'), 4000);
  click(window, '[data-community-action="reactors"]');
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reactors"]'), 4000);
  const { readFileSync } = await import("node:fs");
  for (const f of ["src/community/reactions.js", "src/community/posts.js", "src/community/circles.js", "cloud.js"]) {
    assert.ok(!/["']cheer["']/.test(readFileSync(new URL("../" + f, import.meta.url), "utf8")), `${f} must not name the cheer kind`);
  }
});

test("a PR nobody reacted to in a day rises to the top and is drawn with a quiet highlight", async () => {
  const mock = createCirclesMock({ feed: [
    feedRow({ post_id: "new", published_at: "2026-10-26T10:00:00Z" }),
    feedRow({ post_id: "old-pr", post_type: "POST_PR", title: "דדליפט", unreacted_pr: true, published_at: "2026-10-24T10:00:00Z", metadata: { new_result: "+5.0%" } }),
  ] });
  const window = await bootCircle(mock);
  await waitFor(() => window.document.querySelectorAll("article.post-card").length === 2, 4000);
  const first = window.document.querySelector("article.post-card");
  assert.equal(first.dataset.postId, "old-pr", "lifted above the newer post");
  assert.equal(first.dataset.unreactedPr, "1");
  assert.ok(first.classList.contains("post-card--lift"));
  assert.ok(!window.document.querySelector('[data-post-id="new"]').classList.contains("post-card--lift"));
});

test("the feed has a retry when circle_feed fails, and 'more' when a page was full", async () => {
  let fail = true;
  const rows = Array.from({ length: 30 }, (_, i) => feedRow({ post_id: "p" + i, published_at: `2026-10-26T10:${String(59 - i).padStart(2, "0")}:00Z` }));
  const mock = createCirclesMock({ rpc: { circle_feed: (args) => (fail ? { data: null, error: { message: "boom" } } : { data: args.p_cursor ? [] : rows, error: null }) } });
  const window = await bootCircle(mock);
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-feed-retry"]'), 4000);
  fail = false;
  click(window, '[data-community-action="c-feed-retry"]');
  await waitFor(() => window.document.querySelector('[data-community-action="c-feed-more"]'), 4000);
  click(window, '[data-community-action="c-feed-more"]');
  await waitFor(() => mock.callsTo("circle_feed").some((a) => a.p_cursor === rows[29].published_at), 4000);
});

// ---- Trained together -------------------------------------------------------------------

test("tagging a training partner creates a pending tag from the circle's members", async () => {
  const mock = createCirclesMock({
    circles: [Object.assign(membership(), { profiles: { display_name: "אני", emoji: "💪" } }),
      { club_id: CIRCLE_A, user_id: FRIEND, role: "member", joined_at: "2026-10-02T00:00:00Z", share_defaults: {}, profiles: { display_name: "דנה", emoji: "🦁" } }],
    feed: [feedRow({ post_id: "mine", author_id: ME, author_name: "אני", author_emoji: "💪" })],
    rpc: { post_tag_training_partners: () => ({ data: 1, error: null }) },
  });
  const window = await bootCircle(mock);
  await waitFor(() => !!window.document.querySelector('[data-post-id="mine"]'), 4000);
  click(window, '[data-community-action="toggle-post-menu"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="post-tag-partners"]'), 4000);
  click(window, '[data-community-action="post-tag-partners"]');
  await waitFor(() => !!window.document.querySelector(`[data-partner-pick="${FRIEND}"]`), 4000);
  assert.ok(!window.document.querySelector(`[data-partner-pick="${ME}"]`), "you cannot tag yourself");
  const box = window.document.querySelector(`[data-partner-pick="${FRIEND}"]`);
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick(20);
  assert.match(window.document.querySelector("[data-partners-panel]").textContent, /ממתין לאישור של מי שסימנתם/);
  click(window, '[data-community-action="partners-save"]');
  await waitFor(() => mock.callsTo("post_tag_training_partners").length === 1, 4000);
  assert.deepEqual(mock.callsTo("post_tag_training_partners")[0], { p_post_id: "mine", p_members: [FRIEND] });
});

function pendingTagMock() {
  return createCirclesMock({
    tags: [{ post_id: "theirs", club_id: CIRCLE_A, tagged_user_id: ME, tagged_by: FRIEND, confirmed_at: null, created_at: "2026-10-26T11:00:00Z" }],
    posts: [{ id: "theirs", occurred_on: "2026-10-26", title: "סקוואט", club_id: CIRCLE_A }],
  });
}
test("the tagged member sees a pending tag and confirms it with confirm_trained_together", async () => {
  const mock = pendingTagMock();
  const window = await bootCircle(mock);
  await waitFor(() => !!window.document.querySelector("[data-pending-tags]"), 4000);
  assert.match(window.document.querySelector("[data-pending-tags]").textContent, /דנה/);
  assert.match(window.document.querySelector("[data-pending-tags]").textContent, /רק אחרי האישור/);
  assert.equal(mock.callsTo("confirm_trained_together").length, 0, "a tag counts for nobody until confirmed");
  click(window, '[data-community-action="c-tag-confirm"]');
  await waitFor(() => mock.callsTo("confirm_trained_together").length === 1, 4000);
  assert.deepEqual(mock.callsTo("confirm_trained_together")[0], { p_post_id: "theirs" });
  await waitFor(() => !window.document.querySelector("[data-pending-tags]"), 4000);
});

test("the tagged member can say it was not so", async () => {
  const mock = pendingTagMock();
  const window = await bootCircle(mock);
  await waitFor(() => !!window.document.querySelector("[data-pending-tags]"), 4000);
  click(window, '[data-community-action="c-tag-decline"]');
  await waitFor(() => mock.callsTo("post_training_partner_remove").length === 1, 4000);
  assert.deepEqual(mock.callsTo("post_training_partner_remove")[0], { p_post_id: "theirs" });
  assert.equal(mock.callsTo("confirm_trained_together").length, 0);
});

// ---- The week -----------------------------------------------------------------------------

const WEEK = [
  { user_id: FRIEND, display_name: "דנה", emoji: "🦁", workouts: 2, target: null, percent: 67, paused: false, weeks_met: 3 },
  { user_id: ME, display_name: "אני", emoji: "💪", workouts: 4, target: 3, percent: 133, paused: false, weeks_met: 1 },
  { user_id: "33333333-3333-4333-8333-333333333333", display_name: "גל", emoji: "🌿", workouts: null, target: null, percent: null, paused: true, weeks_met: null },
];

test("the week shows each member's percent of their own target, paused members marked, and weeks met", async () => {
  const mock = createCirclesMock({ week: WEEK });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-section"][data-section="week"]');
  await waitFor(() => window.document.querySelectorAll("[data-week-member]").length === 3, 4000);
  assert.deepEqual(mock.callsTo("circle_week")[0], { p_club_id: CIRCLE_A });
  const dana = window.document.querySelector(`[data-week-member="${FRIEND}"]`).textContent;
  assert.match(dana, /67%/);
  assert.match(dana, /3 שבועות עמדו ביעד/);
  assert.match(window.document.querySelector(`[data-week-member="${ME}"]`).textContent, /133%/);
  assert.match(window.document.querySelector(`[data-week-member="${ME}"]`).textContent, /שבוע אחד עמד ביעד/);
  const gal = window.document.querySelector('[data-week-member="33333333-3333-4333-8333-333333333333"]');
  assert.match(gal.textContent, /בהפסקה/);
  assert.ok(!/%/.test(gal.textContent), "a paused member shows no percent");
  assert.ok(gal.querySelector("[data-week-paused]"));
  // No ranking, no absolute counts, no streaks.
  assert.ok(!/מקום|דירוג:|רצף/.test(text(window).replace("אין דירוג", "")));
  assert.equal(window.document.querySelector("[data-week-layout]").dataset.weekLayout, "list");
  assert.equal(window.document.querySelector(`[data-week-member="${ME}"] [role="progressbar"]`).getAttribute("aria-valuenow"), "100");
});

test("a couple circle shows the two weeks side by side", async () => {
  const mock = createCirclesMock({ circles: [membership({ id: CIRCLE_B, type: "couple", name: "הזוג", emoji: "💞" })], week: WEEK.slice(0, 2) });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-section"][data-section="week"]');
  await waitFor(() => window.document.querySelectorAll("[data-week-member]").length === 2, 4000);
  assert.equal(window.document.querySelector("[data-week-layout]").dataset.weekLayout, "pair");
});

// ---- Benchmark of the month ------------------------------------------------------------------

const MONTH = (w) => w.CirclesCore.benchmarkMonth(new Date());

test("the owner picks the benchmark from the eight named ones", async () => {
  const mock = createCirclesMock({ circles: [membership({ benchmark_enabled: true })] });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-section"][data-section="benchmark"]');
  await waitFor(() => window.document.querySelectorAll('[data-community-action="c-bench-pick"][data-id]').length >= 8, 4000);
  const ids = [...window.document.querySelectorAll('[data-community-action="c-bench-pick"]')].map((b) => b.dataset.id).filter(Boolean);
  assert.deepEqual(ids, ["fran", "grace", "helen", "diane", "cindy", "murph", "isabel", "karen"]);
  click(window, '[data-community-action="c-bench-pick"][data-id="grace"]');
  await waitFor(() => mock.callsTo("update_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("update_circle")[0], { p_club_id: CIRCLE_A, p_settings: { benchmark: "grace" } });
});

test("a member who is not the owner cannot pick", async () => {
  const mock = createCirclesMock({ circles: [membership({ benchmark_enabled: true }, { role: "member" })] });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-section"][data-section="benchmark"]');
  await waitFor(() => has(window, "עוד לא בחר/ה בנצ'מרק"), 4000);
  assert.ok(!window.document.querySelector('[data-community-action="c-bench-pick"]'));
});

test("results are locked until the member logs theirs; then Rx and scaled are separate lists", async () => {
  const GAL = "33333333-3333-4333-8333-333333333333";
  const mock = createCirclesMock({ circles: [membership({ benchmark_enabled: true, benchmark: "fran", benchmark_month: "2000-01-01" }, { role: "member" })] });
  const window = await bootCircle(mock);
  const month = window.CirclesCore.benchmarkMonth(new Date());
  // The stub has no row-level security, so it plays the database's part: other
  // members' rows come back only once the caller has a row of their own.
  const everyone = [
    { club_id: CIRCLE_A, user_id: FRIEND, benchmark: "fran", month, result: "3:59", rx_or_scaled: "rx", created_at: "2026-10-05T00:00:00Z", profiles: { display_name: "דנה", emoji: "🦁" } },
    { club_id: CIRCLE_A, user_id: GAL, benchmark: "fran", month, result: "7:10", rx_or_scaled: "scaled", created_at: "2026-10-06T00:00:00Z", profiles: { display_name: "גל", emoji: "🌿" } },
  ];
  const mine = [];
  const upserts = [];
  const from = mock.client.from;
  mock.client.from = (t) => {
    if (t !== "benchmark_results") return from(t);
    let mode = "select";
    const api = {
      select() { return api; }, eq() { return api; }, order() { return api; },
      upsert(row, opts) { mode = "upsert"; upserts.push({ row, opts }); mine.splice(0, mine.length, Object.assign({ created_at: "2026-10-07T00:00:00Z", profiles: { display_name: "אני", emoji: "💪" } }, row)); return api; },
      then(res, rej) { return Promise.resolve(mode === "upsert" ? { error: null } : { error: null, data: mine.length ? everyone.concat(mine) : [] }).then(res, rej); },
    };
    return api;
  };
  // The circle was stamped for last year when it booted; stamp it for this month and reload.
  mock.db.circle_members[0].clubs.benchmark_month = month;
  window.dispatchEvent(new window.Event("online"));
  await window.circlesReload();
  click(window, '[data-community-action="c-section"][data-section="benchmark"]');
  await waitFor(() => !!window.document.getElementById("circleBenchmark"), 4000);
  assert.match(text(window), /Fran/);
  assert.match(text(window), /התוצאות של האחרים יופיעו אחרי שתשמרו את שלכם/);
  assert.ok(!has(window, "3:59") && !has(window, "7:10"), "other members' results are not shown before mine");
  const form = window.document.getElementById("circleBenchmark");
  form.elements.result.value = "4:35";
  [...form.elements.level].find((r) => r.value === "scaled").checked = true;
  submit(window, form);
  await waitFor(() => upserts.length === 1, 4000);
  assert.deepEqual(upserts[0].row, { club_id: CIRCLE_A, user_id: ME, benchmark: "fran", month, result: "4:35", rx_or_scaled: "scaled" });
  assert.equal(upserts[0].opts.onConflict, "club_id,user_id,benchmark,month");
  await waitFor(() => has(window, "3:59"), 4000);
  const lists = [...window.document.querySelectorAll(".ach-section")].map((n) => n.textContent);
  const rx = lists.find((t) => t.includes("Rx") && t.includes("3:59"));
  const scaled = lists.find((t) => t.includes("Scaled") && t.includes("7:10"));
  assert.ok(rx && !rx.includes("7:10") && !rx.includes("4:35"), "Rx is its own list");
  assert.ok(scaled && scaled.includes("4:35") && !scaled.includes("3:59"), "scaled is its own list, and mine is in it");
});

test("a benchmark picked in an earlier month is not this month's benchmark", async () => {
  const mock = createCirclesMock({ circles: [membership({ benchmark_enabled: true, benchmark: "fran", benchmark_month: "2000-01-01" }, { role: "member" })] });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-section"][data-section="benchmark"]');
  await waitFor(() => has(window, "עוד לא בחר/ה בנצ'מרק לחודש הזה"), 4000);
  assert.ok(!window.document.getElementById("circleBenchmark"), "no form for a stale pick");
});
