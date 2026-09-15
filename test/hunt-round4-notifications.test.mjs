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

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

function navBody() {
  const at = cloudJs.indexOf("function navigateToNotifTarget");
  assert.ok(at > -1, "navigateToNotifTarget exists");
  return cloudJs.slice(at, at + 6000);
}

test("a weekly recap with one classmate uses a singular verb", () => {
  // "נועם התאמנו איתכם השבוע" - a single name with the plural "they trained".
  // For a club of thirty, exactly one shared classmate in a week is an
  // ordinary outcome, not an edge case.
  assert.match(cloudJs, /classmatesList\.length === 1 \? "התאמן\/ה" : "התאמנו"/,
    "the verb agrees with the number of classmates");
  assert.ok(!/\}\)\.join\(", "\)\} התאמנו איתכם השבוע/.test(cloudJs),
    "the hardcoded plural verb must be gone");
});

test("a notification pointing at a deleted announcement says so", () => {
  const body = navBody();
  const at = body.indexOf("target.announcement");
  const branch = body.slice(at, body.indexOf("target.achievement", at));
  assert.match(branch, /if \(!node\) setMessage\("ההודעה הזו כבר לא זמינה"\);/,
    "a missing announcement anchor must tell the member, not silently do nothing");
  // Keyed on the node being ABSENT, never on whether it can be scrolled to -
  // my first version wrote this as `else` on the scrollIntoView test, which
  // would report a present-but-unscrollable node as deleted.
  assert.match(branch, /else if \(node\.scrollIntoView\)/,
    "scrollability is a separate question from existence");
});

test("a notification pointing at a revoked medal says so", () => {
  const body = navBody();
  const at = body.indexOf("target.achievement");
  const branch = body.slice(at, body.indexOf("target.recapWeek", at));
  assert.match(branch, /if \(!node\) setMessage\("המדליה הזו כבר לא זמינה"\);/,
    "a missing achievement anchor must tell the member");
  assert.match(branch, /else if \(node\.scrollIntoView\)/,
    "and a present one is scrolled to, not reported missing");
});

test("the post branch that these two were modelled on still has its own fallback", () => {
  // The three should not drift apart again. The post branch got this on
  // 2026-09-11 and is the reason the shape was recognisable at all.
  const body = navBody();
  const branch = body.slice(body.indexOf("target.post"), body.indexOf("target.event"));
  assert.match(branch, /setMessage\("התוכן הזה לא נטען בפיד כרגע/,
    "the original fallback is intact");
});

// ===========================================================================
// Accessibility and Hebrew correctness, round 4
// ===========================================================================
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

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

test("no invalid gendered slash form survives, including the one I introduced", () => {
  // אחד -> אחת is irregular: the ד BECOMES ת, so "אחד/ת" spells a non-word -
  // exactly the class this project already bans for ברוך/ה. I introduced it
  // hours earlier in this same session while fixing "1 חברי מועדון", which is
  // why the rule below now covers it by name.
  // The blanket ban lives in hebrew-copy-rules.test.mjs alongside ברוך/ה,
  // which is the canonical list and deliberately a plain substring check.
  // This test only pins the call site's own phrasing.
  assert.match(cloudJs, /count === 1 \? "חבר\/ה במועדון"/,
    "a club of one is phrased without the gendered numeral, not patched around it");
});

test("a one-week streak on the coach picker does not say '1 שבועות'", () => {
  assert.match(cloudJs, /=== 1 \? "שבוע אחד" : `\$\{Number\(d\.streak_weeks\) \|\| 0\} שבועות`/,
    "the coach's member-of-week detail agrees with its own number");
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
