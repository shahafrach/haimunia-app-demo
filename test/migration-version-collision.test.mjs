// The duplicate-version guard. The case it exists for is 2026-09-23, when two
// branches each added a migration numbered 202609220007, git merged them
// without a conflict, and production silently skipped one of them for four
// days while check:drift reported clean.
//
// The cases worth pinning are the ones where it could report "fine" without
// having looked, and the one where it must NOT fire: adjacent versions that
// merely look similar.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  versionOf, findCollisions, report, findIncomingCollisions, reportIncoming,
} from "../scripts/check-migration-versions.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the version is the digits before the first underscore, as the CLI parses it", () => {
  assert.equal(versionOf("202609220007_only_the_technical_account_is_hidden.sql"), "202609220007");
  assert.equal(versionOf("202609220008_an_announcement_becomes_its_feed_card.sql"), "202609220008");
  assert.equal(versionOf("rls_helpers.sql"), null, "no leading digits: no version");
});

test("the real 2026-09-23 collision is caught and both files are named", () => {
  const { collisions } = findCollisions([
    "202609220006_a_management_account_is_not_a_clubmate.sql",
    "202609220007_only_the_technical_account_is_hidden.sql",
    "202609220007_an_announcement_becomes_its_feed_card.sql",
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].version, "202609220007");
  assert.deepEqual(collisions[0].names.sort(), [
    "202609220007_an_announcement_becomes_its_feed_card.sql",
    "202609220007_only_the_technical_account_is_hidden.sql",
  ], "naming only one of the pair would leave the author guessing which to move");

  const r = report(findCollisions([
    "202609220007_only_the_technical_account_is_hidden.sql",
    "202609220007_an_announcement_becomes_its_feed_card.sql",
  ]));
  assert.equal(r.ok, false);
  const out = r.lines.join("\n");
  assert.match(out, /supabase migration list --linked/,
    "it has to say HOW to tell which file is safe to renumber");
  // Whitespace-tolerant: the guidance is wrapped prose, so a fixed-width line
  // break falls in the middle of the sentence.
  assert.match(out, /Never renumber one that is already\s+applied/);
});

test("adjacent versions are not a collision", () => {
  const { collisions } = findCollisions([
    "202609220007_only_the_technical_account_is_hidden.sql",
    "202609220008_an_announcement_becomes_its_feed_card.sql",
    "202609230001_module_switches_gate_their_server_paths.sql",
  ]);
  assert.equal(collisions.length, 0, "the fix for the real bug must itself pass");
});

test("three files on one version report all three, not the first two", () => {
  const { collisions } = findCollisions(["1_a.sql", "1_b.sql", "1_c.sql"]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].names.length, 3);
});

test("a file with no version is reported rather than grouped under one", () => {
  const { collisions, unversioned } = findCollisions(["202609220007_a.sql", "notes.sql", "README.sql"]);
  assert.equal(collisions.length, 0, "two unversioned files are not a version collision");
  assert.deepEqual(unversioned.sort(), ["README.sql", "notes.sql"]);
  assert.equal(report({ collisions, unversioned, total: 1 }).ok, false,
    "the CLI would never apply them, so silence would be a false green");
});

test("non-sql files are ignored", () => {
  const { collisions, unversioned, total } = findCollisions([
    "202609220007_a.sql", "202609220007_b.txt", ".gitkeep",
  ]);
  assert.equal(collisions.length, 0);
  assert.equal(unversioned.length, 0);
  assert.equal(total, 1);
});

test("a clean set says how many it actually counted", () => {
  const r = report(findCollisions(["1_a.sql", "2_b.sql", "3_c.sql"]));
  assert.equal(r.ok, true);
  assert.match(r.lines.join("\n"), /3 migrations, every version distinct/,
    "a bare OK cannot be distinguished from a check that looked at nothing");
});

test("this repository's own migrations have no duplicate version", () => {
  const r = report(findCollisions(readdirSync(path.join(root, "supabase", "migrations"))));
  assert.equal(r.ok, true, r.lines.join("\n"));
});

