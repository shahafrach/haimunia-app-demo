-- 202611180004: a burst of failed Edge Function answers is a failure (Q-39).
--
-- WHY. On 2026-11-18 notif_push_send answered 401 every 3 minutes for about seven hours and nothing alerted;
-- it was found by hand. job_health_check() (202609230008) looks only at the LATEST answer of each slug, so a
-- function that flaps, or one that recovered just before a check, reads healthy.
--
-- WHAT. job_health_check(): the body from 202609230008, unchanged, plus one rule: more than 3 non-2xx answers
-- (or timeouts, or transport errors) from one slug within the last hour adds 'edge burst: <slug>' to the
-- failing set. Names stay in job_health_state.failing_jobs (operator only); job_health_status() still exposes
-- only ok / failing_count / last_checked_at, so the public check and its alert carry no member data and no
-- job names. A job that has not run within twice its interval was already a failure (cron_cadence_window).
--
-- scheduled-job-alert.yml now runs hourly instead of every six hours, so an hour-long burst cannot fall
-- between two runs. Stacked on 202611180003 (#188); no other migration branch is open.

CREATE OR REPLACE FUNCTION public.job_health_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := now();
  v_seen jsonb;
  v_failing text[];
  v_count integer;
  v_fingerprint text;
  v_prev public.job_health_state%rowtype;
  v_alert boolean := false;
  v_admin uuid;
  v_edge_jobs integer;
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

  -- ------------------------------------------------------------------
  -- S6, first half: the Edge Function answered, and it answered badly.
  -- ------------------------------------------------------------------
  -- Named by the slug that caused it. Only the LATEST invocation of each slug
  -- counts: one 500 at 03:00 that has since recovered is not worth waking
  -- anyone for, and a slug that is still broken is still the latest.
  v_failing := v_failing || coalesce((
    select array_agg(distinct 'edge: ' || x.slug order by 'edge: ' || x.slug)
      from (
        select distinct on (i.slug) i.slug, r.status_code, r.timed_out, r.error_msg
          from public.edge_function_invocations i
          join net._http_response r on r.id = i.request_id
         where i.invoked_at > v_now - interval '24 hours'
         order by i.slug, i.invoked_at desc
      ) x
     where x.timed_out
        or x.error_msg is not null
        or x.status_code is null
        or x.status_code < 200 or x.status_code >= 300
  ), '{}'::text[]);

  -- ------------------------------------------------------------------
  -- Q-39 (2026-11-18): a burst of bad answers, even when the latest one was good.
  -- ------------------------------------------------------------------
  -- notif_push_send answered 401 every 3 minutes from about 07:40 to 14:39 UTC on 2026-11-18. More than
  -- 3 non-2xx answers (or timeouts, or transport errors) from one slug within the last hour is a failure
  -- of its own, named 'edge burst: <slug>', so a function that flaps between bad and good is not missed.
  v_failing := v_failing || coalesce((
    select array_agg('edge burst: ' || b.slug order by b.slug)
      from (
        select i.slug
          from public.edge_function_invocations i
          join net._http_response r on r.id = i.request_id
         where i.invoked_at > v_now - interval '1 hour'
           and (r.timed_out or r.error_msg is not null or r.status_code is null
                or r.status_code < 200 or r.status_code >= 300)
         group by i.slug
        having count(*) > 3
      ) b
  ), '{}'::text[]);

  -- ------------------------------------------------------------------
  -- S6, second half: nothing was ever sent.
  -- ------------------------------------------------------------------
  -- If scheduled jobs exist to invoke an Edge Function and the secrets are
  -- placeholders, every one of them is a no-op that reports success. This is
  -- the failure that has actually been true here, and the one the old checker
  -- could never see: there is no failed run to find, because nothing was
  -- attempted.
  select count(*) into v_edge_jobs
    from cron.job j
   where j.command ilike '%cron_invoke_edge_function%';

  if v_edge_jobs > 0 and not public.edge_functions_ready() then
    v_failing := v_failing || array['edge functions: Vault secrets unset or still placeholders'];
  end if;

  -- Bounded. Seven days is longer than the 24-hour window above needs, so a
  -- human reading this table after an incident still has the week around it.
  delete from public.edge_function_invocations
   where invoked_at < v_now - interval '7 days';

  -- Sorted and de-duplicated, because the fingerprint below is the text of
  -- this array and the 6-hour re-alert rule compares it to the last one.
  select array(select distinct unnest(v_failing) order by 1) into v_failing;

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
end $function$;
