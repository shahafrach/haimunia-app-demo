-- Weekly target per circle (audit O16, decided 2026-11-07).
--
-- member_targets was one row per person, so a weekly target was the same in
-- every circle although decisions.md lists it under per-circle member
-- settings. The target moves to circle_targets(club_id, user_id): mine only,
-- like member_targets, and it goes when the membership does (the foreign key
-- cascades on leave, removal and account deletion). The pause stays one per
-- person in member_targets.paused_until: a pause is a pause everywhere.
--
-- Existing targets are copied to every circle the member is in, so nobody's
-- percent changes on the day this applies.

create table public.circle_targets (
  club_id       uuid not null,
  user_id       uuid not null,
  weekly_target smallint not null check (weekly_target between 1 and 21),
  updated_at    timestamptz not null default now(),
  primary key (club_id, user_id),
  foreign key (club_id, user_id) references public.circle_members (club_id, user_id) on delete cascade
);
create index circle_targets_user_id_idx on public.circle_targets (user_id);
alter table public.circle_targets enable row level security;
create trigger circle_targets_touch
  before update on public.circle_targets
  for each row execute function public.touch_updated_at();

grant select, insert, update, delete on public.circle_targets to authenticated;
revoke all on public.circle_targets from anon;

-- Mine only. The circle sees a percent through circle_week, never the number.
-- The membership check is the foreign key.
create policy circle_targets_self_select on public.circle_targets for select to authenticated
  using (user_id = auth.uid());
create policy circle_targets_self_insert on public.circle_targets for insert to authenticated
  with check (user_id = auth.uid() and public.is_circle_member(club_id));
create policy circle_targets_self_update on public.circle_targets for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy circle_targets_self_delete on public.circle_targets for delete to authenticated
  using (user_id = auth.uid());

insert into public.circle_targets (club_id, user_id, weekly_target)
select cm.club_id, cm.user_id, mt.weekly_target
  from public.member_targets mt
  join public.circle_members cm on cm.user_id = mt.user_id;

alter table public.member_targets drop column weekly_target;

-- set_weekly_target(integer) is replaced by a version that names the circle.
drop function public.set_weekly_target(integer);
create or replace function public.set_weekly_target(p_club_id uuid, p_target integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_circle_member(p_club_id) then raise exception 'not authorized'; end if;
  if p_target is null or p_target < 1 or p_target > 21 then
    raise exception 'target must be between 1 and 21';
  end if;
  insert into public.circle_targets (club_id, user_id, weekly_target)
  values (p_club_id, auth.uid(), p_target)
  on conflict (club_id, user_id) do update set weekly_target = excluded.weekly_target;
end $$;
revoke all on function public.set_weekly_target(uuid, integer) from public, anon;
grant execute on function public.set_weekly_target(uuid, integer) to authenticated, service_role;

-- A pause no longer invents a target; the circle sees "paused" either way.
create or replace function public.set_pause(p_until date)
returns void language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  if auth.uid() is null or not public.is_community_member() then raise exception 'not authorized'; end if;
  if p_until is not null and (p_until < v_today or p_until > v_today + 180) then
    raise exception 'pause must end within the next 180 days';
  end if;
  insert into public.member_targets (user_id, paused_until)
  values (auth.uid(), p_until)
  on conflict (user_id) do update set paused_until = excluded.paused_until;
end $$;

-- circle_week reads the target of THIS circle. Body otherwise as in 202610250006.
create or replace function public.circle_week(p_club_id uuid)
returns table (
  user_id      uuid,
  display_name text,
  emoji        text,
  workouts     integer,
  target       integer,
  percent      integer,
  paused       boolean,
  weeks_met    integer
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_week date;
begin
  if v_uid is null or not public.is_circle_member(p_club_id) then
    raise exception 'not authorized';
  end if;
  v_week := v_today - extract(dow from v_today)::integer;

  return query
  with m as (
    select cm.user_id as uid, pr.display_name as dn, pr.emoji as em,
           (cm.user_id <> v_uid
            and coalesce((cm.share_defaults ->> 'share_weekly_count')::boolean, true) = false) as hidden
      from public.circle_members cm
      join public.profiles pr on pr.id = cm.user_id
     where cm.club_id = p_club_id and pr.deleted_at is null
  ),
  w as (
    select p.author_id as uid, p.id as pid,
           coalesce(p.occurred_on, (p.published_at at time zone 'Asia/Jerusalem')::date) as d
      from public.workout_posts p
     where p.club_id = p_club_id and p.post_type = 'POST_WORKOUT'
       and p.status = 'active' and p.deleted_at is null
    union
    select t.tagged_user_id, p.id,
           coalesce(p.occurred_on, (p.published_at at time zone 'Asia/Jerusalem')::date)
      from public.post_training_partners t
      join public.workout_posts p on p.id = t.post_id
     where t.club_id = p_club_id and p.club_id = p_club_id and t.confirmed_at is not null
       and p.post_type = 'POST_WORKOUT' and p.status = 'active' and p.deleted_at is null
  ),
  wk as (
    select w.uid, w.d - extract(dow from w.d)::integer as ws, count(*)::integer as c
      from w group by 1, 2
  )
  select m.uid, m.dn, m.em,
         case when m.hidden then null else coalesce(cur.c, 0) end,
         case when m.uid = v_uid then ct.weekly_target::integer end,
         case when m.hidden or ct.weekly_target is null
                   or (tg.paused_until is not null and tg.paused_until >= v_today) then null
              else round(100.0 * coalesce(cur.c, 0) / ct.weekly_target)::integer end,
         (tg.paused_until is not null and tg.paused_until >= v_today),
         case when m.hidden then null
              else (select count(*)::integer from wk
                     where wk.uid = m.uid and ct.weekly_target is not null
                       and wk.c >= ct.weekly_target) end
    from m
    left join public.member_targets tg on tg.user_id = m.uid
    left join public.circle_targets ct on ct.club_id = p_club_id and ct.user_id = m.uid
    left join wk cur on cur.uid = m.uid and cur.ws = v_week
   order by m.dn, m.uid;
end $$;

