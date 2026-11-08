-- 202611080002: the weekly digest push fires on the chosen day and time, once, and carries no numbers.
\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m1'), 'weekly_digest', 'push');
-- Friday 2026-11-13, 10:00 local (UTC+2 in winter) is 08:00 UTC; the default pick is Friday 10:00.
insert into public.reminder_prefs (user_id) values (tests.uid('m1'));
select is(public.reminder_push_due('2026-11-13T08:02:00Z'), 1, 'the default pick (Friday 10:00) fires');
select is(public.reminder_push_due('2026-11-13T08:17:00Z'), 0, 'and only once');
select is(public.reminder_push_due('2026-11-14T08:02:00Z'), 0, 'not on another day');
select is((select deep_link from public.notifications where user_id = tests.uid('m1') and type = 'weekly_digest'), '/tab/history', 'it opens the progress tab');
select is((select category from public.notifications where user_id = tests.uid('m1') and type = 'weekly_digest'), 'training', 'a personal notification, no circle');
select ok((select circle_id is null from public.notifications where user_id = tests.uid('m1') and type = 'weekly_digest'), 'with no circle');

update public.notification_preferences set channel = 'off' where user_id = tests.uid('m1') and type = 'weekly_digest';
select is(public.reminder_push_due('2026-11-20T08:02:00Z'), 0, 'switched off: nothing is written');

select * from finish();
rollback;
