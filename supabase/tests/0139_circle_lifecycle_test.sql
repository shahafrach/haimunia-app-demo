-- Circles RPCs, part 1 (202610250004): creating, changing, leaving and removing
-- circles; invites; joining; member settings; the sign-up path.
--
-- Two circles stand in for "mine" and "theirs":
--   A = m1 (owner), m2          B = m3 (owner), bm, coach
-- and for each function the same question is asked of m1: can a member of A act
-- on B? The answer must be a refusal, and B must be unchanged afterwards.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

-- A scratchpad that the impersonated roles may write: tokens handed back once.
create temp table tok (k text primary key, v text);
grant all on tok to authenticated;

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

-- Fixed circles. bm is a fixture user outside the usual cast.
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'bm@members.haimuniya.invalid', now(), now());
insert into public.profiles (id, handle, display_name) values ('bbbbbbbb-0000-4000-8000-0000000000b1', 'member_bm', 'BM');

insert into public.clubs (id, name, type, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1')),
  ('b0000000-0000-4000-8000-00000000000b', 'Circle B', 'friends', tests.uid('m3'));
insert into public.circle_members (club_id, user_id, role, joined_at) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner',  now() - interval '30 days'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member', now() - interval '20 days'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('m3'), 'owner',  now() - interval '30 days'),
  ('b0000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'member', now() - interval '20 days'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('coach'), 'member', now() - interval '10 days');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('b1000000-0000-4000-8000-000000000001', tests.uid('m3'), 'b0000000-0000-4000-8000-00000000000b', 'POST_WORKOUT', 'B workout', 'active', now());

-- =====================================================================
-- 1. create_circle
-- =====================================================================
-- a stranger: signed in, no profile, no redemption
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', null, true, now(), now());

select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e1');
select throws_ok($$ select public.create_circle('friends', 'Nope', null) $$, 'P0001', 'not authorized',
  'a signed-in stranger (no profile, no invite) cannot create a circle: no public sign-up');

select tests.set_auth(tests.uid('m1'));
insert into tok select 'c_friends', public.create_circle('friends', '  Runners  ', E'\U0001F3C3')::text;
insert into tok select 'c_couple', public.create_circle('couple', 'Us', null)::text;
select tests.clear_auth();

select is((select name || '|' || type || '|' || emoji from public.clubs where id = (select v::uuid from tok where k = 'c_friends')),
  'Runners|friends|' || E'\U0001F3C3', 'create_circle trims the name and stores type and emoji');
select is((select created_by from public.clubs where id = (select v::uuid from tok where k = 'c_friends')), tests.uid('m1'), 'and records the creator');
select is((select role from public.circle_members where club_id = (select v::uuid from tok where k = 'c_friends') and user_id = tests.uid('m1')),
  'owner', 'the creator is the owner');
select is((select share_defaults ->> 'share_workouts' from public.circle_members where club_id = (select v::uuid from tok where k = 'c_friends') and user_id = tests.uid('m1')),
  'false', 'friends share workouts only as a weekly count by default');
select is((select share_defaults ->> 'share_workouts' from public.circle_members where club_id = (select v::uuid from tok where k = 'c_couple') and user_id = tests.uid('m1')),
  'true', 'a couple shares workouts by default');
select is((select share_defaults ->> 'show_weights' from public.circle_members where club_id = (select v::uuid from tok where k = 'c_couple') and user_id = tests.uid('m1')),
  'false', 'and absolute weights are hidden in both');

select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.create_circle('gym', 'x', null) $$, 'P0001', 'unknown circle type', 'an unknown type is refused');
select throws_ok($$ select public.create_circle('friends', '   ', null) $$, 'P0001', 'a circle needs a name', 'a blank name is refused');
select throws_ok($$ select public.create_circle('friends', repeat('x', 41), null) $$, 'P0001', 'circle name is too long', 'and so is a name over 40 characters');

-- 10 circles per person: m1 is in A, c_friends, c_couple = 3; seven more fill it.
select lives_ok($$ select public.create_circle('friends', 'F' || g, null) from generate_series(1, 7) g $$, 'm1 can fill ten circles');
select throws_ok($$ select public.create_circle('friends', 'Eleven', null) $$, 'P0001', 'too_many_circles', 'the eleventh is refused (10 circles per person)');
select tests.clear_auth();
select is((select count(*)::int from public.clubs where name = 'Eleven'), 0, 'and no circle row was left behind');

