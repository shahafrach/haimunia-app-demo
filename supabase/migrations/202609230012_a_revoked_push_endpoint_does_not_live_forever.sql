-- Launch-readiness N11: revoked push subscriptions were kept indefinitely,
-- with no retention period stated anywhere.
--
-- When a browser withdraws a push subscription the row is marked revoked and
-- then kept forever - a dead endpoint URL and the keys that went with it,
-- for every device every member has ever stopped using. Nothing read it
-- again and nothing removed it.
--
-- Added to the retention job that already runs daily rather than given a
-- schedule of its own: this is the same class of promise as the 90-day
-- community-activity retention, and a second cron job for four rows a year
-- would be a second thing to watch.
--
-- The body below is the live definition read with pg_get_functiondef(), with
-- one delete added before the return.
CREATE OR REPLACE FUNCTION public.retention_purge_telemetry(p_days integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 3650);
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  v_deleted integer := 0;
  v_n integer;
begin
  delete from public.feed_impressions where shown_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.analytics_events where created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.feed_interactions where created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.activity_pings
   where activity_date < v_cutoff::date or created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  -- Launch-readiness N11. A push subscription the browser has already revoked
  -- is a dead endpoint plus the keys that went with it, kept forever.
  --
  -- NINETY DAYS, NOT v_days. This deliberately does not follow the caller's
  -- retention argument: v_days is the community-activity promise
  -- (PRIVACY.md), and a revoked push endpoint is not community activity - it
  -- is a device registration that has already been withdrawn. Tying them
  -- together would mean a future change to one silently moving the other.
  --
  -- Not deleted the instant it is revoked, because revoked_at is also what
  -- stops notif_push_pending() re-selecting a dead endpoint; a short tail
  -- keeps that cheap and leaves room to see what happened after a delivery
  -- incident.
  delete from public.push_subscriptions
   where revoked_at is not null
     and revoked_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  return v_deleted;
end $function$;
