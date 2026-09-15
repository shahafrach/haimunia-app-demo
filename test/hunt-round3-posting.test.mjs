// Live bug hunt, fresh round 3 (2026-09-15) — posting and engagement.
//
// Two product defects and one harness defect that had quietly made an entire
// area impossible to test in a browser.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const mockJs = fs.readFileSync(new URL("./helpers/mockSupabase.mjs", import.meta.url), "utf8");

test("editing a comment never shows the member a stored mention marker", () => {
  // A comment is STORED as "@[רון כהן](2222...-222222222222)" and RENDERED
  // with the markers stripped. The edit box was seeded from the raw stored
  // body, so tapping "עריכה" on a comment that mentioned anyone put bracket
  // syntax with a stranger's account id in the middle of the member's own
  // sentence - and editing near those characters mangles the marker, with
  // nothing to repair it.
  const at = cloudJs.indexOf("function startCommentEdit(");
  assert.ok(at > -1, "startCommentEdit exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /body: commentBodyForEditing\(raw\)/, "the box shows the friendly form");
  assert.match(body, /mentionMap: commentMentionMap\(raw\)/, "and the name->id pairs travel with the draft");
  assert.ok(!/body: String\(c\.body \|\| ""\)/.test(body), "the raw stored body must not be seeded any more");
});

test("a mention left alone survives an edit, rebuilt from the map", () => {
  // resolveCommentMentions() cannot rebuild markers - it only ever DOWNGRADES
  // one to plain text when a mention is not permitted - so without the map an
  // edited comment would silently lose every mention it had.
  const at = cloudJs.indexOf("function reEncodeCommentMentions(");
  assert.ok(at > -1, "there is a re-encode step");
  assert.match(cloudJs, /resolveCommentMentions\(reEncodeCommentMentions\(body, e\.mentionMap\)\)/,
    "the save path re-encodes before resolving");
  // Longest name first, or "רון" would eat the prefix of "רון כהן".
  const mapFn = cloudJs.slice(cloudJs.indexOf("function commentMentionMap("), cloudJs.indexOf("function commentBodyForEditing("));
  assert.match(mapFn, /sort\(\(a, b\) => b\.name\.length - a\.name\.length\)/,
    "longer names are re-encoded first so a shorter one cannot eat their prefix");
});

test("a text-only post cannot be saved empty, and the button says so first", () => {
  // The server refuses it (202609060007), so today this costs a failed round
  // trip rather than content. But this repo's own history includes production
  // running twenty migrations behind the code, and a guard that lives only in
  // a migration can be absent in production. Every sibling editor already
  // checks locally; this was the one that did not.
  const at = cloudJs.indexOf("function captionSaveBlocked()");
  assert.ok(at > -1, "the panel can tell when saving is pointless");
  const blocked = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(blocked, /!cleanPostBody\(e\.body\) && !hasPhoto/, "empty text AND no photo blocks it");
  assert.match(cloudJs, /data-community-action="caption-save"\$\{captionSaveBlocked\(\) \? " disabled" : ""\}/,
    "the save button is disabled rather than looking available and failing");
  const save = cloudJs.slice(cloudJs.indexOf("async function postSaveCaption()"), cloudJs.indexOf("async function postSaveCaption()") + 1600);
  assert.match(save, /if \(!body && !hasPhoto\)/, "and the handler refuses it even if the button is bypassed");
  assert.match(save, /אי אפשר לשמור פוסט ריק/, "with a reason the member can read");
});

test("the feed-pagination mock works in a real browser, not only in Node", () => {
  // HARNESS DEFECT. mockSupabase.mjs is injected verbatim into a real Chromium
  // page by scripts/browser-check/lib/mockCloud.mjs, where Buffer does not
  // exist - so the instant a scenario paged past the feed's first 20 items the
  // mock threw "ReferenceError: Buffer is not defined". No browser scenario
  // exercises feed-load-more, which is consistent with that: it would have hit
  // this immediately. The area was not merely uncovered, it was impossible to
  // cover.
  assert.ok(!/Buffer\.from\(/.test(mockJs),
    "Buffer is a Node global and this file runs in a browser too");
  assert.match(mockJs, /btoa\(unescape\(encodeURIComponent\(/, "encodes with browser primitives");
  assert.match(mockJs, /decodeURIComponent\(escape\(atob\(/, "and decodes with them");
});
