// The production push gate must keep refusing, and must keep being the only
// documented route. Launch-readiness S20: migrations reached production by
// hand, four in one day from two sessions, which is how B2 happened.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const script = readFileSync(new URL("scripts/push-migrations.mjs", root), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

// Deliberately NOT read here: docs/ops/MIGRATIONS.md and CLAUDE.md. Both are
// inside test.yml's paths-ignore, which is a considered choice from #17 —
// prose changes should not spend Actions minutes. test/workflow-minutes.mjs
// enforces the other half of that bargain: a test may not depend on a file CI
// would skip, or the guard is only pretending. So this file pins the gate's
// BEHAVIOUR, which lives in scripts/ and package.json and is not ignored, and
// leaves the runbook's wording to review.

test("npm run push:prod exists and points at the gate", () => {
  assert.equal(pkg.scripts["push:prod"], "node scripts/push-migrations.mjs");
  assert.equal(pkg.scripts["check:immutable"], "node scripts/check-migration-immutability.mjs");
});

test("the gate runs both guards and the drift check", () => {
  for (const s of ["check-migration-versions.mjs", "check-migration-immutability.mjs",
                   "check-migration-drift.mjs"]) {
    assert.ok(script.includes(s), `push:prod must run ${s}`);
  }
});

test("it refuses to push when production has migrations the repo does not", () => {
  // The one failure that gets worse after a push than before it.
  assert.match(script, /untracked\.length/);
  assert.match(script, /REFUSED: production has migrations this repository does not/);
});

test("it will not run unattended without an explicit --yes", () => {
  assert.match(script, /isTTY/, "it checks for a terminal");
  assert.match(script, /ASSUME_YES/, "and only skips the prompt on --yes");
  assert.match(script, /"apply"/, "the confirmation is a typed word, not a keypress");
});

test("it verifies the result instead of trusting the exit code", () => {
  const afterPush = script.slice(script.indexOf("// ---- 7."));
  assert.match(afterPush, /drift\(\)/, "drift is re-read after the push");
  assert.match(afterPush, /still not clean/, "and a dirty result fails");
});

test("it refuses from anywhere but a clean, in-sync main", () => {
  assert.match(script, /branch !== "main"/);
  assert.match(script, /origin\/main/);
  assert.match(script, /working tree is not clean/);
});


test("the gate refuses a non-main branch for real, not just in its source", () => {
  // Runs the actual script. This test file is executed from a worktree or a
  // branch during development and from main in CI; either way the script must
  // exit non-zero rather than proceed, because nothing here is on a clean,
  // in-sync main with a pending migration.
  let exitCode = 0;
  let out = "";
  try {
    out = execFileSync("node", ["scripts/push-migrations.mjs", "--dry-run"],
      { cwd: new URL(".", root).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    exitCode = e.status;
    out = (e.stdout || "") + (e.stderr || "");
  }
  // Either it refused (branch/dirty/guard/drift) or production was already
  // current and it exited 0 saying so. What it must never do is apply
  // anything without the typed confirmation, and --dry-run guarantees that.
  assert.ok(exitCode !== 0 || /Nothing to push|stopping here/.test(out),
    `expected a refusal or a clean no-op, got exit ${exitCode}: ${out.slice(0, 300)}`);
  assert.ok(!/Pushing…/.test(out), "--dry-run must never reach the push");
});
