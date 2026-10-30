// backup-database.yml is ready for the box-log project but not scheduled: it
// needs two repository secrets, refuses clearly without them, and the schedule
// stays commented until the owner confirms they exist .
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wf = fs.readFileSync(new URL("../.github/workflows/backup-database.yml", import.meta.url), "utf8");

test("the schedule is commented out", () => {
  assert.ok(!/^\s*schedule:/m.test(wf), "no live schedule: key");
  assert.ok(/^\s*#\s*schedule:/m.test(wf), "the commented schedule is there to uncomment");
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
