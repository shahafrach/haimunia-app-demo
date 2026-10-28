-- Notifications for circles.
--
-- Four types, all off until the member turns each one on:
--   reaction          someone reacted to my post (one per post per hour)
--   trained_together  a tag is waiting for my confirmation
--   circle_joined     someone joined a circle I own
--   week_card         the week card of one of my circles is ready (Saturday night)
-- Every one belongs to exactly one circle (notifications.circle_id). Nobody is
-- told about a circle they have left, and nobody is told by a member they have
-- a block with, in either direction, at write time AND at push time.
--
-- Gym-era types, categories and preference keys go: comment, mention, coach,
-- announcement, event, challenge, streak, achievement notifications. The
-- Realtime publication is already gone (0137); the push sender stays.
--
-- circle_id is named circle_id, not club_id, and is nullable on purpose: the
-- schema guard 0137 requires every club_id column to be NOT NULL, and a
-- notification with no circle is simply never pushed (notif_push_pending
-- requires it), which is the fail-closed reading.
--
-- FORWARD ONLY. No applied migration is edited.
begin;

-- 1. Gym-era leftovers ---------------------------------------------------------
delete from public.notifications
 where type not in ('reaction', 'trained_together', 'circle_joined', 'week_card');

-- The reaction preference was keyed 'reactions'; the key is now the type itself.
update public.notification_preferences np
   set type = 'reaction'
 where np.type = 'reactions'
   and not exists (select 1 from public.notification_preferences o
                    where o.user_id = np.user_id and o.type = 'reaction');
delete from public.notification_preferences
 where type not in ('reaction', 'trained_together', 'circle_joined', 'week_card');
alter table public.notification_preferences
  add constraint notification_preferences_circle_types
  check (type in ('reaction', 'trained_together', 'circle_joined', 'week_card'));

drop trigger if exists member_achievements_notify on public.member_achievements;
drop function if exists public.notif_on_achievement();

-- 2. A notification knows its circle and who caused it ---------------------------
alter table public.notifications
  add column circle_id uuid references public.clubs(id) on delete cascade,
  add column actor_id uuid references public.profiles(id) on delete set null;
create index notifications_circle_user_idx on public.notifications(circle_id, user_id)
  where circle_id is not null;

create or replace function public.protect_notification_content()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.allow_moderation_write', true), '') <> 'on' then
    new.user_id = old.user_id;
    new.circle_id = old.circle_id;
    new.actor_id = old.actor_id;
    new.type = old.type;
    new.category = old.category;
    new.title = old.title;
    new.body = old.body;
    new.source_type = old.source_type;
    new.source_id = old.source_id;
    new.deep_link = old.deep_link;
    new.push_sent_at = old.push_sent_at;
    new.created_at = old.created_at;
  end if;
  return new;
end $$;

-- 3. Opt-in. A missing preference row means OFF. -----------------------------------
-- The preference key is the notification type itself.
create or replace function public.notif_pref_key(p_type text)
returns text language sql immutable set search_path = '' as $$
  select p_type;
$$;

create or replace function public.notif_pref_allows(p_user uuid, p_type text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.notification_preferences np
     where np.user_id = p_user
       and np.type = public.notif_pref_key(p_type)
       and np.channel in ('push', 'in_app')
  );
$$;

-- 4. The one immediate insert path ------------------------------------------------
-- Nothing is written unless: the type is one of the four, the recipient is a
-- member of the circle, the actor (if any) is a member too, the two have no
-- block between them, and the recipient turned the type on. An identical
-- (recipient, type, source) inside the dedupe window (one hour) is one event
-- fired twice: this is what makes reactions "one per post per hour".
drop function public.notif_create(uuid, text, text, text, text, text, uuid, text);

