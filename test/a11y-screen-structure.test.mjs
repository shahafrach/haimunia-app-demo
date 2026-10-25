// COMM-329, the rest of it. The ticket's own acceptance criteria are "one
// <h1> and a logically nested heading list per screen", "<header>/<nav>/
// <main> landmarks, exactly one <main>", and an automated scan that covers
// "every top-level tab AND every community screen (feed, profile,
// challenges, admin)" - the last of which its "Not done" section said no
// test reached, because getting there needs bootCommunity() with a mock
// Supabase project and an admin fixture.
//
// WHAT THIS FILE IS AND WHAT test/heading-outline.test.mjs ALREADY WAS.
// heading-outline.test.mjs is the 2026-09-04 partial: one property (the
// outline) on the four solo tabs plus Manage. This file is the whole
// structural contract on EVERY screen, community included - headings,
// landmarks, the tab/tabpanel pattern, and accessible names on controls
// that render as an icon alone. The two overlap on the outline deliberately:
// deleting either one should still leave a test that fails when the
// outline regresses.
//
// WHAT IT DOES NOT COVER. Rendered geometry and computed contrast - jsdom
// has no layout. Those are scripts/browser-check/a11y-axe-scan.mjs's, which
// runs axe-core against real Chromium and is already a hard gate in
// run-all.mjs. A focus ring's VISIBILITY is a Chromium question; that it is
// built from a theme token rather than a hardcoded colour is a source
// question, and that one is answered at the bottom of this file.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootApp, bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEBREW = /[֐-׿]/;

// ---------------------------------------------------------------------------
// The four assertions, each applied to every screen below.
// ---------------------------------------------------------------------------

/** Every heading rendered inside the screen, in document order. */
function outline(main) {
  return Array.from(main.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || "").replace(/\s+/g, " ").trim() }));
}

function assertHeadingOrder(main, screen) {
  const heads = outline(main);
  assert.ok(heads.length > 0, `${screen}: no heading at all inside <main>`);
  const pretty = heads.map((h) => `h${h.level}:${h.text.slice(0, 24)}`).join(" > ");

  const h1s = heads.filter((h) => h.level === 1);
  assert.equal(h1s.length, 1, `${screen}: expected exactly one <h1>, found ${h1s.length} (${pretty})`);
  assert.equal(heads[0].level, 1, `${screen}: the first heading must be the <h1>, not h${heads[0].level} (${pretty})`);

  // "Correct order" is the screen-reader definition: going deeper may only
  // ever go one level at a time. Coming back up may skip freely - h3 then h2
  // is a new section, not a broken one.
  let deepest = 0;
  for (const h of heads) {
    assert.ok(h.level <= deepest + 1,
      `${screen}: heading level jumps from h${deepest} straight to h${h.level} ("${h.text.slice(0, 40)}") — a section with no parent (${pretty})`);
    deepest = Math.max(deepest, h.level);
  }
  // A screen with sections must say so: an outline that is a lone <h1> gives
  // heading navigation nothing to navigate.
  assert.ok(heads.some((h) => h.level === 2), `${screen}: the <h1> is the only heading — no section headings (${pretty})`);
  for (const h of heads) {
    assert.ok(h.text.length > 0, `${screen}: an empty heading (h${h.level}) — invisible to a sighted member, a blank line to a reader`);
  }
}

/** The accessible name, to the extent jsdom can answer it without layout. */
function accessibleName(el) {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const parts = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)).filter(Boolean);
    if (parts.length) return parts.map((p) => (p.textContent || "").trim()).join(" ").trim();
  }
  const title = el.getAttribute("title");
  return title && title.trim() ? title.trim() : "";
}

/** Text a sighted member can read, ignoring anything hidden from a reader. */
function visibleText(el) {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent;
    else if (node.nodeType === 1 && node.getAttribute("aria-hidden") !== "true") out += visibleText(node);
  }
  return out.replace(/\s+/g, " ").trim();
}

