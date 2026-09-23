-- Account deletion reaches what it used to miss (202609230001).
--
-- Four gaps from docs/audit/launch-readiness.md, three of them in the
-- database and tested here:
--   1. B3  - a deleted account's photos are queued for the Storage API, from
--            every bucket, by the account delete itself.
--   2. B4  - activity_pings and feed_interactions are purged on the same
--            90-day clock as the other telemetry.
--   3. The restriction reason copied into admin_actions is redacted when the
--      restricted member's account is deleted - and only then, and only on
--      rows about that member.
-- The fourth (B5, a delete button on the backup panel) calls the existing
-- request_account_deletion(); 0064 already covers that function for an
-- account with a profile, and section 4 below covers it for one without.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. Photos are queued with the account
-- =====================================================================
select tests.clear_auth();

select has_table('public', 'storage_erasure_queue', 'the erasure queue exists');
select is(
  (select relrowsecurity from pg_class where oid = 'public.storage_erasure_queue'::regclass),
  true,
  'RLS is on the queue');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'storage_erasure_queue'
      and grantee in ('anon', 'authenticated')),
  0,
  'and no client role holds any grant on it');

select ok(
  not has_function_privilege('authenticated', 'public.storage_erasure_pending(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.storage_erasure_pending(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.storage_erasure_done(text, text[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.storage_erasure_done(text, text[])', 'EXECUTE'),
  'no browser session can read or clear the queue');
select ok(
  has_function_privilege('service_role', 'public.storage_erasure_pending(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.storage_erasure_done(text, text[])', 'EXECUTE'),
  'the service role the Edge Function uses can');

-- m3 owns a post photo and an avatar under its own prefix, plus one object
-- uploaded outside the convention that only `owner` ties to it. m2 owns a
-- photo that must not be touched.
delete from public.storage_erasure_queue;
insert into storage.objects (bucket_id, name, owner) values
  ('post-photos',   tests.uid('m3')::text || '/p1.jpg',   tests.uid('m3')),
  ('avatar-photos', tests.uid('m3')::text || '/avatar.webp', tests.uid('m3')),
  ('post-photos',   'legacy/stray.jpg',                   tests.uid('m3')),
  ('post-photos',   tests.uid('m2')::text || '/p1.jpg',   tests.uid('m2'));

delete from auth.users where id = tests.uid('m3');

select set_eq(
  $$ select bucket_id, object_name from public.storage_erasure_queue $$,
  $$ values ('post-photos',   'aaaaaaaa-0000-4000-8000-000000000003/p1.jpg'),
            ('avatar-photos', 'aaaaaaaa-0000-4000-8000-000000000003/avatar.webp'),
            ('post-photos',   'legacy/stray.jpg') $$,
  'deleting the account queues every object it owns, in both buckets, by prefix or by owner - and nothing of anyone else''s');
select is(
  (select count(*)::int from storage.objects where name like tests.uid('m3')::text || '/%'),
  2,
  'the trigger does not delete storage.objects itself - that would orphan the bytes; the Storage API does the delete');

select set_eq(
  $$ select bucket_id, object_name from public.storage_erasure_pending(10) $$,
  $$ select bucket_id, object_name from public.storage_erasure_queue $$,
  'storage_erasure_pending hands the whole queue to the drain');
select is(
  (select min(attempts)::int from public.storage_erasure_queue),
  1,
  'and records that each row was handed out once');
select is(
  (select count(*)::int from public.storage_erasure_pending(1)),
  1,
  'p_limit is honoured');

select is(
  public.storage_erasure_done('post-photos', array[
    'aaaaaaaa-0000-4000-8000-000000000003/p1.jpg', 'legacy/stray.jpg']),
  2,
  'storage_erasure_done clears exactly the confirmed names in that bucket');
select set_eq(
  $$ select bucket_id, object_name from public.storage_erasure_queue $$,
  $$ values ('avatar-photos', 'aaaaaaaa-0000-4000-8000-000000000003/avatar.webp') $$,
  'and leaves what the API has not confirmed yet for the next night');
select is(
  public.storage_erasure_done('post-photos', array['aaaaaaaa-0000-4000-8000-000000000003/avatar.webp']),
  0,
  'a name is matched within its own bucket only');

select is(
  (select schedule from cron.job where jobname = 'purge-due-accounts'),
  '29 3 * * *',
  'the 30-day purge runs at 03:29, ahead of the 03:31 drain, so photos go the same night');
select is(
  (select count(*)::int from cron.job where jobname = 'purge-due-accounts'),
  1,
  'rescheduled in place, not duplicated');

-- =====================================================================
-- 2. activity_pings and feed_interactions follow the 90-day window
-- =====================================================================
delete from public.feed_impressions;
delete from public.analytics_events;
delete from public.feed_interactions;
delete from public.activity_pings;

insert into public.workout_posts (id, author_id, title, result_text, occurred_on)
values ('c1250000-0000-4000-8000-000000000001', tests.uid('m1'), 'Fran', '4:10', current_date);

insert into public.feed_interactions (user_id, post_id, kind, created_at) values
  (tests.uid('m2'), 'c1250000-0000-4000-8000-000000000001', 'open', now() - interval '200 days'),
  (tests.uid('m2'), 'c1250000-0000-4000-8000-000000000001', 'open', now() - interval '2 days');
