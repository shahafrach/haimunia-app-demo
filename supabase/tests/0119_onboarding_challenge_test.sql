-- 202609220002, part 2. The 30-day onboarding challenge: who is offered it,
-- that nobody is ever enrolled without saying yes, where progress comes
-- from, what completion unlocks, and who may read an offer.
--
-- THE ONE PROPERTY THIS FILE EXISTS FOR is in section 3: a member who has
-- merely LOOKED at the offer has no challenge_participants row. "Never
-- enroll automatically" is the requirement, and the only way to test a
-- negative like that is to walk the whole read path and then assert the
-- absence. Section 7 tests the other half of it - that the schema itself
-- refuses a self-join, because the parent challenge is a draft.
--
-- WHY THE PARENT CHALLENGE IS A DRAFT, briefly, because it looks odd until
-- you know: it is a container, not a challenge the club is running, and
-- 'draft' is what keeps it out of club_summary()'s "the active challenge"
-- pick and out of chal_notify_ending_soon()'s walk. Asserted in section 7.
--
-- ATTENDANCE IS SYNCED THE WAY A REAL MEMBER SYNCS IT - a private_records
-- insert that attendance_log_from_record turns into an attendance day -
-- rather than by writing attendance_log directly. The requirement is
-- "progress comes from attendance_log, whatever its source", and a test that
-- wrote the destination table by hand would prove nothing about the chain.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ===========================================================================
-- Fixtures
-- ===========================================================================
select is(
  (select cf.enabled from public.club_features cf where cf.module_key = 'onboarding_challenge'),
  false,
  '202609190002 seeded onboarding_challenge off, and this migration did not quietly turn it on');

-- ===========================================================================
-- 1. Switched off, there is nothing to accept
-- ===========================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  public.onboarding_challenge_state() ->> 'state',
  'off',
  'with the module off the member is told so, rather than being shown an offer that would fail on tap');
select throws_ok(
  $$ select public.onboarding_challenge_respond(true) $$,
  'P0001', 'module disabled',
  'and accepting is refused outright');
select is(
  (select count(*)::int from public.onboarding_challenge_offers),
  0, 'no offer row is created while the module is off');

select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'onboarding_challenge';
-- m1 and m2 joined three days ago; m3 joined 200 days ago.
update public.invite_redemptions set redeemed_at = now() - interval '3 days'   where user_id in (tests.uid('m1'), tests.uid('m2'));
update public.invite_redemptions set redeemed_at = now() - interval '200 days' where user_id = tests.uid('m3');

-- ===========================================================================
-- 2. Who is offered it
-- ===========================================================================
select tests.set_auth(tests.uid('m1'));
select is(public.onboarding_challenge_state() ->> 'state', 'offered',
  'a member who joined three days ago is offered the challenge');
select is((public.onboarding_challenge_state() ->> 'goal_sessions')::int, 8,
  'with the shipped default goal of 8 sessions');
select is((public.onboarding_challenge_state() ->> 'window_days')::int, 30,
  'in a 30-day window');

select tests.set_auth(tests.uid('m2'));
select is(public.onboarding_challenge_state() ->> 'state', 'offered',
  'so is the other three-day-old member - the offer is made to each new member, not to one of them');

select tests.set_auth(tests.uid('m3'));
select is(public.onboarding_challenge_state() ->> 'state', 'none',
  'a member who joined 200 days ago is not offered a NEW member''s challenge');
select throws_ok(
  $$ select public.onboarding_challenge_respond(true) $$,
  'P0001', 'no open offer',
  'and cannot accept one they were never offered, even by calling the RPC directly');

select tests.set_auth(tests.uid('coach'));
select is(public.onboarding_challenge_state() ->> 'state', 'none',
  'a coach is not offered it either - same role filter the welcome queue uses');
select tests.set_auth(tests.uid('admin'));
select is(public.onboarding_challenge_state() ->> 'state', 'none',
  'nor is an admin');

-- ===========================================================================
-- 3. NOBODY IS ENROLLED BY LOOKING
-- ===========================================================================
select tests.clear_auth();
select is(
  (select count(*)::int from public.challenge_participants
    where challenge_id = public.onboarding_challenge_id()),
  0,
  'after every member above has READ their state, not one challenge_participants row exists - reading an offer is not accepting it');
select is(
  (select count(*)::int from public.onboarding_challenge_offers where response is not null),
  0, 'and no offer has been answered by anything other than a member');

-- ===========================================================================
-- 4. Decline
-- ===========================================================================
select tests.set_auth(tests.uid('m2'));
select is(public.onboarding_challenge_respond(false) ->> 'state', 'declined',
  'a member may decline');
select is(public.onboarding_challenge_state() ->> 'state', 'declined',
  'and the decline is remembered, so the app does not ask again forever');
