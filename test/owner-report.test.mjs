// 202609220004, client half: the monthly owner report.
//
// Driven for real - bootCommunity plus the mock Supabase client, the real
// unlock gate, the real tab bar, the real click handlers - the same way
// test/community-admin-analytics-dashboard.test.mjs drives the staff surface
// beside it. Nothing here is a source-text match.
//
// WHAT THIS FILE IS DEFENDING, and it is deliberately NOT the figures: those
// are computed in Postgres and pinned by supabase/tests/0121. What jsdom can
// see and pgTAP cannot is the four things that make this a screen rather than
// a query:
//
//   1. WHO GETS THE TAB. head_coach and above, and the client has to agree
//      with the server about that or the person the report is for is refused
//      their own screen by their own app. A coach gets no tab at all.
//   2. EVERY NUMBER OPENS ITS LIST, including a zero - a figure with no way
//      in is a figure a leader cannot check.
//   3. A FAILED READ IS NOT AN EMPTY REPORT. Seven zeros under "last month"
//      is a statement about the club, and the wrong one to make when the
//      request failed.
//   4. THE TWO TASK FIGURES COUNT TASKS AND THEIR LISTS COUNT MEMBERS. They
//      are allowed to differ, and the screen has to say both numbers rather
//      than letting a leader read a list of two under a figure of three.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const MONTH = "2026-08-01";
const PREV_MONTH = "2026-07-01";

// The row owner_report_generate() writes, as the table really holds it.
function reportRow(month, over) {
  return Object.assign({
    id: `rep-${month}`, club_id: "club-1", month_start: month, recap_id: `recap-${month}`,
    active_members: 37, new_members: 6, stopped_members: 4, strong_start_members: 2,
    // Three tasks across two members - the asymmetry test 4 above exists for.
    coach_tasks_opened: 3, coach_tasks_closed: 5, at_risk_members: 0,
    generated_at: VERIFIED, notified_at: VERIFIED,
  }, over || {});
}

// role is the redeemed role of the account that signs into the management
// gate - which, since the management identity landed, is what decides what
// the panel draws. Here the member and the management account are one person,
// the same fixture shape every other panel test uses.
function seeded(role, opts) {
  const o = opts || {};
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : role, redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: [{ club_id: "club-1", module_key: "owner_report", enabled: o.moduleOff ? false : true, config: {} }],
    owner_reports: o.reports === undefined ? [reportRow(MONTH)] : o.reports,
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  seedAdminStepUp(mock, "u1", "dana@members.haimuniya.invalid");
  return mock;
}

async function openClubPanel(window) {
  window.document.getElementById("tabClubManageBtn").click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
}
function reportTabBtn(window) {
  return window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="ownerreport"]');
}
async function openReport(window) {
  const btn = reportTabBtn(window);
  assert.ok(btn, "the report tab is on the club panel");
  btn.click();
  // Past the skeleton, not merely into the section: the lazy load fires from
  // afterRenderManage(), so the first render of this tab is always the
  // loading state and asserting on it would be asserting on nothing.
  await waitFor(() => !!window.document.querySelector("[data-owner-report]")
    && !window.document.querySelector("[data-owner-report-skeleton]"), 3000);
}
const figure = (window, key) => window.document.querySelector(`[data-owner-report-figure="${key}"]`);

// The mock has an onRpc() hook and no equivalent for a plain table read, so a
// failing .from() is modelled by swapping the one table's builder out.
// mgmtDb()'s management client delegates its from() straight to this one, so
// patching here covers the read the panel actually makes.
// A drill-down renders its card immediately and fills it when the RPC comes
// back, so every assertion about a list has to wait for the settled state -
// waiting for the card alone is waiting for the skeleton.
async function waitList(window, metric) {
  await waitFor(() => {
    const el = window.document.querySelector(`[data-owner-report-list="${metric}"]`);
    return !!el && !el.querySelector("[aria-busy]");
  }, 3000);
  return window.document.querySelector(`[data-owner-report-list="${metric}"]`);
}

