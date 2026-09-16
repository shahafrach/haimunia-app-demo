-- The welcome queue is for members (2026-09-16). Round 10, coach persona.
--
-- coach_new_members() built its `member` CTE from public.profiles filtered only
-- by `deleted_at is null`, with no role filter, and neither
-- renderCoachWelcomeSection() nor renderCoachWelcomeRow() filtered on the
-- client either. So any coach, head coach or admin who joined inside the
-- lookback window appeared in the "קבלת פנים" queue as a green newcomer -
-- including in their own dashboard, beside their own name, with a working
-- "ברכה" button. Reproduced live with a coach and a member redeemed a day
-- apart: both rows rendered identically.
--
-- Not destructive and not a privacy hole, but visibly wrong to every coach on
-- every club that has ever added a second coach, which is every club.
--
-- The body below is the deployed 202609060020 function unchanged except for the
-- two lines in that CTE - the aggregate-not-a-log comment on sessions_logged,
-- the clamp, and the work-queue ordering are all preserved verbatim.

CREATE OR REPLACE FUNCTION public.coach_new_members(p_within_days integer DEFAULT 14)
 RETURNS TABLE(user_id uuid, handle text, display_name text, avatar_url text, joined_on date, days_since_join integer, sessions_logged integer, has_opened_app boolean, last_seen_on date, contacted boolean, contacted_at timestamp with time zone, assigned_coach_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_days integer;
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- Clamped rather than rejected, the same shape coach_celebrate_feed()
  -- (202608290013) uses for p_days: this is a read a dashboard makes on
  -- load, and a bad number is a client bug, not something worth turning
  -- into an error toast in front of a coach. 1..365 because a club's first
  -- year is a legitimate thing to want to look at.
  v_days := least(greatest(coalesce(p_within_days, 14), 1), 365);

  return query
  with member as (
    select
      pr.id,
      pr.handle,
      pr.display_name,
      pr.avatar_url,
      pr.assigned_coach_id,
      coalesce(ir.redeemed_at::date, pr.created_at::date) as joined_on
    from public.profiles pr
    left join public.invite_redemptions ir on ir.user_id = pr.id
    where pr.deleted_at is null
      -- MEMBERS ONLY (202609160003). This CTE filtered on deleted_at alone, so
      -- every coach, head coach and admin whose own join date fell inside the
      -- window appeared in their colleagues' "welcome the new members" queue -
      -- and in their OWN, with a live "send a welcome" button next to their own
      -- name. Found by a coach persona walking the dashboard on a club with
      -- normal staff turnover; wrong on every club that has ever added a coach.
      --
      -- role_rank is the same ranking is_staff()/is_admin() use: member 10,
      -- coach 20 and up. A profile with no redemption row coalesces to 10 and
      -- stays in the list on purpose - that is a genuine new signup mid-flow,
      -- exactly who this queue is for.
      and coalesce(public.role_rank(ir.role), 10) < 20
      and not coalesce(pr.is_admin, false)
  )
  select
    m.id,
    m.handle,
    coalesce(nullif(m.display_name, ''), m.handle),
    m.avatar_url,
    m.joined_on,
    (current_date - m.joined_on),
    -- A COUNT, not a log, and the distinction is load-bearing. PRIVACY.md
    -- promises members that coaches see rates rather than "a detailed log",
    -- and 202609060013 enforced that by taking raw attendance_log reads
    -- away from coach rank. An aggregate count of training days for a
    -- member inside their first few weeks is what COMM-224 specified
    -- ("sessions attended") and discloses no individual session, no date
    -- and no result. It replaces the client's previous stand-in for this
    -- number, community_streaks.current_streak, which counts CONSECUTIVE
    -- DAYS THE MEMBER OPENED THE APP and was being shown beside a new
    -- member's name where a coach would read it as training.
    --
    -- attendance_log is read here rather than through a coach's own grant
    -- precisely because this function is SECURITY DEFINER and can return
    -- the aggregate without handing the coach the rows behind it.
    (select count(*)
       from public.attendance_log al
      where al.user_id = m.id)::integer,
    exists (select 1 from public.activity_pings ap where ap.user_id = m.id),
    (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = m.id),
    exists (select 1 from public.member_contact_log mcl where mcl.user_id = m.id),
    (select max(mcl.contacted_at) from public.member_contact_log mcl where mcl.user_id = m.id),
    m.assigned_coach_id
  from member m
  where m.joined_on >= (current_date - v_days)
  -- Newest first. Within a single day, the members nobody has contacted yet
  -- come before the ones who have already been welcomed, so the list reads
  -- as a work queue rather than as a roster.
  order by
    m.joined_on desc,
    exists (select 1 from public.member_contact_log mcl where mcl.user_id = m.id) asc,
    m.handle asc;
end $$
;
revoke all on function public.coach_new_members(integer) from public, anon;
grant execute on function public.coach_new_members(integer) to authenticated;
comment on function public.coach_new_members(integer) is
  'COMM-224. Members who joined within p_within_days (clamped 1..365), newest first, uncontacted before contacted so it reads as a work queue. MEMBERS ONLY since 202609160003: role_rank(role) < 20 and not is_admin, because staff were appearing in their own welcome queue. A profile with no redemption row counts as a member (rank 10) - that is a genuine signup mid-flow. AUTH: security definer, is_staff(). sessions_logged is an aggregate COUNT over attendance_log, never the rows behind it - see PRIVACY.md. Read-only.';
