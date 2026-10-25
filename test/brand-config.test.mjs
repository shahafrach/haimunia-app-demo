// The product name, and the two things that look like it and are not.
//
// WHY THIS FILE EXISTS. Making a name configurable is the kind of change that
// passes every test while doing nothing: a helper that always returns the
// hardcoded default reads identically to one that works, because the default
// IS the current value. So every assertion here sets a different name and
// checks it comes back, rather than checking the Haimunia one does.
//
// It also pins the two traps. ~190 "haimunia" references in this repo are four
// different things, and two of them destroy data if they are ever treated as
// branding:
//
//   haimunia-demo:             the localStorage prefix, ~38 uses. Every
//                              member's training log lives under it. Change it
//                              on a live club and every phone starts empty,
//                              with the real data still on disk, unread.
//   members.haimuniya.invalid  the synthetic email domain, already written
//                              into auth.users. Change it and every member is
//                              locked out, with no self-service reset because
//                              the addresses were never deliverable.
//
// Both are asserted to still be literal. If a future session "finishes the
// job" by routing them through config, these fail and say why.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { bootApp } from "./helpers/boot.mjs";
import { COMMUNITY_MODULES } from "./helpers/community-src.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

function freshBrand() {
  // safe-helpers.js is an IIFE over a global; give it a bare object to publish
  // onto so each case starts clean.
  const g = {};
  new Function("window", "globalThis", read("src/shared/safe-helpers.js"))(g, g);
  return g;
}

test("a different deployment gets a different name - the helper reads config, it does not return a constant", () => {
  const g = freshBrand();
  g.HAIMUNIA_CONFIG = { brand: { appName: "BoxLog", wordmark: "BOXLOG", championTitle: "אלוף קרוספיט תל אביב" } };
  assert.equal(g.brandName(), "BoxLog");
  assert.equal(g.brandWordmark(), "BOXLOG");
  assert.equal(g.brandChampionTitle(), "אלוף קרוספיט תל אביב");
});

test("a partial config derives the rest instead of rendering blanks", () => {
  const g = freshBrand();
  g.HAIMUNIA_CONFIG = { brand: { appName: "BoxLog" } };
  assert.equal(g.brandWordmark(), "BoxLog", "wordmark falls back to the app name");
  assert.equal(g.brandChampionTitle(), "אלוף BoxLog", "the champion title composes");
});

test("NO config at all still names the app - a missing cloud-config.js must not white-screen it", () => {
  // This is the failure the accessors moved files to avoid: app.js builds
  // ATHLETE_LEVELS and ACHIEVEMENTS at module evaluation, so an undefined
  // helper there is not a missing label, it is a dead app. 1184 of 1858 tests
  // proved it.
  const g = freshBrand();
  assert.equal(g.brandName(), "BOX-LOG");
  assert.equal(g.brandWordmark(), "BOX-LOG");
  assert.equal(g.brandChampionTitle(), "אלוף BOX-LOG");
});

test("the config is read at call time, so a config loaded after this file still counts", () => {
  // index.html loads safe-helpers.js BEFORE cloud-config.js. Capturing the
  // value at definition time would pin the fallback forever and look correct
  // in every test that happens to use the default.
  const g = freshBrand();
  assert.equal(g.brandName(), "BOX-LOG");
  g.HAIMUNIA_CONFIG = { brand: { appName: "BoxLog" } };
  assert.equal(g.brandName(), "BoxLog", "a later config takes effect");
});

test("the shipped config still names this club, and the accessors are on BoxLogSafe too", () => {
  const g = freshBrand();
  new Function("window", read("cloud-config.js"))(g);
  assert.equal(g.brandName(), "BOX-LOG");
  assert.equal(typeof g.BoxLogSafe.brandName, "function");
  assert.ok(Object.isFrozen(g.HAIMUNIA_CONFIG.brand), "the brand block is frozen like the rest of the config");
});

test("the storage prefix is NOT configurable, and the reason is written down", () => {
  const app = read("app.js");
  assert.ok(app.includes("haimunia-demo:"),
    "the localStorage prefix must stay literal - routing it through config orphans every member's training log");
  const cfg = read("cloud-config.js");
  assert.match(cfg, /haimunia-demo:/,
    "cloud-config.js must still WARN about the prefix, because that is where somebody will look for it");
  assert.match(cfg, /NOT CONFIGURABLE/);
});

test("the synthetic email domain is NOT configurable either", () => {
  // usernameToEmail() is in src/community/auth.js now.
  const cloud = read("src/community/auth.js");
  assert.match(cloud, /\$\{username\}@members\.haimuniya\.invalid/,
    "usernameToEmail must stay literal - the addresses are already in auth.users");
  assert.match(read("cloud-config.js"), /members\.haimuniya\.invalid/,
    "and cloud-config.js must explain why it is not a setting");
});

test("every display of the name goes through the helper - no literal left behind in the app's own copy", () => {
  // sw.js is the one deliberate exception (a service worker cannot read the
  // page's window), and it carries a comment saying so. index.html,
  // manifest.json, terms.html and privacy.html are static and are listed in
  // PER_CLUB_SETUP.md instead.
  // Every file of the community layer, not just cloud.js — a literal product
  // name is exactly the kind of thing that rides along with moved code.
  for (const f of ["app.js", "cloud.js", ...COMMUNITY_MODULES]) {
    const src = read(f);
    assert.ok(!src.includes('"BOX-LOG"'),
      `${f} still has a quoted literal product name - it should call brandName()`);
    assert.ok(!src.includes(">BOX-LOG<"),
      `${f} still renders the product name straight into markup`);
  }
  assert.match(read("sw.js"), /A SERVICE WORKER CANNOT READ cloud-config\.js/,
    "sw.js keeps its literal, and says why");
});

test("the app boots and renders the configured name, not a hardcoded one", async () => {
  const window = await bootApp();
  assert.equal(typeof window.brandName, "function", "the helper reached the page");
  const footer = window.document.body.textContent;
  assert.ok(footer.includes(window.brandName()),
    "the rendered footer shows whatever brandName() returns");
});
