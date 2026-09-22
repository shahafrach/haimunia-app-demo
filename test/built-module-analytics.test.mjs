// One event each for the five club_features modules that were built after
// their switches and shipped with no telemetry: coach_tasks,
// onboarding_challenge, owner_report, benchmarks, trained_together.
//
// WHY THIS FILE EXISTS. docs/audit/usage-queries.sql query 5 said "no
// telemetry" about these five, and for a switch with nothing behind it that
// was the honest answer. Once each feature existed it stopped being honest:
// it read exactly like disuse and was not evidence of anything.
//
// WHAT THIS FILE VERIFIES
// - Each module writes its one event, at the surface that is the module's own
//   point, with the documented prop shape - and writes nothing when the
//   action failed.
// - No event carries the member it is about: the task's member, the tagged
//   classmates, the report's figures, the benchmark's score. Each is checked
//   by name.
// - None of the five counts toward WCAM.
// - The map in docs/audit/usage-queries.sql (all four copies) and the table
//   in docs/community/metrics.md both name every new event.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp, bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
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

// ===== coach_tasks ====================================================

function coachTask(extra) {
  return Object.assign({
    id: "t-1", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null,
    rule_key: "welcome", opened_at: daysAgoIso(2), due_on: isoDay(3), overdue: false,
    assigned_coach_id: null, assigned_coach_name: null,
    joined_on: isoDay(-3), days_since_join: 3, sessions_logged: 0,
    contacted_at: null, closed_at: null, detail: {},
  }, extra || {});
}
function coachTasksMock(tasks) {
  const mock = baseMock({
    club_features: [{ club_id: "club-1", module_key: "coach_tasks", enabled: true, config: {} }],
    coach_tasks: tasks.map((t) => ({ id: t.id, user_id: t.user_id, closed_at: null })),
  });
  mock.db.invite_redemptions[0].role = "coach";
  mock.onRpc("coach_tasks_refresh", () => ({ data: tasks, error: null }));
  return mock;
}
async function openCoachTasks(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!q(window, ".subtabbar"), 3000);
  q(window, '[data-community-action="set-tab"][data-tab="coach"]').click();
  await waitFor(() => !!q(window, '[data-community-action="coach-task-contact"]'), 4000);
}

