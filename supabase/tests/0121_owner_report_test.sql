-- 202609220004. The monthly owner report: who may read it, who may not, and
-- whether each number really is the length of the list behind it.
--
-- WHAT THIS FILE IS DEFENDING. Three properties, in order of how badly they
-- would hurt:
--
--   1. A COACH MAY NOT READ IT, and neither may a member. This is the first
--      surface in the app whose audience is head_coach-and-above rather than
--      is_staff(), so "a coach sees nothing" is a claim that has never been
--      true of anything here before and is one careless `or public.is_staff()`
--      away from stopping being true. Asserted for both roles, against the
--      table AND against the list RPC, in section 5.
--   2. THE NUMBER AND ITS LIST CANNOT DISAGREE. The whole point of the
--      feature is that each figure links to the people it is made of, and the
--      way that promise breaks is a figure computed one way and a list
--      computed another. Section 4 re-derives every one of the seven figures
--      from the list RPC a head coach actually calls.
--   3. THE MODULE KEY IS A SERVER GATE. 202609190002 seeded owner_report off
--      and said the branch that built the feature would decide whether its
--      gate was a screen hide or a real predicate. It is a real predicate, so
--      sections 1 and 7 assert that with the key off nothing is generated,
--      nothing is readable, and the list RPC is empty rather than angry.
--
-- TIME IS MOVED BY WRITING ROWS INTO LAST MONTH, never by waiting. Every
-- figure is scoped to a calendar month, so tests.rep_month() - the first of
-- the previous month, which is what a bare owner_report_generate() means -
-- is the only clock this file needs.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ===========================================================================
-- Fixtures
-- ===========================================================================
-- rls_helpers.sql has no head_coach - nothing before this file needed the
-- rank between coach and admin to be a different answer from either. It does
-- now, so this file adds one rather than widening a shared fixture every
-- other suite would then have to account for.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-000000000001'::uuid,
        'authenticated', 'authenticated', 'headcoach@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values ('eeeeeeee-0000-4000-8000-000000000001'::uuid, 'head_coach_x', 'Head Coach X', now())
on conflict (id) do nothing;
insert into public.invite_redemptions (user_id, invite_id, role)
values ('eeeeeeee-0000-4000-8000-000000000001'::uuid, '11111111-2222-4333-8444-555555555555', 'head_coach')
on conflict (user_id) do nothing;

create or replace function tests.hc() returns uuid language sql immutable as $fn$
  select 'eeeeeeee-0000-4000-8000-000000000001'::uuid
$fn$;
-- The month a bare owner_report_generate() means: the most recently completed
-- one. Stable, not immutable - it reads current_date.
create or replace function tests.rep_month() returns date language sql stable as $fn$
  select date_trunc('month', current_date - interval '1 month')::date
$fn$;
grant execute on function tests.hc() to anon, authenticated, service_role;
grant execute on function tests.rep_month() to anon, authenticated, service_role;

select tests.clear_auth();

-- ===========================================================================
-- 0. The shape IS the privacy guarantee
-- ===========================================================================
-- owner_reports holds counts and nothing else. Not because a head coach may
-- not see a name - they may, through owner_report_list() - but because a
-- STORED "members who stopped attending" list is a permanent record of a
-- judgement about a person, growing one row a month forever. The lists are
-- computed on demand; asserting the shape is what stops a later producer
-- writing one down.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'owner_reports'
      and (column_name = 'user_id' or data_type in ('jsonb', 'json', 'text', 'ARRAY'))),
  0,
  'owner_reports has no user_id, no jsonb and no text column - there is nowhere for a member name to be written even by a careless future producer');

select is(
  (select count(*)::int from public.club_features cf where cf.module_key = 'owner_report' and cf.enabled),
  0,
  '202609190002 seeded owner_report off, and this migration did not quietly turn it on');

-- ===========================================================================
-- 1. Switched off, nothing exists at all
-- ===========================================================================
select is(public.owner_report_generate(tests.rep_month()), null,
  'with the module off the generator returns null');
select is((select count(*)::int from public.owner_reports), 0,
  'and writes no row - a club that has not switched this on has no owner_reports rows, not merely unreadable ones');

-- And the job itself produces nothing either, which is the half that matters:
-- the trigger fires, the generator refuses, and the recap is unaffected.
select isnt(public.recap_monthly_generate(tests.rep_month()), null,
  'the monthly recap job still runs with owner_report off');
