-- Anonymous usage counts from the training-log edition (202609230013).
--
-- The table is the first one in this schema that the anon role can write
-- to, so every door is checked from both sides: what anon can do, what it
-- cannot, what a member sees, and what staff see.

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
select ok(not has_function_privilege('anon', 'public.training_log_usage_report(integer)', 'execute'), 'anon cannot run the report');

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
-- Who can read it.
-- ---------------------------------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.training_log_usage), 0, 'a member reads no rows');
select throws_ok($$ select public.training_log_usage_report() $$, '42501', 'not authorized',
  'a member is refused the report outright, not handed a report of zeros');

select tests.set_auth(tests.uid('coach'));
select is((select count(*)::int from public.training_log_usage), 5, 'staff read every row');
select is((public.training_log_usage_report(4) ->> 'devices_seen')::int, 2, 'report: devices seen');
select is((public.training_log_usage_report(4) ->> 'devices_logged')::int, 1, 'report: devices that logged a workout');
select is(jsonb_array_length(public.training_log_usage_report(4) -> 'weeks'), 4, 'report: one entry per requested week, empty weeks included');
select is((public.training_log_usage_report(4) -> 'weeks' -> 3 ->> 'new_devices')::int, 2, 'report: this week''s new devices');

select * from finish();
rollback;
