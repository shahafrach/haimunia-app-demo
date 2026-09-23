// The deletion half of check-migration-immutability.
//
// The check compared only the files PRESENT in the working tree, so a file
// that was deleted was never in the list to be compared and a rename passed
// silently. #54 renamed 202609220007_an_announcement_... to 202609220008_...
// and the check printed OK without an opinion. That rename was correct; the
// absence of an opinion was not.
//
// Deleting an APPLIED migration is the damaging case: production keeps the
// schema_migrations row and the schema it produced, the repository loses the
// file that produced it, and `supabase db reset` then builds a local database
// that production does not match.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, unlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findMissing, renameHintFor } from "../scripts/check-migration-immutability.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join("scripts", "check-migration-immutability.mjs");

test("a file present at the base and gone now is missing", () => {
  assert.deepEqual(findMissing(["a.sql", "b.sql"], ["a.sql"]), ["b.sql"]);
});

test("adding files is not a deletion", () => {
  assert.deepEqual(findMissing(["a.sql"], ["a.sql", "b.sql", "c.sql"]), []);
});

test("an unchanged set is not a deletion", () => {
  assert.deepEqual(findMissing(["a.sql", "b.sql"], ["b.sql", "a.sql"]), [],
    "order is not meaning; only membership is");
});

test("#54's shape: the number changed, the name did not, and the hint follows the name", () => {
  const hint = renameHintFor(
    "202609220007_an_announcement_becomes_its_feed_card.sql",
    ["202609220008_an_announcement_becomes_its_feed_card.sql",
     "202609220007_only_the_technical_account_is_hidden.sql"],
    ["202609220007_an_announcement_becomes_its_feed_card.sql",
     "202609220007_only_the_technical_account_is_hidden.sql"],
  );
  assert.equal(hint, "202609220008_an_announcement_becomes_its_feed_card.sql");
});

test("a re-description keeping the number is followed by the number", () => {
  const hint = renameHintFor(
    "202601010001_first.sql",
    ["202601010001_renamed.sql"],
    ["202601010001_first.sql"],
  );
  assert.equal(hint, "202601010001_renamed.sql");
});

test("THE WRONG ANSWER THIS GUARDS AGAINST: a version twin is not a rename target", () => {
  // During a collision the file sharing the version is a different migration
  // that has been on main for days. Pointing at it would tell the author their
  // file was renamed to somebody else's work. It is not new, so it is excluded.
  const hint = renameHintFor(
    "202609220007_an_announcement_becomes_its_feed_card.sql",
    ["202609220007_only_the_technical_account_is_hidden.sql"],
    ["202609220007_an_announcement_becomes_its_feed_card.sql",
     "202609220007_only_the_technical_account_is_hidden.sql"],
  );
  assert.equal(hint, null, "no hint beats a confident wrong one");
});

test("two equally plausible new candidates yield no hint at all", () => {
  const hint = renameHintFor(
    "202601010001_first.sql",
    ["202601010001_one.sql", "202601010001_two.sql"],
    ["202601010001_first.sql"],
  );
  assert.equal(hint, null);
});

// ---------------------------------------------------------------------------
// The git plumbing, which the pure functions above cannot cover: the check has
// to read the merge base's file list, and reading it wrongly is how the
// original bug survived. A throwaway repository is the only honest test of it.
function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "migguard-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@t.invalid");
  run("config", "user.name", "t");
  mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  cpSync(path.join(root, SCRIPT), path.join(dir, SCRIPT));
  return { dir, run };
}

function runCheck(dir, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("a deleted migration fails the check, and said OK before this guard", () => {
  const { dir, run } = scratchRepo();
  try {
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_first.sql"), "select 1;\n");
    writeFileSync(path.join(dir, "supabase/migrations/202601010002_second.sql"), "select 2;\n");
    run("add", "-A"); run("commit", "-qm", "two migrations");

    run("checkout", "-qb", "feature");
    unlinkSync(path.join(dir, "supabase/migrations/202601010002_second.sql"));
    run("add", "-A"); run("commit", "-qm", "delete one");

    const r = runCheck(dir);
    assert.equal(r.code, 1, "deleting an applied migration must fail the build");
    assert.match(r.out, /existed at the merge base and are now gone/);
    assert.match(r.out, /202601010002_second\.sql/, "it names the file");
    assert.match(r.out, /supabase migration list --linked/, "and how to tell if it was safe");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rename fails too, and names where it went", () => {
  const { dir, run } = scratchRepo();
  try {
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_first.sql"), "select 1;\n");
    run("add", "-A"); run("commit", "-qm", "one migration");

    run("checkout", "-qb", "feature");
    renameSync(
      path.join(dir, "supabase/migrations/202601010001_first.sql"),
      path.join(dir, "supabase/migrations/202601010001_renamed.sql"),
    );
    run("add", "-A"); run("commit", "-qm", "rename it");

    const r = runCheck(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /renamed to 202601010001_renamed\.sql\?/,
      "a rename should read as a rename, not as an unexplained disappearance");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ALLOW_MIGRATION_EDITS=1 is the documented escape hatch for a never-applied file", () => {
  const { dir, run } = scratchRepo();
  try {
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_first.sql"), "select 1;\n");
    run("add", "-A"); run("commit", "-qm", "one migration");
    run("checkout", "-qb", "feature");
    unlinkSync(path.join(dir, "supabase/migrations/202601010001_first.sql"));
    run("add", "-A"); run("commit", "-qm", "delete it");

    assert.equal(runCheck(dir).code, 1, "blocked by default");
    assert.equal(runCheck(dir, { ALLOW_MIGRATION_EDITS: "1" }).code, 0,
      "#54's renumbering was legitimate and has to remain possible");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("adding a migration still passes, which is the common case", () => {
  const { dir, run } = scratchRepo();
  try {
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_first.sql"), "select 1;\n");
    run("add", "-A"); run("commit", "-qm", "one migration");
    run("checkout", "-qb", "feature");
    writeFileSync(path.join(dir, "supabase/migrations/202601010002_second.sql"), "select 2;\n");
    run("add", "-A"); run("commit", "-qm", "add one");

    const r = runCheck(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /none edited, none missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editing an applied migration still fails, unchanged by this guard", () => {
  const { dir, run } = scratchRepo();
  try {
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_first.sql"), "select 1;\n");
    run("add", "-A"); run("commit", "-qm", "one migration");
    run("checkout", "-qb", "feature");
    writeFileSync(path.join(dir, "supabase/migrations/202601010001_first.sql"), "select 999;\n");
    run("add", "-A"); run("commit", "-qm", "edit it");

    const r = runCheck(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /existed at the merge base and have been edited/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
