-- Anonymous usage counts from the training-log edition (202609230013).
--
-- The table is the first one in this schema that the anon role can write
-- to, so every door is checked from both sides: what anon can do, what it
-- cannot, what a member sees, and what staff see (totals, never a row).
-- Then the two bounds on its size: the daily cap and the 180-day purge.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ---------------------------------------------------------------------------
-- The shape of the grants.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.training_log_usage'::regclass),
  'training_log_usage has RLS enabled');
select ok(has_column_privilege('anon', 'public.training_log_usage', 'device_id', 'insert'), 'anon may insert device_id');
select ok(has_column_privilege('anon', 'public.training_log_usage', 'event', 'insert'), 'anon may insert event');
select ok(has_column_privilege('anon', 'public.training_log_usage', 'screen', 'insert'), 'anon may insert screen');
select ok(not has_column_privilege('anon', 'public.training_log_usage', 'day', 'insert'), 'anon may NOT choose the day');
select ok(not has_table_privilege('anon', 'public.training_log_usage', 'select'), 'anon cannot read a single row back');
select ok(not has_table_privilege('anon', 'public.training_log_usage', 'update'), 'anon cannot update');
select ok(not has_table_privilege('anon', 'public.training_log_usage', 'delete'), 'anon cannot delete');
select ok(not has_table_privilege('authenticated', 'public.training_log_usage', 'insert'), 'a signed-in member has no reason to insert and cannot');
select ok(not has_table_privilege('authenticated', 'public.training_log_usage', 'update'), 'nor update');
select ok(not has_table_privilege('authenticated', 'public.training_log_usage', 'delete'), 'nor delete');
select ok(not has_table_privilege('authenticated', 'public.training_log_usage', 'select'), 'no signed-in role, staff included, can select a row');
select ok(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'training_log_usage' and cmd <> 'INSERT'),
  'the only policy on the table is the anon insert');
select ok(not has_function_privilege('anon', 'public.training_log_usage_report(integer)', 'execute'), 'anon cannot run the report');
select ok((select prosecdef from pg_proc where oid = 'public.training_log_usage_report(integer)'::regprocedure),
  'the report is SECURITY DEFINER: it is the only way out of the table');
select ok(not has_function_privilege('anon', 'public.training_log_usage_purge()', 'execute'), 'anon cannot run the purge');
select ok(not has_function_privilege('authenticated', 'public.training_log_usage_purge()', 'execute'), 'nor can a signed-in role');
select is((select schedule from cron.job where jobname = 'training-log-usage-purge'), '47 3 * * *',
  'the purge is scheduled nightly');

-- ---------------------------------------------------------------------------
-- What anon can write.
-- ---------------------------------------------------------------------------
select tests.clear_auth();
set local role anon;
select lives_ok($$ insert into public.training_log_usage (device_id, event) values ('11111111-1111-4111-8111-111111111111', 'app_open') $$,
  'anon counts an app open');
select lives_ok($$ insert into public.training_log_usage (device_id, event) values ('11111111-1111-4111-8111-111111111111', 'app_open') $$,
  'the same fact again the same day is not an error');
select lives_ok($$ insert into public.training_log_usage (device_id, event) values ('11111111-1111-4111-8111-111111111111', 'workout_logged') $$,
  'anon counts a logged workout');
select lives_ok($$ insert into public.training_log_usage (device_id, event, screen) values ('11111111-1111-4111-8111-111111111111', 'screen_open', 'wod'), ('22222222-2222-4222-8222-222222222222', 'screen_open', 'history') $$,
  'anon counts screens opened');
select throws_ok($$ insert into public.training_log_usage (device_id, event) values ('11111111-1111-4111-8111-111111111111', 'workout_content') $$,
  '23514', null, 'an event outside the three is refused');
select throws_ok($$ insert into public.training_log_usage (device_id, event, screen) values ('11111111-1111-4111-8111-111111111111', 'screen_open', 'community') $$,
  '23514', null, 'a screen this edition does not have is refused');
select throws_ok($$ insert into public.training_log_usage (device_id, event, screen) values ('11111111-1111-4111-8111-111111111111', 'app_open', 'wod') $$,
  '23514', null, 'a screen attached to a non-screen event is refused');
select throws_ok($$ insert into public.training_log_usage (day, device_id, event) values ('2020-01-01', '11111111-1111-4111-8111-111111111111', 'app_open') $$,
  '42501', null, 'anon cannot backdate a row');
select throws_ok($$ select count(*) from public.training_log_usage $$, '42501', null, 'anon cannot read');
reset role;

