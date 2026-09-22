begin;

-- A management account is not a clubmate.
--
-- THE BUG, from a real phone screenshot at 390px. "ניהול @admin" - the
-- account the gym's owner signs into the admin panel with - sits in the
-- member directory between two real members, with a "מעקב" button beside it.
-- It is also returned by community search, and it is a candidate for
-- "אנשים שאולי תכירו". It has a display name, a handle and a profile row
-- like anybody else, and nothing anywhere distinguished it from a clubmate.
--
-- That is wrong in three separate ways: it invites a member to follow a
-- mailbox that will never post, it makes the club look one member larger
-- than it is, and it tells every member who reads a roster which account the
-- keys to their data are behind.
--
-- WHO COUNTS AS MANAGEMENT. Rank 40 and above in public.roles - staff, admin
-- and owner - plus the legacy profiles.is_admin flag, which my_role_code()
-- already folds in the same way (202608280001). COACH AND HEAD COACH ARE
-- DELIBERATELY NOT MANAGEMENT: they are people a member trains with, the
-- directory already groups them above everyone else on purpose (COMM-160's
-- badge, splitDirectoryStaff in src/community/directory.js), and hiding them
-- would empty the one group the roster exists to show first. The cut is
-- exactly where is_staff() (rank >= 20) stops and the office starts.
--
-- WHO STILL SEES THEM. Staff - is_staff(), so coach and above. A coach
-- looking up the admin account is looking for a colleague, and the whole
-- point of the fix is what a MEMBER is shown. That decision is made in ONE
-- place, hide_management_from_member() below, which answers false for a
-- staff caller, so the client never has to re-derive "am I staff" to agree
-- with the server.
--
-- WHAT THIS MIGRATION CHANGES:
--
--   1. public.is_management_account(uuid) - the predicate, on its own, with
--      no reference to who is asking.
--   2. public.hide_management_from_member(uuid) - (1) AND the caller is not
--      staff. This is the rule; (1) is only its subject.
--   3. public.management_user_ids() - the ids a member must not be shown,
--      as a set. EMPTY for a staff caller, by construction, because it is
--      built on (2). The members directory reads public.profiles directly
--      from the client (there is no directory RPC - see COMM-231), so the
--      client needs the list itself; handing it a list that is already
--      correct for the caller is what keeps the client from carrying a
--      second copy of the staff rule.
--   4. community_search() and people_suggestions(), re-created with one
--      added WHERE clause each and NO other change. Both were taken from
--      the migrations that last defined them (202609060009 and 202608310003
--      respectively) and are otherwise byte-for-byte those files; the added
--      line is marked in each. This is a forward migration - neither of
--      those files is touched.
--
-- WHY BOTH THE FUNCTIONS AND THE ID LIST. They are not two gates for one
-- rule. The directory's read is a plain PostgREST select on public.profiles
-- and there is no server function in front of it to add a clause to, so the
-- id list is the only thing that can gate that surface. The two functions
-- are gated here as well so a management row does not travel to a member's
-- browser at all on the surfaces where that is preventable - the same
-- "defence in depth, not a second real gate" that loadDirectory()'s own
-- visible_to_club filter is already documented as.
--
-- NO TABLE, NO COLUMN, NO POLICY. Nothing here stores anything; every
-- function reads what public.roles, public.invite_redemptions and
-- public.profiles already say. Table, policy and RLS counts are unchanged
-- by this file.

-- 1. The predicate. SECURITY DEFINER for the same reason my_role_code() is:
-- it reads invite_redemptions and profiles rows that are not the caller's,
-- which those tables' own select policies correctly refuse. It returns a
-- boolean about ONE id and never a row, so it discloses nothing beyond the
-- answer to the question asked - and "is this account management" is a fact
-- the directory's coach badge already publishes one rank down.
--
-- MANAGEMENT_RANK is written as a lookup on public.roles, not as the literal
-- 40, so a tier inserted between head_coach and staff later lands on the
-- correct side of this without an edit here - the same reason is_staff()
-- compares role_rank() against a number rather than listing role codes.
create or replace function public.is_management_account(p_uid uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select true
     from public.profiles p
     where p.id = p_uid
       and p.deleted_at is null
       and (
         p.is_admin
         or coalesce(
              public.role_rank((select ir.role from public.invite_redemptions ir where ir.user_id = p.id)),
              0
            ) >= (select r.rank from public.roles r where r.code = 'staff')
       )
    ), false);
$$;
revoke all on function public.is_management_account(uuid) from public, anon;
grant execute on function public.is_management_account(uuid) to authenticated;
comment on function public.is_management_account(uuid) is
  'True when the account holds a role of rank staff (40) or above, or carries the legacy profiles.is_admin flag. Coach and head coach are NOT management. Says nothing about who is asking - hide_management_from_member() is the rule; this is its subject.';

-- 2. The rule. One definition of "this account must not be shown to this
-- caller", read by everything below and, through management_user_ids(), by
-- the client too.
create or replace function public.hide_management_from_member(p_uid uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_management_account(p_uid) and not public.is_staff();
$$;
revoke all on function public.hide_management_from_member(uuid) from public, anon;
grant execute on function public.hide_management_from_member(uuid) to authenticated;
comment on function public.hide_management_from_member(uuid) is
  'The member-facing visibility rule for management accounts: true when p_uid is a management account AND the caller is not staff. The single place that decides; community_search(), people_suggestions() and management_user_ids() all read it.';

-- 3. The set, for the one surface that has no function in front of it.
-- Gated on is_community_member() like every other definer read in
-- 202609060009 - a signed-in account that has not completed recovery setup
-- gets the same refusal here as it does from community_search().
create or replace function public.management_user_ids()
returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profiles p
  where p.deleted_at is null
    and public.is_community_member()
    and public.hide_management_from_member(p.id);
$$;
revoke all on function public.management_user_ids() from public, anon;
grant execute on function public.management_user_ids() to authenticated;
comment on function public.management_user_ids() is
  'The management accounts the CALLER must not be shown, as a set of uuids. Empty for a staff caller and empty for a non-community-member, both by construction. Exists because the members directory (COMM-231) reads public.profiles directly rather than through an RPC, so the client has to do that surface filtering itself; this hands it a list that is already correct for whoever is asking.';

-- 4a. community_search(), from 202609060009, plus one clause.
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

-- 4b. people_suggestions(), from 202608310003, plus one clause.
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
  'COMM-232 people-you-may-know, extended by COMM-302 and by 202609220006. Ranks members by shared live challenge, then shared training days (attendance_log overlap), then shared post interaction (react or comment), then shared going RSVP - lexicographic, so no weaker signal overtakes a stronger one. The last three are measured over a trailing 60 days. Excludes self, any follow edge in either direction, anything can_view_profile_field rejects for visible_to_club or allow_follows (which also settles blocks), and - for a non-staff caller - every management account (hide_management_from_member). The classmate signal is additionally gated on can_view_profile_field(candidate, ''show_attendance''), inside public.classmate_day_counts(), so a member with attendance private contributes none of it. Returns setof jsonb {user_id, display_name, handle, avatar_url, reason, signals{shared_challenges, shared_classmate_days, shared_interactions, shared_events}}; reason is the strongest signal''s label and may now be ''classmate''. p_limit clamped 1..20.';

commit;
