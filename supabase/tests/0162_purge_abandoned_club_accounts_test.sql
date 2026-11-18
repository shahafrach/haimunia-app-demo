-- An account left behind is deleted after a year, through delete_my_account's own body (202611180003, Q-38d/e).
--
--   Club K: owner (owner), coach (coach), m3, norec, admin

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

select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'),
  (tests.kid(), tests.uid('norec'), 'member'), (tests.kid(), tests.uid('admin'), 'member');

-- Everyone's account looks a year and more old; then each kept one gets one kind of recent activity.
update auth.users set created_at = now() - interval '400 days', last_sign_in_at = now() - interval '400 days'
 where id in (tests.uid('owner'), tests.uid('coach'), tests.uid('m3'), tests.uid('norec'), tests.uid('admin'));
delete from auth.sessions where user_id in (tests.uid('owner'), tests.uid('coach'), tests.uid('m3'), tests.uid('norec'), tests.uid('admin'));
delete from auth.refresh_tokens where user_id in (tests.uid('owner')::text, tests.uid('coach')::text, tests.uid('m3')::text, tests.uid('norec')::text, tests.uid('admin')::text);
update auth.users set last_sign_in_at = now() - interval '10 days' where id = tests.uid('owner');                -- a sign-in
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at)
values (gen_random_uuid(), tests.uid('coach'), now() - interval '400 days', now() - interval '3 days', (now() - interval '3 days')::timestamp); -- a refresh
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on)
values ('f3900000-0000-4000-8000-000000000001', tests.uid('m3'), tests.kid(), 'POST_WORKOUT', 'K m3', 'active', now() - interval '20 days', current_date); -- a post
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on)
values ('f3900000-0000-4000-8000-000000000002', tests.uid('norec'), tests.kid(), 'POST_WORKOUT', 'K norec', 'active', now() - interval '500 days', current_date);

-- =====================================================================================================
-- 1. Closed to every role
-- =====================================================================================================
select ok(not has_function_privilege('authenticated', 'public.purge_abandoned_club_accounts(integer)', 'execute'), 'purge: not authenticated');
select ok(not has_function_privilege('service_role', 'public.purge_abandoned_club_accounts(integer)', 'execute'), 'purge: not service_role');
select ok(not has_function_privilege('authenticated', 'public.delete_account_now(uuid)', 'execute'), 'delete_account_now: not authenticated');
select ok(not has_function_privilege('service_role', 'public.delete_account_now(uuid)', 'execute'), 'delete_account_now: not service_role');
select ok(not has_function_privilege('authenticated', 'public.account_last_activity(uuid)', 'execute'), 'account_last_activity: not authenticated');
select ok(has_function_privilege('authenticated', 'public.delete_my_account()', 'execute'), 'delete_my_account keeps its grant');

-- =====================================================================================================
-- 2. Last activity counts every kind
-- =====================================================================================================
select ok(public.account_last_activity(tests.uid('owner')) > now() - interval '11 days', 'a sign-in counts');
select ok(public.account_last_activity(tests.uid('coach')) > now() - interval '4 days', 'a session refresh counts');
select ok(public.account_last_activity(tests.uid('m3')) > now() - interval '21 days', 'a post counts');
select ok(public.account_last_activity(tests.uid('norec')) < now() - interval '365 days', 'norec: nothing for over a year');
select ok(public.account_last_activity(tests.uid('admin')) < now() - interval '365 days', 'admin: nothing for over a year');
-- admin reacted a month ago, so admin is kept too.
insert into public.reactions (post_id, user_id, kind, created_at) values ('f3900000-0000-4000-8000-000000000001', tests.uid('admin'), 'fire', now() - interval '30 days');
select ok(public.account_last_activity(tests.uid('admin')) > now() - interval '31 days', 'a reaction counts');

-- =====================================================================================================
-- 3. The purge
-- =====================================================================================================
select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select public.purge_abandoned_club_accounts(365) $$, '42501', null, 'not callable from a session');
select tests.clear_auth();

select is(public.purge_abandoned_club_accounts(365), '{"deleted": 1, "failed": 0, "kept_with_data": 0}'::jsonb, 'one account is a year gone: norec');
select ok(not exists (select 1 from auth.users where id = tests.uid('norec')), 'its auth user is deleted');
select ok(not exists (select 1 from public.profiles where id = tests.uid('norec')), 'its profile');
select ok(not exists (select 1 from public.circle_members where user_id = tests.uid('norec')), 'its membership');
select ok(not exists (select 1 from public.workout_posts where author_id = tests.uid('norec')), 'its posts');
select is((select count(*)::int from public.circle_members where club_id = tests.kid()), 4, 'everyone with any activity in the year stays');
select is(public.purge_abandoned_club_accounts(365), '{"deleted": 0, "failed": 0, "kept_with_data": 0}'::jsonb, 'a second run deletes nothing');
select is(public.purge_abandoned_club_accounts(1), '{"deleted": 0, "failed": 0, "kept_with_data": 0}'::jsonb, 'a window under 90 days is raised to 90: nobody active this month goes');

-- An anonymous account is not this purge's (purge_abandoned_profiles has it).
update auth.users set is_anonymous = true, last_sign_in_at = now() - interval '400 days' where id = tests.uid('owner');
select is((public.purge_abandoned_club_accounts(365) ->> 'deleted')::int, 0, 'an anonymous account is left to purge_abandoned_profiles');

select ok(exists (select 1 from cron.job where jobname = 'purge-abandoned-club-accounts'
                   and command like '%purge_abandoned_club_accounts(365)%'), 'the daily job is scheduled');

select * from finish();
rollback;
