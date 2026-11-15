-- 202611150003 (3.12.0): anonymous client error reports and the feedback box.
--   1. anon and authenticated can call both functions; nobody but service_role can read either table.
--   2. Every field is validated; a bad one raises 22023 and stores nothing.
--   3. The limits hold: errors 30 an hour per IP and 2,000 a day; feedback 5 a day per device, 20 a day per IP
--      and 500 a day. A refusal is quiet (void, nothing stored).
--   4. The app comes from the Origin header; no raw IP is stored anywhere, only an HMAC in the counter table.
--   5. Both purges work and are scheduled; feedback_by_screen() is owner-only.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
delete from public.client_error_reports;
delete from public.app_feedback;
delete from public.transfer_attempts where action in ('client_error_ip', 'feedback_ip', 'feedback_device');

create function tests.as_club(p_ip text) returns void language plpgsql as $fn$
begin
  perform set_config('request.headers', json_build_object('origin', 'https://haimunia.pages.dev', 'x-forwarded-for', p_ip || ', 10.0.0.1')::text, true);
end $fn$;
create function tests.err(p_fp text default 'abcd1234') returns void language sql as $fn$
  select public.client_error_report('3.12.0', 'add', 'error', 'TypeError', 'x is not a function', 'app.js', 120, 7, p_fp)
$fn$;
create function tests.fb(p_device text, p_body text default 'הכפתור קטן מדי') returns void language sql as $fn$
  select public.feedback_submit('3.12.0', 'add', 'ios', true, p_body, p_device)
$fn$;
grant execute on function tests.as_club(text), tests.err(text), tests.fb(text, text) to anon, authenticated;
create function tests.err_count() returns integer language sql stable security definer set search_path = '' as $fn$ select count(*)::int from public.client_error_reports $fn$;
create function tests.fb_count() returns integer language sql stable security definer set search_path = '' as $fn$ select count(*)::int from public.app_feedback $fn$;
grant execute on function tests.err_count(), tests.fb_count() to anon, authenticated;

-- 1. Grants -----------------------------------------------------------------------------------------
select ok(has_function_privilege('anon', 'public.client_error_report(text,text,text,text,text,text,integer,integer,text)', 'execute'), 'anon can call client_error_report');
select ok(has_function_privilege('authenticated', 'public.client_error_report(text,text,text,text,text,text,integer,integer,text)', 'execute'), 'authenticated can call client_error_report');
select ok(has_function_privilege('anon', 'public.feedback_submit(text,text,text,boolean,text,text)', 'execute'), 'anon can call feedback_submit');
select ok(has_function_privilege('authenticated', 'public.feedback_submit(text,text,text,boolean,text,text)', 'execute'), 'authenticated can call feedback_submit');
select ok(not has_table_privilege('anon', 'public.client_error_reports', 'select'), 'anon cannot select client_error_reports');
select ok(not has_table_privilege('authenticated', 'public.client_error_reports', 'select'), 'authenticated cannot select client_error_reports');
select ok(not has_table_privilege('anon', 'public.app_feedback', 'select'), 'anon cannot select app_feedback');
select ok(not has_table_privilege('authenticated', 'public.app_feedback', 'select'), 'authenticated cannot select app_feedback');
select ok(not has_table_privilege('anon', 'public.app_feedback', 'insert'), 'anon cannot insert into app_feedback directly');
select ok(not has_table_privilege('anon', 'public.client_error_reports', 'insert'), 'anon cannot insert into client_error_reports directly');
select ok(has_table_privilege('service_role', 'public.app_feedback', 'select'), 'service_role reads app_feedback');
select ok(has_table_privilege('service_role', 'public.client_error_reports', 'select'), 'service_role reads client_error_reports');
select ok(not has_table_privilege('service_role', 'public.client_report_key', 'select'), 'nobody reads the HMAC key, not even service_role');
select ok((select relrowsecurity from pg_class where oid = 'public.app_feedback'::regclass)
      and (select relrowsecurity from pg_class where oid = 'public.client_error_reports'::regclass), 'RLS is on for both tables');
select is((select count(*)::int from pg_policies where tablename in ('app_feedback', 'client_error_reports')), 0, 'and neither has a policy');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name in ('app_feedback', 'client_error_reports')
              and column_name ~ '(user|username|device_id|^ip|ip_|name_|display)'), 0,
  'no user, username, device id or IP column in either table (client_error_reports.name is the error class)');
select ok(not has_function_privilege('anon', 'public.feedback_by_screen(date)', 'execute')
      and not has_function_privilege('authenticated', 'public.feedback_by_screen(date)', 'execute'), 'feedback_by_screen is granted to no client role');

