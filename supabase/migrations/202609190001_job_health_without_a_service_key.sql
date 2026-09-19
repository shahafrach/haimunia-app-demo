begin;

-- Watch the pg_cron jobs from CI without a service-role key in GitHub.
--
-- THE PROBLEM. `.github/workflows/scheduled-job-alert.yml` is the only thing
-- that pages a human when a scheduled job stops running, and the only way it
-- could ask the question was `public.scheduled_job_health()`, which is
-- service_role only - correctly so, since it names every job, its schedule
-- and its last error. So the workflow needed SUPABASE_SERVICE_ROLE_KEY in a
-- GitHub secret: a credential that bypasses every RLS policy on real members'
-- posts, profiles and training logs, sitting in a CI system, to answer a
-- yes/no question. That workflow's own header already called this out as an
-- accepted tradeoff and wrote down the shape of the fix:
--
--     "if it's ever worth narrowing, the shape would be a purpose-made
--      Postgres role plus a SECURITY DEFINER function returning only job
--      name + healthy boolean"
--
-- This is that fix, one step tighter: not even the job name. The check runs
-- INSIDE the database on pg_cron's own schedule and writes its verdict to a
-- row; the public surface reads that row and returns three fields.
--
-- THE SPLIT, and why it is two functions rather than one.
--
--   public.job_health_check()   - granted to nobody, runs hourly from cron.
--                                 Reads cron.job_run_details, decides which
--                                 jobs are failing, notifies the admins
--                                 through notif_create(), stamps
--                                 last_checked_at.
--   public.job_health_status()  - granted to ANON. Returns exactly
--                                 (ok, failing_count, last_checked_at) and
--                                 nothing else, ever.
--
-- The check is the thing that knows job names and error text. The status is
-- the thing the internet can call. Keeping them apart is what makes the anon
-- grant defensible: there is no argument, no filter and no column list a
-- caller can influence, so the surface cannot be widened by the caller.
--
-- WHY LAST_CHECKED_AT IS PART OF THE PUBLIC ANSWER. A monitor that can only
-- say "ok: true" is worthless the moment it stops running - a frozen row
-- reads exactly like a healthy one, which is the same silent-failure shape
-- purge_due_accounts() sat in for the life of the project and the reason
-- docs/ops/MONITORING.md exists at all. The caller compares
-- last_checked_at against now() and treats a stale stamp as a failure, so
-- "the checker is broken" cannot look like "all clear".
--
-- ANON REALLY DOES MEAN THE PUBLIC INTERNET. supabasePublishableKey is
-- committed in cloud-config.js and served to every browser, so anything
-- granted to anon is world-readable. What leaks here is three facts: that
-- some scheduled work exists, how many pieces of it are unhappy, and when
-- the question was last asked. No job name, no schedule, no error text, no
-- member data, no table. That is a deliberate, argued exception to the
-- "no function in public is anon-executable" rule that 202609170001 and
-- supabase/tests/0113 hold - 0113 is amended in the same change to allow
-- this one function BY NAME and by signature, so it still fails the build
-- the day a second one arrives by accident. It is not a relaxation of the
-- rule; it is one carve-out with a test around it.

create extension if not exists pg_cron;

