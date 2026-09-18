// The desktop layout's two attributes, and the gate between them.
//
// The whole safety argument for this feature rests on one thing: there is no
// CSS rule keyed on data-layout alone, so a member at a laptop matches
// nothing. These tests pin the attributes; the stylesheet half is pinned in
// test/desktop-layout-css.test.mjs and measured for real at 1440px by
// scripts/browser-check/desktop-staff-shell.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, waitFor } from "./helpers/boot.mjs";

const DESKTOP = "(min-width: 1024px) and (pointer: fine)";
const root = (w) => w.document.documentElement;

test("the query is exactly the one the brief names - width AND a fine pointer", async () => {
  const asked = [];
  await bootApp({ matchMedia: (q) => { asked.push(q); return false; } });
  assert.ok(asked.includes(DESKTOP), `expected ${DESKTOP}, saw: ${asked.join(" | ")}`);
});

test("a phone gets neither attribute", async () => {
  const w = await bootApp();
  assert.equal(root(w).getAttribute("data-layout"), null);
  assert.equal(root(w).getAttribute("data-staff"), null);
});

test("a wide COARSE-pointer tablet is not a desktop", async () => {
  // True for the width half, false for the whole query: a 1024px touch tablet.
  const w = await bootApp({ matchMedia: (q) => q === "(min-width: 1024px)" });
  assert.equal(root(w).getAttribute("data-layout"), null);
});

test("a member at a real desktop gets data-layout and NOT data-staff", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  assert.equal(root(w).getAttribute("data-layout"), "desktop");
  assert.equal(root(w).getAttribute("data-staff"), null,
    "this is the attribute the whole staff shell hangs off - a member must never carry it");
});

test("staff at a real desktop get both", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  w.communityIsStaff = () => true;
  w.render();
  assert.equal(root(w).getAttribute("data-layout"), "desktop");
  assert.equal(root(w).getAttribute("data-staff"), "1");
});

test("staff on a phone get neither - the shell is desktop-only", async () => {
  const w = await bootApp();
  w.communityIsStaff = () => true;
  w.render();
  assert.equal(root(w).getAttribute("data-layout"), null);
  assert.equal(root(w).getAttribute("data-staff"), null);
});

test("the attributes follow the window live, in both directions", async () => {
  const w = await bootApp();
  w.communityIsStaff = () => true;
  w.render();
  assert.equal(root(w).getAttribute("data-layout"), null);

  w.__setMediaMatcher((q) => q === DESKTOP);
  await waitFor(() => root(w).getAttribute("data-layout") === "desktop", 2000);
  assert.equal(root(w).getAttribute("data-staff"), "1");

  w.__setMediaMatcher(() => false);
  await waitFor(() => root(w).getAttribute("data-layout") === null, 2000);
  assert.equal(root(w).getAttribute("data-staff"), null, "the staff attribute goes with it");
});

test("signing in as staff mid-session reaches the shell without a resize", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  assert.equal(root(w).getAttribute("data-staff"), null);
  // What cloud.js publishing a resolved community session looks like.
  w.communityIsStaff = () => true;
  w.render();
  assert.equal(root(w).getAttribute("data-staff"), "1");
});

test("no community layer, or one that throws, reads as not-staff rather than breaking the render", async () => {
  const w = await bootApp({ matchMedia: (q) => q === DESKTOP });
  w.communityIsStaff = () => { throw new Error("cloud.js exploded"); };
  w.render();
  assert.equal(root(w).getAttribute("data-layout"), "desktop");
  assert.equal(root(w).getAttribute("data-staff"), null);
});
