-- Launch-readiness S6: a scheduled job that did nothing still reports green.
--
-- THE DEFECT, in the shape that matters. Three cron jobs exist only to invoke
-- an Edge Function: purge-abandoned-profiles, recap-weekly and
-- notif-push-send. Each runs `select public.cron_invoke_edge_function(...)`,
-- and that function is fire-and-forget by design — `net.http_post` queues the
-- request and returns an id immediately, so a slow Edge Function cannot hold
-- a cron worker open. Its own comment says the response "lands in
-- net._http_response, which is where a run is verified after the fact."
--
-- Nothing verified it. So:
--
--   * The Edge Function can return 500 on every invocation for a month.
--     cron.job_run_details records `succeeded`, because the SQL succeeded.
--     job_health_check() reads only cron.job_run_details. The board is green.
--
--   * Worse, and this one has actually been true here: if the
--     edge_functions_* Vault secrets are unset or still placeholders,
--     cron_invoke_edge_function() raises a NOTICE and returns null without
--     sending anything at all. The job succeeds. The board is green. No
--     recap has ever been sent.
--
-- That is launch-readiness B2's shape moved into the monitoring layer: a
-- surface reporting health it has not measured, which is worse than no
-- surface, because it converts "we do not know" into "we are fine".
--
-- WHAT IS ADDED, and what is deliberately not.
--
-- A ledger, because the response cannot otherwise be attributed. pg_net gives
-- back a request id and puts the response in net._http_response under that
-- id; nothing records which slug a given id belonged to. Without that, the
-- most this could say is "something returned 500", which is not enough to act
-- on at two in the morning. So cron_invoke_edge_function() now writes the id
-- and the slug down, and the checker joins on it.
--
-- NOT a second alerting path, NOT a new schedule, and NOT a change to what
-- job_health_status() exposes. The anon-callable status function still
-- returns only ok / failing_count / last_checked_at; every name added below
-- lands in failing_jobs, which is operator-only and stays that way.

-- =====================================================================
-- 1. The ledger
-- =====================================================================
create table if not exists public.edge_function_invocations (
  request_id bigint primary key,
  slug text not null,
  invoked_at timestamptz not null default now()
);

create index if not exists edge_function_invocations_invoked_idx
  on public.edge_function_invocations (invoked_at desc);

-- Same posture as job_health_state (202609190001): RLS on, no policy, no
-- grant. Only SECURITY DEFINER functions reach it. This table says which
-- scheduled jobs ran and how they answered, which is operator detail.
alter table public.edge_function_invocations enable row level security;
revoke all on public.edge_function_invocations from public, anon, authenticated;

comment on table public.edge_function_invocations is
  'Which pg_net request id belonged to which Edge Function slug (202609230008). Written by cron_invoke_edge_function(), read by job_health_check() to attribute a net._http_response row back to the job that caused it - pg_net records the response under a request id and nothing else remembers what that id was for. Operator-only: RLS enabled with no policy and no grant. Pruned to 7 days on every health check.';

-- =====================================================================
-- 2. Record the request id
-- =====================================================================
-- Unchanged in every respect except the insert: same slug validation, same
-- Vault read, same placeholder guard, same fire-and-forget post.
create or replace function public.cron_invoke_edge_function(p_slug text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_base text;
  v_key text;
  v_request_id bigint;
begin
  if p_slug is null or p_slug !~ '^[a-z][a-z0-9_-]{2,63}$' then
    raise exception 'unknown edge function %', p_slug;
  end if;

  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'edge_functions_base_url';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'edge_functions_service_role_key';

  if v_base is null or v_key is null
     or v_base like '%PROJECT-REF-NOT-SET%'
     or v_key = 'SERVICE-ROLE-KEY-NOT-SET' then
    raise notice 'cron_invoke_edge_function(%): skipped, the edge_functions_* Vault secrets are unset or still placeholders', p_slug;
    return null;
  end if;

  v_request_id := net.http_post(
    url := rtrim(v_base, '/') || '/' || p_slug,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 30000
  );

  -- The whole point of this migration. Without this row the response in
  -- net._http_response is anonymous and cannot be blamed on a job.
  insert into public.edge_function_invocations (request_id, slug)
  values (v_request_id, p_slug)
  on conflict (request_id) do nothing;

  return v_request_id;
end;
$$;

-- =====================================================================
-- 3. Are the secrets even set?
-- =====================================================================
-- The same three conditions cron_invoke_edge_function() checks, in one place
-- something else can ask about. Definer because vault.decrypted_secrets is
-- not readable by the caller, and it returns a BOOLEAN rather than the
-- secret - nothing here can be used to read a key.
create or replace function public.edge_functions_ready()
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_base text;
  v_key text;
begin
  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'edge_functions_base_url';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'edge_functions_service_role_key';
  return v_base is not null and v_key is not null
     and v_base not like '%PROJECT-REF-NOT-SET%'
     and v_key <> 'SERVICE-ROLE-KEY-NOT-SET';
end;
$$;
revoke all on function public.edge_functions_ready() from public, anon, authenticated;
comment on function public.edge_functions_ready() is
  'True when the edge_functions_* Vault secrets are set and are not placeholders (202609230008). Returns a boolean, never a secret. Revoked from everyone: job_health_check() is the only caller, and whether a deployment is configured is not a member''s business.';

-- =====================================================================
-- 4. The checker learns the two silent failures
-- =====================================================================
-- THE BODY BELOW IS THE LIVE ONE, read out of the database with
-- pg_get_functiondef() after all 190 migrations applied, with two clauses and
-- a prune inserted. It is not a rewrite from memory: the first draft of this
-- migration WAS one, and it declared `returns void` against a function that
-- returns integer, which Postgres refused outright - and it had also invented
-- a notification type and alert copy that do not exist here. Everything the
-- previous definition flagged, it still flags, in its own words.
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
