-- The scheduled-job monitor that needs no service-role key (202609190001).
--
-- TWO QUESTIONS, and they are not the same question.
--
--   1. Does `public.job_health_status()` - the ONE function in `public` that
--      is deliberately executable by `anon`, and therefore by anybody holding
--      the publishable key that ships in cloud-config.js - expose anything
--      beyond ok / failing_count / last_checked_at? The whole argument for
--      granting it is that its answer is three facts with no caller input, so
--      this is the assertion that argument rests on. supabase/tests/0113 says
--      it is the only such function; this file says what it may say.
--
--   2. Does `public.job_health_check()` actually notice a failed run? A
--      monitor that reports "ok" because it cannot see a failure is worse
--      than no monitor - it is the purge_due_accounts shape again, with a
--      green light on top of it. So the failure is MANUFACTURED here, in
--      cron.job_run_details, rather than waited for.
--
-- WHY THE ASSERTIONS ARE CONTAINMENT, NOT EQUALITY. `supabase start` applies
-- every migration, which schedules nine real jobs, and the CI stack is
-- seconds old - so most of them have genuinely never run and are genuinely
-- flagged. That is correct behaviour, not noise to design around, and it is
-- why this file asserts that the manufactured job IS in the failing set and
-- that the healthy one is NOT, rather than asserting a count.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ===========================================================================
-- 1. The anon surface exposes exactly three fields
-- ===========================================================================
select ok(
  has_function_privilege('anon', 'public.job_health_status()', 'execute'),
  'anon can execute job_health_status() - the whole point, and the reason the workflow needs no service-role key');

select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'job_health_status'),
  0,
  'it takes NO arguments - there is no filter, no id and no column list for a caller to widen');

select is(
  (select array_to_string(p.proargnames, ',')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'job_health_status'),
  'ok,failing_count,last_checked_at',
  'and it declares exactly three OUT columns, in this order');

-- The catalog assertion above is what the function PROMISES. This is what an
-- anon caller actually GETS, which is the thing that matters. The landing
-- table is shaped from the function and created by postgres (anon is not
-- assumed to hold TEMPORARY on the database, and that is not what is under
-- test); the row that lands in it is fetched while the session really is
-- `anon`. `insert ... select *` is itself part of the assertion - it fails
-- outright if the function ever returns a fourth column.
create temporary table anon_sees as select * from public.job_health_status() where false;
grant insert on anon_sees to anon;
set local role anon;
insert into anon_sees select * from public.job_health_status();
reset role;

select is(
  (select array_to_string(array_agg(a.attname::text order by a.attnum), ',')
     from pg_attribute a
    where a.attrelid = 'pg_temp.anon_sees'::regclass and a.attnum > 0 and not a.attisdropped),
  'ok,failing_count,last_checked_at',
  'an anon caller receives those three columns and nothing else - no jobname, no schedule, no status, no error text');

select is((select count(*)::int from anon_sees), 1,
  'exactly one row reached anon: the singleton, so there is no per-job listing to walk');

-- The other half of "exposes nothing": every richer path stays shut. If one
-- of these ever flips, the anon grant above stops being a three-field window
-- and becomes a door.
select ok(
  not has_function_privilege('anon', 'public.job_health_check()', 'execute'),
  'anon cannot run the check itself - it reads cron.job_run_details and knows the names');
select ok(
  not has_function_privilege('anon', 'public.scheduled_job_health()', 'execute'),
  'anon cannot reach the operator view either - that is still service_role only');
select ok(
  not has_function_privilege('anon', 'public.cron_cadence_window(text)', 'execute'),
  'nor the cadence helper');
select ok(
  not has_function_privilege('anon', 'public.admin_alert_recipients()', 'execute'),
  'nor the admin roster, which would otherwise enumerate the club staff');
select ok(
  not has_table_privilege('anon', 'public.job_health_state', 'select')
  and not has_table_privilege('authenticated', 'public.job_health_state', 'select'),
  'and the underlying table is not readable by anon OR authenticated - failing_jobs never leaves the database');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.job_health_state'::regclass),
  'job_health_state has RLS enabled, like every other table in public');

