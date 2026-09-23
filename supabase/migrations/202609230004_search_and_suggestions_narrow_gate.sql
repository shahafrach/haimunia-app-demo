-- The narrower gate for search and suggestions.
--
-- 202609230003 gated every remaining definer path on its module switch and
-- deliberately stopped short of these two, with this note:
--
--     NOT IN SCOPE, and deliberately. community_search() and
--     people_suggestions() reference events, but they are search and
--     suggestion surfaces rather than event features; gating either whole
--     function on `events` would empty a member's search because the club
--     switched events off.
--
-- That reasoning is right about the WHOLE-FUNCTION gate and wrong as a place
-- to stop. Both functions keep their module data in a slot that can be emptied
-- on its own, so there is a gate that removes exactly the rows the switch is
-- about and touches nothing else.
--
-- WHY IT IS NOT "LEAVE THEM AND REWORD THE PANEL". The panel claims
-- "נאכף בשרת - גם מי שיעקוף את המסך לא יקבל את המידע". With events off, a
-- member who called community_search directly still got every matching event's
-- title, type, status and start time, and people_suggestions still ranked
-- clubmates by event co-attendance and returned shared_events alongside a
-- reason of 'event'. That is the module's data reaching a member through a
-- surface the switch does not cover, which is the claim failing, not a
-- different feature. 202609230003 removed "חלקית" from the four rows on the
-- strength of gating everything that was left; these two were what was left.
--
-- WHAT EACH GATE DOES, and why neither empties anything:
--
--   community_search() returns jsonb_build_object('members', 'events',
--   'challenges'). The gate goes in the events and challenges subqueries, so
--   the corresponding key coalesces to '[]' and the MEMBERS key - the reason
--   a member opens search - is untouched. Searching with every module off
--   still finds people.
--
--   people_suggestions() unions four signals: same live challenge, same
--   training days, same post interactions, same event attendance. The gate
--   goes in the challenge signal and the event signal, so each contributes
--   zero when its module is off and the other signals still produce
--   suggestions. n_challenges / n_events fall to 0 and the reason falls
--   through to whichever signal is strongest, which is what the scoring
--   already does for a member who has no events in common with anyone.
--
-- The challenges gate is included because it is the same bug: challenges is a
-- module switch too, and both functions carry challenge-derived rows. Fixing
-- only the one named in the earlier note would have left its twin one slot
-- over, which is this codebase's characteristic defect.
--
-- Bodies are the current definitions from 202609220006 with the gate clauses
-- added and nothing else changed. create or replace preserves grants; the
-- revoke/grant pair from that migration is repeated to keep the file
-- self-describing, and the comments are re-issued to name the new behaviour.

begin;

