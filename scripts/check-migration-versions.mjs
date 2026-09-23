#!/usr/bin/env node
// Two migrations must not share a version.
//
// THE FAILURE THIS EXISTS FOR, which happened on 2026-09-23. Two branches
// each added a migration numbered 202609220007:
//
//   202609220007_only_the_technical_account_is_hidden.sql   (#51)
//   202609220007_an_announcement_becomes_its_feed_card.sql  (#49)
//
// Neither branch touched the other's file, so git merged them silently and
// both landed on main. Supabase keys supabase_migrations.schema_migrations on
// the VERSION alone - the digits before the first underscore, not the whole
// filename - so the two cannot both be recorded.
//
// What that cost, in the order it was discovered:
//
//   1. Production applied whichever arrived first and recorded 202609220007.
//      `supabase db push` then treated the OTHER file as already applied and
//      skipped it, with no error and no failed job. The announcements
//      feed-card trigger was absent from production for four days while the
//      repository said it was there, and `check:drift` compared versions, so
//      it reported clean throughout.
//   2. `supabase db reset --local` died on the second file with
//      `duplicate key value violates unique constraint
//      "schema_migrations_pkey", Key (version)=(202609220007) already exists`,
//      which blocked every branch that tried to test a migration chain.
//
// The local failure is loud and the production one is silent, which is the
// wrong way round: the silent one is the one that reaches members.
//
// TWO HALVES, AND THE ORDER MATTERS.
//
//   1. The directory scan. Needs nothing but readdir, so it always runs and
//      can never skip itself into a false green.
//   2. The incoming check. Needs git, and compares what this branch added
//      against what the base branch added since they diverged - the case
//      where the collision does not exist yet on either side and is created
//      by the merge. It degrades to a printed "skipped" line on a shallow
//      clone rather than failing, which is safe because half 1 already ran.
//
// WHY A SEPARATE FILE FROM check-migration-immutability.mjs. That file is
// about a migration's CONTENT and existence - edited, deleted, renamed. This
// one is about the version namespace. They fail for different reasons and a
// reader chasing one should not have to read the other.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS = path.join(root, "supabase", "migrations");

// The version is the leading digit run, exactly as the Supabase CLI parses it:
// everything before the first underscore. `202609220007_a_name.sql` ->
// `202609220007`. A file that does not start with digits has no version and is
// not something this check can reason about, so it is reported separately
// rather than silently grouped under "".
export function versionOf(filename) {
  const m = /^(\d+)_/.exec(filename);
  return m ? m[1] : null;
}

export function findCollisions(filenames) {
  const byVersion = new Map();
  const unversioned = [];
  for (const name of filenames.filter((f) => f.endsWith(".sql")).sort()) {
    const v = versionOf(name);
    if (v === null) {
      unversioned.push(name);
      continue;
    }
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(name);
  }
  const collisions = [];
  for (const [version, names] of byVersion) {
    if (names.length > 1) collisions.push({ version, names });
  }
  collisions.sort((a, b) => a.version.localeCompare(b.version));
  return { collisions, unversioned, total: byVersion.size };
}

// A COLLISION THAT DOES NOT EXIST YET, which the directory scan above
// structurally cannot see.
//
// PR #57 is the specimen. main carries 202609230001_module_switches_... (from
// #53). The branch adds 202609230001_deletion_reaches_photos_... and does not
// yet contain main's file. So on the branch the version appears exactly ONCE,
// findCollisions passes, CI is green - and the collision is created by the
// merge, where no check runs at all. That is the same silent path that let
// 202609220007 reach production: two branches, no common line, git merges them
// without a conflict.
//
// COMPARED AGAINST THE BASE TIP, NOT THE MERGE BASE. The merge base is the
// common ancestor, and main's colliding file arrived AFTER it - that is the
// whole point. What matters is what each side ADDED since they diverged:
//
//   addedHere    files in the working tree that are not at the merge base
//   addedOnBase  files on the base branch tip that are not at the merge base
//
// A version in both, under different filenames, collides the moment the two
// are merged. A legitimate renumbering (#54) adds a version nobody else added,
// so it stays clean here.
export function findIncomingCollisions(addedHere, addedOnBase) {
  const versions = (names) => {
    const m = new Map();
    for (const n of names.filter((f) => f.endsWith(".sql"))) {
      const v = versionOf(n);
      if (v === null) continue;
      if (!m.has(v)) m.set(v, []);
      m.get(v).push(n);
    }
    return m;
  };
  const here = versions(addedHere);
  const there = versions(addedOnBase);
  const incoming = [];
  for (const [version, mine] of here) {
    const theirs = there.get(version);
    if (!theirs) continue;
    const distinct = theirs.filter((t) => !mine.includes(t));
    if (distinct.length) incoming.push({ version, mine: [...mine].sort(), theirs: distinct.sort() });
  }
  incoming.sort((a, b) => a.version.localeCompare(b.version));
  return incoming;
}