test("coach_task_closed records a contact: the rule and whether it was late, never the member", async () => {
  const mock = coachTasksMock([coachTask({ id: "t-1", rule_key: "no_contact_30", overdue: true })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTasks(window);

  q(window, '[data-community-action="coach-task-contact"][data-id="t-1"]').click();
  await waitFor(() => events(mock, "coach_task_closed").length === 1, 4000);

  const props = plain(events(mock, "coach_task_closed")[0].props);
  assert.deepStrictEqual(props, { action: "contacted", rule: "no_contact_30", overdue: true });
  const json = JSON.stringify(props);
  assert.ok(!json.includes("u9") && !json.includes("t-1") && !json.includes("נועה"),
    "a coach task is a named member the club thinks needs a call - the row must not say who");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("coach_task_closed"), false,
    "clearing a work queue is staff triage, not community participation");
});

test("coach_task_closed records a dismissal as its own action", async () => {
  const mock = coachTasksMock([coachTask({ id: "t-1", rule_key: "welcome" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTasks(window);

  q(window, '[data-community-action="coach-task-dismiss"][data-id="t-1"]').click();
  await waitFor(() => events(mock, "coach_task_closed").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "coach_task_closed")[0].props),
    { action: "dismissed", rule: "welcome", overdue: false });
});

test("a failed close writes no coach_task_closed row", async () => {
  const mock = coachTasksMock([coachTask({ id: "t-1" })]);
  const real = mock.client.from.bind(mock.client);
  mock.client.from = (t) => (t === "member_contact_log"
    ? { insert: () => Promise.resolve({ data: null, error: { message: "boom" } }) }
    : real(t));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTasks(window);

  q(window, '[data-community-action="coach-task-contact"][data-id="t-1"]').click();
  await waitFor(() => /לא ניתן היה לבצע את הפעולה/.test(window.document.body.textContent), 4000);
  assert.equal(events(mock, "coach_task_closed").length, 0, "a contact that did not write was not a close");
});

// ===== onboarding_challenge ===========================================

function onboardingMock() {
  const mock = baseMock({
    club_features: [
      { club_id: "club-1", module_key: "onboarding_challenge", enabled: true, config: {} },
      { club_id: "club-1", module_key: "challenges", enabled: true, config: {} },
    ],
    challenges: [], challenge_participants: [], challenge_progress: [],
  });
  mock.onboarding = { state: "offered", goal_sessions: 8, window_days: 30 };
  mock.onRpc("onboarding_challenge_state", () => ({ data: mock.onboarding, error: null }));
  mock.onRpc("chal_progress", () => ({ data: { participant_count: 0 }, error: null }));
  return mock;
}
async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!q(window, ".subtabbar"), 3000);
  q(window, '[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!q(window, "[data-onboarding-challenge]"), 4000);
}

test("onboarding_challenge_responded records an accept", async () => {
  const mock = onboardingMock();
  mock.onRpc("onboarding_challenge_respond", () => {
    mock.onboarding = { state: "accepted", goal_sessions: 8, window_days: 30, progress: 0, days_left: 30 };
    return { data: mock.onboarding, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);

  q(window, '[data-community-action="onboarding-challenge-accept"]').click();
  await waitFor(() => events(mock, "onboarding_challenge_responded").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "onboarding_challenge_responded")[0].props), { accepted: true });
});

test("onboarding_challenge_responded records a decline - the answer no other row can see", async () => {
  const mock = onboardingMock();
  mock.onRpc("onboarding_challenge_respond", () => {
    mock.onboarding = { state: "declined", responded_at: VERIFIED };
    return { data: mock.onboarding, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);

  q(window, '[data-community-action="onboarding-challenge-decline"]').click();
  await waitFor(() => events(mock, "onboarding_challenge_responded").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "onboarding_challenge_responded")[0].props), { accepted: false });
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("onboarding_challenge_responded"), false,
    "WCAM is decided by name, and this name carries the decline too");
});

test("a refused answer writes no row", async () => {
  const mock = onboardingMock();
  mock.onRpc("onboarding_challenge_respond", () => ({ data: null, error: { message: "not offered" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);

  q(window, '[data-community-action="onboarding-challenge-accept"]').click();
  await waitFor(() => /לא ניתן היה לבצע את הפעולה/.test(window.document.body.textContent), 4000);
  assert.equal(events(mock, "onboarding_challenge_responded").length, 0);
});

// ===== owner_report ===================================================

function ownerReportMock(opts) {
  const o = opts || {};
  const mock = baseMock({
    club_features: [{ club_id: "club-1", module_key: "owner_report", enabled: true, config: {} }],
    owner_reports: [
      { id: "rep-08", club_id: "club-1", month_start: "2026-08-01", recap_id: "r-08", active_members: 37, new_members: 6, stopped_members: 4, strong_start_members: 2, coach_tasks_opened: 3, coach_tasks_closed: 5, at_risk_members: 0, generated_at: VERIFIED, notified_at: VERIFIED },
      { id: "rep-07", club_id: "club-1", month_start: "2026-07-01", recap_id: "r-07", active_members: 35, new_members: 4, stopped_members: 2, strong_start_members: 1, coach_tasks_opened: 2, coach_tasks_closed: 2, at_risk_members: 1, generated_at: VERIFIED, notified_at: VERIFIED },
    ],
  });
  mock.db.invite_redemptions[0].role = "head_coach";
  seedAdminStepUp(mock, "u1", "dana@members.haimuniya.invalid");
  if (o.fail) {
    const real = mock.client.from.bind(mock.client);
    const failing = { data: null, error: { message: "boom" } };
    const builder = { select: () => builder, order: () => builder, limit: () => builder, eq: () => builder,
      then: (ok, no) => Promise.resolve(failing).then(ok, no) };
    mock.client.from = (t) => (t === "owner_reports" ? builder : real(t));
  }
  return mock;
}
async function openOwnerReport(window) {
  window.document.getElementById("tabClubManageBtn").click();
  await unlockAdminPanel(window);
  await waitFor(() => !!q(window, ".subtabbar"), 3000);
  q(window, '.subtabbtn[data-community-action="set-manage-tab"][data-tab="ownerreport"]').click();
}

test("owner_report_viewed fires once per visit with how many months loaded, never a figure", async () => {
  const mock = ownerReportMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openOwnerReport(window);
  await waitFor(() => events(mock, "owner_report_viewed").length === 1, 4000);
  await waitFor(() => !!q(window, "[data-owner-report]") && !q(window, "[data-owner-report-skeleton]"), 3000);

  const props = plain(events(mock, "owner_report_viewed")[0].props);
  assert.deepStrictEqual(props, { months: 2 });
  assert.ok(!/37|rep-08/.test(JSON.stringify(props)), "the report's figures stay in the report");

  // A month switch re-renders the tab; it is not a second visit.
  const monthBtn = q(window, '[data-community-action="owner-report-month"][data-month="2026-07-01"]');
  assert.ok(monthBtn, "the month bar offers the earlier month");
  monthBtn.click();
  await waitFor(() => !!q(window, '[data-community-action="owner-report-month"][data-month="2026-07-01"].selected'), 3000);
  assert.equal(events(mock, "owner_report_viewed").length, 1);
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("owner_report_viewed"), false);
});

test("a failed report read is not a view", async () => {
  const mock = ownerReportMock({ fail: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openOwnerReport(window);
  await waitFor(() => !!q(window, "[data-owner-report]") && !q(window, "[data-owner-report-skeleton]"), 4000);
  assert.equal(events(mock, "owner_report_viewed").length, 0);
});

// ===== trained_together ===============================================

function trainedTogetherMock() {
  const today = new Date().toISOString().slice(0, 10);
  const posts = [{
    id: "p1", post_type: "POST_WORKOUT", author_id: "u1", author: { display_name: "דנה", handle: "dana" },
    title: "Fran", occurred_on: today, visibility: "club", created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: { workout_name: "Fran", workout_date: today },
  }];
  return baseMock({
    club_features: [{ club_id: "club-1", module_key: "trained_together", enabled: true, config: {} }],
    feed_page_rows: posts,
    workout_posts: posts.map((p) => ({ id: p.id, author_id: p.author_id, post_type: p.post_type, title: p.title, deleted_at: null })),
    post_training_partners: [],
    attendance_log: [
      { user_id: "u1", occurred_on: today, recorded_at: VERIFIED },
      { user_id: "u9", occurred_on: today, recorded_at: VERIFIED },
    ],
    blocks: [],
  });
}

test("training_partners_tagged records how many tags landed, never who", async () => {
  const mock = trainedTogetherMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!q(window, '[data-post-id="p1"]'), 4000);
  q(window, '[data-post-id="p1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!q(window, '[data-community-action="post-tag-partners"][data-id="p1"]'), 3000);
  q(window, '[data-community-action="post-tag-partners"][data-id="p1"]').click();
  await waitFor(() => !!q(window, '[data-partner-pick="u9"]'), 3000);

  const box = q(window, '[data-partner-pick="u9"]');
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
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
  window.setClubFeatureFlags({ benchmarks: { enabled: true, config: {} } });
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
  window.setClubFeatureFlags({ benchmarks: { enabled: true, config: {} } });
  window.render();
  window.document.getElementById("tabHistoryBtn").click();
  const row = [...window.document.querySelectorAll('[data-action="toggle-benchmark"]')].find((b) => b.dataset.id === "wod:fran");
  row.click();
  const again = [...window.document.querySelectorAll('[data-action="toggle-benchmark"]')].find((b) => b.dataset.id === "wod:fran");
  assert.equal(again.getAttribute("aria-expanded"), "true");
});

// ===== the allow-list and the two docs ================================

const MODULE_EVENT = {
  coach_tasks: "coach_task_closed",
  onboarding_challenge: "onboarding_challenge_responded",
  owner_report: "owner_report_viewed",
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
  assert.deepStrictEqual(plain(a.projectHandProps("coach_task_closed", { action: "contacted", rule: "welcome", overdue: false, user_id: "u9", display_name: "נועה" })),
    { action: "contacted", rule: "welcome", overdue: false });
  assert.deepStrictEqual(plain(a.projectHandProps("training_partners_tagged", { count: 2, members: ["u2", "u3"], post_id: "p1" })),
    { count: 2 });
  assert.deepStrictEqual(plain(a.projectHandProps("benchmark_opened", { kind: "lift", retest_due: true, has_best: true, name: "Back Squat", best: 140 })),
    { kind: "lift", retest_due: true, has_best: true });
  assert.deepStrictEqual(plain(a.projectHandProps("owner_report_viewed", { months: 3, active_members: 37 })), { months: 3 });
});

test("none of the five counts toward WCAM", async () => {
  const window = await bootApp();
  const counting = NEW_NAMES.filter((n) => window.HaimuniaAnalytics.isActiveMemberEvent(n));
  assert.deepStrictEqual(counting, []);
});

test("every one of the five modules is mapped in docs/audit/usage-queries.sql, in all four copies of the map", () => {
  const sql = fs.readFileSync(new URL("../docs/audit/usage-queries.sql", import.meta.url), "utf8");
  for (const [module, event] of Object.entries(MODULE_EVENT)) {
    assert.match(sql, new RegExp(`\\('${event}',\\s*'${module}',\\s*true\\)`),
      `query 1 must map ${event} to ${module} as a club_features key`);
    assert.equal(sql.split(`('${event}','${module}')`).length - 1, 3,
      `${event} must appear in the module_map CTE of queries 2, 4 and 5`);
  }
  // The stale "switches ahead of their features" finding is corrected, and the
  // one built module that is still silent is named rather than hidden.
  assert.match(sql, /47 event names/);
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
  const community = ["../src/community/coach-tools.js", "../src/community/challenges.js",
    "../src/community/admin.js", "../src/community/posts.js"].map(read).join("\n");
  for (const c of ["COACH_TASK_CLOSED", "ONBOARDING_CHALLENGE_RESPONDED", "OWNER_REPORT_VIEWED", "TRAINING_PARTNERS_TAGGED"]) {
    assert.ok(community.includes(`track(A.${c}`), `${c} must have a real call site`);
  }
  assert.ok(read("../app.js").includes("window.ANALYTICS_EVENTS.BENCHMARK_OPENED"),
    "app.js reaches benchmark_opened through the constant, since it cannot see cloud.js's track()");
  for (const name of NEW_NAMES) {
    assert.ok(!community.includes(`track("${name}"`), `${name} must be reached through the constant`);
  }
});
