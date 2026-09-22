-- 202609220006 hid too much, and this narrows it. Forward-only: that file is
-- applied, so the correction is a new migration rather than an edit to it.
--
-- WHAT WENT WRONG. 202609220006 defined a management account as
--
--     p.is_admin OR role_rank(<redeemed role>) >= role_rank('staff')
--
-- and public.roles ranks owner at 60, above staff at 40. The owner of this
-- club trains at this club. So did every head coach the moment anyone gave
-- one a rank above 40. The rule hid them from member search and from
-- people-you-may-know, which is the opposite of what the club wants: the
-- owner is the most recognisable person in the room.
--
-- It was caught by two pgTAP files that predate the rule and were left
-- alone on purpose - 0036's search fixture renames the 'owner' account to a
-- searchable handle and asserts a member finds it, and 0039 expects that
-- same account to carry a classmate signal. Both went red. The tests were
-- right and the predicate was wrong, so the predicate is what moved.
--
-- WHAT IS ACTUALLY BEING HIDDEN. One thing: the technical management login.
-- It is not a person in the room - it has a real email address rather than
-- the synthetic <name>@members.haimuniya.invalid every member gets, it never
-- redeemed an invite, and it holds no place in the club. Two shapes of it:
--
--   1. No invite_redemptions row at all. Never joined the club; it exists to
--      administer it. This is the technical account.
--   2. profiles.is_admin, with no CLUB role redeemed. The legacy flag, on an
--      account that also never took a place in the club.
--
-- An account that redeemed member, coach, head_coach or owner is a clubmate
-- and stays visible, is_admin or not. That is the whole change.
--
-- WHY A ROLE LIST AND NOT A RANK. Because owner (60) sits above staff (40),
-- no `>=` threshold can express "owner is a clubmate but staff is not" - the
-- ordering the ranks encode is authority, and this question is about
-- membership, which is a different axis. The four club roles are therefore
-- named. The failure direction is deliberate: a NEW club role added later
-- and not added here would be treated as management and hidden, which is
-- visible and gets reported, rather than a new management role silently
-- becoming searchable, which is the leak 202609220006 exists to prevent.
--
-- Nothing else moves. hide_management_from_member() is still the rule and
-- still carries the is_staff() exemption; management_user_ids(),
-- community_search() and people_suggestions() all read it and are untouched
-- here, so narrowing the subject narrows all three at once.
create or replace function public.is_management_account(p_uid uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select
       -- 1. never joined the club at all
       not exists (
         select 1 from public.invite_redemptions ir where ir.user_id = p.id
       )
       -- 2. the legacy admin flag, with no club role behind it
       or (
         p.is_admin
         and not exists (
           select 1 from public.invite_redemptions ir
           where ir.user_id = p.id
             and ir.role in ('member', 'coach', 'head_coach', 'owner')
         )
       )
     from public.profiles p
     where p.id = p_uid
       and p.deleted_at is null
    ), false);
$$;

comment on function public.is_management_account(uuid) is
  'True only for the technical management login: an account with no invite_redemptions row at all, or one carrying profiles.is_admin with no club role (member, coach, head_coach, owner) redeemed. Narrowed by 202609220007 from 202609220006''s rank-based test, which hid the owner and head coach because public.roles ranks owner (60) above staff (40) - membership and authority are different axes and a rank threshold cannot express this one. Coaches, head coaches and owners are clubmates and stay visible. Says nothing about who is asking - hide_management_from_member() is the rule; this is its subject.';
