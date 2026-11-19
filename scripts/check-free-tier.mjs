// Free-tier health, once a day (Q-50, Grok backend PRR 2026-11-19): the project is on the Supabase
// free plan, and a free project that is paused, full or over quota does not page anyone. keepalive.yml
// only pings; this reads the numbers and fails loud before a limit is hit.
//
//   status        GET /v1/projects/{ref}               must be ACTIVE_HEALTHY
//   database size POST /v1/projects/{ref}/database/query  fail above 400 MB (the free plan stops at 500)
//   invocations   GET /v1/projects/{ref}/analytics/endpoints/logs.all  Edge Function calls in the last
//                 24 hours, times 30, against 80% of the free 500,000 a month. The free plan keeps one
//                 day of logs, so a projection from that day is the most the API can say.
//   egress        NOT CHECKED, and said so on every run. The Management API has no egress figure, and
//                 the edge logs carry no response bytes ("These logs currently do not include response
//                 byte data", Supabase docs, Manage Egress usage). The owner reads it on the
//                 organization's usage page (docs/ops/MONITORING.md).
//
// Exit codes, the same discipline as check-scheduled-job-health.mjs: 0 checked and healthy, 1 checked
// and over a line, 2 could not check. Needs SUPABASE_ACCESS_TOKEN; reads no member data (one
// pg_database_size() and one count of log lines).
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MB = 1024 * 1024;
export const DB_LIMIT_BYTES = 400 * MB;
export const FREE_INVOCATIONS_PER_MONTH = 500_000;
export const QUOTA_SHARE = 0.8;
export const INVOCATIONS_SQL = "select count(*) as n from function_edge_logs";
export const DB_SIZE_SQL = "select pg_database_size(current_database())::bigint as bytes";

/** m: { status, dbBytes, invocations24h }. Returns { ok, lines, problems }. */
export function evaluate(m) {
  const problems = [];
  const lines = [];
  lines.push(`project status: ${m.status}`);
  if (m.status !== "ACTIVE_HEALTHY") problems.push(`project status is ${m.status}, not ACTIVE_HEALTHY (paused or unhealthy: restore it from the dashboard)`);
  const dbMb = m.dbBytes / MB;
  lines.push(`database size: ${dbMb.toFixed(1)} MB of 500 MB (alert above ${DB_LIMIT_BYTES / MB} MB)`);
  if (m.dbBytes > DB_LIMIT_BYTES) problems.push(`database is ${dbMb.toFixed(1)} MB, above ${DB_LIMIT_BYTES / MB} MB; the free plan goes read-only at 500 MB`);
  const monthly = m.invocations24h * 30;
  const line = FREE_INVOCATIONS_PER_MONTH * QUOTA_SHARE;
  lines.push(`edge function invocations: ${m.invocations24h} in 24 h, about ${monthly} a month of ${FREE_INVOCATIONS_PER_MONTH} (alert above ${line})`);
  if (monthly > line) problems.push(`edge function invocations project to ${monthly} a month, above 80% of the free ${FREE_INVOCATIONS_PER_MONTH}`);
  lines.push("egress: not available from the Management API; read it on the organization's usage page (docs/ops/MONITORING.md)");
  return { ok: problems.length === 0, lines, problems };
}

async function api(path, token, init = {}) {
  const res = await fetch(`https://api.supabase.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.replace(/\?.*$/, "")} answered HTTP ${res.status}`);
  return res.json();
}

export async function measure(ref, token, now = Date.now()) {
  const project = await api(`/v1/projects/${ref}`, token);
  const rows = await api(`/v1/projects/${ref}/database/query`, token, { method: "POST", body: JSON.stringify({ query: DB_SIZE_SQL }) });
  const q = new URLSearchParams({
    sql: INVOCATIONS_SQL,
    iso_timestamp_start: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    iso_timestamp_end: new Date(now).toISOString(),
  });
  const logs = await api(`/v1/projects/${ref}/analytics/endpoints/logs.all?${q}`, token);
  if (logs?.error) throw new Error("logs.all answered an error");
  const dbBytes = Number(rows?.[0]?.bytes);
  const invocations24h = Number(logs?.result?.[0]?.n ?? 0);
  if (typeof project?.status !== "string" || !Number.isFinite(dbBytes) || !Number.isFinite(invocations24h)) {
    throw new Error("an answer did not have the expected shape");
  }
  return { status: project.status, dbBytes, invocations24h };
}

async function postAlert(text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch (e) {
    console.error("Webhook POST threw:", e?.message || e);
  }
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error("::error::SUPABASE_ACCESS_TOKEN is not set: the free-tier check could not run.");
    process.exit(2);
  }
  const ref = readFileSync(new URL("../supabase/PROJECT_REF", import.meta.url), "utf8").trim();
  let m;
  try {
    m = await measure(ref, token);
  } catch (e) {
    const msg = `free-tier check could not check ${ref}: ${e?.message || e}`;
    console.error("::error::" + msg);
    await postAlert(msg);
    process.exit(2);
  }
  const out = evaluate(m);
  console.log(out.lines.join("\n"));
  summary(["## Free-tier health", "", "```", ...out.lines, "```"].join("\n"));
  console.log("::warning::egress is not checked here: the Management API does not report it.");
  if (out.ok) process.exit(0);
  for (const p of out.problems) console.log("::error::" + p);
  await postAlert(`Free-tier alert for ${ref}:\n- ${out.problems.join("\n- ")}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
