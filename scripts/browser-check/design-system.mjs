#!/usr/bin/env node
// The design system in a real Chromium, at 390px, in RTL.
//
// jsdom has no layout and resolves no custom property, so this is where the
// things a member actually sees are measured:
//   1. each tab (Home, Circle, Log, Progress, Me) in one light palette and one
//      dark one: right-to-left, no sideways scroll, page colors resolved from the
//      tokens, four tabs with a raised Log button;
//   2. the palette switch in Settings: attribute, repaint, persistence;
//   3. transparency off by default (no blur), on adds the blur, off removes it;
//   4. reduced motion: the moment's animations and the ring's transition are off;
//   5. the post-workout flow: a PR opens the moment with the PR first, then the
//      comparison with last time, then the weekly ring, then one share action.
// Backend is the in-page mock (lib/mockCloud.mjs); nothing can reach a real project.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal, dismissFirstLogArrival, selectMovement, openSettings } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VIEWPORT = { width: 390, height: 844 };
const ME = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERIFIED = new Date().toISOString();
const club = { id: A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME };
const seed = () => ({
  profiles: [{ id: ME, handle: "member_me", display_name: "אני", emoji: "💪", recovery_verified_at: VERIFIED }],
  circle_members: [{ club_id: A, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: club }],
  member_targets: [{ user_id: ME, weekly_target: 3, paused_until: null }], post_training_partners: [], workout_posts: [], benchmark_results: [], blocks: [], reactions: [],
  notifications: [], notification_preferences: [], analytics_events: [],
});
function rpcs() {
  const m = window.__mock;
  const ok = (data) => () => ({ data: data === undefined ? null : data, error: null });
  m.onRpc("circle_feed", () => ({ data: [], error: null }));
  m.onRpc("circle_week", () => ({ data: [], error: null }));
  for (const n of ["toggle_reaction", "mark_recovery_verified", "set_weekly_target", "set_pause", "set_share_defaults"]) m.onRpc(n, ok(true));
  m.onRpc("notif_unread_count", ok(0));
  m.onRpc("post_training_partners_for", ok([]));
}

const target = await resolveLocalOnlyTarget();
const browser = await chromium.launch();

