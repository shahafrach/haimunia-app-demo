// Audit L3 (2026-11): a PR post printed its date as the raw ISO day
// ("2026-11-02") while every other post card says "2.11.2026". The row now
// goes through cloud.js's shortHebDate, the one read-only date label.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

test("the PR post's date row uses the shared date formatter", () => {
  const src = fs.readFileSync(new URL("../src/community/posts.js", import.meta.url), "utf8");
  const row = src.split("\n").find((l) => l.includes('["תאריך"'));
  assert.ok(row, "the date row exists");
  assert.match(row, /shortHebDate\(/);
});
