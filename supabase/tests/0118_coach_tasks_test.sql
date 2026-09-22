-- 202609220002, part 1. The five coach-task rules, the close rule, and who
-- may read or close one.
--
-- WHAT THIS FILE IS DEFENDING. coach_tasks is the first surface in this app
-- that tells a coach, by name, which members to chase - so two properties
-- matter more than the arithmetic:
--
--   1. A MEMBER MUST NEVER READ ONE. There is no member-facing policy, and
--      "there is no policy" is exactly the kind of thing that survives until
--      somebody adds one for a good-looking reason. Asserted directly, for a
--      member reading their own tasks, in section 6.
--   2. THE THRESHOLDS REALLY DO COME FROM club_features.config. A feature
--      whose numbers are advertised as editable and are in fact hard-coded is
--      worse than one that never claimed it, so section 5 moves a threshold
--      and watches the rule move with it - and feeds it garbage and watches
--      it fall back rather than raise.
--
-- TIME IS MOVED BY AGEING invite_redemptions.redeemed_at AND
-- attendance_log.recorded_at, never by waiting. Every rule is stated as
-- "joined_at + N <= now()", so ageing the join stamp is indistinguishable
-- from time passing and is the only input under a test's control.
--
-- THE FIXTURE'S MEMBER SET IS FOUR: m1, m2, m3 and norec. coach, admin and
-- owner are excluded by coach_task_members()' own role filter, which is the
-- twin of coach_new_members()' and is asserted as such in section 7.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ===========================================================================
-- Fixtures
-- ===========================================================================
-- The module arrives OFF from 202609190002. Section 1 uses that before
-- anything turns it on, which is the only chance this file gets to assert
-- the off state against a database that has never had it on.
select is(
  (select cf.enabled from public.club_features cf where cf.module_key = 'coach_tasks'),
  false,
  '202609190002 seeded coach_tasks off, and this migration did not quietly turn it on');

-- ===========================================================================
-- 1. Switched off, nothing happens at all
-- ===========================================================================
select tests.clear_auth();
-- m1 joined 40 days ago and nobody has ever spoken to them: rules 1, 4 (no,
-- day 60 not reached) and 5 would all have something to say if the module
-- were on.
update public.invite_redemptions set redeemed_at = now() - interval '40 days' where user_id = tests.uid('m1');
select is(public.coach_tasks_sync(), 0, 'with the module off, a sync opens nothing');
select is((select count(*)::int from public.coach_tasks), 0, 'and the table stays empty');

select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.coach_tasks_refresh()),
  0,
  'and a coach asking for the list gets nothing rather than an error - an admin switching a module off mid-shift must not turn the open tab into a toast');

-- Switch it on for everything below.
select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'coach_tasks';

-- ===========================================================================
-- 1b. Switching it on does not open a task for every member at once
-- ===========================================================================
-- THE FAILURE THIS PREVENTS. member_contact_log is empty on a club that has
-- never had a reason to fill it, so an unfloored no_contact_30 opens a task
-- for very nearly every member the moment the switch is flipped - two hundred
-- names on day one, which is a wall rather than a work queue, and a coach
-- handed that closes the tab. The rule therefore counts the quiet period from
-- the LATER of the member's own clock and the day the module was switched on.
--
-- m1 is the proof: they joined 40 days ago and nobody has ever spoken to
-- them, so by their own clock they are ten days past the threshold - and by
-- the club's they are zero days past it, because the switch was flipped one
-- statement ago.
select isnt(public.club_feature_enabled_at('coach_tasks'), null,
  'switching a module on records the day it was switched on, in the module''s own config');
select ok(public.club_feature_enabled_at('coach_tasks') >= now() - interval '1 minute',
  'and the stamp is the moment it was switched on, not some other time');

select is(public.coach_tasks_sync() > 0, true,
  'the sync does open the onboarding tasks m1 is due - the floor is on rule 5 alone, not on the whole feature');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'no_contact_30'),
  0,
  'NOBODY gets a no-contact task on the day the switch is flipped, however long they have been ignored');

