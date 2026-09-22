#!/usr/bin/env node
// 202609220004. The monthly owner report, measured where the club reads it.
//
// WHY THIS CANNOT BE A NODE TEST. test/owner-report.test.mjs already drives
// the whole screen for real - who gets the tab, every figure opening its
// list, the two failure states, the month paging - and it is right about all
// of them. What it cannot see is that any of it FITS, because jsdom has no
// layout. This screen is a hard case for a 390px RTL phone in a way none of
// the panels beside it is:
//
//   * EVERY FIGURE ROW IS A FLEX ROW with a long Hebrew sentence on one side
//     and a number on the other. In RTL the number is the LEFT-most item, so
//     a text column that will not shrink pushes it to a negative x - off the
//     screen, silently, with the row still looking plausible. That is the
//     same failure club-module-row-layout.mjs was written for, one screen
//     over, and it is held by the same two properties (a column that may
//     shrink, min-width:0).
//   * THE FIGURE IS THE CONTROL. Each row is a button, so "fits" is not
//     enough - it has to stay at least 44px tall, or the drill-down is
//     unreachable on the device most of these are read on.
//   * THE LIST OPENS UNDERNEATH ITSELF, inside a card, inside the manage
//     column. A row that overflows there gives the whole app a horizontal
//     scrollbar.
//
// AND ONE THING THAT IS NOT ABOUT LAYOUT AT ALL, checked here because this is
// the only place a real browser runs the screen: the figures and the list
// come from two different server calls, and the list must not render under
// the wrong month. The month chips are clicked for real and the open list is
// asserted gone.
//
// EVERY GEOMETRY ASSERTION IS PAIRED WITH A CONTROL, the same discipline
// club-module-row-layout.mjs and desktop-invite-form-width.mjs use: the two
// rules are removed live and the same page re-measured, proving it WOULD
// fail without them.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal, switchTab, submitManagementGate } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const HC = "eeeeeeee-0000-4000-8000-000000000001";
const VERIFIED = new Date().toISOString();
const MONTH = "2026-08-01";
const PREV = "2026-07-01";
const METRICS = ["active", "new", "stopped", "strong_start", "tasks_opened", "tasks_closed", "at_risk"];

const report = (month, over) => Object.assign({
  id: `rep-${month}`, club_id: "club-1", month_start: month, recap_id: `recap-${month}`,
  // Three digits on every figure: the widest a number gets, which is the
  // width the row has to survive rather than the width it usually sees.
  active_members: 137, new_members: 106, stopped_members: 104, strong_start_members: 102,
  coach_tasks_opened: 103, coach_tasks_closed: 105, at_risk_members: 0,
  generated_at: VERIFIED, notified_at: VERIFIED,
}, over || {});

