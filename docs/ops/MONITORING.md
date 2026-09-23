# Monitoring and alerting

Launch-readiness audit, MON-1. Before this document there was no monitoring
configuration anywhere in the repository and no way to answer "is the
backend actually doing its job" other than opening the app and looking.

## Why this exists, concretely

`purge_due_accounts()` — the function that implements `PRIVACY.md`'s promise
to erase an account 30 days after deletion is requested — was written,
correct, granted, and **never scheduled**. Nobody noticed for the life of
the project, because a job that does not run emits nothing: no error, no
row, no failure. It was found by reading migrations, not by any signal.

Everything below exists so that class of failure is loud instead of silent.

## 1. Scheduled jobs (highest value — start here)

Since `202609190001` this is **automatic**, and it needs no credential.
There are three surfaces, in order of how you will actually meet them.

### 1a. The hourly check, and the in-app alert

`public.job_health_check()` runs every hour as the pg_cron job
`job-health-check`. It flags every job that is inactive, recorded a
`failed` run in the last 24 hours, has not run within its own cadence
window, or has never run **and was first seen more than one cadence
window ago** — and on a problem it notifies **every admin** in-app,
through the ordinary notifications path, as a `job_health_alert` (title
"תקלה בעבודות המתוזמנות", body = the count).

Re-alerting is rate-limited on purpose: the first problem, any change to
the set of failing jobs, and otherwise at most once every six hours. A
gate that fires 168 times a week gets muted, and a muted gate is how
`purge_due_accounts()` went unnoticed in the first place.

A run that is **in progress** is not a failure — pg_cron writes a
`running` row at the start of every run and `notif-batch-flush` runs every
15 minutes, so treating in-progress as failure would page the admins about
a job that is working. A genuinely stuck run is caught one cadence window
later by the staleness clause.

A job that has **never run yet** gets one cadence window of grace from the
first time the check saw it (`202609220001`). Until `202609220001` a job was
flagged from the instant it was scheduled, which reported `recap_monthly`
(`'41 4 1 * *'`, created after 2026-09-01) as failing every hour until its
first run on 2026-10-01 — a month of admin notifications and a month of red
CI over a job doing exactly what it was told. The grace is per cadence, so a
new hourly job is flagged after 3 hours and a new monthly one after 35 days;
it covers the *absence* of a run only, and a job that ran and **failed** is
flagged on its first run with no grace at all. The `purge_due_accounts()`
state — scheduled but never running — is still caught, one window later than
before.

The first-seen stamps live in `public.job_health_state.first_seen`, a
`{"<jobid>": "<timestamptz>"}` map rebuilt from `cron.job` on every run:
pg_cron records no creation time anywhere, so the checker has to remember.
Rebuilding is what prunes it — an unscheduled job loses its key in the same
run, and a job that is unscheduled and scheduled again gets a new `jobid` and
therefore a new window.

### 1b. The external backstop, with no service-role key

`.github/workflows/scheduled-job-alert.yml` runs every six hours and calls
`public.job_health_status()` — **the one function in `public` that is
executable by `anon`** — with the publishable key from `cloud-config.js`.
It returns three fields and takes no arguments:

```sql
select * from public.job_health_status();
--  ok | failing_count |      last_checked_at
```

**It fails when `ok` is false, or when `last_checked_at` is older than two
hours.** The second half is the more important one: `ok` is a stored
opinion, and if the hourly check has itself died, a frozen `ok: true`
reads exactly like a healthy backend. Two hours tolerates one missed
hourly run and not two.

This replaced a workflow that held `SUPABASE_SERVICE_ROLE_KEY` — a
credential that bypasses every RLS policy on real member data — in GitHub
Actions to answer a yes/no question. **Do not reintroduce it.** The only
secret left in that workflow is the optional `ALERT_WEBHOOK_URL`.

**Its red run history, read correctly (checked 2026-09-22).** Every run of
this workflow from its first, on 2026-09-09, to 2026-09-22 is red — but for
two different reasons, and neither is the current code:

- **2026-09-09 to 2026-09-18: missing secrets.** The old script exited 2 with
  *"SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY missing"* (read from the
  log of run 35313987165). That was the fail-closed design working; the
  secrets were never added. PR #14 (merged 2026-09-19) removed the reason —
  there is no secret to add any more.
- **2026-09-19 onward: no runner.** The free Actions allowance ran out on
  2026-09-19. Every run since finishes in about two seconds with
  `runner_id: 0`, no steps and `HTTP 404` on the log download — the job never
  started, so it says nothing about the backend in either direction. This
  clears when the allowance resets on 2026-10-01.

