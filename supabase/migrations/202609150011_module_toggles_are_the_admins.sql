-- A permission the head coach holds and can never be shown.
-- Live bug hunt, fresh round 1 (2026-09-15), reported by an agent that drove
-- the real club panel in Chromium and looked for the control the grant
-- implies. There isn't one, and there cannot be.
--
-- THE CONTRADICTION, and it is between two things I wrote the same day.
-- 202609150004 granted head_coach community.club.manage_modules, saying it
-- was so "the head-coach panel's controls are backed by real grants rather
-- than rendering and then failing". That was written while module toggles
-- were expected to live on the head coach's panel. Hours later the panel
-- split moved them, with renderManagePanel()'s own comment stating the
-- opposite conclusion: "Module toggles decide which FEATURES of the app exist
-- for this club - that is app administration, not club running, so it moves
-- to admin." The grant was never revisited.
--
-- IT IS NOT MERELY DEAD, WHICH IS WHY THIS IS A MIGRATION AND NOT A COMMENT.
-- admin_set_club_feature() gates on has_perm('community.club.manage_modules')
-- - not is_admin() - so a head coach can switch any module in this club on or
-- off right now with a direct RPC call. There is no screen that offers it and
-- nothing in the product suggests they can. A capability that exists only for
-- whoever thinks to call the API directly is the gap between what a system
-- claims and what it permits, and it is worth closing even when the holder is
-- trusted: the club's own head coach turning the feed off for everyone by
-- accident is a worse afternoon than asking an admin to do it on purpose.
--
-- REVOKED RATHER THAN GIVEN A SCREEN. Both were available. The owner's own
-- division is the tie-breaker - "head coach runs the club, admin runs the
-- app" - and which features EXIST for this club is the app. It also sits with
-- the things already settled as admin-only: the audit log, role changes,
-- password resets, bug triage. Moving the UI instead would have reopened a
-- split the owner has already looked at twice and confirmed.
--
-- The head coach keeps everything that is actually theirs: the roster,
-- invites and invite codes, moderation, restrictions, the club's analytics,
-- and the onboarding copy every new member reads.
delete from public.role_permissions
 where role_code = 'head_coach'
   and permission_code = 'community.club.manage_modules';

-- Belt and braces: an admin/owner must still hold it, or this has just made
-- the module toggles unreachable for everybody.
do $$
begin
  if not exists (
    select 1 from public.role_permissions
    where permission_code = 'community.club.manage_modules' and role_code in ('admin', 'owner')
  ) then
    raise exception 'module_toggles_are_the_admins: nobody can manage club modules any more';
  end if;
end $$;

comment on table public.role_permissions is
  'Role -> permission grants. Widened for head_coach in 202609150004 so the head-coach panel''s controls are backed by real grants rather than rendering and then failing: invites (member-role only - 202609030008''s coach-role narrowing is enforced inside invite_create, not here), analytics, and onboarding content. community.club.manage_modules was part of that widening and was taken back off in 202609150011: the panel split moved module toggles to the admin panel hours later, leaving head_coach with a permission no screen could ever exercise and a direct-RPC capability (admin_set_club_feature gates on the permission, not on is_admin()) that nothing in the product implied. There is no ''community.pins'' permission despite the name appearing in older prose - the real code is ''community.content.pin''. Role changes, password resets, the audit log and bug-report triage stay admin-only and are NOT permission-gated at all - each is a hardcoded is_admin() inside its own RPC, so they cannot be widened from this table.';