// ---------------------------------------------------------------------------
// THE INCOMING COLLISION: two branches, one version, no shared line, and the
// collision created by the merge. PR #57 is the live specimen - main holds
// 202609230001_module_switches_... and the branch adds
// 202609230001_deletion_reaches_photos_..., so on the branch alone the version
// appears once and the directory scan above is genuinely clean.
test("PR #57's shape: clean on the branch, a collision on merge", () => {
  const addedHere = ["202609230001_deletion_reaches_photos_telemetry_and_the_audit_note.sql"];
  const addedOnBase = ["202609230001_module_switches_gate_their_server_paths.sql"];

  // The half that always runs sees nothing wrong, which is the whole problem.
  assert.equal(findCollisions(addedHere).collisions.length, 0,
    "one file cannot collide with itself - this is why the branch is green");

  const incoming = findIncomingCollisions(addedHere, addedOnBase);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].version, "202609230001");
  assert.deepEqual(incoming[0].mine, addedHere);
  assert.deepEqual(incoming[0].theirs, addedOnBase);

  const r = reportIncoming(incoming, "origin/main");
  assert.equal(r.ok, false);
  const out = r.lines.join("\n");
  assert.match(out, /the collision is created by the merge/);
  assert.match(out, /Renumber THIS branch's migration/,
    "the branch's file is the unapplied one; main's is not to be touched");
});

test("a branch that adds a version nobody else added is clean", () => {
  assert.deepEqual(
    findIncomingCollisions(["202609240001_mine.sql"], ["202609230001_theirs.sql"]),
    [],
  );
});

test("#54's renumbering stays clean against a moving base", () => {
  // It added 202609220008, which main never used. The guard must not punish
  // the fix for the bug it exists to catch.
  assert.deepEqual(
    findIncomingCollisions(
      ["202609220008_an_announcement_becomes_its_feed_card.sql"],
      ["202609230001_module_switches_gate_their_server_paths.sql"],
    ),
    [],
  );
});

test("the same file added on both sides is not a collision", () => {
  // A branch that has already merged main carries main's file too. Identical
  // names are one migration, not two, and flagging it would make updating a
  // branch from main look like an error.
  assert.deepEqual(
    findIncomingCollisions(["202609230001_same.sql"], ["202609230001_same.sql"]),
    [],
  );
});

test("a branch carrying main's file AND its own on that version still reports the other one", () => {
  const incoming = findIncomingCollisions(
    ["202609230001_same.sql", "202609230001_mine.sql"],
    ["202609230001_same.sql"],
  );
  assert.equal(incoming.length, 0,
    "once both files are in the tree it is a plain duplicate, and findCollisions owns it");
  assert.equal(
    findCollisions(["202609230001_same.sql", "202609230001_mine.sql"]).collisions.length, 1,
    "and it does catch it, so the case is covered by one half or the other, never neither");
});

// The git plumbing of the incoming half. It compares against the base branch
// TIP, not the merge base, and getting that wrong is invisible in a unit test:
// with a merge-base comparison main's newer file is simply not in the list and
// the check passes. A throwaway repository is the only honest test of it.
test("integration: the CLI catches a version main added after the branch diverged", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vercheck-"));
  const run = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@t.invalid");
    run("config", "user.name", "t");
    mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    cpSync(path.join(root, "scripts", "check-migration-versions.mjs"),
           path.join(dir, "scripts", "check-migration-versions.mjs"));
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_base.sql"), "select 1;\n");
    run("add", "-A"); run("commit", "-qm", "base");

    // They diverge here. Then main gains a migration the branch never sees.
    run("checkout", "-qb", "feature");
    run("checkout", "-q", "main");
    writeFileSync(path.join(dir, "supabase/migrations/202601020001_theirs.sql"), "select 2;\n");
    run("add", "-A"); run("commit", "-qm", "main moves on");

    run("checkout", "-q", "feature");
    writeFileSync(path.join(dir, "supabase/migrations/202601020001_mine.sql"), "select 3;\n");
    run("add", "-A"); run("commit", "-qm", "branch adds the same version");

    // The directory holds 202601020001 exactly once, so half 1 is clean.
    assert.equal(
      findCollisions(readdirSync(path.join(dir, "supabase", "migrations"))).collisions.length, 0,
      "the branch really is clean on its own - that is the bug being guarded");

    let code = 0, out = "";
    try {
      out = execFileSync(process.execPath, ["scripts/check-migration-versions.mjs"],
        { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) { code = err.status; out = `${err.stdout ?? ""}${err.stderr ?? ""}`; }

    assert.equal(code, 1, `expected a failure, got:\n${out}`);
    assert.match(out, /202601020001/);
    assert.match(out, /202601020001_mine\.sql/);
    assert.match(out, /202601020001_theirs\.sql/);
    assert.match(out, /collision is created by the merge/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
