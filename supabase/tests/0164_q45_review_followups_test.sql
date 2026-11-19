-- Q-45 (202611190001): client_report_ip_hash reads only cf-connecting-ip; the join code's global ceiling is 3000.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- 1. Only cf-connecting-ip decides the key. x-forwarded-for and x-real-ip alone are the one 'unknown' bucket.
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.1')::text, true);
create temp table k as select public.client_report_ip_hash('t:') as a;
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.2', 'x-real-ip', '192.0.2.3')::text, true);
select is(public.client_report_ip_hash('t:'), (select a from k), 'different x-forwarded-for / x-real-ip: same (unknown) key');
select set_config('request.headers', '{}', true);
select is(public.client_report_ip_hash('t:'), (select a from k), 'no header at all: the same unknown key');
select set_config('request.headers', json_build_object('cf-connecting-ip', '198.51.100.9', 'x-forwarded-for', '192.0.2.1')::text, true);
select isnt(public.client_report_ip_hash('t:'), (select a from k), 'cf-connecting-ip gives its own key');

-- 2. The ceiling: 2999 wrong codes this hour still let a code through to the check; 3000 stops it.
select tests.clear_auth();
delete from public.transfer_attempts where action in ('join_code', 'join_code_wrong');
insert into public.transfer_attempts (ip_hash, action, window_started_at, attempt_count)
values (repeat('0', 64), 'join_code_wrong', now(), 2999);
select tests.set_auth(tests.uid('m2'));
select set_config('request.headers', json_build_object('cf-connecting-ip', '198.51.100.45')::text, true);
select is(public.join_circle('ABCD2345') ->> 'status', 'invalid', 'at 2999 a code is still checked (a wrong one is invalid)');
select tests.clear_auth();
select is((select attempt_count from public.transfer_attempts where ip_hash = repeat('0', 64) and action = 'join_code_wrong'), 3000,
  'that wrong code counted: 3000');
select tests.set_auth(tests.uid('m2'));
select set_config('request.headers', json_build_object('cf-connecting-ip', '198.51.100.45')::text, true);
select is(public.join_circle('ABCD2346') ->> 'status', 'rate_limited', 'at 3000 code-joins stop for the hour');
select is(public.join_circle(repeat('ab', 32)) ->> 'status', 'invalid', 'the long link has no ceiling: still checked');
select tests.clear_auth();

select * from finish();
rollback;
