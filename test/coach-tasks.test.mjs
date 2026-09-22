// 202609220002, part 1. The coach task list, driven for real.
//
// The five RULES are Postgres's and are proved in
// supabase/tests/0118_coach_tasks_test.sql against real rows and real RLS.
// What this file owns is everything that happens once coach_tasks_refresh()
// has answered:
//
//   * the list appears on BOTH staff surfaces - the mobile coach tab and the
//     desktop "דורש תשומת לב" rail - and is the same renderer in both, so an
//     action taken in one goes through one code path rather than two;
//   * the module switch really hides it in the client as well (the server
//     already returns nothing, which is the boundary; this is the shell);
//   * "סימון כנוצר קשר" writes a member_contact_log row and nothing else -
//     the client never closes a task by hand on that path, because the close
//     rule lives in a trigger and a second copy of it here would be the
//     drift this repository keeps finding;
//   * "לא רלוונטי" is the other path, and it IS a direct coach_tasks update,
//     which is the one write the table's policy allows a coach;
//   * a failed read says so instead of rendering "no tasks today", which is
//     the single most damaging thing this surface could get wrong.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const daysAgoIso = (d) => new Date(NOW - d * 86400000).toISOString();
const isoDay = (d) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

function task(extra) {
  return Object.assign({
    id: "t-1", user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null,
    rule_key: "welcome", opened_at: daysAgoIso(2), due_on: isoDay(3), overdue: false,
    assigned_coach_id: null, assigned_coach_name: null,
    joined_on: isoDay(-3), days_since_join: 3, sessions_logged: 0,
    contacted_at: null, closed_at: null, detail: {},
  }, extra || {});
}

function seeded(tasks, featureEnabled) {
  const mock = createMockSupabase({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) },
      { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(3) },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "coach", redeemed_at: daysAgoIso(400) },
      { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: daysAgoIso(3) },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: [{ club_id: "club-1", module_key: "coach_tasks", enabled: featureEnabled !== false, config: {} }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    coach_tasks: (tasks || []).map((t) => ({ id: t.id, user_id: t.user_id, closed_at: null })),
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("coach_tasks_refresh", () => ({ data: tasks || [], error: null }));
  return mock;
}
async function openCoachTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
}
function section(window) { return window.document.querySelector("[data-coach-tasks-section]"); }
// The shell renders immediately and the rows arrive with the RPC, so every
// assertion here waits for the skeleton to go rather than for the section to
// appear - the difference between the two is the whole loading state.
async function settled(window) {
  await waitFor(() => !!section(window), 3000);
  await waitFor(() => !section(window).querySelector('[aria-busy="true"]'), 3000);
  return section(window);
}

test("the task list renders on the coach tab, with the rule, the member and what the list means", async () => {
  const window = await bootCommunity(seeded([
    task({ id: "t-1", rule_key: "welcome" }),
    task({ id: "t-2", rule_key: "no_contact_30", user_id: "u9", overdue: true, due_on: isoDay(-4), days_since_join: 120, sessions_logged: 12 }),
  ]), { syncEnabled: false });
  await openCoachTab(window);
  const text = (await settled(window)).textContent;

  assert.match(text, /משימות להיום/, "the section has a heading a coach can find");
  assert.match(text, /קבלת פנים/, "the welcome rule is named in Hebrew, not as rule_key");
  assert.match(text, /בלי קשר חודש/, "and so is the no-contact rule");
  assert.ok(!/no_contact_30/.test(text), "no raw rule key reaches the screen");
  assert.match(text, /נועה/, "the member is named");
  // THE SENTENCE THAT MAKES THE LIST HONEST. A coach who does not know a task
  // closes itself on contact will close them by hand and wonder why they come
  // back, or will not close them at all.
  assert.match(text, /נסגרת לבד ברגע שנרשם קשר/, "the section says how a task closes");
  assert.match(text, /באיחור/, "an overdue task is marked");
  assert.match(text, /2 משימות, 1 באיחור/, "and the count distinguishes the two");
});

test("the session count says it is a count of app entries, never of classes attended", async () => {
  // The same promise PRIVACY.md makes and renderCoachNewMembersSection()
  // already carries for the same number. A coach reading "12" beside a name
  // on a task list will read it as attendance unless the words say otherwise.
  const window = await bootCommunity(seeded([task({ sessions_logged: 12 })]), { syncEnabled: false });
  await openCoachTab(window);
  await settled(window);
  assert.match(section(window).textContent, /12 אימונים באפליקציה/, "the unit is named");

  const one = await bootCommunity(seeded([task({ sessions_logged: 1 })]), { syncEnabled: false });
  await openCoachTab(one);
  await settled(one);
  assert.match(section(one).textContent, /אימון אחד באפליקציה/, "and the singular has its own branch");
  assert.ok(!/1 אימונים/.test(section(one).textContent), "never '1 אימונים'");

  const none = await bootCommunity(seeded([task({ sessions_logged: 0 })]), { syncEnabled: false });
  await openCoachTab(none);
  await settled(none);
  assert.match(section(none).textContent, /לא רשמו אימון באפליקציה/, "and zero is a sentence, not a 0");
});

