#!/usr/bin/env node
// The desktop staff shell, measured in a real browser at 1440px.
//
// WHY THIS CANNOT BE A NODE TEST. The shell turns on `(pointer: fine)` and
// lays out with `:has()`, sticky positioning and a flex row in an RTL
// document. jsdom has no layout at all, so the node tests can only assert
// which attributes and which markup exist - they cannot see that the rail
// landed on the RIGHT, that three columns fit, or that nothing overflows.
// Those are the claims this file checks, and they are the ones that would
// fail silently.
//
// TWO ACCOUNTS, and the second one is the point. A staff account should get
// the three-column shell; a MEMBER at the identical viewport should measure
// exactly what they measured before this feature existed - same sidebar
// width, same 560px logging column, same absent context column. The member
// half is not a formality: it is the whole promise of the feature.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, consoleErrorCollector } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);
const browser = await chromium.launch();

// Geometry of the three columns plus the page, in one read.
const geometry = (page) => page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: Math.round(r.x), w: Math.round(r.width) };
  };
  return {
    layout: document.documentElement.getAttribute("data-layout"),
    staff: document.documentElement.getAttribute("data-staff"),
    sidebar: box("#desktopSidebar"),
    app: box("#app"),
    context: box("#contextCol"),
    contextChildren: document.getElementById("contextCol").children.length,
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    groups: [...document.querySelectorAll("#desktopSidebar .nav-group-head")].map((e) => e.textContent.trim()),
  };
});

async function openApp(page) {
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);
}

