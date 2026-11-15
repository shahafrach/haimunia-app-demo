-- 202611150002: delete_my_account(). The caller's club data and account are gone at once; another member's
-- rows are untouched; a club owner's ownership passes to the coach; staff audit rows stay; anon cannot call it;
-- authenticated can; the rate limit refuses a fourth call in an hour.
--
--   Friends circle F: m1 (owner), m2, m3
--   Club K:           owner (owner), coach (coach), m3, norec

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

create function tests.kid() returns uuid language sql stable security definer set search_path = '' as
  $$ select c.id from public.clubs c where c.type = 'club' $$;
grant execute on function tests.kid() to authenticated, anon, service_role;
create function tests.fid() returns uuid language sql immutable as $$ select 'f0000000-0000-4000-8000-00000000000f'::uuid $$;
grant execute on function tests.fid() to authenticated, anon, service_role;

insert into public.clubs (id, name, type, created_by) values (tests.fid(), 'Friends F', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values
  (tests.fid(), tests.uid('m1'), 'owner'), (tests.fid(), tests.uid('m2'), 'member'), (tests.fid(), tests.uid('m3'), 'member');
select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'), (tests.kid(), tests.uid('norec'), 'member');
select is(public.owner_set_coach('coach'), 'set', 'setup: the coach');

-- Posts: m3 in K and F, norec in K, m2 in F.
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d5700000-0000-4000-8000-000000000001', tests.uid('m3'), tests.kid(), 'POST_WORKOUT', 'K m3', 'active', now(), current_date),
  ('d5700000-0000-4000-8000-000000000002', tests.uid('m3'), tests.fid(), 'POST_WORKOUT', 'F m3', 'active', now(), current_date),
  ('d5700000-0000-4000-8000-000000000003', tests.uid('norec'), tests.kid(), 'POST_WORKOUT', 'K norec', 'active', now(), current_date),
  ('d5700000-0000-4000-8000-000000000004', tests.uid('m2'), tests.fid(), 'POST_WORKOUT', 'F m2', 'active', now(), current_date);
-- Reactions: m3 on norec's and m2's posts; norec and m2 on each other's posts and on m3's.
insert into public.reactions (post_id, user_id, kind) values
  ('d5700000-0000-4000-8000-000000000003', tests.uid('m3'), 'fire'),
  ('d5700000-0000-4000-8000-000000000004', tests.uid('m3'), 'clap'),
  ('d5700000-0000-4000-8000-000000000001', tests.uid('norec'), 'fire'),
  ('d5700000-0000-4000-8000-000000000003', tests.uid('coach'), 'fist_bump'),
  ('d5700000-0000-4000-8000-000000000004', tests.uid('m1'), 'clap');
insert into public.push_subscriptions (id, user_id, endpoint, keys, app) values
  ('d5710000-0000-4000-8000-000000000001', tests.uid('m3'), 'https://push.example/m3-club', '{"p256dh":"BPk","auth":"aGk"}', 'club'),
  ('d5710000-0000-4000-8000-000000000002', tests.uid('norec'), 'https://push.example/norec-club', '{"p256dh":"BPk","auth":"aGk"}', 'club');
-- notifications has no club_id since 202610250003; circle_id and actor_id come from 202610260001. Leaving a
-- circle deletes notifications there to or from the leaver (circle_members_forget_notifications), so 004 goes
-- with m3; 002 and 003 carry no circle and stay, 002 only loses its text.
insert into public.notifications (id, user_id, type, category, title, body, source_type, source_id, circle_id, actor_id) values
  ('d5720000-0000-4000-8000-000000000001', tests.uid('m3'), 'reaction', 'community', 'm3 own', 'm3 own', 'post', 'd5700000-0000-4000-8000-000000000001', tests.kid(), tests.uid('norec')),
  ('d5720000-0000-4000-8000-000000000002', tests.uid('norec'), 'reaction', 'community', 'about m3', 'K m3', 'post', 'd5700000-0000-4000-8000-000000000001', null, null),
  ('d5720000-0000-4000-8000-000000000003', tests.uid('norec'), 'reaction', 'community', 'about coach', 'other', 'post', 'd5700000-0000-4000-8000-000000000003', null, null),
  ('d5720000-0000-4000-8000-000000000004', tests.uid('norec'), 'reaction', 'community', 'from m3', 'm3 reacted', 'post', 'd5700000-0000-4000-8000-000000000003', tests.kid(), tests.uid('m3'));
insert into public.club_staff_actions (club_id, actor_id, action, target_id) values
  (tests.kid(), tests.uid('owner'), 'link_rotate', null),
  (tests.kid(), tests.uid('coach'), 'member_remove', tests.uid('m3'));

-- Grants.
select ok(not has_function_privilege('anon', 'public.delete_my_account()', 'execute'), 'anon has no execute on delete_my_account');
select ok(has_function_privilege('authenticated', 'public.delete_my_account()', 'execute'), 'authenticated has execute');
select ok((select prosecdef from pg_proc where oid = 'public.delete_my_account()'::regprocedure), 'it is security definer');
select ok((select proconfig from pg_proc where oid = 'public.delete_my_account()'::regprocedure) @> array['search_path=""'],
  'with an empty search_path');
set local role anon;
select throws_ok($$ select public.delete_my_account() $$, '42501', null, 'anon cannot call it');
select tests.clear_auth();
select ok(exists (select 1 from auth.users where id = tests.uid('m3')), 'anon''s attempt deleted nothing');

-- F-016: two-step login. m3 has a verified factor; a password-only (aal1) session is refused by both deletion
-- paths and nothing is deleted. Only the aal2 session below deletes.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('d5730000-0000-4000-8000-000000000001', tests.uid('m3'), 'BOX-LOG', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');
create function tests.set_auth_aal(p_uid uuid, p_aal text) returns void language plpgsql as $fn$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_uid::text, 'role', 'authenticated', 'aud', 'authenticated', 'aal', p_aal)::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_uid::text, true);
  perform pg_catalog.set_config('role', 'authenticated', true);
