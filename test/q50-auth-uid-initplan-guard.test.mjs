// Q-50: no RLS policy calls auth.uid() bare. The live proof is pgTAP 0165 (CI, every policy in the
// catalog); this is the quick half for npm test: every migration after F-005 (202611150004) that
// creates or alters a policy uses only (select auth.uid()).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = new URL("../supabase/migrations/", import.meta.url);
const F005 = "202611150004_rls_auth_uid_initplan.sql";

test("pgTAP 0165 strips exactly the deparsed wrapped form and checks USING and WITH CHECK", () => {
  const t = fs.readFileSync(new URL("../supabase/tests/0165_q50_auth_uid_initplan_guard_test.sql", import.meta.url), "utf8");
  assert.match(t, /replace\(coalesce\(qual, ''\), '\( SELECT auth\.uid\(\) AS uid\)', ''\) ~ 'auth\\\.uid\\\(\\\)'/);
  assert.match(t, /replace\(coalesce\(with_check, ''\), '\( SELECT auth\.uid\(\) AS uid\)', ''\)/);
  assert.match(t, /from pg_policies/);
});

test("no policy written after F-005 calls auth.uid() bare", () => {
  const later = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f > F005).sort();
  const offenders = [];
  for (const f of later) {
    const sql = fs.readFileSync(new URL(f, dir), "utf8").replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/\b(?:create|alter)\s+policy\b[^;]*;/gi)) {
      if (/auth\.uid\(\)/i.test(m[0].replace(/\(\s*select\s+auth\.uid\(\)\s*\)/gi, ""))) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], "wrap it as (select auth.uid()) so Postgres evaluates it once per statement");
});
