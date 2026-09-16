-- 202609160005. The head coach may remove a member, and only downward.
--
-- WHAT THIS FILE IS DEFENDING. Widening admin_remove_member() from a
-- hardcoded is_admin() to a permission is the kind of change that reads as
-- a small convenience and is actually a privilege boundary: removal is a
-- soft delete of a profile plus every post its author wrote, so "who may
-- remove whom" is the whole security content of the feature. The rank guard
-- is what makes the widening safe, and a rank guard is exactly the sort of
-- rule that survives review and then quietly stops holding - so each
-- direction across the boundary is asserted here rather than reasoned about:
--   1. A head coach reaches strictly BELOW their own rank (member, coach).
--   2. A head coach does NOT reach their own rank or above (another head
--      coach, an admin, the owner) - the escalation-by-deletion this test
--      exists for.
--   3. Someone without the permission at all is refused before rank is even
--      considered.
--   4. Self-removal keeps its own separate refusal and is checked FIRST,
--      because "you outrank yourself" is false and the rank message would
--      be the wrong answer.
--   5. The side effects the audit trail depends on still happen.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ---------------------------------------------------------------------
-- Fixtures this file adds on top of rls_helpers': a head coach, a second
-- head coach for the equal-rank case, and disposable targets so no two
-- destructive assertions share a row.
-- ---------------------------------------------------------------------
-- tests.uid() is a fixed lookup of the seven nicknames rls_helpers.sql
-- itself creates, so these three carry literal ids. profiles.id references
-- auth.users, which is why each gets an auth row first - the same order
-- rls_helpers uses for its own fixtures.
select tests.clear_auth();

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'hc1@members.haimuniya.invalid',    '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'hc2@members.haimuniya.invalid',    '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'victim@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, handle, display_name, recovery_verified_at)
values
  ('eeeeeeee-0000-4000-8000-000000000001', 'head_a',   'Head Coach A', now()),
  ('eeeeeeee-0000-4000-8000-000000000002', 'head_b',   'Head Coach B', now()),
  ('eeeeeeee-0000-4000-8000-000000000003', 'victim_x', 'Victim',       now())
on conflict (id) do nothing;

insert into public.invite_redemptions (user_id, invite_id, role)
values
  ('eeeeeeee-0000-4000-8000-000000000001', '11111111-2222-4333-8444-555555555555', 'head_coach'),
  ('eeeeeeee-0000-4000-8000-000000000002', '11111111-2222-4333-8444-555555555555', 'head_coach'),
  ('eeeeeeee-0000-4000-8000-000000000003', '11111111-2222-4333-8444-555555555555', 'member')
on conflict (user_id) do nothing;

-- =====================================================================
-- 0. The grant itself. A permission nobody holds is a feature nobody has.
-- =====================================================================
select is(
  (select count(*)::int from public.role_permissions
   where permission_code = 'community.member.remove'
     and role_code in ('head_coach', 'admin', 'owner')),
  3,
  'community.member.remove is granted to head_coach, admin and owner - and to nobody else below them');

select is(
  (select count(*)::int from public.role_permissions
   where permission_code = 'community.member.remove'
     and role_code in ('member', 'coach', 'staff')),
  0,
  'a plain coach is deliberately NOT given it: adding members is theirs, removing them is not');

-- =====================================================================
-- 1. member_role_rank() reads the same rank my_role_code() would
-- =====================================================================
select is(public.member_role_rank(tests.uid('m1')),    10::smallint, 'a member ranks 10');
select is(public.member_role_rank(tests.uid('coach')), 20::smallint, 'a coach ranks 20');
select is(public.member_role_rank('eeeeeeee-0000-4000-8000-000000000001'::uuid),   30::smallint, 'a head coach ranks 30');
select is(public.member_role_rank(tests.uid('owner')), 60::smallint, 'the owner ranks 60');
select is(
  public.member_role_rank(tests.uid('admin')), 50::smallint,
  'the legacy is_admin flag outranks the member redemption on the same row, exactly as my_role_code() resolves it');
select is(
  public.member_role_rank('99999999-9999-4999-8999-999999999999'::uuid), null,
  'an id with neither a redemption nor the admin flag has no rank at all - and the caller refuses rather than treating that as zero');