-- THE BOUNDARY, FROM BOTH SIDES, because "counted from the switch" has two
-- ways to be wrong a single-sided test cannot tell apart: a floor that never
-- lifts, and an off-by-one that lifts a day early. Ageing the stamp is
-- indistinguishable from waiting and is the only input under a test's
-- control.
create function pg_temp.age_enabled_at(p_age interval) returns void
language sql as $$
  update public.club_features
     set config = jsonb_set(config, '{enabled_at}',
                            to_jsonb(to_char(now() - p_age, 'YYYY-MM-DD"T"HH24:MI:SSOF')))
   where module_key = 'coach_tasks';
$$;

select pg_temp.age_enabled_at(interval '29 days');
select is(public.coach_tasks_sync() >= 0, true, 'sync at 29 days since the switch');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'no_contact_30'),
  0, 'twenty-nine days after the switch, still nothing');

select pg_temp.age_enabled_at(interval '31 days');
select is(public.coach_tasks_sync() > 0, true, 'sync at 31 days since the switch');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'no_contact_30' and user_id = tests.uid('m1')),
  1, 'thirty-one days after the switch, the member nobody has spoken to appears - deferred, never dropped');
select is(
  (select (detail ->> 'counted_from')::timestamptz from public.coach_tasks
    where rule_key = 'no_contact_30' and user_id = tests.uid('m1')),
  public.club_feature_enabled_at('coach_tasks'),
  'and the row says on its face that it was counted from the switch, not from a contact nobody remembers making');

-- A config write that is NOT a toggle must not move the stamp, or every
-- threshold edit would restart the quiet period for the whole club.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('coach_tasks', true, '{"checkin_day": 45}'::jsonb) $$,
  'an admin edits a threshold while the module is already on');
select tests.clear_auth();
select ok(public.club_feature_enabled_at('coach_tasks') <= now() - interval '30 days',
  'editing a threshold leaves the enable date exactly where it was');

-- AND THE OTHER HALF: a call that says nothing about the config must not
-- erase it. admin_set_club_feature() wrote coalesce(p_config, '{}') into the
-- row while its own admin_actions entry recorded coalesce(p_config,
-- v_before.config) - the function disagreed with its own audit trail from the
-- day it shipped (202609010012), and it never mattered while every config was
-- empty. It matters now: the panel's switch calls this with two arguments, so
-- toggling coach_tasks off and on again would have erased every threshold the
-- club had set and the enable stamp with them. 0055 owns this function; this
-- assertion is here because this is the feature that made it load-bearing.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('coach_tasks', true) $$,
  'an admin toggles the module with no config argument at all');
select tests.clear_auth();
select is(
  (select (cf.config ->> 'checkin_day')::int from public.club_features cf where cf.module_key = 'coach_tasks'),
  45, 'the thresholds survive a toggle that said nothing about them');
select isnt(public.club_feature_enabled_at('coach_tasks'), null,
  'and so does the enable stamp');
-- An empty object IS a request to clear the thresholds - and it still cannot
-- take the enable stamp with them. `enabled_at` is a record of something the
-- club did, not a setting somebody chose, and the trigger carries it forward
-- across every write that is not a fresh enable. Without that, clearing the
-- numbers would remove rule 5's floor through a button that says "save", and
-- the next sync would open a task for every member of the club.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('coach_tasks', true, '{}'::jsonb) $$,
  'an admin clears the thresholds explicitly');
select tests.clear_auth();
select is(
  (select cf.config - 'enabled_at' from public.club_features cf where cf.module_key = 'coach_tasks'),
  '{}'::jsonb, 'every threshold is gone - an explicit empty object really does clear');
select isnt(public.club_feature_enabled_at('coach_tasks'), null,
  'and the enable stamp is NOT gone - no client can delete it, because no client wrote it');

-- Fixture reset for everything below: the rule-5 rows opened above belong to
-- this section's clock, and the sections that follow are about the MEMBER's.
-- The stamp goes back far enough to floor nothing, which is the state a club
-- that has been running the module for a while is actually in.
delete from public.coach_tasks;
select pg_temp.age_enabled_at(interval '400 days');

