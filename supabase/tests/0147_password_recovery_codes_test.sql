-- 202610300001: password recovery codes.
--
-- Defended here:
--   1. recovery_codes and recovery_attempts have no client grant at all (anon,
--      authenticated, PUBLIC), RLS on, and no policy; service_role can use them.
--   2. owner_issue_reset_code() is reachable by nobody over the API (anon,
--      authenticated, service_role), refuses a call that carries an auth.uid(),
--      refuses an unknown member, returns a 4x4 code from the 32-symbol alphabet,
--      and stores only a salted HMAC.
--   3. A reset code works once, only for its member, only for an hour, and a
--      newer code replaces the older one.
--   4. The helpers the Edge Function calls are closed to every API role but
--      service_role, and my_recovery_code_created_at() answers only for the caller.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create temp table tok (k text primary key, v text);
grant all on tok to authenticated;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-0000-4000-8000-0000000000d1', 'authenticated', 'authenticated', 'dana_k@members.haimuniya.invalid', false, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-0000-4000-8000-0000000000d2', 'authenticated', 'authenticated', 'yoav@members.haimuniya.invalid', false, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-0000-4000-8000-0000000000d3', 'authenticated', 'authenticated', 'anon_one@members.haimuniya.invalid', true, now(), now());

-- ---------------------------------------------------------------------
-- 1. The tables are closed
-- ---------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.recovery_codes', 'select'), 'anon cannot select recovery_codes');
select ok(not has_table_privilege('authenticated', 'public.recovery_codes', 'select'), 'authenticated cannot select recovery_codes');
select ok(not has_table_privilege('authenticated', 'public.recovery_codes', 'insert'), 'authenticated cannot insert recovery_codes');
select ok(not has_table_privilege('authenticated', 'public.recovery_codes', 'update'), 'authenticated cannot update recovery_codes');
select ok(not has_table_privilege('authenticated', 'public.recovery_codes', 'delete'), 'authenticated cannot delete recovery_codes');
select ok(not has_table_privilege('anon', 'public.recovery_attempts', 'select'), 'anon cannot select recovery_attempts');
select ok(not has_table_privilege('authenticated', 'public.recovery_attempts', 'insert'), 'authenticated cannot insert recovery_attempts');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('recovery_codes', 'recovery_attempts')
      and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0, 'no table grant for anon, authenticated or PUBLIC on either table');
select ok(has_table_privilege('service_role', 'public.recovery_codes', 'insert'), 'service_role can write recovery_codes (the Edge Functions)');
select ok((select relrowsecurity from pg_class where oid = 'public.recovery_codes'::regclass), 'RLS is on for recovery_codes');
select ok((select relrowsecurity from pg_class where oid = 'public.recovery_attempts'::regclass), 'RLS is on for recovery_attempts');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('recovery_codes', 'recovery_attempts')), 0, 'and neither has a policy');

-- ---------------------------------------------------------------------
-- 2. owner_issue_reset_code is reachable by nobody over the API
-- ---------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.owner_issue_reset_code(text)', 'execute'), 'anon cannot execute owner_issue_reset_code');
select ok(not has_function_privilege('authenticated', 'public.owner_issue_reset_code(text)', 'execute'), 'authenticated cannot execute it');
select ok(not has_function_privilege('service_role', 'public.owner_issue_reset_code(text)', 'execute'), 'service_role cannot execute it either');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.owner_issue_reset_code(text)'::regprocedure and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner),
  0, 'the only holder of EXECUTE is the owner (postgres): no other grantee, PUBLIC included');

select tests.set_auth('dddddddd-0000-4000-8000-0000000000d1');
select throws_ok($$ select public.owner_issue_reset_code('yoav') $$, '42501', null, 'a signed-in member calling it gets permission denied');
select tests.clear_auth();

select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-0000000000d1', true);
select throws_ok($$ select public.owner_issue_reset_code('yoav') $$, 'P0001', 'not authorized', 'a call that carries an auth.uid() is refused even as postgres');
select set_config('request.jwt.claim.sub', '', true);

select throws_ok($$ select public.owner_issue_reset_code('nobody_here') $$, 'P0001', null, 'an unknown username is refused');
select throws_ok($$ select public.owner_issue_reset_code('anon_one') $$, 'P0001', null, 'an anonymous account has no username to reset');

-- ---------------------------------------------------------------------
-- 3. What it mints, and that it works once
-- ---------------------------------------------------------------------
insert into tok select 'code', public.owner_issue_reset_code('Yoav');
select matches((select v from tok where k = 'code'), '^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$',
  'a code is four groups of four from the 32-symbol alphabet, and the username is case-insensitive');