select is(
  (select count(*)::int from public.challenge_participants
    where challenge_id = public.onboarding_challenge_id() and user_id = tests.uid('m2')),
  0, 'declining enrolls nobody');
select throws_ok(
  $$ select public.onboarding_challenge_respond(true) $$,
  'P0001', 'this offer was already answered',
  'and an answered offer cannot be answered again - a second tap is an error, not a silent overwrite of a decision');

-- ===========================================================================
-- 5. Accept, and the goal that is frozen when you do
-- ===========================================================================
select tests.clear_auth();
update public.club_features set config = '{"goal_sessions": 2}'::jsonb where module_key = 'onboarding_challenge';

select tests.set_auth(tests.uid('m1'));
select is((public.onboarding_challenge_state() ->> 'goal_sessions')::int, 2,
  'the goal offered is whatever the club has configured, not a hard-coded 8');
select is(public.onboarding_challenge_respond(true) ->> 'state', 'accepted',
  'the member accepts');
select is((public.onboarding_challenge_state() ->> 'progress')::int, 0,
  'with no progress yet');
-- Read as the superuser, not as m1: the container is a draft, so
-- challenge_participants_read (which requires the challenge to be visible)
-- hides a member's own participant row from them. That is by design and is
-- asserted as its own fact immediately below - everything the member's
-- screen shows comes from onboarding_challenge_state(), which is definer.
select is(
  (select count(*)::int from public.onboarding_challenge_offers where user_id = tests.uid('m1') and response = 'accepted'),
  1, 'the member''s own offer records the acceptance');
select tests.clear_auth();
select is(
  (select count(*)::int from public.challenge_participants
    where challenge_id = public.onboarding_challenge_id() and user_id = tests.uid('m1')),
  1, 'and THAT is what creates the one challenge_participants row in this whole feature');
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.challenge_participants
    where challenge_id = public.onboarding_challenge_id()),
  0, 'which the member themselves cannot read, because the container is a draft - their screen is fed by onboarding_challenge_state() alone');

-- The club retunes the goal upward. The member already running must not have
-- their goalposts moved.
select tests.clear_auth();
update public.club_features set config = '{"goal_sessions": 9}'::jsonb where module_key = 'onboarding_challenge';
select tests.set_auth(tests.uid('m1'));
select is((public.onboarding_challenge_state() ->> 'goal_sessions')::int, 2,
  'a member mid-challenge keeps the goal they accepted - the config change reaches the NEXT member, not this one');

-- ===========================================================================
-- 6. Progress comes from attendance_log, and completion unlocks a badge
-- ===========================================================================
-- Synced the way the real client syncs it: a private_records row that
-- attendance_log_from_record (202608310001) turns into an attendance day.
-- A day BEFORE the member accepted is outside their window and must not
-- count - otherwise a member could accept on day 29 and complete instantly.
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'wod_entry', 'w-old',
             jsonb_build_object('id','w-old','wodId','fran','date', to_char(current_date - 5, 'YYYY-MM-DD'),'scoreType','time','ts',1)) $$,
  'm1 syncs a session from five days ago - before they accepted');
select is(
  (select count(*)::int from public.attendance_log where user_id = tests.uid('m1')),
  1, 'it produces an attendance day, as it always did');
select is(
  (select count(*)::int from public.challenge_progress
    where challenge_id = public.onboarding_challenge_id() and user_id = tests.uid('m1')),
  0, 'but NO challenge progress - a day before the window opened is not inside it');
select is((public.onboarding_challenge_state() ->> 'progress')::int, 0,
  'and the member''s own progress still reads zero');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'wod_entry', 'w-1',
             jsonb_build_object('id','w-1','wodId','fran','date', to_char(current_date, 'YYYY-MM-DD'),'scoreType','time','ts',2)) $$,
  'm1 trains today');
select is((public.onboarding_challenge_state() ->> 'progress')::int, 1,
  'one day inside the window is one session of progress');
select tests.clear_auth();
select is(
  (select progress_value::int from public.challenge_participants
    where challenge_id = public.onboarding_challenge_id() and user_id = tests.uid('m1')),
  1, 'and it lands on the participant row through the ordinary challenge_progress_apply trigger, so every existing challenge surface keeps working');
select tests.set_auth(tests.uid('m1'));
select is(public.onboarding_challenge_state() ->> 'state', 'accepted',
  'one of two is not two, so the challenge is still running');
select is(
  (select count(*)::int from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
    where ma.user_id = tests.uid('m1') and d.code = 'onboarding_challenge_done'),
  0, 'and nothing is unlocked yet');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'strength_entry', 'e-2',
             jsonb_build_object('id','e-2','exerciseId','back-squat','date', to_char(current_date + 1, 'YYYY-MM-DD'),'type','reps','weight',100,'reps',5,'sets',3,'ts',3)) $$,
  'm1 trains again - the second day of the two they signed up for');
