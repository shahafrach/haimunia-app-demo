-- Haimunia club: a third circle type, on the shared BOX-LOG project (docs/club/research.md, section C;
-- docs/circles/decisions.md, "Haimunia club").
--
--   1. clubs.type gains 'club'; at most one club exists. Every branch on the type is explicit and an unknown
--      type raises, so a new type can never silently inherit friends' limits (the `else 20` twins).
--   2. circle_members.role gains 'coach' (a club only, one at most). The club's cap is 250.
--   3. The club's join link: one fixed, rotatable invite (rotate_club_link), owner or coach.
--   4. Coach rights: announcements (pinned, no push), delete any post in the club, remove members.
--      The owner passes to the coach on leave or account deletion; with no coach the club has no owner until
--      owner_set_club_owner() is run (docs/ops/CLUB_OWNERSHIP.md). A club is never deleted automatically.
--   5. Notifications: in a club only "reaction on your post" and "trained together". The PR fan-out, the week card
--      and "someone joined" skip type 'club' in the trigger itself.
--   6. push_subscriptions.app and bug_reports.app. A circle notification is pushed only to subscriptions of the
--      app that shows that circle; BOX-LOG's notification list and count leave club rows out.
--   7. transfer_blobs: the one-time transfer code's ciphertext (opaque; refused if it parses as JSON or carries a
--      plaintext field name), per-IP limits, 40 pending at most, deleted on first take or after 24 hours.
--   8. training_log_usage returns: pseudonymous per-device, per-day counts from both club apps, purged at 400 days.
--   9. Owner functions, granted to no role, run from the SQL editor or club-admin.yml.
--
-- FORWARD ONLY. Every SECURITY DEFINER function added or replaced here is listed in
-- supabase/tests/0135_definer_guard_test.sql.
begin;

-- =====================================================================================================
-- 1. The type
-- =====================================================================================================
alter table public.clubs drop constraint clubs_type_check;
alter table public.clubs add constraint clubs_type_check check (type in ('couple', 'friends', 'club'));
-- "The club is one circle of a new type": a second club is refused.
create unique index clubs_one_club_idx on public.clubs (type) where type = 'club';

-- The one place a circle type becomes a member cap. An unknown type raises.
create or replace function public.circle_member_cap(p_type text)
returns integer language plpgsql immutable set search_path = '' as $$
begin
  if p_type = 'couple' then return 2;
  elsif p_type = 'friends' then return 20;
  elsif p_type = 'club' then return 250;
  end if;
  raise exception 'unknown circle type %', coalesce(p_type, 'null');
end $$;
revoke all on function public.circle_member_cap(text) from public, anon;
grant execute on function public.circle_member_cap(text) to authenticated, service_role;

-- Share defaults per type. Club (owner decision 4): every workout is a post, PRs as percent improvement, absolute
-- weights off. A member's own setting (set_share_defaults) always wins. An unknown type raises.
create or replace function public.circle_share_defaults(p_type text)
returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  if p_type = 'couple' then
    return jsonb_build_object('share_workouts', true, 'share_prs', true, 'share_percent', true,
                              'share_weekly_count', true, 'show_weights', false);
  elsif p_type = 'friends' then
    return jsonb_build_object('share_workouts', false, 'share_prs', true, 'share_percent', true,
                              'share_weekly_count', true, 'show_weights', false);
  elsif p_type = 'club' then
    return jsonb_build_object('share_workouts', true, 'share_prs', true, 'share_percent', true,
                              'share_weekly_count', true, 'show_weights', false);
  end if;
  raise exception 'unknown circle type %', coalesce(p_type, 'null');
end $$;
revoke all on function public.circle_share_defaults(text) from public, anon;
grant execute on function public.circle_share_defaults(text) to authenticated, service_role;

-- =====================================================================================================
-- 2. Roles and the insert guard
-- =====================================================================================================
alter table public.circle_members drop constraint circle_members_role_check;
alter table public.circle_members add constraint circle_members_role_check check (role in ('owner', 'member', 'coach'));
create unique index circle_members_one_coach_idx on public.circle_members (club_id) where role = 'coach';

create or replace function public.circle_members_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_count integer;
  v_cap integer;
begin
  select c.type into v_type from public.clubs c where c.id = new.club_id for update;
  if v_type is null then raise exception 'circle not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  v_cap := public.circle_member_cap(v_type);
  select count(*) into v_count from public.circle_members m where m.club_id = new.club_id;
  if v_count >= v_cap then
    raise exception 'circle_full' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.circle_members m where m.user_id = new.user_id;
  if v_count >= 10 then
    raise exception 'too_many_circles' using errcode = 'P0001';
  end if;

  if v_type = 'couple' then
    -- Both members of a couple are owners.
    new.role := 'owner';
  elsif v_type = 'friends' then
    if new.role = 'coach' then raise exception 'only a club has a coach'; end if;
  elsif v_type = 'club' then
    if new.role = 'owner' and exists (select 1 from public.circle_members m
                                       where m.club_id = new.club_id and m.role = 'owner') then
      raise exception 'a club has one owner';
    end if;
  else
    raise exception 'unknown circle type %', v_type;
  end if;
  return new;
