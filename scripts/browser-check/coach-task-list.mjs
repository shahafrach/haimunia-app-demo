#!/usr/bin/env node
// 202609220002. The coach task list, measured where it actually lives.
//
// WHY THIS CANNOT BE A NODE TEST. test/coach-tasks.test.mjs already drives
// the whole list for real - the rules, the rule labels, the two actions, the
// failed-read state - and it is right about every one of them. What it cannot
// see is that any of it FITS, because jsdom has no layout. This list is the
// hardest thing this app has yet put in the 300-360px context rail: each row
// carries two chips, a name, two lines of Hebrew detail, a free-text input
// and two buttons, in RTL, inside the narrowest column on the screen.
//
// THE THREE FAILURES IT IS LOOKING FOR, all of which are silent:
//   1. A row overflowing the rail. In RTL an over-wide child does not clip -
//      it pushes its siblings off the LEFT edge, where a coach sees nothing
//      at all and no error is reported anywhere.
//   2. The note input, which is the one control here with no natural width.
//      A text input at its default size inside a 320px column is the
//      classic source of a horizontal scrollbar on the whole page.
//   3. The same list on a PHONE, in the coach tab, where the row has more
//      width but the buttons have to stay tappable.
//
// AND ONE THING THAT IS NOT ABOUT THIS FEATURE AT ALL: a member at the same
// desktop viewport must still measure exactly what they measured before -
// 560px logging column at x=300, no context column. The task list is staff
// data behind is_staff(), and the desktop shell has exactly one rule that
// keeps members off it (there is no rule keyed on data-layout alone). A
// feature that filled the rail is the most likely thing to break it.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, consoleErrorCollector } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const COACH = "c0ffee00-0000-4000-8000-000000000001";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000009";
const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (d) => new Date(NOW + d * 86400000).toISOString();
const day = (d) => iso(d).slice(0, 10);

// Five tasks, one per rule, so every label and both chip states are on
// screen at once - the widest the list can get.
const TASKS = [
  { id: "t-1", rule_key: "no_contact_30", due_on: day(-6), overdue: true,  days_since_join: 412, sessions_logged: 96, assigned_coach_name: "מאמן ראשי" },
  { id: "t-2", rule_key: "welcome",       due_on: day(1),  overdue: false, days_since_join: 2,   sessions_logged: 0,  assigned_coach_name: null },
  { id: "t-3", rule_key: "first_class_followup", due_on: day(2), overdue: false, days_since_join: 6, sessions_logged: 1, assigned_coach_name: null },
  { id: "t-4", rule_key: "low_attendance", due_on: day(0), overdue: false, days_since_join: 22, sessions_logged: 1, assigned_coach_name: "מאמן ראשי" },
  { id: "t-5", rule_key: "day_60_checkin", due_on: day(4), overdue: false, days_since_join: 61, sessions_logged: 24, assigned_coach_name: null },
].map((t) => Object.assign({
  user_id: MEMBER, handle: "noa_levi", display_name: "נועה לוי־אברמוביץ'",
  avatar_url: null, opened_at: iso(-3), assigned_coach_id: null,
  joined_on: day(-30), contacted_at: null, closed_at: null, detail: {},
}, t));