So nothing in this workflow or its script still fails for a reason a code
change can fix. Two things to check on the first run after 2026-10-01:

1. **It is the first run of the current script anywhere.** It has never
   executed in CI; a red on that run is new information, not the old red.
2. **`202609220001_a_new_job_gets_its_first_window` must be applied to
   production first.** Without it, `recap_monthly` (first run 2026-10-01
   04:41 UTC) counts as never-run and failing until it has run, so `ok` is
   false and the 00:00 UTC run that day goes red for a job doing what it was
   told (the in-database check would be alerting admins in-app for the
   same reason meanwhile). At the time of this
   note the latest migration recorded as applied is `202609190001`; confirm
   with `npm run check:drift`, not with this line.

### 1c. The operator view, when you need the names

`public.scheduled_job_health()` (migrations `202609060016` /
`202609060018`, re-declared by `202609190001`, **service_role only**)
returns one row per pg_cron job with its schedule, last run, that run's
status, and a conservative `healthy` boolean. Run it from the SQL editor
or psql when an alert has already told you something is wrong — never from
CI, which is the whole point of 1b.

```sql
select jobname, last_status, last_run, seconds_since_last_run
  from public.scheduled_job_health()
 where not healthy;

-- or, the same names as the hourly check saw them:
select failing_jobs, failing_count, last_checked_at, first_seen
  from public.job_health_state;
```

`healthy` is false when a job is inactive, when its last run failed, when
it has never run at all, or when it last ran longer ago than
`public.cron_cadence_window(its schedule)` allows — **35 days** for a
monthly job, **9 days** weekly, **2 days** daily, **3 hours** for anything
hourly or faster, i.e. roughly two of the job's own intervals. (A flat
8-day window was `202609060016`'s original rule and was wrong: it made
`recap_monthly` report unhealthy for ~23 days of every month. Fixed in
`202609060018`; the expression now lives in one place,
`cron_cadence_window()`, so the two checkers cannot drift apart.)

A job that has never run reports `last_status = 'never run'` — the exact
state `purge_due_accounts()` sat in.

**This view deliberately does not carry `202609220001`'s first-window
grace**, so a just-scheduled job reads `healthy = false` here while the
hourly check leaves it alone. That is not drift: this view pages nobody, it
is read by a human who has already been told to look, and it prints the job
name and `last_status = 'never run'` in the same row — so the reader can tell
"scheduled yesterday" from "dead" without the function guessing for them.
`job_health_check()` has no such reader; it sends a notification, which is
why the false positive had to be fixed there.

**Expected jobs** (11, as of `202609190001`):

| Job | Cadence | If it stops |
|---|---|---|
| `purge-due-accounts` | daily 03:29 (03:59 before 202609230002) | **The 30-day deletion promise stops being kept.** Highest-severity of the set — it is a privacy commitment, not a feature. |
| `purge-abandoned-profiles` | daily 03:31 | Abandoned anonymous accounts accumulate, **and deleted members' photos stay in Storage** — this run also drains `storage_erasure_queue` (202609230002). Rows older than a day in that queue mean `storage.remove()` is failing: `select count(*), max(attempts) from public.storage_erasure_queue;` |
| `telemetry-retention-purge` | daily 03:47 | The 90-day community-activity retention promise stops being kept (feed impressions, feed interactions, analytics events and app-open days since 202609230002) |
| `idempotency-purge` | daily 03:19 | `request_idempotency` grows without bound |
| `notif-batch-flush` | every 15 min | Batched notifications are never delivered |
| `chal-notify-ending-soon` | hourly | "Challenge ending soon" never fires |
| `coach-engagement-decline` | daily 06:17 | Coaches stop seeing at-risk members |
| `recap-weekly` | Mon 05:11 | No weekly recaps (needs Vault secrets set) |
| `recap_monthly` | 1st 04:41 | No monthly club recap |
| `community-health` | Mon 04:43 | `community_health_scores` stops updating |
| `job-health-check` | hourly :53 | **Nothing is watching any of the others.** The `scheduled-job-alert` workflow catches this one specifically, via `last_checked_at` — see §1b. |

`feed-weights-recompute` was deliberately **unscheduled** (`202609060015`,
FEAT-010) because the function it called is an empty stub. Its absence is
correct; if it reappears without the derivation being built, that is a
regression.

Three of these (`recap-weekly`, `purge-abandoned-profiles`,
`notif-push-send`) reach Edge Functions through `cron_invoke_edge_function()`
and are **inert until the Vault secrets are set**. They used to report
`succeeded` regardless, because the cron job's SQL succeeded — that is
launch-readiness **S6**, and `202609230008` closed it.

