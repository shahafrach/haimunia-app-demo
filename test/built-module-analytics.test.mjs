// One event each for the two modules that were built after their switches and
// shipped with no telemetry and are still in the app: benchmarks and
// trained_together. (The other three - coach_tasks, onboarding_challenge,
// owner_report - went with the staff features.)
//
// WHAT THIS FILE VERIFIES
// - Each module writes its one event, at the surface that is the module's own
//   point, with the documented prop shape - and writes nothing when the
//   action failed.
// - No event carries the member it is about: the tagged members, the
//   benchmark's score. Each is checked by name.
// - Neither counts toward WCAM.
// - The map in docs/audit/usage-queries.sql (all four copies) and the table
//   in docs/community/metrics.md both name every event.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp, bootCommunity, bootHeldPosts, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const daysAgoIso = (d) => new Date(NOW - d * 86400000).toISOString();
const isoDay = (d) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

const events = (mock, name) => mock.db.analytics_events.filter((r) => r.event_name === name);
const plain = (v) => JSON.parse(JSON.stringify(v));
const q = (window, sel) => window.document.querySelector(sel);

function baseMock(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true, created_at: daysAgoIso(400) },
      { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true, created_at: daysAgoIso(3) },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: daysAgoIso(400) },
      { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: daysAgoIso(3) },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: [],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    follows: [], hidden_posts: [], saved_posts: [], feed_impressions: [], feed_interactions: [],
    monthly_club_recaps: [], reports: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// ===== trained_together ===============================================

function trainedTogetherMock() {
  const today = new Date().toISOString().slice(0, 10);
  const posts = [{
    id: "p1", post_type: "POST_WORKOUT", author_id: "u1", author: { display_name: "דנה", handle: "dana" },
    title: "Fran", occurred_on: today, visibility: "club", created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: { workout_name: "Fran", workout_date: today },
  }];
  return baseMock({
    feed_page_rows: posts,
    workout_posts: posts.map((p) => ({ id: p.id, author_id: p.author_id, post_type: p.post_type, title: p.title, deleted_at: null })),
    post_training_partners: [{ post_id: "p1", tagged_user_id: "u9", tagged_by: "u1", created_at: VERIFIED }],
    blocks: [],
  });
}

test("training_partners_tagged records how many tags landed, never who", async () => {
  const mock = trainedTogetherMock();
  const window = await bootHeldPosts(mock);
  await waitFor(() => !!q(window, '[data-post-id="p1"]'), 4000);
  q(window, '[data-post-id="p1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!q(window, '[data-community-action="post-tag-partners"][data-id="p1"]'), 3000);
  q(window, '[data-community-action="post-tag-partners"][data-id="p1"]').click();
  await waitFor(() => !!q(window, '[data-partner-pick="u9"]'), 3000);

  q(window, '[data-community-action="partners-save"]').click();
  await waitFor(() => events(mock, "training_partners_tagged").length === 1, 4000);

  const props = plain(events(mock, "training_partners_tagged")[0].props);
  assert.deepStrictEqual(props, { count: 1 });
  const json = JSON.stringify(props);
  assert.ok(!json.includes("u9") && !json.includes("p1") && !json.includes("נועה"),
    "who trained beside whom is a social graph this table must not hold");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("training_partners_tagged"), false);
});

// ===== benchmarks =====================================================

test("benchmark_opened fires on expand only, with the kind and two booleans - never the score or the name", async () => {
  const window = await bootApp();
  // analytics.js is loaded by bootApp but unconfigured, which is exactly the
  // offline / no-session case: an unconfigured track() drops the row. Give
  // it a recording client so the call can be observed.
  const rows = [];
  window.HaimuniaAnalytics.configure({
    client: { from: () => ({ insert: (row) => { rows.push(row); return Promise.resolve({ error: null }); } }) },
    userId: "u1", attachToBus: false,
  });
  const w = window.wodById("fran");
  await window.dbPutWodEntry({ id: window.uid("wod"), wodId: "fran", date: window.localISODate(new Date()), scoreType: w.scoreType, rx: true, timeSeconds: 245, ts: Date.now() });
  await window.reloadFromDb();
  window.render();
  window.document.getElementById("tabHistoryBtn").click();

  const row = () => [...window.document.querySelectorAll('[data-action="toggle-benchmark"]')].find((b) => b.dataset.id === "wod:fran");
  row().click();
  await waitFor(() => rows.length === 1, 3000);
  assert.equal(rows[0].event_name, "benchmark_opened");
  assert.deepStrictEqual(plain(rows[0].props), { kind: "wod", retest_due: false, has_best: true });
  assert.ok(!/fran|245|4:05/i.test(JSON.stringify(rows[0].props)), "no benchmark name and no result");

  row().click(); // collapse
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rows.length, 1, "collapsing a row is not an open");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("benchmark_opened"), false);
});

