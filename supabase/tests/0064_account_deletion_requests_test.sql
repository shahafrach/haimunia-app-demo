-- account_deletion_requests (202608260001) - self-select only, NO write grant
-- at all for `authenticated`; request_account_deletion() is the only writer
-- and purge_due_accounts() the only reaper.
--
-- This file used to cover activity_pings, weekly_challenges and
-- admin_remove_member() as well; those went with their features in
-- 202610250001 (strip gym), and only the account-deletion path is kept.
--
\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. account_deletion_requests - the read boundary
-- =====================================================================
-- Seeded as the bootstrap superuser: there is no INSERT grant for any
-- client role, so this is the only way to get two members' rows side by
-- side without going through request_account_deletion() first.
select tests.clear_auth();
insert into public.account_deletion_requests (user_id)
values (tests.uid('m1')), (tests.uid('m2'));

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select user_id from public.account_deletion_requests $$,
  $$ select tests.uid('m1') $$,
  'a member selecting the whole table gets exactly their own pending-deletion row');
select is_empty(
  $$ select user_id from public.account_deletion_requests where user_id = tests.uid('m2') $$,
  'and naming another member''s id explicitly returns nothing - the row is filtered away, not refused with an error that would confirm it exists');

-- Whether a member is scheduled for deletion is exactly the kind of thing
-- an admin panel might want, and deliberately does not have: the table has
-- ONE policy and it is self-select. Nothing widens it for staff.
select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select user_id from public.account_deletion_requests $$,
  'an admin has NO special read access - is_admin buys nothing on this table');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select user_id from public.account_deletion_requests $$,
  'and neither does a coach - there is no is_staff() branch here either');

-- =====================================================================
-- 2. account_deletion_requests - the write boundary is the GRANT
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.account_deletion_requests (user_id) values (tests.uid('m1')) $$,
  '42501',
  null,
  'a member cannot insert their own deletion row directly - request_account_deletion() is the only self-service write path');
select throws_ok(
  $$ insert into public.account_deletion_requests (user_id) values (tests.uid('m3')) $$,
  '42501',
  null,
  'and certainly cannot schedule somebody else for deletion');
select throws_ok(
  $$ update public.account_deletion_requests set purge_after = now() + interval '100 years' where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'a member cannot push their own purge_after out to dodge the reaper');
select throws_ok(
  $$ delete from public.account_deletion_requests where user_id = tests.uid('m1') $$,
  '42501',
  null,
  'nor delete the row to cancel - undo is a support action, not a client one');

select tests.clear_auth();
select ok(
  pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'select'),
  'the grant matrix says it out loud: authenticated may SELECT');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'insert')
  and not pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'update')
  and not pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_requests', 'delete'),
  'and nothing else - the three writes above fail at the grant, before RLS is even consulted');
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.account_deletion_requests', 'select'),
  'a signed-out session cannot read the table at all');

-- =====================================================================
-- 3. request_account_deletion() - the one member-facing writer
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body)
values ('c0640000-0000-4000-8000-000000000001', tests.uid('m3'), 'club', 'a post by the member who is about to leave');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'a member can schedule their own deletion');
select results_eq(
  $$ select user_id from public.account_deletion_requests $$,
  $$ select tests.uid('m3') $$,
  'and can still read their own row back AFTER the call soft-deleted their profile - the 30-day undo window stays visible to the person in it');
select ok(
  (select purge_after between now() + interval '29 days' and now() + interval '31 days'
     from public.account_deletion_requests where user_id = tests.uid('m3')),
  'purge_after lands 30 days out, matching the grace period the UI promises');

select tests.clear_auth();
select ok(
  (select deleted_at is not null from public.profiles where id = tests.uid('m3')),
  'the profile is soft-deleted immediately, so the member disappears from the club the moment they ask');
select ok(
  not exists (select 1 from public.workout_posts where id = 'c0640000-0000-4000-8000-000000000001' and deleted_at is null),
  'and every post they authored is gone: deleted with their circle membership (202610290003), as leave_circle does, or soft-deleted if it was in no circle');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'calling it a second time is safe - the on conflict clause re-arms the same row');
select tests.clear_auth();
select is(
  (select count(*)::int from public.account_deletion_requests where user_id = tests.uid('m3')),
  1,
  'still exactly one row, not a second pending request');
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.request_account_deletion()', 'execute'),
  'and a signed-out session cannot call it - auth.uid() would be null and the insert would write a NULL user_id');

-- =====================================================================
-- 10. purge_due_accounts() - service-role only, and it really deletes
-- =====================================================================
-- Destructive, so it runs last: it removes the auth.users row for the
-- member who asked to leave in section 3.
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'public.purge_due_accounts()', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'public.purge_due_accounts()', 'execute'),
  'no browser session can run the reaper, whatever role it holds');
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.purge_due_accounts()', 'execute'),
  'only the service role the scheduler uses can');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.purge_due_accounts() $$,
  '42501',
  null,
  'and an admin calling it from the app gets permission denied, not a purge');

select tests.clear_auth();
update public.account_deletion_requests set purge_after = now() - interval '1 day' where user_id = tests.uid('m3');
select is(
  public.purge_due_accounts(),
  1,
  'once the 30 days are up the reaper takes exactly the one row that is due');
select is(
  (select count(*)::int from auth.users where id = tests.uid('m3')),
  0,
  'the auth.users row is really gone - a hard delete, not another soft one');
select is(
  (select count(*)::int from public.profiles where id = tests.uid('m3')),
  0,
  'and on delete cascade took the profile with it');
select is(
  (select count(*)::int from public.account_deletion_requests where user_id = tests.uid('m3')),
  0,
  'along with the request row itself, so the queue drains');
select is(
  public.purge_due_accounts(),
  0,
  'a second run finds nothing - the reaper is idempotent');
select is(
  (select count(*)::int from public.account_deletion_requests),
  2,
  'and the two requests still inside their 30-day window are untouched, which is the whole point of the grace period');

select * from finish();
rollback;
