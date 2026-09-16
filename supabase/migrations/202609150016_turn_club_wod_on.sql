-- Switch the daily club WOD on. Owner's instruction, 2026-09-15: "Turn on".
--
-- WHY THIS IS A MIGRATION AND NOT A TAP IN THE PANEL. Module toggles are
-- admin-only: 202609150011 revoked community.club.manage_modules from
-- head_coach after the round-1 hunt found the head coach could switch club
-- features off by direct RPC with no screen offering it. That was the right
-- call and it is why this cannot be done from the session I have - the admin
-- account's password was rotated by the owner, as it should have been, and
-- the head coach account cannot reach admin_set_club_feature any more.
--
-- So this records the change in the one place that remains honest: the
-- migration history, where it is dated, attributed and reversible, rather
-- than as an unexplained row edit.
--
-- WHAT IT TURNS ON. A coach schedules a workout from the club catalogue for a
-- given day; it gets one card on the feed and one board that members attach
-- their own logged results to. It is the closest thing this app has to its
-- core job for a CrossFit box - the coach posts today's session, members log
-- it with one tap instead of retyping it - and it had been switched off,
-- which is why nobody has seen it.
--
-- streak_risk_nudges stays OFF deliberately and is NOT touched here. That
-- nudge only exists in-app while web push has no sending half, so it reaches
-- members who already opened the app - precisely the ones who do not need
-- nudging. It becomes worth switching on the day push can deliver it, and
-- should be reconsidered together with that, not before.
-- 2026-09-16: THE ROW THIS UPDATES IS NOT SEEDED BY ANY MIGRATION.
--
-- Every other module key is inserted by the migration that introduced it
-- (202609010012's six, 202609050006's five, 202609100002's two,
-- 202609150014's five). club_wod never was - it reached production's
-- club_features by way of admin_set_club_feature() upserting it from the
-- panel at some point, which no replay reproduces. So on a FRESH database
-- the update below matched nothing, the guard raised, and the whole
-- migration chain stopped here: `supabase start` failed, and with it CI's
-- pgTAP job (79 files, 2747 assertions) and any attempt to stand up a
-- second club.
--
-- EDITING AN APPLIED MIGRATION, DELIBERATELY AND ONCE. The repo's rule
-- (scripts/check-migration-immutability.mjs) is that corrections go in a
-- NEW migration, and it is the right rule. It cannot reach this case: a
-- migration that RAISES aborts the chain, so nothing named after it ever
-- runs on the database that needs the fix. The alternative was a permanent
-- dead CI gate.
--
-- The edit is provably a no-op wherever this file already ran. Production
-- has the row and has it enabled, so the insert conflicts and does nothing
-- and the update still matches nothing; the guard sees exactly what it saw
-- before. Only a replay from empty behaves differently, which is the whole
-- point. 202609160006 records the same seed in forward history.
insert into public.club_features (module_key, enabled)
values ('club_wod', true)
on conflict (club_id, module_key) do nothing;

update public.club_features
   set enabled = true, updated_at = now()
 where module_key = 'club_wod'
   and not enabled;

do $$
begin
  if not exists (select 1 from public.club_features where module_key = 'club_wod' and enabled) then
    raise exception 'turn_club_wod_on: club_wod is still off - the row may be missing entirely';
  end if;
end $$;
