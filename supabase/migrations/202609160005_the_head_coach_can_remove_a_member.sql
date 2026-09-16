begin;

-- THE PERSON WHO ADDS MEMBERS IS THE PERSON WHO REMOVES THEM.
--
-- The head coach owns the door: 202609150004 gave them the invite surface
-- (community.member.invite, community.invite.manage_codes) and the panel
-- split made "הוספת חבר/ה" theirs alone - the admin panel does not even
-- render it (cloud.js:20047's isAdminMode branch). But removal stayed
-- behind admin_remove_member()'s hardcoded is_admin() check, so the one
-- role that actually manages the roster could add people and never take
-- them off it. Members leave clubs; that is ordinary, not exceptional, and
-- routing it through the app owner was a standing bottleneck rather than a
-- safety property.
--
-- WHY A RANK GUARD AND NOT JUST A PERMISSION. Widening the gate to a
-- permission alone would let a head coach (rank 30) remove an admin (50) or
-- the owner (60) - privilege escalation by deletion, and the exact reason
-- the is_admin() check was defensible in the first place. So the widening
-- comes with the constraint that makes it safe: you may only remove someone
-- BELOW your own rank. A head coach reaches members and coaches; another
-- head coach, staff, an admin and the owner are all out of reach. An admin
-- reaches everyone up to staff. Only the owner can remove an admin.
--
-- The rank compared is the same one my_role_code() computes - the higher of
-- the redeemed role and the legacy profiles.is_admin flag - so an is_admin
-- account cannot be demoted-by-omission into range by never having redeemed
-- an invite.
--
-- Self-removal keeps its own separate refusal (request_account_deletion()
-- is the path for your own account) and is checked before the rank guard,
-- because "you outrank yourself" is false and the generic message would be
-- wrong.

insert into public.permissions (code, description) values
  ('community.member.remove', 'Remove a member from the club, below your own role rank')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values
  ('head_coach', 'community.member.remove'),
  ('admin',      'community.member.remove'),
  ('owner',      'community.member.remove')
on conflict do nothing;

-- The rank of any member, by the same rule my_role_code() uses for the
-- caller. Returns null for an id with neither a redemption nor the admin
-- flag, and the caller below treats null as "not removable" rather than as
-- rank 0 - an unknown target is not a safe target.
create or replace function public.member_role_rank(p_user_id uuid) returns smallint
language sql stable security definer set search_path = '' as $$
  select max(r.rank)::smallint
  from public.roles r
  where r.code in (
    (select ir.role from public.invite_redemptions ir where ir.user_id = p_user_id),
    (select 'admin' from public.profiles p where p.id = p_user_id and p.is_admin)
  );
$$;
revoke all on function public.member_role_rank(uuid) from public, anon;
grant execute on function public.member_role_rank(uuid) to authenticated;

comment on function public.member_role_rank(uuid) is
  'The effective role rank of one member: the higher of their redeemed invite_redemptions.role and the legacy profiles.is_admin flag, matching my_role_code()''s own rule for the caller. Null when the id has neither. Used by admin_remove_member() to refuse a target at or above the caller''s own rank.';

-- Body is 202609060022's, unchanged except for the authorization block at
-- the top. The audit row, the posts_removed count, the moderation-write pin
-- and the 30-day purge upsert are all identical.
create or replace function public.admin_remove_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_posts integer;
  v_actor smallint;
  v_target smallint;
begin
  if not (
    exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null)
    or public.has_perm('community.member.remove')
  ) then
    raise exception 'not authorized';
  end if;
  if p_user_id = auth.uid() then raise exception 'use account deletion for your own account'; end if;

  v_actor := public.member_role_rank(auth.uid());
  v_target := public.member_role_rank(p_user_id);
  -- A null target rank is a member we cannot place, and an unplaceable
  -- target is refused rather than treated as the lowest rank.
  if v_actor is null or v_target is null or v_target >= v_actor then
    raise exception 'cannot remove a member at or above your own role';
  end if;

  insert into public.account_deletion_requests(user_id) values (p_user_id)
    on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = p_user_id;
  perform set_config('app.allow_moderation_write', 'on', true);
  with removed as (
    update public.workout_posts set deleted_at = now() where author_id = p_user_id returning 1
  ) select count(*) into v_posts from removed;
  perform set_config('app.allow_moderation_write', 'off', true);

  perform public.log_admin_action(
    'member_remove', 'member', p_user_id,
    null,
    jsonb_build_object('posts_removed', v_posts, 'purge_after', now() + interval '30 days'),
    'remove', null, p_user_id
  );
end $$;
revoke all on function public.admin_remove_member(uuid) from public, anon;
grant execute on function public.admin_remove_member(uuid) to authenticated;

comment on function public.admin_remove_member(uuid) is
  'COMM. Staff remove another member: an immediate soft delete of the profile and of every post they authored, plus a 30-day scheduled purge - the same effect request_account_deletion() has, triggered by staff instead. AUTH: security definer; profiles.is_admin OR has_perm(''community.member.remove'') (head_coach and up, widened in 202609160005 from the earlier is_admin-only gate so the role that owns the invite surface also owns removal). RANK GUARD: raises ''cannot remove a member at or above your own role'' unless member_role_rank(target) < member_role_rank(caller), so a head coach reaches members and coaches only and an admin cannot remove the owner; a null rank on either side is refused. Raises ''not authorized'' without the permission, and ''use account deletion for your own account'' for self, checked first. SIDE EFFECTS: one account_deletion_requests row (upserted), profiles.deleted_at set, every workout_posts row by that author soft deleted, and ONE admin_actions row (member_remove / member / target_id = the removed member) whose after_data carries posts_removed and purge_after.';


commit;
