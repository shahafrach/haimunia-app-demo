begin;

-- A job that has not run YET is not a job that has stopped running.
--
-- THE BUG. public.job_health_check() (202609190001) flags a job when
-- `latest.start_time is null` - it has never run - at every cadence, with no
-- reference to whether its first scheduled time has actually arrived. That
-- clause was written for purge_due_accounts, which was defined, granted and
-- never scheduled for the life of the project, and for that state it is
-- exactly right. But it fires on the other shape too:
--
--     recap_monthly, '41 4 1 * *', created after 2026-09-01.
--
-- Its first run is 2026-10-01 04:41. From the day it was scheduled until
-- that moment it has never run, so the hourly check names it, sets
-- `ok = false`, and notifies every admin - for about a month, over a job
-- that is doing precisely what it was told to do. The external workflow
-- reads the same `ok` and goes red with it, so the club's only monitoring
-- surface is red for a month for no reason.
--
-- That is the 202609060016 false positive again, one layer up. 202609060018
-- fixed a flat staleness window; this fixes a window that has no start. And
-- the cost of a false positive on THIS surface is the thing the whole area
-- exists to prevent: a gate that cries wolf gets muted, and a muted gate is
-- how purge_due_accounts sat unnoticed in the first place.
--
-- THE FIX, and the narrowest form of it that works. A never-run job counts
-- as HEALTHY until one full public.cron_cadence_window(its schedule) has
-- passed since the job was first seen; after that it is failing, exactly as
-- before. The window is the job's own cadence, so a monthly job gets 35 days
-- of grace and an hourly one gets 3 hours - a new hourly job that has not run
-- after three hours has not been slow, it has been broken, and the check
-- still says so within the same day it was deployed.
--
-- WHAT DOES NOT CHANGE, deliberately:
--   * a job that RAN AND FAILED in the last 24 hours is failing. Immediately,
--     on its first run, with no grace of any kind. The grace here is about
--     the absence of evidence, never about evidence of a problem.
--   * a job that is inactive is failing.
--   * a job whose last run is older than its cadence window is failing.
--   * a job whose grace has expired and still has no run is failing - the
--     purge_due_accounts state is still caught, just one window later than
--     before. For every daily job in this schema that is within two days of
--     the deploy; for the one monthly job it is the month it was always
--     going to take to prove itself.
--
-- WHY "FIRST SEEN" AND NOT "CREATED". pg_cron records no creation time:
-- cron.job has jobid, schedule, command, nodename, nodeport, database,
-- username, active and jobname, and nothing that says when the row appeared.
-- There is no timestamp to read, so the checker has to remember. The hourly
-- check is the only thing that looks at cron.job on a schedule, so the first
-- time IT sees a job is the best available proxy for when that job appeared -
-- accurate to within one hour of the truth for anything scheduled after this
-- migration, which is inside the margin of every window it gates.

-- =====================================================================
-- 1. Where "first seen" lives
-- =====================================================================
-- public.job_health_state is a SINGLETON - `id boolean primary key check
-- (id)` - so this cannot be a column of per-job rows without turning that
-- table into something it deliberately is not. It is a jsonb map on the one
-- row instead: {"<jobid>": "<timestamptz>"}, one key per job pg_cron
-- currently has.
--
-- KEYED ON jobid, not on jobname. Three reasons, in order of how much they
-- matter:
--   1. cron.schedule(schedule, command) - the two-argument form - leaves
--      jobname null, and a null key is not a key. jobid is cron.job's
--      primary key and is never null. job_health_check() already carries a
--      coalesce() for exactly this case when building failing_jobs.
--   2. A job that is unscheduled and scheduled again gets a NEW jobid, and
--      should get a new window with it: it is a new job, and it has not
--      proven itself any more than the first one had.
--   3. cron.schedule() UPSERTS on jobname and keeps the jobid, so renaming
--      nothing and re-running a migration does not reset anyone's window.
--
-- The map is REBUILT from cron.job on every check rather than appended to,
-- which is what prunes it: a job that no longer exists loses its key in the
-- same run, so this cannot grow without bound, and point 2 above holds
-- without any deletion logic of its own.
alter table public.job_health_state
  add column if not exists first_seen jsonb not null default '{}'::jsonb;

