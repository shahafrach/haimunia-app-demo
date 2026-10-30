-- 202610290001: the bootstrap owner invite and the narrowed support form.
--
-- Two things are defended here.
--   1. bootstrap_owner_invite() is reachable by nobody over the API (anon,
--      authenticated, service_role), works once, dies after an hour, stores
--      only a hash, and grants nothing beyond the right to create a first
--      circle.
--   2. bug_report_submit() keeps a message and an app version and nothing
--      else, works for a member who is in no circle, refuses an anonymous
--      session, and is rate-limited for real.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create temp table tok (k text primary key, v text);
grant all on tok to authenticated;

-- ---------------------------------------------------------------------
-- 1. Nobody can call it over the API
-- ---------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.bootstrap_owner_invite()', 'execute'), 'anon cannot execute bootstrap_owner_invite');
select ok(not has_function_privilege('authenticated', 'public.bootstrap_owner_invite()', 'execute'), 'authenticated cannot execute bootstrap_owner_invite');
select ok(not has_function_privilege('service_role', 'public.bootstrap_owner_invite()', 'execute'), 'service_role cannot execute it either');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.bootstrap_owner_invite()'::regprocedure and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner),
  0, 'the only holder of EXECUTE is the owner (postgres): no other grantee, PUBLIC included');

select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.bootstrap_owner_invite() $$, '42501', null, 'a signed-in member calling it gets permission denied');
select tests.clear_auth();

-- Second lock: even run as the owner role, a call that carries a user is refused.
select set_config('request.jwt.claim.sub', tests.uid('m1')::text, true);
select throws_ok($$ select public.bootstrap_owner_invite() $$, 'P0001', 'not authorized', 'a call that carries an auth.uid() is refused even as postgres');
select set_config('request.jwt.claim.sub', '', true);

-- ---------------------------------------------------------------------
-- 2. What it mints
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', null, true, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e2', 'authenticated', 'authenticated', null, true, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e3', 'authenticated', 'authenticated', null, true, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e4', 'authenticated', 'authenticated', 'e4@members.haimuniya.invalid', false, now(), now());

insert into tok select 'url', public.bootstrap_owner_invite();
insert into tok select 'token', substr(v, position('#invite=' in v) + 8) from tok where k = 'url';

select matches((select v from tok where k = 'url'), '^https://box-log\.pages\.dev/#invite=[0-9a-f]{64}$',
  'it returns the full invite URL with a 32-byte hex token after the #');
select is((select count(*)::int from public.invite_codes where code_hash = (select v from tok where k = 'token')), 0,
  'the token itself is not stored');
