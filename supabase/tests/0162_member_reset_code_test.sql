-- The reset code a club's owner or coach hands over, and the owner's approve_reset (202611180003, Q-38 / Q-38b).
--
--   Friends circle F: m1 (owner), m2
--   Club K:           owner (owner), coach (coach), m3, norec          m1 is NOT in K

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

create function tests.kid() returns uuid language sql stable security definer set search_path = '' as
  $$ select c.id from public.clubs c where c.type = 'club' $$;
grant execute on function tests.kid() to authenticated, anon, service_role;
create function tests.fid() returns uuid language sql immutable as $$ select 'f3800000-0000-4000-8000-00000000000f'::uuid $$;
grant execute on function tests.fid() to authenticated, anon, service_role;

insert into public.clubs (id, name, type, created_by) values (tests.fid(), 'Friends F', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values (tests.fid(), tests.uid('m1'), 'owner'), (tests.fid(), tests.uid('m2'), 'member');
select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'), (tests.kid(), tests.uid('norec'), 'member');
select is(public.owner_set_coach('coach'), 'set', 'setup: the coach');

-- =====================================================================================================
-- 1. Closed to clients
-- =====================================================================================================
select ok(not has_table_privilege('authenticated', 'public.member_reset_codes', 'select'), 'member_reset_codes: no select for authenticated');
select ok(not has_table_privilege('anon', 'public.member_reset_codes', 'select'), 'member_reset_codes: no select for anon');
select ok(not has_function_privilege('authenticated', 'public.member_reset_consume(text)', 'execute'), 'member_reset_consume: service_role only');
select ok(not has_function_privilege('authenticated', 'public.owner_approve_reset_request(text, text)', 'execute'), 'owner_approve_reset_request: no role');
select ok(not has_function_privilege('service_role', 'public.owner_approve_reset_request(text, text)', 'execute'), 'not even service_role');
select ok(not has_function_privilege('anon', 'public.club_issue_reset_code(uuid, uuid)', 'execute'), 'club_issue_reset_code: not anon');

-- =====================================================================================================
-- 2. Who may issue a code, for whom
-- =====================================================================================================
select tests.set_auth(tests.uid('m3'));
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.kid(), tests.uid('norec')), 'P0001', 'not authorized', 'a plain member cannot');
select tests.set_auth(tests.uid('m1'));
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.fid(), tests.uid('m2')), 'P0001', 'not authorized', 'a friends-circle owner cannot (not a club)');
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.kid(), tests.uid('m3')), 'P0001', 'not authorized', 'nor anyone outside the club');
select tests.set_auth(tests.uid('coach'));
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.kid(), tests.uid('owner')), 'P0001', 'not authorized', 'the coach can never reset the owner');
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.kid(), tests.uid('coach')), 'P0001', 'not authorized', 'nor themself');
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.kid(), tests.uid('m2')), 'P0001', 'member not found', 'nor someone in another circle only');

select public.club_issue_reset_code(tests.kid(), tests.uid('m3')) as code1 \gset
select ok(:'code1' ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$', 'the coach resets m3: an 8-character code from the join-code alphabet');
select tests.set_auth(tests.uid('owner'));
select public.club_issue_reset_code(tests.kid(), tests.uid('coach')) as code_coach \gset
select ok(:'code_coach' ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$', 'the owner can reset the coach');
select tests.clear_auth();
select is((select code_hash from public.member_reset_codes where user_id = tests.uid('m3')),
  encode(extensions.digest('haimunia:member-reset:v1:' || :'code1', 'sha256'), 'hex'), 'only the hash is stored');
select ok((select expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
             from public.member_reset_codes where user_id = tests.uid('m3')), '24 hours');
select is((select count(*)::int from public.club_staff_actions where action = 'member_password_reset'), 2, 'both resets are staff-logged');
select is((select target_id from public.club_staff_actions where action = 'member_password_reset' and actor_id = tests.uid('coach')),
  tests.uid('m3'), 'with the member as target');

-- =====================================================================================================
-- 3. Spending a code (service_role, as recover-password does)
-- =====================================================================================================
set local role service_role;
select is(public.member_reset_consume('ZZZZ2345'), null, 'a wrong code: null');
select is(public.member_reset_consume('ABC'), null, 'a malformed one: null');
select is(public.member_reset_consume(lower(substr(:'code1', 1, 4)) || '-' || substr(:'code1', 5)) ->> 'user_id', tests.uid('m3')::text,
  'the right code in lower case with a dash: the member');
select is(public.member_reset_consume(:'code1'), null, 'one use only');
reset role;

-- A new code replaces the old one, and an expired one is refused.
select tests.set_auth(tests.uid('coach'));
select public.club_issue_reset_code(tests.kid(), tests.uid('norec')) as code2 \gset
select public.club_issue_reset_code(tests.kid(), tests.uid('norec')) as code3 \gset
select tests.clear_auth();
select is((select count(*)::int from public.member_reset_codes where user_id = tests.uid('norec')), 1, 'one live code per member');
set local role service_role;
select is(public.member_reset_consume(:'code2'), null, 'the replaced code is dead');
reset role;
update public.member_reset_codes set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where user_id = tests.uid('norec');
set local role service_role;
select is(public.member_reset_consume(:'code3'), null, 'an expired code is refused');
reset role;

-- Rate limit: 10 a day per staff member (the coach has issued 3).
select tests.set_auth(tests.uid('coach'));
select lives_ok(format('select public.club_issue_reset_code(%L, %L) from generate_series(1, 7)', tests.kid(), tests.uid('m3')), 'issues 4 to 10');
select throws_ok(format('select public.club_issue_reset_code(%L, %L)', tests.kid(), tests.uid('m3')), 'P0001', 'rate_limited', 'the eleventh in a day is refused');

-- =====================================================================================================
-- 4. owner_approve_reset_request: the owner's own way back
-- =====================================================================================================
select tests.clear_auth();
insert into public.reset_requests (user_id, token_hmac, created_at, ready_at, expires_at)
values (tests.uid('owner'), 'abc123' || repeat('0', 58), now() - interval '5 minutes', now() + interval '55 minutes', now() + interval '25 hours');
select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select public.owner_approve_reset_request('owner', 'ABC123') $$, '42501', null, 'not callable from a session');
select tests.clear_auth();
select is(public.owner_approve_reset_request('owner', 'abc12'), 'bad_ref', 'a reference that is not 6 hex characters');
select is(public.owner_approve_reset_request('nobody_here', 'ABC123'), 'no_such_user', 'an unknown username');
select is(public.owner_approve_reset_request('m3', 'ABC123'), 'no_request', 'no open request');
select is(public.owner_approve_reset_request('owner', 'ABC124'), 'no_match', 'a reference from another request: the wait stays');
select ok((select ready_at > now() + interval '50 minutes' from public.reset_requests where user_id = tests.uid('owner')), 'unchanged');
select is(public.owner_approve_reset_request('sha256:' || encode(extensions.digest('owner', 'sha256'), 'hex'), 'abc-123'),
  'approved', 'the hashed username (what club-admin.yml sends) and the phone''s reference: approved');
select ok((select ready_at <= now() from public.reset_requests where user_id = tests.uid('owner')), 'the request is ready now');
select is(public.owner_approve_reset_request('owner', 'ABC123'), 'already', 'again: already');
update public.reset_requests set cancelled_at = now() where user_id = tests.uid('owner');
select is(public.owner_approve_reset_request('owner', 'ABC123'), 'cancelled', 'a cancelled request is never approved');

select * from finish();
rollback;
