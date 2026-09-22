begin;

-- SEVEN SWITCHES THAT ARRIVE BEFORE THE FEATURES THEY SWITCH.
--
-- The usual order in this repository is the opposite one: a feature ships,
-- an audit finds it has no off switch, and a migration adds the key
-- (202609150014 added five that way, 202609160004 and 202609170003 one
-- each). These seven go the other way round on purpose. Each names a
-- feature a later branch will build, and having the key in place first
-- means the branch that builds it wires one `isModuleEnabled()` gate and is
-- done - it does not also have to add a migration, which is the one file
-- this repository cannot have two open branches touching at once
-- (CLAUDE.md, "Parallel work"). One migration now costs less than seven
-- serialised ones later.
--
--   coach_tasks           a task list a coach works through
--   onboarding_challenge  a first challenge offered to a new member
--   benchmarks            the named benchmark workouts (Fran, Grace, ...)
--   strength_percentages  %1RM working weights off a member's own lifts
--   gym_display           a read-only screen shown on the gym wall
--   owner_report          a periodic report for whoever owns the club
--   arbox_attendance      attendance read from Arbox, the booking system
--
-- DISABLED, and that is the whole difference from every earlier seed.
--
-- 202609010012's own comment states the rule the others follow: "a migration
-- must never silently turn something off for a live club." That rule is
-- about a feature members already have. Nothing here exists yet, so there is
-- nothing to take away, and `false` is the only honest starting value: a key
-- that arrived enabled would claim the club had the feature switched on
-- while no code anywhere reads it.
--
-- It also means the branch that later builds one of these ships it OFF, and
-- the admin turns it on when the club is ready - which is the sequence the
-- club has asked for every time so far, and the reverse of club_wod, which
-- ran for weeks before anyone noticed it had no switch at all.
--
-- WHAT THESE KEYS DO NOT DO. `club_feature_enabled()` is not called for any
-- of them by any policy or function in this schema, and there is no RLS
-- clause to extend, because there is no table behind them. Turning one on
-- or off today changes nothing anywhere. The admin panel marks every one of
-- the seven `בפיתוח` for exactly that reason, and marks them UI-only
-- (`clientOnly`) rather than letting the panel's blanket "enforced on the
-- server" line cover a row where it would be false. The branch that builds
-- the feature is the one that decides whether its gate is a client hide or
-- a real RLS predicate, and updates that marker to match.
insert into public.club_features (module_key, enabled)
select k, false
from unnest(array[
  'coach_tasks',
  'onboarding_challenge',
  'benchmarks',
  'strength_percentages',
  'gym_display',
  'owner_report',
  'arbox_attendance'
]) as k
-- do nothing, never `do update`: if a key here somehow already has a row,
-- it got it from admin_set_club_feature() - an admin's explicit choice -
-- and a migration must not overwrite that. Also what makes this file a
-- no-op on a replay.
on conflict (club_id, module_key) do nothing;

-- The same guard 202609160006 introduced, re-stated over the full key list
-- rather than edited into that file (it is applied; corrections and
-- extensions go forward only). A module key the panel offers with no row
-- behind it renders a switch that writes nothing, which is the defect
-- 202609160006 was written after.
do $$
declare
  v_missing text;
begin
  select string_agg(k, ', ') into v_missing
  from unnest(array[
    -- 202609010012
    'announcements', 'events', 'challenges', 'achievements', 'feed', 'leaderboards',
    -- 202609050006
    'directory', 'member_of_week', 'welcome_flow', 'monthly_recap', 'coach_tools',
    -- 202609100002
    'streak_risk_nudges', 'engagement_alerts',
    -- 202609150014
    'weekly_recap', 'comments', 'post_photos', 'mentions', 'outward_share',
    -- 202609150016 / 202609160006
    'club_wod',
    -- 202609160004
    'new_member_posts',
    -- 202609170003. Absent from 202609160006's list, which predates it.
    'push_notifications',
    -- this migration
    'coach_tasks', 'onboarding_challenge', 'benchmarks', 'strength_percentages',
    'gym_display', 'owner_report', 'arbox_attendance'
  ]) as k
  where not exists (
    select 1 from public.club_features cf where cf.module_key = k
  );
  if v_missing is not null then
    raise exception 'club_features is missing a row for: %', v_missing;
  end if;
end $$;

-- And the half the older guard cannot check: these seven must be OFF. A
-- replay that somehow enabled them would mean a later branch's feature
-- switched itself on for the club the day it merged.
do $$
declare
  v_on text;
begin
  select string_agg(cf.module_key, ', ') into v_on
  from public.club_features cf
  where cf.module_key in (
    'coach_tasks', 'onboarding_challenge', 'benchmarks', 'strength_percentages',
    'gym_display', 'owner_report', 'arbox_attendance'
  ) and cf.enabled;
  if v_on is not null then
    raise exception 'these modules have no feature behind them yet and must start off: %', v_on;
  end if;
end $$;

commit;
