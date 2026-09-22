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
// THE GEOMETRY IS MEASURED FOR ALL SEVEN, still, and that is deliberate:
// three of them have shipped since (strength_percentages, and since
// 202609220002 coach_tasks and onboarding_challenge) and a shipped row is
// exactly as capable of pushing its checkbox off the left edge as a planned
// one. What changes with shipping is only the MARKER text, which is asserted
// per row further down rather than over the whole list.
const SEEDED = ["onboarding_challenge", "benchmarks", "strength_percentages", "gym_display", "coach_tasks", "owner_report", "arbox_attendance"];
// Still carrying בפיתוח. The other three ship a feature and must not.
const STILL_PLANNED = ["benchmarks", "gym_display", "owner_report", "arbox_attendance"];
// 202609220002. Two rows that now also render a collapsed threshold
// disclosure BELOW the label - a second block in the same row whose fields
// must not overflow either.
const WITH_SETTINGS = ["coach_tasks", "onboarding_challenge"];

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
const markerText = await page.evaluate(() => {
  const label = document.querySelector('[data-club-feature="benchmarks"]').closest("label");
  return label.textContent.replace(/\s+/g, " ").trim();
});
check("a planned row states in visible text that it is not built yet", /בפיתוח/.test(markerText), markerText.slice(0, 80));
check("and that it is not server-enforced", /בתצוגה בלבד/.test(markerText), markerText.slice(0, 80));

// 202609220002. The two rows that stopped being planned must stop saying so,
// on the real screen and not only in a source test - this is the same
// handover the migration's own comment describes, checked where an admin
// would actually read it.
const shippedMarkers = await page.evaluate((keys) => Object.fromEntries(keys.map((k) => [
  k, document.querySelector(`[data-club-feature="${k}"]`).closest("label").textContent.replace(/\s+/g, " ").trim(),
])), WITH_SETTINGS);
for (const key of WITH_SETTINGS) {
  check(`${key}: the row no longer says בפיתוח`, !/בפיתוח/.test(shippedMarkers[key]), shippedMarkers[key].slice(0, 80));
  check(`${key}: and claims the server enforcement it now has`, /נאכף בשרת/.test(shippedMarkers[key]), shippedMarkers[key].slice(0, 80));
}
for (const key of STILL_PLANNED) {
  const text = await page.evaluate((k) => document.querySelector(`[data-club-feature="${k}"]`).closest("label").textContent.replace(/\s+/g, " ").trim(), key);
  check(`${key}: still says בפיתוח, because nothing has been built behind it`, /בפיתוח/.test(text), text.slice(0, 80));
}

// The threshold fields: opened, measured, and still inside the row. A number
// input is wider than a chip and this is the width where that matters.
await page.evaluate((keys) => { for (const k of keys) document.getElementById(`clubModuleSettings-${k}`).open = true; }, WITH_SETTINGS);
const settings = await page.evaluate((keys) => {
  const vw = document.documentElement.clientWidth;
  return {
    vw, docScrollW: document.documentElement.scrollWidth,
    rows: keys.map((k) => {
      const d = document.getElementById(`clubModuleSettings-${k}`);
      const inputs = [...d.querySelectorAll("input[type=number]")].map((i) => {
        const r = i.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const box = document.querySelector(`[data-club-feature="${k}"]`).getBoundingClientRect();
      return { key: k, inputs, boxLeft: Math.round(box.left), boxRight: Math.round(box.right) };
    }),
  };
}, WITH_SETTINGS);
for (const r of settings.rows) {
  check(`${r.key}: the threshold fields are on screen`, r.inputs.length > 0, `${r.inputs.length} fields`);
  check(`${r.key}: every threshold field is fully inside the viewport`,
    r.inputs.every((i) => i.left >= 0 && i.right <= settings.vw),
    r.inputs.map((i) => `${i.left}..${i.right}`).join(" "));
  check(`${r.key}: and each is big enough to tap`,
    r.inputs.every((i) => i.w >= 44 && i.h >= 28),
    r.inputs.map((i) => `${i.w}×${i.h}`).join(" "));
  // The switch itself must not have been pushed anywhere by the block that
  // opened underneath it - the disclosure is a SIBLING of the label, not a
  // child, precisely so it cannot.
  check(`${r.key}: the switch is still inside the viewport with the fields open`,
    r.boxLeft >= 0 && r.boxRight <= settings.vw, `x=${r.boxLeft}..${r.boxRight}`);
}
check("no horizontal overflow with every threshold field open",
  settings.docScrollW <= settings.vw + 1, `scrollWidth=${settings.docScrollW}, clientWidth=${settings.vw}`);

const liveMarkerText = await page.evaluate(() => {
  const label = document.querySelector('[data-club-feature="events"]').closest("label");
  return label.textContent.replace(/\s+/g, " ").trim();
});
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