comment on column public.job_health_state.first_seen is
  'When public.job_health_check() first saw each pg_cron job: {"<jobid>": "<timestamptz>"}, rebuilt from cron.job on every run so vanished jobs are pruned and a re-created job (new jobid) starts a new window. Added by 202609220001. Read for ONE purpose: a job that has never run is healthy until one public.cron_cadence_window(its schedule) has passed since its first_seen, so a newly scheduled monthly job is not reported failing for the month before its first run. pg_cron records no creation time anywhere in cron.job, so the checker has to remember; first seen is within one hour of created for anything scheduled after 202609220001. Operator-only, like failing_jobs: job_health_status() does not expose it and must not.';

-- THE ONE-TIME AMNESTY, stated out loud rather than discovered later.
--
-- Every job that exists at this instant is seeded with now(), because that
-- is the first moment this rule could have seen it. For a job that has run,
-- the value is never read. For a job that has NEVER run, it grants exactly
-- one cadence window of grace starting now - which is the point for
-- recap_monthly, and is a real (bounded) loss of signal for anything else in
-- that state: 3 hours for an hourly job, 2 days for a daily one, 35 days for
-- a monthly one, once, after which the old behaviour resumes unchanged.
--
-- The alternative - seeding an expired timestamp so nothing existing gets
-- grace - was considered and rejected: it would keep recap_monthly red until
-- 2026-10-01, which is the bug this migration exists to fix. Seeding at
-- migration time rather than letting the first check do it makes the amnesty
-- start at deploy, which is both earlier and deterministic.
update public.job_health_state
   set first_seen = coalesce(
         (select jsonb_object_agg(j.jobid::text, to_jsonb(now())) from cron.job j),
         '{}'::jsonb)
 where id;

comment on table public.job_health_state is
  'The singleton row public.job_health_check() writes its verdict to each hour and public.job_health_status() reads. RLS enabled with no policy and no grant: only SECURITY DEFINER functions reach it. `ok`, `failing_count` and `last_checked_at` are the three fields the anon status function exposes; `failing_jobs`, `first_seen` (202609220001) and the two last_alert_* columns are operator-only and deliberately have no public path.';

-- =====================================================================
-- 2. The check, with the never-run clause given a start time
-- =====================================================================
-- Re-declared in full (202609190001's body, verbatim, with the two changes
-- below) rather than patched, because a function has one definition and it
-- should be readable in the file that last changed it.
--
--   * it records first_seen for every job it can see, before deciding
--     anything, so a job is always registered on the first run that meets it;
--   * the `latest.start_time is null` clause becomes "never run AND first
--     seen more than one cadence window ago".
--
-- now() is captured once into v_now. Inside a single statement now() is
-- transaction time and constant already; the variable is so that the
-- timestamp WRITTEN into first_seen, the timestamp last_checked_at is
-- stamped with, and the timestamp both windows are measured against are
-- provably the same instant rather than three calls that happen to agree.
create or replace function public.job_health_check()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_seen jsonb;
  v_failing text[];
  v_count integer;
  v_fingerprint text;
  v_prev public.job_health_state%rowtype;
  v_alert boolean := false;
  v_admin uuid;
