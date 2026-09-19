// GitHub Actions minutes are a metered, exhaustible resource here.
//
// The repository went private on 2026-09-17, which is the moment every job in
// .github/workflows/ started being billed, and the free monthly allowance ran
// out on 2026-09-19. Runs after that point do not fail on a test - they fail
// at "the job was not started", which looks like a broken build and is
// actually an empty wallet.
//
// Measured on run 35435484944, the last green run of test.yml before the
// quota went, billed per job at GitHub's one-minute rounding:
//
//   node-tests               27.2 min wall -> 28
//   browser-checks            3.4 min wall ->  4
//   migration-check           2.4 min wall ->  3
//   edge-function-lockfiles   0.3 min wall ->  1
//   edge-functions-deployed   0.2 min wall ->  1
//                                             --
//                                             37 billed minutes per run
//
// At 37 minutes a run, the trigger list is not a detail. `push:` with no
// branch filter plus `pull_request:` billed that twice for every push to a
// branch with an open PR, for two runs over nearly the same tree, and
// claude-review.yml re-ran its whole checklist on every `synchronize` on top
// of that.
//
// None of this is visible in a diff review: a workflow with a wrong trigger
// list is green, passes every other test in this directory, and costs the
// club money silently. Per CLAUDE.md - a rule worth keeping gets a
// deterministic guard rather than a louder comment - this file is that guard.
// It pins the SHAPE of the triggers, never a duration, so it cannot go red
// because a suite got slower.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workflowsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

// A workflow file is YAML and there is no YAML parser in this repository's
// dependencies (and no build step to add one to). These three helpers read the
// block structure off the indentation, which is enough for the `on:` mapping
// and is the same shape of reading test/workflow-action-pinning.test.mjs
// already does over `uses:` lines.
function lines(file) {
  return fs
    .readFileSync(path.join(workflowsDir, file), "utf8")
    .split("\n")
    .map((raw) => ({ indent: raw.search(/\S/), text: raw.trim(), raw }))
    // Comment-only and blank lines carry no structure; a comment is indented
    // to whatever reads well, so leaving them in would break the nesting.
    .filter((l) => l.indent >= 0 && !l.text.startsWith("#"));
}

// The lines nested under the first line matching `key` at depth `indent`.
function childrenOf(ls, key, indent) {
  const i = ls.findIndex((l) => l.indent === indent && l.text === key);
  assert.notEqual(i, -1, `expected a "${key}" key at indent ${indent}`);
  const out = [];
  for (let j = i + 1; j < ls.length; j++) {
    if (ls[j].indent <= indent) break;
    out.push(ls[j]);
  }
  return out;
}

