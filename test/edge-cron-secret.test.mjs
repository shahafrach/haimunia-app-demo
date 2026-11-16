// F-023 (202611160001): the scheduled Edge Function calls authenticate with a dedicated cron secret.
//
// From about 2026-11-13 every cron call to notif_push_send and purge_abandoned_profiles answered 401: the
// service_role key in the Vault and the one the functions hold were no longer the same value. Now
// set-vault-secrets writes one random EDGE_CRON_SECRET to both places in the same run; the functions accept
// it (and still the service_role key, for a manual call) through one shared constant-time check, and the SQL
// sends it whenever it is set. The SQL side is pinned by supabase/tests/0159_edge_cron_secret_test.sql.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { isScheduledCaller, timingSafeEqualStrings, MIN_CRON_SECRET_LENGTH } from "../supabase/functions/_shared/cronAuth.mjs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const CRON = "c".repeat(64);
const SERVICE = "eyJhbGciOiJIUzI1NiJ9.service.role";

test("the cron secret and the service_role key both pass; nothing else does", () => {
  assert.equal(isScheduledCaller(`Bearer ${CRON}`, { cronSecret: CRON, serviceRoleKey: SERVICE }), true);
  assert.equal(isScheduledCaller(`Bearer ${SERVICE}`, { cronSecret: CRON, serviceRoleKey: SERVICE }), true, "a manual ops call still works");
  for (const h of [null, "", "Bearer ", `Bearer ${CRON}x`, `bearer ${CRON}`, CRON, `Bearer ${CRON.slice(0, -1)}`, "Bearer anon-key"]) {
    assert.equal(isScheduledCaller(h, { cronSecret: CRON, serviceRoleKey: SERVICE }), false, `refused: ${JSON.stringify(h)}`);
  }
});

test("an unset, empty or short cron secret is never a password", () => {
  assert.equal(MIN_CRON_SECRET_LENGTH, 32);
  for (const cronSecret of [undefined, null, "", "short"]) {
    assert.equal(isScheduledCaller(`Bearer ${cronSecret ?? ""}`, { cronSecret, serviceRoleKey: SERVICE }), false);
    assert.equal(isScheduledCaller("Bearer ", { cronSecret, serviceRoleKey: "" }), false, "and an empty service key admits nobody");
  }
  assert.equal(isScheduledCaller(`Bearer ${SERVICE}`, { cronSecret: null, serviceRoleKey: SERVICE }), true, "the service key alone still works");
});

test("the comparison is constant-shape and exact", () => {
  assert.equal(timingSafeEqualStrings("abc", "abc"), true);
  assert.equal(timingSafeEqualStrings("abc", "abd"), false);
  assert.equal(timingSafeEqualStrings("abc", "abcd"), false);
  const src = read("supabase/functions/_shared/cronAuth.mjs");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /===\s*`Bearer|header\s*===|console\./, "no plain comparison, no logging");
});

test("both scheduled functions use the shared check with EDGE_CRON_SECRET, and no longer their own copy", () => {
  for (const fn of ["notif_push_send", "purge_abandoned_profiles"]) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /import \{ isScheduledCaller \} from "\.\.\/_shared\/cronAuth\.mjs";/, fn);
    assert.match(src, /isScheduledCaller\(req\.headers\.get\("Authorization"\), \{ cronSecret: Deno\.env\.get\("EDGE_CRON_SECRET"\), serviceRoleKey \}\)/, fn);
    assert.doesNotMatch(src, /function timingSafeEqualStrings/, `${fn} has one check, the shared one`);
    assert.doesNotMatch(src, /Deno\.env\.get\("EDGE_CRON_SECRET"\)[^\n]*console|console\.[^\n]*EDGE_CRON_SECRET/, "never logged");
  }
});

test("the migration sends the cron secret when set, falls back to the service_role key, and commits no value", () => {
  const sql = read("supabase/migrations/202611160001_edge_cron_secret.sql");
  assert.match(sql, /vault\.create_secret\(\s*'CRON-SECRET-NOT-SET',\s*'edge_functions_cron_secret'/);
  assert.match(sql, /if v_cron is not null and v_cron <> 'CRON-SECRET-NOT-SET' and length\(v_cron\) >= 32 then\s*v_auth := v_cron;\s*elsif v_key is not null and v_key <> 'SERVICE-ROLE-KEY-NOT-SET' then\s*v_auth := v_key;/);
  assert.match(sql, /'Authorization', 'Bearer ' \|\| v_auth/);
  assert.match(sql, /revoke all on function public\.cron_invoke_edge_function\(text\) from public, anon, authenticated;/);
  assert.match(sql, /revoke all on function public\.edge_functions_ready\(\) from public, anon, authenticated;/);
  assert.equal((sql.match(/security definer set search_path = ''/g) || []).length, 2);
  assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{10,}|sb_secret_|[0-9a-f]{64}/, "no key or secret value in a migration");
});

test("the deploy workflow deploys both functions when _shared changes", () => {
  const wf = read(".github/workflows/deploy-edge-functions.yml");
  assert.match(wf, /- "supabase\/functions\/\*\*"/, "a change to _shared/cronAuth.mjs triggers the deploy on merge");
});
