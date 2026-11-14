-- F-002 (haimunia-club FINDINGS.md, SEC-7): club staff actions leave an audit record.
--
-- Until now a coach or owner could remove a member, remove a member's post, rotate the join link, or
-- delete or pin an announcement, and nothing recorded who did it. admin_actions went with the gym
-- (202610250001_strip_gym). This adds a club-only log, written inside the same SECURITY DEFINER
-- functions that do the action, so a row exists exactly when the action happened.
--
-- What a row holds: the club, the actor, the action, the target id and the time. No text: an
-- announcement's or a post's body is never copied here, so deleting it still deletes it.
-- actor_id and target_id are plain uuids, not foreign keys: the record has to outlive the account
-- (a cascade would erase the trail when someone is removed or deletes their account).
-- Nobody reads it from the app: no client role has any grant; the owner reads it in the SQL editor.
-- Friends and couple circles are not logged: they have no staff, only an owner of a small private group.
--
-- The six functions below are 202611120001's bodies unchanged, plus one club_staff_log() call each.
-- Same signatures, so their grants stay as they are.

create table public.club_staff_actions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  actor_id uuid not null,
  action text not null check (action in (
    'member_remove', 'post_remove', 'link_rotate',
    'announcement_post', 'announcement_pin', 'announcement_unpin', 'announcement_delete'
  )),
  target_id uuid,
  created_at timestamptz not null default now()
);
create index club_staff_actions_club_time_idx on public.club_staff_actions (club_id, created_at desc);
alter table public.club_staff_actions enable row level security;
revoke all on public.club_staff_actions from public, anon, authenticated, service_role;
comment on table public.club_staff_actions is
  'F-002: who did what as club staff (remove member, remove post, rotate link, post, pin, unpin or delete an announcement). Ids and time only, no text. Written only by club_staff_log() from the staff functions; no client role can read or write it. 202611140001.';

-- Called only from the SECURITY DEFINER functions below (they run as the owner). Granted to no role.
create or replace function public.club_staff_log(p_club_id uuid, p_action text, p_target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  insert into public.club_staff_actions (club_id, actor_id, action, target_id)
  values (p_club_id, auth.uid(), p_action, p_target_id);
end $$;
revoke all on function public.club_staff_log(uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function public.remove_member(p_club_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_my_role text;
  v_role text;
begin
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

create or replace function public.post_delete(post_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_is_mod boolean;
begin
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

create or replace function public.rotate_club_link(p_club_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
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

create or replace function public.club_announcement_post(p_club_id uuid, p_body text, p_pinned boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_body text;
  v_id uuid;
begin
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

create or replace function public.club_announcement_set_pinned(p_id uuid, p_pinned boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid;
begin
  select a.club_id into v_club from public.club_announcements a where a.id = p_id;
  if auth.uid() is null or v_club is null or not public.is_club_staff(v_club) then raise exception 'not authorized'; end if;
  if coalesce(p_pinned, false) then
    update public.club_announcements set pinned = false where club_id = v_club and pinned and id <> p_id;
  end if;
  update public.club_announcements set pinned = coalesce(p_pinned, false) where id = p_id;
  perform public.club_staff_log(v_club, case when coalesce(p_pinned, false) then 'announcement_pin' else 'announcement_unpin' end, p_id);
end $$;

create or replace function public.club_announcement_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid;
begin
  select a.club_id into v_club from public.club_announcements a where a.id = p_id;
  if auth.uid() is null or v_club is null or not public.is_club_staff(v_club) then raise exception 'not authorized'; end if;
  delete from public.club_announcements where id = p_id;
  perform public.club_staff_log(v_club, 'announcement_delete', p_id);
end $$;
