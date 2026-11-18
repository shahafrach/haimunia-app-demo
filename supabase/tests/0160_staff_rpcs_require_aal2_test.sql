-- 202611180001 (F-028): every club staff and owner RPC a session can call refuses a password-only (aal1) session
-- of a member with a verified MFA factor, changes nothing, and works at aal2. A staff member without a factor is
-- not affected at aal1.
--
--   Club K:           owner (owner, has a factor), coach (coach, has a factor), m3, norec
--   Friends circle F: m1 (owner, has a factor), m2

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

alter table public.workout_posts alter column club_id drop default;

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

create function tests.kid() returns uuid language sql stable security definer set search_path = '' as
  $$ select c.id from public.clubs c where c.type = 'club' $$;
grant execute on function tests.kid() to authenticated, anon, service_role;
create function tests.fid() returns uuid language sql immutable as $$ select 'f2800000-0000-4000-8000-00000000000f'::uuid $$;
grant execute on function tests.fid() to authenticated, anon, service_role;

insert into public.clubs (id, name, type, created_by) values (tests.fid(), 'Friends F', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values (tests.fid(), tests.uid('m1'), 'owner'), (tests.fid(), tests.uid('m2'), 'member');
select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'), (tests.kid(), tests.uid('norec'), 'member');
select is(public.owner_set_coach('coach'), 'set', 'setup: the coach');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('f2810000-0000-4000-8000-000000000001', tests.uid('m3'), tests.kid(), 'POST_WORKOUT', 'K m3', 'active', now(), current_date),
  ('f2810000-0000-4000-8000-000000000002', tests.uid('coach'), tests.kid(), 'POST_WORKOUT', 'K coach', 'active', now(), current_date),
  ('f2810000-0000-4000-8000-000000000003', tests.uid('norec'), tests.kid(), 'POST_WORKOUT', 'K norec', 'active', now(), current_date);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('f2820000-0000-4000-8000-000000000001', tests.uid('owner'), 'club', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP'),
  ('f2820000-0000-4000-8000-000000000002', tests.uid('coach'), 'club', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP'),
  ('f2820000-0000-4000-8000-000000000003', tests.uid('m1'), 'club', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');

create function tests.set_auth_aal(p_uid uuid, p_aal text) returns void language plpgsql as $fn$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_uid::text, 'role', 'authenticated', 'aud', 'authenticated', 'aal', p_aal)::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_uid::text, true);
  perform pg_catalog.set_config('role', 'authenticated', true);
end $fn$;

-- An announcement to act on, made by the owner at aal2.
select tests.set_auth_aal(tests.uid('owner'), 'aal2');
select public.club_announcement_post(tests.kid(), 'הודעה לבדיקה', false) as ann \gset
select tests.clear_auth();
select ok(:'ann'::uuid is not null, 'setup: an announcement');
create temp table before_invites as select token_hash from public.circle_invites where club_id = tests.kid();
grant select on before_invites to authenticated;

-- ---- aal1 with a verified factor: refused, nothing changes ----
select tests.set_auth_aal(tests.uid('owner'), 'aal1');
select ok(not public.aal_satisfied(), 'the owner''s aal1 session does not satisfy aal');
select throws_ok($$ select public.rotate_club_link(tests.kid()) $$, 'P0001', 'not authorized', 'aal1 owner: rotate_club_link refused');
select throws_ok($$ select public.club_announcement_post(tests.kid(), 'should not post', false) $$, 'P0001', 'not authorized', 'aal1 owner: club_announcement_post refused');
select throws_ok(format('select public.club_announcement_set_pinned(%L::uuid, true)', :'ann'::text), 'P0001', 'not authorized', 'aal1 owner: club_announcement_set_pinned refused');
select throws_ok(format('select public.club_announcement_delete(%L::uuid)', :'ann'::text), 'P0001', 'not authorized', 'aal1 owner: club_announcement_delete refused');
select throws_ok($$ select public.remove_member(tests.kid(), tests.uid('m3')) $$, 'P0001', 'not authorized', 'aal1 owner: remove_member refused');
select throws_ok($$ select public.post_delete('f2810000-0000-4000-8000-000000000001') $$, 'P0001', 'not authorized', 'aal1 owner: post_delete (moderation) refused');
select tests.set_auth_aal(tests.uid('coach'), 'aal1');
select throws_ok($$ select public.post_delete('f2810000-0000-4000-8000-000000000003') $$, 'P0001', 'not authorized', 'aal1 coach: post_delete of a member''s post refused');
select throws_ok($$ select public.post_delete('f2810000-0000-4000-8000-000000000002') $$, 'P0001', 'not authorized', 'aal1 coach: post_delete of their own post refused too');
select throws_ok($$ select public.remove_member(tests.kid(), tests.uid('norec')) $$, 'P0001', 'not authorized', 'aal1 coach: remove_member refused');
select tests.set_auth_aal(tests.uid('m1'), 'aal1');
select throws_ok($$ select public.create_circle_invite(tests.fid()) $$, 'P0001', 'not authorized', 'aal1 circle owner: create_circle_invite refused');
select throws_ok($$ select public.update_circle(tests.fid(), '{"name":"Renamed"}'::jsonb) $$, 'P0001', 'not authorized', 'aal1 circle owner: update_circle refused');
select tests.clear_auth();

select is((select count(*)::int from public.circle_members where club_id = tests.kid() and user_id in (tests.uid('m3'), tests.uid('norec'))), 2, 'aal1: nobody was removed');
select is((select count(*)::int from public.workout_posts where id in ('f2810000-0000-4000-8000-000000000001', 'f2810000-0000-4000-8000-000000000002', 'f2810000-0000-4000-8000-000000000003') and deleted_at is null), 3, 'aal1: no post was deleted');
select is((select count(*)::int from public.club_announcements where club_id = tests.kid()), 1, 'aal1: no announcement was posted or deleted');
select ok(not (select pinned from public.club_announcements where id = :'ann'::uuid), 'aal1: nothing was pinned');
select set_eq('select token_hash from public.circle_invites where club_id = tests.kid()', 'select token_hash from before_invites', 'aal1: the club link was not rotated');
select is((select count(*)::int from public.circle_invites where club_id = tests.fid()), 0, 'aal1: no friends-circle invite was made');
select is((select name from public.clubs where id = tests.fid()), 'Friends F', 'aal1: the circle was not renamed');

-- ---- aal2: the same calls work ----
select tests.set_auth_aal(tests.uid('owner'), 'aal2');
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'aal2 owner: rotate_club_link');
select lives_ok($$ select public.club_announcement_post(tests.kid(), 'aal2 post', false) $$, 'aal2 owner: club_announcement_post');
select lives_ok(format('select public.club_announcement_set_pinned(%L::uuid, true)', :'ann'::text), 'aal2 owner: club_announcement_set_pinned');
select lives_ok(format('select public.club_announcement_delete(%L::uuid)', :'ann'::text), 'aal2 owner: club_announcement_delete');
select lives_ok($$ select public.post_delete('f2810000-0000-4000-8000-000000000001') $$, 'aal2 owner: post_delete');
select lives_ok($$ select public.remove_member(tests.kid(), tests.uid('m3')) $$, 'aal2 owner: remove_member');
select tests.set_auth_aal(tests.uid('m1'), 'aal2');
select lives_ok($$ select public.create_circle_invite(tests.fid()) $$, 'aal2 circle owner: create_circle_invite');
select lives_ok($$ select public.update_circle(tests.fid(), '{"name":"Renamed"}'::jsonb) $$, 'aal2 circle owner: update_circle');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where club_id = tests.kid() and user_id = tests.uid('m3')), 0, 'aal2: the member was removed');
select is((select name from public.clubs where id = tests.fid()), 'Renamed', 'aal2: the circle was renamed');

-- ---- a staff member with no factor is unaffected at aal1 ----
delete from auth.mfa_factors where user_id = tests.uid('coach');
select tests.set_auth_aal(tests.uid('coach'), 'aal1');
select ok(public.aal_satisfied(), 'no factor: aal1 satisfies aal');
select lives_ok($$ select public.post_delete('f2810000-0000-4000-8000-000000000003') $$, 'no factor, aal1 coach: post_delete still works');
select tests.clear_auth();

select * from finish();
rollback;
