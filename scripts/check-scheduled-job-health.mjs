#!/usr/bin/env node
// Go-live guide, item A.5 - the scheduled-job alert, with no service-role key.
//
// WHAT CHANGED, 2026-09-19 (migration 202609190001). This script used to call
// `public.scheduled_job_health()`, which is service_role only by design - it
// returns every job's name, schedule, last status and staleness - so the
// workflow around it needed SUPABASE_SERVICE_ROLE_KEY in a GitHub secret. That
// key bypasses every RLS policy on real members' posts, profiles and training
// logs. Holding a full-database credential in CI to answer a yes/no question
// was a blast radius nobody was getting value from, and the old version of
// this file said so itself: "if it's ever worth narrowing, the shape would be
// a purpose-made Postgres role plus a SECURITY DEFINER function returning only
// job name + healthy boolean".
//
// It is now narrower than that. The check RUNS INSIDE THE DATABASE, hourly, as
// the pg_cron job `job-health-check`; it is the thing that knows job names and
// error text, and it notifies the club's admins in-app through the ordinary
// notifications path. This script only reads the verdict, through
// `public.job_health_status()`, which returns three fields and takes no
// arguments:
//
//     ok              boolean      - is every scheduled job healthy
//     failing_count   integer      - how many are not
//     last_checked_at timestamptz  - when the in-database check last ran
//
// No job names. No schedules. No error text. No member data. So it runs with
// the PUBLISHABLE key that is already committed in cloud-config.js and already
// served to every browser - the same reasoning, and the same key, as
// check-edge-functions-deployed.mjs. There is no secret in this path at all,
// which also means it works unchanged on a fork.
//
// WHY last_checked_at IS HALF THE CHECK, and the more important half. `ok`
// alone is worthless the moment the in-database check stops running: a frozen
// row reads exactly like a healthy one. That is the same silent-failure shape
// as purge_due_accounts(), which sat unscheduled for the life of the project
// because a job that does not run emits nothing. So a stamp older than
// MAX_AGE_MINUTES is a FAILURE here, not a warning - "the monitor is dead" and
// "everything is fine" must never produce the same exit code.
//
// Exit codes, deliberately three and not two:
//   0 - checked, and the backend reports every scheduled job healthy.
//   1 - checked, and something is wrong: ok=false, or the verdict is stale.
//   2 - could not complete the check at all (network, HTTP error, unexpected
//       response shape). Also alerts. "The checker itself is broken" must not
//       look like "all clear" to whoever is watching CI's green and red.
//
// Optional: ALERT_WEBHOOK_URL - any endpoint that accepts a JSON POST with a
// "text" field (Slack and Discord incoming webhooks both work as-is). It is
// the one thing here that is still a secret, and it is OPTIONAL: with it unset
// the workflow's own red run is the alert, and the message is printed instead.
//
// SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY may be set in the environment to
// point this at another project; with neither set it reads cloud-config.js,
// which is the normal case.
//
//   node scripts/check-scheduled-job-health.mjs
//
// KNOWN BLIND SPOT, carried over unchanged and still open (VAULT-1, found
// 2026-09-08, GO_LIVE_GUIDE.md A.4/A.5). `recap-weekly` and
// `purge-abandoned-profiles` reach their Edge Functions through
// cron_invoke_edge_function(), which answers unset/placeholder Vault secrets
// with `raise notice` + `return null` rather than an exception. The cron job's
// SQL therefore completes normally and pg_cron records 'succeeded' even when
// no HTTP request left the database. job_health_check() reads the same run
// status, so for those two jobs "healthy" still means only "the SQL ran".
// Closing it needs a check against net._http_response, which is a separate
// change; it is written down here rather than silently trusted.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Two hours. The in-database check runs hourly, so this tolerates exactly one
// missed run and not two - the same "roughly two intervals" rule
// public.cron_cadence_window() applies to every other job, applied here to the
// checker itself. Tighter would alarm on a single slow hour; looser would let
// the monitor be dead for most of a working day.
const MAX_AGE_MINUTES = 120;

function readConfig() {
  const src = readFileSync(path.join(root, "cloud-config.js"), "utf8");
  const url = src.match(/supabaseUrl:\s*"([^"]+)"/);
  const key = src.match(/supabasePublishableKey:\s*"([^"]+)"/);
  return { url: url && url[1], key: key && key[1] };
}

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

async function postAlert(text) {
  if (!WEBHOOK_URL) {
    console.error("ALERT_WEBHOOK_URL not set - cannot deliver this alert, printing instead:\n" + text);
    return;
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`Webhook POST failed: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error("Webhook POST threw:", err?.message || err);
  }
}

async function main() {
  const cfg = {
    url: process.env.SUPABASE_URL || readConfig().url,
    key: process.env.SUPABASE_PUBLISHABLE_KEY || readConfig().key,
  };
  if (!cfg.url || !cfg.key || /YOUR_|example\.supabase/.test(cfg.url)) {
    const msg = "scheduled-job-health check misconfigured: no usable project URL/publishable key in cloud-config.js or the environment. The check did not run - that is not the same as \"all jobs healthy\".";
    console.error(msg);
    await postAlert(`⚠️ ${msg}`);
    process.exit(2);
  }

  let row;
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, "")}/rest/v1/rpc/job_health_status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: "{}",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    const payload = await res.json();
    // PostgREST returns a set-returning function as an array. One row, always.
    row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row.ok !== "boolean" || typeof row.last_checked_at !== "string") {
      throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 300)}`);
    }
  } catch (err) {
    const msg = `scheduled-job-health check could not reach the database: ${err?.message || err}. Treat as unverified, not healthy.`;
    console.error(msg);
    await postAlert(`⚠️ ${msg}`);
    process.exit(2);
  }

  const checkedAt = new Date(row.last_checked_at);
  if (Number.isNaN(checkedAt.getTime())) {
    const msg = `scheduled-job-health check got an unparseable last_checked_at (${row.last_checked_at}). Treat as unverified, not healthy.`;
    console.error(msg);
    await postAlert(`⚠️ ${msg}`);
    process.exit(2);
  }
  const ageMinutes = Math.round((Date.now() - checkedAt.getTime()) / 60000);
  const failing = Number(row.failing_count) || 0;

  const problems = [];
  // The stale case is listed FIRST on purpose: if the in-database check has
  // stopped running, `ok` is a stale opinion and says nothing about now.
  if (ageMinutes > MAX_AGE_MINUTES) {
    problems.push(
      `the in-database check last ran ${ageMinutes} minutes ago (limit ${MAX_AGE_MINUTES}). ` +
      `The hourly 'job-health-check' cron job may itself have stopped - which means NOTHING is watching the others.`
    );
  }
  if (row.ok === false) {
    problems.push(`${failing} scheduled job(s) are failing. The club's admins have been notified in-app.`);
  }

  if (problems.length === 0) {
    console.log(
      `scheduled-job-health: ok=true, failing_count=${failing}, last checked ${ageMinutes} minute(s) ago.`
    );
    process.exit(0);
  }

  const msg =
    `🔴 scheduled-job-health: ${problems.join(" ")}\n\n` +
    `Operator view (service_role, from the SQL editor or psql - never from CI):\n` +
    `  select * from public.scheduled_job_health() where not healthy;\n` +
    `  select failing_jobs, last_checked_at from public.job_health_state;`;
  console.error(msg);
  await postAlert(msg);
  process.exit(1);
}

main();
