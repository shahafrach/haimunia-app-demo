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

const cloudJs = readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
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

test("every control on the roster row refreshes BOTH surfaces that render it", () => {
  // The two surfaces, and the single template that makes them siblings. If
  // one of them ever stops going through the shared template they are no
  // longer the same row and this whole guard needs rewriting, so assert it.
  const search = fnBody(cloudJs, "function renderMemberManagement()");
  const roster = fnBody(cloudJs, "function renderMemberRoster()");
  assert.match(search, /memberManagementRowHtml\(/, "the search panel renders the shared row");
  assert.match(roster, /memberManagementRowHtml\(/, "and so does the roster");

  // Every action the row can fire, read off the row itself.
  const rowHtml = fnBody(cloudJs, "function memberManagementRowHtml(m, opts)")
    + fnBody(cloudJs, "function memberRoleButtonsHtml(m, readOnly)");
  const actions = [...new Set([...rowHtml.matchAll(/data-community-action="([a-z-]+)"/g)].map((m) => m[1]))];
  // Four controls today. A floor, not an equality: adding a fifth should make
  // this file check the fifth, never make it fail for existing.
  assert.ok(actions.length >= 4, `expected the row to carry its controls, found ${actions.length}`);

  // Every one of them routes through askConfirm, so the handler is named on
  // the confirm dispatch rather than on the click. Build action -> handler
  // from the dispatch itself.
  const handlers = new Map(
    [...cloudJs.matchAll(/else if \(c\.action === "([a-z-]+)"\) (\w+)\(/g)].map((m) => [m[1], m[2]]),
  );

  // The one exemption, with the reason, because an unexplained allowlist is
  // how a guard quietly stops guarding. A password reset rotates a secret and
  // changes NOTHING the row renders - name, handle, role, join date, last
  // activity. Re-reading both surfaces for it would be two round trips to
  // redraw identical HTML.
  const changesNothingTheRowShows = new Set(["admin-reset-password"]);

  for (const action of actions) {
    if (changesNothingTheRowShows.has(action)) continue;
    const handler = handlers.get(action);
    assert.ok(handler, `${action} fires from the roster row and no confirm dispatch handles it`);
    const body = fnBody(cloudJs, `async function ${handler}(`);
    assert.match(
      body,
      /await refreshMemberSurfaces\(\)/,
      `${action} -> ${handler}() mutates a roster row and must refresh both surfaces, not one. `
      + "This is the exact shape of the 2026-09-16 bug: the RPC succeeds, the screen does not change.",
    );
  }
});

test("refreshMemberSurfaces re-reads both, and the roster half is conditional on purpose", () => {
  const body = fnBody(cloudJs, "async function refreshMemberSurfaces()");
  assert.match(body, /await searchMembers\(state\.members\.search\)/, "the admin-only search panel");
  assert.match(body, /if \(state\.admin\.roster\.loaded\) await loadRoster\(true\)/,
    "and the roster, but only when something has loaded it - an admin working purely from "
    + "search should pay for one round trip, not two");
});

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
  assert.ok(withAlign >= 20, `expected to have parsed the overlay styles, saw only ${withAlign}`);
  assert.ok(centred >= 15, `expected most card dialogs to be centred, saw only ${centred}`);
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
    ["cloud.js", cloudJs, /else if \(action === "([a-z0-9-]+)"\)/g, 200],
    ["cloud.js", cloudJs, /else if \(c\.action === "([a-z0-9-]+)"\)/g, 15],
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

test("deleting a draft says draft, and runs the one delete function", () => {
  const form = fnBody(cloudJs, "function renderChallengeForm()");
  assert.match(form, /data-community-action="challenge-delete-draft"/,
    "the draft button has its own action, so its own confirm copy is reachable");

  // Take the whole line: the payload is an object, so a [^}] capture stops
  // short of exactly the part worth asserting on.
  const branchAt = cloudJs.indexOf('else if (action === "challenge-delete-draft")');
  assert.ok(branchAt > -1, "the draft branch exists");
  const draftBranch = [null, cloudJs.slice(branchAt, cloudJs.indexOf("\n", branchAt))];
  assert.match(draftBranch[1], /title: "מחיקת טיוטה"/, "with the copy written for a draft");
  assert.ok(!/כל ההרשמות/.test(draftBranch[1]),
    "and not the permanent-deletion warning about registrations a draft does not have");
  assert.match(draftBranch[1], /action: "challenge-delete", payload: \{ id: el\.dataset\.id, draft: true \}/,
    "it runs the SAME delete as everything else - deleteChallenge is the superset, with the "
    + "permission check and the view/cache cleanup the draft-only copy never had");

  // One delete function, not two that drift.
  assert.ok(!/deleteChallengeDraft/.test(cloudJs), "the near-duplicate delete function is gone");
  assert.match(cloudJs, /async function deleteChallenge\(id, wasDraft\)/);
  assert.match(cloudJs, /setMessage\(wasDraft \? "הטיוטה נמחקה" : "האתגר נמחק"\)/,
    "the flag changes what the message calls the thing, and nothing else");
});

test("the challenge staff toolbar breaks 3 + 1 on purpose, not by wrapping", () => {
  const at = cloudJs.indexOf("const staffToolbar = (staff || pinBtn)");
  assert.ok(at > -1);
  const line = cloudJs.slice(at, cloudJs.indexOf("\n", at));
  // Two rows, and the destructive one is the second, fenced by the same
  // hairline the post menu uses. Four chips will not fit a 390px line, so the
  // only question was whether the break looked chosen.
  assert.ok(!/\$\{endBtn\}\$\{deleteBtn\}/.test(line), "מחיקה no longer trails סיום on the same row");
  assert.match(line, /\$\{deleteBtn \? `<div class="chip-row"[^`]*border-top:1px solid var\(--border\)/,
    "it gets its own row behind a separator");
  assert.match(line, /margin-bottom:\$\{deleteBtn \? "0" : "10px"\}/,
    "and the first row drops its bottom margin so the two read as one block");
  // The tempting wrong fix, pinned so nobody takes it: this string is shared
  // with the post menu and the event toolbar.
  const pinLabels = (cloudJs.match(/"הצמדה למעלה"|>הצמדה למעלה</g) || []).length;
  assert.ok(pinLabels >= 3, "הצמדה למעלה is still shared across surfaces - do not shorten it in one of them");
});