select is((select count(*)::int from public.owner_reports), 0,
  'and still writes no owner report');

-- ===========================================================================
-- 2. The month's data
-- ===========================================================================
update public.club_features set enabled = true where module_key = 'owner_report';

-- m1: a long-standing member who trained five days last month, carries two
--     coach tasks opened last month (one of them closed last month) and two
--     open engagement flags.
-- m2: joined on the first of last month and trained four days - the
--     strong-start threshold exactly.
-- m3: trained the month BEFORE last and not once last month. The one member
--     who stopped.
-- norec: joined last month and trained once. New, active, not a strong start.
-- coach/admin/owner/head_coach: no attendance at all, and their redemptions
--     are stamped now() by rls_helpers, so none of them is new either.
update public.invite_redemptions set redeemed_at = now() - interval '400 days' where user_id = tests.uid('m1');
update public.invite_redemptions set redeemed_at = tests.rep_month()::timestamptz where user_id = tests.uid('m2');
update public.invite_redemptions set redeemed_at = now() - interval '300 days' where user_id = tests.uid('m3');
update public.invite_redemptions set redeemed_at = (tests.rep_month() + 4)::timestamptz where user_id = tests.uid('norec');

insert into public.attendance_log (user_id, occurred_on) values
  (tests.uid('m1'), tests.rep_month() + 1),
  (tests.uid('m1'), tests.rep_month() + 2),
  (tests.uid('m1'), tests.rep_month() + 3),
  (tests.uid('m1'), tests.rep_month() + 4),
  (tests.uid('m1'), tests.rep_month() + 5),
  (tests.uid('m2'), tests.rep_month() + 0),
  (tests.uid('m2'), tests.rep_month() + 1),
  (tests.uid('m2'), tests.rep_month() + 2),
  (tests.uid('m2'), tests.rep_month() + 3),
  (tests.uid('norec'), tests.rep_month() + 6),
  (tests.uid('m3'), (tests.rep_month() - interval '1 month')::date + 3),
  (tests.uid('m3'), (tests.rep_month() - interval '1 month')::date + 4);

insert into public.coach_tasks (user_id, rule_key, opened_at, due_on, closed_at) values
  (tests.uid('m1'), 'welcome',              (tests.rep_month() + 2)::timestamptz, tests.rep_month() + 9,  (tests.rep_month() + 4)::timestamptz),
  (tests.uid('m1'), 'no_contact_30',        (tests.rep_month() + 8)::timestamptz, tests.rep_month() + 8,  null),
  (tests.uid('m2'), 'first_class_followup', (tests.rep_month() + 3)::timestamptz, tests.rep_month() + 6,  null);

insert into public.coach_engagement_flags (user_id, level, flagged_at, status) values
  (tests.uid('m1'), 'mild',        now() - interval '20 days', 'open'),
  (tests.uid('m1'), 'significant', now() - interval '3 days',  'open'),
  (tests.uid('m3'), 'inactive',    now() - interval '9 days',  'open'),
  (tests.uid('m2'), 'mild',        now() - interval '40 days', 'dismissed');

-- ===========================================================================
-- 3. The existing monthly recap job is what produces it
-- ===========================================================================
-- No call to owner_report_generate() here, deliberately. The report has to
-- arrive as a side effect of the job that already exists, or the feature is
-- something somebody has to remember to run.
select lives_ok($$select public.recap_monthly_generate(tests.rep_month())$$,
  'the monthly recap job runs');
select is((select count(*)::int from public.owner_reports), 1,
  'and the owner report for that month now exists, produced by the recap job rather than by a second scheduler');
select isnt(
  (select o.recap_id from public.owner_reports o where o.month_start = tests.rep_month()),
  null,
  'and it is keyed to the monthly_club_recaps row it was generated alongside');

select results_eq(
  $$select active_members, new_members, stopped_members, strong_start_members,
           coach_tasks_opened, coach_tasks_closed, at_risk_members
      from public.owner_reports where month_start = tests.rep_month()$$,
  $$values (3, 2, 1, 1, 3, 1, 2)$$,
  'the seven figures: 3 active (m1, m2, norec), 2 new (m2, norec), 1 stopped (m3), 1 strong start (m2 at exactly four), 3 tasks opened, 1 closed, 2 members currently flagged');

