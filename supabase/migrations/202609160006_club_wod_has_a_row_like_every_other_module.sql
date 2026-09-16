begin;

-- The forward half of the 202609150016 repair.
--
-- club_wod is the only module key in the product that no migration ever
-- inserted into club_features. Production acquired its row through the
-- admin panel (admin_set_club_feature upserts), which is invisible to a
-- replay - so every fresh database had no row, 202609150016's guard raised,
-- and the migration chain stopped dead. That file now seeds the row itself,
-- because a raising migration aborts the chain and nothing named after it
-- can repair the database that needs repairing.
--
-- This migration exists so the seed is also recorded where every other
-- module's seed is recorded, in forward history, rather than only as an
-- edit to an already-applied file. It is idempotent by construction and is
-- a no-op on any database that has the row - which, after the edit above,
-- is all of them.
--
-- WHAT WOULD HAVE CAUGHT THIS. Nothing in the suite asserts that every
-- module key cloud.js offers a toggle for has a club_features row to toggle.
-- The assertion below is the cheap version of that check, scoped to the key
-- that actually broke: a club_wod row exists and no module key the panel
-- knows about is missing from the table.
insert into public.club_features (module_key, enabled)
values ('club_wod', true)
on conflict (club_id, module_key) do nothing;

do $$
declare
  v_missing text;
begin
  select string_agg(k, ', ') into v_missing
  from unnest(array[
    'announcements', 'events', 'challenges', 'achievements', 'feed', 'leaderboards',
    'directory', 'member_of_week', 'welcome_flow', 'monthly_recap', 'coach_tools',
    'streak_risk_nudges', 'engagement_alerts',
    'weekly_recap', 'comments', 'post_photos', 'mentions', 'outward_share',
    'club_wod', 'new_member_posts'
  ]) as k
  where not exists (
    select 1 from public.club_features cf where cf.module_key = k
  );
  if v_missing is not null then
    raise exception 'club_features is missing a row for: %', v_missing;
  end if;
end $$;

commit;
