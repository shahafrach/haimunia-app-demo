-- 202611140001 (F-002): every club staff action writes one club_staff_actions row with the actor, the
-- target and the time; a refused action and an action outside a club write none; no client role can
-- read or write the log, and no text is ever copied into it.
--
--   Friends circle F: m1 (owner), m2
--   Club K:           owner (owner), coach (coach), m3, norec

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
create function tests.fid() returns uuid language sql immutable as $$ select 'f0000000-0000-4000-8000-00000000000f'::uuid $$;
grant execute on function tests.fid() to authenticated, anon, service_role;
create function tests.log_count(p_action text) returns integer language sql stable security definer set search_path = '' as
  $$ select count(*)::int from public.club_staff_actions a where a.action = p_action $$;
grant execute on function tests.log_count(text) to authenticated;

insert into public.clubs (id, name, type, created_by) values (tests.fid(), 'Friends F', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values
  (tests.fid(), tests.uid('m1'), 'owner'), (tests.fid(), tests.uid('m2'), 'member');
select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'), (tests.kid(), tests.uid('norec'), 'member');
select is(public.owner_set_coach('coach'), 'set', 'setup: the coach');

-- The table: RLS on, no client grant, the helper granted to no role.
select ok((select relrowsecurity from pg_class where oid = 'public.club_staff_actions'::regclass), 'club_staff_actions has RLS on');
select ok(not has_table_privilege('authenticated', 'public.club_staff_actions', 'select'), 'authenticated cannot read the log');
select ok(not has_table_privilege('authenticated', 'public.club_staff_actions', 'insert'), 'authenticated cannot write the log');
select ok(not has_table_privilege('anon', 'public.club_staff_actions', 'select'), 'anon cannot read the log');
select ok(not has_function_privilege('authenticated', 'public.club_staff_log(uuid, text, uuid)', 'execute'), 'club_staff_log is not callable by authenticated');
select ok(not has_function_privilege('anon', 'public.club_staff_log(uuid, text, uuid)', 'execute'), 'nor by anon');

-- Posts: a moderator's removal is logged; an author deleting their own post is not.
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d5500000-0000-4000-8000-000000000001', tests.uid('m3'), tests.kid(), 'POST_WORKOUT', 'K m3 workout', 'active', now(), current_date),
  ('d5500000-0000-4000-8000-000000000002', tests.uid('coach'), tests.kid(), 'POST_WORKOUT', 'K coach workout', 'active', now(), current_date);
select tests.set_auth(tests.uid('coach'));
select lives_ok($$ select public.post_delete('d5500000-0000-4000-8000-000000000001') $$, 'the coach removes a member''s post');
select lives_ok($$ select public.post_delete('d5500000-0000-4000-8000-000000000002') $$, 'the coach deletes their own post');
select tests.clear_auth();
select is(tests.log_count('post_remove'), 1, 'one post_remove row: the moderation, not the coach''s own delete');
select is((select actor_id from public.club_staff_actions where action = 'post_remove'), tests.uid('coach'), 'post_remove: the actor is the coach');
select is((select target_id from public.club_staff_actions where action = 'post_remove'), 'd5500000-0000-4000-8000-000000000001'::uuid, 'post_remove: the target is the post');

-- Removing a member.
select tests.set_auth(tests.uid('m3'));
select throws_ok(format('select public.remove_member(%L, %L)', tests.kid(), tests.uid('norec')), 'P0001', 'not authorized', 'a member cannot remove a member');
select tests.set_auth(tests.uid('m1'));
select lives_ok(format('select public.remove_member(%L, %L)', tests.fid(), tests.uid('m2')), 'a friends circle owner removes a member');
select tests.set_auth(tests.uid('coach'));
select lives_ok(format('select public.remove_member(%L, %L)', tests.kid(), tests.uid('norec')), 'the coach removes a club member');
select tests.clear_auth();
select is(tests.log_count('member_remove'), 1, 'one member_remove row: the club removal; a refused one and a friends circle write none');
select results_eq(
  $$ select club_id, actor_id, target_id from public.club_staff_actions where action = 'member_remove' $$,
  format('values (%L::uuid, %L::uuid, %L::uuid)', tests.kid(), tests.uid('coach'), tests.uid('norec')),
  'member_remove: club, actor and the removed member');
select ok((select created_at from public.club_staff_actions where action = 'member_remove') <= now(), 'member_remove: with its time');

-- The link.
select tests.set_auth(tests.uid('m3'));
select throws_ok($$ select public.rotate_club_link(tests.kid()) $$, 'P0001', 'not authorized', 'a member cannot rotate the link');
select tests.set_auth(tests.uid('owner'));
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'the owner rotates the link');
select tests.clear_auth();
select is(tests.log_count('link_rotate'), 1, 'one link_rotate row');
select is((select actor_id from public.club_staff_actions where action = 'link_rotate'), tests.uid('owner'), 'link_rotate: the actor is the owner');