-- ---------------------------------------------------------------------------
-- One row per fact per day, stamped with the server's day.
-- ---------------------------------------------------------------------------
select tests.clear_auth();
select is((select count(*)::int from public.training_log_usage where device_id = '11111111-1111-4111-8111-111111111111' and event = 'app_open'), 1,
  'two app opens the same day are stored once');
select is((select count(*)::int from public.training_log_usage where day <> (now() at time zone 'Asia/Jerusalem')::date), 0,
  'every row carries the club-time-zone day the server stamped');

-- ---------------------------------------------------------------------------
-- Who can read it: nobody reads a row; staff get totals.
-- ---------------------------------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select count(*) from public.training_log_usage $$, '42501', null, 'a member cannot read a row');
select throws_ok($$ select public.training_log_usage_report() $$, '42501', 'not authorized',
  'a member is refused the report outright, not handed a report of zeros');

select tests.set_auth(tests.uid('coach'));
select throws_ok($$ select count(*) from public.training_log_usage $$, '42501', null, 'staff cannot read a row either');
select is((public.training_log_usage_report(4) ->> 'devices_seen')::int, 2, 'report: devices seen');
select is((public.training_log_usage_report(4) ->> 'devices_logged')::int, 1, 'report: devices that logged a workout');
select is(jsonb_array_length(public.training_log_usage_report(4) -> 'weeks'), 4, 'report: one entry per requested week, empty weeks included');
select is((public.training_log_usage_report(4) -> 'weeks' -> 3 ->> 'new_devices')::int, 2, 'report: this week''s new devices');
select ok(public.training_log_usage_report(4)::text !~ '11111111-1111-4111-8111-111111111111'
      and public.training_log_usage_report(4)::text !~ '22222222-2222-4222-8222-222222222222',
  'the report carries no device id');
select is((select array_agg(k order by k) from jsonb_object_keys(public.training_log_usage_report(4)) k),
  array['as_of','devices_logged','devices_logged_7d','devices_seen','devices_seen_7d','first_day','screens','weeks'],
  'the report is totals only: exactly these keys');

-- ---------------------------------------------------------------------------
-- The daily cap: the 1,001st row of a day is dropped, silently.
-- ---------------------------------------------------------------------------
select tests.clear_auth();
set local role anon;
-- 4 rows already today (the repeated app open was dropped); 996 more reach
-- exactly 1,000.
select lives_ok($$ insert into public.training_log_usage (device_id, event)
  select gen_random_uuid(), 'app_open' from generate_series(1, 996) $$, 'anon fills the day to 1,000 rows');
select lives_ok($$ insert into public.training_log_usage (device_id, event) values ('33333333-3333-4333-8333-333333333333', 'app_open') $$,
  'the 1,001st insert is not an error');
reset role;
select is((select count(*)::int from public.training_log_usage where day = (now() at time zone 'Asia/Jerusalem')::date), 1000,
  'the day holds 1,000 rows');
select is((select count(*)::int from public.training_log_usage where device_id = '33333333-3333-4333-8333-333333333333'), 0,
  'the 1,001st row was dropped');

-- ---------------------------------------------------------------------------
-- The purge: older than 180 days goes, the rest stays.
-- ---------------------------------------------------------------------------
-- Backdated rows can only be written with the stamping trigger off (as the
-- table owner, inside this transaction).
alter table public.training_log_usage disable trigger training_log_usage_before_insert;
insert into public.training_log_usage (day, device_id, event) values
  ((now() at time zone 'Asia/Jerusalem')::date - 181, '44444444-4444-4444-8444-444444444444', 'app_open'),
  ((now() at time zone 'Asia/Jerusalem')::date - 400, '44444444-4444-4444-8444-444444444444', 'workout_logged'),
  ((now() at time zone 'Asia/Jerusalem')::date - 180, '55555555-5555-4555-8555-555555555555', 'app_open'),
  ((now() at time zone 'Asia/Jerusalem')::date - 30,  '55555555-5555-4555-8555-555555555555', 'workout_logged');
alter table public.training_log_usage enable trigger training_log_usage_before_insert;
select is(public.training_log_usage_purge(), 2, 'the purge deletes the two rows older than 180 days');
select is((select count(*)::int from public.training_log_usage where device_id = '44444444-4444-4444-8444-444444444444'), 0,
  'nothing older than 180 days is left');
select is((select count(*)::int from public.training_log_usage where device_id = '55555555-5555-4555-8555-555555555555'), 2,
  'a row exactly 180 days old, and a recent one, stay');
select is((select count(*)::int from public.training_log_usage where day = (now() at time zone 'Asia/Jerusalem')::date), 1000,
  'today''s rows are untouched');

select * from finish();
rollback;