-- ===========================================================================
-- 2. The five rules
-- ===========================================================================
-- m1: joined 40 days ago, never trained, never contacted, assigned to coach.
-- m2: joined 25 days ago, ONE training day inside the first 21.
-- m3: joined 65 days ago, TWO training days inside the first 21, contacted
--     5 days ago.
-- norec: joined 400 days ago, contacted 40 days ago - outside every
--     onboarding rule's window and inside rule 5's.
update public.profiles set assigned_coach_id = tests.uid('coach') where id = tests.uid('m1');
update public.invite_redemptions set redeemed_at = now() - interval '25 days'  where user_id = tests.uid('m2');
update public.invite_redemptions set redeemed_at = now() - interval '65 days'  where user_id = tests.uid('m3');
update public.invite_redemptions set redeemed_at = now() - interval '400 days' where user_id = tests.uid('norec');

insert into public.attendance_log (user_id, occurred_on, recorded_at)
values
  (tests.uid('m2'), (now() - interval '20 days')::date, now() - interval '20 days'),
  (tests.uid('m3'), (now() - interval '64 days')::date, now() - interval '64 days'),
  (tests.uid('m3'), (now() - interval '50 days')::date, now() - interval '50 days');

insert into public.member_contact_log (user_id, contacted_by, contacted_at, note)
values
  (tests.uid('m3'),    tests.uid('coach'), now() - interval '5 days',  'שיחה'),
  (tests.uid('norec'), tests.uid('coach'), now() - interval '40 days', 'שיחה');

select is(public.coach_tasks_sync() > 0, true, 'with the module on, the sync opens tasks');

-- ---- rule 1: welcome, in days 1..7, by a named coach -----------------------
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'welcome' and user_id = tests.uid('m1')),
  1, 'welcome: a member who joined 40 days ago has a welcome task - day 1 has passed');
select is(
  (select assigned_coach_id from public.coach_tasks where rule_key = 'welcome' and user_id = tests.uid('m1')),
  tests.uid('coach'),
  'welcome: and it carries the coach the member is assigned to - the rule asks for a NAMED coach');
select is(
  (select due_on from public.coach_tasks where rule_key = 'welcome' and user_id = tests.uid('m1')),
  (now() - interval '40 days' + interval '7 days')::date,
  'welcome: due on day 7, which is the "by day 7" half of the rule');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'welcome' and user_id = tests.uid('norec')),
  0, 'welcome: a member who joined 400 days ago is outside the 90-day onboarding window and gets none');

-- ---- rule 2: follow up after the first class ------------------------------
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'first_class_followup' and user_id = tests.uid('m2')),
  1, 'first class: a member who has trained once has a follow-up task');
select is(
  (select opened_at from public.coach_tasks where rule_key = 'first_class_followup' and user_id = tests.uid('m2')),
  (select min(recorded_at) from public.attendance_log where user_id = tests.uid('m2')),
  'first class: it opens at the FIRST attendance instant, not at the join - so a hello before the first session cannot close it');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'first_class_followup' and user_id = tests.uid('m1')),
  0, 'first class: a member who has never trained has no follow-up task, because there is nothing to follow up');

-- ---- rule 3: fewer than 2 attendances in the first 21 days ----------------
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'low_attendance' and user_id = tests.uid('m2')),
  1, 'low attendance: one training day inside the first 21 is fewer than two, so a personal contact task opens');
select is(
  (select (detail ->> 'sessions_in_window')::int from public.coach_tasks
    where rule_key = 'low_attendance' and user_id = tests.uid('m2')),
  1, 'low attendance: and the count that fired it is on the row, so a coach reading it later does not have to re-derive it');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'low_attendance' and user_id = tests.uid('m3')),
  0, 'low attendance: two training days inside the window is not fewer than two - the boundary is exclusive on the right member');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'low_attendance' and user_id = tests.uid('m1')),
  1, 'low attendance: a member who never trained at all is the clearest case of all');

-- ---- rule 4: check in at day 60 -------------------------------------------
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'day_60_checkin' and user_id = tests.uid('m3')),
  1, 'day 60: a member 65 days in has a check-in task');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'day_60_checkin' and user_id = tests.uid('m2')),
  0, 'day 60: a member 25 days in does not - the day has not arrived');

