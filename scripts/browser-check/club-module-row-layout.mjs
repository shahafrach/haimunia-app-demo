#!/usr/bin/env node
// 202609190002 / COMM-379. The club-module toggle row grew a second and a
// third line, and jsdom has no opinion about any of it.
//
// The row used to be one flex line: a short Hebrew label, and a checkbox
// pushed to the far edge by justify-content:space-between. It now carries,
// on the left of that same edge-pushed checkbox, a label PLUS up to two
// marker chips PLUS - for the seven not-yet-built modules - a full sentence
// of Hebrew description. That is three things this suite exists to measure
// and `npm test` cannot:
//
//   * the checkbox is still on screen and still tappable. A flex item with
//     no min-width:0 beside a long unbreakable run does not wrap - it pushes
//     its sibling out of the container, and in RTL it pushes it off the
//     LEFT edge, where a phone shows nothing at all and reports no error.
//   * the description wraps under the label rather than squeezing it.
//   * nothing overflows the document horizontally. The panel is inside a
//     <details> inside the manage column, and a single overflowing row
//     gives the whole app a horizontal scrollbar.
//
// EVERY ASSERTION IS PAIRED WITH A CONTROL, the same discipline
// desktop-invite-form-width.mjs uses: the layout is held by two rules
// (flex-direction:column on the text side, min-width:0 so it may shrink),
// so this script removes them live and re-measures, proving the same page
// and the same element WOULD fail without them.
//
// 390px, not desktop: this is the width the club actually reads the admin
// panel at, and it is the width where a three-part row has no room.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal, switchTab, submitManagementGate } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

// All seven of 202609190002's keys. Two live modules ('events', RLS-gated,
// and 'directory', a client-side hide) are read further down as the
// within-list control for the markers, but they need no fixture row: a key
// with no club_features row defaults to enabled, which is what they are.
//
// SEEDED, not PLANNED, and the rename is the point. Every row here gets the
// same geometry checks whether or not its feature has shipped - a switch
// pushed off a 390px screen is a bug either way - but two of the seven are
// BUILT now (strength_percentages 2026-09-21, benchmarks 2026-09-22) and the
// marker checks below are the half that has to tell them apart. Calling the
// whole list PLANNED is how this file came to read a בפיתוח marker off a row
// that had, correctly, just stopped carrying one.
const SEEDED = ["onboarding_challenge", "benchmarks", "strength_percentages", "gym_display", "coach_tasks", "owner_report", "arbox_attendance"];
// The two halves of 202609190002's handover, same split as
// test/planned-module-switches.test.mjs keeps - a key moves from one to the
// other in the commit that adds its gate, and both lists are asserted, so the
// row and the code cannot disagree in either direction.
const STILL_PLANNED = "onboarding_challenge";
const ALREADY_BUILT = "benchmarks";

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = await consoleErrorCollector(page);

