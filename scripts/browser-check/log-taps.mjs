#!/usr/bin/env node
// Taps to log one set. The biggest complaint users of other training apps
// report is friction logging a set, so this counts it: real taps (trusted
// click events) from a cold open of the app to a saved set, for a lift the
// member has logged before.
//
//   A  "the same as last time": open Log, save.
//   B  "a different lift I did this week": open Log, pick it, save.
//
// The script takes the shortest path the screen offers: after opening Log it
// looks at what is on screen and only taps what it has to. Typing into the
// picker's search box is counted separately (it is a keyboard interaction, not
// a tap), so a design that needs search cannot hide it.
//
// Baseline (HEAD before the Design session): A = 5 taps + 1 search, B = 5 taps + 1 search.
// After: see the numbers this prints; test/log-taps-budget.test.mjs-style
// budgets are asserted at the bottom (A <= 2, B <= 3).
import { chromium } from "playwright";
import { resolveTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, selectMovement, consoleErrorCollector, dismissFirstLogArrival, dismissCelebrationIfOpen } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveTarget();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const errors = await consoleErrorCollector(page);
await installMockCloud(page, {});
await page.goto(target.url);
await dismissWelcomeModal(page);

// ---- Seed: history for two lifts, through the UI, not counted ----------------
async function setField(field, value) {
  await page.fill(`input.stepper-val[data-field='${field}']`, String(value));
  await page.dispatchEvent(`input.stepper-val[data-field='${field}']`, "change");
}
async function logSet(query, weight, reps) {
  await page.click("#tabAddBtn");
  await selectMovement(page, query);
  await setField("weight", weight);
  await setField("reps", reps);
  await page.click("#bottomBarBtn");
  await page.waitForTimeout(150);
  await dismissFirstLogArrival(page, { timeout: 1500 }).catch(() => {});
  await dismissCelebrationIfOpen(page);
  await page.evaluate(() => { const m = document.querySelector("[data-action='close-moment']"); if (m) m.click(); });
}
for (let i = 0; i < 3; i++) await logSet("Strict Press", 40, 5);
for (let i = 0; i < 3; i++) await logSet("Back Squat", 80, 5);

// ---- Fresh open ------------------------------------------------------------
async function freshOpen() {
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#app", { state: "visible" });
  await page.evaluate(() => {
    window.__taps = 0;
    document.addEventListener("click", (e) => { if (e.isTrusted) window.__taps++; }, true);
    window.__typed = 0;
    document.addEventListener("input", (e) => { if (e.isTrusted) window.__typed++; }, true);
  });
}
const taps = () => page.evaluate(() => window.__taps);
const typed = () => page.evaluate(() => window.__typed);
const saveVisible = () => page.evaluate(() => { const b = document.getElementById("bottomBarBtn"); const bar = document.getElementById("bottomBar"); return !!b && bar && getComputedStyle(bar).display !== "none" && b.dataset.action === "save-set"; });

async function logLastSet(wantQuery) {
  await page.click("#tabAddBtn");
  await page.waitForTimeout(120);
  // Is the wanted lift already the selected one? Read the chosen name.
  const chosen = async () => page.evaluate(() => { const s = document.querySelector(".exercise-select span"); return s ? s.textContent : ""; });
  if (!(await saveVisible()) || !(await chosen()).includes(wantQuery)) {
    const chip = page.locator(`[data-action='pick-recent-lift']`, { hasText: wantQuery });
    if (await chip.count()) await chip.first().click();
    else {
      await page.click("[data-action='open-picker']");
      await page.fill("#pickerSearch", wantQuery);
      await page.waitForSelector(".modal-list .movement-btn[data-id]");
      await page.click(".modal-list .movement-btn[data-id] >> nth=0");
      await page.waitForFunction(() => !document.getElementById("pickerOverlay").classList.contains("open"));
      const prefill = page.locator("[data-action='prefill-last']");
      if (await prefill.count()) await prefill.first().click();
    }
  }
  await page.waitForTimeout(120);
  const before = await page.evaluate(() => (typeof entries !== "undefined" ? entries.length : -1));
  await page.click("#bottomBarBtn");
  await page.waitForFunction((n) => typeof entries !== "undefined" && entries.length === n + 1, before, { timeout: 4000 });
}

await freshOpen();
await logLastSet("Back Squat");
const A = { taps: await taps(), typed: await typed() };
console.log(`A  same lift as last time: ${A.taps} taps, ${A.typed} typed fields`);

await freshOpen();
await logLastSet("Strict Press");
const B = { taps: await taps(), typed: await typed() };
console.log(`B  a different lift:       ${B.taps} taps, ${B.typed} typed fields`);

const BASELINE = { A: 5, B: 5 };
check(`A: logging the same lift again took ${A.taps} taps (baseline ${BASELINE.A})`, A.taps < BASELINE.A);
check("A: no typing needed", A.typed === 0);
check(`B: logging a different recent lift took ${B.taps} taps (baseline ${BASELINE.B})`, B.taps < BASELINE.B);
check("B: no typing needed", B.typed === 0);
check("A is at most 2 taps", A.taps <= 2);
check("B is at most 3 taps", B.taps <= 3);
check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nlog-taps: FAILED" : "\nlog-taps: all checks passed");
process.exit(failed ? 1 : 0);
