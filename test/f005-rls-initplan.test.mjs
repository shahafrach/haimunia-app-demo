// F-005 (splinter 0003_auth_rls_initplan): RLS policies call auth.uid() once per statement.
// Held until after launch (owner decision 2026-11-15).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

test("F-005: the initplan migration wraps every auth.uid() it touches", () => {
  const sql = readFileSync(new URL("../supabase/migrations/202611150001_rls_auth_uid_initplan.sql", import.meta.url), "utf8")
    .replace(/^--.*$/gm, "");
  assert.equal((sql.match(/^alter policy /gm) || []).length, 43);
  assert.doesNotMatch(sql.replace(/\(select auth\.uid\(\)\)/g, ""), /auth\.uid\(\)/, "no bare auth.uid() left");
});
