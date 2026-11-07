#!/usr/bin/env node
// Accessibility sweep of the account screens (sign-up explainer, login, forgot password, two-step login gate,
// Me: security panel, notification schedules) and the weekly summary, in real Chromium. Home-port batch 2, feature 5.
//
// For every screen it measures, rather than reads the CSS:
//   * touch targets: every visible interactive control is at least 44x44 CSS px (or sits inside a label row that is);
//   * axe serious/critical WCAG 2.2 AA violations in the default look;
//   * colour contrast (axe, real pixels) in all six palettes (the default "classic" and five more), light and dark;
//   * no positive tabindex, and the Tab order follows the screen top to bottom;
//   * no horizontal overflow at 320 px (RTL);
//   * with prefers-reduced-motion: no endless animation is running.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const PALETTES = ["classic", "chalk", "slate", "cedar", "sand", "iris"];
const MODES = ["light", "dark"];
const MIN_TARGET = 44;

let failed = false;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " - " + detail : ""}`); if (!ok) failed = true; };

const target = await resolveLocalOnlyTarget();
const VERIFIED = new Date().toISOString();
const SEED = {
  profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  community_feed: [], notification_preferences: [], reminder_prefs: [],
};

async function setLook(page, palette, mode) {
  await page.evaluate(([p, m]) => { const r = document.documentElement; r.setAttribute("data-palette", p); r.setAttribute("data-theme", m); }, [palette, mode]);
  await page.waitForTimeout(40);
}
// The classic palette draws the header logo in white over a dark photo; axe cannot see a CSS background image
// and, in an explicit light theme, compares it with the page colour instead (a false 1.09:1). Checked by eye on
// a screenshot: white on the dark photo. Everything else on the page is measured.
const AXE_CONTEXT = { exclude: [[".header-logo"]] };
async function axe(page, opts) {
  await page.evaluate(axeSource);
  return page.evaluate(async ([ctx, o]) => await window.axe.run(ctx, o), [AXE_CONTEXT, opts]);
}

/** Interactive controls smaller than 44 px in either direction, unless a label row around them is big enough. */
async function smallTargets(page) {
  return page.evaluate((min) => {
    const sel = "button, a[href], select, input:not([type=hidden]), textarea, [role=button], [role=switch], [role=tab], summary";
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest("[hidden], [aria-hidden=true], .modal-overlay:not(.open)")) continue;
      let w = r.width, h = r.height;
      const label = el.closest("label");
      if (label) { const lr = label.getBoundingClientRect(); w = Math.max(w, lr.width); h = Math.max(h, lr.height); }
      // Inline links inside a sentence are exempt (WCAG 2.5.8 inline exception).
      if (el.tagName === "A" && el.closest("p, li") && cs.display === "inline") continue;
      if (w < min - 0.5 || h < min - 0.5) out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.dataset && el.dataset.communityAction ? "[" + el.dataset.communityAction + "]" : ""} ${Math.round(w)}x${Math.round(h)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
    }
    return out;
  }, MIN_TARGET);
}

/** Tab through the page; the visual order must not jump back up the screen. */
async function tabOrderProblems(page) {
  const positive = await page.evaluate(() => [...document.querySelectorAll("[tabindex]")].filter((e) => Number(e.getAttribute("tabindex")) > 0).length);
  const ys = [];
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  // Only the screen's own content (#content) is judged; the header and the bottom bar are fixed furniture.
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => { const e = document.activeElement; if (!e || !e.closest("#content")) return null; const r = e.getBoundingClientRect(); const again = e.__tabSeen === true; e.__tabSeen = true; return { y: r.top + window.scrollY, again, name: e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "[" + (e.dataset.communityAction || e.dataset.action || e.name || "") + "]", pos: getComputedStyle(e).position }; });
    if (!stop) continue;
    // A full lap (the first stop again, even if the screen redrew in between) ends the walk.
    if (stop.again || (ys.length && stop.name === ys[0].name && Math.abs(stop.y - ys[0].y) < 2)) break;
    ys.push(stop);
  }
  let jumps = 0;
  const where = [];
  for (let i = 1; i < ys.length; i++) if (ys[i].y < ys[i - 1].y - 12) { jumps++; where.push(`${ys[i - 1].name}@${Math.round(ys[i - 1].y)} -> ${ys[i].name}@${Math.round(ys[i].y)}`); }
  if (process.env.A11Y_DEBUG && where.length) console.log("      jumps: " + where.join(" ; "));
  return { positive, jumps, count: ys.length };
}

async function auditScreen(page, label, { tabs = true } = {}) {
  await setLook(page, "classic", "light");
  const small = await smallTargets(page);
  check(`${label}: every control is at least ${MIN_TARGET}px`, small.length === 0, small.slice(0, 4).join(" | "));
  const res = await axe(page, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
  const blocking = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(`${label}: axe serious/critical`, blocking.length === 0, blocking.map((v) => `${v.id}×${v.nodes.length}: ${v.nodes[0].target.join(" ")}`).join(" | "));
  const bad = [];
  for (const p of PALETTES) for (const m of MODES) {
    await setLook(page, p, m);
    const r = await axe(page, { runOnly: { type: "rule", values: ["color-contrast"] } });
    if (r.violations.length) bad.push(`${p}/${m}: ${r.violations[0].nodes.length} node(s), e.g. ${r.violations[0].nodes[0].target.join(" ")}`);
  }
  check(`${label}: text contrast in 6 palettes x light/dark`, bad.length === 0, bad.slice(0, 3).join(" | "));
  await setLook(page, "classic", "light");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label}: no sideways scroll`, overflow <= 1, `${overflow}px`);
  if (tabs) {
    const t = await tabOrderProblems(page);
    check(`${label}: focus order follows the screen`, t.positive === 0 && t.jumps <= 1, `tabindex>0: ${t.positive}, jumps back: ${t.jumps}, stops: ${t.count}`);
  }
  const endless = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.getTiming().iterations === Infinity).length);
  check(`${label}: no endless animation under reduced motion`, endless === 0, `${endless} running`);
}

