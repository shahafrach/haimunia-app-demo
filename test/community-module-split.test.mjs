// The rules that make src/community/*.js work at all.
//
// cloud.js was one 22,370-line IIFE. It is now cloud.js plus fourteen
// per-feature files, and the thing holding them together is not a module
// system — it is the one global lexical environment that classic <script>
// tags share in a browser. Three properties keep that working, none of them
// obvious from reading any single file, and all three fail in ways that are
// either invisible under jsdom or only visible as a blank Community tab in
// production. So they are asserted here.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMUNITY_MODULES, COMMUNITY_FILES, communityFile } from "./helpers/community-src.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const sw = readFileSync(path.join(root, "sw.js"), "utf8");

test("there is more than one community module, so the rules below are actually being exercised", () => {
  assert.ok(COMMUNITY_MODULES.length >= 2, `expected the split modules, found ${COMMUNITY_MODULES.length}`);
});

// 1. ORDER. cloud.js builds some top-level `const`s at evaluation time out of
//    direct references to functions that live in the modules —
//    POST_CARD_RENDERERS is the clearest, mapping each post type to its
//    renderer. A function declaration is only available once its own script
//    has run, so a module loaded AFTER cloud.js leaves those unresolved and
//    the whole layer throws at load.
test("every community module loads before cloud.js", () => {
  const cloudAt = indexHtml.indexOf('<script defer src="./cloud.js"></script>');
  assert.ok(cloudAt > -1, "index.html must still load cloud.js as a deferred classic script");
  for (const rel of COMMUNITY_MODULES) {
    const at = indexHtml.indexOf(`<script defer src="./${rel}"></script>`);
    assert.ok(at > -1, `${rel} must be loaded by index.html as a deferred classic script`);
    assert.ok(at < cloudAt, `${rel} must load BEFORE cloud.js - cloud.js resolves module functions at evaluation time`);
  }
});

// 2. CLASSIC SCRIPTS, NOT MODULES, AND NO IIFE. Either one would cut these
//    files off from state, client, esc and rerender, which they reach as
//    plain identifiers because they used to share cloud.js's closure. There
//    is no bundler and no build step to paper over the difference.
test("every community module is a classic script: strict, no IIFE, no import/export", () => {
  for (const rel of COMMUNITY_MODULES) {
    const src = communityFile(rel);
    assert.match(src, /^"use strict";/, `${rel} must open with its own "use strict" - it is its own script`);
    assert.doesNotMatch(src, /^\s*(?:import|export)\s/m, `${rel} must not use ES module syntax - it is loaded as a classic <script>`);
    assert.doesNotMatch(src, /^\(function \(\) \{/m, `${rel} must not wrap itself in an IIFE - that would hide it from cloud.js and from its siblings`);
    // Top-level declarations must stay at two spaces of indent, the shape
    // they had inside cloud.js's old wrapper. Nothing depends on this at
    // runtime; the source-text tests that anchor on it do.
    assert.match(src, /^ {2}(?:async )?function [A-Za-z0-9_$]+\s*\(/m, `${rel} should carry top-level declarations at the layer's two-space indent`);
  }
});

// 3. NO REDECLARATION. All 1,100-odd names are global lexical bindings now.
//    Two `const`s of the same name at global scope is a SyntaxError that
//    takes down the later script entirely — and jsdom cannot see it, because
//    test/helpers/boot.mjs gives the layer one window.eval() with its own
//    scope. Only a real browser catches it, which is why it is pinned here
//    as well as in scripts/browser-check.
test("no two files in the global lexical scope declare the same top-level name", () => {
  // Top level is two spaces of indent in the community layer (it kept
  // cloud.js's old wrapper indentation) and zero in app.js and
  // src/constants.js. Matching either everywhere would read a function's own
  // locals as globals, which is how this test first "found" app.js's `cfg`.
  const declRe = (indent) => new RegExp(`^ {${indent}}(?:(?:async )?function|const|let|var) ([A-Za-z0-9_$]+)\\s*[=(]`);
  // app.js and src/constants.js are in the same scope and are NOT part of the
  // community layer; they are where the five real collisions were found when
  // cloud.js gave up its IIFE. esc, cssSel, cleanStr and bidiText are
  // declared `var` on both sides deliberately (var + var is legal, and both
  // bind the identical window.BoxLogSafe function), so they are the one
  // allowed overlap.
  const SHARED_VAR_ALIASES = new Set(["esc", "cssSel", "cleanStr", "bidiText"]);
  const files = [...COMMUNITY_FILES.map((f) => [f, 2]), ["app.js", 0], ["src/constants.js", 0]];
  const seen = new Map();
  for (const [rel, indent] of files) {
    const re = declRe(indent);
    const names = new Set();
    for (const line of readFileSync(path.join(root, rel), "utf8").split("\n")) {
      const m = line.match(re);
      if (m) names.add(m[1]);
    }
    for (const n of names) {
      if (SHARED_VAR_ALIASES.has(n)) continue;
      const first = seen.get(n);
      assert.ok(first === undefined,
        `"${n}" is declared at top level in both ${first} and ${rel}. Classic <script> tags share one global lexical environment, so that is a redeclaration SyntaxError in a browser - and jsdom will not show it to you.`);
      seen.set(n, rel);
    }
  }
});

// 4. PRECACHE. sw-precache.test.mjs already fails on a src/*.js file that is
//    in index.html and in neither list. This says the narrower thing the
//    community layer needs: optional, never required, so a miss degrades the
//    Community tab and never blocks install of the offline training log.
test("every community module is precached as OPTIONAL, beside cloud.js", () => {
  const required = sw.slice(sw.indexOf("const REQUIRED_ASSETS"), sw.indexOf("const OPTIONAL_ASSETS"));
  const optional = sw.slice(sw.indexOf("const OPTIONAL_ASSETS"), sw.indexOf("const ASSETS ="));
  for (const rel of COMMUNITY_MODULES) {
    assert.ok(!required.includes(`"./${rel}"`), `${rel} must not be in REQUIRED_ASSETS - app.js guards every community integration point`);
    assert.ok(optional.includes(`"./${rel}"`), `${rel} is loaded by index.html but missing from OPTIONAL_ASSETS`);
  }
});
