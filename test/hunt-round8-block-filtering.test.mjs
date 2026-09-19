// Live bug hunt, fresh round 8 (2026-09-15) — and the bug it fixes was
// committed by round 7's own fix to the same problem.
//
// block() purges the member-row caches it knows about. Round 7 widened that
// from one cache to three and left a comment saying "EVERY surface that
// renders a member row, not just the search array". Two more surfaces went on
// rendering a blocked member with live "פרופיל" and "מעקב" buttons for the
// rest of the session - the people-you-may-know strip and the
// trained-with-you-today card - because both load once and are never
// invalidated.
//
// The block confirmation promises "לא תראו זה את זה בקהילה". Two of the app's
// own surfaces did not honour it.
//
// Enumerating caches is what produced this twice. Reactors, comments,
// mentions and mention-search already filter with isBlockedUser() AT RENDER
// TIME, which is the pattern that cannot rot.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();

test("every member list is filtered when it renders, not when a block happens", () => {
  const at = cloudJs.indexOf("function blockFilteredList(slice)");
  assert.ok(at > -1, "there is one shared render-time filter");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /slice\.items\.filter\(\(m\) => !m \|\| !isBlockedUser\(m\.id \|\| m\.user_id\)\)/,
    "it drops blocked members, keyed on either id shape these rows use");
  // Must not mutate the cache: an unblock has to bring the rows straight back
  // without a reload.
  assert.match(body, /Object\.assign\(\{\}, slice, \{ items: kept \}\)/,
    "a shallow copy, so the cached list itself is untouched");
  assert.match(body, /kept\.length === slice\.items\.length \? slice :/,
    "and the original object is returned unchanged when nothing was filtered");
});

test("the two surfaces that ignored a block now use it", () => {
  assert.match(cloudJs, /const s = blockFilteredList\(state\.members\.suggestions\);/,
    "people you may know");
  assert.match(cloudJs, /const s = blockFilteredList\(state\.members\.classmatesToday\);/,
    "trained with you today");
});

test("the coach's new-member list is filtered too", () => {
  // A staff surface over the same rows: a coach who blocked someone should
  // not be handed them as a task to work through.
  assert.match(cloudJs, /\(state\.club\.newMembers \|\| \[\]\)\.filter\(\(m\) => !m \|\| !isBlockedUser\(m\.id \|\| m\.user_id\)\)/,
    "the coach board's new-member list respects a block");
});

test("the surfaces that were already right keep filtering at render time", () => {
  // These are the precedent the fix follows; if any of them regressed to
  // cache-purging the lesson would be lost.
  assert.match(cloudJs, /const reactors = \(rs\.list \|\| \[\]\)\.filter\(\(r\) => !isBlockedUser\(r\.id\)\);/, "reactors");
  assert.match(cloudJs, /if \(isBlockedUser\(c\.author_id\)\) return commentPlaceholder/, "comments");
  assert.match(cloudJs, /results = \(data \|\| \[\]\)\.filter\(\(p\) => !isBlockedUser\(p\.id\)\);/, "mention search");
});
