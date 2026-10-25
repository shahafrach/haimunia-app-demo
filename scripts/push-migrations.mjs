#!/usr/bin/env node
// The only way a migration should reach production while there is no CI.
//
// WHY THIS EXISTS. Launch-readiness S20: migrations are applied to production
// by hand, with no gate. That is how B2 happened — six migrations the client
// already called had never been applied, and nobody knew because nothing
// checked. On 2026-09-23 four more went in by hand, from two different
// sessions, each with its own separate human approval and its own separate
// chance to skip a check.
//
// The honest fix is a CI job gated on `check:drift`, and it cannot be built
// today: GitHub Actions minutes ran out on 2026-09-19 and reset on
// 2026-10-01, and every job repo-wide currently fails in about two seconds
// with zero steps. So this is the smallest thing that is actually safe now —
// the same gate, run locally, refusing rather than warning. It needs no
// minutes, no runner and no secrets beyond the Supabase CLI link the operator
// already has.
//
// WHAT IT REFUSES, and why each one:
//
//   HEAD is not exactly origin/main
//       Production must only ever receive migrations that are merged, exactly
//       as merged. A push from a branch puts SQL in the database that no
//       reviewer saw and that `check:drift` will then report as "applied but
//       NOT in the repo" for everyone else, which reads as somebody having run
//       SQL by hand. Checked by commit, not by branch name, so a detached
//       worktree sitting on origin/main is fine - see the note at the check.
//
//   check-migration-versions fails
//       Two files sharing a version prefix. Supabase keys schema_migrations
//       on the version, so the second is silently treated as already applied
//       and never runs — exactly what happened to 202609220007, which reached
//       production only after #54 renamed it.
//
//   check-migration-immutability fails
//       An applied migration edited, deleted or renamed. A local `db reset`
//       replays the edited file and passes while production still carries
//       what the original did.
//
//   drift shows migrations applied to production but NOT in the repo
//       Somebody ran SQL by hand. Pushing is the wrong response: work out
//       what it did first. This is the one failure that is worse after a
//       push than before it.
//
// It does NOT check whether another open PR adds a migration. That rule —
// one migration at a time — binds when you WRITE one, not when you push, and
// by the time a migration is on main the question has already been settled.
// docs/ops/MIGRATIONS.md is where that rule lives.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const ASSUME_YES = args.has("--yes");
const DRY_RUN = args.has("--dry-run");

function say(s = "") { console.log(s); }
function die(code, ...lines) { for (const l of lines) console.error(l); process.exit(code); }

async function git(...a) {
  const { stdout } = await run("git", a, { cwd: root });
  return stdout.trim();
}

// Each guard is run as its own process and judged on its exit code, rather
// than by importing its internals. They are separately tested and separately
// owned; this file should not be able to disagree with them about what
// passing means.
async function guard(label, file) {
  process.stdout.write(`  ${label} … `);
  try {
    const { stdout } = await run("node", [path.join("scripts", file)], { cwd: root });
    say("ok");
    const last = stdout.trim().split("\n").filter(Boolean).pop();
    if (last) say(`      ${last.trim()}`);
    return true;
  } catch (e) {
    say("REFUSED");
    say((e.stdout || "").trimEnd());
    say((e.stderr || "").trimEnd());
    return false;
  }
}

// Returns { ok, unapplied[], untracked[], text }.
async function drift() {
  try {
    const { stdout } = await run("node", ["scripts/check-migration-drift.mjs"], { cwd: root });
    return { ok: true, unapplied: [], untracked: [], text: stdout.trimEnd() };
  } catch (e) {
    const text = ((e.stdout || "") + (e.stderr || "")).trimEnd();
    if (e.code === 2 || /could not|failed to connect|not linked/i.test(text)) {
      die(2, "", "Could not read production's migration list:", text, "",
             "That is a refusal, not a green light. Fix the link (`supabase link`) and retry.");
    }
    const unapplied = [];
    const untracked = [];
    let bucket = null;
    for (const line of text.split("\n")) {
      if (/committed but NOT applied/.test(line)) { bucket = unapplied; continue; }
      if (/applied to production but NOT in the repo/.test(line)) { bucket = untracked; continue; }
      const m = line.match(/^\s{4}(\d{8,20})\s*$/);
      if (m && bucket) bucket.push(m[1]);
      if (/^\s{2}\S/.test(line)) bucket = null;
    }
    return { ok: false, unapplied, untracked, text };
  }
}