insert into tok select 'norm', replace(v, '-', '') from tok where k = 'code';

select is((select count(*)::int from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset'), 1, 'one reset row for the member');
select is((select count(*)::int from public.recovery_codes where code_hmac = (select v from tok where k = 'norm') or code_hmac = (select v from tok where k = 'code')), 0, 'the code itself is not stored');
select is((select code_hmac from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset'),
  encode(hmac('box-log:reset-code:v1:' || (select v from tok where k = 'norm'), (select salt from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset'), 'sha256'), 'hex'),
  'only a salted HMAC with a domain prefix is stored');
select ok((select expires_at > now() + interval '59 minutes' and expires_at <= now() + interval '1 hour' from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset'), 'it expires in one hour');

select ok(not public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d2', 'AAAA-AAAA-AAAA-AAAA'), 'a wrong code is refused');
select ok(not public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d1', (select v from tok where k = 'code')), 'the right code for another member is refused');
select ok(not public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d2', 'short'), 'a malformed code is refused');
select ok(public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d2', lower((select v from tok where k = 'code'))), 'the right code works (dashes and case do not matter)');
select ok(not public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d2', (select v from tok where k = 'code')), 'and only once');
select ok((select used_at is not null from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset'), 'the row is marked used');

-- Expiry.
delete from tok where k in ('code');
insert into tok select 'code', public.owner_issue_reset_code('yoav');
select ok((select used_at is null from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset'), 'a new code replaces the spent one and is unused');
update public.recovery_codes set expires_at = now() - interval '1 second' where user_id = 'dddddddd-0000-4000-8000-0000000000d2' and kind = 'reset';
select ok(not public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d2', (select v from tok where k = 'code')), 'an expired code is refused');

-- A newer code replaces the older one.
insert into tok select 'first', public.owner_issue_reset_code('dana_k');
insert into tok select 'second', public.owner_issue_reset_code('dana_k');
select is((select count(*)::int from public.recovery_codes where user_id = 'dddddddd-0000-4000-8000-0000000000d1' and kind = 'reset'), 1, 'still one reset row per member');
select ok(not public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d1', (select v from tok where k = 'first')), 'the older code no longer works');
select ok(public.recovery_consume_reset_code('dddddddd-0000-4000-8000-0000000000d1', (select v from tok where k = 'second')), 'the newer one does');

-- ---------------------------------------------------------------------
-- 4. The helpers
-- ---------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.recovery_consume_reset_code(uuid, text)', 'execute'), 'anon cannot spend a reset code');
select ok(not has_function_privilege('authenticated', 'public.recovery_consume_reset_code(uuid, text)', 'execute'), 'authenticated cannot spend a reset code');
select ok(has_function_privilege('service_role', 'public.recovery_consume_reset_code(uuid, text)', 'execute'), 'service_role can');
select ok(not has_function_privilege('authenticated', 'public.recovery_lookup_user(text)', 'execute'), 'authenticated cannot look a username up');
select ok(not has_function_privilege('anon', 'public.recovery_revoke_sessions(uuid)', 'execute'), 'anon cannot revoke sessions');
select ok(not has_function_privilege('authenticated', 'public.recovery_revoke_sessions(uuid)', 'execute'), 'authenticated cannot revoke sessions');
select ok(has_function_privilege('service_role', 'public.recovery_revoke_sessions(uuid)', 'execute'), 'service_role can');

select is(public.recovery_lookup_user('  Yoav '), 'dddddddd-0000-4000-8000-0000000000d2'::uuid, 'a username finds its account (trimmed, case-insensitive)');
select is(public.recovery_lookup_user('anon_one'), null::uuid, 'an anonymous account is not found');
select is(public.recovery_lookup_user('nobody_here'), null::uuid, 'neither is an unknown name');

select ok(not has_function_privilege('anon', 'public.my_recovery_code_created_at()', 'execute'), 'anon cannot ask whether it has a code');
select ok(has_function_privilege('authenticated', 'public.my_recovery_code_created_at()', 'execute'), 'authenticated can');
insert into public.recovery_codes (user_id, kind, code_hmac) values ('dddddddd-0000-4000-8000-0000000000d1', 'recovery', 'x');
select tests.set_auth('dddddddd-0000-4000-8000-0000000000d1');
select isnt(public.my_recovery_code_created_at(), null::timestamptz, 'a member with a code sees when it was made');
select tests.clear_auth();
select tests.set_auth('dddddddd-0000-4000-8000-0000000000d2');
select is(public.my_recovery_code_created_at(), null::timestamptz, 'a member without one sees null, and never another member''s row');
select tests.clear_auth();

select * from finish();
rollback;
