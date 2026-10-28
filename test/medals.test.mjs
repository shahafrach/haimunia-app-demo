// Tiered achievement medals (pr/streak groups: the only ones with a
// bronze/silver/gold tier) are drawn, not pictured. They are the same SVG
// shield/circle as the other medals, with a tier class (.tier-bronze,
// .tier-silver, .tier-gold) that picks the metal from the --bronze-*,
// --silver-* and --gold-* component tokens and the glow from a token-based
// color-mix. The Design session removed the photographed weight plates
// (assets/medal-*.png): a picture cannot follow a palette, and the old
// square-glow bug was a property of the clipped photo, which no longer exists.
//
// ACHIEVEMENTS is a module-scope `const`, not a window property (top-level
// const/let never attach to the global object), so this drives the real
// achievements modal DOM the same way the rest of this suite does, rather
// than reaching into internal state directly.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function badgeByName(window, text) {
  return [...window.document.querySelectorAll(".medal-badge")].find((el) => el.querySelector(".medal-name")?.textContent.includes(text));
}

test("an earned medal's glow is a drop-shadow on its own SVG, colored by the tier's glow token", () => {
  assert.match(indexHtml, /\.medal-badge\.earned \.medal-shape:not\(\.medal-shape-plate\) \{[^}]*filter:drop-shadow\(0 0 5px var\(--glow-color\)\)/);
  for (const tier of ["bronze", "silver", "gold"]) {
    assert.match(indexHtml, new RegExp(`\\.tier-${tier} \\{[^}]*--glow-color:color-mix\\(in srgb, var\\(--${tier}-mid\\)`), `${tier} glow is a color-mix of its metal token`);
  }
  assert.ok(!fs.existsSync(new URL("../assets/medal-bronze.png", import.meta.url)), "the photographed plates are gone");
});

test("tiered (pr) medals are drawn SVG medals whose metal comes from tier tokens, not pictures", async () => {
  const window = await bootApp();
  window.openAchievements();

  const bronze = badgeByName(window, "ברונזה");
  const silver = badgeByName(window, "כסף");
  const gold = badgeByName(window, "זהב");
  assert.ok(bronze && silver && gold, "the achievements list should show all three PR tiers");

  for (const [el, tier] of [[bronze, "bronze"], [silver, "silver"], [gold, "gold"]]) {
    assert.ok(el.querySelector(`svg.medal-shape.tier-${tier}`), `${tier}: an SVG medal carrying its tier class`);
    assert.equal(el.querySelector("img"), null, `${tier}: no picture of a medal`);
  }
});

test("a medal's glow comes from its tier class, not from an inline color", async () => {
  const window = await bootApp();
  window.openAchievements();
  for (const el of window.document.querySelectorAll(".medal-badge")) {
    assert.ok(!/--glow-color/.test(el.getAttribute("style") || ""), "the glow color is a token-based rule in tokens/CSS, not inline");
  }
});

test("tiered (streak) medals use the same tier classes as pr medals", async () => {
  const window = await bootApp();
  window.openAchievements();
  const streakBronze = [...window.document.querySelectorAll(".medal-badge")].find((el) => el.querySelector(".medal-name")?.textContent.includes("רצף") && el.querySelector(".medal-name")?.textContent.includes("ברונזה"));
  assert.ok(streakBronze, "a bronze-tier streak achievement should exist");
  assert.ok(streakBronze.querySelector("svg.medal-shape.tier-bronze"));
});

test("non-tiered medals (milestone, rx, capstone) still render the SVG shield/circle, as before", async () => {
  const window = await bootApp();
  window.openAchievements();
  const badges = [...window.document.querySelectorAll(".medal-badge")];
  const milestone = badges.find((el) => el.querySelector(".medal-name")?.textContent.includes("אתלט שלם"));
  const capstone = badges.find((el) => el.classList.contains("capstone-badge"));
  assert.ok(milestone && capstone, "a milestone badge and the capstone badge should both be present");

  for (const badge of [milestone, capstone]) {
    assert.ok(badge.querySelector("svg.medal-shape"), "non-tiered medals should still use the SVG shield/circle");
    assert.equal(badge.querySelector(".medal-plate"), null, "non-tiered medals should never pick up the plate frame (no tier)");
  }
});

test("a tiered medal still gets the locked/earned CSS classes on the surrounding badge, as before", async () => {
  const window = await bootApp();
  window.openAchievements();
  const found = badgeByName(window, "ברונזה");
  assert.ok(found, "the bronze PR badge should exist");
  assert.ok(found.classList.contains("locked"), "a fresh install should have this tier locked");
  assert.ok(!found.classList.contains("earned"));
  // The SVG carries medal-shape, so the grayscale (locked) and glow (earned)
  // filter rules scoped to .medal-badge.locked/.earned .medal-shape reach it.
  assert.ok(found.querySelector("svg.medal-shape"));
});
