-- The club's short join code (202611180002, Q-37): an 8-character code on the club's one link row, accepted by
-- join_circle beside the 64-hex token. Expiry, max uses, the per-account limit, wrong codes, rotation and
-- cross-circle.
--
--   Friends circle F: m1 (owner), m2
--   Club K:           owner (owner), coach (coach), m3        joiners: m2, norec, admin; m1 spends its attempts

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
create function tests.fid() returns uuid language sql immutable as $$ select 'f3700000-0000-4000-8000-00000000000f'::uuid $$;
grant execute on function tests.fid() to authenticated, anon, service_role;

insert into public.clubs (id, name, type, created_by) values (tests.fid(), 'Friends F', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values (tests.fid(), tests.uid('m1'), 'owner'), (tests.fid(), tests.uid('m2'), 'member');
select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member');
select is(public.owner_set_coach('coach'), 'set', 'setup: the coach');

-- =====================================================================================================
-- 1. The helpers: closed to every client role; the alphabet; normalising
-- =====================================================================================================
select ok(not has_function_privilege('authenticated', 'public.join_code_generate()', 'execute'), 'join_code_generate: not callable by authenticated');
select ok(not has_function_privilege('anon', 'public.join_code_generate()', 'execute'), 'join_code_generate: not callable by anon');
select ok(not has_function_privilege('authenticated', 'public.join_code_normalize(text)', 'execute'), 'join_code_normalize: not callable by authenticated');
select ok(not has_function_privilege('anon', 'public.rotate_club_invite(uuid)', 'execute'), 'rotate_club_invite: not callable by anon');
select is(public.join_code_normalize(' ab-cd 23 45 '), 'ABCD2345', 'normalize: upper case, spaces and dashes removed');
select is_empty($$ select c from (select regexp_split_to_table(public.join_code_generate(), '') c from generate_series(1, 500)) s
                   where c !~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]$' $$,
  'every generated character is from the 31 unambiguous ones (no 0, O, 1, I, L)');
select is((select count(distinct c)::int from (select regexp_split_to_table(public.join_code_generate(), '') c from generate_series(1, 2000)) s),
  31, 'and all 31 occur');
select is((select count(*)::int from (select public.join_code_generate() g from generate_series(1, 200)) s where char_length(g) <> 8),
  0, 'every code is 8 characters');

-- =====================================================================================================
-- 2. rotate_club_invite: token and code once, both hashed; the same checks as rotate_club_link
-- =====================================================================================================
select tests.set_auth(tests.uid('m3'));
select throws_ok($$ select public.rotate_club_invite(tests.kid()) $$, 'P0001', 'not authorized', 'a plain member cannot rotate');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.rotate_club_invite(tests.fid()) $$, 'P0001', 'not authorized', 'the owner of a friends circle cannot use it on that circle');
select throws_ok($$ select public.rotate_club_invite(tests.kid()) $$, 'P0001', 'not authorized', 'nor on the club they are not in');