// A head coach, which is the narrowest role that may see any of this.
const seed = {
  profiles: [
    { id: HC, handle: "roni_head_coach", display_name: "רוני", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "mem-1", handle: "noa_levi", display_name: "נועה לוי־אברמוביץ'", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [{ user_id: HC, invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  club_features: [{ club_id: "club-1", module_key: "owner_report", enabled: true, config: {} }],
  owner_reports: [report(MONTH), report(PREV, { stopped_members: 11 })],
  workout_posts: [], feed_page_rows: [], post_comments: [], reports: [], admin_actions: [],
  pins: [], posting_restrictions: [], follows: [], hidden_posts: [], notifications: [],
  notification_preferences: [], coach_engagement_flags: [], analytics_events: [],
};

// owner_report_list() is a SECURITY DEFINER read over four tables the mock
// has no stand-in for, so it is stubbed with the rows supabase/tests/0121
// proves the real one returns. This scenario is about geometry, not rules.
//
// REGISTERED AS AN INIT SCRIPT so it is in place before any render can fire,
// the same reason coach-task-list.mjs registers its own that way.
async function stubList(page) {
  await page.addInitScript(() => {
    window.__mock.onRpc("owner_report_list", (args) => ({
      data: [
        { user_id: "mem-1", handle: "noa_levi", display_name: "נועה לוי־אברמוביץ'", avatar_url: null, value: 12 },
        { user_id: "mem-2", handle: "yuval_ben_shimon", display_name: null, avatar_url: null, value: 3 },
        { user_id: "mem-3", handle: "a", display_name: "דוד", avatar_url: null, value: 1 },
      ].slice(0, args.p_metric === "at_risk" ? 0 : 3),
      error: null,
    }));
  });
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);
const browser = await chromium.launch();

async function openReport(page) {
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);
  // The CLUB management panel, which is where the head coach works. It is a
  // separate identity, so a login stands in front of it.
  //
  // Two routes to the same tab, because there are two navigations: the
  // hamburger on a phone, and the persistent sidebar at desktop widths, where
  // #navMenuBtn is not visible at all and switchTab() has nothing to click.
  // isVisible(), not $(): the sidebar row is in the DOM at every width and is
  // merely hidden on a phone, so a bare selector match would click nothing.
  const sidebarRow = page.locator('#desktopSidebar .navrow[data-tab="clubmanage"]');
  if (await sidebarRow.isVisible()) await sidebarRow.click();
  else await switchTab(page, "tabClubManageBtn");
  await page.evaluate((id) => window.__mock.seedCredentials(id, "roni@members.haimuniya.invalid", "Aa123456789!"), HC);
  await submitManagementGate(page, "roni@members.haimuniya.invalid", "Aa123456789!");
  await page.waitForSelector("#content .subtabbar[aria-label='ניווט בניהול']", { timeout: 10000 });
  await page.click(".subtabbtn[data-community-action='set-manage-tab'][data-tab='ownerreport']");
  await page.waitForSelector("[data-owner-report-figure]", { timeout: 10000 });
}

// Every figure row's own box, its number, and the column it sits in.
const measure = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const section = document.querySelector("[data-owner-report]");
  const s = section.getBoundingClientRect();
  const rows = [...document.querySelectorAll("[data-owner-report-figure]")].map((el) => {
    const r = el.getBoundingClientRect();
    const spans = el.querySelectorAll(":scope > span");
    const text = spans[0] ? spans[0].getBoundingClientRect() : null;
    const num = spans[1] ? spans[1].getBoundingClientRect() : null;
    return {
      key: el.dataset.ownerReportFigure,
      left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
      textLeft: text ? Math.round(text.left) : null, textRight: text ? Math.round(text.right) : null,
      numLeft: num ? Math.round(num.left) : null, numRight: num ? Math.round(num.right) : null,
      numW: num ? Math.round(num.width) : null,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
    };
  });
  return {
    vw, docScrollW: document.documentElement.scrollWidth,
    sectionLeft: Math.round(s.left), sectionRight: Math.round(s.right), sectionW: Math.round(s.width),
    rows,
  };
});

// --- 1. THE PHONE, WHICH IS WHERE THIS IS READ ---------------------------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, seed, { user: { id: HC, is_anonymous: false, email: "roni@members.haimuniya.invalid" } });
  await stubList(page);
  await openReport(page);

  const m = await measure(page);
  console.log(`viewport ${m.vw}px, section ${m.sectionW}px, document scrollWidth ${m.docScrollW}px`);

  check("all seven figures are on the screen", m.rows.length === 7,
    `${m.rows.length}: ${m.rows.map((r) => r.key).join(", ")}`);
  check("and they are the seven the server writes", METRICS.every((k) => m.rows.some((r) => r.key === k)),
    m.rows.map((r) => r.key).join(", "));

  for (const r of m.rows) {
    check(`${r.key}: the row stays inside the panel`,
      r.left >= m.sectionLeft - 1 && r.right <= m.sectionRight + 1,
      `row ${r.left}..${r.right} in ${m.sectionLeft}..${m.sectionRight}`);
    // THE FAILURE THIS SCRIPT EXISTS FOR. In RTL the number is the LEFT-most
    // item, so an over-wide text column pushes it to a negative x, where a
    // phone shows nothing and reports no error.
    check(`${r.key}: the number itself is fully on screen`,
      r.numLeft !== null && r.numLeft >= 0 && r.numRight <= m.vw && r.numW >= 8,
      `number ${r.numLeft}..${r.numRight} (${r.numW}px) of ${m.vw}`);
    check(`${r.key}: the label and the number do not overlap`,
      r.textLeft !== null && r.numRight !== null && r.textLeft >= r.numRight - 1,
      `text starts ${r.textLeft}, number ends ${r.numRight}`);
    check(`${r.key}: the row does not scroll sideways inside itself`,
      r.scrollW <= r.clientW + 1, `scrollWidth=${r.scrollW} clientWidth=${r.clientW}`);
    // It is a button before it is a figure.
    check(`${r.key}: it is big enough to tap`, r.h >= 44, `${r.w}×${r.h}px`);
  }
  check("no horizontal overflow on the document", m.docScrollW <= m.vw + 1,
    `scrollWidth=${m.docScrollW}, clientWidth=${m.vw}`);

  // --- the drill-down, opened for real -----------------------------------
  await page.click('[data-owner-report-figure="stopped"]');
  await page.waitForSelector('[data-owner-report-list="stopped"] [data-owner-report-member]', { timeout: 10000 });
  const list = await page.evaluate(() => {
    const card = document.querySelector("[data-owner-report-list]");
    const c = card.getBoundingClientRect();
    return {
      vw: document.documentElement.clientWidth,
      docScrollW: document.documentElement.scrollWidth,
      cardLeft: Math.round(c.left), cardRight: Math.round(c.right),
      rows: [...card.querySelectorAll("[data-owner-report-member]")].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
        };
      }),
      // The figure that opened it must still be where it was: the card is a
      // SIBLING of the figure list, not a child of a row, precisely so
      // opening one cannot move the others.
      figures: document.querySelectorAll("[data-owner-report-figure]").length,
    };
  });
  check("the list opens with its members on screen", list.rows.length === 3, `${list.rows.length} rows`);
  for (const [i, r] of list.rows.entries()) {
    check(`list row ${i + 1}: stays inside the card`,
      r.left >= list.cardLeft - 1 && r.right <= list.cardRight + 1,
      `${r.left}..${r.right} in ${list.cardLeft}..${list.cardRight}`);
    // The longest name in the fixture is a hyphenated Hebrew double-barrel,
    // which is the unbreakable run that actually overflows a narrow row.
    check(`list row ${i + 1}: does not scroll sideways`, r.scrollW <= r.clientW + 1,
      `scrollWidth=${r.scrollW} clientWidth=${r.clientW}`);
  }
  check("the seven figures are all still there with the list open", list.figures === 7, `${list.figures}`);
  check("no horizontal overflow with the list open", list.docScrollW <= list.vw + 1,
    `scrollWidth=${list.docScrollW}, clientWidth=${list.vw}`);

  // --- the month chips, clicked for real ---------------------------------
  await page.click(`[data-community-action="owner-report-month"][data-month="${PREV}"]`);
  await page.waitForFunction(() => !document.querySelector("[data-owner-report-list]"), { timeout: 10000 });
  const paged = await page.evaluate(() => ({
    stopped: document.querySelector('[data-owner-report-figure="stopped"]').textContent.replace(/\s+/g, " ").trim(),
    docScrollW: document.documentElement.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  check("paging to another month closes the list that belonged to the last one",
    !paged.stopped.includes("104"), paged.stopped.slice(0, 60));
  check("and still no horizontal overflow after paging",
    paged.docScrollW <= paged.vw + 1, `scrollWidth=${paged.docScrollW}`);

  // --- control ------------------------------------------------------------
  // If this passes trivially the measurements above prove nothing about the
  // layout - they would hold on any markup. It has to genuinely fail.
  await page.addStyleTag({ content: `
    [data-owner-report-figure] > span:first-child {
      flex-direction: row !important;
      min-width: auto !important;
      white-space: nowrap !important;
    }
  ` });
  const broken = await measure(page);
  const pushed = broken.rows.some((r) => r.numLeft < 0 || r.numRight > broken.vw);
  check("control: without the column/min-width rules the number IS pushed off screen or the page overflows",
    pushed || broken.docScrollW > broken.vw + 1,
    `pushed=${pushed}, scrollWidth=${broken.docScrollW} vs ${broken.vw}`);

  check("no console errors on the phone", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- 2. THE SAME SCREEN ON A DESKTOP MANAGE COLUMN -----------------------
// The manage panel is the one surface that is NOT inside the 560px logging
// column, so the report gets a different width here and the same row has to
// hold up at both ends of the range.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, seed, { user: { id: HC, is_anonymous: false, email: "roni@members.haimuniya.invalid" } });
  await stubList(page);
  await openReport(page);

  const m = await measure(page);
  console.log(`desktop: viewport ${m.vw}px, section ${m.sectionW}px`);
  for (const r of m.rows) {
    check(`desktop ${r.key}: the number is on screen`,
      r.numLeft >= 0 && r.numRight <= m.vw, `${r.numLeft}..${r.numRight}`);
    check(`desktop ${r.key}: still tappable`, r.h >= 44, `${r.w}×${r.h}px`);
  }
  check("desktop: no horizontal overflow", m.docScrollW <= m.vw + 1,
    `scrollWidth=${m.docScrollW}, clientWidth=${m.vw}`);
  check("no console errors on the desktop", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