-- =====================================================================
-- 2. update_circle: owner only, one circle only
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a',
  '{"name":"Alpha","emoji":"x","mode":"weekly_competition","invite_policy":"any_member","welcome_line":"hi","benchmark_enabled":true,"benchmark":"fran"}') $$,
  'the owner changes every setting');
select tests.clear_auth();
select is((select name || '|' || mode || '|' || invite_policy || '|' || welcome_line || '|' || benchmark_enabled::text || '|' || benchmark
             from public.clubs where id = 'a0000000-0000-4000-8000-00000000000a'),
  'Alpha|weekly_competition|any_member|hi|true|fran', 'and they stick');
select is((select benchmark_month from public.clubs where id = 'a0000000-0000-4000-8000-00000000000a'),
  date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, 'picking a benchmark stamps the current month (Asia/Jerusalem)');

select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a', '{"benchmark":"clean"}') $$, 'P0001', 'unknown benchmark', 'only the eight named benchmarks can be picked');
select throws_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a', '{"colour":"red"}') $$, 'P0001', 'unknown setting colour', 'an unknown setting is refused');
select throws_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a', '{"mode":"ranked"}') $$, 'P0001', 'unknown mode', 'and an unknown mode');
select throws_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a', '{}') $$, 'P0001', 'settings are required', 'and an empty change');
select lives_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a', '{"benchmark":null}') $$, 'null clears the benchmark');
select tests.clear_auth();
select is((select benchmark_month from public.clubs where id = 'a0000000-0000-4000-8000-00000000000a'), null, 'and its month');

select tests.set_auth(tests.uid('m2'));
select throws_ok($$ select public.update_circle('a0000000-0000-4000-8000-00000000000a', '{"name":"mine now"}') $$, 'P0001', 'not authorized', 'a member who is not the owner cannot change settings');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.update_circle('b0000000-0000-4000-8000-00000000000b', '{"name":"hijacked"}') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: the owner of A cannot change B');
select tests.clear_auth();
select is((select name from public.clubs where id = 'b0000000-0000-4000-8000-00000000000b'), 'Circle B', 'and B is unchanged');

-- =====================================================================
-- 3. Invites
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
insert into tok select 'a_inv', public.create_circle_invite('a0000000-0000-4000-8000-00000000000a');
select tests.clear_auth();
select matches((select v from tok where k = 'a_inv'), '^[0-9a-f]{64}$', 'create_circle_invite returns a 32-byte token as 64 hex characters');
select is((select count(*)::int from public.circle_invites where club_id = 'a0000000-0000-4000-8000-00000000000a'), 1, 'one invite row');
select is((select token_hash from public.circle_invites where club_id = 'a0000000-0000-4000-8000-00000000000a'),
  encode(extensions.digest((select v from tok where k = 'a_inv'), 'sha256'), 'hex'), 'only the sha256 of the token is stored');
select is((select count(*)::int from public.circle_invites where token_hash = (select v from tok where k = 'a_inv')), 0, 'the raw token is not stored anywhere in the row');
select ok((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
             from public.circle_invites where club_id = 'a0000000-0000-4000-8000-00000000000a'), 'it expires in 7 days');
select is((select max_uses from public.circle_invites where club_id = 'a0000000-0000-4000-8000-00000000000a'), 5, 'friends invites default to 5 uses');

select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.create_circle_invite('a0000000-0000-4000-8000-00000000000a', 21) $$, 'P0001', 'uses must be between 1 and 20', 'the use limit is capped at 20');
-- invite_policy: A was set to any_member above, so m2 may invite; B is 'owner'.
select tests.set_auth(tests.uid('m2'));
select lives_ok($$ select public.create_circle_invite('a0000000-0000-4000-8000-00000000000a', 1) $$, 'invite_policy any_member: a plain member may invite');
select tests.set_auth('bbbbbbbb-0000-4000-8000-0000000000b1');
select throws_ok($$ select public.create_circle_invite('b0000000-0000-4000-8000-00000000000b') $$, 'P0001', 'not authorized', 'invite_policy owner: a plain member may not');
select tests.set_auth(tests.uid('m3'));
select lives_ok($$ select public.create_circle_invite('b0000000-0000-4000-8000-00000000000b') $$, 'but the owner may');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.create_circle_invite('b0000000-0000-4000-8000-00000000000b') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot mint an invite to B');