insert into public.activity_pings (user_id, activity_date, created_at) values
  (tests.uid('m1'), current_date - 200, now() - interval '200 days'),
  (tests.uid('m1'), current_date - 2,   now() - interval '2 days'),
  -- A future-dated row still ages out by created_at.
  (tests.uid('m2'), current_date + 5,   now() - interval '200 days');

select results_eq(
  $$ select public.retention_purge_telemetry(90) $$,
  $$ values (3) $$,
  'the retention job now counts rows from feed_interactions and activity_pings in its total');
select results_eq(
  $$ select count(*)::int from public.feed_interactions $$,
  $$ values (1) $$,
  'the 200-day-old feed interaction is gone and the 2-day-old one survives');
select set_eq(
  $$ select user_id, activity_date from public.activity_pings $$,
  $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, current_date - 2) $$,
  'the old ping is gone, the recent one survives, and a future activity_date cannot outlive the window');
select results_eq(
  $$ select public.retention_purge_telemetry(90) $$,
  $$ values (0) $$,
  'a second pass deletes nothing');
select results_eq(
  $$ select public.retention_purge_telemetry(1) $$,
  $$ values (2) $$,
  'and p_days is the window for both new tables too');
select ok(
  not has_function_privilege('authenticated', 'public.retention_purge_telemetry(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.retention_purge_telemetry(integer)', 'EXECUTE'),
  'still granted to no client role');

-- =====================================================================
-- 3. The restriction reason is redacted with the account
-- =====================================================================
delete from public.admin_actions;

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.mod_restrict_member(tests.uid('m1'), 'permanent', null, 'סיפר בפוסט על הפציעה בברך', null) $$,
  'staff restrict m1 with a reason');
select lives_ok(
  $$ select public.mod_lift_restriction(
       (select id from public.posting_restrictions where user_id = tests.uid('m1') and lifted_at is null),
       'דיברנו איתו על הברך') $$,
  'and lift it with a reason of their own');
select lives_ok(
  $$ select public.mod_restrict_member(tests.uid('m2'), 'permanent', null, 'הסיבה של m2', null) $$,
  'm2 is restricted too, and stays');
select tests.clear_auth();

-- A report_review row carries the same text as its note when the decision
-- was a restriction. Written directly: the log has no client write path.
insert into public.admin_actions (admin_id, action_type, target_type, target_id, after_data, target_user_id, action_detail, note)
values
  (tests.uid('admin'), 'report_review', 'report', gen_random_uuid(),
   '{"status":"action_taken","decision":"restrict_permanent"}', tests.uid('m1'), 'restrict_permanent', 'סיפר בפוסט על הפציעה בברך'),
  -- m1 as the ACTING admin on someone else: about m2, so it stays.
  (tests.uid('m1'), 'member_restrict', 'member', tests.uid('m2'),
   '{"reason":"נכתב על m2"}', tests.uid('m2'), 'permanent', 'נכתב על m2');

select is(
  (select count(*)::int from public.admin_actions
    where target_user_id = tests.uid('m1') and note like '%ברך%'),
  3,
  'before deletion, three audit rows about m1 carry the reason');

delete from auth.users where id = tests.uid('m1');

select is(
  (select count(*)::int from public.admin_actions where target_user_id = tests.uid('m1')),
  3,
  'after deletion the audit rows are still there - the log outlives the account');
select is(
  (select count(*)::int from public.admin_actions
    where target_user_id = tests.uid('m1')
      and (note like '%ברך%' or after_data::text like '%ברך%')),
  0,
  'but no copy of the reason survives in note or after_data');
select is(
  (select note from public.admin_actions
    where target_user_id = tests.uid('m1') and action_type = 'member_restrict'),
  '[הנימוק נמחק יחד עם החשבון]',
  'the note says what happened to it, as bug reports do');
select is(
  (select after_data ->> 'reason' from public.admin_actions
    where target_user_id = tests.uid('m1') and action_type = 'member_restrict'),
  '[הנימוק נמחק יחד עם החשבון]',
  'after_data.reason is redacted too');
select is(
  (select after_data ->> 'lift_reason' from public.admin_actions
    where target_user_id = tests.uid('m1') and action_type = 'member_unrestrict'),
  '[הנימוק נמחק יחד עם החשבון]',
  'and so is the lift reason');
select is(
  (select after_data ->> 'restriction_type' from public.admin_actions
    where target_user_id = tests.uid('m1') and action_type = 'member_restrict'),
  'permanent',
  'the decision itself is kept');
select is(
  (select after_data ->> 'decision' from public.admin_actions
    where target_user_id = tests.uid('m1') and action_type = 'report_review'),
  'restrict_permanent',
  'including on the report review');
select is(
  (select count(*)::int from public.admin_actions
    where target_user_id = tests.uid('m2') and note in ('הסיבה של m2', 'נכתב על m2')),
  2,
  'rows about another member are untouched - including one the deleted member wrote as staff');

-- =====================================================================
-- 4. A backup-only account (no profile) can request deletion
-- =====================================================================
insert into auth.users (instance_id, id, aud, role, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0125-4000-8000-000000000001',
        'authenticated', 'authenticated', true, now(), now());
select tests.set_auth('bbbbbbbb-0125-4000-8000-000000000001');
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'an anonymous backup account with no profile can call request_account_deletion()');
select tests.clear_auth();
select is(
  (select count(*)::int from public.account_deletion_requests
    where user_id = 'bbbbbbbb-0125-4000-8000-000000000001'
      and purge_after > now() + interval '29 days'),
  1,
  'and it is scheduled for the same 30-day purge as everyone else');

select * from finish();
rollback;
