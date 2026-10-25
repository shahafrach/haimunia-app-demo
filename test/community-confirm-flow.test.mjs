// Found by an independent UX review: publishing a workout to the
// community feed (public, optionally with a photo) fired immediately
// with zero confirmation or preview, while comparatively low-stakes
// actions in the same file (block, sync history, delete account) went
// through native window.confirm() - three different destructive-action
// patterns for comparably serious actions, and the riskiest one (public
// broadcast) had none at all. Replaced all of it with one in-app confirm
// dialog (askConfirm/closeConfirm/runConfirm), reused for every
// destructive or broadcast action, plus a new delete-own-post action
// (there was previously no way to remove a single published post short
// of deleting the whole account).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

import { cloudSource } from "./helpers/community-src.mjs";
// The community layer, not one file of it: what this test asserts is a
// property of the layer, and the layer is cloud.js plus src/community/*.js
// now. Every pattern below is unchanged.
const src = cloudSource();

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();

test("no raw window.confirm() remains in cloud.js", () => {
  assert.doesNotMatch(src, /window\.confirm\(/);
});

test("askConfirm/closeConfirm/runConfirm exist, and the dispatcher wires confirm-yes/confirm-no", () => {
  assert.match(src, /function askConfirm\(opts\) \{ state\.ui\.confirmDialog = opts; rerender\(\); \}/);
  assert.match(src, /function closeConfirm\(\) \{ state\.ui\.confirmDialog = null; rerender\(\); \}/);
  assert.match(src, /function runConfirm\(\)/);
  assert.match(src, /action === "confirm-yes"\) runConfirm\(\)/);
  assert.match(src, /action === "confirm-no"\) closeConfirm\(\)/);
});

test("publishing asks for confirmation with a title/result preview before calling publishWorkout, instead of firing immediately", () => {
  const clickHandlerStart = src.indexOf('if (action === "publish") {');
  const clickHandlerEnd = src.indexOf("else if (action === \"follow\")", clickHandlerStart);
  const block = src.slice(clickHandlerStart, clickHandlerEnd);
  assert.match(block, /askConfirm\(\{ title: "פרסום תוצאה"/);
  assert.match(block, /action: "publish", payload: \{ type: el\.dataset\.type, id: el\.dataset\.id, visibility: el\.dataset\.visibility, file \}/);
  assert.doesNotMatch(block, /publishWorkout\(/, "publishWorkout must not be called directly from the click handler anymore - only from runConfirm()");
});

test("block, delete-account, and migrate all route through askConfirm with a destructive-appropriate label", () => {
  assert.match(src, /askConfirm\(\{ title: "חסימת משתמש".*action: "block", payload: \{ userId: el\.dataset\.id \} \}\)/);
  assert.match(src, /askConfirm\(\{ title: "מחיקת חשבון".*action: "delete-account" \}\)/);
  assert.match(src, /askConfirm\(\{ title: "סנכרון היסטוריה".*action: "migrate" \}\)/);
});

test("post deletion goes through the post_delete RPC behind the undo window, and only the author is offered it (block otherwise)", () => {
  // The legacy direct-table delete (deletePost, the no-post_type card's own
  // "הסרת שיתוף") went with that card; what is left is the typed card's menu.
  // The author scoping is enforced by post_delete() on the server.
  const fn = src.slice(src.indexOf("async function postDeleteViaMenu("), src.indexOf("async function", src.indexOf("async function postDeleteViaMenu(") + 10));
  assert.match(fn, /deferCommunityDelete\(\{/, "it goes out through the undo window, not straight from the tap");
  assert.match(fn, /client\.rpc\("post_delete", \{ post_id: postId \}\)/, "and through the RPC that checks the caller");
  const menu = src.slice(src.indexOf("function postMenuHtml("), src.indexOf("function postActionsHtml("));
  assert.match(menu, /if \(own\) \{/, "the menu branches on whether the post is the caller's own");
  assert.match(menu, /mi\("post-delete", "מחיקה", post\.id, true\)/, "the author is offered delete, marked destructive");
  // Reports went with the moderation queue (docs/circles/decisions.md): what
  // is left for everyone else is blocking the author.
  assert.match(menu, /\} else \{[\s\S]*mi\("block", "חסימת החבר\/ה", post\.author_id, true\)/, "and everyone else is offered block, not delete");
  assert.doesNotMatch(menu, /mi\("report"/, "no report action remains");
  assert.doesNotMatch(src, /<div class="chip-row post-actions">\s*<button class="chip-btn" data-community-action="delete-post"/,
    "no card may put a delete chip back into the action row");
  assert.match(src, /askConfirm\(\{ title: "מחיקת פוסט".*action: "post-delete-rpc", payload: \{ postId: el\.dataset\.id \} \}\)/);
});

test("COMM-234: renderConfirmSheet() is concatenated LAST in renderConfirmDialog(), so it stacks on top of every other .modal-overlay it can be nested inside", () => {
  // Found by a real-Chromium browser-check run (community-challenge-lifecycle.mjs
  // - leave-challenge's confirm fires while challengeView is still open):
  // every overlay this function returns shares the .modal-overlay class and
  // the same fixed z-index:50 (index.html), so two open at once stack by DOM
  // order, not by which one is logically "on top". askConfirm() is always a
  // modal-on-modal nested inside whatever triggered it (leave-challenge/
  // event-cancel/composer-discard all fire it with their own overlay still
  // open), so its markup has to be the last thing concatenated. jsdom's
  // programmatic .click() has no hit-testing, so this real bug was invisible
  // to every prior test that clicked confirm-yes directly - this source-order
  // assertion is the change-detector; the real-browser click-through proof
  // lives in scripts/browser-check/community-challenge-lifecycle.mjs.
  const fnStart = src.indexOf("function renderConfirmDialog()");
  const fnEnd = src.indexOf("\n  }", fnStart);
  const body = src.slice(fnStart, fnEnd);
  const confirmIdx = body.indexOf("renderConfirmSheet()");
  assert.ok(confirmIdx > -1, "renderConfirmSheet() must still be called from renderConfirmDialog()");
  for (const other of ["renderPrSharePrompt()", "renderAchievementUnlockCelebration()", "renderNotificationCenter()"]) {
    const otherIdx = body.indexOf(other);
    assert.ok(otherIdx > -1, `${other} must still be called from renderConfirmDialog()`);
    assert.ok(confirmIdx > otherIdx, `renderConfirmSheet() must be concatenated after ${other}, so it paints on top`);
  }
});

test("the confirm dialog is exposed globally (not just inside the Community tab's own output) and reset on sign-out", () => {
  // Sharing can now be triggered from the Calendar/Progress tabs (see
  // renderShareControl), so the confirm dialog can't only render as part
  // of renderCommunityApp()'s return value - app.js's own render() calls
  // window.renderCloudConfirmDialog() unconditionally after every tab's
  // content instead. See community-live-sync-and-auth.test.mjs for an
  // executing test of this actually working across a tab switch.
  assert.match(src, /function renderConfirmDialog\(\)/);
  assert.match(src, /window\.renderCloudConfirmDialog = renderConfirmDialog;/);
  assert.match(src, /state\.ui\.confirmDialog = null;\s*$/m);
});