-- ===========================================================================
-- 2. The cadence window, one copy for two callers
-- ===========================================================================
-- 202609060018's four intervals, restated as assertions so the extraction in
-- 202609190001 cannot quietly change any of them. The 8-day flat window it
-- replaced made recap_monthly report unhealthy 23 days out of 30.
select is(public.cron_cadence_window('41 4 1 * *'), interval '35 days', 'a day-of-month schedule is monthly: 35 days');
select is(public.cron_cadence_window('17 4 * * 1'), interval '9 days',  'a day-of-week schedule is weekly: 9 days');
select is(public.cron_cadence_window('17 6 * * *'), interval '2 days',  'a pinned hour is daily: 2 days');
select is(public.cron_cadence_window('*/15 * * * *'), interval '3 hours', 'anything hourly or faster: 3 hours');
-- The one behaviour 202609190001 added rather than ported: a schedule that is
-- not five cron fields used to fall into the FIRST arm and get 35 days, so an
-- '@hourly' job could have been dead a month unnoticed.
select is(public.cron_cadence_window('@hourly'), interval '3 hours', 'an unrecognised form gets the TIGHTEST window, not the widest');
select is(public.cron_cadence_window('30 seconds'), interval '3 hours', 'so does an interval literal');
select is(public.cron_cadence_window('@monthly'), interval '35 days', 'the nickname forms get their real cadence');
select is(public.cron_cadence_window('41  4 1 * *'), interval '35 days', 'and a double space does not shift the fields it reads');

-- ===========================================================================
-- 3. The check flags a failed run
-- ===========================================================================
-- Three jobs are manufactured, all on the same hourly cadence so the only
-- difference between them is what cron recorded:
--   pgtap-job-failed     - one run, 20 minutes ago, status 'failed'
--   pgtap-job-healthy    - one run, 20 minutes ago, status 'succeeded'
--   pgtap-job-running    - one run, 2 minutes ago, status 'running'
-- The third is the false positive this check deliberately does not produce:
-- pg_cron writes a 'running' row at the START of every run, notif-batch-flush
-- runs every 15 minutes, and a checker that treated in-progress as failure
-- would page the admins about a job that is working.
-- Plain statements rather than lives_ok(): both the schedule and the
-- job_run_details insert need postgres's rights over the `cron` schema, which
-- it holds on Supabase (202609050005 schedules eight jobs this same way), and
-- if that ever stops being true the raw Postgres error names the privilege -
-- which is more use than a TAP line saying the test died. Everything here
-- rolls back with the transaction, so no job survives the file.
select cron.schedule('pgtap-job-failed',  '31 * * * *', 'select 1');
select cron.schedule('pgtap-job-healthy', '32 * * * *', 'select 1');
select cron.schedule('pgtap-job-running', '33 * * * *', 'select 1');

-- runid IS SUPPLIED EXPLICITLY, and that is not a style choice.
-- cron.job_run_details.runid defaults to nextval('cron.runid_seq'), the
-- sequence is owned by supabase_admin with no grants on it at all, and
-- `postgres` therefore holds INSERT and SELECT on the table but not USAGE on
-- its sequence. Letting the default fire raises `permission denied for
-- sequence runid_seq`, which aborts the file mid-transaction: pgTAP never
-- reaches finish(), emits no plan, and the run reports "Dubious ... All 19
-- subtests passed" - a failure that reads like a pass. Naming runid skips the
-- default, so no sequence privilege is needed.
--
-- This costs the test nothing, because runid is not part of anything under
-- assertion here. Neither job_health_check() nor scheduled_job_health() ever
-- reads it: both only select jobid, status and start_time from this table and
-- join on jobid, so the values below need to be unique and nothing more. They
-- are taken from the current max so they cannot collide with rows pg_cron
-- wrote itself, and the whole thing rolls back regardless.
insert into cron.job_run_details (runid, jobid, status, start_time, end_time)
select (select coalesce(max(d.runid), 0) from cron.job_run_details d)
         + row_number() over (order by j.jobname),
       j.jobid,
       case j.jobname when 'pgtap-job-failed'  then 'failed'
                      when 'pgtap-job-healthy' then 'succeeded'
                      else 'running' end,
       case j.jobname when 'pgtap-job-running' then now() - interval '2 minutes'
                      else now() - interval '20 minutes' end,
       null
  from cron.job j
 where j.jobname in ('pgtap-job-failed', 'pgtap-job-healthy', 'pgtap-job-running');