const staffSeed = {
  profiles: [
    { id: COACH, handle: "coach_x", display_name: "מאמן", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: VERIFIED },
    { id: MEMBER, handle: "noa_levi", display_name: "נועה לוי־אברמוביץ'", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: VERIFIED },
  ],
  invite_redemptions: [
    { user_id: COACH, invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    { user_id: MEMBER, invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  club_features: [{ club_id: "club-1", module_key: "coach_tasks", enabled: true, config: {} }],
  announcements: [], workout_posts: [], community_streaks: [], member_contact_log: [],
  notifications: [], notification_preferences: [], analytics_events: [], coach_tasks: [],
};
const staffUser = { id: COACH, is_anonymous: false, email: "coach@members.haimuniya.invalid" };

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);
const browser = await chromium.launch();

async function openApp(page) {
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);
}
// coach_tasks_refresh() is a SECURITY DEFINER read with no table behind it in
// the mock, so it is stubbed with the rows supabase/tests/0118 proves the
// real one returns. This scenario is about geometry, not about the rules.
//
// REGISTERED AS AN INIT SCRIPT, not through withMock() after the page loads,
// and that is not a style preference. app.js calls staffHomeAfterRender() on
// every render where the staff shell is on, so the first read fires the
// instant data-staff flips - which is before any post-navigation evaluate can
// run. Stubbing afterwards left the list in its error state with loaded=true,
// and nothing later re-read it. Init scripts run in registration order, so
// this one sees the window.__mock installMockCloud's own glue just created.
async function stubTasks(page, rows) {
  await page.addInitScript((r) => {
    window.__mock.onRpc("coach_tasks_refresh", () => ({ data: r, error: null }));
  }, rows);
}
// Every row's own box, the rail it sits in, and the controls that have no
// natural width.
const measureRows = (page, containerSel) => page.evaluate((sel) => {
  const container = document.querySelector(sel);
  if (!container) return { missing: true };
  const c = container.getBoundingClientRect();
  const section = container.querySelector("[data-coach-tasks-section]") || container;
  const s = section.getBoundingClientRect();
  const rows = [...container.querySelectorAll("[data-coach-task]")].map((el) => {
    const r = el.getBoundingClientRect();
    const input = el.querySelector("input[type=text], input:not([type])");
    const i = input ? input.getBoundingClientRect() : null;
    const buttons = [...el.querySelectorAll("button.chip-btn")].map((b) => {
      const br = b.getBoundingClientRect();
      return { left: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width), h: Math.round(br.height) };
    });
    return {
      id: el.dataset.coachTask,
      left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
      input: i ? { left: Math.round(i.left), right: Math.round(i.right), w: Math.round(i.width), h: Math.round(i.height) } : null,
      buttons,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
    };
  });
  return {
    containerLeft: Math.round(c.left), containerRight: Math.round(c.right), containerW: Math.round(c.width),
    sectionLeft: Math.round(s.left), sectionRight: Math.round(s.right),
    rows,
    vw: document.documentElement.clientWidth,
    docScrollW: document.documentElement.scrollWidth,
  };
}, containerSel);

function assertRowsFit(where, m) {
  check(`${where}: every task row is on screen`, m.rows.length === TASKS.length, `${m.rows.length} of ${TASKS.length}`);
  for (const r of m.rows) {
    // THE RTL OVERFLOW. A child wider than its column pushes left, into
    // negative x, where nothing is drawn and nothing complains.
    check(`${where}: ${r.id} stays inside its column`,
      r.left >= m.containerLeft - 1 && r.right <= m.containerRight + 1,
      `row ${r.left}..${r.right} in ${m.containerLeft}..${m.containerRight}`);
    check(`${where}: ${r.id} does not scroll sideways inside itself`,
      r.scrollW <= r.clientW + 1, `scrollWidth=${r.scrollW} clientWidth=${r.clientW}`);
    check(`${where}: ${r.id}'s note field is inside the row and usable`,
      !!r.input && r.input.left >= r.left - 1 && r.input.right <= r.right + 1 && r.input.w >= 80 && r.input.h >= 28,
      r.input ? `${r.input.left}..${r.input.right} (${r.input.w}×${r.input.h}) in ${r.left}..${r.right}` : "no input");
    check(`${where}: ${r.id}'s two actions are both on screen and tappable`,
      r.buttons.length === 2 && r.buttons.every((b) => b.left >= 0 && b.right <= m.vw && b.w >= 44 && b.h >= 28),
      r.buttons.map((b) => `${b.left}..${b.right} ${b.w}×${b.h}`).join(" | "));
  }
  check(`${where}: no horizontal overflow on the document`, m.docScrollW <= m.vw + 1,
    `scrollWidth=${m.docScrollW}, clientWidth=${m.vw}`);
}

