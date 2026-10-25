// The eight named benchmarks exist in four places that must agree: the app's
// own list (BENCHMARK_WOD_IDS in app.js, the source), the check on
// clubs.benchmark, the check on benchmark_results.benchmark, and the list
// update_circle validates against. A fifth or a missing one in any copy is a
// pick the owner can make and a member cannot log, or the other way round.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");
const sql = fs.readFileSync(path.join(root, "supabase", "migrations", "202610250004_circle_lifecycle_rpcs.sql"), "utf8");

const fromApp = JSON.parse(appJs.match(/const BENCHMARK_WOD_IDS = (\[[^\]]+\]);/)[1]).sort();

test("the app names eight benchmarks", () => {
  assert.equal(fromApp.length, 8);
});

test("every SQL copy of the benchmark list equals the app's", () => {
  const lists = [...sql.matchAll(/in \(((?:'[a-z]+',\s*)+'[a-z]+')\)/g)]
    .map((m) => m[1].match(/[a-z]+/g).sort())
    .filter((l) => l.length === 8);
  // clubs check, benchmark_results check, update_circle
  assert.equal(lists.length, 3, "expected three copies of the list in the migration");
  for (const l of lists) assert.deepEqual(l, fromApp);
});
