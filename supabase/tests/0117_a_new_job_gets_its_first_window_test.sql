-- 202609220001. A job that has not run YET is not a job that has stopped.
--
-- THE BUG THIS PINS. job_health_check() (202609190001) flagged a job the
-- instant `latest.start_time is null` - never run - regardless of whether its
-- first scheduled time had arrived. recap_monthly ('41 4 1 * *'), created
-- after 2026-09-01, therefore reported failing every hour until its first run
-- on 2026-10-01: a month of notifications to every admin and a month of red
-- on .github/workflows/scheduled-job-alert.yml, over a job doing exactly what
-- it was told. A monitoring surface that is red for a month gets muted, and a
-- muted gate is how purge_due_accounts sat unnoticed for the life of the
-- project - so this is the same class of defect the whole area exists to
-- prevent, not a cosmetic one.
--
-- THE THREE CASES, which are the three this file is built around:
--   1. a NEW MONTHLY job, never run, inside its window  -> healthy;
--   2. a NEW HOURLY job, never run, PAST its window     -> failing;
--   3. a job that RAN AND FAILED                        -> failing, always.
--
-- Case 3 is the one that must not have moved. The grace added by
-- 202609220001 is about the absence of evidence; evidence of a problem is
-- untouched, and a test that only proved the new leniency would not notice
-- if the leniency had swallowed the old strictness.
--
-- THE WINDOW BOUNDARY IS TESTED FROM BOTH SIDES, per cadence, because "one
-- full cadence window since first seen" has two ways to be wrong that a
-- single-sided test cannot tell apart: a flat window (the 202609060016 bug,
-- one layer up) and an off-by-a-window comparison. An hourly job is asserted
-- healthy at 2h59m and failing at 3h01m; a monthly one healthy at 34 days and
-- failing at 36. A flat window cannot produce all four.
--
-- ASSERTIONS ARE CONTAINMENT, NOT EQUALITY, for the reason 0116 records:
-- `supabase start` applies every migration and schedules the real jobs, in a
-- stack seconds old. What is different here is WHY that no longer produces a
-- long failing list - those jobs are now inside their own first windows,
-- which is the behaviour under test - so asserting a count would be asserting
-- the fixture rather than the rule.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ===========================================================================
-- Fixtures
-- ===========================================================================
-- Three manufactured jobs. Only the third gets a run row, so the only
-- difference between the first two is their SCHEDULE - which is the point:
-- the window each one is judged by must come from its own cadence.
select cron.schedule('pgtap-window-monthly', '41 4 1 * *', 'select 1');
select cron.schedule('pgtap-window-hourly',  '34 * * * *', 'select 1');
select cron.schedule('pgtap-window-failed',  '35 * * * *', 'select 1');

-- runid IS SUPPLIED EXPLICITLY, and that is not a style choice.
-- cron.job_run_details.runid defaults to nextval('cron.runid_seq'), the
-- sequence is owned by supabase_admin with no grants on it, and `postgres`
-- therefore holds INSERT on the table but not USAGE on its sequence. Letting
-- the default fire raises `permission denied for sequence runid_seq`, which
-- aborts the file mid-transaction: pgTAP never reaches finish() and the run
-- reports "Dubious ... All N subtests passed" - a failure that reads as a
-- pass. Naming runid skips the default. (0116 hit this first; the note is
-- repeated because the trap is in the insert, not in the file.)
insert into cron.job_run_details (runid, jobid, status, start_time, end_time)
select (select coalesce(max(d.runid), 0) from cron.job_run_details d) + 1,
       j.jobid, 'failed', now() - interval '20 minutes', null
  from cron.job j
 where j.jobname = 'pgtap-window-failed';

-- Moving a job's first_seen backwards is how this file advances time: the
-- rule is "now() - first_seen vs the window", so ageing the stamp is
-- indistinguishable from waiting, and it is the only part of the input under
-- the test's control. One function rather than four copies of the same
-- five-line update - the repo's characteristic defect is a right line with
-- copies, and a test file is not exempt.
create function pg_temp.age_first_seen(p_job text, p_age interval)
returns void language sql as $$
  update public.job_health_state
     set first_seen = jsonb_set(
           first_seen,
           array[(select j.jobid::text from cron.job j where j.jobname = p_job)],
           to_jsonb(now() - p_age))
   where id;
$$;

create function pg_temp.flagged(p_job text)
returns boolean language sql as $$
  select (select s.failing_jobs from public.job_health_state s where s.id) @> array[p_job];
$$;

-- ===========================================================================
-- 1. The check registers every job it can see
-- ===========================================================================
select lives_ok($$ select public.job_health_check() $$, 'the hourly check runs');

select ok(
  (select first_seen from public.job_health_state)
    ? (select j.jobid::text from cron.job j where j.jobname = 'pgtap-window-monthly'),
  'a job the check has just met is recorded in job_health_state.first_seen, keyed by jobid - pg_cron stores no creation time anywhere, so this is the only clock the rule can read');