select is((select count(*)::int from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 1,
  'only its sha256 is stored');
select ok((select expires_at > now() + interval '59 minutes' and expires_at <= now() + interval '1 hour' from public.invite_codes
            where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')),
  'it expires in one hour');
select is((select max_uses from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 1,
  'it allows one use');

-- ---------------------------------------------------------------------
-- 3. It works once, and grants nothing but the first circle
-- ---------------------------------------------------------------------
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e1');
select is(public.redeem_invite_code((select v from tok where k = 'token'), 'pilot-actor-1'), 'member', 'the first redeemer is accepted');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e2');
select is(public.redeem_invite_code((select v from tok where k = 'token'), 'pilot-actor-2'), 'invalid', 'the same token a second time is refused');

select tests.clear_auth();
select is((select use_count from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 1,
  'and the use is counted once');
select is((select count(*)::int from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e1'), 0,
  'redeeming made the redeemer a member of no circle');
select is((select role from public.invite_redemptions where user_id = 'eeeeeeee-0000-4000-8000-0000000000e1'), 'member',
  'it left one redemption row, role member');
select is((select count(*)::int from public.invite_redemptions where user_id = 'eeeeeeee-0000-4000-8000-0000000000e2'), 0,
  'and the refused second redeemer has none');

insert into public.profiles (id, handle, display_name) values ('eeeeeeee-0000-4000-8000-0000000000e1', 'pilot_owner', 'Owner');

select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e1');
select ok(not public.is_community_member(), 'the redeemer is not a community member yet');
select is((select count(*)::int from public.workout_posts), 0, 'and reads no posts');
select is((select count(*)::int from public.clubs), 0, 'and sees no circle');
insert into tok select 'club', public.create_circle('friends', 'Pilot', null)::text;
select is((select role from public.circle_members where club_id = (select v::uuid from tok where k = 'club') and user_id = 'eeeeeeee-0000-4000-8000-0000000000e1'), 'owner',
  'what the token allowed: creating a first circle, as its owner');
select throws_ok($$ select public.bootstrap_owner_invite() $$, '42501', null, 'the new owner still cannot call the bootstrap function');
select tests.clear_auth();

-- ---------------------------------------------------------------------
-- 4. It expires after an hour
-- ---------------------------------------------------------------------
insert into tok select 'url2', public.bootstrap_owner_invite();
insert into tok select 'token2', substr(v, position('#invite=' in v) + 8) from tok where k = 'url2';
update public.invite_codes set expires_at = now() - interval '1 second'
 where code_hash = encode(digest((select v from tok where k = 'token2'), 'sha256'), 'hex');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e3');
select is(public.redeem_invite_code((select v from tok where k = 'token2'), 'pilot-actor-3'), 'invalid', 'a token past its hour is refused');
select tests.clear_auth();
select is((select count(*)::int from public.invite_redemptions where user_id = 'eeeeeeee-0000-4000-8000-0000000000e3'), 0, 'and leaves no redemption');

-- ---------------------------------------------------------------------
-- 5. The support form: a message and a version
-- ---------------------------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.bug_report_submit('אני רוצה למחוק את החשבון', '{"app_version":"4.39.0","ua":"Mozilla/5.0 secret","online":true,"standalone":true}'::jsonb) $$,
  'a member files a פנייה');
select lives_ok($$ select public.bug_report_submit('x', '{"version":"<script>"}'::jsonb) $$, 'a version that does not look like one is dropped, not stored');
select throws_ok($$ select count(*) from public.bug_reports $$, '42501', null, 'the table is still closed to clients');
select tests.clear_auth();
select is((select diagnostics from public.bug_reports where body = 'אני רוצה למחוק את החשבון'), '{"app_version": "4.39.0"}'::jsonb,
  'only app_version is kept; user agent, connection and the rest are discarded');
select is((select diagnostics from public.bug_reports where body = 'x'), '{"app_version": ""}'::jsonb, 'a bad version becomes empty');

-- someone in no circle can still write (access and deletion requests)
insert into public.profiles (id, handle, display_name) values ('eeeeeeee-0000-4000-8000-0000000000e4', 'no_circle', 'No Circle');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e4');
select lives_ok($$ select public.bug_report_submit('עזבתי את כל המעגלים', '{}'::jsonb) $$, 'a member who is in no circle can write');
-- an anonymous session (mid sign-up) cannot. "Anonymous" is what auth.users says
-- (202610290003): the JWT's claim goes stale when sign-up upgrades the session.
select tests.clear_auth();
update auth.users set is_anonymous = true where id = 'eeeeeeee-0000-4000-8000-0000000000e4';
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-4000-8000-0000000000e4","role":"authenticated","is_anonymous":true}', true);
select set_config('role', 'authenticated', true);
select throws_ok($$ select public.bug_report_submit('hi', '{}'::jsonb) $$, 'P0001', 'not authorized', 'an anonymous session cannot');
select tests.clear_auth();
update auth.users set is_anonymous = false where id = 'eeeeeeee-0000-4000-8000-0000000000e4';
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e3');
select throws_ok($$ select public.bug_report_submit('hi', '{}'::jsonb) $$, 'P0001', 'not authorized', 'someone with no profile cannot');
select tests.clear_auth();

-- the rate limit is enforced: 5 an hour
select tests.set_auth(tests.uid('m2'));
select lives_ok($$ select public.bug_report_submit('1', '{}'::jsonb) $$, 'report 1 of 5');
select lives_ok($$ select public.bug_report_submit('2', '{}'::jsonb) $$, 'report 2 of 5');
select lives_ok($$ select public.bug_report_submit('3', '{}'::jsonb) $$, 'report 3 of 5');
select lives_ok($$ select public.bug_report_submit('4', '{}'::jsonb) $$, 'report 4 of 5');
select lives_ok($$ select public.bug_report_submit('5', '{}'::jsonb) $$, 'report 5 of 5');
select throws_ok($$ select public.bug_report_submit('6', '{}'::jsonb) $$, 'P0001', 'rate_limited', 'the sixth in an hour is refused');
select tests.clear_auth();

select * from finish();
rollback;