set local role anon;
select tests.as_club('203.0.113.7');
select throws_ok($$ select count(*) from public.app_feedback $$, '42501', null, 'anon select on app_feedback is refused');
select throws_ok($$ select count(*) from public.client_error_reports $$, '42501', null, 'anon select on client_error_reports is refused');

-- 2. Fields -----------------------------------------------------------------------------------------
select lives_ok($$ select tests.err() $$, 'anon reports an error');
select tests.clear_auth();
select results_eq($$ select app, app_version, screen, kind, name, message, file, line, col, fp from public.client_error_reports $$,
  $$ values ('club'::text, '3.12.0'::text, 'add'::text, 'error'::text, 'TypeError'::text, 'x is not a function'::text, 'app.js'::text, 120, 7, 'abcd1234'::text) $$,
  'stored as sent, with the app from the Origin');
set local role anon;
select tests.as_club('203.0.113.7');
select throws_ok($$ select public.client_error_report('3.12.0', 'nowhere', 'error', null, 'm', 'app.js', 1, 1, 'abcd1234') $$, '22023', null, 'an unknown screen is refused');
select throws_ok($$ select public.client_error_report('3.12.0', 'add', 'crash', null, 'm', 'app.js', 1, 1, 'abcd1234') $$, '22023', null, 'an unknown kind is refused');
select throws_ok($$ select public.client_error_report('3.12.0', 'add', 'error', 'Type Error 2', 'm', 'app.js', 1, 1, 'abcd1234') $$, '22023', null, 'a name with spaces or digits is refused');
select throws_ok(format('select public.client_error_report(%L, %L, %L, null, %L, %L, 1, 1, %L)', '3.12.0', 'add', 'error', repeat('x', 201), 'app.js', 'abcd1234'), '22023', null, 'a message over 200 characters is refused');
select throws_ok($$ select public.client_error_report('3.12.0', 'add', 'error', null, 'm', 'https://evil.example/x.js', 1, 1, 'abcd1234') $$, '22023', null, 'a URL as the file is refused');
select throws_ok($$ select public.client_error_report('3.12.0', 'add', 'error', null, 'm', 'app.js', 1, 1, 'XYZ') $$, '22023', null, 'a bad fingerprint is refused');
select throws_ok($$ select public.client_error_report('3.12.0 beta build', 'add', 'error', null, 'm', 'app.js', 1, 1, 'abcd1234') $$, '22023', null, 'a bad version is refused');
select throws_ok($$ select public.client_error_report('3.12.0', 'add', 'error', null, 'm', 'app.js', -1, 1, 'abcd1234') $$, '22023', null, 'a negative line is refused');
select lives_ok($$ select public.client_error_report('3.12.0', 'other', 'storage', null, '', 'other', null, null, '00ff00ff') $$, 'the smallest valid report is accepted');
select set_config('request.headers', json_build_object('origin', 'https://example.com', 'x-forwarded-for', '192.0.2.200')::text, true);
select public.client_error_report('3.12.0', 'add', 'error', null, 'm', 'app.js', 1, 1, 'feedbeef');
select tests.clear_auth();
select is((select app from public.client_error_reports where fp = 'feedbeef'), 'unknown', 'another Origin is recorded as unknown, never trusted from the caller');
set local role anon;
select tests.as_club('203.0.113.7');

select lives_ok($$ select tests.fb('dev-aaaaaaaaaaaaaaaa') $$, 'anon sends feedback');
select throws_ok($$ select tests.fb('dev-aaaaaaaaaaaaaaaa', '   ') $$, '22023', null, 'an empty body is refused');
select throws_ok(format('select tests.fb(%L, %L)', 'dev-aaaaaaaaaaaaaaaa', repeat('א', 1001)), '22023', null, 'a body over 1000 characters is refused');
select lives_ok(format('select tests.fb(%L, %L)', 'dev-cccccccccccccccc', repeat('א', 1000)), 'exactly 1000 characters is accepted');
select throws_ok($$ select public.feedback_submit('3.12.0', 'add', 'tablet', false, 'x', 'dev-aaaaaaaaaaaaaaaa') $$, '22023', null, 'an unknown device type is refused');
select throws_ok($$ select public.feedback_submit('3.12.0', 'add', 'ios', false, 'x', 'short') $$, '22023', null, 'a missing or short device id is refused');
select throws_ok($$ select public.feedback_submit('3.12.0', 'nowhere', 'ios', false, 'x', 'dev-aaaaaaaaaaaaaaaa') $$, '22023', null, 'an unknown screen is refused');
select tests.clear_auth();
select is((select row(app, screen, device_type, standalone, body)::text from public.app_feedback where body = 'הכפתור קטן מדי'),
  row('club', 'add', 'ios', true, 'הכפתור קטן מדי')::text, 'feedback is stored with the app from the Origin, nothing else added');