select ok(
  ((select first_seen from public.job_health_state)
     ->> (select j.jobid::text from cron.job j where j.jobname = 'pgtap-window-hourly'))::timestamptz
  > now() - interval '1 minute',
  'and it is stamped at the run that first saw it, not at some default');

select ok(
  not has_column_privilege('anon', 'public.job_health_state', 'first_seen', 'select')
  and not has_column_privilege('authenticated', 'public.job_health_state', 'first_seen', 'select'),
  'the new column is operator-only like failing_jobs - job_health_status() is still the only anon path and it returns three fields');

-- ===========================================================================
-- 2. CASE 1 - a new monthly job, never run, is healthy
-- ===========================================================================
select ok(
  not pg_temp.flagged('pgtap-window-monthly'),
  'a monthly job scheduled a moment ago is NOT flagged - recap_monthly''s first run is up to a month away and saying it has failed every hour until then is what mutes the gate');

select ok(
  not pg_temp.flagged('pgtap-window-hourly'),
  'nor is an hourly one inside its first three hours');

-- ===========================================================================
-- 3. CASE 3 - a job that ran and failed is flagged, with no grace at all
-- ===========================================================================
-- Stated here, before the window walks below, and asserted again after each
-- of them: this is the behaviour 202609220001 must not have relaxed, and it
-- is also the only thing keeping `ok` false while the other two are healthy.
select ok(
  pg_temp.flagged('pgtap-window-failed'),
  'a job whose run FAILED 20 minutes ago is flagged on its first run - the grace is for the ABSENCE of a run, never for evidence of a problem');

select ok(
  not (select ok from public.job_health_state),
  'so ok is false - the single bit the workflow gates on still reflects a real failure while two never-run jobs sit healthy beside it');

-- ===========================================================================
-- 4. CASE 2 - the hourly job, walked across its own window
-- ===========================================================================
select pg_temp.age_first_seen('pgtap-window-hourly', interval '2 hours 59 minutes');
select lives_ok($$ select public.job_health_check() $$, 'the check runs again just before the hourly window closes');
select ok(
  not pg_temp.flagged('pgtap-window-hourly'),
  'at 2h59m an hourly job that has never run is still healthy - one FULL window, not a fraction of one');

select pg_temp.age_first_seen('pgtap-window-hourly', interval '3 hours 1 minute');
select lives_ok($$ select public.job_health_check() $$, 'and again two minutes of window later');
select ok(
  pg_temp.flagged('pgtap-window-hourly'),
  'at 3h01m it IS flagged - an hourly job that has not run in three hours is not new any more, it is broken, and the check says so the same day it was deployed');

select ok(
  not pg_temp.flagged('pgtap-window-monthly'),
  'and the monthly job beside it is untouched - the window comes from each job''s own cadence, which no single flat constant can do');

select ok(
  pg_temp.flagged('pgtap-window-failed'),
  'the failed job is still flagged across all of it');

-- ===========================================================================
-- 5. The grace is a window, not an amnesty
-- ===========================================================================
-- The purge_due_accounts state - defined, granted, never scheduled, never
-- run, noticed by nobody - is what the never-run clause was written for, and
-- it must still be caught. It is caught one cadence window later than before,
-- and this is the assertion that says "later", not "never".
select pg_temp.age_first_seen('pgtap-window-monthly', interval '34 days');
select lives_ok($$ select public.job_health_check() $$, 'the check runs 34 days into the monthly job''s window');
select ok(
  not pg_temp.flagged('pgtap-window-monthly'),
  'a monthly job still has not missed anything at 34 days - the 35-day window is the same one cron_cadence_window() gives every monthly caller');

select pg_temp.age_first_seen('pgtap-window-monthly', interval '36 days');
select lives_ok($$ select public.job_health_check() $$, 'and again past 35 days');
select ok(
  pg_temp.flagged('pgtap-window-monthly'),
  'a monthly job that has never run 36 days after it was first seen IS flagged - the never-run clause is delayed by one window, not removed');

select ok(
  (select failing_count from public.job_health_state)
    = coalesce(array_length((select failing_jobs from public.job_health_state), 1), 0),
  'failing_count is still the size of failing_jobs, not a separately maintained number that can drift from it');

-- ===========================================================================
-- 6. The map is rebuilt, not appended to
-- ===========================================================================
-- Two behaviours in one assertion, and both matter: first_seen cannot grow
-- without bound as jobs come and go, and a job that is unscheduled and
-- scheduled again is a NEW job with a new jobid - so it gets a new window
-- rather than inheriting the expired one of the job it replaced.
select cron.unschedule('pgtap-window-monthly');
select lives_ok($$ select public.job_health_check() $$, 'the check runs after a job is unscheduled');
select is(
  (select count(*)::int
     from jsonb_object_keys((select first_seen from public.job_health_state)) k
    where k not in (select j.jobid::text from cron.job j)),
  0,
  'first_seen holds a key for exactly the jobs that exist - a vanished job is pruned in the same run, so the map cannot accumulate forever');
select ok(
  not pg_temp.flagged('pgtap-window-monthly'),
  'and a job that no longer exists is not reported failing either');

select * from finish();
rollback;
