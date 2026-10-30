// The Actions minutes guards.
//
// This repository went private on 2026-09-17 and exhausted the free Actions
// allowance on 2026-09-19. One full run of test.yml bills 37 minutes, so the
// triggers are now load-bearing in a way they were not when runs were free,
// and three of them are the kind of thing that silently reverts:
//
//   * `push:` with no branch filter, which ran the whole suite TWICE for every
//     push to a PR branch - once for push, once for pull_request, in two
//     different concurrency groups so neither cancelled the other.
//   * a paths-ignore list that skips CI for documentation, which is only safe
//     while none of the skipped files is one the suite asserts on. Six
//     markdown files ARE, three of them under docs/.
//   * that same list, duplicated under both triggers because GitHub Actions
//     has no YAML anchors.
//
// The middle one is the reason this file exists. The other two are cheap to
// pin while we are here.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, "test");
const testYml = fs.readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8");
const reviewYml = fs.readFileSync(path.join(root, ".github/workflows/claude-review.yml"), "utf8");

// ---------------------------------------------------------------------------
// Enough YAML to read one workflow's triggers. No parser dependency: this repo
// has no yaml package and test/workflow-action-pinning.test.mjs already reads
// workflows with regexes for the same reason.
// ---------------------------------------------------------------------------

/** The `paths-ignore:` list nested under `on: <trigger>:`, or null if absent. */
function pathsIgnoreFor(yml, trigger) {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l === `  ${trigger}:`);
  if (at < 0) return null;
  const key = lines.findIndex((l, i) => i > at && l === "    paths-ignore:");
  // Stop at the next trigger or top-level key, so a missing paths-ignore under
  // this trigger cannot silently borrow the next one's.
  const end = lines.findIndex((l, i) => i > at && /^ {0,2}\S/.test(l));
  if (key < 0 || (end > -1 && key > end)) return null;
  const out = [];
  for (let i = key + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {6}- '([^']+)'$/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** The `types: [...]` list nested under `on: <trigger>:`. */