end $$;
revoke all on function public.circle_members_guard() from public, anon;

create or replace function public.circle_members_guard_role()
returns trigger language plpgsql set search_path = '' as $$
declare v_type text;
begin
  if new.club_id is distinct from old.club_id or new.user_id is distinct from old.user_id then
    raise exception 'a membership cannot move';
  end if;
  if new.role is not distinct from old.role then return new; end if;
  select c.type into v_type from public.clubs c where c.id = new.club_id;
  if v_type = 'couple' then
    if new.role <> 'owner' then raise exception 'both members of a couple are owners'; end if;
  elsif v_type = 'friends' then
    if new.role = 'coach' then raise exception 'only a club has a coach'; end if;
  elsif v_type = 'club' then
    if new.role = 'owner' and exists (select 1 from public.circle_members m
                                       where m.club_id = new.club_id and m.role = 'owner'
                                         and m.user_id <> new.user_id) then
      raise exception 'a club has one owner';
    end if;
  else
    raise exception 'unknown circle type %', v_type;
  end if;
  return new;
end $$;

-- =====================================================================================================
-- 3. Caller helpers
-- =====================================================================================================
-- Owner or coach of THIS club (a club-type circle). Reads only the caller's own membership row.
create or replace function public.is_club_staff(p_club_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.circle_members m
      join public.clubs c on c.id = m.club_id and c.type = 'club'
     where m.club_id = p_club_id and m.user_id = auth.uid() and m.role in ('owner', 'coach')
  );
$$;
revoke all on function public.is_club_staff(uuid) from public, anon;
grant execute on function public.is_club_staff(uuid) to authenticated, service_role;

-- =====================================================================================================
-- 4. Invites: friends and couple unchanged; a club has one rotatable link
-- =====================================================================================================
alter table public.circle_invites drop constraint circle_invites_max_uses_check;
-- 1..20 for a couple or friends invite is enforced by create_circle_invite; the club link carries a large number
-- because the member cap, not the link, limits a club.
alter table public.circle_invites add constraint circle_invites_max_uses_check check (max_uses between 1 and 100000);

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

-- Owner or coach. Deletes the club's current link and returns a new one ONCE (only its sha256 is stored).
-- 5 per caller per day. The link never expires and the 250 cap, not the link, limits joins.
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
  return v_token;
end $$;
revoke all on function public.rotate_club_link(uuid) from public, anon;
grant execute on function public.rotate_club_link(uuid) to authenticated;

-- =====================================================================================================
-- 5. Leaving, removal, ownership
-- =====================================================================================================
create or replace function public.circle_members_after_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_next uuid;
  v_type text;
begin
  -- The circle itself is being deleted (the last member left, or a cascade from
  -- clubs): the cascade removes everything, nothing to hand off.
  select c.type into v_type from public.clubs c where c.id = old.club_id for update;
  if not found then return null; end if;

  -- Their notification text about posts that are about to go.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications n
     set title = '', body = ''
   where n.source_type = 'post'
     and n.source_id in (select p.id from public.workout_posts p
                          where p.club_id = old.club_id and p.author_id = old.user_id)
     and (n.title <> '' or n.body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);

  -- Decision: leaving or removal deletes the member's posts and reactions in
  -- this circle. The private log stays on the device. Reactions on their posts
  -- and tags on their posts cascade with the post. In a club, their
  -- announcements go too.
  delete from public.reactions r
   using public.workout_posts p
   where r.post_id = p.id and p.club_id = old.club_id and r.user_id = old.user_id;
  delete from public.post_training_partners t
   where t.club_id = old.club_id and t.tagged_user_id = old.user_id;
  delete from public.workout_posts p
   where p.club_id = old.club_id and p.author_id = old.user_id;
  delete from public.benchmark_results b
   where b.club_id = old.club_id and b.user_id = old.user_id;
  delete from public.club_announcements a
   where a.club_id = old.club_id and a.author_id = old.user_id;

  if v_type = 'club' then
    -- A club is never deleted automatically and never handed to a random member (owner decision 5): the owner
    -- passes to the coach, whose seat is then empty; with no coach the club has no owner until
    -- owner_set_club_owner() runs.
    if old.role = 'owner' then
      update public.circle_members set role = 'owner'
       where club_id = old.club_id and role = 'coach';
    end if;
    return null;
  elsif v_type not in ('couple', 'friends') then
    raise exception 'unknown circle type %', v_type;
  end if;

  -- The last member to leave deletes the circle.
  if not exists (select 1 from public.circle_members m where m.club_id = old.club_id) then
    delete from public.clubs where id = old.club_id;
    return null;
  end if;

  -- An owner who leaves passes ownership to the longest-standing member.
  if not exists (select 1 from public.circle_members m
                  where m.club_id = old.club_id and m.role = 'owner') then
    select m.user_id into v_next
      from public.circle_members m
     where m.club_id = old.club_id
     order by m.joined_at, m.user_id
     limit 1;
    update public.circle_members set role = 'owner'
     where club_id = old.club_id and user_id = v_next;
  end if;
  return null;
end $$;
revoke all on function public.circle_members_after_delete() from public, anon;