create function public.notif_create(
  p_user uuid, p_type text, p_category text, p_title text, p_body text,
  p_source_type text, p_source_id uuid, p_deep_link text,
  p_circle_id uuid default null, p_actor_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := coalesce(p_actor_id, auth.uid());
  v_id uuid;
begin
  if p_user is null then return null; end if;
  if p_type is null
     or p_type not in ('reaction', 'trained_together', 'circle_joined', 'week_card') then
    raise exception 'unknown notification type %', p_type;
  end if;
  if p_category is distinct from 'community' then
    raise exception 'unknown notification category %', p_category;
  end if;
  if p_circle_id is null then
    raise exception 'a notification belongs to a circle';
  end if;

  if v_actor is not null and v_actor = p_user then return null; end if;

  -- The recipient is still in the circle, and so is whoever caused this.
  if not exists (select 1 from public.circle_members m
                  where m.club_id = p_circle_id and m.user_id = p_user) then
    return null;
  end if;
  if v_actor is not null and not exists (
       select 1 from public.circle_members m
        where m.club_id = p_circle_id and m.user_id = v_actor) then
    return null;
  end if;

  if v_actor is not null and exists (
       select 1 from public.blocks b
        where (b.blocker_id = p_user and b.blocked_id = v_actor)
           or (b.blocker_id = v_actor and b.blocked_id = p_user)) then
    return null;
  end if;

  if not public.notif_pref_allows(p_user, p_type) then return null; end if;

  if exists (
    select 1 from public.notifications n
     where n.user_id = p_user
       and n.type = p_type
       and n.source_id is not distinct from p_source_id
       and n.created_at > now() - public.notif_dedupe_window()
  ) then
    return null;
  end if;

  insert into public.notifications
    (user_id, type, category, title, body, source_type, source_id, deep_link, circle_id, actor_id)
  values (
    p_user, p_type, p_category,
    coalesce(left(p_title, 160), ''), coalesce(left(p_body, 500), ''),
    p_source_type, p_source_id, p_deep_link, p_circle_id, v_actor
  )
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.notif_create(uuid, text, text, text, text, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;

-- 5. Triggers ---------------------------------------------------------------------
-- Names go into the body wrapped in bidi isolates, so a Latin name inside a
-- Hebrew sentence does not reorder the sentence.
create or replace function public.notif_on_reaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_post public.workout_posts;
  v_name text;
  v_circle text;
begin
  select * into v_post from public.workout_posts p where p.id = new.post_id;
  if not found or v_post.author_id = new.user_id then return null; end if;
  select pr.display_name into v_name from public.profiles pr where pr.id = new.user_id;
  select c.name into v_circle from public.clubs c where c.id = v_post.club_id;

  perform public.notif_create(
    v_post.author_id, 'reaction', 'community',
    'עידוד חדש על הפוסט שלך',
    chr(8296) || coalesce(v_name, '') || chr(8297) || ' הגיב/ה לפוסט שלך במעגל ' || chr(8296) || coalesce(v_circle, '') || chr(8297),
    'post', new.post_id,
    '/circles?c=' || v_post.club_id::text || '&post=' || new.post_id::text,
    v_post.club_id, new.user_id);
  return null;
end $$;

create or replace function public.notif_on_training_partner_tag()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_post public.workout_posts;
  v_name text;
  v_circle text;
begin
  if new.confirmed_at is not null then return null; end if;
  select * into v_post from public.workout_posts p where p.id = new.post_id;
  if not found then return null; end if;
  select pr.display_name into v_name from public.profiles pr where pr.id = new.tagged_by;
  select c.name into v_circle from public.clubs c where c.id = v_post.club_id;

  perform public.notif_create(
    new.tagged_user_id, 'trained_together', 'community',
    'תיוג לאימון משותף מחכה לאישור שלך',
    chr(8296) || coalesce(v_name, '') || chr(8297) || ' תייג/ה אותך באימון במעגל ' || chr(8296) || coalesce(v_circle, '') || chr(8297),
    'post', new.post_id,
    '/circles?c=' || v_post.club_id::text || '&post=' || new.post_id::text,
    v_post.club_id, new.tagged_by);
  return null;
end $$;

-- Someone joined: the owners of the circle are told (a couple: the other owner).
create or replace function public.notif_on_circle_join()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_circle text;
  r record;
begin
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
create trigger circle_members_notify_join after insert on public.circle_members
  for each row execute function public.notif_on_circle_join();

-- A member who leaves (or is removed) keeps no notification about that circle,
-- and the circle's other members keep none that this member caused.
create or replace function public.circle_members_forget_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.notifications n
   where n.circle_id = old.club_id
     and (n.user_id = old.user_id or n.actor_id = old.user_id);
  return null;
end $$;
create trigger circle_members_forget_notifications_trigger after delete on public.circle_members
  for each row execute function public.circle_members_forget_notifications();

revoke all on function public.notif_on_reaction() from public, anon, authenticated;
revoke all on function public.notif_on_training_partner_tag() from public, anon, authenticated;
revoke all on function public.notif_on_circle_join() from public, anon, authenticated;
revoke all on function public.circle_members_forget_notifications() from public, anon, authenticated;

-- 6. The week card -----------------------------------------------------------------
-- Called hourly (p_now exists only so a test can pick the moment). The week starts Sunday in Asia/Jerusalem and the card is ready
-- Saturday night (21:00); a run missed that night still counts until Sunday
-- noon. A circle with no workout that week sends nothing, and a paused member
-- is not nudged. One notification per member per circle per week: the source id
-- is derived from the circle and the week, and is checked for ever, not just
-- inside the dedupe window.
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
     where (tg.paused_until is null or tg.paused_until < v_today)
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

select cron.schedule('week-card-notify', '17 * * * *', $$select public.notif_week_card_due()$$);

-- 7. Who actually gets a push ------------------------------------------------------
-- All of the filters of 202609170002 (opted in to push, live endpoint, profile
-- not deleted, 24-hour floor) plus the circle rules, re-checked at SEND time:
-- the recipient is still in the circle, so is the actor, no block has appeared
-- since the row was written, and the post the row is about still exists.
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
     and n.circle_id is not null
     and exists (select 1 from public.circle_members m
                  where m.club_id = n.circle_id and m.user_id = n.user_id)
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
     and exists (
       select 1 from public.notification_preferences np
        where np.user_id = n.user_id
          and np.type = public.notif_pref_key(n.type)
          and np.channel = 'push'
     )
     and coalesce(s.keys->>'p256dh', '') <> ''
     and coalesce(s.keys->>'auth', '') <> ''
   order by n.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- 8. Account deletion removes the push subscriptions at once --------------------------
-- Same body as 202609060011, plus the subscriptions: a deleted member must not
-- keep a device that can be pushed to for the 30 days before the purge.
create or replace function public.request_account_deletion() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_deletion_requests(user_id) values (auth.uid())
  on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = auth.uid();
  delete from public.push_subscriptions where user_id = auth.uid();
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts set deleted_at = now() where author_id = auth.uid();
  perform set_config('app.allow_moderation_write', 'off', true);
end $$;

commit;