function assertLandmarks(doc, screen) {
  const mains = doc.querySelectorAll('main, [role="main"]');
  assert.equal(mains.length, 1, `${screen}: expected exactly one <main> landmark, found ${mains.length}`);
  const mainName = accessibleName(mains[0]);
  assert.ok(HEBREW.test(mainName), `${screen}: <main> has no Hebrew accessible name (got "${mainName}")`);

  const navs = Array.from(doc.querySelectorAll('nav, [role="navigation"]'));
  assert.ok(navs.length > 0, `${screen}: no navigation landmark`);
  for (const nav of navs) {
    const name = accessibleName(nav);
    assert.ok(HEBREW.test(name),
      `${screen}: a <nav> with no Hebrew label (#${nav.id || nav.className}) — several navs with no names are indistinguishable in a landmark list`);
  }

  const banners = Array.from(doc.querySelectorAll('header, [role="banner"]')).filter((h) => !h.closest("main"));
  assert.ok(banners.length > 0, `${screen}: no banner landmark`);
  for (const banner of banners) {
    assert.ok(HEBREW.test(accessibleName(banner)), `${screen}: the banner landmark has no Hebrew label`);
  }

  // A region is a landmark ONLY when it is named, and an unnamed one is
  // dropped from the landmark list entirely - so an unnamed role="region" is
  // always a mistake, never a choice.
  for (const region of doc.querySelectorAll('[role="region"]')) {
    const name = accessibleName(region);
    assert.ok(HEBREW.test(name),
      `${screen}: role="region" on #${region.id || region.className} has no Hebrew name — an unnamed region is not a landmark`);
  }
}

function assertTabPattern(doc, screen) {
  const tablists = Array.from(doc.querySelectorAll('[role="tablist"]'));
  assert.ok(tablists.length > 0, `${screen}: no tab strip found at all`);
  for (const list of tablists) {
    const where = `${screen}: tablist #${list.id || list.className}`;
    assert.ok(HEBREW.test(accessibleName(list)), `${where} has no Hebrew accessible name`);

    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    assert.ok(tabs.length > 0, `${where} contains no role="tab" children`);

    let selected = 0;
    for (const tab of tabs) {
      const sel = tab.getAttribute("aria-selected");
      assert.ok(sel === "true" || sel === "false", `${where}: a tab with aria-selected="${sel}" — must be exactly "true" or "false"`);
      if (sel === "true") selected++;

      const controls = tab.getAttribute("aria-controls");
      assert.ok(controls, `${where}: tab "${visibleText(tab) || tab.id}" has no aria-controls — a reader is told "tab" with no way to reach the panel`);
      const panel = doc.getElementById(controls);
      assert.ok(panel, `${where}: tab "${visibleText(tab) || tab.id}" points aria-controls at #${controls}, which is not in the document`);
      assert.equal(panel.getAttribute("role"), "tabpanel", `${where}: #${controls} is controlled by a tab but is not role="tabpanel"`);

      const labelledBy = panel.getAttribute("aria-labelledby");
      assert.ok(labelledBy, `${where}: the panel #${controls} has no aria-labelledby — an unnamed panel announces no context`);
      assert.ok(doc.getElementById(labelledBy), `${where}: panel #${controls} is labelled by #${labelledBy}, which is not in the document`);
      assert.ok(HEBREW.test(accessibleName(panel)), `${where}: panel #${controls} resolves to a non-Hebrew name "${accessibleName(panel)}"`);
    }
    // At most one, not exactly one: the desktop sidebar renders its
    // destinations as three grouped strips, so two of the three legitimately
    // hold no selected tab while the third holds the active screen.
    assert.ok(selected <= 1, `${where}: ${selected} tabs are aria-selected="true" at once`);
  }
}

