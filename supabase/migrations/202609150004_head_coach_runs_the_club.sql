-- The head coach runs the club (2026-09-15), at the club owner's request.
--
-- WHAT CHANGES AND WHY. The admin panel and the head-coach panel are being
-- split into two separate screens, and the head coach's is "everything to do
-- with running the club". Today head_coach holds only the content half of
-- that - announcements, challenges, comment moderation, pinning, events,
-- member restriction, delete-any-post - while the operational half (issuing
-- invites, reading the club's own numbers, switching club modules on and off)
-- is admin-only. A panel that showed those areas without the grants behind
-- them would render a screen full of controls that fail on use, so the grants
-- move with the screen rather than the screen pretending.
--
-- WHAT DELIBERATELY DOES NOT MOVE, and why each one stays with admin:
--   * role changes (admin_grant_coach / admin_set_role) - the ability to
--     appoint staff is the ability to appoint yourself; it stays with the
--     account that answers for the club.
--   * password resets (admin_reset_password) - it hands over a working
--     credential for somebody else's account.
--   * the audit log - a record of staff actions that the staff being recorded
--     should not be the only ones able to read.
--   * bug report triage (bug_report_set_status, 202609150002) - reading is
--     already is_staff(), so a head coach sees every report; closing one is
--     the admin's call.
-- None of those four are permission-gated at all: each is a hardcoded
-- is_admin() inside its own RPC, so this migration cannot widen them by
-- accident even if a future edit added the wrong permission code here.
--
-- THE COACH-ROLE INVITE NARROWING IS UNAFFECTED. 202609030008 added a second
-- gate inside invite_create(): minting a COACH-role invite requires is_admin()
-- specifically, on top of the base permission. Granting community.member.invite
-- here lets a head coach mint MEMBER invites and nothing more - the narrowing
-- that stopped coach/head_coach/staff minting coach-role invites still stands,
-- checked in the function rather than here.

insert into public.role_permissions (role_code, permission_code) values
  -- Issue and manage invites: the single most common club-running task, and
  -- the reason the head-coach panel exists at all.
  ('head_coach', 'community.member.invite'),
  ('head_coach', 'community.invite.manage_codes'),
  -- The club's own numbers. Not personal data: the analytics surfaces are
  -- aggregates, and the ones that are not (coach_inactive_members) keep their
  -- own separate admin gate.
  ('head_coach', 'community.analytics.view'),
  -- Which modules the club runs. This is the "what does this club do"
  -- decision, which is the head coach's job description.
  ('head_coach', 'community.club.manage_modules'),
  -- What a brand-new member reads on their first open. Club content, edited
  -- by whoever runs the club. (Already seeded for head_coach; listed here so
  -- this file states the panel's full requirement in one place rather than
  -- leaving a reader to diff it against three earlier seeds.)
  ('head_coach', 'community.content.manage_onboarding')
on conflict (role_code, permission_code) do nothing;

-- NOT LISTED, deliberately: there is no 'community.pins' permission. The
-- string appears in older migration prose and in the client's PERM map
-- comments, but it was never seeded into public.permissions - the real code
-- for that surface is 'community.content.pin', which head_coach already
-- holds. Writing it here failed the whole insert on a foreign key, which is
-- the constraint doing exactly its job; recorded so the next person reading
-- that prose does not repeat it.

comment on table public.role_permissions is
  'Role -> permission grants. Widened for head_coach in 202609150004 so the head-coach panel''s controls are backed by real grants rather than rendering and then failing: invites (member-role only - 202609030008''s coach-role narrowing is enforced inside invite_create, not here), analytics, club modules, onboarding content. There is no ''community.pins'' permission despite the name appearing in older prose - the real code is ''community.content.pin''. Role changes, password resets, the audit log and bug-report triage stay admin-only and are NOT permission-gated at all - each is a hardcoded is_admin() inside its own RPC, so they cannot be widened from this table.';


-- =====================================================================
-- The audit log was never actually analytics
-- =====================================================================
-- CAUGHT BY 0085's own assertion while widening head_coach above, and worth
-- stating plainly because the comment at the top of this file was WRONG when
-- first written: it claimed the audit log "stays admin-only ... a hardcoded
-- is_admin() inside its own RPC". It is not. admin_actions_page() gates on
-- has_perm('community.analytics.view'), so granting head_coach analytics
-- silently handed them the record of every staff action - including their
-- own - which is the one thing an audit log must not be.
--
-- community.analytics.view was doing double duty. It legitimately gates five
-- analytics readers (analytics_dashboard, retention_cohorts, member_segments,
-- registration_funnel, community_health_history) plus recap_monthly_publish,
-- all of which ARE club-running surfaces a head coach should have. It also
-- gated the audit log, which is not analytics by any reading.
--
-- Split here rather than by withholding analytics from head_coach, because
-- the permission was the thing that was wrong. The new gate is is_admin()
-- (role_rank >= 50), which is BEHAVIOUR-PRESERVING for everyone who had this
-- before today: analytics.view was seeded only to admin (50) and owner (60),
-- both of which is_admin() covers. The only caller that loses access is the
-- head_coach grant added by this very migration, which had not shipped.
--
-- admin_log_password_reset() needed no change - despite mentioning the
-- permission in a comment, it already checks profiles.is_admin directly.
CREATE OR REPLACE FUNCTION public.admin_actions_page(p_cursor timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 25, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS SETOF admin_actions
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_admin() then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  return query
    select a.* from public.admin_actions a
    where (p_cursor is null or a.created_at < p_cursor)
      and (coalesce(p_filters ->> 'action_type', '') = '' or a.action_type = p_filters ->> 'action_type')
      and (coalesce(p_filters ->> 'admin_id', '') = '' or a.admin_id = (p_filters ->> 'admin_id')::uuid)
      and (coalesce(p_filters ->> 'target_user_id', '') = '' or a.target_user_id = (p_filters ->> 'target_user_id')::uuid)
    order by a.created_at desc
    limit v_limit;
end $function$;

comment on function public.admin_actions_page(timestamptz, integer, jsonb) is
  'The audit log reader. Gate changed from has_perm(''community.analytics.view'') to is_admin() in 202609150004: the log is not analytics, and leaving it on that permission meant widening analytics to a role widened the audit log with it - so the staff whose actions are recorded could read the record. Behaviour-preserving for admin and owner, who are the only roles that held analytics.view before that migration.';