-- =====================================================================
-- 1. The cadence window, extracted - one copy, not three
-- =====================================================================
-- 202609060016 shipped a flat 8-day staleness window and 202609060018 fixed
-- it with a per-cadence one, because a flat window made recap_monthly report
-- unhealthy ~23 days of every 30. That per-cadence `case` is the single most
-- load-bearing expression in this whole area and it was about to exist in two
-- places: scheduled_job_health() and the new check below. This repo's
-- characteristic defect is a right line with copies, one of which gets
-- missed, so it becomes a function BEFORE the second copy is written.
--
-- The intervals are 202609060018's, verbatim and unchanged - roughly two of
-- the job's own intervals, so one missed run is tolerated and two are not.
--
-- ONE THING IS ADDED, and it is a fix rather than a port. 202609060018's
-- expression assumes a five-field cron string, and reaches its FIRST arm -
-- 35 days - for anything else, because split_part() returns '' past the end
-- of the string and '' <> '*'. pg_cron also accepts the @hourly/@daily/
-- @weekly/@monthly aliases and an interval literal like '30 seconds', and
-- every one of those would have been given a 35-day staleness window: a job
-- scheduled '@hourly' could have been dead for a month before either checker
-- said a word. No job in this schema uses those forms today, so nothing was
-- ever wrong in production and this is a latent bug, not an incident - but
-- putting the expression in one shared place is exactly the moment to stop
-- carrying it. The aliases get their real cadence and anything still
-- unrecognised falls to the TIGHTEST window rather than the widest, so an
-- unknown schedule errs towards a false alarm somebody can dismiss instead
-- of a silence nobody can see.
create or replace function public.cron_cadence_window(p_schedule text)
returns interval
language sql immutable set search_path = '' as $$
  -- Split once, on any run of whitespace, and index the array - rather than
  -- four split_part(..., ' ', n) calls, which silently read the wrong field
  -- for a schedule written with two spaces between columns.
  with f as (
    select btrim(lower(coalesce(p_schedule, ''))) as nick,
           case when p_schedule is null then null
                else regexp_split_to_array(btrim(p_schedule), '\s+') end as parts
  )
  select case
    -- pg_cron's nickname forms, which have no fields to split.
    when f.nick in ('@yearly', '@annually', '@monthly') then interval '35 days'
    when f.nick = '@weekly' then interval '9 days'
    when f.nick in ('@daily', '@midnight') then interval '2 days'
    -- Anything that is not five whitespace-separated fields (an interval
    -- literal such as '30 seconds', '@hourly', a malformed string) is not a
    -- cron expression this can reason about. Tightest window, deliberately.
    when f.parts is null or array_length(f.parts, 1) <> 5 then interval '3 hours'
    -- field 3 = day of month; pinned means monthly or rarer
    when f.parts[3] <> '*' then interval '35 days'
    -- field 5 = day of week; pinned means weekly
    when f.parts[5] <> '*' then interval '9 days'
    -- field 2 = hour; pinned means once a day
    when f.parts[2] <> '*' then interval '2 days'
    -- everything else runs at least hourly
    else interval '3 hours'
  end
  from f;
$$;
revoke all on function public.cron_cadence_window(text) from public, anon, authenticated;
comment on function public.cron_cadence_window(text) is
  'How stale a pg_cron job''s last run may be before it counts as missed, derived from the job''s own five-field schedule: day-of-month pinned -> 35 days, day-of-week pinned -> 9 days, hour pinned -> 2 days, otherwise 3 hours. Roughly two of the job''s own intervals, so a single missed run is tolerated and two in a row are not. Lifted verbatim out of scheduled_job_health() (202609060018) when job_health_check() (202609190001) needed the same rule, so the expression has ONE home rather than a copy per caller - a flat window was the 202609060016 bug that made recap_monthly cry wolf for 23 days a month, and it must never be possible to fix one copy and miss the other.';

-- scheduled_job_health() re-declared over the helper. Behaviour is
-- IDENTICAL - the case expression moved, nothing about it changed - and
-- supabase/tests/0116 asserts the two agree for all four cadences. It is
-- re-stated here rather than left carrying its own copy precisely because
-- leaving it would create the twin this section exists to prevent.
-- Grants are re-stated too: CREATE OR REPLACE preserves the ACL, but a
-- function's exposure should be readable in the file that last defined it.
create or replace function public.scheduled_job_health()
returns table (
  jobname text,
  schedule text,
  active boolean,
  last_run timestamptz,
  last_status text,
  seconds_since_last_run numeric,
  healthy boolean
)
language sql stable security definer set search_path = '' as $$
  with last_runs as (
    select d.jobid, max(d.start_time) as last_run
      from cron.job_run_details d
     group by d.jobid
  ),
  latest as (
    select d.jobid, d.status, d.start_time
      from cron.job_run_details d
      join last_runs l on l.jobid = d.jobid and l.last_run = d.start_time
  )
  select j.jobname::text,
         j.schedule::text,
         j.active,
         latest.start_time as last_run,
         coalesce(latest.status, 'never run')::text as last_status,
         extract(epoch from (now() - latest.start_time))::numeric as seconds_since_last_run,
         coalesce(
           j.active
           and latest.status = 'succeeded'
           and latest.start_time > now() - public.cron_cadence_window(j.schedule::text),
           false) as healthy
    from cron.job j
    left join latest on latest.jobid = j.jobid
   order by j.jobname;
