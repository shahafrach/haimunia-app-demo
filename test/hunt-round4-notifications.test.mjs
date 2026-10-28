// Live bug hunt, fresh round 4 (2026-09-15) — what the app says unprompted.
//
// Two of the three are sibling drift INSIDE ONE FUNCTION: navigateToNotifTarget()
// has six branches, and only the post branch was ever given a "the thing this
// points at is gone" fallback. The other two anchor-based branches were
// written from the same scrollIntoView pattern and never got it.
//
// The third is another count of one - a plural VERB this time rather than a
// plural noun, which is why the earlier sweeps for "1 X" strings missed it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();

function navBody() {
  const at = cloudJs.indexOf("function navigateToNotifTarget");
  assert.ok(at > -1, "navigateToNotifTarget exists");
  return cloudJs.slice(at, at + 6000);
}



test("closing a nested dialog returns focus to the control that opened IT", () => {
  // HIGH. The opener-restore path only ran when EVERY dialog closed. Close a
  // dialog opened from inside another - the share sheet on top of the PR
  // celebration - and the parent's key became current, so this fell through
  // to the "freshly opening" branch and focused the parent's FIRST control.
  //
  // On both surfaces where this stacking exists the first control is the
  // PUBLISH action, so a keyboard or screen-reader user who pressed Enter out
  // of reflex after dismissing the share sheet published their PR to the club
  // feed without choosing to.
  const at = cloudJs.indexOf("function syncCloudDialogFocus");
  const body = cloudJs.slice(at, at + 5200);
  assert.match(body, /if \(cloudOpenDialogKey && openKey !== cloudOpenDialogKey\s*\n\s*&& \(openKey in cloudDialogOpeners\) && !cloudDialogEl\(cloudOpenDialogKey\)\) \{/,
    "a nested close is recognised: a different dialog is current and the previous one is gone");
  const branch = body.slice(body.indexOf("const closed = cloudOpenDialogKey;"), body.indexOf("if (!(openKey in cloudDialogOpeners))"));
  assert.match(branch, /cloudResolveOpener\(cloudDialogOpeners\[closed\]\)/,
    "focus goes to the CLOSED dialog's own opener");
  assert.match(branch, /delete cloudDialogOpeners\[closed\]/, "and its registration is cleaned up");
  assert.match(branch, /cloudOpenDialogKey = openKey;/, "the parent becomes current");
});



test("the WOD-builder call to action uses the text-safe accent, not the fill", () => {
  // --energy as TEXT on the dark surface is 3.75:1, under the 4.5 required at
  // 14px bold. --energy-text exists precisely for this and measures 5.20:1;
  // index.html's own note says every small-text use "routes around this fill".
  // These two call sites did not.
  const uses = appJs.split('font-size:14px; color:var(--energy-text);').length - 1;
  assert.equal(uses, 2, `both halves of the CTA must use the text token, found ${uses}`);
  assert.ok(!/font-size:14px; color:var\(--energy\);/.test(appJs),
    "no small text may sit on the raw fill colour");
});

test("chips carry the same 44px touch floor as every other interactive class", () => {
  const at = indexHtml.indexOf("  .chip-btn{");
  assert.ok(at > -1, ".chip-btn exists");
  const rule = indexHtml.slice(at, indexHtml.indexOf("}", at));
  assert.match(rule, /min-height:44px/,
    "chips carry real actions - RSVP, leave a challenge, and the X that closes a dialog");
});