select tests.set_auth(tests.uid('coach'));
select public.rotate_club_invite(tests.kid()) as inv1 \gset
select ok((:'inv1'::jsonb ->> 'token') ~ '^[0-9a-f]{64}$', 'the coach rotates: the token as before');
select ok((:'inv1'::jsonb ->> 'code') ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$', 'and an 8-character code');
select (:'inv1'::jsonb ->> 'token') as tok1, (:'inv1'::jsonb ->> 'code') as code1 \gset
select tests.clear_auth();
select is((select count(*)::int from public.circle_invites where club_id = tests.kid()), 1, 'still one link row per club');
-- 202611180003 (Q-38f): an HMAC under the Vault key, no longer a plain sha256.
select is((select code_hash from public.circle_invites where club_id = tests.kid()),
  public.join_code_hmac(:'code1'), 'the code is stored as its HMAC only');
select ok(not exists (select 1 from public.circle_invites i where i.code_hash = :'code1' or i.token_hash = :'code1'), 'never the code itself');
select is((select expires_at from public.circle_invites where club_id = tests.kid()), 'infinity'::timestamptz, 'the link and its code do not expire');
select is((select max_uses from public.circle_invites where club_id = tests.kid()), 100000, 'the cap, not the row, limits joins');
select is((select count(*)::int from public.club_staff_actions where club_id = tests.kid() and action = 'link_rotate'), 1, 'the rotation is staff-logged');

-- =====================================================================================================
-- 3. join_circle with the code
-- =====================================================================================================
select tests.set_auth(tests.uid('m2'));
select is(public.join_circle(lower(substr(:'code1', 1, 4)) || ' - ' || substr(:'code1', 5, 4)) ->> 'status', 'joined',
  'm2 joins with the code typed in lower case, with a space and a dash');
select is((select count(*)::int from public.circle_members where club_id = tests.kid() and user_id = tests.uid('m2')), 1, 'm2 is in the club');
select is((select count(*)::int from public.circle_members where club_id = tests.fid() and user_id = tests.uid('m2')), 1,
  'and still in the friends circle only once: the code named the club, nothing else');
select is(public.join_circle(:'code1') ->> 'status', 'already_member', 'the code again: already_member');

select tests.set_auth(tests.uid('norec'));
select is(public.join_circle(:'tok1') ->> 'status', 'joined', 'the long token on the same row still works');
select tests.clear_auth();
select is((select uses from public.circle_invites where club_id = tests.kid()), 2, 'code and token count uses on the same row');

-- Wrong and malformed codes
select tests.set_auth(tests.uid('admin'));
select is(public.join_circle('ZZZZ2345') ->> 'status', 'invalid', 'a well-formed wrong code: invalid');
select is(public.join_circle('ABCD234') ->> 'status', 'invalid', 'seven characters: invalid');
select is(public.join_circle('ABCD23450') ->> 'status', 'invalid', 'nine characters: invalid');
select is(public.join_circle('ABCD2340') ->> 'status', 'invalid', 'a 0 (not in the alphabet): invalid');
select is(public.join_circle('') ->> 'status', 'invalid', 'empty: invalid');
select is(public.join_circle(null) ->> 'status', 'invalid', 'null: invalid');

-- Max uses: a row whose uses are spent refuses the code as it refuses the token.
select tests.clear_auth();
update public.circle_invites set max_uses = uses where club_id = tests.kid();
select tests.set_auth(tests.uid('admin'));
select is(public.join_circle(:'code1') ->> 'status', 'invalid', 'uses spent: the code is refused');
select tests.clear_auth();
update public.circle_invites set max_uses = 100000 where club_id = tests.kid();

-- Expiry: an expired row refuses the code.
update public.circle_invites set expires_at = now() - interval '1 minute' where club_id = tests.kid();
select tests.set_auth(tests.uid('admin'));
select is(public.join_circle(:'code1') ->> 'status', 'invalid', 'expired: the code is refused');
select tests.clear_auth();
update public.circle_invites set expires_at = 'infinity' where club_id = tests.kid();
select tests.set_auth(tests.uid('admin'));
select is(public.join_circle(:'code1') ->> 'status', 'joined', 'and the same code works once the row is live again');

-- =====================================================================================================
-- 4. Rotation ends the old code; rotate_club_link keeps its contract and also makes a code
-- =====================================================================================================
select tests.set_auth(tests.uid('owner'));
select public.rotate_club_invite(tests.kid()) ->> 'code' as code2 \gset
select tests.set_auth(tests.uid('m1'));
select is(public.join_circle(:'code1') ->> 'status', 'invalid', 'after a rotation the old code is invalid');
select tests.set_auth(tests.uid('owner'));
select public.rotate_club_link(tests.kid()) as tok3 \gset
select ok(:'tok3' ~ '^[0-9a-f]{64}$', 'rotate_club_link still returns only the token');
select tests.clear_auth();
select ok((select code_hash is not null from public.circle_invites where club_id = tests.kid()), 'and its row has a code as well');
select is((select count(*)::int from public.club_staff_actions where club_id = tests.kid() and action = 'link_rotate'), 3,
  'every rotation, by either name, is logged once');
select tests.set_auth(tests.uid('m1'));
select is(public.join_circle(:'code2') ->> 'status', 'invalid', 'rotate_club_link also ends the code before it');

-- Rotations share one daily limit: 3 so far today (coach 1, owner 2), each actor has 5.
select tests.set_auth(tests.uid('owner'));
select lives_ok($$ select public.rotate_club_invite(tests.kid()) $$, 'owner rotation 3 of 5');
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'owner rotation 4 of 5');
select lives_ok($$ select public.rotate_club_invite(tests.kid()) $$, 'owner rotation 5 of 5');
select throws_ok($$ select public.rotate_club_invite(tests.kid()) $$, 'P0001', 'rate_limited', 'a sixth by either name is refused');
select throws_ok($$ select public.rotate_club_link(tests.kid()) $$, 'P0001', 'rate_limited', 'rotate_club_link counts against the same limit');

-- =====================================================================================================
-- 5. Cross-circle: friends invites have no code, and a code never reaches them
-- =====================================================================================================
select tests.set_auth(tests.uid('m1'));
select public.create_circle_invite(tests.fid()) as ftok \gset
select tests.clear_auth();
select ok((select code_hash is null from public.circle_invites where club_id = tests.fid()), 'a friends invite has no code');
select is((select count(*)::int from public.circle_invites where code_hash is not null), 1, 'only the club row carries a code');

-- =====================================================================================================
-- 6. Rate limit: wrong codes spend the same 10 attempts an hour, and then even the right code waits
-- =====================================================================================================
select tests.set_auth(tests.uid('coach'));
select public.rotate_club_invite(tests.kid()) ->> 'code' as code_live \gset
select tests.set_auth(tests.uid('m1'));
-- m1 has spent 2 of its 10 attempts above; 20 more wrong ones cross the limit.
select is((select count(*)::int from (select public.join_circle('ZZZZ2345') ->> 'status' s from generate_series(1, 20)) x where s = 'rate_limited') > 0,
  true, 'wrong codes run into the per-account limit');
select is(public.join_circle(:'code_live') ->> 'status', 'rate_limited', 'then the right code is refused too, until the hour passes');

select * from finish();
rollback;
