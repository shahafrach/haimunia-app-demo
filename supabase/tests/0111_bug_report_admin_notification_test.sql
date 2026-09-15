-- Bug reports reach the admin (202609150005).
--
-- The owner filed the first real bug report through the app and then said:
-- "it need to tap טעינת דיווחים for seeing it, so its not good, i want
-- notification for admin". A queue nobody is told about is a queue nobody
-- reads, and a bug channel nobody reads is worse than none - it collects a
-- member's effort and returns silence.
--
-- The audience is the load-bearing assertion here, not the delivery: alerting
-- a head coach about something only an admin can close is an interruption
-- with no available remedy, and this schema already made that mistake once in
-- the other direction (202609120012's moderation column exposure).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;
begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.set_auth(tests.uid('m1'));
select public.bug_report_submit('הכפתור לא עובד', '{"version":"4.44.0"}'::jsonb);
select tests.clear_auth();

select is(
  (select count(*)::int from public.notifications where type = 'new_bug_report' and user_id = tests.uid('admin')),
  1, 'the admin is notified when a member files a bug report');
select is(
  (select count(*)::int from public.notifications where type = 'new_bug_report' and user_id = tests.uid('coach')),
  0, 'a coach is NOT - closing a report is admin-only, so alerting them is an interruption they cannot act on');
select is(
  (select count(*)::int from public.notifications where type = 'new_bug_report' and user_id = tests.uid('m1')),
  0, 'and the reporter is not notified about their own report');
select * from finish();
rollback;
