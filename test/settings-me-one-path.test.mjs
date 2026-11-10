// Audit M6, M7 (2026-11): Me was reachable only from the circle avatar, the
// signed-out support sheet sent members to it anyway, appearance was set in
// two places, and the nav card showed the private log's name while Home showed
// the profile's. Now: Me is in the menu for everyone, Settings links to it,
// appearance lives once in Settings, and one name is shown.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";
import { createCirclesMock, bootCommunity, click, waitFor } from "./helpers/circles.mjs";

test("signed out: the menu has a Me row, and the support sheet's sign-in button opens Me", async () => {
  const window = await bootApp();
  window.document.getElementById("navMenuBtn").click();
  const meRow = window.document.querySelector("#navMenuList #tabMeBtn");
  assert.ok(meRow, "Me is a menu row");
  assert.match(meRow.textContent, /אני והחשבון/);
  assert.equal(window.document.querySelector("#bottomTabBar #tabMeBtn"), null, "and not a bottom tab");
  window.openSupport();
  const btn = window.document.querySelector('#supportBody [data-action="open-me"]');
  assert.ok(btn, "the signed-out support sheet offers a way in");
  assert.ok(!/במסך "אני"/.test(window.document.getElementById("supportBody").textContent), "and no longer names a screen without saying how to reach it");
  btn.click();
  assert.equal(window.document.getElementById("supportOverlay").classList.contains("open"), false);
  assert.equal(window.haimuniaActiveTab, "me");
});

test("Settings leads to Me, signed in or not", async () => {
  const window = await bootApp();
  window.openSettings();
  const row = window.document.querySelector('#settingsBody [data-action="open-me"]');
  assert.ok(row);
  assert.match(row.textContent, /כניסה או הרשמה/);
});

test("signed in: Me has no appearance controls of its own, only a link to Settings; one name everywhere", async () => {
  const mock = createCirclesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-open-me"]'), 4000);
  click(window, '[data-community-action="c-open-me"]');
  await waitFor(() => !!window.document.getElementById("communityProfile"), 4000);
  const content = window.document.getElementById("content");
  assert.equal(content.querySelector("[data-appearance-root]"), null, "no second set of appearance controls in Me");
  assert.ok(content.querySelector('[data-action="open-settings"]'), "a link to where they are");
  window.document.getElementById("navMenuBtn").click();
  assert.equal(window.document.querySelector("#navMenuList .who-name").textContent.trim(), "אני", "the nav card shows the profile name");
  assert.equal(window.document.querySelector("#settingsBody .who-name").textContent.trim(), "אני", "and so does Settings");
  assert.match(window.document.querySelector('#settingsBody [data-action="open-me"]').textContent, /החשבון והמעגלים שלי/);
});