function failTableRead(mock, table) {
  const real = mock.client.from.bind(mock.client);
  const failing = { data: null, error: { message: "boom" } };
  const builder = {
    select: () => builder, order: () => builder, limit: () => builder, eq: () => builder,
    then: (ok, no) => Promise.resolve(failing).then(ok, no),
  };
  mock.client.from = (t) => (t === table ? builder : real(t));
}

// A plausible owner_report_list() response for one metric.
const listRows = (rows) => rows.map((r, i) => Object.assign({
  user_id: `m${i + 1}`, handle: `member_${i + 1}`, display_name: null, avatar_url: null, value: 1,
}, r));

test("a head coach gets the tab, and its seven figures are the row the server wrote", async () => {
  const window = await bootCommunity(seeded("head_coach"), { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  // All seven, in the order the screen declares them, each carrying its own
  // figure - no derivation, no re-summing, whatever the table said.
  const expected = [
    ["active", "37"], ["new", "6"], ["stopped", "4"], ["strong_start", "2"],
    ["tasks_opened", "3"], ["tasks_closed", "5"], ["at_risk", "0"],
  ];
  for (const [key, value] of expected) {
    const el = figure(window, key);
    assert.ok(el, `${key} is on the screen`);
    assert.ok(el.textContent.includes(value), `${key} shows ${value} — got "${el.textContent.replace(/\s+/g, " ").trim()}"`);
  }
  assert.equal(window.document.querySelectorAll("[data-owner-report-figure]").length, 7,
    "seven figures and no more - a number nobody asked for is a number somebody will act on");
  // The month is named, not implied. A report that does not say which month
  // it is about is a report somebody will read as this one.
  assert.match(window.document.querySelector("[data-owner-report] .ach-section-title").textContent, /2026/);
});

test("a coach gets no tab at all - this is the one staff surface that is not is_staff()", async () => {
  const window = await bootCommunity(seeded("coach"), { syncEnabled: false });
  await openClubPanel(window);
  assert.equal(reportTabBtn(window), null,
    "a coach who can open the club panel still gets no owner-report tab - the server refuses the read either way, and a tab onto a refusal is worse than no tab");
  assert.equal(window.document.querySelector("[data-owner-report]"), null);
});

test("an admin gets it too, because the rank is head_coach AND ABOVE", async () => {
  const window = await bootCommunity(seeded("admin"), { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);
  assert.ok(figure(window, "active"), "the admin reads the club's month");
});

test("with the module off there is no tab, whatever the rank", async () => {
  const window = await bootCommunity(seeded("head_coach", { moduleOff: true }), { syncEnabled: false });
  await openClubPanel(window);
  assert.equal(reportTabBtn(window), null, "switching owner_report off takes the screen away");
});

test("tapping a number opens the list behind it, for that month and that metric", async () => {
  const mock = seeded("head_coach");
  const calls = [];
  mock.onRpc("owner_report_list", (args) => {
    calls.push(args);
    return { data: listRows([{ display_name: "נועה", value: 12 }, { handle: "yuval", value: 3 }]), error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  figure(window, "stopped").click();
  await waitList(window, "stopped");

  assert.deepEqual(calls, [{ p_month_start: MONTH, p_metric: "stopped", p_limit: 500 }],
    "the list is asked for by the month on screen and the metric that was tapped");
  const list = window.document.querySelector('[data-owner-report-list="stopped"]');
  assert.match(list.textContent, /נועה/, "the names are on the screen");
  assert.match(list.textContent, /yuval/, "including a member with no display name, by handle");
  assert.equal(list.querySelectorAll("[data-owner-report-member]").length, 2);
  assert.equal(figure(window, "stopped").getAttribute("aria-expanded"), "true",
    "and the figure says it is expanded, so the disclosure is announced rather than only drawn");
});

test("a zero opens its list too - the number a leader most wants to confirm", async () => {
  const mock = seeded("head_coach");
  const calls = [];
  mock.onRpc("owner_report_list", (args) => { calls.push(args); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  figure(window, "at_risk").click();
  await waitList(window, "at_risk");
  assert.equal(calls.length, 1, "a zero is not a dead control");
  assert.match(window.document.querySelector('[data-owner-report-list="at_risk"]').textContent, /אין חברים/,
    "and it says the list really is empty, which is a different sentence from a failure");
});

test("the task figures count TASKS and their lists count MEMBERS, and the screen says both", async () => {
  const mock = seeded("head_coach");
  // Three tasks across two members - exactly the case the figure and the
  // list are allowed to disagree about.
  mock.onRpc("owner_report_list", () => ({ data: listRows([{ value: 2 }, { value: 1 }]), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  assert.ok(figure(window, "tasks_opened").textContent.includes("3"), "the figure is three tasks");
  figure(window, "tasks_opened").click();
  await waitList(window, "tasks_opened");
  const list = window.document.querySelector('[data-owner-report-list="tasks_opened"]');
  assert.equal(list.querySelectorAll("[data-owner-report-member]").length, 2, "two members");
  assert.match(list.textContent, /2 שמות/,
    "and the list says how many NAMES it holds, so a leader reading 3 above and 2 rows below is told why");
  assert.match(list.textContent, /2 משימות/, "with each member's own task count beside them");
});

test("each list says what its number means, rather than printing a bare integer", async () => {
  const mock = seeded("head_coach");
  mock.onRpc("owner_report_list", (args) => ({
    data: listRows([{ value: args.p_metric === "at_risk" ? 9 : 1 }]), error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  figure(window, "at_risk").click();
  await waitList(window, "at_risk");
  assert.match(window.document.querySelector('[data-owner-report-list="at_risk"]').textContent, /מסומן\/ת 9 ימים/,
    "nine means nine days flagged, not nine sessions");

  figure(window, "active").click();
  await waitList(window, "active");
  assert.match(window.document.querySelector('[data-owner-report-list="active"]').textContent, /אימון אחד/,
    "and one means one training day, in the singular");
});

test("a failed report read says so instead of rendering seven zeros", async () => {
  const mock = seeded("head_coach");
  failTableRead(mock, "owner_reports");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  const section = window.document.querySelector("[data-owner-report]");
  assert.equal(window.document.querySelectorAll("[data-owner-report-figure]").length, 0,
    "no figures at all - a zero here would be a claim about the club that nobody measured");
  assert.match(section.textContent, /לא ניתן היה לטעון את הדוח/);
  assert.ok(section.querySelector('[data-community-action="owner-report-retry"]'), "and offers a retry");
});

test("a failed drill-down leaves the figures alone and does not claim the list is empty", async () => {
  const mock = seeded("head_coach");
  mock.onRpc("owner_report_list", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  figure(window, "stopped").click();
  await waitList(window, "stopped");
  const list = window.document.querySelector('[data-owner-report-list="stopped"]');
  assert.match(list.textContent, /לא ניתן היה לטעון את הרשימה/,
    "'nobody stopped attending' is exactly the wrong thing to tell a head coach whose request failed");
  assert.ok(figure(window, "stopped").textContent.includes("4"),
    "and the seven figures, which loaded fine, are still on the screen");
});

test("a club with no report yet is told when the first one arrives, not that it has no data", async () => {
  const window = await bootCommunity(seeded("head_coach", { reports: [] }), { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);
  const section = window.document.querySelector("[data-owner-report]");
  assert.match(section.textContent, /החודש הבא/,
    "the report is produced once a month by the recap job - a club that switched this on today is waiting for the calendar, not missing data");
  assert.equal(window.document.querySelectorAll("[data-owner-report-figure]").length, 0);
});

test("paging to another month closes the list that belonged to the one before it", async () => {
  const mock = seeded("head_coach");
  mock.db.owner_reports = [reportRow(MONTH), reportRow(PREV_MONTH, { stopped_members: 11 })];
  mock.onRpc("owner_report_list", () => ({ data: listRows([{ display_name: "נועה" }]), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubPanel(window);
  await openReport(window);

  figure(window, "stopped").click();
  await waitList(window, "stopped");

  window.document.querySelector(`[data-community-action="owner-report-month"][data-month="${PREV_MONTH}"]`).click();
  await waitFor(() => figure(window, "stopped").textContent.includes("11"), 3000);
  assert.equal(window.document.querySelector("[data-owner-report-list]"), null,
    "a list of July's names under an August header is a screen that is quietly lying");
});
