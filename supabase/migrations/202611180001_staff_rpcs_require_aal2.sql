-- 202611180001: club staff and owner RPCs require aal2 when the member has MFA (F-028, high).
--
-- WHY. 202611070002 made every table policy require public.aal_satisfied(): a member with a verified MFA factor
-- who signed in with only a password (aal1) can read and write nothing until they pass the second factor. But a
-- SECURITY DEFINER function runs past RLS, so those restrictive policies never see its writes. Cursor's security
-- pass (club #35, test/audit-aal1-staff-rpcs.test.mjs) showed an owner's aal1 session rotating the club link,
-- posting an announcement and removing a member. 202611150002 already did this for delete_my_account and
-- request_account_deletion (F-016); this does it for every staff and owner RPC a session can call.
--
-- WHAT. The same first statement in each, and nothing else changed (each body below is copied from the migration
-- named above it):
--   rotate_club_link, club_announcement_post, club_announcement_set_pinned, club_announcement_delete,
--   remove_member, post_delete, create_circle_invite, update_circle.
-- create or replace keeps each function's grants and comment. A member without a verified factor is unaffected
-- (aal_satisfied() is true for them), and so is an aal2 session.
--
-- LEFT, on purpose (listed in the PR):
--   * owner_set_coach, owner_set_club_owner: refuse any session (auth.uid() must be null) and are revoked from
--     every role, so only the operator runs them from the SQL editor.
--   * is_club_staff, is_circle_owner: boolean helpers, not actions; every action that uses them is gated here.
--   * circle_members_guard, circle_members_after_delete, notif_on_circle_join, workout_posts_guard_privileged_type:
--     triggers, which fire only on writes that RLS or one of the functions above already gates.
--   * club_staff_log, club_staff_actions_purge: an internal audit helper and a cron job.

-- rotate_club_link: body as in 202611140001_club_staff_audit.sql, plus the aal2 check as its first statement.
create or replace function public.rotate_club_link(p_club_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if v_uid is null then raise exception 'not authorized'; end if;
  perform 1 from public.clubs c where c.id = p_club_id and c.type = 'club' for update;
  if not found or not public.is_club_staff(p_club_id) then raise exception 'not authorized'; end if;
  if not public.check_rate_limit('rotate_club_link', 5, 1440) then raise exception 'rate_limited'; end if;

  delete from public.circle_invites i where i.club_id = p_club_id;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.circle_invites (club_id, token_hash, created_by, expires_at, max_uses)
  values (p_club_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid, 'infinity', 100000);
  perform public.club_staff_log(p_club_id, 'link_rotate', null);
  return v_token;
end $$;

-- club_announcement_post: body as in 202611140001_club_staff_audit.sql, plus the aal2 check as its first statement.
create or replace function public.club_announcement_post(p_club_id uuid, p_body text, p_pinned boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_body text;
  v_id uuid;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if auth.uid() is null or not public.is_club_staff(p_club_id) then raise exception 'not authorized'; end if;
  v_body := left(btrim(regexp_replace(coalesce(p_body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g')), 501);
  if v_body = '' then raise exception 'an announcement needs text'; end if;
  if char_length(v_body) > 500 then raise exception 'announcement is too long'; end if;
  if not public.check_rate_limit('club_announcement_post', 10, 1440) then raise exception 'rate_limited'; end if;
  if coalesce(p_pinned, false) then
    update public.club_announcements set pinned = false where club_id = p_club_id and pinned;
  end if;
  insert into public.club_announcements (club_id, author_id, body, pinned)
  values (p_club_id, auth.uid(), v_body, coalesce(p_pinned, false))
  returning id into v_id;
  perform public.club_staff_log(p_club_id, 'announcement_post', v_id);
  return v_id;
end $$;

-- club_announcement_set_pinned: body as in 202611140001_club_staff_audit.sql, plus the aal2 check as its first statement.
create or replace function public.club_announcement_set_pinned(p_id uuid, p_pinned boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  select a.club_id into v_club from public.club_announcements a where a.id = p_id;
  if auth.uid() is null or v_club is null or not public.is_club_staff(v_club) then raise exception 'not authorized'; end if;
  if coalesce(p_pinned, false) then
    update public.club_announcements set pinned = false where club_id = v_club and pinned and id <> p_id;
  end if;
  update public.club_announcements set pinned = coalesce(p_pinned, false) where id = p_id;
  perform public.club_staff_log(v_club, case when coalesce(p_pinned, false) then 'announcement_pin' else 'announcement_unpin' end, p_id);
end $$;

-- club_announcement_delete: body as in 202611140001_club_staff_audit.sql, plus the aal2 check as its first statement.
create or replace function public.club_announcement_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  select a.club_id into v_club from public.club_announcements a where a.id = p_id;
  if auth.uid() is null or v_club is null or not public.is_club_staff(v_club) then raise exception 'not authorized'; end if;
  delete from public.club_announcements where id = p_id;
  perform public.club_staff_log(v_club, 'announcement_delete', p_id);
end $$;

-- remove_member: body as in 202611140001_club_staff_audit.sql, plus the aal2 check as its first statement.
create or replace function public.remove_member(p_club_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_my_role text;
  v_role text;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select c.type into v_type from public.clubs c where c.id = p_club_id;
  select m.role into v_my_role from public.circle_members m
   where m.club_id = p_club_id and m.user_id = auth.uid();
  if v_type is null or v_my_role is null then raise exception 'not authorized'; end if;
  if not (v_my_role = 'owner' or (v_type = 'club' and v_my_role = 'coach')) then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then raise exception 'member is required'; end if;
  if p_user_id = auth.uid() then raise exception 'use leave_circle'; end if;
  select m.role into v_role from public.circle_members m
   where m.club_id = p_club_id and m.user_id = p_user_id;
  if v_role is null then raise exception 'member not found'; end if;
  if v_role = 'owner' then raise exception 'an owner cannot be removed'; end if;
  if v_role = 'coach' and v_my_role <> 'owner' then raise exception 'not authorized'; end if;
  delete from public.circle_members m where m.club_id = p_club_id and m.user_id = p_user_id;
  if v_type = 'club' then perform public.club_staff_log(p_club_id, 'member_remove', p_user_id); end if;
end $$;

-- post_delete: body as in 202611140001_club_staff_audit.sql, plus the aal2 check as its first statement.
create or replace function public.post_delete(post_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_is_mod boolean;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;

  -- Moderation exists only in a club, and only for that club's owner and coach.
  v_is_mod := v_row.club_id is not null and public.is_club_staff(v_row.club_id);

  if v_row.author_id is distinct from v_uid and not v_is_mod then
    raise exception 'not authorized';
  end if;

  if v_row.deleted_at is not null and v_row.status = 'removed' then return; end if;

  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts
    set deleted_at = now(), status = 'removed'
  where id = post_id;
  perform set_config('app.allow_moderation_write', 'off', true);

  -- Notification snapshots pointing at this post lose their text.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications
     set title = '', body = ''
   where source_type = 'post' and source_id = post_id
     and (title <> '' or body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);

  -- A moderator removing someone else's post is a staff action (F-002). An author deleting their own is not.
  if v_is_mod and v_row.author_id is distinct from v_uid then
    perform public.club_staff_log(v_row.club_id, 'post_remove', post_id);
  end if;
end $$;

-- create_circle_invite: body as in 202611120001_haimunia_club.sql, plus the aal2 check as its first statement.
create or replace function public.create_circle_invite(p_club_id uuid, p_max_uses integer default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_type text;
  v_policy text;
  v_members integer;
  v_cap integer;
  v_max integer;
  v_token text;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if v_uid is null then raise exception 'not authorized'; end if;

  -- The circle row lock serialises two invites to one circle, so the daily cap
  -- below cannot be raced past.
  select c.type, c.invite_policy into v_type, v_policy
    from public.clubs c where c.id = p_club_id for update;
  if v_type is null or not public.is_circle_member(p_club_id) then
    raise exception 'not authorized';
  end if;
  -- A club has one fixed link (rotate_club_link), never per-person invites.
  if v_type = 'club' then raise exception 'use rotate_club_link'; end if;
  if v_type not in ('couple', 'friends') then raise exception 'unknown circle type %', v_type; end if;
  if v_policy = 'owner' and not public.is_circle_owner(p_club_id) then
    raise exception 'not authorized';
  end if;

  select count(*) into v_members from public.circle_members m where m.club_id = p_club_id;
  v_cap := public.circle_member_cap(v_type);
  if v_members >= v_cap then
    raise exception 'circle_full';
  end if;

  if (select count(*) from public.circle_invites i
       where i.club_id = p_club_id and i.created_at > now() - interval '1 day') >= 20 then
    raise exception 'invite_limit';
  end if;

  v_max := coalesce(p_max_uses, case v_type when 'couple' then 1 when 'friends' then 5 end);
  if v_max < 1 or v_max > 20 then raise exception 'uses must be between 1 and 20'; end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.circle_invites (club_id, token_hash, created_by, expires_at, max_uses)
  values (p_club_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid,
          now() + interval '7 days', v_max);
  return v_token;
end $$;

-- update_circle: body as in 202610250004_circle_lifecycle_rpcs.sql, plus the aal2 check as its first statement.
create or replace function public.update_circle(p_club_id uuid, p_settings jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_name text;
  v_emoji text;
  v_mode text;
  v_enabled boolean;
  v_policy text;
  v_welcome text;
  v_benchmark text;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if auth.uid() is null or not public.is_circle_owner(p_club_id) then
    raise exception 'not authorized';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' or p_settings = '{}'::jsonb then
    raise exception 'settings are required';
  end if;

  for v_key, v_val in select * from jsonb_each(p_settings) loop
    case v_key
      when 'name' then
        if jsonb_typeof(v_val) <> 'string' then raise exception 'name must be text'; end if;
        v_name := btrim(v_val #>> '{}');
        if char_length(v_name) not between 1 and 40 then raise exception 'name must be 1 to 40 characters'; end if;
      when 'emoji' then
        if jsonb_typeof(v_val) <> 'string' then raise exception 'emoji must be text'; end if;
        v_emoji := btrim(v_val #>> '{}');
        if char_length(v_emoji) not between 1 and 16 then raise exception 'emoji must be 1 to 16 characters'; end if;
      when 'mode' then
        v_mode := v_val #>> '{}';
        if jsonb_typeof(v_val) <> 'string' or v_mode not in ('together', 'weekly_competition') then
          raise exception 'unknown mode';
        end if;
      when 'benchmark_enabled' then
        if jsonb_typeof(v_val) <> 'boolean' then raise exception 'benchmark_enabled must be true or false'; end if;
        v_enabled := (v_val #>> '{}')::boolean;
      when 'invite_policy' then
        v_policy := v_val #>> '{}';
        if jsonb_typeof(v_val) <> 'string' or v_policy not in ('owner', 'any_member') then
          raise exception 'unknown invite policy';
        end if;
      when 'welcome_line' then
        if jsonb_typeof(v_val) <> 'string' then raise exception 'welcome_line must be text'; end if;
        v_welcome := btrim(v_val #>> '{}');
        if char_length(v_welcome) > 200 then raise exception 'welcome line is too long'; end if;
      when 'benchmark' then
        if jsonb_typeof(v_val) not in ('string', 'null') then raise exception 'unknown benchmark'; end if;
        v_benchmark := v_val #>> '{}';
        if v_benchmark is not null
           and v_benchmark not in ('fran', 'grace', 'helen', 'diane', 'cindy', 'murph', 'isabel', 'karen') then
          raise exception 'unknown benchmark';
        end if;
      else
        raise exception 'unknown setting %', v_key;
    end case;
  end loop;

  update public.clubs c set
    name              = coalesce(v_name, c.name),
    emoji             = coalesce(v_emoji, c.emoji),
    mode              = coalesce(v_mode, c.mode),
    benchmark_enabled = coalesce(v_enabled, c.benchmark_enabled),
    invite_policy     = coalesce(v_policy, c.invite_policy),
    welcome_line      = coalesce(v_welcome, c.welcome_line),
    -- The month is stamped by clubs_stamp_benchmark_month when this column is set.
    benchmark         = case when p_settings ? 'benchmark' then v_benchmark else c.benchmark end
   where c.id = p_club_id;
end $$;