-- 20 per circle per day
select tests.clear_auth();
insert into public.circle_invites (club_id, token_hash, created_by, expires_at)
select 'a0000000-0000-4000-8000-00000000000a', encode(extensions.digest('filler' || g, 'sha256'), 'hex'), tests.uid('m1'), now() + interval '7 days'
  from generate_series(1, 17) g;   -- 2 real ones above + 17 = 19
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.create_circle_invite('a0000000-0000-4000-8000-00000000000a') $$, 'the 20th invite of the day is allowed');
select throws_ok($$ select public.create_circle_invite('a0000000-0000-4000-8000-00000000000a') $$, 'P0001', 'invite_limit', 'the 21st is refused');
select tests.set_auth(tests.uid('m3'));
select lives_ok($$ select public.create_circle_invite('b0000000-0000-4000-8000-00000000000b') $$, 'the cap is per circle: B is unaffected');
select tests.clear_auth();
update public.circle_invites set created_at = now() - interval '25 hours' where club_id = 'a0000000-0000-4000-8000-00000000000a';
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.create_circle_invite('a0000000-0000-4000-8000-00000000000a') $$, 'a day later the budget is back');

-- =====================================================================
-- 4. join_circle
-- =====================================================================
-- A brand-new anonymous account: signed in, nothing else.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e2', 'authenticated', 'authenticated', null, true, now(), now());

select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e2');
select is(public.is_community_member(), false, 'a new anonymous account is not a member of anything');
select is((select count(*)::int from public.clubs), 0, 'an anonymous user in no circle sees no circle');
select is((select count(*)::int from public.circle_members), 0, '... no roster');
select is((select count(*)::int from public.workout_posts), 0, '... no post');
select is((select count(*)::int from public.reactions), 0, '... no reaction');
select is((select count(*)::int from public.post_training_partners), 0, '... no tag');
select is((select count(*)::int from public.benchmark_results), 0, '... no benchmark result');
select is((select count(*)::int from public.profiles), 0, '... no profile, not even a stub of their own yet');
select is(has_table_privilege('authenticated', 'public.circle_invites', 'select'), false, '... and the invite table is closed to every client role');
select is((select count(*)::int from public.achievement_definitions), 0, '... and not the achievement catalogue either');

select is(public.join_circle(repeat('f', 64)) ->> 'status', 'invalid', 'an unknown token is just invalid');
select is(public.join_circle('not a token') ->> 'status', 'invalid', 'so is a malformed one');
select tests.clear_auth();
select is((select attempt_count from public.rate_limits where user_id = 'eeeeeeee-0000-4000-8000-0000000000e2' and action = 'join_circle'), 2, 'and each attempt counted, even though neither raised');
select is((select count(*)::int from public.profiles where id = 'eeeeeeee-0000-4000-8000-0000000000e2'), 0, 'a failed join creates no profile');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e2');

