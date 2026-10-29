-- Founder link (202610290002). A member sends a friend a "start your own
-- circle" link. What is pinned here: one use, seven days, three a day, nothing
-- for anon or an anonymous session, and the token grants the right to create
-- circles and nothing else: the redeemer is in no circle and reads nothing of
-- the sender's, and the sender reads nothing of the redeemer's circle.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create temp table tok (k text primary key, v text);
grant all on tok to authenticated;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'ffffffff-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', null, true, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ffffffff-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', null, true, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ffffffff-0000-4000-8000-0000000000f3', 'authenticated', 'authenticated', null, true, now(), now());

-- The sender's circle, with something in it to read.
insert into public.clubs (id, name, type, created_by) values
  ('f0000000-0000-4000-8000-0000000000a1', 'Sender circle', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values
  ('f0000000-0000-4000-8000-0000000000a1', tests.uid('m1'), 'owner');

-- ---------------------------------------------------------------------
-- 1. Who can call it
-- ---------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.create_founder_invite()', 'execute'), 'anon cannot execute create_founder_invite');
select ok(not has_function_privilege('public', 'public.create_founder_invite()', 'execute'), 'PUBLIC cannot either');
select ok(has_function_privilege('authenticated', 'public.create_founder_invite()', 'execute'), 'authenticated can');

-- an anonymous sign-in (mid sign-up) is still "authenticated" to Postgres
select set_config('request.jwt.claims', '{"sub":"ffffffff-0000-4000-8000-0000000000f1","role":"authenticated","is_anonymous":true}', true);
select set_config('role', 'authenticated', true);
select throws_ok($$ select public.create_founder_invite() $$, 'P0001', 'not authorized', 'an anonymous session cannot mint one');
select tests.clear_auth();

select tests.set_auth('ffffffff-0000-4000-8000-0000000000f3');
select throws_ok($$ select public.create_founder_invite() $$, 'P0001', 'not authorized', 'someone with no profile cannot mint one');
select tests.clear_auth();

-- ---------------------------------------------------------------------
-- 2. What it mints
-- ---------------------------------------------------------------------
select tests.set_auth(tests.uid('m1'));
insert into tok select 'url', public.create_founder_invite();
select tests.clear_auth();
insert into tok select 'token', substr(v, position('#invite=' in v) + 8) from tok where k = 'url';

select matches((select v from tok where k = 'url'), '^https://box-log\.pages\.dev/#invite=[0-9a-f]{64}$',
  'a member gets the full URL with a 32-byte hex token after the #');
select is((select count(*)::int from public.invite_codes where code_hash = (select v from tok where k = 'token')), 0, 'the token itself is not stored');
select is((select count(*)::int from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 1, 'only its sha256 is stored');
select ok((select expires_at > now() + interval '6 days 23 hours' and expires_at <= now() + interval '7 days' from public.invite_codes
            where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 'it expires in seven days');
select is((select max_uses from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 1, 'it allows one use');
select is((select role from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 'member', 'it is an ordinary member code');

-- ---------------------------------------------------------------------
-- 3. One use
-- ---------------------------------------------------------------------
select tests.set_auth('ffffffff-0000-4000-8000-0000000000f1');
select is(public.redeem_invite_code((select v from tok where k = 'token'), 'founder-actor-1'), 'member', 'the friend redeems it through redeem_invite_code');
select tests.set_auth('ffffffff-0000-4000-8000-0000000000f2');
select is(public.redeem_invite_code((select v from tok where k = 'token'), 'founder-actor-2'), 'invalid', 'a second person with the same link is refused');
select tests.clear_auth();
select is((select use_count from public.invite_codes where code_hash = encode(digest((select v from tok where k = 'token'), 'sha256'), 'hex')), 1, 'and the use is counted once');
select is((select count(*)::int from public.invite_redemptions where user_id = 'ffffffff-0000-4000-8000-0000000000f2'), 0, 'the second person has no redemption');

-- ---------------------------------------------------------------------
-- 4. Seven days, not eight
-- ---------------------------------------------------------------------
select tests.set_auth(tests.uid('m2'));
insert into tok select 'url2', public.create_founder_invite();
select tests.clear_auth();
insert into tok select 'token2', substr(v, position('#invite=' in v) + 8) from tok where k = 'url2';
update public.invite_codes set expires_at = now() - interval '1 second'
 where code_hash = encode(digest((select v from tok where k = 'token2'), 'sha256'), 'hex');
select tests.set_auth('ffffffff-0000-4000-8000-0000000000f2');
select is(public.redeem_invite_code((select v from tok where k = 'token2'), 'founder-actor-3'), 'invalid', 'an expired link is refused');
select tests.clear_auth();
select is((select count(*)::int from public.invite_redemptions where user_id = 'ffffffff-0000-4000-8000-0000000000f2'), 0, 'and leaves no redemption');

-- ---------------------------------------------------------------------
-- 5. The token grants the right to create a circle, nothing else
-- ---------------------------------------------------------------------
select is((select count(*)::int from public.circle_members where user_id = 'ffffffff-0000-4000-8000-0000000000f1'), 0, 'the redeemer is in no circle');
insert into public.profiles (id, handle, display_name) values ('ffffffff-0000-4000-8000-0000000000f1', 'founder_friend', 'Friend');

select tests.set_auth('ffffffff-0000-4000-8000-0000000000f1');
select ok(not public.is_community_member(), 'the redeemer is not a community member');
select is((select count(*)::int from public.clubs), 0, 'the redeemer sees no circle');
select is((select count(*)::int from public.clubs where id = 'f0000000-0000-4000-8000-0000000000a1'), 0, 'least of all the sender''s');
select is((select count(*)::int from public.circle_members), 0, 'reads no roster');
select is((select count(*)::int from public.workout_posts), 0, 'reads no posts');
select is((select count(*)::int from public.profiles where id = tests.uid('m1')), 0, 'cannot even read the sender''s profile');
insert into tok select 'club', public.create_circle('friends', 'Friend circle', null)::text;
select is((select role from public.circle_members where club_id = (select v::uuid from tok where k = 'club') and user_id = 'ffffffff-0000-4000-8000-0000000000f1'), 'owner',
  'what the token allowed: a circle of their own, as its owner');
select is((select count(*)::int from public.clubs where id = 'f0000000-0000-4000-8000-0000000000a1'), 0, 'and the sender''s circle is still invisible after it');
select tests.clear_auth();

select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.clubs where id = (select v::uuid from tok where k = 'club')), 0, 'the sender cannot see the friend''s circle');
select is((select count(*)::int from public.circle_members where club_id = (select v::uuid from tok where k = 'club')), 0, 'nor its roster');
select tests.clear_auth();

-- ---------------------------------------------------------------------
-- 6. Three a day
-- ---------------------------------------------------------------------
select tests.set_auth(tests.uid('m3'));
select lives_ok($$ select public.create_founder_invite() $$, 'link 1 of 3');
select lives_ok($$ select public.create_founder_invite() $$, 'link 2 of 3');
select lives_ok($$ select public.create_founder_invite() $$, 'link 3 of 3');
select throws_ok($$ select public.create_founder_invite() $$, 'P0001', 'rate_limited', 'the fourth in a day is refused');
select tests.clear_auth();
select is((select attempt_count from public.rate_limits where user_id = tests.uid('m3') and action = 'founder_invite'), 3, 'three were counted; the refused one rolled back');
-- the cap is per member
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.create_founder_invite() $$, 'another member is not held back by m3''s cap');
select tests.clear_auth();
-- and it is per day
update public.rate_limits set window_started_at = now() - interval '25 hours' where user_id = tests.uid('m3') and action = 'founder_invite';
select tests.set_auth(tests.uid('m3'));
select lives_ok($$ select public.create_founder_invite() $$, 'a day later the member can send another');
select tests.clear_auth();

select * from finish();
rollback;