`job_health_check()` now flags two things it could not see before:

- **The secrets are still placeholders.** If any scheduled job exists to
  invoke an Edge Function while `edge_functions_base_url` or
  `edge_functions_service_role_key` is unset or still a placeholder, the board
  reports `edge functions: Vault secrets unset or still placeholders`. Every
  one of those jobs is a no-op that reports success, and that is now said out
  loud rather than inferred from a runbook.
- **The Edge Function answered badly.** `cron_invoke_edge_function()` is
  fire-and-forget: `net.http_post` queues the request and the response lands
  in `net._http_response` under a request id that nothing used to remember the
  purpose of. It now writes that id and the slug into
  `public.edge_function_invocations`, so a non-2xx, a timeout or a transport
  error is reported as `edge: <slug>` rather than as an anonymous failure.
  Only the latest invocation of each slug counts, over a 24-hour window, so a
  500 that has since recovered stops being reported.

**Expect the board to go red the first time this runs in a project whose
secrets are unset.** That is the fix working: the jobs were always inert, and
the only thing that changed is that the monitoring stopped agreeing they were
fine. Set the two Vault secrets (§4) and it clears on the next hourly run.

Neither addition reaches `job_health_status()`, the one function `anon` may
call — it still returns only `ok`, `failing_count` and `last_checked_at`.
Which job is failing, and whether a deployment is configured, stay in
`failing_jobs`, which is operator-only.

## 2. Authentication and abuse

Supabase dashboard → Authentication → Logs. Watch for:

- A spike in anonymous sign-ups. With CAPTCHA enabled (SEC-004) this should
  be low and human-shaped; a spike means either the CAPTCHA is
  misconfigured or it is being bypassed.
- Repeated failed `signInWithPassword` against many usernames — credential
  stuffing. Usernames are club-public via the member directory, so this is
  a realistic attack.

```sql
-- Invite-code guessing. The throttle allows 5 per 15 min per actor;
-- sustained pressure means somebody is working through the space.
select count(*), date_trunc('hour', created_at) as hour
  from public.invite_attempts
 where created_at > now() - interval '24 hours'
 group by 2 order by 2 desc;
```

## 3. Rate limits actually firing

```sql
select action, count(*), max(attempt_count)
  from public.rate_limits
 where window_started_at > now() - interval '1 hour'
 group by action order by 3 desc;
```

A limit being hit occasionally is the system working. `post_create` or
`private_record_write` pinned at its ceiling for a single user, repeatedly,
is either abuse or a client retry loop — both worth looking at.

## 4. Edge Functions

Supabase dashboard → Edge Functions → Logs, for `recap_weekly`,
`purge_abandoned_profiles`, `admin_reset_password`.

`cron_invoke_edge_function()` dispatches asynchronously through `pg_net`, so
**a cron job reporting `succeeded` only means the request was queued**. The
function's own outcome is in:

```sql
select * from net._http_response order by created desc limit 20;
```

This is the one place where "the job is green" and "the work happened" can
genuinely disagree. Check it after any change to the recap or purge
functions.

## 5. Moderation backlog

```sql
select count(*) from public.reports where status = 'open';
```

Not a system-health metric — a duty-of-care one. A backlog that keeps
growing means reports are being filed and not reviewed.

## 6. Keeping the project from pausing (pre-launch)

### What Supabase actually says, and what it does not

Supabase pauses a Free-plan project that goes quiet:

> A Free plan project is considered inactive if it does not receive sufficient
> user database activity over the past week.
> — [Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)