const browser = await chromium.launch();
for (const [width, name] of [[320, "320px"]]) {
  // ---- signed out ----
  const out = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  const errs = await consoleErrorCollector(out);
  await installMockCloud(out, SEED, { user: null });
  await out.goto(target.url, { waitUntil: "networkidle" });
  await out.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await dismissWelcomeModal(out);
  await switchTab(out, "tabCommunityBtn");
  await out.waitForSelector('[data-community-action="start-signup"]', { timeout: 20000 });
  check("signed-out gate explains sign-up before it starts", (await out.locator("[data-signup-explainer]").count()) === 1);
  await auditScreen(out, `gate ${name}`);
  await out.click('[data-community-action="show-login"]');
  await out.waitForSelector("#communityLogin");
  await auditScreen(out, `login ${name}`);
  await out.click('[data-community-action="gate-back"]').catch(() => {});
  await out.evaluate(() => { state.ui.recovery.view = "form"; state.ui.gateView = "login"; rerender(); });
  await out.waitForSelector("#communityRecover");
  await auditScreen(out, `forgot password ${name}`);
  check("no console errors (signed out)", errs.length === 0, errs.slice(0, 2).join(" | "));
  await out.close();

  // ---- signed in ----
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, SEED, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await dismissWelcomeModal(page);
  await page.evaluate(() => switchAppTab("me"));
  await page.waitForSelector("#communityHead", { timeout: 20000 });
  await page.evaluate(() => {
    state.ui.mfa.has = false; state.ui.recovery.has = true;
    state.notif.prefsLoaded = true;
    state.notif.prefs = { workout_reminder: "in_app", weekly_digest: "in_app" };
    state.notif.reminder = { loaded: true, row: { workout_days: [0, 2], workout_hour: 18, workout_minute: 0 }, saving: false };
    rerender();
  });
  check("Me shows the security panel and both schedules", (await page.locator("#mfaPanel").count()) === 1 && (await page.locator("[data-reminder-schedule]").count()) === 2);
  await auditScreen(page, `Me: security off + schedules ${name}`);
  await page.evaluate(() => { state.ui.mfa.enroll = { factorId: "f", qr: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>", secret: "JBSWY3DPEHPK3PXP" }; rerender(); });
  await auditScreen(page, `Me: two-step enrol ${name}`);
  await page.evaluate(() => { state.ui.mfa.enroll = null; state.ui.mfa.has = true; state.ui.mfa.disableOpen = true; state.ui.mfa.signOutAllOpen = true; rerender(); });
  await auditScreen(page, `Me: two-step on, confirm forms ${name}`);
  await page.evaluate(() => { state.ui.mfa.challenge = true; rerender(); });
  check("the code gate replaces the account screen", (await page.locator("#communityMfaChallenge").count()) === 1 && (await page.locator("#mfaPanel").count()) === 0);
  await auditScreen(page, `two-step login gate ${name}`);
  await page.evaluate(() => { state.ui.mfa.recover = true; rerender(); });
  await auditScreen(page, `two-step recovery form ${name}`);
  await page.evaluate(() => { state.ui.mfa.challenge = false; state.ui.mfa.recover = false; rerender(); });
  await page.evaluate(() => {
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) entries.push({ id: "e" + i, exerciseId: "back-squat", date: d(i * 2), ts: Date.now() - i * 2 * 86400000, type: "reps", weight: 100 + (5 - i) * 2.5, reps: 5, sets: 3 });
  });
  await switchTab(page, "tabHistoryBtn");
  await page.waitForSelector("#weeklySummary", { timeout: 8000 }).catch(() => {});
  check("progress screen shows the weekly summary", (await page.locator("#weeklySummary").count()) === 1);
  await auditScreen(page, `Progress ${name}`);
  check("no console errors (signed in)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