// The `- "value"` items directly under `key`, as an array of strings.
function listUnder(ls, key, indent) {
  const kids = childrenOf(ls, key, indent);
  const itemIndent = kids.length ? kids[0].indent : 0;
  return kids
    .filter((l) => l.indent === itemIndent && l.text.startsWith("- "))
    .map((l) => l.text.slice(2).trim().replace(/^["']|["']$/g, ""));
}

test("test.yml runs on pull_request and on push to main only", () => {
  const ls = lines("test.yml");
  const on = childrenOf(ls, "on:", 0);
  const eventKeys = on.filter((l) => l.indent === 2).map((l) => l.text);
  assert.deepEqual(
    eventKeys.filter((k) => k.endsWith(":")).sort(),
    ["pull_request:", "push:"],
    "test.yml should be triggered by exactly pull_request and push - a third event is a third bill",
  );
  // A bare `push:` - no branch filter - is the expensive default this guard
  // exists to prevent: every push to every branch runs all five jobs, and on a
  // branch with an open PR that is a second full run of the same tree.
  const branches = on.filter((l) => l.indent === 4 && l.text.startsWith("branches:")).map((l) => l.text);
  assert.equal(branches.length, 1, "exactly one of the two events should filter by branch, and it is push");
  assert.match(
    branches[0],
    /^branches:\s*\[\s*main\s*\]$/,
    'push must be limited to main; the pull_request run already covers a PR branch (got "' + branches[0] + '")',
  );
});

// Every markdown file the suite actually opens, derived rather than listed:
// a fixture the workflow filter does not re-include is a fixture that can
// change with no test run and no red, which is the whole point of the check
// below. Reads are matched on the line that performs them, which covers every
// form in test/ today (`new URL("../PRIVACY.md", ...)` and
// `path.join(ROOT, "docs", "community", "contracts.md")` alike). A file name
// assembled at runtime would slip past this; none is today.
function markdownFixturesReadByTheSuite() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const found = new Set();
  for (const entry of fs.readdirSync(testDir)) {
    if (!entry.endsWith(".mjs")) continue;
    for (const line of fs.readFileSync(path.join(testDir, entry), "utf8").split("\n")) {
      if (!/\breadFile(?:Sync)?\s*\(/.test(line)) continue;
      for (const m of line.matchAll(/["'`]([^"'`]*\.md)["'`]/g)) found.add(path.basename(m[1]));
    }
  }
  return [...found].sort();
}

test("test.yml skips a documentation-only change, and both events skip the same paths", () => {
  const ls = lines("test.yml");
  const on = childrenOf(ls, "on:", 0);
  const push = childrenOf(on, "push:", 2);
  const pull = childrenOf(on, "pull_request:", 2);
  const pushPaths = listUnder(push, "paths:", 4);
  const pullPaths = listUnder(pull, "paths:", 4);
  // The twin check. GitHub Actions does not expand YAML anchors, so this list
  // is written out twice, and a path that skips a run on one event and not the
  // other is a filter that does nothing: the PR run still bills 37 minutes.
  // This is exactly the sibling drift CLAUDE.md names as this codebase's
  // characteristic defect, in the one place where it costs money.
  assert.deepEqual(
    pushPaths,
    pullPaths,
    "push and pull_request must filter on the SAME paths - one filtered event and one unfiltered is no filter at all",
  );
  assert.equal(pushPaths[0], "**", "the list must start by including everything; the negations below narrow it");
  for (const pattern of ["!docs/**", "!**/*.md"]) {
    assert.ok(
      pushPaths.includes(pattern),
      `paths must contain "${pattern}" - a documentation-only change should not bill 37 minutes`,
    );
  }
});

test("every markdown file the suite reads is re-included, so it cannot change untested", () => {
  const ls = lines("test.yml");
  const paths = listUnder(childrenOf(childrenOf(ls, "on:", 0), "pull_request:", 2), "paths:", 4);
  const lastNegation = Math.max(paths.indexOf("!docs/**"), paths.indexOf("!**/*.md"));
  const reincluded = paths
    .slice(lastNegation + 1)
    .filter((p) => !p.startsWith("!"))
    .map((p) => path.basename(p));
  const fixtures = markdownFixturesReadByTheSuite();
  assert.ok(fixtures.length > 0, "sanity check: the suite does read markdown fixtures");
  for (const fixture of fixtures) {
    assert.ok(
      reincluded.includes(fixture),
      `${fixture} is read by a test but is excluded by test.yml's path filter: an edit to it would skip CI entirely, and the red would surface on some later, unrelated PR. Add it to the paths list in BOTH events, after the negations.`,
    );
  }
});

test("test.yml cancels a superseded run rather than paying for an answer nobody reads", () => {
  const ls = lines("test.yml");
  const concurrency = childrenOf(ls, "concurrency:", 0);
  const group = concurrency.find((l) => l.text.startsWith("group:"));
  assert.ok(group, "test.yml needs a concurrency group");
  // Per branch. head_ref is the PR's own branch and is empty outside
  // pull_request, where ref is refs/heads/main.
  assert.match(group.text, /github\.head_ref/, "the concurrency group must key on the branch, via github.head_ref");
  assert.ok(
    concurrency.some((l) => l.text === "cancel-in-progress: true"),
    "cancel-in-progress must be true: a second push makes the first run's answer worthless before it finishes",
  );
});

test("claude-review.yml reviews on `opened`, not on every push", () => {
  const ls = lines("claude-review.yml");
  const on = childrenOf(ls, "on:", 0);
  const pr = childrenOf(on, "pull_request:", 2);
  const types = pr.find((l) => l.text.startsWith("types:"));
  assert.ok(types, "claude-review.yml's pull_request trigger must name its types explicitly");
  // An unfiltered `pull_request:` defaults to opened + synchronize +
  // reopened, so "no types" is the expensive case, not the neutral one.
  assert.doesNotMatch(
    types.text,
    /synchronize/,
    "`synchronize` re-runs the whole seven-point checklist on every push to an open PR; ask for a re-review with an @claude comment instead",
  );
  assert.match(types.text, /opened/, "a PR should still get one review when it is opened");
});

test("claude-review.yml keeps the @claude escape hatch that makes `opened`-only affordable", () => {
  const ls = lines("claude-review.yml");
  const on = childrenOf(ls, "on:", 0);
  const eventKeys = on.filter((l) => l.indent === 2 && l.text.endsWith(":")).map((l) => l.text);
  // Dropping `synchronize` is only reasonable because a human can still ask
  // for a review of the current diff at the moment it matters. Remove these
  // and the review becomes a thing that happened once, on the first commit of
  // the branch, and can never be repeated.
  for (const event of ["issue_comment:", "pull_request_review_comment:"]) {
    assert.ok(eventKeys.includes(event), `claude-review.yml must keep the ${event.slice(0, -1)} trigger`);
  }
});
