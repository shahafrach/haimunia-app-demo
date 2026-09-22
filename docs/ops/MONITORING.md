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
| `purge-due-accounts` | daily 03:59 | **The 30-day deletion promise stops being kept.** Highest-severity of the set — it is a privacy commitment, not a feature. |
| `purge-abandoned-profiles` | daily 03:31 | Abandoned anonymous accounts accumulate |
| `telemetry-retention-purge` | daily 03:47 | The 90-day analytics retention promise stops being kept |
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

Two of these (`recap-weekly`, `purge-abandoned-profiles`) reach Edge
Functions through `cron_invoke_edge_function()` and are **inert until the
Vault secrets are set**. They will report `succeeded` regardless, because
the cron job's SQL succeeded — see §4.

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

## What is deliberately NOT monitored

No third-party APM, error-tracking SDK, or analytics vendor is wired in, and
none should be added casually: the app ships a strict CSP with no CDN in
`script-src` and a `connect-src` pinned to the Supabase project (SEC-015
leans on both). Adding a monitoring SDK means widening that policy, which
trades a real XSS mitigation for observability. If it is ever done, it
should be a deliberate, documented decision with the same scrutiny the
CAPTCHA hosts got — not a dependency someone adds in passing.
