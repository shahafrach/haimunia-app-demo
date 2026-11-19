// Q-45 (202611190001): follow-ups from the claude-review of #188. Behaviour in pgTAP 0164 (CI).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202611190001_q45_review_followups.sql", import.meta.url), "utf8");

test("the join code's global ceiling is 3000 wrong codes an hour, after the per-account and per-IP limits", () => {
  const j = sql.slice(sql.indexOf("create or replace function public.join_circle("));
  const acct = j.indexOf("check_rate_limit('join_circle', 10, 60)");
  const ip = j.indexOf("transfer_rate_ok(public.request_ip_hash(), 'join_code', 20, 60)");
  const ceil = j.indexOf("a.attempt_count >= 3000");
  const count = j.indexOf("perform public.transfer_rate_ok(repeat('0', 64), 'join_code_wrong'");
  assert.ok(acct > 0 && ip > acct && ceil > ip && count > ceil, "account limit, then IP limit, then the ceiling, then a wrong code counts");
  assert.doesNotMatch(j, /attempt_count >= 300\b/);
});

test("client errors and feedback key their per-IP limit on cf-connecting-ip only", () => {
  const f = sql.slice(sql.indexOf("create or replace function public.client_report_ip_hash"), sql.indexOf("create or replace function public.join_circle("));
  assert.match(f, /'cf-connecting-ip'/);
  assert.doesNotMatch(f, /x-forwarded-for|x-real-ip/i);
  assert.match(f, /revoke all on function public\.client_report_ip_hash\(text\) from public, anon, authenticated, service_role;/);
});
