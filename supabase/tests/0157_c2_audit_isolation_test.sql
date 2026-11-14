-- C2 audit isolation (2026-11-14 full review).
-- Proves: user A cannot read or change user B's rows; a non-member cannot see a
-- club feed or a circle; anon reads nothing private; club and BOX-LOG (friends)
-- data are isolated. Also asserts C2-1 staff audit writes.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

create function tests.cnt(p_sql text) returns bigint
language plpgsql as $fn$
declare n bigint;
begin
  execute p_sql into n;
  return n;
exception when insufficient_privilege then return 0;
end $fn$;
create function tests.dml(p_sql text) returns integer
language plpgsql as $fn$
declare n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception when insufficient_privilege then return 0;
end $fn$;
grant execute on function tests.cnt(text), tests.dml(text) to authenticated, anon;

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;
delete from public.private_records;
delete from public.workout_posts;
delete from public.club_announcements;
delete from public.club_staff_actions;

insert into public.clubs (id, name, type, created_by) values
  ('f0000000-0000-4000-8000-00000000000f', 'Friends F', 'friends', tests.uid('m1')),
  ('c0000000-0000-4000-8000-00000000000c', 'Club K', 'club', tests.uid('owner'));
insert into public.circle_members (club_id, user_id, role) values
  ('f0000000-0000-4000-8000-00000000000f', tests.uid('m1'), 'owner'),
  ('f0000000-0000-4000-8000-00000000000f', tests.uid('m2'), 'member'),
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('owner'), 'owner'),
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('coach'), 'coach'),
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('m3'), 'member');

insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m1'), 'session_note', 'c2-a', '{"t":"a"}'::jsonb),
  (tests.uid('m2'), 'session_note', 'c2-b', '{"t":"b"}'::jsonb);

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('af000000-0000-4000-8000-000000000001', tests.uid('m2'), 'f0000000-0000-4000-8000-00000000000f', 'POST_WORKOUT', 'F feed', 'active', now()),
  ('ac000000-0000-4000-8000-000000000001', tests.uid('m3'), 'c0000000-0000-4000-8000-00000000000c', 'POST_WORKOUT', 'K feed', 'active', now());

insert into public.club_announcements (club_id, author_id, body) values
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('owner'), 'club only');

select tests.set_auth(tests.uid('m1'));
select is(tests.cnt($$ select count(*) from public.private_records where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' $$),
  0::bigint, 'C2: m1 cannot read m2 private_records');
select is(tests.dml($$ update public.private_records set payload = '{"t":"hack"}'::jsonb where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' $$),
  0, 'C2: m1 cannot update m2 private_records');
select is(tests.dml($$ delete from public.private_records where user_id = 'aaaaaaaa-0000-4000-8000-000000000002' $$),
  0, 'C2: m1 cannot delete m2 private_records');
select is(tests.cnt($$ select count(*) from public.private_records where user_id = auth.uid() $$),
  1::bigint, 'C2: m1 still sees only own private_records');

select tests.set_auth(tests.uid('m1'));
select is(tests.cnt($$ select count(*) from public.workout_posts where club_id = 'c0000000-0000-4000-8000-00000000000c' $$),
  0::bigint, 'C2: non-member cannot see club feed posts');
select is(tests.cnt($$ select count(*) from public.club_announcements where club_id = 'c0000000-0000-4000-8000-00000000000c' $$),
  0::bigint, 'C2: non-member cannot see club announcements');
select is(tests.cnt($$ select count(*) from public.circle_members where club_id = 'c0000000-0000-4000-8000-00000000000c' $$),
  0::bigint, 'C2: non-member cannot see club circle_members');
select is(tests.cnt($$ select count(*) from public.clubs where id = 'c0000000-0000-4000-8000-00000000000c' $$),
  0::bigint, 'C2: non-member cannot see the club row');

select tests.clear_auth();
set local role anon;
select is(tests.cnt($$ select count(*) from public.private_records $$), 0::bigint, 'C2: anon reads zero private_records');
select is(tests.cnt($$ select count(*) from public.workout_posts $$), 0::bigint, 'C2: anon reads zero workout_posts');
select is(tests.cnt($$ select count(*) from public.circle_members $$), 0::bigint, 'C2: anon reads zero circle_members');
select is(tests.cnt($$ select count(*) from public.clubs $$), 0::bigint, 'C2: anon reads zero clubs');
select is(tests.cnt($$ select count(*) from public.club_announcements $$), 0::bigint, 'C2: anon reads zero announcements');
select is(tests.cnt($$ select count(*) from public.profiles $$), 0::bigint, 'C2: anon reads zero profiles');
select is(tests.cnt($$ select count(*) from public.transfer_blobs $$), 0::bigint, 'C2: anon reads zero transfer_blobs');
select tests.clear_auth();

select tests.set_auth(tests.uid('m2'));
select is(tests.cnt($$ select count(*) from public.workout_posts where club_id = 'f0000000-0000-4000-8000-00000000000f' $$),
  1::bigint, 'C2: friends member sees friends feed');
select is(tests.cnt($$ select count(*) from public.workout_posts where club_id = 'c0000000-0000-4000-8000-00000000000c' $$),
  0::bigint, 'C2: friends member does not see club feed');
select tests.set_auth(tests.uid('m3'));
select is(tests.cnt($$ select count(*) from public.workout_posts where club_id = 'c0000000-0000-4000-8000-00000000000c' $$),
  1::bigint, 'C2: club member sees club feed');
select is(tests.cnt($$ select count(*) from public.workout_posts where club_id = 'f0000000-0000-4000-8000-00000000000f' $$),
  0::bigint, 'C2: club member does not see friends feed');

select tests.clear_auth();
select tests.set_auth(tests.uid('coach'));
select lives_ok($$ select public.club_announcement_post('c0000000-0000-4000-8000-00000000000c', 'audit probe', false) $$,
  'C2-1 setup: coach posts an announcement');
select tests.clear_auth();
select ok((select count(*) > 0 from public.club_staff_actions where action = 'announcement_post'),
  'C2-1: announcement_post writes club_staff_actions');

select tests.set_auth(tests.uid('coach'));
select public.club_announcement_post('c0000000-0000-4000-8000-00000000000c', 'to pin', true) as ann_pin \gset
select lives_ok(format('select public.club_announcement_set_pinned(%L, false)', :'ann_pin'),
  'C2-1 setup: unpin');
select tests.clear_auth();
select ok((select count(*) > 0 from public.club_staff_actions where action = 'announcement_unpin' and target_id = :'ann_pin'::uuid),
  'C2-1: club_announcement_set_pinned writes club_staff_actions');

select tests.set_auth(tests.uid('coach'));
select lives_ok(format('select public.club_announcement_delete(%L)', :'ann_pin'),
  'C2-1 setup: delete announcement');
select tests.clear_auth();
select ok((select count(*) > 0 from public.club_staff_actions where action = 'announcement_delete' and target_id = :'ann_pin'::uuid),
  'C2-1: club_announcement_delete writes club_staff_actions');

select tests.set_auth(tests.uid('coach'));
select lives_ok($$ select public.remove_member('c0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000003') $$,
  'C2-1 setup: coach removes m3');
select tests.clear_auth();
select ok((select count(*) > 0 from public.club_staff_actions
            where action = 'member_remove' and target_id = 'aaaaaaaa-0000-4000-8000-000000000003'),
  'C2-1: remove_member writes club_staff_actions');

select * from finish();
rollback;