test("a task with no assigned coach says so - the welcome rule asks for a NAMED coach", async () => {
  const window = await bootCommunity(seeded([task({})]), { syncEnabled: false });
  await openCoachTab(window);
  await settled(window);
  assert.match(section(window).textContent, /בלי מאמן\/ת אחראי\/ת/, "an unassigned task is visibly unassigned");

  const assigned = await bootCommunity(seeded([task({ assigned_coach_id: "u1", assigned_coach_name: "דנה" })]), { syncEnabled: false });
  await openCoachTab(assigned);
  await settled(assigned);
  assert.match(section(assigned).textContent, /אחריות: דנה/, "and an assigned one names the coach");
});

test("marking a task contacted writes ONE member_contact_log row and closes nothing by hand", async () => {
  const mock = seeded([task({ id: "t-1" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await settled(window);

  const note = window.document.querySelector('[data-coach-task-note="u9"]');
  note.value = "דיברנו אחרי האימון";
  note.dispatchEvent(new window.Event("input", { bubbles: true }));

  window.document.querySelector('[data-community-action="coach-task-contact"][data-id="t-1"]').click();
  await waitFor(() => mock.db.member_contact_log.length === 1, 3000);

  assert.equal(mock.db.member_contact_log[0].user_id, "u9", "the row is about the member, not the task");
  assert.equal(mock.db.member_contact_log[0].note, "דיברנו אחרי האימון", "and carries the coach's note");
  // THE POINT. The close rule is a trigger on member_contact_log. A client
  // that also wrote coach_tasks here would be a second copy of it, and the
  // two would disagree the first time the rule changed.
  assert.equal(mock.db.coach_tasks.filter((t) => t.closed_at).length, 0,
    "the client closes nothing itself - the database's own trigger owns that");
});

test("'לא רלוונטי' is the other path, and it is the one direct coach_tasks write a coach may make", async () => {
  const mock = seeded([task({ id: "t-1" }), task({ id: "t-2", rule_key: "day_60_checkin" })]);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await settled(window);

  window.document.querySelector('[data-community-action="coach-task-dismiss"][data-id="t-1"]').click();
  await waitFor(() => !!mock.db.coach_tasks.find((t) => t.id === "t-1").closed_at, 3000);

  assert.equal(mock.db.member_contact_log.length, 0,
    "dismissing a task is not a claim that anybody was contacted - no contact row is invented");
  assert.equal(mock.db.coach_tasks.find((t) => t.id === "t-2").closed_at, null,
    "and only the task that was dismissed is closed");
  await waitFor(() => !section(window).textContent.includes("קבלת פנים"), 3000);
  assert.match(section(window).textContent, /שיחת יום 60/, "the other task stays on the list");
});

test("a failed read says so and offers a retry - it never renders as 'no tasks today'", async () => {
  const mock = seeded([]);
  mock.onRpc("coach_tasks_refresh", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  const text = (await settled(window)).textContent;
  assert.match(text, /לא ניתן היה לטעון את המשימות/, "the failure is stated");
  assert.ok(!/אין משימות פתוחות/.test(text),
    "and is NOT reported as an empty list - telling a coach there is nothing to do because a read failed is the worst outcome this surface has");
  assert.ok(section(window).querySelector('[data-community-action="coach-tasks-retry"]'), "with a retry");
});

test("an empty list is an empty list, and says what would put something in it", async () => {
  const window = await bootCommunity(seeded([]), { syncEnabled: false });
  await openCoachTab(window);
  const text = (await settled(window)).textContent;
  assert.match(text, /אין משימות פתוחות/, "the empty state is stated plainly");
  assert.match(text, /תופיע כאן/, "and says what would fill it, rather than leaving a coach to guess");
});

test("switching the module off removes the section entirely, and asks the server for nothing", async () => {
  const mock = seeded([task({})], false);
  let calls = 0;
  mock.onRpc("coach_tasks_refresh", () => { calls++; return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("לחגוג"), 3000);
  assert.equal(section(window), null, "no shell, no heading, no empty state");
  assert.equal(calls, 0, "and no call is made - the module gate is checked before the read, not after it");
});

test("the desktop staff rail renders the same section, through the same renderer", async () => {
  // renderStaffContextColumn() is what app.js puts in the desktop context
  // column. Calling it directly is how this is testable in jsdom, which has
  // no layout and therefore no desktop shell - the GEOMETRY of that column is
  // scripts/browser-check/coach-task-list.mjs's job, and the two together are
  // the whole claim.
  const window = await bootCommunity(seeded([task({ rule_key: "low_attendance" })]), { syncEnabled: false });
  await openCoachTab(window);
  await settled(window);

  const html = window.renderStaffContextColumn();
  assert.match(html, /דורש תשומת לב/, "it is the attention rail");
  assert.match(html, /data-coach-tasks-section/, "and the task section is in it");
  assert.match(html, /כמעט לא הגיע/, "with the same rule labels the coach tab shows");
  // FIRST in the rail. The rail is the one place on the staff home allowed to
  // be a to-do list, and this is the only section in it that literally is one.
  assert.ok(html.indexOf("data-coach-tasks-section") < html.indexOf("קבלת פנים"),
    "the task list comes before the browsable sections rather than under them");
});

test("a blocked member's task is filtered out of the list, like every other member list on this tab", async () => {
  const mock = seeded([task({ id: "t-1", user_id: "u9" })]);
  mock.db.blocks = [{ blocker_id: "u1", blocked_id: "u9", created_at: VERIFIED }];
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await settled(window);
  assert.ok(!/נועה/.test(section(window).textContent),
    "a coach who has blocked somebody is not handed them as a task");
});
