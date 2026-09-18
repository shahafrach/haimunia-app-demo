// The desktop staff shell: the stylesheet's own rules, and the sidebar.
//
// Two claims are made about this feature in prose, and both are the kind
// that rot silently. They are enforced here instead:
//   1. No rule can reach a member or a phone, because every selector
//      carries BOTH attributes.
//   2. No hardcoded colour, so the shell follows the theme in both dark
//      mechanisms without a rule of its own.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";
import { createHash } from "node:crypto";

const DESKTOP = "(min-width: 1024px) and (pointer: fine)";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const block = (() => {
  const start = html.indexOf("THE DESKTOP STAFF SHELL (2026-09-18)");
  assert.ok(start > 0, "the staff shell block should exist");
  return html.slice(start, html.lastIndexOf("</style>"));
})();
// The slice starts inside the block's own opening comment, so close that one
// off before stripping the rest.
const rules = block.slice(block.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");

test("every selector in the shell carries BOTH attributes - a member matches nothing", () => {
  let checked = 0;
  for (const m of rules.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (!head || head.startsWith("@")) continue;
    for (const one of head.split(",")) {
      const sel = one.trim();
      if (!sel) continue;
      checked++;
      assert.ok(sel.startsWith('html[data-layout="desktop"][data-staff="1"]'),
        `every staff-shell selector needs both attributes, found: ${sel}`);
    }
  }
  assert.ok(checked > 12, `sanity check: expected the whole block, checked ${checked}`);
});

test("there is no rule keyed on data-layout alone, anywhere in the stylesheet", () => {
  // This is the single line that keeps the member desktop layout untouched.
  const styles = html.slice(0, html.lastIndexOf("</style>"));
  for (const m of styles.matchAll(/html\[data-layout="desktop"\](\[data-staff="1"\])?/g)) {
    assert.ok(m[1], "a rule matched data-layout without data-staff - that would reach every member at a laptop");
  }
});

test("the shell uses existing tokens and introduces no colour of its own", () => {
  const hexes = rules.match(/#[0-9a-fA-F]{3,8}/g) || [];
  assert.deepEqual(hexes, [], `no hardcoded colours allowed in the staff shell, found: ${hexes.join(", ")}`);
  for (const fn of ["rgb(", "rgba(", "hsl("]) {
    assert.ok(!rules.includes(fn), `no literal ${fn} colours either`);
  }
  assert.ok(rules.includes("var(--surface)") && rules.includes("var(--border)") && rules.includes("var(--steel)"),
    "sanity check: it should actually be using the app's tokens");
});

test("it sets no font-family - the app's own self-hosted stacks apply", () => {
  assert.ok(!/font-family/.test(rules));
});

test("a member's sidebar is byte-identical with the shell code present", async () => {
  const member = await bootApp({ matchMedia: (q) => q === DESKTOP });
  const staff = await bootApp({ matchMedia: (q) => q === DESKTOP });
  staff.communityIsStaff = () => true;
  staff.render();

  const hashOf = (w) => createHash("sha256")
    .update(w.document.getElementById("desktopSidebar").innerHTML).digest("hex");
  assert.notEqual(hashOf(member), hashOf(staff), "sanity check: the staff sidebar IS different");

  // The member's sidebar is one ungrouped list, exactly as before.
  assert.equal(member.document.querySelectorAll("#desktopSidebar .nav-group").length, 0);
  assert.equal(member.document.querySelectorAll('#desktopSidebar [role="tablist"]').length, 1);
});

test("the staff sidebar groups the SAME destinations under three headings", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  w.communityIsStaff = () => true;
  w.render();

  const heads = [...w.document.querySelectorAll("#desktopSidebar .nav-group-head")].map((e) => e.textContent);
  assert.deepEqual(heads, ["צוות", "קהילה", "האימון שלי"]);

  const grouped = [...w.document.querySelectorAll("#desktopSidebar .nav-group .navrow")].map((e) => e.dataset.tab);
  assert.deepEqual(grouped, ["staffhome", "manage", "clubmanage", "community", "add", "history", "calendar", "wod"]);

  // Same rows as the ungrouped list a member gets, plus the one destination
  // this feature adds - not a second navigation mechanism.
  const member = await bootApp({ matchMedia: (q) => q === DESKTOP });
  const memberTabs = [...member.document.querySelectorAll("#desktopSidebar .navrow")]
    .map((e) => e.dataset.tab).filter(Boolean);
  assert.deepEqual(grouped.filter((t) => t !== "staffhome").sort(), memberTabs.sort());
});

test("the bottom bar and the hamburger are untouched by the grouping", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  w.communityIsStaff = () => true;
  w.render();
  const bottom = [...w.document.querySelectorAll("#bottomTabBar .tabbtn")].map((e) => e.dataset.tab);
  assert.deepEqual(bottom, ["add", "history", "calendar", "wod", "community"],
    "staffhome is main:false and must never reach the bottom bar");
  assert.equal(w.document.querySelectorAll("#bottomTabBar .nav-group").length, 0);
});

test("staffhome is unreachable without the shell, and the guard rewrites the tab", async () => {
  const phone = await bootApp({ url: "https://example.test/?tab=staffhome" });
  assert.equal(phone.haimuniaActiveTab, "add");

  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  w.communityIsStaff = () => true;
  w.render();
  w.document.querySelector('#desktopSidebar .navrow[data-tab="staffhome"]').click();
  assert.equal(w.haimuniaActiveTab, "staffhome");

  // The coach drags the window narrow: the tab itself is rewritten.
  w.__setMediaMatcher(() => false);
  assert.equal(w.haimuniaActiveTab, "add");
});

test("the context column stays empty for a member, so the :has() gate still holds", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  assert.equal(w.document.getElementById("contextCol").children.length, 0);
});

test("the rail stays off the two management tabs, so their 940px table area survives", async () => {
  // The ≥1200 rule that widens ניהול is gated on the context column being
  // EMPTY - `.app-shell:not(:has(> .context-col > *))`. Filling it there
  // collapsed the moderation queue, the roster and the audit log from 940px
  // back to 560px, which scripts/browser-check/desktop-layout.mjs measured
  // and this asserts the cause of.
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  w.communityIsStaff = () => true;
  // The rail's CONTENT is cloud.js's (bootApp loads app.js alone), and what
  // is under test here is app.js's decision about WHICH TABS get one - so the
  // content is stubbed and the decision is real.
  w.renderStaffContextColumn = () => "<div>rail</div>";
  w.render();
  w.document.querySelector('#desktopSidebar .navrow[data-tab="staffhome"]').click();
  assert.ok(w.document.getElementById("contextCol").children.length > 0,
    "the rail is there on a coach screen");

  w.document.querySelector('#desktopSidebar .navrow[data-tab="manage"]').click();
  assert.equal(w.document.getElementById("contextCol").children.length, 0,
    "and gone on ניהול, or that tab loses 380px of table");

  w.document.querySelector('#desktopSidebar .navrow[data-tab="clubmanage"]').click();
  assert.equal(w.document.getElementById("contextCol").children.length, 0);
});
