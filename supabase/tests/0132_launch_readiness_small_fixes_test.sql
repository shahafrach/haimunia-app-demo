-- Four small launch-readiness items, each with the case that made it a defect
-- and the case that proves the fix discriminates (202609230009-12).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- S17 / COMM-105: a PR names the movement
-- =====================================================================
-- pr_share() resolves a NAME only for a custom movement, because only those
-- sync to private_records. It must record the movement ID regardless, so the
-- client can name a built-in lift from its own library.
select tests.set_auth(tests.uid('m1'));

-- A built-in lift: an id with no private_records 'movement' row behind it.
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('m1'), 'strength_entry', 'pr0132-builtin',
        jsonb_build_object('exerciseId', 'back-squat', 'weight', 100, 'reps', 1,
                           'ts', extract(epoch from now()) * 1000));

select lives_ok($$ select public.pr_share('pr0132-builtin', '', '[]'::jsonb, null) $$,
  'a PR on a built-in lift shares');

select is(
  (select metadata ->> 'movement_id' from public.workout_posts
    where author_id = tests.uid('m1') and post_type = 'POST_PR'
    order by created_at desc limit 1),
  'back-squat',
  'THE MOVEMENT ID IS RECORDED even though the name could not be resolved -
   without it the card falls through to the post-type label and every built-in
   PR in the feed reads "שיא אישי"');

select is(
  (select metadata ->> 'movement' from public.workout_posts
    where author_id = tests.uid('m1') and post_type = 'POST_PR'
    order by created_at desc limit 1),
  null,
  'and the name is still absent, because the server does not know the built-in
   library and deliberately does not learn it');
select tests.clear_auth();

-- =====================================================================
-- N8 / AUDIT-RECON-003: an event image must be https
-- =====================================================================
select throws_ok(
  $$ insert into public.events (id, title, event_type, start_at, created_by, status, image_url)
     values ('e0132000-0000-4000-8000-000000000001', 'x', 'social_night', now(),
             tests.uid('coach'), 'draft', 'javascript:alert(1)') $$,
  '23514', null, 'a javascript: image URL is refused by the column, not only by the renderer');

select throws_ok(
  $$ insert into public.events (id, title, event_type, start_at, created_by, status, image_url)
     values ('e0132000-0000-4000-8000-000000000002', 'x', 'social_night', now(),
             tests.uid('coach'), 'draft', 'http://example.com/a.jpg') $$,
  '23514', null, 'and so is plain http - a mixed-content image is a broken image with a leak attached');

select lives_ok(
  $$ insert into public.events (id, title, event_type, start_at, created_by, status, image_url)
     values ('e0132000-0000-4000-8000-000000000003', 'x', 'social_night', now(),
             tests.uid('coach'), 'draft', 'https://example.com/a.jpg') $$,
  'an https URL is accepted - the check discriminates rather than simply forbidding');

select lives_ok(
  $$ insert into public.events (id, title, event_type, start_at, created_by, status, image_url)
     values ('e0132000-0000-4000-8000-000000000004', 'x', 'social_night', now(),
             tests.uid('coach'), 'draft', null) $$,
  'and null is still allowed - most events have no image');

-- =====================================================================
-- N11: a revoked push endpoint does not live forever
-- =====================================================================
insert into public.push_subscriptions (user_id, endpoint, keys, created_at, revoked_at)
values (tests.uid('m1'), 'https://push.example/old', '{}'::jsonb,
        now() - interval '200 days', now() - interval '120 days'),
       (tests.uid('m2'), 'https://push.example/recent', '{}'::jsonb,
        now() - interval '200 days', now() - interval '10 days'),
       (tests.uid('m3'), 'https://push.example/live', '{}'::jsonb,
        now() - interval '200 days', null);

select lives_ok($$ select public.retention_purge_telemetry(90) $$, 'the retention job runs');

select is_empty(
  $$ select 1 from public.push_subscriptions where endpoint = 'https://push.example/old' $$,
  'a subscription revoked 120 days ago is gone');
select isnt_empty(
  $$ select 1 from public.push_subscriptions where endpoint = 'https://push.example/recent' $$,
  'one revoked 10 days ago is kept - the tail is deliberate, revoked_at is what stops
   notif_push_pending re-selecting a dead endpoint');
select isnt_empty(
  $$ select 1 from public.push_subscriptions where endpoint = 'https://push.example/live' $$,
  'and a LIVE subscription is never touched, whatever its age');

-- =====================================================================
-- N7 / COMM-315: the member of the week is told
-- =====================================================================
-- Asserted on the definition rather than by publishing: member_of_week_publish
-- needs a week's worth of eligibility fixtures to reach its insert, and what
-- is being fixed here is that the call was absent entirely.
select ok(
  (select pg_get_functiondef(oid) like '%notif_create%'
     from pg_proc where proname = 'member_of_week_publish' and pronamespace = 'public'::regnamespace),
  'member_of_week_publish notifies the member it is about');
select ok(
  (select pg_get_functiondef(oid) like '%exception when others%'
     from pg_proc where proname = 'member_of_week_publish' and pronamespace = 'public'::regnamespace),
  'and best-effort: a notification that cannot be written must not roll back the club''s choice');

select * from finish();
rollback;