// --- 1. THE DESKTOP STAFF RAIL -------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, staffSeed, { user: staffUser });
  await stubTasks(page, TASKS);
  await openApp(page);
  await page.waitForFunction(() => document.documentElement.getAttribute("data-staff") === "1");
  await page.click('#desktopSidebar .navrow[data-tab="staffhome"]');
  await page.waitForSelector("#content .staff-home");
  await page.waitForSelector("#contextCol [data-coach-tasks-section]", { timeout: 10000 });
  await page.waitForSelector("#contextCol [data-coach-task]", { timeout: 10000 });

  const m = await measureRows(page, "#contextCol");
  console.log(`context rail ${m.containerW}px, viewport ${m.vw}px`);
  check("the task list is IN the context rail, not in the centre column",
    !m.missing && m.rows.length > 0, `rows=${m.rows.length}`);
  // The rail is the narrowest column on the screen and the reason this file
  // exists. 300-360px is the range desktop-staff-shell.mjs already pins.
  check("the rail is still 300-360px wide with the list in it",
    m.containerW >= 300 && m.containerW <= 360, `w=${m.containerW}`);
  assertRowsFit("rail", m);

  // The list comes FIRST in the rail: it is the only section in it that is
  // literally a to-do list, and a work queue under three browsable sections
  // stops being one.
  const firstSection = await page.evaluate(() => {
    const el = document.querySelector("#contextCol .ach-section");
    return el ? el.hasAttribute("data-coach-tasks-section") : null;
  });
  check("and it is the first section in the rail", firstSection === true, `first=${firstSection}`);

  // The actions really work at this width, not merely fit.
  await page.click('#contextCol [data-community-action="coach-task-dismiss"][data-id="t-2"]');
  await page.waitForFunction(() => !document.querySelector('#contextCol [data-coach-task="t-2"]'), { timeout: 10000 });
  check("a task can actually be closed from the rail", true, "t-2 left the list");

  check("no console errors on the staff desktop", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- 2. A MEMBER AT THE SAME VIEWPORT ------------------------------------
// The one rule that keeps members off the staff shell is the absence of a
// rule. Re-measured here because this feature is the first thing to put real
// content in the rail, and "the rail appeared for everyone" is exactly the
// failure that would not show up in any test of the feature itself.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page);
  await openApp(page);
  const g = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { x: Math.round(r.x), w: Math.round(r.width) };
    };
    return {
      staff: document.documentElement.getAttribute("data-staff"),
      app: box("#app"), sidebar: box("#desktopSidebar"), context: box("#contextCol"),
      contextChildren: document.getElementById("contextCol").children.length,
      tasks: document.querySelectorAll("[data-coach-tasks-section]").length,
      scrollWidth: document.documentElement.scrollWidth, vw: window.innerWidth,
    };
  });
  check("a member still carries no data-staff", g.staff === null, `staff=${g.staff}`);
  check("the member logging column is still 560px at x=300", !!g.app && g.app.w === 560 && g.app.x === 300, JSON.stringify(g.app));
  check("the member sidebar is still 248px at x=892", !!g.sidebar && g.sidebar.w === 248 && g.sidebar.x === 892, JSON.stringify(g.sidebar));
  check("the member context column is still absent, not an empty box",
    g.context === null && g.contextChildren === 0, `box=${JSON.stringify(g.context)} children=${g.contextChildren}`);
  check("and no task list is rendered anywhere for a member", g.tasks === 0, `sections=${g.tasks}`);
  check("no horizontal scroll", g.scrollWidth <= g.vw, `scrollWidth=${g.scrollWidth}`);
  check("no console errors on the member desktop", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- 3. THE PHONE, WHERE MOST COACHES ACTUALLY READ IT -------------------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, staffSeed, { user: staffUser });
  await stubTasks(page, TASKS);
  await openApp(page);
  await page.click("#tabCommunityBtn");
  await page.waitForSelector('[data-community-action="set-tab"][data-tab="coach"]', { timeout: 10000 });
  await page.click('[data-community-action="set-tab"][data-tab="coach"]');
  await page.waitForSelector("[data-coach-task]", { timeout: 10000 });

  const m = await measureRows(page, "#content");
  console.log(`phone content ${m.containerW}px, viewport ${m.vw}px`);
  assertRowsFit("phone", m);

  // The list is at the TOP of the coach tab, above the browsable sections.
  const first = await page.evaluate(() => {
    const el = document.querySelector("#content .ach-section");
    return el ? el.hasAttribute("data-coach-tasks-section") : null;
  });
  check("phone: the task list is the first section on the coach tab", first === true, `first=${first}`);

  check("no console errors on the coach phone", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