select is(public.join_circle((select v from tok where k = 'a_inv')) ->> 'status', 'joined', 'a valid token joins');
select is(public.join_circle((select v from tok where k = 'a_inv')) ->> 'status', 'already_member', 'a second use by the same person is already_member');
select tests.clear_auth();
select is((select club_id from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e2'), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'they joined exactly the circle the token names');
select is((select count(*)::int from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e2'), 1, 'and only that one');
select is((select uses from public.circle_invites where token_hash = encode(extensions.digest((select v from tok where k = 'a_inv'), 'sha256'), 'hex')), 1, 'the invite was spent once: already_member did not spend it');
select is((select count(*)::int from public.profiles where id = 'eeeeeeee-0000-4000-8000-0000000000e2'), 1, 'joining created the bare profile an anonymous account lacked');
select is((select share_defaults ->> 'share_prs' from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e2'), 'true', 'and the circle type''s sharing defaults');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e2');
select is(public.is_community_member(), true, 'is_community_member() now means: in at least one circle');
select is((select count(*)::int from public.circle_members where club_id = 'a0000000-0000-4000-8000-00000000000a'), 3, 'they see their new circle''s roster');
select is((select count(*)::int from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'and nothing of B');

-- use limit (a 1-use invite) and expiry
select tests.set_auth(tests.uid('m1'));
insert into tok select 'a_one', public.create_circle_invite('a0000000-0000-4000-8000-00000000000a', 1);
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', ('eeeeeeee-0000-4000-8000-0000000000e' || g)::uuid, 'authenticated', 'authenticated', null, true, now(), now()
  from unnest(array['3','4','5']) g;
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e3');
select is(public.join_circle((select v from tok where k = 'a_one')) ->> 'status', 'joined', 'the one use is taken');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e4');
select is(public.join_circle((select v from tok where k = 'a_one')) ->> 'status', 'invalid', 'the next person is told invalid: a used-up invite looks like an unknown one');
select tests.clear_auth();
update public.circle_invites set expires_at = now() - interval '1 second' where token_hash = encode(extensions.digest((select v from tok where k = 'a_inv'), 'sha256'), 'hex');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e4');
select is(public.join_circle((select v from tok where k = 'a_inv')) ->> 'status', 'invalid', 'an expired invite is invalid');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e4'), 0, 'and joined nothing');

-- circle limits are enforced through join_circle and do not spend the invite
select tests.set_auth(tests.uid('m1'));
insert into tok select 'couple_inv', public.create_circle_invite((select v::uuid from tok where k = 'c_couple'));
select tests.clear_auth();
select is((select max_uses from public.circle_invites where club_id = (select v::uuid from tok where k = 'c_couple')), 1, 'a couple invite defaults to 1 use');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e4');
select is(public.join_circle((select v from tok where k = 'couple_inv')) ->> 'status', 'joined', 'the partner joins the couple');
select tests.clear_auth();
select is((select role from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e4' and club_id = (select v::uuid from tok where k = 'c_couple')), 'owner', 'and both members of a couple are owners');
-- the couple is now full: an invite cannot be minted, and a stale one cannot be used
insert into public.circle_invites (club_id, token_hash, created_by, expires_at)
values ((select v::uuid from tok where k = 'c_couple'), encode(extensions.digest('stale', 'sha256'), 'hex'), tests.uid('m1'), now() + interval '1 day');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.create_circle_invite((select v::uuid from tok where k = 'c_couple')) $$, 'P0001', 'circle_full', 'a full circle mints no invite');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e5');
select is(public.join_circle(encode(extensions.digest('stale', 'sha256'), 'hex')) ->> 'status', 'invalid', 'a token that only matches by its hash is not a token (the hash is not the secret)');
select tests.clear_auth();
-- a stale invite whose raw value we know
insert into public.circle_invites (club_id, token_hash, created_by, expires_at)
values ((select v::uuid from tok where k = 'c_couple'), encode(extensions.digest(repeat('a', 64), 'sha256'), 'hex'), tests.uid('m1'), now() + interval '1 day');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e5');
select is(public.join_circle(repeat('a', 64)) ->> 'status', 'circle_full', 'a third person cannot join a full couple');
select tests.clear_auth();
select is((select uses from public.circle_invites where token_hash = encode(extensions.digest(repeat('a', 64), 'sha256'), 'hex')), 0, 'and the invite was not spent');
select is((select count(*)::int from public.profiles where id = 'eeeeeeee-0000-4000-8000-0000000000e5'), 0, 'nor a profile created');

-- 10 circles per person through join_circle
insert into public.circle_invites (club_id, token_hash, created_by, expires_at)
values ('b0000000-0000-4000-8000-00000000000b', encode(extensions.digest(repeat('b', 64), 'sha256'), 'hex'), tests.uid('m3'), now() + interval '1 day');
update public.circle_invites set max_uses = 5 where token_hash = encode(extensions.digest(repeat('b', 64), 'sha256'), 'hex');
select tests.set_auth(tests.uid('m1'));
select is(public.join_circle(repeat('b', 64)) ->> 'status', 'too_many_circles', 'a person already in 10 circles cannot join an 11th');

-- A member of A holding B's token joins B and ONLY B.
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is(public.join_circle(repeat('b', 64)) ->> 'status', 'joined', 'a member of A can join B with B''s token');
select tests.clear_auth();
select is((select array_agg(club_id order by club_id) from public.circle_members where user_id = tests.uid('m2')),
  array['a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b']::uuid[], 'and is then in exactly those two circles');
delete from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b' and user_id = tests.uid('m2');

-- rate limit: 10 attempts per user per hour, valid or not
select tests.set_auth(tests.uid('norec'));
select is((select count(*)::int from generate_series(1, 10) g where public.join_circle(repeat('0', 64)) ->> 'status' = 'invalid'), 10, 'ten attempts in the hour are answered');
select is(public.join_circle(repeat('0', 64)) ->> 'status', 'rate_limited', 'the eleventh is rate_limited');
select is(public.join_circle(repeat('b', 64)) ->> 'status', 'rate_limited', 'even with a valid token');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where user_id = tests.uid('norec')), 0, 'and nothing was joined');
select is((select attempt_count from public.rate_limits where user_id = tests.uid('norec') and action = 'join_circle'), 12, 'every attempt was counted in rate_limits, refused ones included');
update public.rate_limits set window_started_at = now() - interval '61 minutes' where user_id = tests.uid('norec') and action = 'join_circle';
select tests.set_auth(tests.uid('norec'));
select is(public.join_circle(repeat('b', 64)) ->> 'status', 'joined', 'an hour later the budget is back and the token works');
select tests.clear_auth();
delete from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b' and user_id = tests.uid('norec');

-- bootstrap: redeem_invite_code grants no circle access by itself
insert into public.invite_codes (code_hash, role, active, max_uses)
values (encode(extensions.digest(repeat('c', 40), 'sha256'), 'hex'), 'member', true, 5);
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e6', 'authenticated', 'authenticated', null, true, now(), now());
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e6');
select is(public.redeem_invite_code(repeat('c', 40), 'actor-1'), 'member', 'the bootstrap code is redeemed');
select is(public.is_community_member(), false, 'redeeming grants no membership of any circle');
select is((select count(*)::int from public.clubs), 0, 'and no circle is visible');
select is((select count(*)::int from public.workout_posts) + (select count(*)::int from public.circle_members), 0, 'nor a post nor a roster');
select tests.clear_auth();
insert into public.profiles (id, handle, display_name) values ('eeeeeeee-0000-4000-8000-0000000000e6', 'boot_owner', 'Boot');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e6');
select lives_ok($$ select public.create_circle('friends', 'First', null) $$, 'with a profile, the redeemed account can create the first circle');
select is(public.is_community_member(), true, 'and is then a member of it');

-- =====================================================================
-- 5. set_share_defaults, set_weekly_target, set_pause
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok($$ select public.set_share_defaults('a0000000-0000-4000-8000-00000000000a', '{"show_weights":true,"share_workouts":true}') $$, 'a member sets their sharing for a circle');
select lives_ok($$ select public.set_share_defaults('a0000000-0000-4000-8000-00000000000a', '{"share_prs":false}') $$, 'and changes one key later');
select tests.clear_auth();
select is((select share_defaults ->> 'show_weights' from public.circle_members where club_id = 'a0000000-0000-4000-8000-00000000000a' and user_id = tests.uid('m2')), 'true', 'it is stored');
select is((select share_defaults ->> 'share_prs' || '/' || (share_defaults ->> 'show_weights') from public.circle_members where club_id = 'a0000000-0000-4000-8000-00000000000a' and user_id = tests.uid('m2')), 'false/true', 'the second call merged over the first instead of replacing it');
select is((select share_defaults from public.circle_members where club_id = 'a0000000-0000-4000-8000-00000000000a' and user_id = tests.uid('m1')), '{}'::jsonb, 'another member''s defaults are untouched');
select tests.set_auth(tests.uid('m2'));
select throws_ok($$ select public.set_share_defaults('a0000000-0000-4000-8000-00000000000a', '{"bio":true}') $$, 'P0001', 'unknown setting bio', 'an unknown key is refused');
select throws_ok($$ select public.set_share_defaults('a0000000-0000-4000-8000-00000000000a', '{"show_weights":"yes"}') $$, 'P0001', 'show_weights must be true or false', 'and a non-boolean');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.set_share_defaults('b0000000-0000-4000-8000-00000000000b', '{"show_weights":true}') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot set sharing for B');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b' and share_defaults ->> 'show_weights' = 'true'), 0, 'and B''s rows are unchanged');

select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.set_weekly_target(4) $$, 'a weekly target is set');
select throws_ok($$ select public.set_weekly_target(0) $$, 'P0001', 'target must be between 1 and 21', 'zero is refused');
select throws_ok($$ select public.set_weekly_target(22) $$, 'P0001', 'target must be between 1 and 21', 'and 22');
select lives_ok($$ select public.set_pause(current_date + 7) $$, 'a pause is set');
select throws_ok($$ select public.set_pause(current_date - 3) $$, 'P0001', 'pause must end within the next 180 days', 'a pause in the past is refused');
select tests.clear_auth();
select is((select weekly_target::int from public.member_targets where user_id = tests.uid('m1')), 4, 'the target is stored');
select is((select paused_until is not null from public.member_targets where user_id = tests.uid('m1')), true, 'and the pause');
select is((select count(*)::int from public.member_targets where user_id <> tests.uid('m1')), 0, 'neither call wrote anyone else''s row');
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.set_pause(null) $$, 'a pause is cleared with null');
select tests.set_auth('eeeeeeee-0000-4000-8000-0000000000e5');
select throws_ok($$ select public.set_weekly_target(3) $$, 'P0001', 'not authorized', 'a user in no circle has no target to set');

-- =====================================================================
-- 6. leave_circle and remove_member
-- =====================================================================
-- Circle L: owner o, then x, then y by joined_at. x has posts, reactions and a
-- tag there, and also posts in circle M (which must survive leaving L).
select tests.clear_auth();
insert into public.clubs (id, name, type, created_by) values
  ('c1000000-0000-4000-8000-0000000000c1', 'L', 'friends', tests.uid('owner')),
  ('c2000000-0000-4000-8000-0000000000c2', 'M', 'friends', tests.uid('owner'));
insert into public.circle_members (club_id, user_id, role, joined_at) values
  ('c1000000-0000-4000-8000-0000000000c1', tests.uid('owner'),    'owner',  now() - interval '30 days'),
  ('c1000000-0000-4000-8000-0000000000c1', tests.uid('admin'), 'member', now() - interval '20 days'),
  ('c1000000-0000-4000-8000-0000000000c1', tests.uid('coach'), 'member', now() - interval '10 days'),
  ('c2000000-0000-4000-8000-0000000000c2', tests.uid('owner'),    'owner',  now() - interval '30 days'),
  ('c2000000-0000-4000-8000-0000000000c2', tests.uid('admin'), 'member', now() - interval '20 days');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('c1100000-0000-4000-8000-000000000001', tests.uid('admin'), 'c1000000-0000-4000-8000-0000000000c1', 'POST_WORKOUT', 'admin in L', 'active', now()),
  ('c1100000-0000-4000-8000-000000000002', tests.uid('admin'), 'c2000000-0000-4000-8000-0000000000c2', 'POST_WORKOUT', 'admin in M', 'active', now()),
  ('c1100000-0000-4000-8000-000000000003', tests.uid('owner'),    'c1000000-0000-4000-8000-0000000000c1', 'POST_WORKOUT', 'owner in L', 'active', now());
insert into public.reactions (post_id, user_id) values
  ('c1100000-0000-4000-8000-000000000003', tests.uid('admin')),
  ('c1100000-0000-4000-8000-000000000001', tests.uid('owner'));
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by) values
  ('c1100000-0000-4000-8000-000000000003', tests.uid('admin'), tests.uid('owner'));
insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
select 'c1000000-0000-4000-8000-0000000000c1', tests.uid('admin'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '5:00', 'rx';

select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select public.leave_circle('b0000000-0000-4000-8000-00000000000b') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: leaving a circle you are not in is refused');
select throws_ok(format($$ select public.remove_member('b0000000-0000-4000-8000-00000000000b', %L) $$, tests.uid('coach')), 'P0001', 'not authorized',
  'CROSS-CIRCLE: the owner of A cannot remove a member of B');
select throws_ok(format($$ select public.remove_member('c1000000-0000-4000-8000-0000000000c1', %L) $$, tests.uid('owner')), 'P0001', 'use leave_circle', 'removing yourself is leave_circle');
select tests.set_auth(tests.uid('admin'));
select throws_ok(format($$ select public.remove_member('c1000000-0000-4000-8000-0000000000c1', %L) $$, tests.uid('coach')), 'P0001', 'not authorized', 'a plain member cannot remove anyone');
select tests.set_auth(tests.uid('owner'));
select throws_ok(format($$ select public.remove_member('c1000000-0000-4000-8000-0000000000c1', %L) $$, 'dddddddd-0000-4000-8000-0000000000ff'::uuid), 'P0001', 'member not found', 'removing a non-member is refused');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b'), 3, 'B still has its three members');

-- the owner removes admin from L: admin's L content goes, M content stays
select tests.set_auth(tests.uid('owner'));
select lives_ok(format($$ select public.remove_member('c1000000-0000-4000-8000-0000000000c1', %L) $$, tests.uid('admin')), 'the owner removes a member');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where club_id = 'c1000000-0000-4000-8000-0000000000c1' and user_id = tests.uid('admin')), 0, 'they are out of L');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('admin') and club_id = 'c1000000-0000-4000-8000-0000000000c1'), 0, 'their posts in L are deleted');
select is((select count(*)::int from public.reactions where post_id = 'c1100000-0000-4000-8000-000000000003' and user_id = tests.uid('admin')), 0, 'their reactions in L are deleted');
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('admin')), 0, 'the tags naming them in L are deleted');
select is((select count(*)::int from public.benchmark_results where user_id = tests.uid('admin') and club_id = 'c1000000-0000-4000-8000-0000000000c1'), 0, 'and their benchmark results in L');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('admin') and club_id = 'c2000000-0000-4000-8000-0000000000c2'), 1, 'their post in the OTHER circle M survives');
select is((select count(*)::int from public.reactions where user_id = tests.uid('owner')), 0, 'reactions by others on the removed member''s post went with the post');
select is((select count(*)::int from public.workout_posts where club_id = 'c1000000-0000-4000-8000-0000000000c1' and author_id = tests.uid('owner')), 1, 'the owner''s own post stays');

