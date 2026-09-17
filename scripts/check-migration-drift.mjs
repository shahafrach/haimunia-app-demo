#!/usr/bin/env node
// Is the database actually running what the repo says it runs?
//
// On 2026-09-17 the answer was no. 202609170001 - the migration that revokes
// anon's EXECUTE on every function in public - had been committed, tested and
// reviewed the day before, and never applied. It was found by running
// `supabase migration list --linked` on a hunch while answering an unrelated
// question. Nothing in CI applies migrations and nothing checks that they
// were applied, so "fixed in the repo" and "fixed in production" are separate
// facts and only one of them is visible from a pull request.
//
// This makes the second fact one command:  npm run check:drift
//
// It deliberately does NOT apply anything. Drift in the other direction -
// applied on the server, absent from the repo - means somebody ran SQL by
// hand, and pushing is the wrong response to that.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Exported for the tests: the parsing is the part with edge cases, and it
// should be checkable without a network or a linked project.
export function parseMigrationList(stdout) {
  // The CLI prints progress lines ("Initialising login role...") and an
  // update notice around the payload, so pick the line that IS the payload
  // rather than assuming it arrives alone.
  const line = String(stdout).split("\n").find((l) => l.trim().startsWith('{"migrations"'));
  if (!line) throw new Error("no migration list in the CLI output - did it fail to connect?");
  const rows = JSON.parse(line).migrations || [];
  return {
    total: rows.length,
    unapplied: rows.filter((r) => r.local && !r.remote).map((r) => r.local),
    untracked: rows.filter((r) => r.remote && !r.local).map((r) => r.remote),
  };
}

export function report({ total, unapplied, untracked }) {
  const lines = [];
  if (!unapplied.length && !untracked.length) {
    lines.push(`✓ ${total} migrations, repo and database agree.`);
    return { ok: true, lines };
  }
  if (unapplied.length) {
    lines.push(`✗ ${unapplied.length} migration(s) committed but NOT applied to production:`);
    for (const v of unapplied) lines.push(`    ${v}`);
    lines.push("  Whatever they fix is not fixed live. Apply with:");
    lines.push("    supabase db push --linked --yes");
  }
  if (untracked.length) {
    lines.push(`✗ ${untracked.length} migration(s) applied to production but NOT in the repo:`);
    for (const v of untracked) lines.push(`    ${v}`);
    lines.push("  Somebody ran SQL by hand. Do NOT push - work out what it did first.");
  }
  return { ok: false, lines };
}

// node --test imports this file for parseMigrationList; only run the CLI when
// it is the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = promisify(execFile);
  try {
    const { stdout } = await run("supabase", ["migration", "list", "--linked"], { timeout: 120000 });
    const { ok, lines } = report(parseMigrationList(stdout));
    console.log(lines.join("\n"));
    process.exit(ok ? 0 : 1);
  } catch (err) {
    // A failure to CHECK is not a pass. The whole point of this file is that
    // a green tick must mean something was measured.
    console.error("could not check migration drift:", err.message);
    console.error("(needs the supabase CLI, a linked project, and network access)");
    process.exit(2);
  }
}