-- coach_tasks_opened is a count of TASKS and the list behind it is one row
-- per member, so the two are deliberately different numbers. Pinned here so
-- nobody "fixes" one into the other.
select is(
  (select count(*)::int from public.owner_report_members(tests.rep_month(), 'tasks_opened')),
  2,
  'three tasks opened, across two members - the figure is the sum and the list is the members, which is why the screen says both');

-- ===========================================================================
-- 4. Every number is the list behind it
-- ===========================================================================
select tests.set_auth(tests.hc());

select is((select count(*)::int from public.owner_report_list(tests.rep_month(), 'active', 500)),
  (select active_members from public.owner_reports where month_start = tests.rep_month()),
  'active: the list a head coach opens is exactly as long as the number they tapped');
select is((select count(*)::int from public.owner_report_list(tests.rep_month(), 'new', 500)),
  (select new_members from public.owner_reports where month_start = tests.rep_month()),
  'new members: same');
select is((select count(*)::int from public.owner_report_list(tests.rep_month(), 'stopped', 500)),
  (select stopped_members from public.owner_reports where month_start = tests.rep_month()),
  'stopped attending: same');
select is((select count(*)::int from public.owner_report_list(tests.rep_month(), 'strong_start', 500)),
  (select strong_start_members from public.owner_reports where month_start = tests.rep_month()),
  'strong start: same');
select is((select count(*)::int from public.owner_report_list(tests.rep_month(), 'at_risk', 500)),
  (select at_risk_members from public.owner_reports where month_start = tests.rep_month()),
  'currently at risk: same');
-- The two task metrics, whose figure is the SUM of the list rather than its
-- length - the one place where "the number is the list" needs stating
-- differently, and therefore the one place it could silently drift.
select is((select coalesce(sum(value), 0)::int from public.owner_report_list(tests.rep_month(), 'tasks_opened', 500)),
  (select coach_tasks_opened from public.owner_reports where month_start = tests.rep_month()),
  'tasks opened: the figure is the sum of the per-member counts in its own list');
select is((select coalesce(sum(value), 0)::int from public.owner_report_list(tests.rep_month(), 'tasks_closed', 500)),
  (select coach_tasks_closed from public.owner_reports where month_start = tests.rep_month()),
  'tasks closed: same');

-- The right people, not merely the right count.
select results_eq(
  $$select user_id from public.owner_report_list(tests.rep_month(), 'stopped', 500)$$,
  $$select tests.uid('m3')$$,
  'the one member who stopped attending is m3 - trained the month before, not once last month');
select is(
  (select value from public.owner_report_list(tests.rep_month(), 'strong_start', 500)),
  4,
  'and the strong-start list carries each member''s own session count, so a leader can see who cleared the bar by how much');

-- A metric name that is not one of the seven is a programming error, not an
-- empty list: an unknown metric that quietly returned nothing would render a
-- zero the club would read as a fact.
select throws_ok(
  $$select * from public.owner_report_list(tests.rep_month(), 'top_members', 500)$$,
  'P0001', 'unknown metric top_members',
  'an unknown metric is refused rather than answered with an empty list');

-- ===========================================================================
-- 5. Who may read it - the boundary this feature introduces
-- ===========================================================================
-- A COACH IS NOT A LEADER HERE. Every other staff surface in this app is
-- is_staff(), which is coach-and-above; this one is not, and that is the
-- assertion most likely to be undone by a well-meaning later edit.
select tests.set_auth(tests.uid('coach'));
select is((select count(*)::int from public.owner_reports), 0,
  'a COACH reads no owner report at all - the table policy is head_coach and above, not is_staff()');
select throws_ok(
  $$select * from public.owner_report_list(tests.rep_month(), 'stopped', 500)$$,
  'P0001', 'not authorized',
  'and the list RPC refuses them outright rather than returning an empty list they would read as good news');

select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.owner_reports), 0,
  'a member reads no owner report');
select throws_ok(
  $$select * from public.owner_report_list(tests.rep_month(), 'at_risk', 500)$$,
  'P0001', 'not authorized',
  'and cannot ask who is flagged at risk - least of all about themselves');

select tests.set_auth(tests.uid('m2'));
select is((select count(*)::int from public.owner_reports), 0,
  'and neither does the member the report counts as a new joiner');

select tests.set_auth(tests.hc());
select is((select count(*)::int from public.owner_reports), 1,
  'the head coach reads it');
