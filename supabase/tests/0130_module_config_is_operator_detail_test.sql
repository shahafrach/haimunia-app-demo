-- N2 (202609230007). A module's config is operator detail.
--
-- The defect was a COLUMN privilege, not a row policy, so the assertions that
-- matter are about what a member can SELECT through their own grant - not
-- about what a function chooses to return. A test that only called the new
-- reader would pass even if the column were still world-readable, which is the
-- whole bug.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- A real threshold to hunt for, on a module that seeds a row.
update public.club_features
   set config = '{"low_attendance_min_sessions": 2, "no_contact_days": 30}'::jsonb
 where module_key = 'coach_tasks';

-- =====================================================================
-- The column privilege itself. This is the fix; everything else is shape.
-- =====================================================================
select ok(
  not has_column_privilege('authenticated', 'public.club_features', 'config', 'SELECT'),
  'authenticated has NO select privilege on club_features.config');
select ok(
  has_column_privilege('authenticated', 'public.club_features', 'enabled', 'SELECT'),
  'and still reads enabled, which every gated surface needs');
select ok(
  has_column_privilege('authenticated', 'public.club_features', 'module_key', 'SELECT'),
  'and module_key');

-- =====================================================================
-- A member reading the table directly gets the rows and not the column.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select lives_ok($$ select module_key, enabled from public.club_features $$,
  'a member still reads the rows - hiding them would make club_feature_enabled() fall back to ON');
select throws_ok($$ select config from public.club_features $$,
  '42501', null,
  'and is refused the config column outright');

-- The reader masks rather than refuses, so a member gets the same SHAPE.
select is(
  (select config from public.club_features_for_caller() where module_key = 'coach_tasks'),
  '{}'::jsonb,
  'club_features_for_caller: a member sees an empty config, not null and not the thresholds');
select isnt(
  (select enabled::text from public.club_features_for_caller() where module_key = 'coach_tasks'),
  null,
  'and still sees whether the module is on, which is what they came for');

select tests.clear_auth();

-- =====================================================================
-- A coach IS the audience for a coach-task threshold. is_staff() is rank >= 20.
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select is(
  (select config ->> 'low_attendance_min_sessions'
     from public.club_features_for_caller() where module_key = 'coach_tasks'),
  '2',
  'a coach reads the threshold they are being measured against');
select tests.clear_auth();

-- =====================================================================
-- THE PART THAT WOULD ROT SILENTLY: club_feature_enabled() is definer and must
-- not have been caught by the revoke. If it had been, switching a module off
-- would start RAISING inside every gated policy instead of gating - and the
-- failure would look like an unrelated permission error somewhere far away.
-- =====================================================================
-- Switches are flipped as the bootstrap superuser: a member has no UPDATE on
-- this table and never did, and the first version of this test flipped one
-- while still authenticated as m1 - a permission error that looked like the
-- revoke had gone too far when it was the fixture's own fault.
update public.club_features set enabled = false where module_key = 'events';
select tests.set_auth(tests.uid('m1'));
select is(public.club_feature_enabled('events'), false,
  'club_feature_enabled still reads the table as owner with the module off');
-- The sub-key form reads config, which is exactly the revoked column.
select lives_ok($$ select public.club_feature_enabled('coach_tasks', 'some_sub_key') $$,
  'and its sub-key form still reads config through definer rights');
select tests.clear_auth();

update public.club_features set enabled = true where module_key = 'events';
select tests.set_auth(tests.uid('m1'));
select is(public.club_feature_enabled('events'), true,
  'and with it on again');
select tests.clear_auth();

-- =====================================================================
-- And the admin writer is untouched: it is definer too, and an admin editing a
-- threshold is the reason the column exists at all.
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_set_club_feature('coach_tasks', true, '{"no_contact_days": 21}'::jsonb) $$,
  'an admin still writes config through admin_set_club_feature');
select is(
  (select config ->> 'no_contact_days' from public.club_features_for_caller() where module_key = 'coach_tasks'),
  '21',
  'and reads back what they wrote');
select tests.clear_auth();

-- =====================================================================
-- anon gets nothing, as it does everywhere else.
-- =====================================================================
select ok(
  not has_function_privilege('anon', 'public.club_features_for_caller()', 'EXECUTE'),
  'anon cannot call the reader');

select * from finish();
rollback;