begin
  -- Register every job that exists now, keeping the timestamp already
  -- recorded for the ones seen before. Because this is built by aggregating
  -- over cron.job rather than by merging into the stored map, a job that has
  -- been unscheduled since the last run simply has no key here, which is the
  -- pruning: the map is always exactly the current job set.
  select coalesce(s.first_seen, '{}'::jsonb) into v_seen
    from public.job_health_state s
   where s.id;

  select coalesce(
           jsonb_object_agg(j.jobid::text,
                            coalesce(v_seen -> j.jobid::text, to_jsonb(v_now))),
           '{}'::jsonb)
    into v_seen
    from cron.job j;

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
       and d.start_time > v_now - interval '24 hours'
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
      -- NEVER RUN. Failing only once its first window has gone by: a job
      -- scheduled '41 4 1 * *' yesterday has not missed anything, and saying
      -- it has for a month is how a monitoring surface gets muted. The
      -- coalesce is unreachable - v_seen was just rebuilt from this same
      -- cron.job - and is there so a future caller that passes a stale map
      -- fails safe towards "give it its window" rather than towards a null
      -- comparison that silently drops the job out of the failing set.
      or (latest.start_time is null
          and coalesce((v_seen ->> j.jobid::text)::timestamptz, v_now)
              < v_now - public.cron_cadence_window(j.schedule::text))
      -- HAS RUN, BUT NOT RECENTLY ENOUGH. Unchanged, and deliberately split
      -- out from the clause above: these two were one expression when "never
      -- run" meant "infinitely stale", and they are two different questions
      -- the moment a never-run job has a start time of its own.
      or (latest.start_time is not null
          and latest.start_time < v_now - public.cron_cadence_window(j.schedule::text));

  v_count := coalesce(array_length(v_failing, 1), 0);
  v_fingerprint := array_to_string(v_failing, ',');

  select * into v_prev from public.job_health_state where id;

  -- RE-ALERT RULE, unchanged from 202609190001. The check runs hourly and
  -- notif_create()'s own de-dupe window is one hour, which means a plain
  -- "notify on any problem" would put one notification per hour, indefinitely,
  -- in front of the admins for as long as a job stayed broken. A gate that
  -- cries wolf gets muted, and a muted gate is how purge_due_accounts went
  -- unnoticed.
  --
  -- So: alert on the first problem, alert again whenever the SET of failing
  -- jobs changes (a new job breaking is new information), and otherwise
  -- re-alert at most every 6 hours so a standing problem stays visible
  -- without becoming wallpaper.
  if v_count > 0 then
    v_alert := v_prev.last_alert_at is null
            or v_prev.last_alert_fingerprint is distinct from v_fingerprint
            or v_prev.last_alert_at < v_now - interval '6 hours';
  end if;

  update public.job_health_state
     set last_checked_at = v_now,
         first_seen = v_seen,
         ok = (v_count = 0),
         failing_count = v_count,
         failing_jobs = v_failing,
         last_alert_at = case when v_alert then v_now else last_alert_at end,
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
  'Hourly pg_cron job ''job-health-check'' (202609190001, never-run rule amended by 202609220001). Reads cron.job_run_details and flags every job that is inactive, recorded a ''failed'' run in the last 24 hours, has not run within public.cron_cadence_window(its schedule), or has NEVER run and was first seen more than one such window ago. That last clause is the 202609220001 change: a never-run job used to be flagged at every cadence from the instant it was scheduled, which reported recap_monthly (''41 4 1 * *'') as failing for the whole month between being created and its first run. A job''s first_seen is recorded in public.job_health_state.first_seen, keyed by jobid, rebuilt from cron.job on every run so it prunes itself and a re-created job gets a new window. The grace covers the ABSENCE of a run only - a job that ran and failed is flagged on its first run with no grace at all, and a never-run job whose window has expired is flagged exactly as before, so the purge_due_accounts state is still caught, one cadence window later. Writes the verdict to the public.job_health_state singleton (ok, failing_count, failing_jobs, first_seen, last_checked_at) and returns the failing count. On a problem it notifies every public.admin_alert_recipients() member with a ''job_health_alert'' notification through notif_create() - first occurrence, any change to the failing set, and otherwise at most once every 6 hours, so a week-long outage is not 168 notifications. A run IN PROGRESS is not a failure (unlike scheduled_job_health(), which requires the latest status to be ''succeeded''): pg_cron writes a ''running'' row at the start of every run and the 15-minute flusher would otherwise page the admins for working normally; a genuinely stuck run is still caught one cadence window later. SECURITY DEFINER with the grant as the only gate and NO auth.uid() check - the documented scheduled-job exception (retention_purge_telemetry, notif_batch_flush_due, recompute_feed_weights) - and GRANTED TO NO ROLE, so only the cron job owner can call it.';

-- =====================================================================
-- 3. The twin that is deliberately NOT changed
-- =====================================================================
-- public.scheduled_job_health() carries the same "never run is unhealthy"
-- rule, in `coalesce(j.active and latest.status = 'succeeded' and ..., false)`.
-- It is left exactly as it is, and that is a decision rather than an
-- oversight:
--
--   * it pages nobody. It is the service_role operator view a human runs
--     from the SQL editor AFTER something has already told them to look, and
--     it returns `last_status = 'never run'` alongside the name and the
--     schedule - so the reader can see the difference between "scheduled
--     yesterday" and "dead" in the same row. The false positive being fixed
--     above is a false positive precisely because job_health_check() has no
--     reader to make that judgement: it sends a notification.
--   * it is `stable` and takes no state. Giving it the same rule would mean
--     reading job_health_state from a function that today touches nothing
--     but cron.*, coupling the on-demand report to the hourly job's
--     bookkeeping for a difference a human can already see.
--   * supabase/tests/0081 pins its never-run behaviour by name as
--     deliberate, and 0116 pins the shared window both callers use. The
--     drift between the two functions is therefore asserted and documented
--     rather than latent, which is the condition under which CLAUDE.md's
--     sibling rule allows a twin to be left alone.
--
-- The cadence WINDOW itself still has exactly one home,
-- public.cron_cadence_window(), and this migration does not add a second.

commit;
