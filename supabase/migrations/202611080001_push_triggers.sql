-- Push triggers (Home port, feature 1).
--
--   * reaction: ON by default (a missing preference row now means on for this one type; an explicit
--     'off' row still turns it off). Every other type stays opt-in.
--   * pr_circle: a circle member's new personal record, to the other members of that circle. Names the
--     member only: no lift, no weight (what a member shares is decided by their own share settings).
--   * workout_reminder: personal, at a time and on days the member chooses (reminder_prefs). Content-free:
--     the server never sees the private training log, so it cannot know whether you already trained.
--   * weekly_digest: type allowed here, scheduled in the next migration.
-- Personal types have no circle (notifications.circle_id is null), category 'training'.
-- The comment type from the brief does not exist: decisions.md has no text comments, only reactions.
--
-- FORWARD ONLY. The functions below are re-created whole from 202610260001 with the change marked.
begin;

alter table public.notification_preferences drop constraint notification_preferences_circle_types;
alter table public.notification_preferences
  add constraint notification_preferences_circle_types
  check (type in ('reaction', 'trained_together', 'circle_joined', 'week_card', 'pr_circle', 'workout_reminder', 'weekly_digest'));

create or replace function public.notif_pref_allows(p_user uuid, p_type text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.notification_preferences np
     where np.user_id = p_user
       and np.type = public.notif_pref_key(p_type)
       and np.channel in ('push', 'in_app')
  ) or (p_type = 'reaction' and not exists (
    select 1 from public.notification_preferences np
     where np.user_id = p_user and np.type = 'reaction'));
$$;

-- CHANGE: 'pr_circle' joins the allowed list.
create or replace function public.notif_create(
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
     or p_type not in ('reaction', 'trained_together', 'circle_joined', 'week_card', 'pr_circle') then
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

-- CHANGE: personal types need no circle; reaction counts as push when it has no row (default on).
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
     and (n.circle_id is not null or n.type in ('workout_reminder', 'weekly_digest'))
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
     and (exists (
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


-- A circle member's new personal record reaches the rest of the circle.
create or replace function public.notif_on_pr_post()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_circle text;
  r record;
begin
  if new.post_type <> 'POST_PR' or new.status <> 'active' or new.deleted_at is not null then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'active' then return null; end if;
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

create trigger workout_posts_notify_pr
  after insert or update of status on public.workout_posts
  for each row execute function public.notif_on_pr_post();

-- When the workout reminder fires. Days are 0 (Sunday) to 6, Asia/Jerusalem; the time is on a 15-minute grid.
create table public.reminder_prefs (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  workout_days   smallint[] not null default '{}'
                 check (workout_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[] and cardinality(workout_days) <= 7),
  workout_hour   smallint not null default 18 check (workout_hour between 0 and 23),
  workout_minute smallint not null default 0 check (workout_minute in (0, 15, 30, 45)),
  updated_at     timestamptz not null default now()
);
alter table public.reminder_prefs enable row level security;
create policy reminder_prefs_select on public.reminder_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy reminder_prefs_insert on public.reminder_prefs for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy reminder_prefs_update on public.reminder_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy aal2_required on public.reminder_prefs as restrictive for all to authenticated
  using ((select public.aal_satisfied())) with check ((select public.aal_satisfied()));
revoke all on public.reminder_prefs from public, anon, authenticated;
grant select, insert, update on public.reminder_prefs to authenticated;
grant select on public.reminder_prefs to service_role;

-- Personal reminders, called every 15 minutes by pg_cron. One row per member per day per kind (the source id
-- is a hash of member + kind + day, so a repeated run is a no-op). Delivery is notif_push_pending / notif_push_send.
create or replace function public.reminder_push_due(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_local timestamp := coalesce(p_now, now()) at time zone 'Asia/Jerusalem';
  v_today date := v_local::date;
  v_dow integer := extract(dow from v_local)::integer;
  v_slot integer := extract(hour from v_local)::integer * 60 + (extract(minute from v_local)::integer / 15) * 15;
  v_sid uuid;
  v_written integer := 0;
  r record;
begin
  for r in
    select rp.user_id
      from public.reminder_prefs rp
      join public.profiles pr on pr.id = rp.user_id and pr.deleted_at is null
     where v_dow = any (rp.workout_days)
       and rp.workout_hour * 60 + rp.workout_minute between v_slot and v_slot + 14
       and public.notif_pref_allows(rp.user_id, 'workout_reminder')
  loop
    v_sid := md5(r.user_id::text || ':workout:' || v_today::text)::uuid;
    if exists (select 1 from public.notifications n
                where n.user_id = r.user_id and n.type = 'workout_reminder' and n.source_id = v_sid) then
      continue;
    end if;
    insert into public.notifications (user_id, type, category, title, body, source_type, source_id, deep_link)
    values (r.user_id, 'workout_reminder', 'training', 'זמן לאימון',
            'הגיע הזמן שבחרתם לאימון. נתראה בסט הראשון.', 'reminder', v_sid, '/tab/add');
    v_written := v_written + 1;
  end loop;
  return v_written;
end $$;
revoke all on function public.reminder_push_due(timestamptz) from public, anon, authenticated;
grant execute on function public.reminder_push_due(timestamptz) to service_role;

select cron.schedule('reminder-push', '2,17,32,47 * * * *', $$select public.reminder_push_due()$$);

commit;