and, on the same page, *"typically a few user requests to the database each day
over the previous week is enough to keep the project from being paused."*
[Going into prod](https://supabase.com/docs/guides/platform/going-into-prod)
adds only *"we may pause applications on the Free Plan that exhibit low
activity in a 7-day period."*

**Supabase does not document whether a `pg_cron` job running inside the project
counts.** Checked 2026-09-23 against both pages above: neither distinguishes
between a request arriving from outside and work the database does to itself,
and the only qualifier either gives is the word *user* — "user database
activity", "user requests". Community answers disagree with each other, and
none of them is Supabase saying so.

This project runs `pg_cron` every six hours already
([§1a](#1a-the-hourly-check-and-the-in-app-alert)). If internal activity
counted, nothing more would be needed. **We do not rely on that**, because the
cost of being wrong is the whole app going dark before launch, and the cost of
being right anyway is one REST call every two days. The heartbeat therefore
comes from outside, over the same public REST API a signed-out browser uses.

### What the heartbeat calls, and why that one

`public.job_health_status()` — the **only** thing `anon` may execute in this
project. `202609170001` revoked anon `EXECUTE` on everything else, and no table
is anon-selectable. Verified against production 2026-09-23:

```
POST /rest/v1/rpc/job_health_status   ->  200, 84 bytes, 1.3s
GET  /rest/v1/profiles?select=id      ->  401
```

It matters that the call is an **RPC and not a 401**: an RPC runs a real
function in Postgres, which is the activity being counted. A rejected request
may never reach the database at all, so a heartbeat that 401s could keep the
logs busy while the project pauses anyway. If the ping target is ever changed,
the replacement must be anon-callable for the same reason;
`test/keepalive-heartbeat.test.mjs` pins it.

**Never a service-role key.** The call needs no privilege, the publishable key
already ships to every browser in `cloud-config.js`, and the Worker refuses to
run if the key it is handed looks like a secret one.

### The two paths

| | Primary | Fallback |
|---|---|---|
| Where | Cloudflare Worker, `workers/keepalive/` | `.github/workflows/keepalive.yml` |
| Cadence | `14 7 */2 * *` (every 2 days, 07:14 UTC) | `44 7 */2 * *`, **commented out** |
| Status | to be deployed | disabled until Actions minutes reset 2026-10-01 |

They fail for different reasons — a Cloudflare account or Worker problem on one
side, an exhausted Actions budget or a disabled workflow on the other — which
is the point of having two. Run both once the minutes are back; two heartbeats
two days apart is about one call a day against a seven-day threshold.

`*/2` on day-of-month means days 1, 3, 5 … 31, so the gap after a 31-day month
is one day rather than two. That is the harmless direction to be wrong in.

### Deploying the Worker — exactly what to click

You need this once. The Worker is in the repository; nothing here is secret.

1. **Install and sign in** (from the repository root):
   ```bash
   npx wrangler login
   ```
   A browser tab opens on `dash.cloudflare.com`. Click **Allow** on the
   "Wrangler is requesting access" screen. If you have more than one account,
   pick the one that owns **haimunia-app** (Pages).

2. **Check it before deploying anything.** This runs the Worker locally and
   fires the cron path by hand — it makes one real call to the project:
   ```bash
   cd workers/keepalive
   npx wrangler dev --test-scheduled
   ```
   In a second terminal:
   ```bash
   curl "http://localhost:8787/__scheduled?cron=14+7+*/2+*+*"
   ```
   The first terminal should print `keepalive: ok http=200 in …ms body=[{"ok":true,…`.
   Press `Ctrl+C` to stop.

3. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   It prints the Worker name and the cron trigger it registered.

4. **Confirm the schedule in the dashboard.** In Cloudflare:
   **Workers & Pages** → **haimunia-keepalive** → **Settings** → **Triggers**.
   Under **Cron Triggers** you should see `14 7 */2 * *`. If the section is
   empty, the deploy did not register it — re-run step 3 from inside
   `workers/keepalive/` so `wrangler.toml` is the one in scope.

5. **Read the first real run.** Same Worker → **Logs** → **Begin log stream**,
   or:
   ```bash
   npx wrangler tail haimunia-keepalive
   ```
   A healthy line reads `keepalive: ok http=200 …`. A failure reads
   `keepalive: FAILED http=… ` and is loud on purpose.

**What to do if it ever fails.** Open the app. If it loads, the heartbeat
broke, not the project — check the key in `wrangler.toml` still matches
`cloud-config.js`. If the app does not load, the project may already be paused:
un-pause it from the Supabase dashboard (**Project Settings** → **General**),
then fix the heartbeat.

### Enabling the Actions fallback after 2026-10-01

1. Uncomment the `schedule:` block in `.github/workflows/keepalive.yml`.
2. Update `test/keepalive-heartbeat.test.mjs` — one assertion pins the schedule
   as commented, and it is meant to be changed in that same commit.
3. **Actions** tab → **keepalive** → **Run workflow**, and read the log once.

---

## What is deliberately NOT monitored

No third-party APM, error-tracking SDK, or analytics vendor is wired in, and
none should be added casually: the app ships a strict CSP with no CDN in
`script-src` and a `connect-src` pinned to the Supabase project (SEC-015
leans on both). Adding a monitoring SDK means widening that policy, which
trades a real XSS mitigation for observability. If it is ever done, it
should be a deliberate, documented decision with the same scrutiny the
CAPTCHA hosts got — not a dependency someone adds in passing.
