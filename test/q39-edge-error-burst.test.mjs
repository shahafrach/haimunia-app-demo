// Q-39 (202611180004): a burst of bad Edge Function answers is a failure, and the alert runs hourly.
// Behaviour in pgTAP 0163 (CI); this pins the shape.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202611180004_q39_edge_error_burst.sql", import.meta.url), "utf8");
const prev = fs.readFileSync(new URL("../supabase/migrations/202609230008_a_job_that_did_nothing_stops_reporting_green.sql", import.meta.url), "utf8");
const wf = fs.readFileSync(new URL("../.github/workflows/scheduled-job-alert.yml", import.meta.url), "utf8");

test("job_health_check keeps every earlier rule and adds the burst rule", () => {
  const body = (s) => s.slice(s.indexOf("CREATE OR REPLACE FUNCTION public.job_health_check()"), s.lastIndexOf("end $function$;"));
  const burstStart = sql.indexOf("  -- ------------------------------------------------------------------\n  -- Q-39");
  const burstEnd = sql.indexOf("), '{}'::text[]);", burstStart) + "), '{}'::text[]);\n".length;
  const norm = (t) => t.replace(/\n{2,}/g, "\n").trim();
  assert.equal(norm(body(sql.slice(0, burstStart) + sql.slice(burstEnd))), norm(body(prev)), "the rest is the 202609230008 body, unchanged");
  const burst = sql.slice(burstStart, burstEnd);
  assert.match(burst, /'edge burst: ' \|\| b\.slug/);
  assert.match(burst, /i\.invoked_at > v_now - interval '1 hour'/);
  assert.match(burst, /having count\(\*\) > 3/);
  assert.match(burst, /r\.timed_out or r\.error_msg is not null or r\.status_code is null\s+or r\.status_code < 200 or r\.status_code >= 300/);
  assert.doesNotMatch(sql, /create or replace function public\.job_health_status/i, "the public status is not redefined");
});

test("the alert workflow runs hourly and still needs no secret", () => {
  assert.match(wf, /- cron: "17 \* \* \* \*"/);
  const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN/);
});