-- ---- rule 5: nobody has spoken to this member in 30 days ------------------
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'no_contact_30' and user_id = tests.uid('norec')),
  1, 'no contact: a member contacted 40 days ago is overdue, even though they joined 400 days ago - this rule is NOT scoped to onboarding');
select is(
  (select opened_at from public.coach_tasks where rule_key = 'no_contact_30' and user_id = tests.uid('norec')),
  (now() - interval '40 days' + interval '30 days'),
  'no contact: it opens thirty days after the LAST contact, not thirty days after the join');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'no_contact_30' and user_id = tests.uid('m3')),
  0, 'no contact: a member contacted 5 days ago is not overdue');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'no_contact_30' and user_id = tests.uid('m1')),
  1, 'no contact: a member nobody has EVER contacted counts from their join date, so they are not invisible for want of a contact row');

-- ---- nobody who is not a member gets a task ------------------------------
select is(
  (select count(*)::int from public.coach_tasks where user_id in (tests.uid('coach'), tests.uid('admin'), tests.uid('owner'))),
  0, 'no task is ever opened about a coach, an admin or the owner - the same mistake 202609160003 fixed in the welcome queue');

-- ===========================================================================
-- 3. The sync is idempotent
-- ===========================================================================
select is(public.coach_tasks_sync(), 0, 'a second sync over unchanged history opens nothing new');
select is(
  (select count(*)::int from public.coach_tasks),
  (select count(*)::int from public.coach_tasks),
  'sanity');
select is(public.coach_tasks_sync(), 0, 'and a third');

-- ===========================================================================
-- 4. A task closes when a contact exists after it opened
-- ===========================================================================
select is(
  (select closed_at from public.coach_tasks where rule_key = 'welcome' and user_id = tests.uid('m1')),
  null, 'm1 has never been contacted, so their welcome task is open');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.member_contact_log (user_id, note) values ('aaaaaaaa-0000-4000-8000-000000000001', 'התקשרתי') $$,
  'a coach logs a contact with m1, through the ordinary member_contact_log insert and no new RPC');
select tests.clear_auth();

select is(
  (select count(*)::int from public.coach_tasks where user_id = tests.uid('m1') and closed_at is null),
  0, 'every task open for m1 closed in the same transaction as the contact - the trigger, not the next sync');
select is(
  (select closed_by from public.coach_tasks where rule_key = 'welcome' and user_id = tests.uid('m1')),
  tests.uid('coach'),
  'and the close records WHO made contact, which is the audit a shared work queue exists for');

-- A contact does NOT close a task that opens later. m2's low_attendance task
-- opened at joined + 21 days, which is four days ago; a contact stamped six
-- days ago is before it.
insert into public.member_contact_log (user_id, contacted_by, contacted_at, note)
values (tests.uid('m2'), tests.uid('coach'), now() - interval '6 days', 'שיחה ישנה');
select is(
  (select closed_at from public.coach_tasks where rule_key = 'low_attendance' and user_id = tests.uid('m2')),
  null,
  'a contact stamped BEFORE a task opened does not close it - "after the task opened" is the whole rule');
select is(public.coach_tasks_sync() >= 0, true, 'and a sync does not close it either');
select is(
  (select closed_at from public.coach_tasks where rule_key = 'low_attendance' and user_id = tests.uid('m2')),
  null,
  'still open after the sync re-asserted the close rule over every open task');

-- ===========================================================================
-- 5. The thresholds really are in club_features.config
-- ===========================================================================
-- m2 is 25 days in and has no day-60 task. Move the threshold to day 10 and
-- the same member, the same history and the same sync produce one.
update public.club_features
   set config = '{"checkin_day": 10}'::jsonb
 where module_key = 'coach_tasks';
select is(public.coach_tasks_sync() > 0, true, 'moving checkin_day to 10 opens tasks the default never would have');
select is(
  (select count(*)::int from public.coach_tasks where rule_key = 'day_60_checkin' and user_id = tests.uid('m2')),
  1, 'the check-in rule fires at whatever day the club configured, not at a hard-coded 60');