-- owners cannot be removed; an owner who leaves passes ownership on
select tests.clear_auth();
update public.circle_members set role = 'owner' where club_id = 'c1000000-0000-4000-8000-0000000000c1' and user_id = tests.uid('coach');
select tests.set_auth(tests.uid('owner'));
select throws_ok(format($$ select public.remove_member('c1000000-0000-4000-8000-0000000000c1', %L) $$, tests.uid('coach')), 'P0001', 'an owner cannot be removed', 'an owner cannot be removed by remove_member');
select tests.clear_auth();
update public.circle_members set role = 'member' where club_id = 'c1000000-0000-4000-8000-0000000000c1' and user_id = tests.uid('coach');

-- L: m1 (owner, joined 30d ago) and coach. Add y (joined 15 days ago) so the
-- longest-standing remaining member is coach, not y.
insert into public.circle_members (club_id, user_id, role, joined_at)
values ('c1000000-0000-4000-8000-0000000000c1', tests.uid('m3'), 'member', now() - interval '15 days');
select tests.set_auth(tests.uid('owner'));
select lives_ok($$ select public.leave_circle('c1000000-0000-4000-8000-0000000000c1') $$, 'the owner leaves');
select tests.clear_auth();
select is((select role from public.circle_members where club_id = 'c1000000-0000-4000-8000-0000000000c1' and user_id = tests.uid('m3')), 'owner', 'ownership passes to the longest-standing member (joined 15 days ago, not the one who joined 10 days ago)');
select is((select role from public.circle_members where club_id = 'c1000000-0000-4000-8000-0000000000c1' and user_id = tests.uid('coach')), 'member', 'and to no one else');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('owner') and club_id = 'c1000000-0000-4000-8000-0000000000c1'), 0, 'the leaver''s posts in L are deleted');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('owner') and club_id = 'c2000000-0000-4000-8000-0000000000c2'), 0, 'fixture check: the owner has no post in M to lose');

