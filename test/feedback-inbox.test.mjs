// Feedback inbox (Home port, feature 3): the reading script, the workflow and the migration stay inside their limits.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { clampLimit, selectSql, markSql } from "../scripts/feedback-inbox.mjs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("the limit is clamped and the query never selects who wrote it", () => {
  assert.equal(clampLimit("500"), 100);
  assert.equal(clampLimit("0"), 1);
  assert.equal(clampLimit("abc"), 50);
  assert.equal(clampLimit("7; drop table bug_reports"), 7, "only the leading number counts");
  const sql = selectSql("5");
  assert.match(sql, /read_at is null/);
  assert.doesNotMatch(sql, /reporter_id|handled_by|admin_note/);
  assert.doesNotMatch(sql, /diagnostics\s*(,|as|from)/i, "device facts are not printed, only the app version");
});

test("marking read touches only well-formed ids", () => {
  assert.equal(markSql([]), null);
  assert.equal(markSql(["x'; delete from bug_reports; --"]), null);
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.match(markSql([id, "bad"]), new RegExp(`id in \\('${id}'\\)$`));
});

test("the workflow is manual, read-only on the repo, pinned, and never echoes the token", () => {
  const wf = read("../.github/workflows/feedback-inbox.yml");
  const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(code, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(schedule|pull_request|push):/m);
  assert.match(code, /permissions:\s*\n\s+contents: read/);
  assert.match(code, /uses: actions\/checkout@[0-9a-f]{40}/);
  for (const line of code.split("\n").filter((l) => /\becho\b/.test(l))) assert.doesNotMatch(line, /SUPABASE_ACCESS_TOKEN\b(?!\s+is not set)/);
});

test("the migration adds read_at and tag to a table clients cannot touch", () => {
  const sql = read("../supabase/migrations/202611080003_feedback_inbox.sql");
  assert.match(sql, /add column read_at timestamptz/);
  assert.match(sql, /tag text check \(tag is null or tag in \('bug', 'idea', 'question', 'other'\)\)/);
  assert.doesNotMatch(sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"), /grant /i, "no new grant: bug_reports stays closed to clients");
});