$$;
revoke all on function public.scheduled_job_health() from public, anon, authenticated;
grant execute on function public.scheduled_job_health() to service_role;
comment on function public.scheduled_job_health() is
  'Launch-readiness audit, MON-1. One row per pg_cron job: schedule, active flag, last run, that run''s status, and a `healthy` boolean. Unchanged in behaviour since 202609060018; re-declared by 202609190001 only so its per-cadence staleness window comes from public.cron_cadence_window() instead of an inline copy the new job_health_check() would have had to duplicate. A job that has NEVER run is unhealthy at any cadence, which is precisely the state purge_due_accounts sat in undetected. Read it with `select * from public.scheduled_job_health() where not healthy;`. service_role only - it names jobs and schedules, so it is the OPERATOR view; public.job_health_status() is the anon-safe three-field summary. See docs/ops/MONITORING.md.';

-- =====================================================================
-- 2. Who hears about it - the admin roster, also extracted
-- =====================================================================
-- 202609150005 resolved "every admin/owner" inline inside
-- bug_report_alert_recipients(), noting it was deliberately not
-- mod_alert_recipients() because a coach can moderate but cannot close a bug
-- report. That reasoning holds exactly as well here - a coach cannot fix a
-- stalled cron job either - and it would have produced a third verbatim copy
-- of the same two-source admin query.
--
-- So the QUERY moves into admin_alert_recipients() and
-- bug_report_alert_recipients() keeps its name and its contract as a wrapper.
-- 202609150005's argument was about not coupling "who moderates" to "who
-- hears about bugs"; those are still two different questions with two
-- different answers. "Who is an admin" is one question with one answer, and
-- it now has one implementation.
create or replace function public.admin_alert_recipients()
returns setof uuid
language sql stable security definer set search_path = '' as $$
  -- The two sources of admin-ness, checked directly, because my_role_code()
  -- answers only for the CALLER and this runs with no session at all: the
  -- legacy profiles.is_admin flag, and a redeemed role whose rank clears 50
  -- (admin/owner). That is is_admin()'s own definition expressed over the
  -- roster rather than over auth.uid().
  select p.id
  from public.profiles p
  where p.deleted_at is null
    and (
      p.is_admin
      or exists (
        select 1 from public.invite_redemptions ir
        where ir.user_id = p.id
          and coalesce(public.role_rank(ir.role) >= 50, false)
      )
    )
  order by p.id;
$$;
revoke all on function public.admin_alert_recipients() from public, anon, authenticated;
comment on function public.admin_alert_recipients() is
  'Every admin/owner (profiles.is_admin, or a redeemed role with role_rank >= 50) who is eligible to hear about something only an admin can action. Extracted from bug_report_alert_recipients() (202609150005) by 202609190001 when job_health_check() needed the same audience, so the query has one home. Deliberately NOT mod_alert_recipients(), which includes coaches: neither closing a bug report nor restarting a stalled cron job is something a coach can do, and an alert with no available remedy is an interruption.';

create or replace function public.bug_report_alert_recipients()
returns setof uuid
language sql stable security definer set search_path = '' as $$
  select * from public.admin_alert_recipients();
$$;
revoke all on function public.bug_report_alert_recipients() from public, anon, authenticated;
comment on function public.bug_report_alert_recipients() is
  'Every admin/owner eligible to hear about a new bug report (202609150005). Since 202609190001 this is a thin wrapper over admin_alert_recipients(), which holds the query - the audience and the behaviour are unchanged. Kept as its own name so notif_on_bug_report() and its test still read as a statement about bug reports, and so a future change to who hears about bugs specifically has a place to live.';