-- an owner removed by account deletion hands over the same way
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'dddddddd-0000-4000-8000-0000000000d1', 'authenticated', 'authenticated', 'd1@members.haimuniya.invalid', now(), now());
insert into public.profiles (id, handle, display_name) values ('dddddddd-0000-4000-8000-0000000000d1', 'member_d1', 'D1');
insert into public.clubs (id, name, type, created_by) values ('c3000000-0000-4000-8000-0000000000c3', 'E', 'friends', 'dddddddd-0000-4000-8000-0000000000d1');
insert into public.circle_members (club_id, user_id, role, joined_at) values
  ('c3000000-0000-4000-8000-0000000000c3', 'dddddddd-0000-4000-8000-0000000000d1', 'owner', now() - interval '9 days'),
  ('c3000000-0000-4000-8000-0000000000c3', tests.uid('m2'), 'member', now() - interval '5 days');
delete from auth.users where id = 'dddddddd-0000-4000-8000-0000000000d1';
select is((select created_by from public.clubs where id = 'c3000000-0000-4000-8000-0000000000c3'), null, 'deleting the creator''s account is not blocked by the immutable-creator guard; the creator is just cleared');
select is((select role from public.circle_members where club_id = 'c3000000-0000-4000-8000-0000000000c3' and user_id = tests.uid('m2')), 'owner', 'account deletion of the owner passes ownership on too');

