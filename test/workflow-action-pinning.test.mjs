// Security hunt round 9: every `uses:` action in .github/workflows/ is
// meant to be pinned to a full 40-char commit SHA (with a `# vX.Y.Z`
// comment for a human to see what that SHA actually is), not a floating
// tag - a tag can be moved to point at different code with no commit in
// this repo to review, right underneath a CI job. An earlier launch-
// readiness audit found and fixed exactly this on test.yml's
// migration-check job (`supabase/setup-cli@v1` -> a pinned SHA), but the
// identical `@v1`/`version: latest` pattern was still live in
// deploy-edge-functions.yml - the higher-privilege of the two jobs, since
// it runs with a real SUPABASE_ACCESS_TOKEN against production Edge
// Functions rather than a throwaway local stack. Nothing caught that the
// fix never reached every workflow file, so this locks the convention in
// across all of them, not just the one job an earlier audit happened to
// look at.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workflowsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const workflowFiles = fs.readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("sanity check: at least one workflow file exists to check", () => {
  assert.ok(workflowFiles.length > 0, "expected .github/workflows/*.yml to exist");
});

for (const file of workflowFiles) {
  test(`every action in ${file} is pinned to a full commit SHA, not a floating tag`, () => {
    const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
    const usesLines = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(usesLines.length > 0, `sanity check: ${file} should reference at least one action`);
    for (const ref of usesLines) {
      // A local/composite action (./path) has no remote SHA to pin - not
      // what this check is about.
      if (ref.startsWith("./") || ref.startsWith(".\\")) continue;
      assert.match(
        ref,
        /^[^@]+@[0-9a-f]{40}$/,
        `${file}: "${ref}" must be pinned to a full 40-char commit SHA (owner/repo@<sha>), not a floating tag or "latest"`,
      );
    }
  });
}

// 2026-09-18. A pin is a version as well as a SHA, and the two artifact
// actions were pinned to majors that run on Node 20 - actions/upload-artifact
// v4.6.2 and actions/download-artifact v4.3.0 - so every backup run and every
// restore drill printed the runner's Node 20 deprecation warning. A warning
// nobody can fix is a warning everybody learns to scroll past, which is worth
// more than the warning itself on a workflow whose whole job is to be
// believed when it is red.
//
// The pinning check above cannot see this: a SHA is equally opaque whatever
// runtime it carries. So the version in the `# vX.Y.Z` comment - the thing a
// human reads and the thing a bump changes - is checked against the first
// release of each action that actually declares `runs.using: node24`.
//
// Each number below was read from that tag's own action.yml, by cloning the
// tag, not from a changelog: the majors that merely ADDED Node 24 support
// (upload-artifact v5, download-artifact v6) still default to node20 and are
// deliberately not enough here.
const FIRST_NODE24_RELEASE = {
  "actions/checkout": "5.0.0",
  "actions/setup-node": "5.0.0",
  "actions/upload-artifact": "6.0.0",
  "actions/download-artifact": "7.0.0",
  // setup-deno is the one where the line is not a major: 2.0.0 is node20 and
  // 2.0.5 is node24.
  "denoland/setup-deno": "2.0.5",
};
// A composite action is a list of steps the runner executes itself - it
// declares no Node runtime of its own, so there is nothing here to be
// deprecated. The steps INSIDE it are its author's problem, not a pin we
// control.
//
// 2026-09-19, consolidation. This list gained a second entry the day it
// shipped, and the way it happened is the point. This test and its
// FIRST_NODE24_RELEASE map arrived in PR #13; claude-review.yml, which uses
// anthropics/claude-code-action, arrived in PR #11. Both were green against
// main at 18c9172 because neither branch could see the other's file, they
// merged without a textual conflict, and main was red on the merge of the
// second - a new workflow is in scope for a test that walks the whole
// directory. If you add a workflow, run this file; if you add an action to
// this list, check every workflow, not the one you were looking at.
//
// anthropics/claude-code-action is composite: `runs.using: "composite"`, read
// from action.yml at the pinned SHA 4036a180 (v1.0.230) rather than from a
// changelog, the same way every number in FIRST_NODE24_RELEASE above was
// obtained. Its own inner steps pin oven-sh/setup-bun, which is upstream's
// pin to keep current, not ours.
const NO_NODE_RUNTIME = new Set([
  "supabase/setup-cli",
  "anthropics/claude-code-action",
]);

function semverAtLeast(actual, minimum) {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

for (const file of workflowFiles) {
  test(`every action in ${file} runs on a Node runtime GitHub has not deprecated`, () => {
    const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
    const lines = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s]+)@[0-9a-f]{40}\s*#\s*v?(\d+\.\d+\.\d+)/gm)];
    const bare = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s.][^@\s]*)@/gm)].map((m) => m[1]);
    assert.equal(lines.length, bare.length,
      `${file}: every pinned action must carry a "# vX.Y.Z" comment saying which version the SHA is - without it neither a human nor this test can tell`);
    for (const [, action, version] of lines) {
      if (NO_NODE_RUNTIME.has(action)) continue;
      const minimum = FIRST_NODE24_RELEASE[action];
      assert.ok(minimum,
        `${file}: "${action}" is not in FIRST_NODE24_RELEASE. Read its action.yml at the pinned tag, add the first version whose runs.using is node24, and pin at least that - or add it to NO_NODE_RUNTIME if it is a composite action`);
      assert.ok(semverAtLeast(version, minimum),
        `${file}: "${action}" is pinned to v${version}, which runs on Node 20 and makes every run of this workflow print a deprecation warning. v${minimum} is the first release that runs on Node 24`);
    }
  });
}