-- 1. community_search(): the events and challenges slots, not the function.
CREATE OR REPLACE FUNCTION public.community_search(p_query text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_q text;
  v_limit int;
  v_pattern text;
  v_members jsonb;
  v_events jsonb;
  v_challenges jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  -- Same sanitization searchPeople (cloud.js) already does client-side
  -- before building its ilike pattern: strip %, _, comma and parens so a
  -- raw query cannot turn into an unintended wildcard or break the
  -- concatenated pattern. Replicated here because this function receives
  -- the raw string over RPC, not the client's already-sanitized copy.
  v_q := btrim(regexp_replace(coalesce(p_query, ''), '[%_,()]', '', 'g'));
  v_limit := greatest(1, least(coalesce(p_limit, 10), 50));

  -- Matches searchPeople's existing client-side threshold: under 2
  -- characters is empty results, not a query, and not an error.
  if char_length(v_q) < 2 then
    return jsonb_build_object(
      'members', '[]'::jsonb,
      'events', '[]'::jsonb,
      'challenges', '[]'::jsonb
    );
  end if;

  v_pattern := '%' || v_q || '%';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'handle', m.handle,
    'display_name', m.display_name,
    'bio', m.bio,
    'avatar_url', m.avatar_url,
    'allow_follows', m.allow_follows
  )), '[]'::jsonb)
  into v_members
  from (
    select p.id, p.handle, p.display_name, p.bio, p.avatar_url, p.allow_follows
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_uid
      and (p.handle ilike v_pattern or p.display_name ilike v_pattern)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = v_uid and b.blocked_id = p.id)
           or (b.blocker_id = p.id and b.blocked_id = v_uid)
      )
      and (p.visible_to_club or public.is_admin())
      -- THE ONE ADDED LINE. Everything else in this function is byte-for-byte
      -- what 202609060009 shipped. See this migration's header.
      and not public.hide_management_from_member(p.id)
    order by p.display_name nulls last, p.handle
    limit v_limit
  ) m;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ev.id,
    'title', ev.title,
    'event_type', ev.event_type,
    'status', ev.status,
    'start_at', ev.start_at
  )), '[]'::jsonb)
  into v_events
  from (
    select e.id, e.title, e.event_type, e.status, e.start_at
    from public.events e
    where e.title ilike v_pattern
    and public.club_feature_enabled('events')
      and (
        e.status <> 'draft'
        or e.created_by = v_uid
        or public.has_perm('community.event.manage')
      )
    order by e.start_at asc
    limit v_limit
  ) ev;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'title', c.title,
    'challenge_type', c.challenge_type,
    'status', c.status,
    'start_at', c.start_at,
    'end_at', c.end_at
  )), '[]'::jsonb)
  into v_challenges
  from (
    select ch.id, ch.title, ch.challenge_type, ch.status, ch.start_at, ch.end_at
    from public.challenges ch
    where ch.title ilike v_pattern
    and public.club_feature_enabled('challenges')
      and (
        ch.status <> 'draft'
        or ch.created_by = v_uid
        or public.has_perm('community.challenge.create')
      )
    order by ch.end_at desc
    limit v_limit
  ) c;

  return jsonb_build_object('members', v_members, 'events', v_events, 'challenges', v_challenges);
end $function$;
revoke all on function public.community_search(text, integer) from public, anon;
grant execute on function public.community_search(text, integer) to authenticated;

comment on function public.community_search(text, integer) is
  'Member-facing search over members, events and challenges. Definer, authenticated only, and it drops what the caller may not see: draft events and challenges unless the caller created them or holds the matching permission, and management accounts unless the caller is staff (202609220006, hide_management_from_member). Since 202609230004 the events slot is gated on club_feature_enabled(''events'') and the challenges slot on ''challenges'', so a switched-off module contributes an empty array rather than its rows. The members slot is NEVER gated - it is why a member opens search, and emptying it was the reason 202609230003 left this function alone.';

