#!/usr/bin/env node
// Which desktop surfaces are allowed to be wider than the 560px logging column.
//
// index.html's WIDE DESKTOP block encodes five decisions, and the first is
// that the logging column never changes width at any breakpoint. The
// exceptions are surfaces that are TABLES rather than forms: ניהול has been
// widened to 940px since that block was written, and חברים (the member
// directory) joined it on 2026-09-17 - it renders the identical
// log-list/log-row shape the member roster does.
//
// This is a real browser rather than a grep because the rules turn on
// `:has()` and on `[aria-selected="true"]`, and a selector that matches
// NOTHING looks exactly like a deliberate design choice from the source. The
// failure being guarded is silent in both directions: a typo that stops the
// directory widening, and a change that starts widening the feed.
//
// It renders the layout shell directly instead of booting the app: nothing
// here needs a session, a tab click, or a backend, and a check that cannot
// touch the network cannot touch production.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
// EVERY style block. Taking the first `<style>`…`</style>` only is how a
// measurement earlier the same day reported that a row which visibly wraps
// fits comfortably - the second block holds the tokens.
const blocks = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]);
check("index.html's style blocks were all collected", blocks.length >= 2, `${blocks.length} found`);
const css = blocks.join("\n");

const communityShell = (activeTabId) => `
<div class="app-shell">
  <aside class="desktop-sidebar"></aside>
  <div id="app"><div id="content">
    <div class="subtabbar" role="tablist" aria-label="ניווט בקהילה">
      ${["feed", "boards", "directory", "account"].map((id) =>
        `<button class="subtabbtn" id="commTab-${id}" role="tab" aria-selected="${id === activeTabId}">${id}</button>`).join("")}
    </div>
  </div></div>
  <aside class="context-col" id="contextCol"></aside>
</div>`;

const manageShell = `
<div class="app-shell">
  <aside class="desktop-sidebar"></aside>
  <div id="app"><div id="content">
    <div class="subtabbar" role="tablist" aria-label="ניווט בניהול">
      <button class="subtabbtn" id="manageTab-moderation" role="tab" aria-selected="true">moderation</button>
    </div>
  </div></div>
  <aside class="context-col" id="contextCol"></aside>
</div>`;

const EXPECTED = [
  ["directory", 940, "a list of people is the same task at 940px, with fewer wraps"],
  ["manage", 940, "roster, moderation queue and analytics are genuinely tabular"],
  ["feed", 560, "a reading column - 940px of body text is worse, not more"],
  ["account", 560, "forms: a 940px row puts the label and its control at opposite ends"],
  ["boards", 560, "mixed - leaderboards are tables, challenges are cards; needs splitting first"],
];

const browser = await chromium.launch();
for (const width of [1280, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  for (const [name, expected, why] of EXPECTED) {
    const markup = name === "manage" ? manageShell : communityShell(name);
    await page.setContent(`<!doctype html><html dir="rtl" lang="he"><head>${css}</head><body>${markup}</body></html>`);
    const actual = await page.$eval("#app", (e) => Math.round(e.getBoundingClientRect().width));
    check(`${width}px · ${name} column is ${expected}px`, actual === expected, actual === expected ? why : `measured ${actual}px`);
  }
  await page.close();
}

// Below the breakpoint NOTHING widens: the whole wide-desktop block lives
// inside a media query so the phone layout cannot see any of it.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html dir="rtl" lang="he"><head>${css}</head><body>${communityShell("directory")}</body></html>`);
  const actual = await page.$eval("#app", (e) => Math.round(e.getBoundingClientRect().width));
  check("390px · the directory is still a phone column", actual <= 390, `${actual}px`);
  await page.close();
}

await browser.close();
console.log(failed ? "\ndesktop-column-widths: FAILED" : "\ndesktop-column-widths: all good");
process.exit(failed ? 1 : 0);
