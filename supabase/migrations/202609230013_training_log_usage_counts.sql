-- Anonymous usage counts for the training-log edition
-- (haimuniya.github.io/haimunia-app/, the community-free app members use).
--
-- THE QUESTION. The gym owner wants to know how many people use that app and
-- how many actually log workouts. That app has no accounts and no sign-in, and
-- keeps every workout on the member's own phone. So the answer can only come
-- from the app saying "a device opened me" - and it must be able to say that
-- without saying anything about who, or what they trained.
--
-- WHAT A ROW IS. One device, one kind of event, one day:
--   device_id  a random UUID the app generates on the phone the first time it
--              counts, and keeps in localStorage. Not derived from anything;
--              clearing site data makes a new one. It is PSEUDONYMOUS, not
--              anonymous: it links one phone's counts across days, which is
--              what makes "devices this week" and the weekly trend possible.
--   event      app_open | workout_logged | screen_open. Nothing else exists.
--   screen     for screen_open only: add | history | calendar | wod.
--   day        stamped HERE, in the club's time zone - the client cannot set
--              it, and there is no timestamp finer than the day.
-- No name, no account, no IP, no user agent, no workout content: the columns
-- are the whole record, and none of them could hold any of that.
--
-- AT MOST ONE ROW PER (day, device, event, screen). A second insert of the
-- same fact is dropped by the trigger below, silently, so "opened the app six
-- times on Tuesday" is stored as "opened it on Tuesday". That is all the
-- report needs, and it means the table cannot describe anyone's day hour by
-- hour even to staff.
--
-- WHO CAN DO WHAT.
--   anon           INSERT of (device_id, event, screen) only. The app sends
--                  the publishable key and no session, so this is the role
--                  its requests arrive as. It cannot read a single row back,
--                  including its own.
--   authenticated  NOTHING on the table. Not even staff can read a row: the
--                  one way out is training_log_usage_report(), which returns
--                  totals only and refuses anyone who is not is_staff(). So
--                  no per-device, per-day row ever leaves the database.
--   nobody         UPDATE or DELETE through the API.
--
-- ABUSE. An anonymous insert grant means anyone holding the publishable key
-- (which is public by design) can add rows, and one statement can carry
-- hundreds of thousands of them with a fresh device id each - measured at
-- 168 bytes a row including indexes, three million rows would fill the free
-- tier's 500 MB and put the WHOLE project, community app included, into
-- read-only mode. So:
--   * the check constraints bound WHAT can be added;
--   * the trigger drops a repeat of the same fact the same day;
--   * the trigger drops EVERY row past 1,000 in one day (the club's real use
--     is about 600). The cost, accepted: whoever reaches the cap first - an
--     attacker - wipes out the rest of that day's counts;
--   * a nightly job deletes every row older than 180 days.
-- Together they bound the table at about 1,000 x 180 x 168 bytes, ~30 MB.
-- A script inventing device ids can still inflate "devices seen" up to the
-- cap; that is the honest limit of counting without accounts, and why the
-- report labels these as counts of devices, not people.

create table public.training_log_usage (
  day       date not null default ((now() at time zone 'Asia/Jerusalem')::date),
  device_id uuid not null,
  event     text not null,
  screen    text not null default '',
  primary key (day, device_id, event, screen),
  constraint training_log_usage_event_known
    check (event in ('app_open', 'workout_logged', 'screen_open')),
  constraint training_log_usage_screen_known
    check (screen in ('', 'add', 'history', 'calendar', 'wod')),
  constraint training_log_usage_screen_only_for_screen_open
    check ((event = 'screen_open') = (screen <> ''))
);

comment on table public.training_log_usage is
  'Pseudonymous per-device, per-day usage counts from the training-log edition (haimuniya.github.io/haimunia-app). Insert-only for anon (device_id, event, screen); no role can select a row - staff get totals through training_log_usage_report(); capped at 1,000 rows a day and purged after 180 days. See 202609230013.';

create index training_log_usage_device_idx on public.training_log_usage (device_id);