function assertEveryControlIsNamed(doc, screen) {
  const nameless = [];
  for (const el of doc.querySelectorAll('button, a[href], [role="button"], [role="tab"]')) {
    if (el.getAttribute("aria-hidden") === "true" || el.closest('[aria-hidden="true"]')) continue;
    if (visibleText(el)) continue;            // reads its own label off the screen
    if (accessibleName(el)) continue;         // icon-only, but named
    nameless.push(el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>").slice(0, 160));
  }
  assert.deepEqual(nameless, [],
    `${screen}: ${nameless.length} icon-only control(s) with no accessible name:\n  ${nameless.join("\n  ")}`);
}

function assertScreen(window, screen) {
  const doc = window.document;
  const main = doc.querySelector("main");
  assert.ok(main, `${screen}: no <main>`);
  assertHeadingOrder(main, screen);
  assertLandmarks(doc, screen);
  assertTabPattern(doc, screen);
  assertEveryControlIsNamed(doc, screen);
}

// ---------------------------------------------------------------------------
// The training log: the four screens app.js owns, reached without any cloud.
// ---------------------------------------------------------------------------

const SOLO_TABS = [
  ["רישום", "tabAddBtn"],
  ["התקדמות", "tabHistoryBtn"],
  ["לוח שנה", "tabCalendarBtn"],
  ["אימונים", "tabWodBtn"],
];

for (const [screen, btn] of SOLO_TABS) {
  test(`a11y structure — training log, ${screen}`, async () => {
    const window = await bootApp();
    window.document.getElementById(btn).click();
    assertScreen(window, screen);
  });
}

// The WOD screen is the one app.js screen with a tab strip INSIDE it, so its
// three sub-tabs are three screens, not one.
test("a11y structure — training log, the WOD sub-tabs each keep the structure", async () => {
  const window = await bootApp();
  window.document.getElementById("tabWodBtn").click();
  for (const sub of ["history", "benchmarks", "log"]) {
    window.document.querySelector(`.subtabbar [data-subtab="${sub}"]`).click();
    assertScreen(window, `אימונים / ${sub}`);
    const panel = window.document.getElementById("wodContent");
    assert.equal(panel.getAttribute("aria-labelledby"), `wodSubtab-${sub}`,
      `the WOD panel still names the sub-tab that was selected when the screen opened, not "${sub}"`);
  }
});

// ---------------------------------------------------------------------------
// The community layer: the one screen it has left, reached for real through
// bootCommunity() with a mock Supabase project. The feed, boards, directory
// and coach sub-tabs, the Manage screens and the challenge dialog were dropped
// with the gym features; what remains is the signed-in home (profile, privacy,
// achievements, notification preferences, sign out).
// ---------------------------------------------------------------------------

const VERIFIED = new Date().toISOString();

function communityMock() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

test("a11y structure — community, the signed-in home", async () => {
  const window = await bootCommunity(communityMock(), { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  assertScreen(window, "קהילה");
});

// ---------------------------------------------------------------------------
// Focus rings. Not a DOM question - jsdom has no layout and cannot tell a
// visible outline from a suppressed one - but "is it built from a token that
// both themes define" is answerable off the stylesheet, and that is the half
// that breaks silently when a new token is added to one theme block only.
// ---------------------------------------------------------------------------

test("focus rings are drawn from a theme token, in both themes", () => {
  const css = fs.readFileSync(path.join(root, "index.html"), "utf8");

  const rules = [...css.matchAll(/:focus(?:-visible|-within)?[^{]*\{([^}]*outline\s*:[^;}]*)/g)].map((m) => m[1]);
  assert.ok(rules.length >= 3, `expected the app-wide focus rules, found ${rules.length}`);
  const tokens = new Set();
  for (const rule of rules) {
    const outline = /outline\s*:\s*([^;}]*)/.exec(rule)[1].trim();
    if (/^none$/i.test(outline)) continue;
    const token = /var\((--[a-z-]+)\)/.exec(outline);
    assert.ok(token, `a focus ring drawn from a hardcoded colour instead of a token: "outline:${outline}"`);
    tokens.add(token[1]);
  }
  assert.ok(tokens.size > 0, "no focus ring found at all");

  // The CLAUDE.md theme rule, applied to exactly the tokens the focus ring
  // depends on: a token defined for light and for only ONE of the two dark
  // blocks draws the focus ring in the wrong colour - possibly the
  // background's own - for whichever dark path was missed.
  const light = /:root\s*\{([\s\S]*?)\}/.exec(css);
  const osDark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/.exec(css);
  const pickedDark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(light && osDark && pickedDark, "the three theme blocks CLAUDE.md describes are not all present");
  for (const token of tokens) {
    for (const [name, block] of [["light :root", light[1]], ["prefers-color-scheme:dark", osDark[1]], ['[data-theme="dark"]', pickedDark[1]]]) {
      assert.ok(new RegExp(`${token}\\s*:`).test(block),
        `the focus ring uses ${token}, which the ${name} theme block never defines`);
    }
  }
});