-- Announcements: post, pin, unpin, delete. No body in the log.
select tests.set_auth(tests.uid('coach'));
select public.club_announcement_post(tests.kid(), 'אימון מיוחד ביום שישי', false) as ann1 \gset
select tests.set_auth(tests.uid('m3'));
select throws_ok(format('select public.club_announcement_set_pinned(%L, true)', :'ann1'), 'P0001', 'not authorized', 'a member cannot pin');
select throws_ok(format('select public.club_announcement_delete(%L)', :'ann1'), 'P0001', 'not authorized', 'a member cannot delete');
select tests.set_auth(tests.uid('owner'));
select lives_ok(format('select public.club_announcement_set_pinned(%L, true)', :'ann1'), 'the owner pins it');
select lives_ok(format('select public.club_announcement_set_pinned(%L, false)', :'ann1'), 'and unpins it');
select lives_ok(format('select public.club_announcement_delete(%L)', :'ann1'), 'and deletes it');
select tests.clear_auth();
select is(tests.log_count('announcement_post'), 1, 'one announcement_post row');
select is(tests.log_count('announcement_pin'), 1, 'one announcement_pin row');
select is(tests.log_count('announcement_unpin'), 1, 'one announcement_unpin row');
select is(tests.log_count('announcement_delete'), 1, 'one announcement_delete row');
select results_eq(
  $$ select actor_id, target_id from public.club_staff_actions where action = 'announcement_delete' $$,
  format('values (%L::uuid, %L::uuid)', tests.uid('owner'), :'ann1'),
  'announcement_delete: the owner and the deleted announcement''s id, which outlives it');
select is((select count(*)::int from public.club_staff_actions a where a.club_id <> tests.kid()), 0, 'nothing logged outside the club');
select is((select count(*)::int from public.club_staff_actions a where a::text like '%אימון%'), 0, 'no announcement text is copied into the log');

-- Retention: 12 months, purged daily.
insert into public.club_staff_actions (club_id, actor_id, action, target_id, created_at) values
  (tests.kid(), tests.uid('owner'), 'link_rotate', null, now() - interval '13 months'),
  (tests.kid(), tests.uid('owner'), 'link_rotate', null, now() - interval '11 months');
select is(public.club_staff_actions_purge(), 1, 'the purge deletes the row older than 12 months');
select is(tests.log_count('link_rotate'), 2, 'and keeps the 11-month-old row and today''s');
select ok(exists (select 1 from cron.job where jobname = 'club-staff-actions-purge' and command like '%club_staff_actions_purge%'), 'the purge is scheduled');
select ok(not has_function_privilege('authenticated', 'public.club_staff_actions_purge()', 'execute'), 'the purge is not callable by authenticated');

-- An authenticated caller cannot read it even through the table name.
select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select count(*) from public.club_staff_actions $$, '42501', null, 'even the club owner cannot read the log from the app');
select tests.clear_auth();

select * from finish();
rollback;
