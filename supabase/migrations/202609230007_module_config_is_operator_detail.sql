-- Nice-to-have N2. A module's config is operator detail, not member detail.
--
-- club_features_read (202609010012:43) is `using (true)` for every
-- authenticated caller, and the grant is on the whole table. The row shape is
-- (module_key, enabled, config), so any member who calls PostgREST directly
-- reads config too. Today that is:
--
--   coach_tasks       welcome_from_day, welcome_by_day, first_class_followup_days,
--                     low_attendance_min_sessions, low_attendance_window_days,
--                     checkin_day, no_contact_days, onboarding_window_days
--   onboarding_challenge  goal_sessions, offer_within_days, window_days
--   owner_report      strong_start_sessions
--   feed              coach_top_hours
--
-- None of it is catastrophic on its own. Together it is the club's operating
-- policy: exactly how many sessions in how many days marks you as attendance-
-- risk, how long after joining a coach is told to greet you, how many days of
-- silence flags you for contact, and what counts as a strong start in the
-- report the owner reads. A member who knows the thresholds can sit just
-- inside them, and a member who reads "low_attendance_min_sessions: 2" learns
-- the club is watching a number nobody told them about. Neither is a breach;
-- both are the club's business rather than the floor's.
--
-- WHY NOT AN RLS POLICY. RLS filters ROWS. This is a COLUMN, and the rows
-- themselves must stay readable - every gated surface in the client needs
-- module_key and enabled, and hiding a row would make isModuleEnabled() fall
-- back to true and quietly re-enable a switched-off module (club_feature_
-- enabled's own comment explains why a missing row means "on"). So the fix is
-- a column privilege plus a reader that decides, not a row policy.
--
-- WHAT THIS DOES:
--   1. Revokes SELECT (config) from authenticated. Nobody reads that column
--      through PostgREST any more - not a member, not staff, not the admin
--      panel. The remaining columns keep their grant and their `using (true)`
--      policy, so nothing that reads module_key/enabled changes at all.
--   2. Adds club_features_for_caller(), SECURITY DEFINER, which returns every
--      row with config masked to '{}'::jsonb unless the caller is staff. It is
--      the ONLY read path to config, which makes the decision one line in one
--      place rather than a rule each new surface has to remember.
--
-- club_feature_enabled() and admin_set_club_feature() are untouched: both are
-- SECURITY DEFINER and read the table as its owner, so the revoke does not
-- reach them. That matters more than it looks - club_feature_enabled() is what
-- every gated RLS policy and definer function calls, and if the revoke had
-- reached it, switching a module off would have started raising instead of
-- gating.
--
-- is_staff() is rank >= 20, which is coach and above. A coach is the audience
-- for a coach-task threshold, so the cut is there rather than at admin: the
-- thresholds describe work coaches do, and a coach who cannot see the window
-- they are being measured against cannot reason about their own queue.

begin;

-- 1. The column leaves the client's reach entirely.
--
-- AND IT HAS TO BE DONE IN TWO STEPS, which the first version of this file got
-- wrong. 202609010012 issued `grant select on public.club_features`, a
-- TABLE-level privilege, and Postgres does not let you subtract a column from
-- one: `revoke select (config)` against a table-level grant is accepted,
-- changes nothing, and reports no error. The pgTAP assertion on
-- has_column_privilege is what caught it - the migration "succeeded" and the
-- column was still world-readable.
--
-- So: drop the table-level grant, then grant the columns members may read. Any
-- column added to this table in future is NOT granted by default, which is the
-- safer direction for a table whose whole problem was a grant that covered
-- more than anyone intended.
revoke select on public.club_features from authenticated;
grant select (club_id, module_key, enabled, updated_by, updated_at)
  on public.club_features to authenticated;

-- 2. One reader, which decides.
create or replace function public.club_features_for_caller()
returns table (module_key text, enabled boolean, config jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select cf.module_key,
         cf.enabled,
         -- The mask is '{}' rather than null so every caller gets the same
         -- SHAPE. A client that has to branch on null before reading a config
         -- is a client that will forget to, and the empty object is already
         -- what the loader coalesces a missing config to.
         case when public.is_staff() then coalesce(cf.config, '{}'::jsonb)
              else '{}'::jsonb
         end as config
    from public.club_features cf
   where cf.club_id = public.default_club_id()
   order by cf.module_key;
$$;

revoke all on function public.club_features_for_caller() from public, anon;
grant execute on function public.club_features_for_caller() to authenticated;

comment on function public.club_features_for_caller() is
  'The client''s only read path for club_features. Returns every module row for the default club - module_key, enabled, and config - with config masked to ''{}'' unless is_staff() (rank >= 20, coach and above). N2: club_features_read is ''using (true)'' and the grant covered the whole row, so any member reading PostgREST directly got the club''s operating thresholds: how few sessions in how many days marks attendance risk, how long after joining a coach is told to greet them, what counts as a strong start in the owner''s report. RLS could not fix it because it filters rows and this is a column - and hiding the ROW would be worse, since club_feature_enabled() treats a missing row as ON and a switched-off module would quietly come back. So SELECT (config) is revoked from authenticated and this is the one place that decides who sees it. Not used by club_feature_enabled() or admin_set_club_feature(), which are definer and read the table as owner.';

commit;
