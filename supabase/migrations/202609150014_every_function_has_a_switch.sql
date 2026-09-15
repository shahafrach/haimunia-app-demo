-- Five features that could not be switched off.
-- 2026-09-15, on the owner's instruction: every function in the app should
-- have a toggle in the admin panel.
--
-- club_features rows for the five keys cloud.js's CLUB_MODULE_TOGGLES gained
-- in the same change. admin_set_club_feature() validates only the SHAPE of a
-- module key (^[a-z][a-z0-9_]{2,31}$), not membership of a list, so no server
-- function needs changing - but a row has to exist for the panel to render a
-- switch and for isModuleEnabled() to have something to read. Defaulting to
-- true keeps every club exactly as it is today; the point is that the switch
-- now exists, not that anything changes.
--
-- WEEKLY_RECAP IS THE ONE THAT SHOULD NOT HAVE BEEN MISSING. The monthly club
-- recap has been switchable since it shipped. The weekly one - more frequent,
-- and the one that reaches every member rather than only the club's own
-- summary - never was. Same pair, same kind of surface, one switch between
-- them: the drift shape this hunt has been finding all day, in the feature
-- registry itself.
--
-- All five are enforced CLIENT-SIDE only, and cloud.js marks them clientOnly
-- so the panel does not claim otherwise. They hide a control rather than
-- revoking a permission; the server-side checks each surface always had are
-- unchanged. That is the honest description of what an owner switching off a
-- feature gets: the club stops being offered it.
-- The primary key is (club_id, module_key), and club_id defaults to
-- default_club_id() - so the conflict target must name both, and the insert
-- lets the default supply the club.
insert into public.club_features (module_key, enabled, config)
select k, true, '{}'::jsonb
from unnest(array['weekly_recap', 'comments', 'post_photos', 'mentions', 'outward_share']) as k
on conflict (club_id, module_key) do nothing;
