// Audit L4 (2026-11), fix plan F14. A calendar day's set rows were two flex
// groups, so a long lift name wrapped unevenly and its summary ("3×5 @ 140")
// sat against it. Measures, at 390px, that the name and the summary keep a
// gap and that nothing scrolls sideways.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";
import { dismissWelcomeModal, switchTab } from "./lib/actions.mjs";

let failed = false;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`); if (!ok) failed = true; };

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)`);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await installMockCloud(page);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await dismissWelcomeModal(page);
  await page.evaluate(async () => {
    for (const [name, w] of [["Deadlift", 140], ["Romanian Deadlift With Pause At The Knee", 100], ["Back Squat", 120]]) {
      await window.addMovement(name, "Deadlift");
      window.applyFieldValue("step", "weight", w);
      window.applyFieldValue("step", "reps", 5);
      window.applyFieldValue("step", "sets", 3);
      await window.saveSet();
      if (typeof window.closeCelebration === "function") window.closeCelebration();
    }
  });
  await switchTab(page, "tabCalendarBtn");
  await page.click('[data-action="cal-select-day"][aria-current="date"]');
  await page.waitForSelector("#calDetail .cal-entry-row", { timeout: 5000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll("#calDetail .cal-entry-row")].map((row) => {
    const name = row.firstElementChild.getBoundingClientRect();
    const rest = row.lastElementChild.getBoundingClientRect();
    // RTL: the name is on the right, the summary and buttons on the left.
    return { text: row.firstElementChild.textContent.trim(), gap: Math.round(name.left - rest.right), sameTop: Math.abs(name.top - rest.top) < 40 };
  }));
  check("three set rows are shown", rows.length === 3, String(rows.length));
  for (const r of rows) check(`"${r.text.slice(0, 24)}": the name keeps a gap from its summary`, r.gap >= 8, `${r.gap}px`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no sideways scroll", overflow <= 1, `${overflow}px`);
} catch (e) {
  check("scenario ran", false, e && e.message);
} finally {
  await browser.close();
  await target.close();
}
process.exit(failed ? 1 : 0);