select lives_ok($$ select public.job_health_check() $$, 'the hourly check runs');

select ok(
  (select failing_jobs from public.job_health_state) @> array['pgtap-job-failed'],
  'a job whose run FAILED in the last 24 hours is flagged - the assertion this whole file exists for');

select ok(
  not ((select failing_jobs from public.job_health_state) @> array['pgtap-job-healthy']),
  'a job that succeeded 20 minutes ago on an hourly cadence is NOT flagged - a monitor that flags everything is the same as one that flags nothing');

select ok(
  not ((select failing_jobs from public.job_health_state) @> array['pgtap-job-running']),
  'and a run still in progress is not a failure - it is caught one cadence window later if it is genuinely stuck');

select ok(
  (select failing_count from public.job_health_state) >= 1
  and (select failing_count from public.job_health_state)
      = coalesce(array_length((select failing_jobs from public.job_health_state), 1), 0),
  'failing_count is the size of failing_jobs, not a separately maintained number that can drift from it');

select ok(
  not (select ok from public.job_health_state),
  'ok is false while anything is failing - which is the single bit the workflow gates on');

select ok(
  (select last_checked_at from public.job_health_state) > now() - interval '1 minute',
  'and last_checked_at is stamped by the run, so a stopped checker cannot read as a healthy one');

-- The admins hear about it, through the existing notifications path.
select is(
  (select count(*)::int from public.notifications
    where type = 'job_health_alert' and user_id = tests.uid('admin')),
  1, 'the admin is notified once');
select is(
  (select count(*)::int from public.notifications
    where type = 'job_health_alert' and user_id = tests.uid('coach')),
  0, 'a coach is not - restarting a cron job is not something a coach can do, and an alert with no remedy is an interruption');
select is(
  (select count(*)::int from public.notifications
    where type = 'job_health_alert' and user_id = tests.uid('m1')),
  0, 'and a member certainly is not');
select is_empty(
  $$ select n.id from public.notifications n
      where n.type = 'job_health_alert'
        and (n.body like '%pgtap-job-failed%' or n.title like '%pgtap-job-failed%') $$,
  'the notification body carries a count, never a job name - the same line the anon function keeps');

-- A second run inside the re-alert window must not notify again. A gate that
-- fires hourly forever gets muted, and a muted gate is how purge_due_accounts
-- sat unnoticed for the life of the project.
select lives_ok($$ select public.job_health_check() $$, 'the check runs again an instant later');
select is(
  (select count(*)::int from public.notifications where type = 'job_health_alert'),
  (select count(*)::int from public.admin_alert_recipients()),
  'and sends nothing new: one notification per admin in total, not one per admin per run (job_health_check''s own 6-hour re-alert rule, with notif_create''s 1-hour de-dupe behind it)');

-- ===========================================================================
-- 4. The extraction did not change who hears about a bug report
-- ===========================================================================
-- bug_report_alert_recipients() became a wrapper over admin_alert_recipients()
-- in the same migration. Same audience, or the extraction was not behaviour-
-- preserving and 0111 is about to fail for a reason nobody will connect to
-- this change.
select set_eq(
  $$ select * from public.bug_report_alert_recipients() $$,
  $$ select * from public.admin_alert_recipients() $$,
  'bug_report_alert_recipients() still answers exactly what it did, now via the shared roster');
select ok(
  (select count(*)::int from public.admin_alert_recipients() r where r = tests.uid('admin')) = 1
  and (select count(*)::int from public.admin_alert_recipients() r where r = tests.uid('owner')) = 1
  and (select count(*)::int from public.admin_alert_recipients() r where r = tests.uid('coach')) = 0,
  'the admin and the owner are on it; the coach is not');

select * from finish();
rollback;