const VERIFIED = new Date().toISOString();
await installMockCloud(page, {
  profiles: [{ id: "admin-1", handle: "roi", display_name: "רועי", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "admin-1", invite_id: "i1", role: "admin", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  // Exactly as 202609190002 leaves them: a row each, all off.
  club_features: SEEDED.map((module_key) => ({ club_id: "club-1", module_key, enabled: false, config: {} })),
  workout_posts: [], feed_page_rows: [], post_comments: [], reports: [], admin_actions: [],
  pins: [], posting_restrictions: [], follows: [], hidden_posts: [], notifications: [],
  notification_preferences: [],
}, { user: { id: "admin-1", is_anonymous: false, email: "admin@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible" });
await dismissWelcomeModal(page);

// The SYSTEM admin panel (tabManageBtn), which is where the module switches
// live - not the club panel. Management is a separate identity, so a login
// stands in front of it even for an account already signed in as an admin.
await switchTab(page, "tabManageBtn");
await page.evaluate(() => window.__mock.seedCredentials("admin-1", "roi@members.haimuniya.invalid", "Aa123456789!"));
await submitManagementGate(page, "roi@members.haimuniya.invalid", "Aa123456789!");
await page.waitForSelector("#content .subtabbar[aria-label='ניווט בניהול']", { timeout: 10000 });
await page.click(".subtabbtn[data-community-action='set-manage-tab'][data-tab='moderation']");
// The switches sit inside a collapsed <details> area; open it the way an
// admin would before anything here can be measured.
await page.waitForSelector("#manageArea-settings summary", { timeout: 10000 });
await page.evaluate(() => { document.getElementById("manageArea-settings").open = true; });
await page.waitForSelector("[data-club-modules-panel] [data-club-feature]", { state: "visible", timeout: 10000 });

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------
async function measure() {
  return page.evaluate((keys) => {
    const vw = document.documentElement.clientWidth;
    const rows = keys.map((key) => {
      const box = document.querySelector(`[data-club-feature="${key}"]`);
      if (!box) return { key, missing: true };
      const label = box.closest("label");
      const b = box.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      const descEl = document.getElementById(`clubModuleDesc-${key}`);
      const d = descEl ? descEl.getBoundingClientRect() : null;
      // The label text line is the first child span of the text column.
      const textCol = label.firstElementChild;
      const titleEl = textCol ? textCol.firstElementChild : null;
      const t = titleEl ? titleEl.getBoundingClientRect() : null;
      return {
        key,
        boxLeft: Math.round(b.left), boxRight: Math.round(b.right),
        boxW: Math.round(b.width), boxH: Math.round(b.height),
        rowRight: Math.round(l.right), rowLeft: Math.round(l.left),
        descTop: d ? Math.round(d.top) : null,
        descLeft: d ? Math.round(d.left) : null,
        descRight: d ? Math.round(d.right) : null,
        titleBottom: t ? Math.round(t.bottom) : null,
        chips: titleEl ? titleEl.querySelectorAll("span").length : 0,
        titleText: titleEl ? titleEl.textContent.trim() : "",
      };
    });
    return { vw, docScrollW: document.documentElement.scrollWidth, rows };
  }, SEEDED);
}

const m = await measure();
console.log(`viewport ${m.vw}px, document scrollWidth ${m.docScrollW}px`);

check("every seeded module has a switch on screen", m.rows.every((r) => !r.missing),
  m.rows.filter((r) => r.missing).map((r) => r.key).join(", ") || "all seven present");

for (const r of m.rows) {
  if (r.missing) continue;
  // THE FAILURE THIS SCRIPT EXISTS FOR. In RTL the checkbox is the LEFT-most
  // item, so an over-wide text column pushes it to a negative x - off the
  // screen, silently, with the row still looking plausible.
  check(`${r.key}: the switch is fully inside the viewport`,
    r.boxLeft >= 0 && r.boxRight <= m.vw, `x=${r.boxLeft}..${r.boxRight} of ${m.vw}`);
  check(`${r.key}: the switch is not squashed to nothing by the text beside it`,
    r.boxW >= 12 && r.boxH >= 12, `${r.boxW}×${r.boxH}px`);
  // The description is a second LINE, not a second column: it starts below
  // the label rather than beside it.
  check(`${r.key}: the description sits under the label, not alongside it`,
    r.descTop !== null && r.titleBottom !== null && r.descTop >= r.titleBottom - 1,
    `desc top=${r.descTop}, label bottom=${r.titleBottom}`);
  check(`${r.key}: the description stays inside the row`,
    r.descLeft >= r.rowLeft - 1 && r.descRight <= r.rowRight + 1,
    `desc ${r.descLeft}..${r.descRight} in row ${r.rowLeft}..${r.rowRight}`);
}

check("no horizontal overflow on the document", m.docScrollW <= m.vw + 1,
  `scrollWidth=${m.docScrollW}, clientWidth=${m.vw}`);

// Both markers render, and they are real text rather than a title attribute
// - the whole reason they exist rather than a tooltip.
const readMarker = (key) => page.evaluate((k) => {
  const label = document.querySelector(`[data-club-feature="${k}"]`).closest("label");
  return label.textContent.replace(/\s+/g, " ").trim();
}, key);

const markerText = await readMarker(STILL_PLANNED);
check("a planned row states in visible text that it is not built yet", /בפיתוח/.test(markerText), markerText.slice(0, 80));
check("and that it is not server-enforced", /בתצוגה בלבד/.test(markerText), markerText.slice(0, 80));

// The other half of the handover, and the assertion this file was missing:
// a key whose feature has shipped must have LOST בפיתוח while keeping
// בתצוגה בלבד. Without it, reading the marker off a built row was the same
// check as reading it off a planned one, which is exactly how this scenario
// failed the day benchmarks shipped - the row was right and the script was
// pointing at it.
const builtMarkerText = await readMarker(ALREADY_BUILT);
check("a row whose feature has shipped no longer says it is in development",
  !/בפיתוח/.test(builtMarkerText), builtMarkerText.slice(0, 80));
check("but still says it is a display-only hide, because that has not changed",
  /בתצוגה בלבד/.test(builtMarkerText) && !/נאכף בשרת/.test(builtMarkerText), builtMarkerText.slice(0, 80));

const liveMarkerText = await readMarker("events");
check("a live, RLS-gated row says so instead", /נאכף בשרת/.test(liveMarkerText) && !/בפיתוח/.test(liveMarkerText), liveMarkerText.slice(0, 80));

// The switch still works after all of this - a row that renders beautifully
// and cannot be tapped is not an improvement.
await page.click('[data-club-feature="gym_display"]');
const flipped = await page.evaluate(() => document.querySelector('[data-club-feature="gym_display"]').checked);
check("the switch is still operable by tap at 390px", flipped === true, `checked=${flipped}`);

// ---------------------------------------------------------------------------
// Control: take the two rules away and watch the same row break
// ---------------------------------------------------------------------------
// If this control passes trivially, the assertions above prove nothing about
// the layout - they would hold on any markup. It must genuinely fail.
await page.addStyleTag({ content: `
  [data-club-modules-panel] label.log-row > span:first-child {
    flex-direction: row !important;
    min-width: auto !important;
    white-space: nowrap !important;
  }
` });
const broken = await measure();
const anyOffScreen = broken.rows.some((r) => !r.missing && (r.boxLeft < 0 || r.boxRight > broken.vw));
check("control: without the column/min-width rules the switch IS pushed off screen or the page overflows",
  anyOffScreen || broken.docScrollW > broken.vw + 1,
  `offScreen=${anyOffScreen}, scrollWidth=${broken.docScrollW} vs ${broken.vw}`);

const consoleErrors = errors;
check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