-- =====================================================================
-- 2. DOWNWARD: a head coach removes a member, with every side effect
-- =====================================================================
select tests.set_auth('eeeeeeee-0000-4000-8000-000000000001'::uuid);

select lives_ok(
  $$ select public.admin_remove_member('eeeeeeee-0000-4000-8000-000000000003'::uuid) $$,
  'a head coach removes a plain member - the whole point of 202609160005');

select tests.clear_auth();

select isnt(
  (select deleted_at from public.profiles where id = 'eeeeeeee-0000-4000-8000-000000000003'::uuid), null,
  'the profile is soft deleted immediately, not merely queued');

select is(
  (select count(*)::int from public.account_deletion_requests where user_id = 'eeeeeeee-0000-4000-8000-000000000003'::uuid), 1,
  'and the 30-day purge is scheduled, the same one request_account_deletion() would have created');

select ok(
  (select purge_after > now() + interval '29 days'
     from public.account_deletion_requests where user_id = 'eeeeeeee-0000-4000-8000-000000000003'::uuid),
  'the purge really is ~30 days out, not now()');

select is(
  (select count(*)::int from public.admin_actions
   where action_type = 'member_remove' and target_user_id = 'eeeeeeee-0000-4000-8000-000000000003'::uuid
     and admin_id = 'eeeeeeee-0000-4000-8000-000000000001'::uuid),
  1,
  'exactly one audit row, attributed to the head coach who did it - a widened gate must not widen into an unlogged path');

-- A coach is below a head coach too, so this direction is open as well.
select tests.set_auth('eeeeeeee-0000-4000-8000-000000000001'::uuid);
select lives_ok(
  $$ select public.admin_remove_member(tests.uid('coach')) $$,
  'rank 20 is below rank 30, so a head coach reaches a coach');

-- =====================================================================
-- 3. NOT UPWARD, and not sideways. The escalation this guard exists for.
-- =====================================================================
select throws_ok(
  $$ select public.admin_remove_member('eeeeeeee-0000-4000-8000-000000000002'::uuid) $$,
  'cannot remove a member at or above your own role',
  'an EQUAL rank is refused - ">=" and not ">", so two head coaches cannot delete each other');

select throws_ok(
  $$ select public.admin_remove_member(tests.uid('admin')) $$,
  'cannot remove a member at or above your own role',
  'a head coach cannot remove an admin');

select throws_ok(
  $$ select public.admin_remove_member(tests.uid('owner')) $$,
  'cannot remove a member at or above your own role',
  'and certainly not the owner - privilege escalation by deletion is the failure this whole guard is for');

select throws_ok(
  $$ select public.admin_remove_member('99999999-9999-4999-8999-999999999999'::uuid) $$,
  'cannot remove a member at or above your own role',
  'an unplaceable target is refused rather than treated as the lowest rank');

-- =====================================================================
-- 4. Self-removal still has its own answer, checked BEFORE rank
-- =====================================================================
select throws_ok(
  $$ select public.admin_remove_member('eeeeeeee-0000-4000-8000-000000000001'::uuid) $$,
  'use account deletion for your own account',
  'removing yourself gets the account-deletion message, not the rank one - you do not outrank yourself and that would be the wrong sentence');

-- =====================================================================
-- 5. Without the permission, rank never even comes up
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.admin_remove_member(tests.uid('m3')) $$,
  'not authorized',
  'a plain member is refused at the permission check, not the rank check');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_remove_member(tests.uid('m3')) $$,
  'not authorized',
  'and so is another member - community.member.remove starts at head_coach');

-- =====================================================================
-- 6. The admin ceiling. An admin is not the owner.
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.admin_remove_member(tests.uid('owner')) $$,
  'cannot remove a member at or above your own role',
  'an admin (50) cannot remove the owner (60) - the widening tightened this direction, which used to be allowed');

select lives_ok(
  $$ select public.admin_remove_member(tests.uid('m3')) $$,
  'but an admin still removes a member exactly as before');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_remove_member(tests.uid('admin')) $$,
  'and the owner, alone, reaches an admin');

select * from finish();
rollback;