// What the operator is about to apply, in enough detail to recognise a
// mistake: the statements that change the shape of the database, not the
// whole file.
function describe(version) {
  const dir = path.join(root, "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.startsWith(version));
  if (!file) return [`${version}  (file not found in supabase/migrations/)`];
  const sql = readFileSync(path.join(dir, file), "utf8");
  const lines = sql.split("\n");
  const verbs = lines
    .map((l) => l.trim())
    .filter((l) => /^(create|alter|drop|truncate|grant|revoke|insert|update|delete)\b/i.test(l))
    .map((l) => l.replace(/\s+/g, " ").slice(0, 96));
  const destructive = verbs.filter((v) => /^(drop|truncate|delete)\b/i.test(v));
  const out = [`${file}  (${lines.length} lines, ${verbs.length} statements)`];
  const shown = verbs.slice(0, 12);
  for (const v of shown) out.push(`      ${v}`);
  if (verbs.length > shown.length) out.push(`      … and ${verbs.length - shown.length} more`);
  if (destructive.length) {
    out.push(`      ⚠ ${destructive.length} destructive statement(s) — drop/truncate/delete`);
  }
  return out;
}

async function main() {
  say("push:prod — the gate that stands in for CI until 2026-10-01");
  say("");

  // ---- 0. the linked project must be THIS repository's project ----
  // supabase/PROJECT_REF names the one project this repository deploys to.
  // `supabase link` records the linked ref in supabase/.temp/project-ref. A
  // mismatch means the CLI points at some other project (another app on the
  // same account), and pushing there would apply this schema to it.
  say("Project:");
  const expectedRef = readFileSync(path.join(root, "supabase", "PROJECT_REF"), "utf8").trim();
  let linkedRef = "";
  try {
    linkedRef = readFileSync(path.join(root, "supabase", ".temp", "project-ref"), "utf8").trim();
  } catch { /* not linked */ }
  if (linkedRef !== expectedRef) {
    die(1, `  REFUSED: linked project is "${linkedRef || "none"}", expected "${expectedRef}".`, "",
        `Run: supabase link --project-ref ${expectedRef}`);
  }
  say(`  ${expectedRef}`);
  say("");

  // ---- 1. the code being pushed must be merged code ----
  say("Revision:");
  // WHAT IS ACTUALLY BEING CHECKED, and why it is not the branch name.
  //
  // The invariant production needs is "this is exactly the code that was
  // merged", which is a statement about a COMMIT, not about what a local ref
  // happens to be called. Checking for a branch literally named `main` looked
  // equivalent and is not: the shared checkout holds `main`, so a second
  // worktree cannot check it out at all, and `git worktree add --detach` is
  // then the only way to work on merged code. Refusing that turned the gate
  // into something only one working copy on the machine could ever run -
  // found by trying to run it from a worktree, which is the house style
  // precisely because several sessions share this repository.
  //
  // So: HEAD must equal origin/main. A branch called main that has drifted is
  // refused; a detached HEAD sitting exactly on origin/main is fine.
  await run("git", ["fetch", "--quiet", "origin", "main"], { cwd: root }).catch(() => {});
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  const head = await git("rev-parse", "HEAD");
  const remote = await git("rev-parse", "origin/main");
  if (head !== remote) {
    const ahead = await git("rev-list", "--count", `origin/main..HEAD`);
    const behind = await git("rev-list", "--count", `HEAD..origin/main`);
    die(1, `  REFUSED: HEAD is ${ahead} ahead / ${behind} behind origin/main.`, "",
           `  HEAD   ${head.slice(0, 7)}${branch === "HEAD" ? " (detached)" : ` (${branch})`}`,
           `  origin/main ${remote.slice(0, 7)}`, "",
           "  Production only ever receives merged migrations, and only exactly as they",
           "  were merged. Pull, or merge the PR first.");
  }
  const dirty = await git("status", "--porcelain");
  if (dirty) {
    die(1, "  REFUSED: the working tree is not clean.", "",
           dirty.split("\n").map((l) => "    " + l).join("\n"), "",
           "  Commit or stash first - what is on disk is what gets applied.");
  }
  say(`  HEAD ${head.slice(0, 7)} == origin/main${branch === "HEAD" ? " (detached worktree)" : ` (${branch})`}, clean`);
  say("");

  // ---- 2. both guards ----
  say("Guards:");
  const okVersions = await guard("version collisions   ", "check-migration-versions.mjs");
  const okImmutable = await guard("edited/renamed/deleted", "check-migration-immutability.mjs");
  if (!okVersions || !okImmutable) {
    die(1, "", "REFUSED: a migration guard failed. Nothing was pushed.", "",
           "Both guards exist because the failure they catch is invisible otherwise —",
           "see docs/ops/MIGRATIONS.md. Fix the cause; do not bypass this.");
  }
  say("");

  // ---- 3. what production actually has ----
  say("Production:");
  const d = await drift();
  for (const line of d.text.split("\n")) say("  " + line);
  if (d.untracked.length) {
    die(1, "", "REFUSED: production has migrations this repository does not.", "",
           "Somebody ran SQL by hand. Pushing now would layer new changes on top of",
           "a database whose real state nobody has written down. Work out what those",
           "versions did first.");
  }
  if (d.ok || d.unapplied.length === 0) {
    say("");
    say("Nothing to push — production already matches the repository.");
    process.exit(0);
  }
  say("");

  // ---- 4. show the plan ----
  say(`About to apply ${d.unapplied.length} migration(s) to PRODUCTION:`);
  say("");
  for (const v of d.unapplied) for (const line of describe(v)) say("  " + line);
  say("");
  say("  This writes to the live database holding real member data.");
  say("  There is no undo. A migration is reversed by writing another one.");
  say("");

  if (DRY_RUN) {
    say("--dry-run: stopping here. Nothing was pushed.");
    process.exit(0);
  }

  // ---- 5. a deliberate confirmation ----
  if (!ASSUME_YES) {
    if (!process.stdin.isTTY) {
      die(1, "REFUSED: not a terminal, and --yes was not given.", "",
             "Run this by hand and read the plan above, or pass --yes only when you",
             "have already read it. This gate is the whole point of the script.");
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type the word "apply" to continue: ');
    rl.close();
    if (answer.trim() !== "apply") {
      die(1, "", "Not confirmed. Nothing was pushed.");
    }
    say("");
  }

  // ---- 6. push ----
  say("Pushing…");
  const code = await new Promise((resolve) => {
    const p = spawn("supabase", ["db", "push", "--linked", "--yes"], { cwd: root, stdio: "inherit" });
    p.on("close", resolve);
    p.on("error", () => resolve(127));
  });
  if (code !== 0) {
    die(code || 1, "", `supabase db push exited ${code}. Production may be PARTIALLY applied.`, "",
           "Run `npm run check:drift` and read what it says before doing anything else.");
  }

  // ---- 7. prove it landed ----
  say("");
  say("Verifying:");
  const after = await drift();
  for (const line of after.text.split("\n")) say("  " + line);
  if (!after.ok) {
    die(1, "", "The push reported success but drift is still not clean. Read the above.");
  }
  say("");
  say("Done. Record what you applied — docs/ops/MIGRATIONS.md, step 6.");
}

main().catch((e) => die(2, "push:prod failed unexpectedly:", String((e && e.stack) || e)));