select tests.set_auth(tests.uid('admin'));
select is((select count(*)::int from public.owner_reports), 1,
  'the admin reads it');
select tests.set_auth(tests.uid('owner'));
select is((select count(*)::int from public.owner_reports), 1,
  'and so does the owner, who outranks both');

-- Nobody writes it, at any rank. owner_report_generate() is the only writer.
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$update public.owner_reports set active_members = 999$$,
  '42501', null,
  'not even an admin may edit a figure - there is no update grant, and a report somebody can hand-edit is not a report');
select throws_ok(
  $$insert into public.owner_reports (month_start) values (date_trunc('month', current_date)::date)$$,
  '42501', null,
  'and nobody can hand-write a month into existence');

-- ===========================================================================
-- 6. The announcement
-- ===========================================================================
select tests.clear_auth();
select is(
  (select count(*)::int from public.notifications n where n.type = 'owner_report_ready'),
  3,
  'three accounts were told: the head coach, the admin and the owner');
select results_eq(
  $$select n.user_id from public.notifications n where n.type = 'owner_report_ready' order by n.user_id$$,
  $$select r from unnest(array[tests.uid('admin'), tests.hc(), tests.uid('owner')]) r order by r$$,
  'and they are exactly owner_report_recipients() - no coach and no member');

-- THE ONE THING A PUSH NOTIFICATION MUST NOT DO. It lands on a phone without
-- anyone opening the report, so it carries counts and never a name.
select is(
  (select count(*)::int from public.notifications n, public.profiles p
    where n.type = 'owner_report_ready'
      and p.handle is not null
      and (n.body like '%' || p.handle || '%' or n.body like '%' || coalesce(p.display_name, p.handle) || '%')),
  0,
  'and the body names no member - three integers, which is the whole of "no member data leaves the club" in the one place text about members is written for delivery');

select is(
  (select count(*)::int from public.owner_reports o where o.month_start = tests.rep_month() and o.notified_at is not null),
  1,
  'the row records that they were told');

-- Re-running the job refreshes the figures and does NOT re-announce.
select is(public.owner_report_generate(tests.rep_month()),
  (select id from public.owner_reports where month_start = tests.rep_month()),
  'a re-run returns the same row rather than making a second one');
select is(
  (select count(*)::int from public.notifications n where n.type = 'owner_report_ready'),
  3,
  'and sends nothing - a month gets one announcement however many times the recap job runs');

-- ===========================================================================
-- 6b. owner_report_recipients() and owner_report_viewer() are the same set
-- ===========================================================================
-- Two functions answering "who leads this club" from two directions - one
-- over the roster with no session, one about the caller. They are a twin, and
-- a twin that drifts here means either a leader who never hears about the
-- report or somebody notified about a screen they cannot open.
select tests.set_auth(tests.hc());        select ok(public.owner_report_viewer(),      'head coach: viewer');
select tests.set_auth(tests.uid('admin')); select ok(public.owner_report_viewer(),      'admin: viewer');
select tests.set_auth(tests.uid('owner')); select ok(public.owner_report_viewer(),      'owner: viewer');
select tests.set_auth(tests.uid('coach')); select ok(not public.owner_report_viewer(),  'coach: not a viewer');
select tests.set_auth(tests.uid('m1'));    select ok(not public.owner_report_viewer(),  'member: not a viewer');
select tests.clear_auth();
select results_eq(
  $$select * from public.owner_report_recipients() order by 1$$,
  $$select r from unnest(array[tests.uid('admin'), tests.hc(), tests.uid('owner')]) r order by r$$,
  'and the roster-side twin returns exactly the three accounts the caller-side one says yes to');

-- ===========================================================================
-- 7. Switching it back off
-- ===========================================================================
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'owner_report';

select tests.set_auth(tests.hc());
select is((select count(*)::int from public.owner_reports), 0,
  'with the module off even the head coach reads nothing - the gate is in the RLS policy, which is what makes this key server-enforced rather than a screen hide');
select is((select count(*)::int from public.owner_report_list(tests.rep_month(), 'active', 500)), 0,
  'and the list is EMPTY rather than an error: an admin switching a module off in one tab must not turn an open tab into a toast');

select tests.clear_auth();
select is(public.owner_report_generate(tests.rep_month()), null,
  'and the generator stops producing anything, so the row cannot silently go on being refreshed behind a closed door');

select * from finish();
rollback;