-- 2. people_suggestions(): the challenge and event SIGNALS, not the function.
create or replace function public.people_suggestions(p_limit int default 10)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_since timestamptz;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if public.my_role_code() is null then raise exception 'not authorized'; end if;

  v_limit := greatest(1, least(coalesce(p_limit, 10), 20));
  v_since := now() - interval '60 days';

  return query
  with signals as (
    -- Signal 1: both in the same live challenge.
    select cp2.user_id as cand, 'challenge'::text as signal,
           count(distinct cp2.challenge_id)::integer as n
    from public.challenge_participants cp1
    join public.challenge_participants cp2
      on cp2.challenge_id = cp1.challenge_id
     and cp2.user_id <> cp1.user_id
    join public.challenges ch on ch.id = cp1.challenge_id
    where cp1.user_id = v_uid
      and cp1.status <> 'withdrawn'
      and cp2.status <> 'withdrawn'
      and ch.status = 'active'
      and ch.end_at >= now()
      and public.club_feature_enabled('challenges')
    group by cp2.user_id

    union all

    -- Signal 2 (COMM-302): both trained on the same days. The count is
    -- calendar days the two members both logged a session inside the same
    -- trailing 60 days, already deduplicated to one day per member per day by
    -- attendance_log's unique key. The whole branch - window, overlap and the
    -- show_attendance gate - is classmate_day_counts(), which feed_page calls
    -- too, so the two functions cannot come to different answers about who
    -- trains with whom.
    select c.user_id, 'classmate'::text, c.shared_days
    from public.classmate_day_counts() c

    union all

    -- Signal 3: both reacted to or commented on the same post. 'open',
    -- 'hide', 'save' and 'profile_open' are telemetry, not engagement with
    -- another member, so they are not overlap.
    select fi2.user_id, 'interaction'::text,
           count(distinct fi2.post_id)::integer
    from public.feed_interactions fi1
    join public.feed_interactions fi2
      on fi2.post_id = fi1.post_id
     and fi2.user_id <> fi1.user_id
    where fi1.user_id = v_uid
      and fi1.kind in ('react', 'comment')
      and fi2.kind in ('react', 'comment')
      and fi1.created_at >= v_since
      and fi2.created_at >= v_since
    group by fi2.user_id

    union all

    -- Signal 4: both said going to the same event. 'interested' is not
    -- showing up, so it is not shared attendance of any kind.
    select ea2.user_id, 'event'::text,
           count(distinct ea2.event_id)::integer
    from public.event_attendees ea1
    join public.event_attendees ea2
      on ea2.event_id = ea1.event_id
     and ea2.user_id <> ea1.user_id
    where ea1.user_id = v_uid
      and ea1.response = 'going'
      and ea2.response = 'going'
      and ea1.registered_at >= v_since
      and ea2.registered_at >= v_since
      and public.club_feature_enabled('events')
    group by ea2.user_id
  ),
  scored as (
    select s.cand,
           coalesce(sum(s.n) filter (where s.signal = 'challenge'), 0)::integer as n_challenges,
           coalesce(sum(s.n) filter (where s.signal = 'classmate'), 0)::integer as n_classmate_days,
           coalesce(sum(s.n) filter (where s.signal = 'interaction'), 0)::integer as n_interactions,
           coalesce(sum(s.n) filter (where s.signal = 'event'), 0)::integer as n_events
    from signals s
    group by s.cand
  ),
  eligible as (
    select sc.cand, sc.n_challenges, sc.n_classmate_days, sc.n_interactions, sc.n_events,
           p.display_name, p.handle, p.avatar_url
    from scored sc
    join public.profiles p on p.id = sc.cand
    where sc.cand <> v_uid
      -- An existing edge in either direction is not a suggestion: one way
      -- means the caller already acted, the other means the strip would
      -- suggest someone already in their orbit.
      and not exists (
        select 1 from public.follows f
        where (f.follower_id = v_uid and f.followed_id = sc.cand)
           or (f.follower_id = sc.cand and f.followed_id = v_uid)
      )
      and public.can_view_profile_field(sc.cand, 'visible_to_club')
      and public.can_view_profile_field(sc.cand, 'allow_follows')
      -- THE ONE ADDED LINE. Everything else is byte-for-byte 202608310003.
      and not public.hide_management_from_member(sc.cand)
  )
  select jsonb_build_object(
    'user_id', e.cand,
    'display_name', e.display_name,
    'handle', e.handle,
    'avatar_url', e.avatar_url,
    'reason', case
                when e.n_challenges > 0 then 'challenge'
                when e.n_classmate_days > 0 then 'classmate'
                when e.n_interactions > 0 then 'interaction'
                else 'event'
              end,
    'signals', jsonb_build_object(
      'shared_challenges', e.n_challenges,
      'shared_classmate_days', e.n_classmate_days,
      'shared_interactions', e.n_interactions,
      'shared_events', e.n_events
    )
  )
  from eligible e
  order by e.n_challenges desc,
           e.n_classmate_days desc,
           e.n_interactions desc,
           e.n_events desc,
           coalesce(nullif(btrim(e.display_name), ''), e.handle) asc,
           e.cand asc
  limit v_limit;
  -- No signal, no row. A brand new member gets zero suggestions and
  -- COMM-232's honest empty state, never a padded list of strangers. That is
  -- unchanged by the fourth signal: a member with zero overlap on all four
  -- still gets no card, not a padded one.
end $$;

revoke all on function public.people_suggestions(int) from public, anon;
grant execute on function public.people_suggestions(int) to authenticated;

comment on function public.people_suggestions(int) is
  'Who a member might know: candidates scored over four signals - same live challenge, same training days (classmate_day_counts), same post interactions, same event attendance - excluding existing edges, blocks and management accounts (202609220006). Since 202609230004 the challenge signal is gated on club_feature_enabled(''challenges'') and the event signal on ''events''. A gated signal contributes zero rather than removing the candidate, so suggestions survive with any subset of modules on; shared_challenges / shared_events read 0 and the reason falls through to the strongest remaining signal, exactly as it already did for a member with nothing in common on that axis.';

commit;
