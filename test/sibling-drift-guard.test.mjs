// B4. The dominant defect in this codebase is not a wrong rule - it is a
// right rule applied to one of the two places that needed it. Two bugs on
// 2026-09-16 were the same bug twice:
//
//   * the roster row is rendered by TWO surfaces from ONE template, and three
//     of the four controls on it refreshed only one surface. Reported live as
//     "after giving coach permission, it's not changing" - the RPC had
//     succeeded every time and the screen was showing a stale read.
//   * six dialogs carried the identical copied `align-items:flex-start`,
//     pinning the card to the top of the screen with half the viewport empty
//     under it. Reported as "the challenge window is too high".
//
// Both were fixed by hand, in all six and all four places. This file exists
// so the SEVENTH and the FIFTH cannot be added silently. It deliberately
// derives what to check from the source rather than from a list written here:
// a list would need the same maintenance the bug class is made of.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// Slice one function body: from its signature to the next declaration at the
// same (two-space) indentation. Everything in cloud.js lives inside one IIFE,
// so that indentation is the file's top level.
function fnBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at > -1, `cannot find ${signature} - this guard is reading a file it no longer understands`);
  const rest = src.slice(at + signature.length);
  const end = rest.search(/\n {2}(?:async )?function /);
  return rest.slice(0, end === -1 ? 6000 : end);
}

test("no dialog overlay pins its card to the top of the screen", () => {
  // .modal-overlay's own rule is align-items:flex-end - it is a bottom sheet
  // by default - so a centred card dialog MUST override align-items inline.
  // The inline style is load-bearing, not redundant, which is why the fix was
  // to correct the value in all six rather than to delete it.
  assert.match(indexHtml, /\.modal-overlay\{[^}]*align-items:flex-end/,
    "the base rule is still a bottom sheet, so the inline overrides below are still needed");

  const files = [["cloud.js", cloudJs], ["app.js", appJs], ["index.html", indexHtml]];
  let withAlign = 0;
  let centred = 0;
  for (const [name, src] of files) {
    for (const [tag] of src.matchAll(/<div class="modal-overlay[^"]*"[^>]*>/g)) {
      const align = /align-items:\s*([a-z-]+)/.exec(tag);
      if (!align) continue; // inherits the bottom-sheet default, which is fine
      withAlign++;
      if (align[1] === "center") centred++;
      assert.notEqual(
        align[1], "flex-start",
        `${name} has a dialog overlay pinned to the top of the viewport: ${tag.slice(0, 120)}`
        + " - reported live as \"the challenge window is too high\". Centre it, like the other six.",
      );
      assert.ok(["center", "stretch", "flex-end"].includes(align[1]),
        `${name}: unrecognised overlay alignment "${align[1]}" - centre (card), stretch (full-height sheet) `
        + "or flex-end (bottom sheet) are the three this app has a look for");
    }
  }
  // A guard that finds nothing passes. These two floors are what stop this
  // test from going green because a regex stopped matching - the failure mode
  // that has bitten this repo six times, most recently a backup verification
  // that grepped for a string pg_dump does not emit.
  assert.ok(withAlign >= 8, `expected to have parsed the overlay styles, saw only ${withAlign}`);
  assert.ok(centred >= 6, `expected most card dialogs to be centred, saw only ${centred}`);
});

test("no dispatch branch is unreachable behind an identical one above it", () => {
  // Found on 2026-09-17 while reading for something else: the challenge form's
  // "delete draft" button and the challenge view's "delete" button both fired
  // `challenge-delete`, and BOTH branches tested for it. The second could
  // never run. The visible result was a coach deleting an unpublished draft
  // being warned that every registration, team and progress entry would go
  // with it - a draft has none - and told to "end the challenge" instead,
  // which an unpublished challenge cannot do. The copy written for that exact
  // case sat three lines below, unreachable, for as long as it had existed.
  //
  // Nothing about this is specific to challenges: it is a long else-if chain
  // keyed on a string, which is what every action dispatch in this app is.
  const chains = [
    ["cloud.js", cloudJs, /else if \(action === "([a-z0-9-]+)"\)/g, 40],
    ["cloud.js", cloudJs, /else if \(c\.action === "([a-z0-9-]+)"\)/g, 4],
    ["app.js", appJs, /else if \(c\.action === "([a-z0-9-]+)"\)/g, 3],
  ];
  for (const [name, src, re, floor] of chains) {
    const seen = new Set();
    const dead = [];
    let parsed = 0;
    for (const [, action] of src.matchAll(re)) {
      parsed++;
      if (seen.has(action)) dead.push(action);
      seen.add(action);
    }
    // A guard that matched nothing would pass. Pin a floor per chain.
    assert.ok(parsed >= floor, `${name}: expected to parse at least ${floor} branches, parsed ${parsed}`);
    assert.deepEqual(dead, [], `${name}: these branches can never run - an identical test appears above them: ${dead.join(", ")}`);
  }
  // If a second, genuinely separate dispatcher ever needs a name this one
  // already uses, teach this test the pair. Do not delete the assertion.
});