async function open({ palette = "chalk", scheme = "light", reducedMotion = "no-preference", signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, reducedMotion, locale: "he-IL", serviceWorkers: "block" });
  await ctx.addInitScript((p) => { try { if (!localStorage.getItem("haimunia-demo:palette")) localStorage.setItem("haimunia-demo:palette", p); } catch (e) {} }, palette);
  const page = await ctx.newPage();
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, seed(), signedIn ? { user: { id: ME, is_anonymous: false } } : {});
  await page.addInitScript({ content: `(${rpcs.toString()})();` });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  return { ctx, page, errors };
}
const facts = (page) => page.evaluate(() => {
  const cs = getComputedStyle(document.body);
  const tabs = [...document.querySelectorAll("#bottomTabBar .tabbtn")];
  const bar = document.getElementById("bottomTabBar").getBoundingClientRect();
  const log = document.querySelector("#bottomTabBar .tabbtn--log .tab-log-disc");
  return {
    dir: getComputedStyle(document.documentElement).direction,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bg: cs.backgroundColor, fg: cs.color, font: cs.fontFamily.split(",")[0],
    tabs: tabs.map((t) => t.id),
    logRaised: log ? log.getBoundingClientRect().top < bar.top : false,
    small: tabs.filter((t) => t.getBoundingClientRect().height < 44).length,
    palette: document.documentElement.dataset.palette,
  };
});
const rgb = (s) => (/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s) || []).slice(1, 4).map(Number);
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// ---- 1. Every tab, one light and one dark palette ---------------------------------
for (const [palette, scheme] of [["chalk", "light"], ["slate", "dark"]]) {
  const { ctx, page, errors } = await open({ palette, scheme });
  for (const [label, id] of [["Home", "#tabHomeBtn"], ["Circle", "#tabCommunityBtn"], ["Log", "#tabAddBtn"], ["Progress", "#tabHistoryBtn"]]) {
    await page.click(id);
    await page.waitForTimeout(300);
    const f = await facts(page);
    const tag = `${palette}/${scheme} ${label}`;
    check(`${tag}: right-to-left, no sideways scroll`, f.dir === "rtl" && f.overflow <= 1, `dir=${f.dir} overflow=${f.overflow}`);
    check(`${tag}: page text reads at 4.5:1 or better on the page color`, ratio(rgb(f.fg), rgb(f.bg)) >= 4.5, `${f.fg} on ${f.bg}`);
    check(`${tag}: Heebo`, f.font.replace(/"/g, "") === "Heebo", f.font);
    check(`${tag}: four tabs in order, Log raised, all 44px`, f.tabs.join() === "tabHomeBtn,tabCommunityBtn,tabAddBtn,tabHistoryBtn" && f.logRaised && f.small === 0, JSON.stringify(f.tabs) + ` raised=${f.logRaised} small=${f.small}`);
  }
  await page.click("#tabHomeBtn");
  await page.waitForSelector('[data-community-action="c-open-me"]', { timeout: 8000 });
  await page.click('[data-community-action="c-open-me"]');
  await page.waitForSelector("#communityProfile", { timeout: 8000 });
  const me = await facts(page);
  check(`${palette}/${scheme} Me: no sideways scroll`, me.overflow <= 1, String(me.overflow));
  check(`${palette}/${scheme} Me: Appearance is on the page`, await page.locator('[data-appearance-root="me"] [data-action="set-palette"]').count() === 6);
  check(`${palette}/${scheme}: no console errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ---- 2. The palette switch ----------------------------------------------------------
{
  const { ctx, page } = await open({ palette: "chalk", scheme: "light" });
  const before = (await facts(page)).bg;
  await openSettings(page);
  await page.click('#settingsBody [data-action="set-palette"][data-palette="slate"]');
  await page.waitForTimeout(150);
  const after = await facts(page);
  check("palette switch: the attribute changes at once", after.palette === "slate");
  check("palette switch: the page color changes with it", after.bg !== before, `${before} -> ${after.bg}`);
  check("palette switch: the choice is marked in the picker", await page.getAttribute('#settingsBody [data-palette="slate"][data-action="set-palette"]', "aria-checked") === "true");
  const swatch = await page.evaluate(() => [...document.querySelectorAll("#settingsBody .palette-opt")].map((el) => getComputedStyle(el).backgroundColor));
  check("palette switch: each miniature paints its own palette", new Set(swatch).size === 6, swatch.join(" | "));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  check("palette switch: it survives a reload", (await facts(page)).palette === "slate");
  await ctx.close();
}

// ---- 3. Transparency --------------------------------------------------------------------
{
  const { ctx, page } = await open({ palette: "iris", scheme: "light" });
  const blur = () => page.evaluate(() => getComputedStyle(document.getElementById("bottomTabBar")).backdropFilter || getComputedStyle(document.getElementById("bottomTabBar")).webkitBackdropFilter);
  check("transparency: off by default, nothing is blurred", (await blur()) === "none", await blur());
  await openSettings(page);
  await page.click('#settingsBody [data-action="set-transparency"][data-pref="on"]');
  await page.waitForTimeout(150);
  check("transparency: on blurs the bars", /blur/.test(await blur()), await blur());
  check("transparency: on is stamped for the next load", await page.evaluate(() => localStorage.getItem("haimunia-demo:transparency")) === "on");
  await page.click('#settingsBody [data-action="set-transparency"][data-pref="off"]');
  await page.waitForTimeout(150);
  check("transparency: off removes the blur again", (await blur()) === "none");
  await ctx.close();
}

// ---- 4 and 5. The post-workout flow, with and without reduced motion -----------------------
async function logSets(page, query, kgs) {
  await page.click("#tabAddBtn");
  await selectMovement(page, query);
  await page.fill("input.stepper-val[data-field='reps']", "5");
  await page.dispatchEvent("input.stepper-val[data-field='reps']", "change");
  for (const kg of kgs) {
    await page.fill("input.stepper-val[data-field='weight']", String(kg));
    await page.dispatchEvent("input.stepper-val[data-field='weight']", "change");
    await page.click("#bottomBarBtn");
    await page.waitForTimeout(200);
    await dismissFirstLogArrival(page, { timeout: 1200 }).catch(() => {});
    if (await page.evaluate(() => document.getElementById("momentOverlay").classList.contains("open")) && kg !== kgs[kgs.length - 1]) await page.click("[data-action='close-moment']");
  }
}
for (const reduced of ["no-preference", "reduce"]) {
  const { ctx, page, errors } = await open({ palette: "cedar", scheme: "dark", reducedMotion: reduced, signedIn: false });
  await logSets(page, "Back Squat", [100, 100, 102.5, 105, 110]);
  await page.waitForSelector("#momentOverlay.open", { timeout: 5000 });
  const tag = `moment (${reduced === "reduce" ? "reduced motion" : "motion on"})`;
  const m = await page.evaluate(() => {
    const body = document.getElementById("momentBody");
    const order = [...body.children].map((c) => c.className.split(" ")[0] || c.tagName.toLowerCase());
    const pr = body.querySelector(".moment-pr");
    const fill = body.querySelector(".ring-fill");
    const overlay = document.getElementById("momentOverlay");
    return {
      order,
      headline: document.getElementById("momentTitle").textContent,
      badge: !!(pr && pr.querySelector(".pr-badge svg") && /שיא/.test(pr.querySelector(".pr-badge").textContent)),
      pct: pr ? /\+\d/.test(pr.textContent) : false,
      compare: !!body.querySelector(".moment-compare-row"),
      ringText: body.querySelector(".moment-week-title")?.textContent,
      fillTransition: fill ? getComputedStyle(fill).transitionDuration : "",
      prAnimation: pr ? getComputedStyle(pr).animationName : "",
      burst: overlay.classList.contains("burst"),
      actions: [...document.querySelectorAll("#momentActions button")].map((b) => b.dataset.action || b.textContent.trim()),
      overflow: document.getElementById("momentBody").scrollWidth - document.getElementById("momentBody").clientWidth,
    };
  });
  const idx = (c) => m.order.indexOf(c);
  check(`${tag}: headline names the lift`, /שיא חדש ב/.test(m.headline), m.headline);
  check(`${tag}: the PR comes first, then the comparison, then the week`, idx("moment-pr") >= 0 && idx("moment-pr") < idx("section") && idx("section") < idx("moment-week"), m.order.join(">"));
  check(`${tag}: the PR has a shape, a label and a percent`, m.badge && m.pct);
  check(`${tag}: today is compared with last time`, m.compare);
  check(`${tag}: the ring says what is done or left, not a deficit`, !!m.ringText && !/חסר|פיגור/.test(m.ringText), m.ringText);
  check(`${tag}: one share action and the way out`, m.actions.includes("close-moment") && m.actions.length <= 2, m.actions.join());
  check(`${tag}: no sideways scroll`, m.overflow <= 1);
  if (reduced === "reduce") {
    check(`${tag}: the ring's transition is off`, /^0(\.0+)?m?s/.test(m.fillTransition) || m.fillTransition === "0s", m.fillTransition);
    check(`${tag}: the PR card does not animate`, m.prAnimation === "none", m.prAnimation);
  } else {
    check(`${tag}: the PR card animates in`, m.prAnimation !== "none", m.prAnimation);
  }
  await page.click("[data-action='close-moment']");
  await page.waitForFunction(() => !document.getElementById("momentOverlay").classList.contains("open"));
  check(`${tag}: closing returns to the log`, await page.evaluate(() => document.getElementById("tabAddBtn").classList.contains("active")));
  check(`${tag}: no console errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
await target.close();
console.log(failed ? "\ndesign-system: FAILED" : "\ndesign-system: all checks passed");
process.exit(failed ? 1 : 0);