-- Owner only in a couple or friends circle. In a club: the owner or the coach. Nobody removes an owner (an owner
-- who wants out leaves); only the owner removes the coach; removing yourself is leave_circle.
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
end $$;

-- =====================================================================================================
-- 6. Posts: the club's owner and coach may delete any post in the club
-- =====================================================================================================
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
end $$;

-- A club's feed is 250 members' posts. circle_feed reads one circle's live posts newest first, 30 at a time;
-- workout_posts_club_id_idx alone means a sort of every post the club ever had on each page.
create index workout_posts_circle_feed_idx on public.workout_posts (club_id, published_at desc, id desc)
  where deleted_at is null and status = 'active';

-- =====================================================================================================
-- 7. Announcements (club only): pinned, never pushed
-- =====================================================================================================
create table public.club_announcements (
  id         uuid primary key default gen_random_uuid(),
  club_id    uuid not null references public.clubs (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null,
  body       text not null check (char_length(body) between 1 and 500),
  pinned     boolean not null default false,
  created_at timestamptz not null default now()
);
create index club_announcements_club_idx on public.club_announcements (club_id, pinned desc, created_at desc);
create index club_announcements_author_idx on public.club_announcements (author_id);
create unique index club_announcements_one_pinned_idx on public.club_announcements (club_id) where pinned;
alter table public.club_announcements enable row level security;
revoke all on public.club_announcements from public, anon, authenticated;
grant select on public.club_announcements to authenticated;
create policy club_announcements_read on public.club_announcements for select to authenticated
  using (public.is_circle_member(club_id));
-- Two-step login (202611070002): every table with a client policy carries the restrictive aal2 policy.
create policy aal2_required on public.club_announcements as restrictive for all to authenticated
  using ((select public.aal_satisfied())) with check ((select public.aal_satisfied()));

-- 10 per caller per day. Pinning one unpins any other: a club has at most one pinned announcement.
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
end $$;

create or replace function public.club_announcement_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid;
begin
  select a.club_id into v_club from public.club_announcements a where a.id = p_id;
  if auth.uid() is null or v_club is null or not public.is_club_staff(v_club) then raise exception 'not authorized'; end if;
  delete from public.club_announcements where id = p_id;
end $$;
revoke all on function public.club_announcement_post(uuid, text, boolean) from public, anon;
revoke all on function public.club_announcement_set_pinned(uuid, boolean) from public, anon;
revoke all on function public.club_announcement_delete(uuid) from public, anon;
grant execute on function public.club_announcement_post(uuid, text, boolean) to authenticated;
grant execute on function public.club_announcement_set_pinned(uuid, boolean) to authenticated;
grant execute on function public.club_announcement_delete(uuid) to authenticated;

-- =====================================================================================================
-- 8. Notifications: no fan-out in a club
-- =====================================================================================================
create or replace function public.notif_on_pr_post()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_circle text;
  r record;
begin
  if new.post_type <> 'POST_PR' or new.status <> 'active' or new.deleted_at is not null then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'active' then return null; end if;
  -- Owner decision 7: nothing fans out to a club's members.
  if exists (select 1 from public.clubs c where c.id = new.club_id and c.type = 'club') then return null; end if;
  select pr.display_name into v_name from public.profiles pr where pr.id = new.author_id;
  select c.name into v_circle from public.clubs c where c.id = new.club_id;
  for r in select m.user_id from public.circle_members m
            where m.club_id = new.club_id and m.user_id <> new.author_id
  loop
    perform public.notif_create(
      r.user_id, 'pr_circle', 'community',
      'שיא אישי חדש במעגל',
      chr(8296) || coalesce(v_name, '') || chr(8297) || ' שבר/ה שיא אישי במעגל ' || chr(8296) || coalesce(v_circle, '') || chr(8297),
      'post', new.id,
      '/circles?c=' || new.club_id::text || '&post=' || new.id::text,
      new.club_id, new.author_id);
  end loop;
  return null;
end $$;
revoke all on function public.notif_on_pr_post() from public, anon, authenticated;

create or replace function public.notif_on_circle_join()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_circle text;
  r record;
begin
  -- Owner decision 6: up to 250 joins must not become 250 pushes to the owner.
  if exists (select 1 from public.clubs c where c.id = new.club_id and c.type = 'club') then return null; end if;
  select pr.display_name into v_name from public.profiles pr where pr.id = new.user_id;
  select c.name into v_circle from public.clubs c where c.id = new.club_id;
  for r in
    select m.user_id from public.circle_members m
     where m.club_id = new.club_id and m.role = 'owner' and m.user_id <> new.user_id
  loop
    perform public.notif_create(
      r.user_id, 'circle_joined', 'community',
      'חבר/ה חדש/ה במעגל',
      chr(8296) || coalesce(v_name, '') || chr(8297) || ' הצטרף/ה למעגל ' || chr(8296) || coalesce(v_circle, '') || chr(8297),
      'circle_member', new.user_id,
      '/circles?c=' || new.club_id::text,
      new.club_id, new.user_id);
  end loop;
  return null;
end $$;

create or replace function public.notif_week_card_due(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := coalesce(p_now, now()) at time zone 'Asia/Jerusalem';
  v_today date := v_now::date;
  v_dow integer := extract(dow from v_now)::integer;
  v_week date;
  v_sid uuid;
  v_written integer := 0;
  r record;
begin
  if v_dow = 6 and v_now::time >= time '21:00' then
    v_week := v_today - 6;
  elsif v_dow = 0 and v_now::time < time '12:00' then
    v_week := v_today - 7;
  else
    return 0;
  end if;

  for r in
    select c.id as club_id, c.name as club_name, cm.user_id
      from public.clubs c
      join public.circle_members cm on cm.club_id = c.id
      join public.profiles pr on pr.id = cm.user_id and pr.deleted_at is null
      left join public.member_targets tg on tg.user_id = cm.user_id
     where c.type <> 'club'   -- owner decision 5: a club has no week card
       and (tg.paused_until is null or tg.paused_until < v_today)
       and exists (
         select 1 from public.workout_posts p
          where p.club_id = c.id and p.post_type = 'POST_WORKOUT'
            and p.status = 'active' and p.deleted_at is null
            and coalesce(p.occurred_on, (p.published_at at time zone 'Asia/Jerusalem')::date)
                between v_week and v_week + 6)
  loop
    v_sid := md5(r.club_id::text || ':' || v_week::text)::uuid;
    if exists (select 1 from public.notifications n
                where n.user_id = r.user_id and n.type = 'week_card' and n.source_id = v_sid) then
      continue;
    end if;
    if public.notif_create(
         r.user_id, 'week_card', 'community',
         'כרטיס השבוע מוכן',
         'כרטיס השבוע של ' || chr(8296) || r.club_name || chr(8297) || ' מוכן לשיתוף',
         'circle_week', v_sid,
         '/circles?c=' || r.club_id::text || '&week=1',
         r.club_id, null) is not null then
      v_written := v_written + 1;
    end if;
  end loop;
  return v_written;
end $$;
revoke all on function public.notif_week_card_due(timestamptz) from public, anon, authenticated;
grant execute on function public.notif_week_card_due(timestamptz) to service_role;

-- =====================================================================================================
-- 9. Which app a push goes to
-- =====================================================================================================
alter table public.push_subscriptions
  add column app text not null default 'box-log'
    constraint push_subscriptions_app_check check (app in ('box-log', 'club'));

-- The app that shows a circle. Null for a circle that no longer exists.
create or replace function public.circle_app(p_club_id uuid)
returns text language sql stable set search_path = '' as $$
  select case c.type when 'club' then 'club' when 'couple' then 'box-log' when 'friends' then 'box-log' end
    from public.clubs c where c.id = p_club_id;
$$;
revoke all on function public.circle_app(uuid) from public, anon;
grant execute on function public.circle_app(uuid) to authenticated, service_role;

-- CHANGE: a circle notification is pushed only to subscriptions of the app that shows that circle. Personal
-- notifications (workout reminder, weekly digest, reset requested) go to every subscription of the account: a
-- club-only member has no BOX-LOG device, and a reset alert must reach every device.
create or replace function public.notif_push_pending(p_limit integer default 200)
returns table(notification_id uuid, subscription_id uuid, endpoint text, p256dh text,
              auth_secret text, title text, body text, deep_link text, notification_type text)
language sql security definer set search_path = '' as $$
  select n.id, s.id, s.endpoint,
         s.keys->>'p256dh', s.keys->>'auth',
         n.title, n.body, n.deep_link, n.type
    from public.notifications n
    join public.profiles pr on pr.id = n.user_id and pr.deleted_at is null
    join public.push_subscriptions s on s.user_id = n.user_id and s.revoked_at is null
   where n.push_sent_at is null
     and n.created_at > now() - interval '24 hours'
     and (n.circle_id is not null or n.type in ('workout_reminder', 'weekly_digest', 'reset_requested'))
     and (n.circle_id is null or s.app = public.circle_app(n.circle_id))
     and (n.circle_id is null
          or exists (select 1 from public.circle_members m
                      where m.club_id = n.circle_id and m.user_id = n.user_id))
     and (n.actor_id is null
          or exists (select 1 from public.circle_members m
                      where m.club_id = n.circle_id and m.user_id = n.actor_id))
     and (n.actor_id is null
          or not exists (select 1 from public.blocks b
                          where (b.blocker_id = n.user_id and b.blocked_id = n.actor_id)
                             or (b.blocker_id = n.actor_id and b.blocked_id = n.user_id)))
     and (n.source_type is distinct from 'post'
          or exists (select 1 from public.workout_posts p
                      where p.id = n.source_id and p.deleted_at is null))
     and (n.type = 'reset_requested'
          or exists (
            select 1 from public.notification_preferences np
             where np.user_id = n.user_id
               and np.type = public.notif_pref_key(n.type)
               and np.channel = 'push')
          or (n.type = 'reaction' and not exists (
            select 1 from public.notification_preferences np
             where np.user_id = n.user_id and np.type = 'reaction')))
     and coalesce(s.keys->>'p256dh', '') <> ''
     and coalesce(s.keys->>'auth', '') <> ''
   order by n.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- The notification list and badge count of one app. p_app defaults to box-log, so a BOX-LOG client that does not
-- send it behaves as before minus the club's rows. Personal rows (no circle) show in both apps.
drop function public.notif_list(timestamptz, integer, uuid);
create function public.notif_list(
  p_cursor timestamptz default null,
  p_limit integer default 20,
  p_cursor_id uuid default null,
  p_app text default 'box-log'
)
returns setof public.notifications
language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if p_app is null or p_app not in ('box-log', 'club') then raise exception 'unknown app'; end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 40);
  return query
    select n.* from public.notifications n
    where n.user_id = auth.uid()
      and (n.circle_id is null or public.circle_app(n.circle_id) = p_app)
      and (
        p_cursor is null
        or (p_cursor_id is null and n.created_at < p_cursor)
        or (p_cursor_id is not null and (n.created_at, n.id) < (p_cursor, p_cursor_id))
      )
    order by n.created_at desc, n.id desc
    limit v_limit;
end $$;
revoke all on function public.notif_list(timestamptz, integer, uuid, text) from public, anon;
grant execute on function public.notif_list(timestamptz, integer, uuid, text) to authenticated;

drop function public.notif_unread_count();
create function public.notif_unread_count(p_app text default 'box-log') returns integer
language sql stable security invoker set search_path = '' as $$
  select count(*)::integer from public.notifications n
  where n.user_id = auth.uid() and n.read_at is null
    and (n.circle_id is null or public.circle_app(n.circle_id) = p_app);
$$;
revoke all on function public.notif_unread_count(text) from public, anon;
grant execute on function public.notif_unread_count(text) to authenticated;

-- =====================================================================================================
-- 10. Bug reports know which app sent them
-- =====================================================================================================
alter table public.bug_reports
  add column app text not null default 'box-log'
    constraint bug_reports_app_check check (app in ('box-log', 'club'));

create or replace function public.bug_report_submit(p_body text, p_diagnostics jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_body text;
  v_version text;
  v_app text;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  -- A signed-up member with a profile, in a circle or not. An anonymous
  -- session (mid sign-up) is not one.
  if exists (select 1 from auth.users u where u.id = auth.uid() and coalesce(u.is_anonymous, false))
     or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.deleted_at is null) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then raise exception 'body required' using errcode = 'P0001'; end if;
  v_body := left(v_body, 4000);

  -- Kept besides the message: the app version, if it looks like one, and which app sent it. Anything else in
  -- p_diagnostics is dropped here, not stored.
  v_version := coalesce(p_diagnostics ->> 'app_version', p_diagnostics ->> 'version', '');
  if v_version !~ '^[0-9A-Za-z._-]{1,32}$' then v_version := ''; end if;
  v_app := case p_diagnostics ->> 'app' when 'club' then 'club' else 'box-log' end;

  if not public.check_rate_limit('bug_report_submit', 5, 60) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.bug_reports (reporter_id, body, diagnostics, app)
  values (auth.uid(), v_body, jsonb_build_object('app_version', v_version), v_app)
  returning id into v_id;
  return v_id;
end $$;

-- =====================================================================================================
-- 11. Transfer code: opaque ciphertext, one take, 24 hours
-- =====================================================================================================
create table public.transfer_blobs (
  lookup_hash text primary key check (lookup_hash ~ '^[0-9a-f]{64}$'),
  iv          bytea not null check (octet_length(iv) = 12),
  ciphertext  bytea not null check (octet_length(ciphertext) between 17 and 5242880),
  ip_hash     text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now()
);
create index transfer_blobs_created_idx on public.transfer_blobs (created_at);
alter table public.transfer_blobs enable row level security;
revoke all on public.transfer_blobs from public, anon, authenticated, service_role;
comment on table public.transfer_blobs is
  'Haimunia transfer code (202611120001): AES-GCM ciphertext of one backup, encrypted on the old phone with a key that exists only in the code the member copies. The server holds the sha256 of the lookup half and the ciphertext, never the key. Deleted on the first take or after 24 hours. No role reads it; only transfer_put/transfer_take (service_role).';

create table public.transfer_attempts (
  ip_hash           text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  action            text not null check (action in ('put', 'take')),
  window_started_at timestamptz not null default now(),
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  primary key (ip_hash, action)
);
alter table public.transfer_attempts enable row level security;
revoke all on public.transfer_attempts from public, anon, authenticated, service_role;

-- Same shape as check_rate_limit, keyed by an IP hash: there is no account on either side of a transfer.
create or replace function public.transfer_rate_ok(p_ip_hash text, p_action text, p_max integer, p_window_minutes integer)
returns boolean language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  insert into public.transfer_attempts (ip_hash, action, window_started_at, attempt_count)
  values (p_ip_hash, p_action, now(), 1)
  on conflict (ip_hash, action) do update set
    window_started_at = case when public.transfer_attempts.window_started_at < now() - make_interval(mins => p_window_minutes) then now() else public.transfer_attempts.window_started_at end,
    attempt_count = case when public.transfer_attempts.window_started_at < now() - make_interval(mins => p_window_minutes) then 1 else public.transfer_attempts.attempt_count + 1 end
  returning attempt_count into v_count;
  return v_count <= p_max;
end $$;
revoke all on function public.transfer_rate_ok(text, text, integer, integer) from public, anon, authenticated, service_role;

-- True when the bytes look like plaintext a client forgot to encrypt: valid UTF-8 JSON, or any backup field name.
create or replace function public.transfer_looks_plaintext(p_bytes bytea)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_name text;
begin
  foreach v_name in array array['"app"', '"box-log"', '"entries"', '"bodyweightEntries"', '"weight"',
                                '"sessionNotes"', '"wodEntries"', '"measureEntries"', '"exportedAt"'] loop
    if position(convert_to(v_name, 'UTF8') in p_bytes) > 0 then return true; end if;
  end loop;
  begin
    perform convert_from(p_bytes, 'UTF8')::jsonb;
    return true;
  exception when others then
    return false;
  end;
end $$;
revoke all on function public.transfer_looks_plaintext(bytea) from public, anon;
grant execute on function public.transfer_looks_plaintext(bytea) to service_role;

-- Called by the transfer-put Edge Function only. Returns a status, never raises for a refusal (a raise would roll
-- back the attempt count): stored | rate_limited | full | invalid | too_large | plaintext | exists.
create or replace function public.transfer_put(p_lookup_hash text, p_iv_b64 text, p_ciphertext_b64 text, p_ip_hash text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_iv bytea;
  v_ct bytea;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then return 'invalid'; end if;
  if not public.transfer_rate_ok(p_ip_hash, 'put', 5, 1440) then return 'rate_limited'; end if;
  if p_lookup_hash is null or p_lookup_hash !~ '^[0-9a-f]{64}$' then return 'invalid'; end if;
  -- 5 MiB of ciphertext is at most 6,990,508 base64 characters.
  if p_ciphertext_b64 is null or char_length(p_ciphertext_b64) > 6990508 then return 'too_large'; end if;
  begin
    v_iv := decode(p_iv_b64, 'base64');
    v_ct := decode(p_ciphertext_b64, 'base64');
  exception when others then
    return 'invalid';
  end;
  if octet_length(v_iv) <> 12 or octet_length(v_ct) < 17 then return 'invalid'; end if;
  if octet_length(v_ct) > 5242880 then return 'too_large'; end if;
  if public.transfer_looks_plaintext(v_ct) then return 'plaintext'; end if;

  -- Serialise the global cap.
  perform pg_advisory_xact_lock(hashtextextended('transfer_put', 0));
  if (select count(*) from public.transfer_blobs b where b.created_at > now() - interval '24 hours') >= 40 then
    return 'full';
  end if;
  insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash)
  values (p_lookup_hash, v_iv, v_ct, p_ip_hash)
  on conflict (lookup_hash) do nothing;
  if not found then return 'exists'; end if;
  return 'stored';
end $$;
revoke all on function public.transfer_put(text, text, text, text) from public, anon, authenticated;
grant execute on function public.transfer_put(text, text, text, text) to service_role;

-- Called by the transfer-take Edge Function only. One statement deletes and returns, so a second take finds
-- nothing. {status: ok, iv, ciphertext} | {status: not_found | rate_limited | invalid}.
create or replace function public.transfer_take(p_lookup_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_iv bytea;
  v_ct bytea;
  v_fresh boolean;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status', 'invalid'); end if;
  if not public.transfer_rate_ok(p_ip_hash, 'take', 10, 15) then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if p_lookup_hash is null or p_lookup_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status', 'invalid'); end if;
  delete from public.transfer_blobs b
   where b.lookup_hash = p_lookup_hash
  returning b.iv, b.ciphertext, b.created_at > now() - interval '24 hours'
  into v_iv, v_ct, v_fresh;
  -- An expired row is deleted above and not returned.
  if v_ct is null or not v_fresh then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok',
    'iv', encode(v_iv, 'base64'),
    'ciphertext', translate(encode(v_ct, 'base64'), E'\n', ''));
end $$;
revoke all on function public.transfer_take(text, text) from public, anon, authenticated;
grant execute on function public.transfer_take(text, text) to service_role;

create or replace function public.transfer_purge()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from public.transfer_blobs where created_at < now() - interval '24 hours';
  get diagnostics v_n = row_count;
  delete from public.transfer_attempts where window_started_at < now() - interval '2 days';
  return v_n;
end $$;
revoke all on function public.transfer_purge() from public, anon, authenticated;
grant execute on function public.transfer_purge() to service_role;
select cron.schedule('transfer-purge', '23 * * * *', $$select public.transfer_purge()$$);

-- =====================================================================================================
-- 12. Usage counting returns (owner decision 9)
-- =====================================================================================================
-- Insert-only for anon: device_id (random, made on the phone), event, screen. The server stamps the day and,
-- from the request's Origin header, which app sent it. No role can select a row; totals come from
-- training_log_usage_report(), granted to no role. At most 2,000 rows a day; purged after 400 days.
create table public.training_log_usage (
  day       date not null default ((now() at time zone 'Asia/Jerusalem')::date),
  device_id uuid not null,
  event     text not null,
  screen    text not null default '',
  app       text not null default 'unknown',
  primary key (day, device_id, event, screen),
  constraint training_log_usage_event_known
    check (event in ('app_open', 'workout_logged', 'screen_open')),
  constraint training_log_usage_screen_known
    check (screen in ('', 'add', 'history', 'calendar', 'wod', 'home', 'progress', 'circle', 'me')),
  constraint training_log_usage_screen_only_for_screen_open
    check ((event = 'screen_open') = (screen <> '')),
  constraint training_log_usage_app_known
    check (app in ('old', 'club', 'unknown'))
);
comment on table public.training_log_usage is
  'Pseudonymous per-device, per-day usage counts from the Haimunia club apps (the old app on haimuniya.github.io and the new one on haimunia.pages.dev). Insert-only for anon (device_id, event, screen); app is set from the Origin header. No role can select a row; totals through training_log_usage_report() (granted to no role). At most 2,000 rows a day, purged after 400 days. 202611120001, restoring what 202610250001 dropped.';
create index training_log_usage_device_idx on public.training_log_usage (device_id);

create or replace function public.training_log_usage_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_origin text;
begin
  new.day := (now() at time zone 'Asia/Jerusalem')::date;
  begin
    v_origin := nullif(current_setting('request.headers', true), '')::json ->> 'origin';
  exception when others then
    v_origin := null;
  end;
  new.app := case v_origin
    when 'https://haimuniya.github.io' then 'old'
    when 'https://haimunia.pages.dev' then 'club'
    else 'unknown'
  end;
  if (select count(*) from public.training_log_usage u where u.day = new.day) >= 2000 then
    return null;
  end if;
  if exists (
    select 1 from public.training_log_usage u
     where u.day = new.day and u.device_id = new.device_id
       and u.event = new.event and u.screen = new.screen
  ) then
    return null;
  end if;
  return new;
end $$;
revoke all on function public.training_log_usage_before_insert() from public, anon, authenticated;
create trigger training_log_usage_before_insert
  before insert on public.training_log_usage
  for each row execute function public.training_log_usage_before_insert();

alter table public.training_log_usage enable row level security;
revoke all on table public.training_log_usage from public, anon, authenticated;
grant insert (device_id, event, screen) on table public.training_log_usage to anon;
create policy training_log_usage_insert_anon on public.training_log_usage
  for insert to anon with check (true);
-- authenticated has no grant here; the restrictive policy is the 202611070002 rule for every policied table.
create policy aal2_required on public.training_log_usage as restrictive for all to authenticated
  using ((select public.aal_satisfied())) with check ((select public.aal_satisfied()));

-- Totals only, never a row or a device id. Granted to no role: the SQL editor (postgres) runs it.
create or replace function public.training_log_usage_report(p_weeks integer default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 104);
  v_first_week date;
  v_out jsonb;
begin
  if auth.uid() is not null then raise exception 'not authorized' using errcode = '42501'; end if;
  -- Weeks start Sunday, Asia/Jerusalem (decisions.md).
  v_first_week := v_today - extract(dow from v_today)::integer - 7 * (v_weeks - 1);
  with u as (select * from public.training_log_usage),
  firsts as (select device_id, min(day) as first_day from u group by device_id),
  weeks as (
    select generate_series(v_first_week, v_today, interval '1 week')::date as week_start
  ),
  per_week as (
    select w.week_start,
      (select count(distinct u.device_id) from u
         where u.day >= w.week_start and u.day < w.week_start + 7) as devices,
      (select count(distinct u.device_id) from u
         where u.event = 'workout_logged' and u.day >= w.week_start and u.day < w.week_start + 7) as logging_devices,
      (select count(*) from firsts f
         where f.first_day >= w.week_start and f.first_day < w.week_start + 7) as new_devices
    from weeks w
  )
  select jsonb_build_object(
    'as_of', v_today,
    'first_day', (select min(day) from u),
    'devices_seen', (select count(distinct device_id) from u),
    'devices_logged', (select count(distinct device_id) from u where event = 'workout_logged'),
    'devices_seen_7d', (select count(distinct device_id) from u where day > v_today - 7),
    'devices_logged_7d', (select count(distinct device_id) from u where event = 'workout_logged' and day > v_today - 7),
    'apps_7d', coalesce((select jsonb_object_agg(a.app, a.devices)
      from (select app, count(distinct device_id) as devices from u where day > v_today - 7 group by app) a), '{}'::jsonb),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object(
        'week_start', pw.week_start, 'devices', pw.devices,
        'logging_devices', pw.logging_devices, 'new_devices', pw.new_devices) order by pw.week_start)
      from per_week pw), '[]'::jsonb),
    'screens', coalesce((select jsonb_agg(jsonb_build_object('screen', s.screen, 'devices', s.devices) order by s.screen)
      from (select screen, count(distinct device_id) as devices from u
              where event = 'screen_open' and day > v_today - 28 group by screen) s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.training_log_usage_report(integer) from public, anon, authenticated;

create or replace function public.training_log_usage_purge()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.training_log_usage
   where day < (now() at time zone 'Asia/Jerusalem')::date - 400;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function public.training_log_usage_purge() from public, anon, authenticated;
select cron.schedule('training-log-usage-purge', '47 3 * * *', $$select public.training_log_usage_purge()$$);

-- =====================================================================================================
-- 13. Owner functions: granted to no role (SQL editor, or club-admin.yml through the Management API)
-- =====================================================================================================
-- p_who is a username, or 'sha256:<hex>' of the lower-cased username, so club-admin.yml never puts a username in
-- a public workflow log. A permanent, live account only.
create or replace function public.owner_user_by_name(p_who text)
returns uuid language plpgsql stable set search_path = '' as $$
declare v_id uuid;
begin
  if p_who ~ '^sha256:[0-9a-f]{64}$' then
    select u.id into v_id from auth.users u
     where u.email like '%@members.haimuniya.invalid'
       and encode(extensions.digest(split_part(u.email, '@', 1), 'sha256'), 'hex') = substr(p_who, 8)
       and not coalesce(u.is_anonymous, false) and u.deleted_at is null
     limit 1;
  else
    select u.id into v_id from auth.users u
     where u.email = lower(btrim(coalesce(p_who, ''))) || '@members.haimuniya.invalid'
       and not coalesce(u.is_anonymous, false) and u.deleted_at is null
     limit 1;
  end if;
  if v_id is not null and not exists (select 1 from public.profiles p where p.id = v_id and p.deleted_at is null) then
    return null;
  end if;
  return v_id;
end $$;
revoke all on function public.owner_user_by_name(text) from public, anon, authenticated, service_role;

-- created | exists | no_such_user | too_many_circles
create or replace function public.owner_create_club(p_owner text, p_name text, p_emoji text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_name text;
  v_emoji text;
  v_id uuid;
begin
  if auth.uid() is not null then raise exception 'not authorized'; end if;
  if exists (select 1 from public.clubs c where c.type = 'club') then return 'exists'; end if;
  v_uid := public.owner_user_by_name(p_owner);
  if v_uid is null then return 'no_such_user'; end if;
  v_name := left(btrim(regexp_replace(coalesce(p_name, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g')), 40);
  if v_name = '' then raise exception 'a club needs a name'; end if;
  v_emoji := nullif(btrim(coalesce(p_emoji, '')), '');
  if v_emoji is not null and char_length(v_emoji) > 16 then raise exception 'emoji is too long'; end if;

  insert into public.clubs (name, type, emoji, created_by)
  values (v_name, 'club', coalesce(v_emoji, E'\U0001F4AA'), v_uid)
  returning id into v_id;
  begin
    insert into public.circle_members (club_id, user_id, role, share_defaults)
    values (v_id, v_uid, 'owner', public.circle_share_defaults('club'));
  exception when others then
    if sqlerrm = 'too_many_circles' then
      delete from public.clubs where id = v_id;
      return 'too_many_circles';
    end if;
    raise;
  end;
  return 'created';
end $$;
revoke all on function public.owner_create_club(text, text, text) from public, anon, authenticated, service_role;

-- set | no_club | no_such_user | not_member | is_owner | already
create or replace function public.owner_set_coach(p_who text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_club uuid;
  v_uid uuid;
  v_role text;
begin
  if auth.uid() is not null then raise exception 'not authorized'; end if;
  select c.id into v_club from public.clubs c where c.type = 'club' for update;
  if v_club is null then return 'no_club'; end if;
  v_uid := public.owner_user_by_name(p_who);
  if v_uid is null then return 'no_such_user'; end if;
  select m.role into v_role from public.circle_members m where m.club_id = v_club and m.user_id = v_uid;
  if v_role is null then return 'not_member'; end if;
  if v_role = 'owner' then return 'is_owner'; end if;
  if v_role = 'coach' then return 'already'; end if;
  update public.circle_members set role = 'member' where club_id = v_club and role = 'coach';
  update public.circle_members set role = 'coach' where club_id = v_club and user_id = v_uid;
  return 'set';
end $$;
revoke all on function public.owner_set_coach(text) from public, anon, authenticated, service_role;

-- The one line in docs/ops/CLUB_OWNERSHIP.md. Makes that member the owner; the previous owner, if any, becomes a
-- member; a coach who becomes the owner leaves the coach seat empty. set | no_club | no_such_user | not_member | already
create or replace function public.owner_set_club_owner(p_who text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_club uuid;
  v_uid uuid;
  v_role text;
begin
  if auth.uid() is not null then raise exception 'not authorized'; end if;
  select c.id into v_club from public.clubs c where c.type = 'club' for update;
  if v_club is null then return 'no_club'; end if;
  v_uid := public.owner_user_by_name(p_who);
  if v_uid is null then return 'no_such_user'; end if;
  select m.role into v_role from public.circle_members m where m.club_id = v_club and m.user_id = v_uid;
  if v_role is null then return 'not_member'; end if;
  if v_role = 'owner' then return 'already'; end if;
  update public.circle_members set role = 'member' where club_id = v_club and role = 'owner';
  update public.circle_members set role = 'owner' where club_id = v_club and user_id = v_uid;
  return 'set';
end $$;
revoke all on function public.owner_set_club_owner(text) from public, anon, authenticated, service_role;

commit;
