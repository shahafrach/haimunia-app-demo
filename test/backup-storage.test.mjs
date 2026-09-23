// The photo half of the backup (2026-09-23).
//
// The restore drill established that `supabase db dump` captures
// storage.objects ROWS and not the files — so a database-only archive
// restores perfectly and leaves every member photo pointing at bytes that no
// longer exist. These assertions are about the properties that made the first
// version of this script wrong in a way an exit code could not show.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const src = readFileSync(new URL("scripts/backup-storage.mjs", root), "utf8");
const wf = readFileSync(new URL(".github/workflows/backup-database.yml", root), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("both photo buckets are covered, named explicitly", () => {
  const list = src.match(/const BUCKETS = \[([^\]]*)\]/)[1];
  for (const b of ["post-photos", "avatar-photos"]) {
    assert.ok(list.includes(`"${b}"`), `${b} is backed up`);
  }
});

test("download and upload are symmetric — the bug the drill caught", () => {
  // `supabase storage cp -r` appends the bucket name on the way DOWN and the
  // source directory's name on the way UP. The first version passed
  // root/<bucket> as the download destination and ss:///<bucket> as the
  // upload destination, producing post-photos/post-photos/<uid>/<file> in
  // both directions. The upload version of that bug exited 0 and reported
  // "2 object(s) uploaded" with every photo at a path no database row
  // references — a recovery that reports success and restores nothing usable.
  assert.match(src, /"-r", `ss:\/\/\/\$\{bucket\}`, root\]/,
    "download targets the ROOT, letting the CLI create the bucket directory");
  assert.match(src, /"-r", src, "ss:\/\/\/"\]/,
    "and upload targets the ROOT too, letting the source directory name BE the bucket");
  assert.ok(!/"-r", src, `ss:\/\/\/\$\{bucket\}`/.test(src),
    "never upload into ss:///<bucket> - that nests the bucket name");
});

test("the manifest is what makes it checkable", () => {
  for (const field of ["object_count", "total_bytes", "sha256", "taken_at"]) {
    assert.ok(src.includes(field), `manifest records ${field}`);
  }
  // A directory of JPEGs cannot tell you whether it is complete; the sha256
  // per file is what turns "the command exited zero" into "all N files
  // present and unchanged".
  assert.match(src, /createHash\("sha256"\)/);
  assert.match(src, /missing === 0 && changed === 0/, "verify fails on either");
});

test("a failed download is loud and non-zero", () => {
  // The failure this whole script exists because of is a backup that quietly
  // omits half of itself.
  assert.match(src, /FAILED to download/);
  assert.match(src, /process\.exit\(1\)/);
});

test("a drill can target the local stack, so rehearsing never writes to production", () => {
  assert.match(src, /const TARGET = process\.argv\.includes\("--local"\)/,
    "--local swaps the endpoint");
  // "--linked" legitimately appears once, in the ternary that DEFINES TARGET.
  // What must not exist is a cp call that hard-codes it and so ignores the
  // flag - that is what would make a drill write to production.
  assert.equal((src.match(/"--linked"/g) || []).length, 1,
    "--linked appears only where TARGET is chosen");
  assert.ok(!/sh\(\["storage", "cp", "--linked"/.test(src),
    "no storage command hard-codes the production endpoint");
});

test("the workflow refuses rather than backing up half the data", () => {
  assert.match(wf, /SUPABASE_ACCESS_TOKEN/, "the workflow needs storage credentials");
  assert.match(wf, /node scripts\/backup-storage\.mjs backup backup/,
    "and runs the photo backup into the same directory it encrypts");
  // Same rule the passphrase gate follows: refuse, never skip quietly.
  const gate = wf.slice(wf.indexOf("refuse to run without"), wf.indexOf("setup-cli"));
  assert.match(gate, /SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF is not set/,
    "missing storage credentials fail the job rather than producing a half backup");
});

test("npm exposes it, so it is not a script only its author knows about", () => {
  assert.equal(pkg.scripts["backup:storage"], "node scripts/backup-storage.mjs");
});