-- the last member leaving deletes the circle and everything in it
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at)
values ('c3100000-0000-4000-8000-000000000001', tests.uid('m2'), 'c3000000-0000-4000-8000-0000000000c3', 'POST_WORKOUT', 'last', 'active', now());
insert into public.circle_invites (club_id, token_hash, created_by, expires_at)
values ('c3000000-0000-4000-8000-0000000000c3', encode(extensions.digest('e-inv', 'sha256'), 'hex'), tests.uid('m2'), now() + interval '1 day');
select tests.set_auth(tests.uid('m2'));
select lives_ok($$ select public.leave_circle('c3000000-0000-4000-8000-0000000000c3') $$, 'the last member leaves');
select tests.clear_auth();
select is((select count(*)::int from public.clubs where id = 'c3000000-0000-4000-8000-0000000000c3'), 0, 'the circle is deleted');
select is((select count(*)::int from public.workout_posts where club_id = 'c3000000-0000-4000-8000-0000000000c3'), 0, 'with its posts');
select is((select count(*)::int from public.circle_invites where club_id = 'c3000000-0000-4000-8000-0000000000c3'), 0, 'and its invites');

-- a couple: both are owners, one leaving leaves the other an owner
select is((select count(*)::int from public.circle_members where club_id = (select v::uuid from tok where k = 'c_couple')), 2, 'fixture: the couple has two members');
select tests.set_auth(tests.uid('m1'));
select lives_ok(format($$ select public.leave_circle(%L) $$, (select v from tok where k = 'c_couple')), 'one partner leaves');
select tests.clear_auth();
select is((select role from public.circle_members where club_id = (select v::uuid from tok where k = 'c_couple')), 'owner', 'the other is still an owner');
select is((select count(*)::int from public.clubs where id = (select v::uuid from tok where k = 'c_couple')), 1, 'and the circle stays');

-- B was never touched by any of this
select is((select count(*)::int from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b'), 3, 'circle B has its three members');
select is((select count(*)::int from public.workout_posts where club_id = 'b0000000-0000-4000-8000-00000000000b'), 1, 'and its post');
select is((select name from public.clubs where id = 'b0000000-0000-4000-8000-00000000000b'), 'Circle B', 'and its name');

-- =====================================================================
-- 7. purge_abandoned_profiles skips anyone in a circle
-- =====================================================================
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', null, true, now() - interval '60 days', now() - interval '60 days'),
       ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', null, true, now() - interval '60 days', now() - interval '60 days');
insert into public.profiles (id, handle, display_name) values
  ('eeeeeeee-0000-4000-8000-0000000000f1', 'old_member', 'Old member'),
  ('eeeeeeee-0000-4000-8000-0000000000f2', 'old_drifter', 'Old drifter');
insert into public.circle_members (club_id, user_id) values ('b0000000-0000-4000-8000-00000000000b', 'eeeeeeee-0000-4000-8000-0000000000f1');
select lives_ok($$ select public.purge_abandoned_profiles(30) $$, 'the purge runs');
select is((select count(*)::int from auth.users where id = 'eeeeeeee-0000-4000-8000-0000000000f1'), 1, 'an old anonymous account that is in a circle is NOT purged');
select is((select count(*)::int from public.circle_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000f1'), 1, 'and keeps its membership');
select is((select count(*)::int from auth.users where id = 'eeeeeeee-0000-4000-8000-0000000000f2'), 0, 'while an equally old anonymous account in no circle still is');

select * from finish();
rollback;