-- The day is always the server's, and a repeat of the same fact is not an
-- error - the app fires and forgets, and a 409 for "already counted today"
-- would only be noise in a member's browser console. Past the daily cap every
-- row is dropped the same silent way. SECURITY DEFINER so the checks can read
-- the table that anon cannot. The count runs on the primary key, which
-- leads with `day`.
create or replace function public.training_log_usage_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.day := (now() at time zone 'Asia/Jerusalem')::date;
  if (select count(*) from public.training_log_usage u where u.day = new.day) >= 1000 then
    return null;
  end if;
  if exists (
    select 1 from public.training_log_usage u
     where u.day = new.day and u.device_id = new.device_id
       and u.event = new.event and u.screen = new.screen
  ) then
    return null;
  end if;
  return new;
end
$$;
revoke all on function public.training_log_usage_before_insert() from public, anon, authenticated;

create trigger training_log_usage_before_insert
  before insert on public.training_log_usage
  for each row execute function public.training_log_usage_before_insert();

alter table public.training_log_usage enable row level security;

revoke all on table public.training_log_usage from public, anon, authenticated;
grant insert (device_id, event, screen) on table public.training_log_usage to anon;

-- The check constraints are the validation; this policy only opens the door
-- to the one role that needs it.
create policy training_log_usage_insert_anon on public.training_log_usage
  for insert to anon with check (true);

-- No select policy, and no select grant to anyone: see WHO CAN DO WHAT.

-- The staff report. One call answers the owner's two questions and the trend:
--   devices_seen        distinct devices that ever opened the app
--   devices_logged      distinct devices that logged at least one workout
--   *_7d                the same, for the last seven days
--   weeks[]             for each of the last p_weeks Monday-based weeks, oldest
--                       first and including empty weeks: devices active,
--                       devices that logged, and devices seen for the first time
--   screens[]           for the last 28 days, how many devices opened each screen
--
-- SECURITY DEFINER, because no caller can read the table itself: this function
-- is the only way anything leaves it, and what leaves is counts, never a row
-- or a device id. It refuses outright for anyone who is not staff, rather than
-- returning a report of zeros that would read as "nobody uses the app".
create or replace function public.training_log_usage_report(p_weeks integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 104);
  v_first_week date;
  v_out jsonb;
begin
  if not public.is_staff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_first_week := (date_trunc('week', v_today::timestamp) - make_interval(weeks => v_weeks - 1))::date;

  with u as (select * from public.training_log_usage),
  firsts as (select device_id, min(day) as first_day from u group by device_id),
  weeks as (
    select generate_series(v_first_week, date_trunc('week', v_today::timestamp)::date, interval '1 week')::date as week_start
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
    'first_day', (select min(day) from u),
    'devices_seen', (select count(distinct device_id) from u),
    'devices_logged', (select count(distinct device_id) from u where event = 'workout_logged'),
    'devices_seen_7d', (select count(distinct device_id) from u where day > v_today - 7),
    'devices_logged_7d', (select count(distinct device_id) from u where event = 'workout_logged' and day > v_today - 7),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object(
        'week_start', pw.week_start, 'devices', pw.devices,
        'logging_devices', pw.logging_devices, 'new_devices', pw.new_devices) order by pw.week_start)
      from per_week pw), '[]'::jsonb),
    'screens', coalesce((select jsonb_agg(jsonb_build_object('screen', s.screen, 'devices', s.devices) order by s.screen)
      from (select screen, count(distinct device_id) as devices from u
              where event = 'screen_open' and day > v_today - 28 group by screen) s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$$;

revoke all on function public.training_log_usage_report(integer) from public, anon;
grant execute on function public.training_log_usage_report(integer) to authenticated;

comment on function public.training_log_usage_report(integer) is
  'Staff-only summary of training_log_usage: devices seen, devices that logged a workout, both for the last 7 days, a weekly trend (Monday weeks, club time zone) and screen reach over 28 days. Totals only - never a row or a device id. SECURITY DEFINER because no role can read the table directly. Raises "not authorized" for anyone not is_staff().';

-- Retention: 180 days, then gone. The report reads twelve weeks, so nothing it
-- shows depends on older rows; "devices seen" is therefore "in the last 180
-- days". Callable only by the scheduler (and the owner), not through the API.
create or replace function public.training_log_usage_purge()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.training_log_usage
   where day < (now() at time zone 'Asia/Jerusalem')::date - 180;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;
revoke all on function public.training_log_usage_purge() from public, anon, authenticated;

-- Nightly, clear of the other 03:xx jobs. cron.schedule upserts on the name.
select cron.schedule('training-log-usage-purge', '47 3 * * *',
  $$select public.training_log_usage_purge()$$);