// A REAL COACH SESSION, not an overridden predicate.
//
// The first draft of this scenario set window.communityIsStaff = () => true
// and got the attribute but an empty screen, which was the harness lying:
// that export is what the LAYOUT gate reads, while the centre column's own
// content asks cloud.js's internal isStaff() - state.profile plus the
// redemption row. Seeding the session exercises both, and the failure it
// produced was a fair one.
const COACH = "c0ffee00-0000-4000-8000-000000000001";
const VERIFIED = new Date().toISOString();
const staffSeed = {
  profiles: [{
    id: COACH, handle: "coach_x", display_name: "מאמן", is_admin: false,
    recovery_verified_at: VERIFIED, visible_to_club: true, created_at: VERIFIED,
  }],
  invite_redemptions: [{ user_id: COACH, invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  announcements: [], workout_posts: [], community_streaks: [],
  notifications: [], notification_preferences: [], analytics_events: [],
};
const staffUser = { id: COACH, is_anonymous: false, email: "coach@members.haimuniya.invalid" };

// --- A MEMBER at 1440px: nothing may have changed ------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page);
  await openApp(page);
  const g = await geometry(page);

  check("a member at a real desktop carries data-layout", g.layout === "desktop", `layout=${g.layout}`);
  check("...and never data-staff - the attribute the whole shell hangs off",
    g.staff === null, `staff=${g.staff}`);
  // The numbers the pre-existing desktop-layout.mjs has measured since the
  // ≥900 tier shipped. If this feature moved a member's furniture, it moved
  // one of these.
  check("the member sidebar is still 248px at x=892", g.sidebar && g.sidebar.w === 248 && g.sidebar.x === 892,
    JSON.stringify(g.sidebar));
  check("the member logging column is still 560px at x=300", g.app && g.app.w === 560 && g.app.x === 300,
    JSON.stringify(g.app));
  check("the member context column is still absent, not an empty box",
    g.context === null && g.contextChildren === 0, `box=${JSON.stringify(g.context)} children=${g.contextChildren}`);
  check("the member sidebar is one ungrouped list", g.groups.length === 0, g.groups.join(", "));
  check("no horizontal scroll", g.scrollWidth <= g.viewport, `scrollWidth=${g.scrollWidth}`);
  check("no console errors on the member desktop", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- STAFF at 1440px: three columns, rail on the right -------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, staffSeed, { user: staffUser });
  await openApp(page);
  await page.waitForFunction(() => document.documentElement.getAttribute("data-staff") === "1");
  await page.click('#desktopSidebar .navrow[data-tab="staffhome"]');
  await page.waitForSelector("#content .staff-home");
  const g = await geometry(page);

  check("staff carry both attributes", g.layout === "desktop" && g.staff === "1",
    `layout=${g.layout} staff=${g.staff}`);
  check("the sidebar groups are צוות / קהילה / האימון שלי",
    g.groups.join("|") === "צוות|קהילה|האימון שלי", g.groups.join(" | "));

  // RTL: the rail is the RIGHTMOST column, the context rail the leftmost,
  // and the centre column sits between them. Checked as an ordering rather
  // than as three magic numbers, so a width tweak does not fail this.
  const rightEdge = (b) => b.x + b.w;
  check("three columns are on screen at once",
    !!(g.sidebar && g.app && g.context),
    `sidebar=${JSON.stringify(g.sidebar)} app=${JSON.stringify(g.app)} context=${JSON.stringify(g.context)}`);
  if (g.sidebar && g.app && g.context) {
    check("the navigation rail is the rightmost column (RTL)",
      rightEdge(g.sidebar) > rightEdge(g.app) && rightEdge(g.app) > rightEdge(g.context),
      `sidebar→${rightEdge(g.sidebar)} app→${rightEdge(g.app)} context→${rightEdge(g.context)}`);
    check("the centre column is the widest of the three",
      g.app.w > g.sidebar.w && g.app.w > g.context.w,
      `app=${g.app.w} sidebar=${g.sidebar.w} context=${g.context.w}`);
    check("the context rail is between 300 and 360px",
      g.context.w >= 300 && g.context.w <= 360, `w=${g.context.w}`);
    check("the three columns reclaim most of the viewport",
      (g.sidebar.w + g.app.w + g.context.w) >= g.viewport * 0.8,
      `live=${g.sidebar.w + g.app.w + g.context.w}px of ${g.viewport}`);
  }
  check("the context rail has real content, never an empty card",
    g.contextChildren > 0, `children=${g.contextChildren}`);
  check("no horizontal scroll on the staff shell", g.scrollWidth <= g.viewport, `scrollWidth=${g.scrollWidth}`);

  // The centre column's three parts, by the markup they actually render.
  const centre = await page.evaluate(() => ({
    week: document.querySelectorAll("#content .staff-week-day").length,
    directory: !!document.querySelector("#content #communityDirectorySearch"),
    announcements: [...document.querySelectorAll("#content .ach-section")]
      .some((s) => s.textContent.includes("הודעות מהמועדון")),
  }));
  check("the week strip renders seven days", centre.week === 7, `days=${centre.week}`);
  check("the member roster is in the centre column", centre.directory);
  check("the announcements archive is in the centre column", centre.announcements);
  check("no console errors on the staff shell", errors.length === 0, errors.join(" | "));

  // The logging tab is NOT the staff home, and must keep its own width.
  await page.click('#desktopSidebar .navrow[data-tab="add"]');
  await page.waitForFunction(() => !document.querySelector("#content .staff-home"));
  const logging = await geometry(page);
  check("a coach on the logging tab still gets the 560px logging column",
    logging.app && logging.app.w === 560, JSON.stringify(logging.app));
  await page.close();
}

// --- The rail folds away before it can squeeze the centre ----------------
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await installMockCloud(page, staffSeed, { user: staffUser });
  await openApp(page);
  await page.waitForFunction(() => document.documentElement.getAttribute("data-staff") === "1");
  await page.click('#desktopSidebar .navrow[data-tab="staffhome"]');
  await page.waitForSelector("#content .staff-home");
  const g = await geometry(page);
  check("below 1180 the context rail is hidden rather than squeezed",
    g.context === null, JSON.stringify(g.context));
  check("and the shell still does not scroll sideways", g.scrollWidth <= g.viewport,
    `scrollWidth=${g.scrollWidth}`);
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\ndesktop-staff-shell: FAILURES ABOVE" : "\ndesktop-staff-shell: all checks passed");
process.exit(failed ? 1 : 0);