test("with analytics absent the benchmark screen still opens - the event is optional, the screen is not", async () => {
  const window = await bootApp();
  delete window.analyticsTrack;
  window.render();
  window.document.getElementById("tabHistoryBtn").click();
  const row = [...window.document.querySelectorAll('[data-action="toggle-benchmark"]')].find((b) => b.dataset.id === "wod:fran");
  row.click();
  const again = [...window.document.querySelectorAll('[data-action="toggle-benchmark"]')].find((b) => b.dataset.id === "wod:fran");
  assert.equal(again.getAttribute("aria-expanded"), "true");
});

// ===== the allow-list and the two docs ================================

const MODULE_EVENT = {
  benchmarks: "benchmark_opened",
  trained_together: "training_partners_tagged",
};
const NEW_NAMES = Object.values(MODULE_EVENT);

test("every new name is in EVENTS with a props allow-list that drops the member it is about", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  for (const name of NEW_NAMES) {
    assert.ok(Object.values(a.EVENTS).includes(name), `${name} must be in EVENTS`);
    assert.ok(Array.isArray(a.HAND_PROP_KEYS[name]) && a.HAND_PROP_KEYS[name].length, `${name} must narrow its props`);
  }
  assert.deepStrictEqual(plain(a.projectHandProps("training_partners_tagged", { count: 2, members: ["u2", "u3"], post_id: "p1" })),
    { count: 2 });
  assert.deepStrictEqual(plain(a.projectHandProps("benchmark_opened", { kind: "lift", retest_due: true, has_best: true, name: "Back Squat", best: 140 })),
    { kind: "lift", retest_due: true, has_best: true });
});

test("neither counts toward WCAM", async () => {
  const window = await bootApp();
  const counting = NEW_NAMES.filter((n) => window.HaimuniaAnalytics.isActiveMemberEvent(n));
  assert.deepStrictEqual(counting, []);
});

test("both modules are mapped in docs/audit/usage-queries.sql, in all four copies of the map", () => {
  const sql = fs.readFileSync(new URL("../docs/audit/usage-queries.sql", import.meta.url), "utf8");
  for (const [module, event] of Object.entries(MODULE_EVENT)) {
    assert.match(sql, new RegExp(`\\('${event}',\\s*'${module}',\\s*true\\)`),
      `query 1 must map ${event} to ${module} as a club_features key`);
    assert.equal(sql.split(`('${event}','${module}')`).length - 1, 3,
      `${event} must appear in the module_map CTE of queries 2, 4 and 5`);
  }
  // The stale "switches ahead of their features" finding is corrected, and the
  // one built module that is still silent is named rather than hidden.
  // 48 since N10 added client_error.
  assert.match(sql, /48 event names/);
  assert.match(sql, /strength_percentages - BUILT/);
});

test("docs/community/metrics.md names every new event with its trigger surface and its WCAM answer", () => {
  const doc = fs.readFileSync(new URL("../docs/community/metrics.md", import.meta.url), "utf8");
  for (const name of NEW_NAMES) {
    const row = doc.split("\n").find((l) => l.startsWith(`| \`${name}\``));
    assert.ok(row, `the tracked-events table must carry a row for ${name}`);
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    assert.equal(cells.length, 4, `${name}'s row must fill all four columns`);
    assert.match(cells[3], /^no\b/, `${name} must answer the WCAM column, and the answer is no`);
  }
  assert.match(doc, /`EVENTS` holds 47 names/);
});

test("every new event has a real call site reached through its constant", () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const community = read("../src/community/posts.js");
  assert.ok(community.includes("track(A.TRAINING_PARTNERS_TAGGED"), "TRAINING_PARTNERS_TAGGED must have a real call site");
  assert.ok(read("../app.js").includes("window.ANALYTICS_EVENTS.BENCHMARK_OPENED"),
    "app.js reaches benchmark_opened through the constant, since it cannot see cloud.js's track()");
  for (const name of NEW_NAMES) {
    assert.ok(!community.includes(`track("${name}"`), `${name} must be reached through the constant`);
  }
});
