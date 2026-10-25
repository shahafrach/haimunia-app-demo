-- Circles RPCs, part 3: the weekly view and the circle feed.
--
-- circle_week is the circle screen's numbers: per member, workouts this week,
-- percent of their own target, paused, and how many weeks the target was met.
-- Never a ranking, never a streak. The week starts Sunday, Asia/Jerusalem, for
-- everyone (decisions.md: Distribution).
--
-- circle_feed is the circle's posts, newest first, with PRs that went a day
-- without a reaction flagged so the client can lift them to the top.
--
-- FORWARD ONLY. No applied migration is edited.
begin;

-- A "workout" is a POST_WORKOUT in this circle: the member's own, plus the ones
-- they were tagged on and CONFIRMED (a pending tag counts for nobody). Weeks
-- met is counted against the member's current target. A member who does not
-- share a weekly count with the circle (share_weekly_count false) shows nothing
-- numeric to the others; a paused member shows "paused" and no percent.
-- Only the caller's own row carries the target itself.
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
         case when m.uid = v_uid then tg.weekly_target::integer end,
         case when m.hidden or tg.weekly_target is null
                   or (tg.paused_until is not null and tg.paused_until >= v_today) then null
              else round(100.0 * coalesce(cur.c, 0) / tg.weekly_target)::integer end,
         (tg.paused_until is not null and tg.paused_until >= v_today),
         case when m.hidden then null
              else (select count(*)::integer from wk
                     where wk.uid = m.uid and tg.weekly_target is not null
                       and wk.c >= tg.weekly_target) end
    from m
    left join public.member_targets tg on tg.user_id = m.uid
    left join wk cur on cur.uid = m.uid and cur.ws = v_week
   order by m.dn, m.uid;
end $$;

-- The circle's posts, newest first, a page at a time: pass the last
-- published_at you were given as p_cursor. INVOKER, so the posts, reactions and
-- profiles policies are what limit the rows; the explicit membership check
-- only turns an empty page into a refusal.
create or replace function public.circle_feed(
  p_club_id uuid, p_cursor timestamptz default null, p_limit integer default 30)
returns table (
  post_id         uuid,
  author_id       uuid,
  author_name     text,
  author_emoji    text,
  post_type       public.post_type,
  title           text,
  result_text     text,
  body            text,
  metadata        jsonb,
  occurred_on     date,
  published_at    timestamptz,
  reaction_counts jsonb,
  my_reactions    text[],
  unreacted_pr    boolean
)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not public.is_circle_member(p_club_id) then
    raise exception 'not authorized';
  end if;

  return query
  select p.id, p.author_id, pr.display_name, pr.emoji, p.post_type, p.title, p.result_text,
         p.body, p.metadata, p.occurred_on, p.published_at,
         coalesce((select jsonb_object_agg(x.kind, x.n)
                     from (select r.kind, count(*) as n
                             from public.reactions r where r.post_id = p.id
                            group by r.kind) x), '{}'::jsonb),
         coalesce((select array_agg(r.kind order by r.kind)
                     from public.reactions r
                    where r.post_id = p.id and r.user_id = auth.uid()), array[]::text[]),
         -- A PR a day old that nobody but its author has reacted to.
         (p.post_type = 'POST_PR'
          and p.published_at < now() - interval '1 day'
          and not exists (select 1 from public.reactions r
                           where r.post_id = p.id and r.user_id <> p.author_id))
    from public.workout_posts p
    join public.profiles pr on pr.id = p.author_id
   where p.club_id = p_club_id
     and p.deleted_at is null and p.status = 'active'
     and (p_cursor is null or p.published_at < p_cursor)
   order by p.published_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), 50);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.circle_week(uuid)',
    'public.circle_feed(uuid, timestamptz, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

commit;
