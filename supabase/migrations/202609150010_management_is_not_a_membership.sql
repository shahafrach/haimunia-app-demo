-- The management accounts are not members of the club, and must not be.
-- 2026-09-15, correcting 202609150009 the same day it landed:
--
--   "I want an sign in option only to admin and head coach - they are not
--    related to the actual user using app, it's different."
--
-- WHAT I GOT WRONG. 202609150009 found a real problem - the owner signed in
-- and was refused by every member-data policy, because is_community_member()
-- requires a redeemed invite and the admin account had none - and then fixed
-- it the wrong way round. It made the admin account a full member of the club
-- (role 'owner'), so that the member half of the app would work for it.
--
-- That treats management as a very senior MEMBERSHIP. It is not. It is a
-- separate login that has nothing to do with whoever is using the app on this
-- phone, which is the entire point of the two-client design (see
-- makeMgmtClient() in cloud.js): the owner trains on their own account and
-- administers with a different one, and those two facts are unrelated.
--
-- THE REAL FIX WAS ON THE CLIENT, not here. The management panels route
-- through renderManageApp/renderClubManageApp, independently of the Community
-- tab's own sign-in gate, and every RPC behind them is is_admin()/is_staff()
-- gated rather than is_community_member() gated. So management never needed a
-- membership at all - it needed the two hamburger rows to stop requiring a
-- member session before they would render, which is what locked the owner out
-- once the club was emptied. That is fixed in app.js's getNavItems().
--
-- SO THE REDEMPTION COMES BACK OFF. Removing it does not weaken the account:
-- is_admin() is `profiles.is_admin OR role_rank >= 50`, and this account has
-- the flag, which is why my_permissions() already returned all 13 permissions
-- for it BEFORE 202609150009 added the role. What changes is only that it is
-- no longer a member of the club it administers - which is the thing that was
-- asked for.
--
-- The head coach KEEPS its redemption. That is not an inconsistency: the
-- head_coach ROLE is carried by invite_redemptions.role and there is nowhere
-- else for it to live, so removing it would strip the only thing that gets
-- that account through its own panel's gate. The difference is real - one
-- account's authority comes from a flag, the other's from a role - and it
-- predates all of this.
do $$
declare
  v_admin uuid;
begin
  select id into v_admin from auth.users where email = 'haimuniya@gmail.com';
  if v_admin is null then
    raise notice 'management_is_not_a_membership: no admin account here, skipping';
    return;
  end if;

  delete from public.invite_redemptions where user_id = v_admin;
  delete from public.invites where id = 'aaaaaaaa-0915-4000-8000-000000000002'::uuid;

  -- The flag is what carries this account's authority now, so it had better
  -- still be set - otherwise this migration has just demoted the only admin.
  if not exists (select 1 from public.profiles where id = v_admin and is_admin and deleted_at is null) then
    raise exception 'management_is_not_a_membership: the admin account lost is_admin - refusing to leave the club with no administrator';
  end if;

  raise notice 'management_is_not_a_membership: % is an administrator, not a member', v_admin;
end $$;