select is((public.onboarding_challenge_state() ->> 'state')::text, 'completed',
  'reaching the goal completes the challenge');
select isnt((public.onboarding_challenge_state() -> 'completed_at')::text, 'null',
  'and the completion is stamped on the offer');
select tests.clear_auth();
select is(
  (select status from public.challenge_participants
    where challenge_id = public.onboarding_challenge_id() and user_id = tests.uid('m1')),
  'completed',
  'the participant row moves to completed - the one status transition challenge_participants_guard_progress allows a member on their own row');
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
    where ma.user_id = tests.uid('m1') and d.code = 'onboarding_challenge_done'),
  1, 'and the achievement is unlocked');
select is(
  (select ma.verified from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
    where ma.user_id = tests.uid('m1') and d.code = 'onboarding_challenge_done'),
  true,
  'marked VERIFIED, because every step of it is server-derived: attendance_log days inside a window the server stamped, with no client claim anywhere - which is the bar 202609120001 set');

-- The definition itself, in the shape 0074 requires of every enabled row.
select tests.clear_auth();
select is(
  (select count(*)::int from public.achievement_definitions
    where code = 'onboarding_challenge_done' and enabled
      and category = 'challenge' and trigger_type = 'CHALLENGE_COMPLETED'
      and icon is not null and name ~ '[֐-׿]'),
  1, 'the definition is an ordinary enabled challenge-category row with a Hebrew name and an icon');
select is(
  (select count(*)::int from public.achievement_definitions
    where code = 'onboarding_challenge_done' and config ? 'client_claimable'),
  0, 'and it carries no client_claimable key at all, so ach_claim can never mint it');

-- A member with no accepted offer produces no progress at all.
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values ('aaaaaaaa-0000-4000-8000-000000000003', 'wod_entry', 'w-m3',
             jsonb_build_object('id','w-m3','wodId','grace','date', to_char(current_date, 'YYYY-MM-DD'),'scoreType','time','ts',1)) $$,
  'a member who was never offered the challenge still syncs training normally');
select tests.clear_auth();
select is(
  (select count(*)::int from public.challenge_progress
    where challenge_id = public.onboarding_challenge_id() and user_id = tests.uid('m3')),
  0, 'and writes no onboarding progress - the trigger is a no-op for anyone with no accepted offer');

-- ===========================================================================
-- 7. The parent challenge is a container, not a club challenge
-- ===========================================================================
select is(
  (select status from public.challenges where id = public.onboarding_challenge_id()),
  'draft',
  'the parent challenge is a draft: that is what keeps it out of club_summary()''s "the active challenge" pick and out of chal_notify_ending_soon()');
select is(
  (select challenge_type from public.challenges where id = public.onboarding_challenge_id()),
  'consistency',
  'and it is one of the six challenge types that already existed - no new type, no new table');

select tests.set_auth(tests.uid('m3'));
select is(
  (select count(*)::int from public.challenges where id = public.onboarding_challenge_id()),
  0, 'a member cannot read the container at all, so it never appears on their board');
select throws_ok(
  $$ insert into public.challenge_participants (challenge_id, user_id)
     values ('0b0a0d17-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000003') $$,
  '42501', null,
  'and cannot self-join it either - challenge_participants_join_self requires an ACTIVE challenge, so "never enroll automatically" is a schema property and not a client promise');
select throws_ok(
  $$ insert into public.challenge_progress (challenge_id, user_id, delta)
     values ('0b0a0d17-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000003', 50) $$,
  '42501', null,
  'nor hand-enter progress against it - progress is attendance or nothing');

-- ===========================================================================
-- 8. RLS on the offer
-- ===========================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.onboarding_challenge_offers),
  1, 'a member sees exactly one offer row: their own');
select is(
  (select user_id from public.onboarding_challenge_offers),
  tests.uid('m1'), 'and it is theirs');
select throws_ok(
  $$ insert into public.onboarding_challenge_offers (user_id) values ('aaaaaaaa-0000-4000-8000-000000000003') $$,
  '42501', null,
  'a member cannot create an offer for anybody, themselves included');
select throws_ok(
  $$ update public.onboarding_challenge_offers set response = 'accepted' $$,
  '42501', null,
  'nor edit one - which is what stops a decline being quietly rewritten into an acceptance');
select throws_ok(
  $$ delete from public.onboarding_challenge_offers $$,
  '42501', null,
  'nor delete one');

select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.onboarding_challenge_offers),
  2, 'a coach sees the club''s offers - who was asked and who said no is a coach''s question about their own club');

select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'onboarding_challenge';
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.onboarding_challenge_offers),
  0, 'and with the module switched off nobody reads an offer at all - the gate is in the policy, which is what makes this key server-enforced');
select is(public.onboarding_challenge_state() ->> 'state', 'off',
  'the state function agrees');

select tests.clear_auth();
select * from finish();
rollback;
