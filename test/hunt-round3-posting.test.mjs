// Live bug hunt, fresh round 3 (2026-09-15) — posting and engagement.
//
// Two product defects and one harness defect that had quietly made an entire
// area impossible to test in a browser.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const mockJs = fs.readFileSync(new URL("./helpers/mockSupabase.mjs", import.meta.url), "utf8");




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
