-- 202611080001: push triggers.
--   1. A reaction is ON for a member with no preference row, OFF with an explicit off row; every other
--      type (including the new ones) is off with no row.
--   2. reminder_prefs is own-row only, closed to anon, readable by service_role (backup), carries aal2_required.
--   3. The job and the trigger function are closed to the API roles.
--   4. reminder_push_due writes one content-free row per member per day, only on a chosen day and time.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
select ok(public.notif_pref_allows(tests.uid('m1'), 'reaction'), 'reaction: no row means on');
select ok(not public.notif_pref_allows(tests.uid('m1'), 'pr_circle'), 'pr_circle: no row means off');
select ok(not public.notif_pref_allows(tests.uid('m1'), 'workout_reminder'), 'workout_reminder: no row means off');
select ok(not public.notif_pref_allows(tests.uid('m1'), 'weekly_digest'), 'weekly_digest: no row means off');
insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m1'), 'reaction', 'off'), (tests.uid('m1'), 'workout_reminder', 'push');
select ok(not public.notif_pref_allows(tests.uid('m1'), 'reaction'), 'reaction: an explicit off row is off');
select ok(public.notif_pref_allows(tests.uid('m1'), 'workout_reminder'), 'workout_reminder: a push row is on');

select ok(not has_table_privilege('anon', 'public.reminder_prefs', 'select'), 'anon cannot read reminder_prefs');
select ok(has_table_privilege('service_role', 'public.reminder_prefs', 'select'), 'service_role can (backup)');
select is((select count(*)::int from pg_policy where polrelid = 'public.reminder_prefs'::regclass and polname = 'aal2_required' and not polpermissive), 1, 'restrictive aal2_required is there');
select ok(not has_function_privilege('authenticated', 'public.reminder_push_due(timestamptz)', 'execute'), 'authenticated cannot run the job');
select ok(not has_function_privilege('anon', 'public.notif_on_pr_post()', 'execute'), 'anon cannot run the trigger function');

-- 2026-11-08 is a Sunday (dow 0). Winter time: Jerusalem is UTC+2, so 15:30 UTC is 17:30 local.
insert into public.reminder_prefs (user_id, workout_days, workout_hour, workout_minute)
  values (tests.uid('m1'), array[0]::smallint[], 17, 30);
select is(public.reminder_push_due('2026-11-08T15:32:00Z'), 1, 'it fires in the chosen slot');
select is(public.reminder_push_due('2026-11-08T15:47:00Z'), 0, 'and not in the next slot');
select is(public.reminder_push_due('2026-11-08T15:33:00Z'), 0, 'a second run in the same slot writes nothing');
select is(public.reminder_push_due('2026-11-09T15:32:00Z'), 0, 'and not on a day that was not chosen');
select is((select body from public.notifications where user_id = tests.uid('m1') and type = 'workout_reminder'),
  'הגיע הזמן שבחרתם לאימון. נתראה בסט הראשון.', 'the text carries nothing from the training log');

select * from finish();
rollback;