export function reportIncoming(incoming, baseRef) {
  if (!incoming.length) return { ok: true, lines: [] };
  const lines = ["check-migration-versions: FAILED\n"];
  lines.push(`This branch adds a migration version that ${baseRef} has already used.`);
  lines.push("Nothing is red on the branch alone - the collision is created by the merge:\n");
  for (const { version, mine, theirs } of incoming) {
    lines.push(`  ${version}`);
    for (const n of mine) lines.push(`    this branch  ${n}`);
    for (const n of theirs) lines.push(`    ${baseRef.padEnd(11)}  ${n}`);
  }
  lines.push(`
Merging these produces two files on one version, which Supabase cannot record:
\`supabase db reset\` dies on a duplicate schema_migrations_pkey, and against a
real project \`db push\` silently skips whichever arrives second.

Renumber THIS branch's migration - it is the one that has not been applied
anywhere. Pick a version above everything on ${baseRef}, update the branch from
${baseRef}, and re-run.`);
  return { ok: false, lines };
}

export function report({ collisions, unversioned, total }) {
  const lines = [];
  if (!collisions.length && !unversioned.length) {
    lines.push(`check-migration-versions: OK (${total} migrations, every version distinct)`);
    return { ok: true, lines };
  }
  if (collisions.length) {
    lines.push("check-migration-versions: FAILED\n");
    lines.push("These migrations share a version. Supabase records applied migrations by");
    lines.push("version alone, so only ONE of each group can ever be applied:\n");
    for (const { version, names } of collisions) {
      lines.push(`  ${version}`);
      for (const n of names) lines.push(`    - ${n}`);
    }
    lines.push(`
Locally this fails loudly - \`supabase db reset\` dies with a duplicate key on
schema_migrations_pkey. Against a real project it fails SILENTLY: whichever
file was applied first owns the version, \`supabase db push\` skips the rest,
and no error is raised. The unapplied one is then absent from production while
the repository says it is there.

Renumber the migration that has NOT been applied anywhere. Check with
\`supabase migration list --linked\` - a row with a local version and an empty
remote is the one that is safe to move. Never renumber one that is already
applied: production keeps the old row and the file stops matching it.`);
  }
  if (unversioned.length) {
    if (collisions.length) lines.push("");
    lines.push("These files are in supabase/migrations/ but do not start with a version:\n");
    for (const n of unversioned) lines.push(`    - ${n}`);
    lines.push("\nThe CLI will not apply them. Rename them `<version>_<name>.sql` or move them out.");
  }
  return { ok: false, lines };
}

// git, only for the incoming-collision half. The directory scan above needs
// none and therefore always runs: if this half has to skip itself on a shallow
// clone, the check still measured something rather than reporting a false
// green.
function gitLines(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".sql")).map((l) => path.basename(l));
}

function incomingCheck() {
  const candidates = [
    process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main", "origin/master", "main", "master",
  ].filter(Boolean);
  let baseRef = null;
  for (const ref of candidates) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        { cwd: root, stdio: "ignore" });
      baseRef = ref;
      break;
    } catch { /* try the next */ }
  }
  if (!baseRef) return { ok: true, lines: ["  (no base branch: skipped the incoming-collision half)"] };

  let mergeBase;
  try {
    mergeBase = execFileSync("git", ["merge-base", "HEAD", baseRef],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return { ok: true, lines: [`  (no merge base with ${baseRef}: skipped the incoming-collision half)`] };
  }

  const atBase = new Set(gitLines(["ls-tree", "--name-only", mergeBase, "supabase/migrations/"]));
  const onBaseTip = gitLines(["ls-tree", "--name-only", baseRef, "supabase/migrations/"]);
  const here = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));

  const addedHere = here.filter((n) => !atBase.has(n));
  const addedOnBase = onBaseTip.filter((n) => !atBase.has(n));
  const r = reportIncoming(findIncomingCollisions(addedHere, addedOnBase), baseRef);
  if (!r.ok) return r;
  return { ok: true, lines: [`  (no incoming collision with ${baseRef}: ${addedHere.length} added here, ${addedOnBase.length} added there)`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const first = report(findCollisions(fs.readdirSync(MIGRATIONS)));
  if (!first.ok) {
    console.error(first.lines.join("\n"));
    process.exit(1);
  }
  const second = incomingCheck();
  if (!second.ok) {
    console.error(second.lines.join("\n"));
    process.exit(1);
  }
  console.log([...first.lines, ...second.lines].join("\n"));
  process.exit(0);
}
