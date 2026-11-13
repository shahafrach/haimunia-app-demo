-- 202611130001: usage counts from apps that send an "app" field are accepted again; the report filters by app.
--
-- The bug: 202611120001 granted anon INSERT on (device_id, event, screen) only. The old app since 3.3.0
-- (haimuniya/haimunia-app) and the club app since 3.7.0 (shahafrach/haimunia-club) add "app" to every
-- count, so PostgREST rejects each insert with 42501 and the count is lost. Production on 2026-11-13 held
-- zero rows with app = 'old'.
--
-- The fix keeps the decision that the server, not the phone, says which app sent a count:
--   1. anon may now write the app column, so these requests succeed;
--   2. the trigger still overwrites it from the Origin header, whatever the phone sent.
-- So anon still cannot choose the app; it can only stop being refused for naming it.
--
-- training_log_usage_report gains p_app (null = every app), so one app's numbers can be read alone.
-- Forward only; 202611120001 is not edited.

grant insert (app) on table public.training_log_usage to anon;

comment on table public.training_log_usage is
  'Pseudonymous per-device, per-day usage counts from the Haimunia club apps (the old app on haimuniya.github.io and the new one on haimunia.pages.dev). Insert-only for anon (device_id, event, screen, app); app is always overwritten from the Origin header. No role can select a row; totals through training_log_usage_report() (granted to no role). At most 2,000 rows a day, purged after 400 days. 202611120001, 202611130001.';

drop function if exists public.training_log_usage_report(integer);

-- Totals only, never a row or a device id. Granted to no role: the SQL editor (postgres) runs it.
create or replace function public.training_log_usage_report(p_weeks integer default 12, p_app text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 104);
  v_first_week date;
  v_out jsonb;
begin
  if auth.uid() is not null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_app is not null and p_app not in ('old', 'club', 'unknown') then
    raise exception 'unknown app %', p_app using errcode = '22023';
  end if;
  -- Weeks start Sunday, Asia/Jerusalem (decisions.md).
  v_first_week := v_today - extract(dow from v_today)::integer - 7 * (v_weeks - 1);
  with u as (select * from public.training_log_usage t where p_app is null or t.app = p_app),
  firsts as (select device_id, min(day) as first_day from u group by device_id),
  weeks as (
    select generate_series(v_first_week, v_today, interval '1 week')::date as week_start
  ),
  per_week as (
    select w.week_start,
      (select count(distinct u.device_id) from u
         where u.day >= w.week_start and u.day < w.week_start + 7) as devices,
      (select count(distinct u.device_id) from u
         where u.event = 'workout_logged' and u.day >= w.week_start and u.day < w.week_start + 7) as logging_devices,
      (select count(*) from firsts f
         where f.first_day >= w.week_start and f.first_day < w.week_start + 7) as new_devices
    from weeks w
  )
  select jsonb_build_object(
    'as_of', v_today,
    'app', p_app,
    'first_day', (select min(day) from u),
    'devices_seen', (select count(distinct device_id) from u),
    'devices_logged', (select count(distinct device_id) from u where event = 'workout_logged'),
    'devices_seen_7d', (select count(distinct device_id) from u where day > v_today - 7),
    'devices_logged_7d', (select count(distinct device_id) from u where event = 'workout_logged' and day > v_today - 7),
    'apps_7d', coalesce((select jsonb_object_agg(a.app, a.devices)
      from (select app, count(distinct device_id) as devices from u where day > v_today - 7 group by app) a), '{}'::jsonb),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object(
        'week_start', pw.week_start, 'devices', pw.devices,
        'logging_devices', pw.logging_devices, 'new_devices', pw.new_devices) order by pw.week_start)
      from per_week pw), '[]'::jsonb),
    'screens', coalesce((select jsonb_agg(jsonb_build_object('screen', s.screen, 'devices', s.devices) order by s.screen)
      from (select screen, count(distinct device_id) as devices from u
              where event = 'screen_open' and day > v_today - 28 group by screen) s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.training_log_usage_report(integer, text) from public, anon, authenticated;
