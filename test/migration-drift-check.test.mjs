// The drift checker itself. Its whole value is that a green result means
// something was measured, so the cases worth pinning are the ones where it
// could report "fine" without having looked.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseMigrationList, report } from "../scripts/check-migration-drift.mjs";

// Shaped like the real thing: the CLI wraps its payload in progress lines and
// a version notice, and a parser that assumed a bare JSON document would have
// worked on nothing.
const wrap = (rows) => [
  "Initialising login role...",
  "Connecting to remote database...",
  JSON.stringify({ migrations: rows, message: "Migrations listed" }),
  "A new version of Supabase CLI is available: v2.117.0",
].join("\n");

test("agreement is reported as agreement", () => {
  const r = report(parseMigrationList(wrap([
    { local: "202609160007", remote: "202609160007" },
    { local: "202609170001", remote: "202609170001" },
  ])));
  assert.equal(r.ok, true);
  assert.match(r.lines.join("\n"), /2 migrations, repo and database agree/);
});

test("the 2026-09-17 case: committed, reviewed, and never applied", () => {
  const r = report(parseMigrationList(wrap([
    { local: "202609160007", remote: "202609160007" },
    { local: "202609170001", remote: "" },
  ])));
  assert.equal(r.ok, false, "this is the failure that went unnoticed for a day");
  const out = r.lines.join("\n");
  assert.match(out, /202609170001/, "it names the migration, not just a count");
  assert.match(out, /supabase db push --linked --yes/, "and the command that fixes it");
});

test("drift the other way is not something to push at", () => {
  const r = report(parseMigrationList(wrap([{ local: "", remote: "202609180001" }])));
  assert.equal(r.ok, false);
  const out = r.lines.join("\n");
  assert.match(out, /applied to production but NOT in the repo/);
  assert.match(out, /Do NOT push/,
    "somebody ran SQL by hand; pushing the repo over it is the wrong reflex");
});

test("output the parser cannot read raises, and does not read as success", () => {
  assert.throws(() => parseMigrationList("Connecting to remote database...\nfailed to connect"),
    /no migration list/, "a failed connection must not parse as zero drift");
  // The CLI's own failure path is covered by the script exiting 2 rather than
  // 0 - asserted below on the source, since running it needs a linked project.
  const src = readFileSync(new URL("../scripts/check-migration-drift.mjs", import.meta.url), "utf8");
  assert.match(src, /process\.exit\(2\)/, "a failure to CHECK exits non-zero, like a failure to pass");
  assert.match(src, /process\.exit\(ok \? 0 : 1\)/);
});

// THE HUMAN TABLE. The CLI emits JSON only when it detects an agent driving
// it; a person in a terminal gets this, and `--output json` does not change it
// for `migration list` (it does for `functions list` - verified 2026-09-17).
// The first version of this checker read JSON only, was verified against real
// output, and would have thrown for every human who ran it.
const humanTable = (rows) => [
  "Initialising login role...",
  "Connecting to remote database...",
  "",
  "   Local          | Remote         | Time (UTC)     ",
  "  ----------------|----------------|----------------",
  ...rows.map(([l, r]) => `   ${l ? "`" + l + "`" : "              "} | ${r ? "`" + r + "`" : "              "} | \`${l || r}\` `),
  "A new version of Supabase CLI is available: v2.117.0",
].join("\n");

test("the human table parses, not just the agent's JSON", () => {
  const r = report(parseMigrationList(humanTable([
    ["202609160007", "202609160007"],
    ["202609170001", "202609170001"],
  ])));
  assert.equal(r.ok, true);
  assert.match(r.lines.join("\n"), /2 migrations, repo and database agree/);
});

test("drift is found in the table form too", () => {
  const r = report(parseMigrationList(humanTable([
    ["202609160007", "202609160007"],
    ["202609170001", ""],
    ["", "202609180001"],
  ])));
  assert.equal(r.ok, false);
  const out = r.lines.join("\n");
  assert.match(out, /202609170001/, "committed but not applied");
  assert.match(out, /202609180001/, "applied but not in the repo");
  assert.match(out, /Do NOT push/);
});

test("the table's header and separator rows are not mistaken for migrations", () => {
  // Both contain pipes, so a parser that merely split on "|" would count
  // "Local | Remote | Time (UTC)" and "----|----|----" as two migrations.
  const parsed = parseMigrationList(humanTable([["202609160007", "202609160007"]]));
  assert.equal(parsed.total, 1, "one data row, not three");
  assert.deepEqual(parsed.unapplied, []);
  assert.deepEqual(parsed.untracked, []);
});

test("npm run check:drift is wired", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["check:drift"], "node scripts/check-migration-drift.mjs");
});
