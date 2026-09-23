#!/usr/bin/env node
// Launch-readiness audit, DATABASE_AUDIT.md DB-M1.
//
// THE PROBLEM. Supabase tracks applied migrations by filename, not by
// content. Editing a migration file that has already run against a real
// project is therefore invisible: the local `supabase db reset` replays the
// EDITED file from empty and passes, while production still carries what
// the ORIGINAL file did. The two silently diverge, and nothing in CI can
// tell. The audit found four migrations that had been edited after being
// applied - one commit message for such an edit literally reads "broke a
// live migration run".
//
// THE RULE THIS ENFORCES. A migration file, once committed, is immutable.
// Corrections go in a NEW migration. This is the same rule the repo already
// follows by convention (see any of the `drop policy ... create policy`
// re-declarations); it just had nothing enforcing it.
//
// HOW. For every file in supabase/migrations/, compare the working-tree
// content against the content at the merge-base with the default branch.
// A file that existed there and differs now is a rewrite of applied
// history. A file that did not exist there is new, and is fine.
//
// AND every file that existed at the merge base must still exist. Comparing
// only the files present today cannot see a deletion - the file is not in the
// list to be compared - so a rename passed this check for as long as it had
// one. Deleting an applied migration is the worse half of the same bug: the
// schema_migrations row outlives the file that explains it.
//
// Two files sharing a version is a third way the ledger breaks, and it is
// checked separately by scripts/check-migration-versions.mjs, which needs no
// git history and therefore cannot skip itself.
//
// Deliberately compares against the MERGE BASE, not against HEAD~1: a
// feature branch that legitimately adds several migrations over several
// commits must not trip this on its own additions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS = path.join(root, "supabase", "migrations");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

// Pure, so node --test can exercise the rule without building a git history.
// Everything above and below this pair is I/O; this is the actual judgement.
export function findMissing(namesAtBase, namesNow) {
  const now = new Set(namesNow);
  return namesAtBase.filter((n) => !now.has(n));
}

// When a migration disappears, saying where it went turns "a migration
// vanished" into the one-line fact the author needs instead of a diff to go
// and read.
//
// ONLY A FILE THAT IS NEW CAN BE THE RENAME TARGET, and that restriction is
// the whole correctness of this function. Matching on "some other file has
// this version" is wrong precisely in the case that matters: during a version
// collision the twin sharing the version is a DIFFERENT, long-standing
// migration, and pointing at it would tell the author their file was renamed
// to somebody else's. Filtering to files absent from the merge base removes
// that class of wrong answer entirely.
//
// Suffix first (a renumbering keeps the descriptive name - #54's shape), then
// version (a re-description keeps the number). Ambiguity yields null: no hint
// is better than a confident wrong one.
export function renameHintFor(missingName, namesNow, namesAtBase = []) {
  const atBase = new Set(namesAtBase);
  const added = namesNow.filter((n) => n !== missingName && !atBase.has(n));
  const suffixOf = (s) => s.replace(/^\d+_/, "");

  const bySuffix = added.filter((n) => suffixOf(n) === suffixOf(missingName));
  if (bySuffix.length === 1) return bySuffix[0];

  const v = /^(\d+)_/.exec(missingName)?.[1];
  if (!v) return null;
  const byVersion = added.filter((n) => n.startsWith(`${v}_`));
  return byVersion.length === 1 ? byVersion[0] : null;
}

function resolveBase() {
  // The base branch this work will merge into. Falls back through the
  // common names so this runs both in CI and on a laptop.
  const candidates = [
    process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(Boolean);
  for (const ref of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch { /* try the next one */ }
  }
  return null;
}

// node --test imports this file for findMissing/renameHintFor; only walk the
// repository when it is the entry point. Same convention as
// check-migration-drift.mjs.
const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;

const base = isEntryPoint ? resolveBase() : null;
if (isEntryPoint && !base) {
  console.log("check-migration-immutability: no base branch found (shallow clone or a fresh repo) - skipping.");
  process.exit(0);
}
if (isEntryPoint) {

let mergeBase;
try {
  mergeBase = git(["merge-base", "HEAD", base]);
} catch {
  console.log(`check-migration-immutability: no merge base with ${base} - skipping.`);
  process.exit(0);
}

// Everything that was a migration at the merge base. Walking THIS rather than
// the working tree is what makes a deletion visible - see the block below.
const namesAtBase = git(["ls-tree", "--name-only", `${mergeBase}`, "supabase/migrations/"])
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.endsWith(".sql"))
  .map((l) => path.basename(l))
  .sort();

const violations = [];
for (const name of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  const rel = `supabase/migrations/${name}`;
  let committed;
  try {
    committed = execFileSync("git", ["show", `${mergeBase}:${rel}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    continue; // Not present at the merge base: a new migration. Fine.
  }
  const current = fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
  if (current !== committed) violations.push(rel);
}

// A MIGRATION THAT VANISHED, which the loop above structurally cannot see.
//
// It iterates the files PRESENT in the working tree, so a file that was
// deleted is not in the list and is never compared to anything. Renaming one
// is a delete plus an add: the new name is "not present at the merge base:
// fine", the old name is not iterated at all, and the whole thing passes.
//
// That is not hypothetical. #54 renamed 202609220007_an_announcement_... to
// 202609220008_... and this check printed OK. The rename was correct - that
// migration had never been applied - but the check had no opinion either way,
// which is the part worth fixing. Deleting an APPLIED migration is worse than
// editing one: production keeps the schema_migrations row forever, the file
// that explains it is gone, and `supabase db reset` rebuilds a local database
// that no longer matches the project it is meant to mirror.
const namesNow = new Set(fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")));
const missing = namesAtBase.filter((n) => !namesNow.has(n));

if (missing.length && process.env.ALLOW_MIGRATION_EDITS !== "1") {
  console.error("check-migration-immutability: FAILED\n");
  console.error("These migrations existed at the merge base and are now gone:\n");
  for (const m of missing) {
    const renamedTo = renameHintFor(m, [...namesNow], namesAtBase);
    console.error(`  - supabase/migrations/${m}${renamedTo ? `   (renamed to ${renamedTo}?)` : ""}`);
  }
  console.error(`
Supabase records an applied migration by version in
supabase_migrations.schema_migrations and never looks at the file again.
Deleting or renaming the file does not undo the migration: production keeps
the row and the schema it produced, while the repository no longer contains
the thing that produced it. A local \`supabase db reset\` then builds a
database that production does not match, and nothing reports a difference.

If the migration has genuinely never been applied anywhere - check with
\`supabase migration list --linked\` and look for a local version whose
remote column is empty - then removing or renumbering it is safe and is
sometimes the only fix, as it was for the duplicate 202609220007. Say so
explicitly in the PR and re-run with ALLOW_MIGRATION_EDITS=1.`);
  process.exit(1);
}

if (violations.length && process.env.ALLOW_MIGRATION_EDITS !== "1") {
  console.error("check-migration-immutability: FAILED\n");
  console.error("These migrations already existed at the merge base and have been edited:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`
Supabase tracks applied migrations by FILENAME, not content. A project that
already ran the original version will never run the edited one, so the local
database and production diverge silently and no test can see it.

Put the correction in a NEW migration instead. If this edit is genuinely
safe (a comment-only change, or a file that has demonstrably never been
applied anywhere), say so explicitly in the PR and re-run with
ALLOW_MIGRATION_EDITS=1.`);
  process.exit(1);
}

console.log(
  `check-migration-immutability: OK (${namesAtBase.length} migrations at the merge base, ` +
  `none edited, none missing; compared against ${base} at ${mergeBase.slice(0, 8)})`,
);
}