function typesFor(yml, trigger) {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l === `  ${trigger}:`);
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) break;
    const m = lines[i].match(/^ {4}types:\s*\[([^\]]*)\]/);
    if (m) return m[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

/** Minimal Actions path filter: `**` crosses `/`, `*` does not, rest literal. */
function globMatches(pattern, filePath) {
  const rx = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${rx}$`).test(filePath);
}

// ---------------------------------------------------------------------------
// Every markdown file the suite actually reads, derived from test/*.mjs rather
// than listed here - a list would be one more thing to forget to update.
// ---------------------------------------------------------------------------
function markdownFilesTheSuiteReads() {
  const found = new Map(); // repo-relative path -> the test files that read it
  for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(testDir, file), "utf8");
    // Every readFileSync(...) call's argument list, then every quoted string in
    // it. path.join(ROOT, "docs", "community", "contracts.md") arrives as four
    // separate literals, so they are re-joined; new URL("../PRIVACY.md", ...)
    // arrives as one.
    for (const call of src.matchAll(/readFileSync\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
      const literals = [...call[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
      const mdAt = literals.findIndex((s) => s.endsWith(".md"));
      if (mdAt < 0) continue;
      const rel = path.posix.normalize(literals.slice(0, mdAt + 1).join("/").replace(/^\.\.\//, ""));
      if (!fs.existsSync(path.join(root, rel))) {
        assert.fail(`${file} reads a markdown path this test could not resolve to a real file: "${rel}". ` +
          `Fix the resolution here rather than dropping it - an unresolved read is an unguarded one.`);
      }
      found.set(rel, (found.get(rel) || []).concat(file));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------

test("test.yml runs on pull_request and on push to main only, so one push is one run", () => {
  const on = testYml.slice(testYml.indexOf("\non:"), testYml.indexOf("\npermissions:"));
  assert.match(on, /^ {2}push:$/m, "test.yml must still run on push");
  assert.match(on, /^ {4}branches: \[main\]$/m,
    "push must be limited to main - an unqualified push: runs the whole 37-minute suite a second time for every push to a PR branch");
  assert.match(on, /^ {2}pull_request:$/m, "test.yml must still run on pull_request");
});

test("test.yml cancels a superseded run, grouped per branch", () => {
  const block = testYml.slice(testYml.indexOf("\nconcurrency:"), testYml.indexOf("\njobs:"));
  assert.match(block, /cancel-in-progress: true/,
    "a push that supersedes a running build must cancel it, not pay for both");
  assert.match(block, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.head_ref \|\| github\.ref \}\}/,
    "group on head_ref so a PR's successive pushes share one group; github.ref alone is refs/pull/N/merge and groups with nothing else");
});

test("both triggers carry the same paths-ignore list", () => {
  const push = pathsIgnoreFor(testYml, "push");
  const pr = pathsIgnoreFor(testYml, "pull_request");
  assert.ok(push && push.length, "the push trigger must have a paths-ignore list");
  assert.ok(pr && pr.length, "the pull_request trigger must have a paths-ignore list");
  // GitHub Actions has no YAML anchors, so this really is two copies. Two
  // copies of one rule is this codebase's characteristic defect; this is the
  // guard for it.
  assert.deepEqual(push, pr,
    "the two paths-ignore lists have drifted - a path ignored on one trigger and not the other means CI skips or runs depending on how the commit arrived");
});

test("no markdown file the suite asserts on is inside paths-ignore", () => {
  // THE LOAD-BEARING ONE. Skipping CI for documentation is only safe while the
  // skipped documentation is documentation. Six markdown files are read and
  // asserted on - PRIVACY.md, TERMS.md, README.md and three under
  // docs/community/ - and ignoring any of them would let an edit that
  // contradicts the code merge with its own guard never running.
  const ignore = pathsIgnoreFor(testYml, "pull_request");
  const reads = markdownFilesTheSuiteReads();
  assert.ok(reads.size >= 6, `expected the suite to still read several markdown files, found ${reads.size}`);
  for (const [rel, readers] of reads) {
    for (const pattern of ignore) {
      assert.ok(!globMatches(pattern, rel),
        `paths-ignore entry '${pattern}' matches ${rel}, which ${readers.join(" and ")} read and assert on. ` +
        `CI would skip for a change to it. Either narrow the pattern or stop asserting on that file.`);
    }
  }
});

test("every paths-ignore entry matches something that exists, so a typo cannot quietly protect nothing", () => {
  const ignore = pathsIgnoreFor(testYml, "pull_request");
  const tracked = [];
  (function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else tracked.push(rel);
    }
  })(root, "");
  for (const pattern of ignore) {
    assert.ok(tracked.some((f) => globMatches(pattern, f)),
      `paths-ignore entry '${pattern}' matches no file in the repository - a typo here silently ignores nothing`);
  }
});

test("claude-review runs when a PR is opened and on @claude, not on every push", () => {
  const types = typesFor(reviewYml, "pull_request");
  assert.deepEqual(types, ["opened"],
    "a review per push is a runner per push for a diff the reviewer has mostly already read; ask with @claude instead");
  // The mention handlers are the other half of the bargain and must stay.
  assert.match(reviewYml, /^ {2}issue_comment:$/m, "the conversation-tab @claude handler must stay");
  assert.match(reviewYml, /^ {2}pull_request_review_comment:$/m, "the pinned-to-a-line @claude handler must stay");
  assert.match(reviewYml, /contains\(github\.event\.comment\.body, '@claude'\)/,
    "a comment must still have to say @claude to start a runner");
});

// ---------------------------------------------------------------------------
// e2e.yml boots Docker and a Supabase stack. It must not run on every PR.
// ---------------------------------------------------------------------------
test("e2e.yml runs only when its tests, itself or the schema change, and on demand", () => {
  const e2eYml = fs.readFileSync(path.join(root, ".github/workflows/e2e.yml"), "utf8");
  assert.match(e2eYml, /^ {2}workflow_dispatch: \{\}$/m, "e2e.yml must be runnable on demand");
  assert.doesNotMatch(e2eYml, /^ {2}push:/m, "e2e.yml must not run on push");
  const at = e2eYml.indexOf("\n  pull_request:");
  const paths = [...e2eYml.slice(at, e2eYml.indexOf("\npermissions:")).matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
  assert.deepEqual(paths, ["scripts/e2e/**", "supabase/migrations/**", ".github/workflows/e2e.yml"],
    "e2e.yml's pull_request paths changed - widening them runs Docker and Supabase on most PRs");
  const minutes = Number((e2eYml.match(/timeout-minutes: (\d+)/) || [])[1]);
  assert.ok(minutes > 0 && minutes <= 30, `e2e.yml's timeout is ${minutes} minutes; keep it at 30 or less`);
});