-- 3. Limits -----------------------------------------------------------------------------------------
-- Errors: 30 an hour per IP. 203.0.113.7 has 2 so far.
delete from public.client_error_reports;
delete from public.transfer_attempts where action = 'client_error_ip';
set local role anon;
select tests.as_club('198.51.100.1');
select tests.err() from generate_series(1, 31);
select tests.clear_auth();
select is(tests.err_count(), 30, 'errors: the 31st report in an hour from one IP is dropped quietly');
set local role anon;
select tests.as_club('198.51.100.2');
select lives_ok($$ select tests.err() $$, 'another IP is not affected');
select tests.clear_auth();
select is(tests.err_count(), 31, 'and is stored');
-- Errors: 2,000 a day in total.
insert into public.client_error_reports (app, app_version, screen, kind, message, file, fp)
select 'club', '3.12.0', 'add', 'error', 'seed', 'app.js', 'abcd1234' from generate_series(1, 1969);
set local role anon;
select tests.as_club('198.51.100.3');
select tests.err();
select tests.clear_auth();
select is(tests.err_count(), 2000, 'errors: nothing past 2,000 a day');

-- Feedback: 5 a day per device.
delete from public.app_feedback;
delete from public.transfer_attempts where action in ('feedback_ip', 'feedback_device');
set local role anon;
select tests.as_club('192.0.2.10');
select tests.fb('dev-dddddddddddddddd') from generate_series(1, 6);
select tests.clear_auth();
select is(tests.fb_count(), 5, 'feedback: the 6th from one device in a day is dropped quietly');
-- 20 a day per IP, whatever the device.
set local role anon;
select tests.as_club('192.0.2.10');
select tests.fb('dev-' || lpad(i::text, 16, '0')) from generate_series(1, 20) i;
select tests.clear_auth();
-- The IP counter counts attempts: the 6 above (the refused 6th included) and 14 of these 20 fit in 20.
select is(tests.fb_count(), 19, 'feedback: 20 attempts a day from one IP, new devices or not');
-- 500 a day in total.
insert into public.app_feedback (app, app_version, screen, device_type, body)
select 'club', '3.12.0', 'add', 'ios', 'seed' from generate_series(1, 480);  -- 19 + 480 = 499
set local role anon;
select tests.as_club('192.0.2.99');
select tests.fb('dev-eeeeeeeeeeeeeeee');
select tests.clear_auth();
select is(tests.fb_count(), 500, 'feedback: the 500th of the day is stored');
set local role anon;
select tests.as_club('192.0.2.98');
select tests.fb('dev-ffffffffffffffff');
select tests.clear_auth();
select is(tests.fb_count(), 500, 'feedback: nothing past 500 a day');

-- 4. No raw IP anywhere -----------------------------------------------------------------------------
select is((select count(*)::int from public.transfer_attempts
            where action in ('client_error_ip', 'feedback_ip', 'feedback_device')
              and (ip_hash like '%192.0.2%' or ip_hash like '%198.51.100%' or ip_hash like '%dev-%')), 0,
  'the counters hold HMACs, never the IP or the device id');
select ok((select bool_and(ip_hash ~ '^[0-9a-f]{64}$') from public.transfer_attempts
            where action in ('client_error_ip', 'feedback_ip', 'feedback_device')), 'each counter key is a 64-hex HMAC');

-- 5. Purges, schedules and the owner read -------------------------------------------------------------
update public.client_error_reports set created_at = now() - interval '31 days' where message = 'seed';
select ok(public.client_error_reports_purge() >= 1969, 'error reports older than 30 days are purged');
select is((select count(*)::int from public.client_error_reports where message = 'seed'), 0, 'none left');
update public.app_feedback set created_at = now() - interval '13 months' where body = 'seed';
select ok(public.app_feedback_purge() >= 480, 'feedback older than 12 months is purged');
select is((select count(*)::int from public.app_feedback where body = 'seed'), 0, 'none left');
select ok(exists (select 1 from cron.job where jobname = 'client-error-reports-purge'), 'the error purge is scheduled');
select ok(exists (select 1 from cron.job where jobname = 'app-feedback-purge'), 'the feedback purge is scheduled');
select is((select n from public.feedback_by_screen(current_date - 1) where screen = 'add'), 20::bigint, 'feedback_by_screen counts per screen (19 + 1 after the purge)');
select ok((select jsonb_array_length(newest) from public.feedback_by_screen(current_date - 1) where screen = 'add') <= 20, 'and returns at most the 20 newest');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select * from public.feedback_by_screen(current_date) $$, '42501', null, 'a member cannot read it');

select * from finish();
rollback;
