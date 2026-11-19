// backup-database.yml backs up box-log daily (scheduled since 2026-10-30): it
// needs two repository secrets and refuses clearly without them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wf = fs.readFileSync(new URL("../.github/workflows/backup-database.yml", import.meta.url), "utf8");

test("the schedule is on: daily backup, Sunday drill, matching the drill's if", () => {
  assert.match(wf, /^\s{2}schedule:\s*\n\s+- cron: "17 2 \* \* 1-6"\s*\n\s+- cron: "17 2 \* \* 0"/m);
  assert.match(wf, /github\.event\.schedule == '17 2 \* \* 0'/);
});

test("the workflow needs exactly two secrets", () => {
  const used = [...new Set([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ["BACKUP_PASSPHRASE", "SUPABASE_ACCESS_TOKEN"]);
  assert.ok(!/SUPABASE_DB_URL|SUPABASE_PROJECT_REF|storage cp|backup-storage/.test(wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")), "no database URL and no photo-bucket half");
});

test("a missing secret fails the job with a message naming it, before any dump", () => {
  const gate = wf.slice(wf.indexOf("- name: refuse to run without"), wf.indexOf("uses: supabase/setup-cli"));
  assert.match(gate, /SUPABASE_ACCESS_TOKEN is not set/);
  assert.match(gate, /BACKUP_PASSPHRASE is not set/);
  assert.match(gate, /exit 1/);
  assert.ok(wf.indexOf("- name: refuse to run without") < wf.indexOf("supabase db dump --linked"), "the gate runs first");
});

test("the project comes from supabase/PROJECT_REF and the dump needs no password", () => {
  assert.match(wf, /supabase link --project-ref "\$\(tr -d '\[:space:\]' < supabase\/PROJECT_REF\)"/);
  assert.ok(!/--db-url|--password|SUPABASE_DB_PASSWORD/.test(wf), "no connection string or password anywhere");
});

// Q-50: a timed drill that asserts exact row counts (RTO/RPO: docs/ops/BACKUPS.md, not asserted here:
// docs/ops/** is in test.yml's paths-ignore).
import { countDumpRows } from "../scripts/count-dump-rows.mjs";

test("Q-50: count-dump-rows counts tuples of multi-row INSERTs, not statements, and ignores ( ) ; inside strings", () => {
  const sql = [
    `INSERT INTO "public"."profiles" ("id", "name") VALUES`,
    `\t('a', 'it''s (not) a row; really'),`,
    `\t('b', NULL),`,
    `\t('c', '{"x":[1,2]}');`,
    `INSERT INTO "auth"."users" ("id") VALUES ('u1');`,
    `INSERT INTO "public"."profiles" ("id", "name") VALUES ('d', '(');`,
    `SELECT pg_catalog.setval('"public"."x_seq"', 3, true);`,
  ].join("\n");
  assert.deepEqual(Object.fromEntries(countDumpRows(sql)), { "public.profiles": 4, "auth.users": 1 });
  assert.throws(() => countDumpRows(`INSERT INTO "public"."t" ("a") VALUES ('open;`), /unterminated/);
});

test("Q-50: the drill is timed, compares exact row counts from the dump, and writes both to the summary", () => {
  const drill = wf.slice(wf.indexOf("  restore-drill:"));
  const code = drill.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(code.indexOf("- name: start the clock") < code.indexOf("uses: actions/download-artifact"), "the clock starts before the download");
  assert.match(code, /node scripts\/count-dump-rows\.mjs data\.sql > expected-rows\.tsv/);
  assert.match(code, /if \[ "\$n" != "\$want" \]; then/);
  const last = code.slice(code.indexOf("- name: write the drill's duration"));
  assert.match(last, /if: always\(\)/);
  assert.match(last, /GITHUB_STEP_SUMMARY/);
  assert.match(last, /DRILL_START/);
});