-- =====================================================================
-- 3. Where the verdict lives
-- =====================================================================
-- One row, forever. `id boolean primary key check (id)` is the singleton:
-- true is the only value that satisfies both, so a second row cannot be
-- inserted even by a definer function with a bug in it.
--
-- RLS is enabled with NO policy and no grant, which is this schema's
-- standard "definer functions only" shape - 202608270002 already revoked the
-- default SELECT for anon and authenticated on every table created after it,
-- so the table is unreachable by PostgREST from either role. job_health_
-- status() crosses that boundary as the owner and returns three of the six
-- columns; failing_jobs and the alert bookkeeping stay on this side of it.
create table if not exists public.job_health_state (
  id boolean primary key default true check (id),
  -- When the check last COMPLETED. The public answer includes this because
  -- a monitor that has stopped running must not read as a healthy one.
  last_checked_at timestamptz not null default now(),
  ok boolean not null default true,
  failing_count integer not null default 0,
  -- Operator detail. Never leaves the database through an anon path.
  failing_jobs text[] not null default '{}',
  -- Alert bookkeeping, so a problem that lasts a week does not become 168
  -- identical notifications. See the re-alert rule in job_health_check().
  last_alert_at timestamptz,
  last_alert_fingerprint text
);
alter table public.job_health_state enable row level security;
revoke all on table public.job_health_state from public, anon, authenticated;
comment on table public.job_health_state is
  'The singleton row public.job_health_check() writes its verdict to each hour and public.job_health_status() reads. RLS enabled with no policy and no grant: only SECURITY DEFINER functions reach it. `ok`, `failing_count` and `last_checked_at` are the three fields the anon status function exposes; `failing_jobs` and the two last_alert_* columns are operator-only and deliberately have no public path.';

-- Seeded with now() rather than a null or an epoch: the hourly job has not
-- run yet at the instant this migration applies, and a caller that fails on
-- a stale last_checked_at would otherwise alert on the deploy itself. The
-- job runs within the hour, well inside the two-hour staleness budget the
-- workflow uses.
insert into public.job_health_state (id) values (true) on conflict (id) do nothing;

-- =====================================================================
-- 4. The check
-- =====================================================================
-- WHAT COUNTS AS FAILING, and the one place this deliberately diverges from
-- scheduled_job_health().
--
-- A job is failing when any of these is true:
--   * it is not active - somebody or something unscheduled it;
--   * any of its runs in the LAST 24 HOURS recorded status 'failed';
--   * it has never run at all - the purge_due_accounts state, and the single
--     most important one here, flagged at every cadence;
--   * its last run is older than public.cron_cadence_window(its schedule).
--
-- THE DIVERGENCE: scheduled_job_health() requires the latest run's status to
-- be exactly 'succeeded', so a job that is mid-run right now reads unhealthy
-- there. That is fine for a report a human reads on demand and wrong for a
-- gate that fires hourly and notifies people: pg_cron writes a
-- 'running'/'starting' row at the START of a run, and notif-batch-flush runs
-- every 15 minutes, so a check landing during a run would page the admins
-- about a job that is working. A run in progress is therefore not a failure
-- here. A run that is STUCK still gets caught, one cadence window later, by
-- the staleness clause - nothing is lost, it just takes longer than a false
-- positive would have.
--
-- The 24-hour window is the failed-run clause only. Staleness stays on each
-- job's own cadence, because a flat window applied to recap_monthly is
-- exactly the 202609060016 bug, and a monthly job that has stopped must
-- still be detectable by something now that nothing calls
-- scheduled_job_health() on a schedule any more.
create or replace function public.job_health_check()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_failing text[];
  v_count integer;
  v_fingerprint text;
  v_prev public.job_health_state%rowtype;
  v_alert boolean := false;
  v_admin uuid;
