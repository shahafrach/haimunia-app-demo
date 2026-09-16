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