end $fn$;
select tests.set_auth_aal(tests.uid('m3'), 'aal1');
select throws_ok($$ select public.delete_my_account() $$, 'P0001', 'not authorized',
  'aal1 with a verified factor: delete_my_account is refused');
select throws_ok($$ select public.request_account_deletion() $$, 'P0001', 'not authorized',
  'aal1 with a verified factor: request_account_deletion is refused too (twin)');
select tests.clear_auth();
select ok(exists (select 1 from auth.users where id = tests.uid('m3')), 'aal1: the auth user is still there');
select ok(exists (select 1 from public.profiles where id = tests.uid('m3') and deleted_at is null), 'aal1: the profile is untouched');
select is((select count(*)::int from public.circle_members where user_id = tests.uid('m3')), 2, 'aal1: both memberships stay');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('m3') and deleted_at is null), 2, 'aal1: both posts stay');
select is((select count(*)::int from public.push_subscriptions where user_id = tests.uid('m3')), 1, 'aal1: the push subscription stays');
select is((select count(*)::int from public.account_deletion_requests where user_id = tests.uid('m3')), 0, 'aal1: no deletion request was written');

-- No uid at all: request_account_deletion refuses (it used to run every statement with a null uid).
select tests.clear_auth();
select throws_ok($$ select public.request_account_deletion() $$, 'P0001', 'not authorized',
  'request_account_deletion with no auth.uid() is refused');

-- m3 deletes their account, with the aal2 session.
select tests.set_auth_aal(tests.uid('m3'), 'aal2');
select lives_ok($$ select public.delete_my_account() $$, 'm3 deletes their own account');
select tests.clear_auth();

select is((select count(*)::int from auth.users where id = tests.uid('m3')), 0, 'the auth user is gone');
select is((select count(*)::int from public.profiles where id = tests.uid('m3')), 0, 'the profile is gone');
select is((select count(*)::int from public.circle_members where user_id = tests.uid('m3')), 0, 'every membership is gone');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('m3')), 0,
  'every post is gone: a real delete, not a soft one');
select is((select count(*)::int from public.reactions where user_id = tests.uid('m3')), 0, 'every reaction m3 gave is gone');
select is((select count(*)::int from public.push_subscriptions where user_id = tests.uid('m3')), 0, 'the push subscription is gone');
select is((select count(*)::int from public.notifications where user_id = tests.uid('m3')), 0, 'm3''s notifications are gone');

-- Everyone else's rows.
select is((select count(*)::int from public.workout_posts where id in
  ('d5700000-0000-4000-8000-000000000003', 'd5700000-0000-4000-8000-000000000004') and status = 'active' and deleted_at is null), 2,
  'the other members'' posts are untouched');
select is((select count(*)::int from public.reactions where user_id in (tests.uid('coach'), tests.uid('m1'))), 2,
  'reactions other members gave on other posts are untouched');
select is((select count(*)::int from public.push_subscriptions where user_id = tests.uid('norec')), 1, 'norec''s push subscription stays');
select is((select count(*)::int from public.notifications where id in
  ('d5720000-0000-4000-8000-000000000002', 'd5720000-0000-4000-8000-000000000003')), 2, 'norec''s notifications outside a circle stay');
select is((select count(*)::int from public.notifications where id = 'd5720000-0000-4000-8000-000000000004'), 0,
  'one from m3 in the club goes with m3''s membership, as on leaving');
select is((select title || body from public.notifications where id = 'd5720000-0000-4000-8000-000000000002'), '',
  'but the one about m3''s post loses its text');
select is((select title from public.notifications where id = 'd5720000-0000-4000-8000-000000000003'), 'about coach',
  'one about another post keeps it');
select is((select count(*)::int from public.circle_members where club_id = tests.fid()), 2, 'the friends circle keeps m1 and m2');
select is((select count(*)::int from public.circle_members where club_id = tests.kid()), 3, 'the club keeps owner, coach and norec');
select ok(exists (select 1 from public.profiles where id = tests.uid('norec')), 'norec''s profile stays');
select is((select count(*)::int from public.club_staff_actions where club_id = tests.kid()), 2,
  'staff audit rows stay, the one naming m3 as target included (ids only)');

-- The club owner deletes their account: the coach becomes the owner.
select tests.set_auth(tests.uid('owner'));
select lives_ok($$ select public.delete_my_account() $$, 'the club owner deletes their account');
select tests.clear_auth();
select is((select role from public.circle_members where club_id = tests.kid() and user_id = tests.uid('coach')), 'owner',
  'ownership passes to the coach');
select ok(exists (select 1 from public.clubs where id = tests.kid()), 'the club is not deleted');
select is((select count(*)::int from public.club_staff_actions where actor_id = tests.uid('owner')), 1, 'the owner''s audit row stays');

-- The rate limit: 3 calls an hour.
insert into public.rate_limits (user_id, action, window_started_at, attempt_count)
values (tests.uid('norec'), 'delete_my_account', now(), 3);
select tests.set_auth(tests.uid('norec'));
select throws_ok($$ select public.delete_my_account() $$, 'P0001', 'rate_limited', 'a fourth call in the hour is refused');
select tests.clear_auth();
select ok(exists (select 1 from auth.users where id = tests.uid('norec')), 'and deletes nothing');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('norec')), 1, 'norec''s post stays');

select * from finish();
rollback;