begin
  with last_runs as (
    select d.jobid, max(d.start_time) as last_run
      from cron.job_run_details d
     group by d.jobid
  ),
  latest as (
    select d.jobid, d.status, d.start_time
      from cron.job_run_details d
      join last_runs l on l.jobid = d.jobid and l.last_run = d.start_time
  ),
  recent_failure as (
    select distinct d.jobid
      from cron.job_run_details d
     where d.status = 'failed'
       and d.start_time > now() - interval '24 hours'
  )
  -- coalesce on the NAME too: cron.schedule(schedule, command) - the
  -- two-argument form - leaves jobname null, and a null element would make
  -- the fingerprint below compare unequal to itself on every run, so a
  -- single unnamed job would turn the 6-hour re-alert rule back into an
  -- hourly one. Every job in this schema is named, which is exactly why
  -- nobody would notice.
  select coalesce(
           array_agg(coalesce(j.jobname::text, 'job ' || j.jobid)
                     order by coalesce(j.jobname::text, 'job ' || j.jobid)),
           '{}'::text[])
    into v_failing
    from cron.job j
    left join latest on latest.jobid = j.jobid
   where not j.active
      or exists (select 1 from recent_failure rf where rf.jobid = j.jobid)
      or latest.start_time is null
      or latest.start_time < now() - public.cron_cadence_window(j.schedule::text);

  v_count := coalesce(array_length(v_failing, 1), 0);
  v_fingerprint := array_to_string(v_failing, ',');

  select * into v_prev from public.job_health_state where id;

  -- RE-ALERT RULE. The check runs hourly and notif_create()'s own de-dupe
  -- window is one hour, which means a plain "notify on any problem" would
  -- put one notification per hour, indefinitely, in front of the admins for
  -- as long as a job stayed broken. A gate that cries wolf gets muted, and a
  -- muted gate is how purge_due_accounts went unnoticed - 202609060018 made
  -- that argument about a false positive and it applies just as much to a
  -- true positive repeated 168 times a week.
  --
  -- So: alert on the first problem, alert again whenever the SET of failing
  -- jobs changes (a new job breaking is new information), and otherwise
  -- re-alert at most every 6 hours so a standing problem stays visible
  -- without becoming wallpaper.
  if v_count > 0 then
    v_alert := v_prev.last_alert_at is null
            or v_prev.last_alert_fingerprint is distinct from v_fingerprint
            or v_prev.last_alert_at < now() - interval '6 hours';
  end if;

  update public.job_health_state
     set last_checked_at = now(),
         ok = (v_count = 0),
         failing_count = v_count,
         failing_jobs = v_failing,
         last_alert_at = case when v_alert then now() else last_alert_at end,
         -- Cleared on recovery, so the next problem is a first problem and
         -- alerts immediately rather than waiting out a 6-hour window.
         last_alert_fingerprint = case
           when v_count = 0 then null
           when v_alert then v_fingerprint
           else last_alert_fingerprint end
   where id;

  if v_alert then
    for v_admin in select * from public.admin_alert_recipients() loop
      -- The existing immediate-notification path, unchanged: notif_create()
      -- applies the block-edge, preference and de-dupe filters for us, and
      -- is the only way a row reaches public.notifications.
      --
      -- NO JOB NAMES IN THE BODY. A notification row is readable by its
      -- recipient through ordinary RLS, and the recipients here are admins,
      -- so naming the job would be defensible - but the count is what the
      -- admin acts on ("go look"), and keeping operational detail on one
      -- side of the line everywhere makes the line easy to keep.
      -- deep_link is NULL: there is no in-app screen for this yet, and a
      -- link that resolves to the feed would be worse than none.
      perform public.notif_create(
        v_admin, 'job_health_alert', 'community',
        'תקלה בעבודות המתוזמנות',
        v_count || ' עבודות מתוזמנות לא רצו כמתוכנן. בדקו את מצב השרת.',
        'job_health', null, null);
    end loop;
  end if;

  return v_count;
