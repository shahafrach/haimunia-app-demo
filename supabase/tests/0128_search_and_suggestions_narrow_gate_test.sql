-- The narrower gate for search and suggestions (202609230004).
--
-- 0125 and 0127 assert the shape "module off -> the call refuses". These two
-- functions are the opposite case on purpose: they must KEEP WORKING with the
-- module off and return less. So every assertion here comes in a pair - the
-- gated slot empties, and the ungated one does not - because a gate that
-- emptied the whole result would pass any test that only checked the gated
-- half, and emptying search is precisely what 202609230003 refused to do.
--
-- Modules are switched as the bootstrap superuser, so the fixture leaves no
-- admin_actions row, same as 0127.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- --------------------------------------------------------------------------
-- Fixture. One event and one challenge whose titles share a search token with
-- a member's display name, so ONE query exercises all three slots at once: if
-- the gate ever reached the members slot, the members assertion below fails
-- rather than silently passing on a query that matched no member anyway.
-- --------------------------------------------------------------------------
update public.profiles set display_name = 'Zebra Person' where id = tests.uid('m2');

insert into public.events (id, title, event_type, start_at, created_by, status)
  values ('e1280000-0000-4000-8000-000000000001', 'Zebra Social', 'social_night',
          now() + interval '3 days', tests.uid('coach'), 'published');

insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, created_by, status)
  values ('c1280000-0000-4000-8000-000000000001', 'Zebra Challenge', 'individual_target', 'reps',
          now(), now() + interval '7 days', tests.uid('coach'), 'active');

-- m1 and m2 share the challenge and the event, so BOTH people_suggestions
-- signals under test are non-zero before anything is switched off.
insert into public.challenge_participants (challenge_id, user_id, status) values
  ('c1280000-0000-4000-8000-000000000001', tests.uid('m1'), 'active'),
  ('c1280000-0000-4000-8000-000000000001', tests.uid('m2'), 'active');
insert into public.event_attendees (event_id, user_id, response, registered_at) values
  ('e1280000-0000-4000-8000-000000000001', tests.uid('m1'), 'going', now()),
  ('e1280000-0000-4000-8000-000000000001', tests.uid('m2'), 'going', now());

-- =====================================================================
-- community_search: every slot populated while every module is on
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'events'), 1,
  'community_search: the events slot carries the event while events is on');
select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'challenges'), 1,
  'community_search: the challenges slot carries the challenge while challenges is on');
select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'members'), 1,
  'community_search: the members slot carries the member');

select tests.clear_auth();

-- =====================================================================
-- events off: the events slot empties, the other two do not
-- =====================================================================
update public.club_features set enabled = false where module_key = 'events';
select tests.set_auth(tests.uid('m1'));

select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'events'), 0,
  'community_search: the events slot is empty once events is off');
select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'members'), 1,
  'community_search: SEARCH IS NOT EMPTIED - members still returned with events off');
select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'challenges'), 1,
  'community_search: the challenges slot is untouched by the events switch');

select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'events';

-- =====================================================================
-- challenges off: the twin, which the earlier note did not name
-- =====================================================================
update public.club_features set enabled = false where module_key = 'challenges';
select tests.set_auth(tests.uid('m1'));

select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'challenges'), 0,
  'community_search: the challenges slot is empty once challenges is off');
select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'members'), 1,
  'community_search: members still returned with challenges off');
select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'events'), 1,
  'community_search: the events slot is untouched by the challenges switch');

select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'challenges';

-- =====================================================================
-- Both off: search still answers. The whole-function gate 202609230003
-- rejected would have returned nothing here.
-- =====================================================================
update public.club_features set enabled = false where module_key in ('events', 'challenges');
select tests.set_auth(tests.uid('m1'));

select is(
  jsonb_array_length(public.community_search('Zebra', 10) -> 'members'), 1,
  'community_search: with BOTH modules off a member search still finds people');

select tests.clear_auth();
update public.club_features set enabled = true where module_key in ('events', 'challenges');

-- =====================================================================
-- people_suggestions: the signal falls to zero, the candidate survives
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select ok(
  (select (s -> 'signals' -> 'shared_events')::int > 0
     from public.people_suggestions(10) s
    where (s ->> 'user_id') = tests.uid('m2')::text),
  'people_suggestions: shared_events is non-zero while events is on');
select ok(
  (select (s -> 'signals' -> 'shared_challenges')::int > 0
     from public.people_suggestions(10) s
    where (s ->> 'user_id') = tests.uid('m2')::text),
  'people_suggestions: shared_challenges is non-zero while challenges is on');

select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'events';
select tests.set_auth(tests.uid('m1'));

select is(
  (select (s -> 'signals' -> 'shared_events')::int
     from public.people_suggestions(10) s
    where (s ->> 'user_id') = tests.uid('m2')::text), 0,
  'people_suggestions: the event signal contributes zero once events is off');
select ok(
  (select count(*) > 0
     from public.people_suggestions(10) s
    where (s ->> 'user_id') = tests.uid('m2')::text),
  'people_suggestions: THE CANDIDATE SURVIVES - the challenge signal still carries them');

select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'events';

-- =====================================================================
-- Both signals off: the member is no longer suggested BY THESE SIGNALS,
-- and the function still returns cleanly rather than raising.
-- =====================================================================
update public.club_features set enabled = false where module_key in ('events', 'challenges');
select tests.set_auth(tests.uid('m1'));

select lives_ok($$ select public.people_suggestions(10) $$,
  'people_suggestions: still callable with both modules off, never raises');
select is(
  coalesce((select (s -> 'signals' -> 'shared_events')::int + (s -> 'signals' -> 'shared_challenges')::int
     from public.people_suggestions(10) s
    where (s ->> 'user_id') = tests.uid('m2')::text), 0), 0,
  'people_suggestions: neither gated signal contributes with both modules off');

select tests.clear_auth();
update public.club_features set enabled = true where module_key in ('events', 'challenges');

select * from finish();
rollback;
