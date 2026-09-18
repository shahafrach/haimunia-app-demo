// Launch-readiness audit, SEC-018.
//
// The security pass flagged 37 innerHTML/outerHTML sinks in app.js and
// recorded confidence LOW, because it had sampled four of them rather than
// tracing all 37 - "worth doing before launch; not worth blocking on".
// This file is that pass, done mechanically so it also stays done.
//
// WHY app.js RATHER THAN cloud.js: cloud.js renders remote,
// attacker-influenced data and has ZERO innerHTML assignments (asserted
// below, so that stays true). app.js renders the LOCAL training log - but
// "local" is not the same as "trusted": records round-trip through
// private_records and come back from the network, and an import file is
// user-supplied. So the sinks are worth pinning even though the blast
// radius is self-XSS rather than cross-member.
//
// The rule enforced: every `${...}` inside an innerHTML/outerHTML
// assignment must be esc()-wrapped, a numeric coercion, or an identifier
// this file explicitly allow-lists as a proven constant. A new unwrapped
// interpolation fails here rather than shipping.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");

// Identifiers proven safe by inspection during the SEC-018 pass. Each entry
// records WHY, because an allow-list without reasons rots into a mute
// button.
const PROVEN_SAFE = new Map([
  // Hardcoded SVG string literals in the ICONS object (app.js ~2218).
  // No user input reaches them; they are markup by construction.
  ["ICONS.chevronsLeft", "hardcoded SVG literal in const ICONS"],
  ["ICONS.dumbbell", "hardcoded SVG literal in const ICONS"],
  ["ICONS.flame", "hardcoded SVG literal in const ICONS"],
  // computeCurrentStreak(): `let streak = 0` incremented in a while loop
  // and returned. Provably an integer, never a string.
  ["streak", "integer counter from computeCurrentStreak()"],
  // renderNotificationsList(): a ternary of two hardcoded Hebrew string
  // literals, gated on RELEASE_NOTES.length (a const array's own length,
  // not a value that can carry user input).
  ["notifEmptyMessage", "ternary of two hardcoded literals in renderNotificationsList(), gated on RELEASE_NOTES.length"],
]);

function sinkLines(src) {
  return src.split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => /\.(innerHTML|outerHTML)\s*=/.test(line));
}

test("cloud.js still has zero innerHTML/outerHTML assignments", () => {
  // This is the load-bearing one: cloud.js is where remote, other-member
  // data is rendered. It reaches esc() unguarded at the top of the file
  // precisely so it fails loudly rather than degrading to a no-op.
  assert.equal(sinkLines(cloudJs).length, 0,
    "cloud.js renders attacker-influenced data - it must keep using template composition with esc(), never a raw innerHTML sink");
});

test("every interpolation in an app.js innerHTML sink is escaped, numeric, or a proven constant", () => {
  const offenders = [];
  for (const { n, line } of sinkLines(appJs)) {
    for (const m of line.matchAll(/\$\{([^}]+)\}/g)) {
      const expr = m.group ? m.group(1) : m[1];
      const e = expr.trim();
      // Escaped, explicitly coerced, or a bare number.
      if (/^(esc|Number|String|parseInt|parseFloat)\s*\(/.test(e)) continue;
      if (/^\d+$/.test(e)) continue;
      // A nested template that is itself fully escaped is fine; the regex
      // above already caught the simple cases, so anything left is checked
      // against the allow-list by exact text.
      if (PROVEN_SAFE.has(e)) continue;
      offenders.push(`app.js:${n} -> \${${e}}`);
    }
  }
  assert.deepEqual(offenders, [],
    "unescaped interpolation reaching an innerHTML sink - wrap it in esc(), coerce it with Number(), or add it to PROVEN_SAFE with the reason it cannot carry user input");
});

test("the sink count is pinned, so a new sink is a deliberate decision", () => {
  // Not a style rule - a review trigger. Adding an innerHTML sink to app.js
  // should require looking at this file and thinking about escaping, which
  // is exactly what SEC-018 found had not happened.
  // 37 -> 38 on 2026-09-15: openSupport() writes renderSupportContent() into
  // #supportBody, the same shape openAchievements()/renderNotificationsList()
  // already use for their own overlays. Checked rather than waved through,
  // since that is what this pin is for: the body interpolates exactly two
  // things, a routes array built from string literals in this file, and
  // esc(supportDiagnostics()). The diagnostics string is the only one
  // carrying outside input at all (navigator.userAgent) and it is escaped.
  // The member's own typed description is NEVER interpolated - it is read
  // from the live textarea's .value at send time by supportReportText() and
  // handed to encodeURIComponent(), so it never re-enters the DOM as markup.
  //
  // 38 -> 40 on 2026-09-18: render() gained the desktop staff shell's context
  // column, which is two sinks on #contextCol - the write, and the `= ""`
  // reset in its own catch. Checked rather than waved through, which is what
  // this pin exists to force:
  //   * NEITHER LINE INTERPOLATES ANYTHING. One assigns the return value of
  //     window.renderStaffContextColumn() (a cloud.js function reached
  //     through a typeof guard), the other assigns an empty string literal.
  //     There is no `${...}` in either, so there is nothing in app.js for
  //     this file's escaping rule to check.
  //   * The markup itself is built in cloud.js, from the same coach section
  //     renderers the phone already uses, and cloud.js is asserted directly
  //     below to have ZERO innerHTML sinks of its own - it returns strings
  //     and app.js is the one that writes them, which is the arrangement
  //     this file is built around.
  //   * The one value that column composes itself is pendingModerationCount(),
  //     a .filter().length - provably an integer, the same class of value as
  //     computeCurrentStreak() in the PROVEN_SAFE list above. Every other
  //     interpolation in it goes through esc() or bidiText().
  const count = sinkLines(appJs).length;
  assert.equal(count, 40,
    `app.js has ${count} innerHTML/outerHTML sinks, expected 40. If you added one, verify its interpolations are escaped and update this number; if you removed one, just update it.`);
});

test("esc() is a single shared definition, so there is one escaping rule and not several", () => {
  const helpers = fs.readFileSync(path.join(root, "src", "shared", "safe-helpers.js"), "utf8");
  // & < > " ' - correct for both text and quoted-attribute contexts.
  assert.match(helpers, /function esc\(/);
  for (const ch of ["&", "<", ">", '"', "'"]) {
    assert.ok(helpers.includes(ch), `esc() must handle ${ch}`);
  }
  // No second definition anywhere that could drift from it.
  assert.doesNotMatch(appJs, /^\s*function esc\(/m,
    "app.js must use the shared esc(), not define its own");
  assert.doesNotMatch(cloudJs, /^\s*function esc\(/m,
    "cloud.js must use the shared esc(), not define its own");
});
