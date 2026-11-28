// Free-tier health, once a day (Q-50, Grok backend PRR 2026-11-19): the project is on the Supabase
// free plan, and a free project that is paused, full or over quota does not page anyone. keepalive.yml
// only pings; this reads the numbers and fails loud before a limit is hit.
//
//   status        GET /v1/projects/{ref}               must be ACTIVE_HEALTHY
//   database size POST /v1/projects/{ref}/database/query  fail above 400 MB (the free plan stops at 500)
//   invocations   NOT CHECKED (Q-66), and said so on every run. This used logs.all, which has answered
//                 HTTP 410 since 2026-11-22: the endpoint is gone. Its replacements either need one call
//                 per function (functions.combined-stats) or do not clearly count invocations
//                 (usage.api-counts), so the metric is dropped rather than guessed. Read it on the
//                 organization's usage page (docs/ops/MONITORING.md).
//   egress        NOT CHECKED, and said so on every run. The Management API has no egress figure, and
//                 the edge logs carry no response bytes. Read it on the same usage page.
//
// Exit codes: 0 checked and healthy, 1 checked and over a line, 2 could not check (a timeout, a 5xx, a
// 429, a bad token), 3 the check itself is broken (the API answered 404 or 410: an endpoint this script
// uses is gone, so the script needs fixing - not a quota problem). Needs SUPABASE_ACCESS_TOKEN; reads no
// member data (one pg_database_size()).
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MB = 1024 * 1024;
export const DB_LIMIT_BYTES = 400 * MB;
export const DB_SIZE_SQL = "select pg_database_size(current_database())::bigint as bytes";

/** m: { status, dbBytes }. Returns { ok, lines, problems }. */
export function evaluate(m) {
  const problems = [];
  const lines = [];
  lines.push(`project status: ${m.status}`);
  if (m.status !== "ACTIVE_HEALTHY") problems.push(`project status is ${m.status}, not ACTIVE_HEALTHY (paused or unhealthy: restore it from the dashboard)`);
  const dbMb = m.dbBytes / MB;
  lines.push(`database size: ${dbMb.toFixed(1)} MB of 500 MB (alert above ${DB_LIMIT_BYTES / MB} MB)`);
  if (m.dbBytes > DB_LIMIT_BYTES) problems.push(`database is ${dbMb.toFixed(1)} MB, above ${DB_LIMIT_BYTES / MB} MB; the free plan goes read-only at 500 MB`);
  lines.push("edge function invocations: not checked here; read them on the organization's usage page (docs/ops/MONITORING.md)");
  lines.push("egress: not available from the Management API; read it on the organization's usage page (docs/ops/MONITORING.md)");
  return { ok: problems.length === 0, lines, problems };
}

/** An answer from the Management API that was not 2xx; `status` is the HTTP status. */
export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = "ApiError"; this.status = status; }
}

async function api(path, token, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.supabase.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new ApiError(`${init.method || "GET"} ${path.replace(/\?.*$/, "")} answered HTTP ${res.status}`, res.status);
  return res.json();
}

export async function measure(ref, token, { fetchImpl = fetch } = {}) {
  const project = await api(`/v1/projects/${ref}`, token, {}, fetchImpl);
  const rows = await api(`/v1/projects/${ref}/database/query`, token, { method: "POST", body: JSON.stringify({ query: DB_SIZE_SQL }) }, fetchImpl);
  const dbBytes = Number(rows?.[0]?.bytes);
  if (typeof project?.status !== "string" || !Number.isFinite(dbBytes)) {
    throw new Error("an answer did not have the expected shape");
  }
  return { status: project.status, dbBytes };
}

/**
 * Q-66: why a measurement failed. 404 and 410 mean the API no longer has what this script asks for: the check is
 * broken and needs a code change (exit 3). Anything else - a timeout, a 5xx, a 429, a bad token, a reshaped
 * answer - is "could not check this time" (exit 2). Neither is "quota near the limit" (exit 1).
 */
export function classifyFailure(err, ref) {
  const why = err?.message || String(err);
  if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
    return { exitCode: 3, message: `free-tier check is BROKEN for ${ref}: ${why}. The Management API endpoint it uses is gone; fix scripts/check-free-tier.mjs. This is not a quota problem.` };
  }
  return { exitCode: 2, message: `free-tier check could not check ${ref}: ${why}` };
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
    const f = classifyFailure(e, ref);
    console.error("::error::" + f.message);
    summary(["## Free-tier health", "", f.exitCode === 3 ? "**Check broken** (not a quota problem):" : "**Could not check:**", "", f.message].join("\n"));
    await postAlert(f.message);
    process.exit(f.exitCode);
  }
  const out = evaluate(m);
  console.log(out.lines.join("\n"));
  summary(["## Free-tier health", "", "```", ...out.lines, "```"].join("\n"));
  console.log("::warning::egress and Edge Function invocations are not checked here: read them on the organization's usage page.");
  if (out.ok) process.exit(0);
  for (const p of out.problems) console.log("::error::" + p);
  await postAlert(`Free-tier alert for ${ref}:\n- ${out.problems.join("\n- ")}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