end $$;
revoke all on function public.job_health_check() from public, anon, authenticated;
comment on function public.job_health_check() is
  'Hourly pg_cron job ''job-health-check'' (202609190001). Reads cron.job_run_details and flags every job that is inactive, recorded a ''failed'' run in the last 24 hours, has never run, or has not run within public.cron_cadence_window(its schedule). Writes the verdict to the public.job_health_state singleton (ok, failing_count, failing_jobs, last_checked_at) and returns the failing count. On a problem it notifies every public.admin_alert_recipients() member with a ''job_health_alert'' notification through notif_create() - first occurrence, any change to the failing set, and otherwise at most once every 6 hours, so a week-long outage is not 168 notifications. A run IN PROGRESS is not a failure (unlike scheduled_job_health(), which requires the latest status to be ''succeeded''): pg_cron writes a ''running'' row at the start of every run and the 15-minute flusher would otherwise page the admins for working normally; a genuinely stuck run is still caught one cadence window later. SECURITY DEFINER with the grant as the only gate and NO auth.uid() check - the documented scheduled-job exception (retention_purge_telemetry, notif_batch_flush_due, recompute_feed_weights) - and GRANTED TO NO ROLE, so only the cron job owner can call it.';

-- =====================================================================
-- 5. The anon-safe answer
-- =====================================================================
-- THREE COLUMNS, NO ARGUMENTS, NO FILTERS. The signature is the security
-- boundary: there is nothing for a caller to pass, so there is nothing to
-- widen, and the body is a single select of three named columns from a
-- one-row table. Adding a column to job_health_state does not change what
-- this returns; that has to be a deliberate edit here, in a new migration.
--
-- Granted to anon so .github/workflows/scheduled-job-alert.yml can call it
-- with the publishable key that is already committed in cloud-config.js and
-- already served to every browser - which removes SUPABASE_SERVICE_ROLE_KEY,
-- a full-database credential, from GitHub Actions entirely. The exception
-- this makes to 202609170001's "nothing in public is anon-executable" is
-- argued at the top of this file and is pinned BY NAME in
-- supabase/tests/0113 so it stays an exception of exactly one.
create or replace function public.job_health_status()
returns table (
  ok boolean,
  failing_count integer,
  last_checked_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select s.ok, s.failing_count, s.last_checked_at
    from public.job_health_state s
   where s.id;
$$;
revoke all on function public.job_health_status() from public;
grant execute on function public.job_health_status() to anon, authenticated, service_role;
comment on function public.job_health_status() is
  'The anon-safe scheduled-job monitor (202609190001). Returns exactly one row of exactly three fields - ok, failing_count, last_checked_at - and takes no arguments, so a caller cannot widen it. No job names, no schedules, no error text, no member data. THE ONE FUNCTION IN public THAT IS DELIBERATELY EXECUTABLE BY anon: supabase/tests/0113 allows it by name and still fails the build for any other. It exists so .github/workflows/scheduled-job-alert.yml can ask "is the backend''s scheduled work healthy, and was that question asked recently" with the publishable key from cloud-config.js instead of a service-role key held in GitHub. last_checked_at is part of the answer on purpose: a caller must treat a stale stamp as a failure, or a monitor that has stopped running reads exactly like a healthy one. public.scheduled_job_health() remains the service_role operator view with the names and the detail.';

-- =====================================================================
-- 6. The schedule
-- =====================================================================
-- HOURLY at :53. cron.schedule UPSERTS on job name, so this is idempotent.
-- Minute 53 is free - the eight existing jobs sit on */15, 41, 17, 23, 17,
-- 31, 11 and 47 - keeping to 202608310006's habit of not stampeding :00.
--
-- Hourly rather than daily because this replaces a once-a-day workflow and
-- the whole point is to shorten the gap between a job breaking and somebody
-- knowing. Hourly is also what makes the workflow's two-hour staleness
-- budget meaningful: one missed check is tolerated, two are not.
select cron.schedule('job-health-check', '53 * * * *',
  $$select public.job_health_check()$$);

commit;