select is(
  (select due_on from public.coach_tasks where rule_key = 'day_60_checkin' and user_id = tests.uid('m2')),
  (now() - interval '25 days' + interval '10 days')::date,
  'and the due date moved with it');

-- Garbage in the config falls back to the shipped default rather than
-- raising: the value is typed into an admin panel and a threshold reader
-- that throws would take the whole list down.
select is(public.club_feature_number('coach_tasks', 'checkin_day', 60, 1, 365), 10::numeric,
  'a number in the config is read');
update public.club_features set config = '{"checkin_day": "not a number"}'::jsonb where module_key = 'coach_tasks';
select is(public.club_feature_number('coach_tasks', 'checkin_day', 60, 1, 365), 60::numeric,
  'a non-numeric string falls back to the default');
update public.club_features set config = '{"checkin_day": null}'::jsonb where module_key = 'coach_tasks';
select is(public.club_feature_number('coach_tasks', 'checkin_day', 60, 1, 365), 60::numeric,
  'a json null falls back to the default');
update public.club_features set config = '{"checkin_day": {"day": 10}}'::jsonb where module_key = 'coach_tasks';
select is(public.club_feature_number('coach_tasks', 'checkin_day', 60, 1, 365), 60::numeric,
  'an object where a number was expected falls back to the default');
update public.club_features set config = '{"checkin_day": 99999}'::jsonb where module_key = 'coach_tasks';
select is(public.club_feature_number('coach_tasks', 'checkin_day', 60, 1, 365), 365::numeric,
  'and an absurd number is clamped rather than obeyed');
select is(public.club_feature_number('coach_tasks', 'never_set_by_anyone', 7, 1, 90), 7::numeric,
  'a key nobody has ever set reads as the default');
update public.club_features set config = '{}'::jsonb where module_key = 'coach_tasks';

-- ===========================================================================
-- 6. RLS: staff read and close, members never see them
-- ===========================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.coach_tasks),
  0,
  'A MEMBER READS NO COACH TASK AT ALL - not even the ones about themselves. There is no member-facing policy and there must never be one');
select is(
  (select count(*)::int from public.onboarding_challenge_offers),
  (select count(*)::int from public.onboarding_challenge_offers where user_id = tests.uid('m1')),
  'sanity: the offers table, by contrast, IS a member-facing row and is scoped to their own');
select throws_ok(
  $$ select * from public.coach_tasks_refresh() $$,
  'P0001', 'not authorized',
  'and the list function refuses a member outright rather than returning an empty list that reads like "no tasks"');

select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.coach_tasks) > 0,
  true, 'a coach reads the club''s tasks');
select is(
  (select count(*)::int from public.coach_tasks_refresh()) > 0,
  true, 'and the list function answers them');
select is(
  (select count(*)::int from public.coach_tasks_refresh(true, 100))
    >= (select count(*)::int from public.coach_tasks_refresh(false, 100)),
  true, 'p_include_closed widens the list rather than narrowing it');

-- Insert and delete are closed to everyone, staff included: the sync owns
-- the table. A coach who could mint a task could mint an excuse to contact
-- somebody.
select throws_ok(
  $$ insert into public.coach_tasks (user_id, rule_key, opened_at, due_on)
     values ('aaaaaaaa-0000-4000-8000-000000000002', 'welcome', now(), current_date) $$,
  '42501',
  null,
  'no client may insert a coach task, staff included - coach_tasks_sync() is the only writer');
select throws_ok(
  $$ delete from public.coach_tasks $$,
  '42501',
  null,
  'and none may delete one');

-- Closing by hand is allowed; editing under cover of closing is not.
select lives_ok(
  $$ update public.coach_tasks set closed_at = now()
      where rule_key = 'low_attendance' and user_id = 'aaaaaaaa-0000-4000-8000-000000000002' $$,
  'a coach closes a task by hand');
select is(
  (select closed_by from public.coach_tasks where rule_key = 'low_attendance' and user_id = tests.uid('m2')),
  tests.uid('coach'),
  'and closed_by is stamped by the server from auth.uid(), never taken from the request');
-- An UPDATE that clears closed_at on a row that is still OPEN. An already
-- closed row cannot be reached at all - the policy's USING clause requires
-- closed_at is null, so it is invisible to UPDATE and the statement matches
-- nothing - so this is the reachable half of "never reopened", and the
-- guard's own already-closed branch is defence behind a door that is shut.
-- norec's no_contact_30 task opened ten days ago and their only contact is
-- forty days old, so it is the one task still open at this point. Asserted
-- rather than assumed: a throws_ok against a statement that matches no row
-- passes for the wrong reason, silently, which is exactly what the first
-- draft of these two assertions did.
select is(
  (select count(*)::int from public.coach_tasks
    where user_id = 'aaaaaaaa-0000-4000-8000-00000000000e' and closed_at is null),
  1, 'norec has exactly one open task, so the two refusals below are really being tested against a row');
select throws_ok(
  $$ update public.coach_tasks set closed_at = null
      where user_id = 'aaaaaaaa-0000-4000-8000-00000000000e' and closed_at is null $$,
  'P0001', 'a coach task is closed, not reopened',
  'an update that leaves a task open is refused - the only legal move is open -> closed');
select throws_ok(
  $$ update public.coach_tasks set due_on = current_date + 30, closed_at = now()
      where user_id = 'aaaaaaaa-0000-4000-8000-00000000000e' and closed_at is null $$,
  'P0001', 'a coach task is closed, not edited',
  'and a close may not smuggle an edit of the rule, the member or the deadline alongside it');

select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.coach_tasks where closed_at is null),
  0,
  'a member still cannot even see an open task, let alone close one - the UPDATE policy cannot be reached without the SELECT');

-- ===========================================================================
-- 7. The twin
-- ===========================================================================
-- coach_task_members() restates coach_new_members()' role filter. The two
-- are asserted equal here rather than trusted, because a right line with one
-- missed copy is this codebase's characteristic defect and this is the copy.
-- The two cannot be compared in one query: coach_new_members() needs a staff
-- session and coach_task_members() is granted to no role at all (it is
-- internal, and the definer functions reach it with the owner's rights). So
-- the staff side is materialised first, then the comparison runs as the
-- bootstrap superuser.
select tests.set_auth(tests.uid('coach'));
create temp table twin_welcome_queue as select user_id from public.coach_new_members(3650);
select tests.clear_auth();
-- Windowed to 365 days on this side, because coach_new_members() clamps its
-- own p_within_days to 365 and the fixture deliberately holds a member who
-- joined 400 days ago (norec, for rule 5). The ROLE filter is what is being
-- compared here, not the lookback.
select set_eq(
  $$ select user_id from public.coach_task_members() where joined_at >= now() - interval '365 days' $$,
  $$ select user_id from twin_welcome_queue $$,
  'coach_task_members() and coach_new_members() agree on exactly who is a member - if this fails, one of the two role filters has been edited and the other has not');

-- ===========================================================================
-- 8. Switching the module back off hides everything again
-- ===========================================================================
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'coach_tasks';
select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.coach_tasks),
  0,
  'with the module off a coach reads nothing - the gate is in the RLS policy, which is what makes this key server-enforced rather than a screen hide');
select is(
  (select count(*)::int from public.coach_tasks_refresh()),
  0, 'and the list is empty rather than an error');
select tests.clear_auth();
select is(public.coach_tasks_sync(), 0, 'and the sync opens nothing while it is off');

-- ===========================================================================
-- 9. Switching it off and on again restarts the quiet period
-- ===========================================================================
-- The same answer as the first enable, for the same reason: the rule is about
-- what the club has had the chance to act on, and a club that turned the
-- module off was not acting on it. Tasks already opened are rows and stay
-- open; only new firings move.
select ok(public.club_feature_enabled_at('coach_tasks') <= now() - interval '300 days',
  'the stamp is still the old one while the module is off - disabling does not touch it');
update public.club_features set enabled = true where module_key = 'coach_tasks';
select ok(public.club_feature_enabled_at('coach_tasks') >= now() - interval '1 minute',
  're-enabling restamps, so the club gets its quiet period back');

select * from finish();
rollback;
