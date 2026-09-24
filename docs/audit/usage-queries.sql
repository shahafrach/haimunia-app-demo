-- ===========================================================================
-- Module usage queries — "which modules do members actually use?"
-- ===========================================================================
--
-- Paste one numbered block at a time into the Supabase SQL editor. Every
-- statement in this file is a SELECT. There is no INSERT, UPDATE, DELETE,
-- CREATE, ALTER or GRANT anywhere in it, and nothing here creates a view or a
-- function: it is a reading instrument, not a migration.
--
-- WHO CAN RUN IT. The SQL editor runs as `postgres`, which bypasses RLS. That
-- matters, because three of the tables read below are unreadable to an
-- ordinary session: `analytics_events` needs `community.analytics.view`
-- (202608280012), `activity_pings` is own-row only (202608270001), and
-- `attendance_log` has no SELECT policy for any client role at all
-- (202608310001). Run these in the editor, not from the app.
--
-- SINGLE CLUB. Every table here carries `club_id default default_club_id()`
-- and the product is one gym, so no query filters on it. Add
-- `and club_id = public.default_club_id()` if that ever stops being true.
--
-- WEEKS are Monday-based and resolve in the session's TimeZone (UTC in the
-- editor). That is deliberately the same convention `analytics_week_buckets()`
-- (202609010006) already uses, and it carries the same known discrepancy that
-- function records: metrics.md's WCAM section says week boundaries should
-- follow the club's local week, and no function in this module implements
-- that. These queries do not introduce a third opinion about time zones.
--
-- SOURCE OF THE MAP: `EVENTS` in `src/analytics.js` (the allow-list — the
-- table's own CHECK only enforces name *shape*) and the trigger-surface table
-- in `docs/community/metrics.md`. When a new event name is added to
-- `src/analytics.js`, add a row to the map below or it silently falls into
-- `(unmapped)` in query 2.
--
--
-- ---------------------------------------------------------------------------
-- THE EVENT-TO-MODULE MAP
-- ---------------------------------------------------------------------------
--
-- A `module` here is a `club_features.module_key` wherever one exists. This
-- paragraph used to say "the same 21 keys an admin can actually switch off
-- (202609010012, 202609050006, 202609100002, 202609150014, 202609150016,
-- 202609160004, 202609160006, 202609170003)"; 202609190002 has since added
-- seven more, so the registry holds 28 and the panel offers 28, of which
-- those seven are marked `planned` because nothing is behind them yet.
-- Eight surfaces produce events but have no toggle of their own; they are
-- marked `*` and are NOT club_features keys.
--
--   event_name                | module            | why
--   --------------------------+-------------------+----------------------------
--   feed_viewed               | feed              | the Feed sub-tab
--   post_impression           | feed              | a card seen in the feed
--   post_opened               | feed              | the post/comment thread
--   post_created              | feed              | the composer (bus)
--   workout_shared            | feed              | publishing a workout to the
--                             |                   | club feed. NOT outward_share,
--                             |                   | which is sharing outside the
--                             |                   | app and emits nothing.
--   reaction_added            | feed              | reactions have no toggle of
--                             |                   | their own; they key off the
--                             |                   | post's visibility
--   comment_created           | comments          | its own module key
--   achievement_shared        | achievements      |
--   challenge_viewed          | challenges        |
--   challenge_joined          | challenges        |
--   challenge_completed       | challenges        |
--   leaderboard_viewed        | leaderboards      |
--   event_viewed              | events            |
--   event_rsvp                | events            |
--   directory_opened          | directory         | the roster sub-tab
--   weekly_recap_opened       | weekly_recap      |
--   weekly_recap_shared       | weekly_recap      |
--   coach_congratulate_sent   | coach_tools       | staff-only by construction
--   push_opt_in               | push_notifications|
--   profile_opened            | profiles*         | a member profile, reachable
--                             |                   | from feed/search/directory,
--                             |                   | so not the directory module
--   member_followed           | profiles*         | the social graph
--   notification_opened       | notifications*    | the notification centre has
--                             |                   | per-type prefs, not a club
--                             |                   | toggle; push_notifications
--                             |                   | is only the push transport
--   search_performed          | search*           | both boxes; split by
--                             |                   | props->>'source' in query 3
--   report_submitted          | moderation*       |
--   attendance_recorded       | attendance*       | a training session reaching
--                             |                   | the server (bus, COMM-300)
--   classmates_card_viewed    | classmates_today* | kept separate from attendance
--                             |                   | on purpose: the card's whole
--                             |                   | question is how often it had
--                             |                   | anything to show
--   announcement_viewed       | announcements     | the archive on screen, with
--                             |                   | rows in it. Announcements
--                             |                   | render inline and are never
--                             |                   | "opened", so a view is the
--                             |                   | only honest event here
--   member_of_week_published  | member_of_week    | the coach's publish
--   welcome_sent              | welcome_flow      | a welcome comment written,
--                             |                   | from the feed card or the
--                             |                   | coach section
--   monthly_recap_viewed      | monthly_recap     | the MEMBER card. The staff
--                             |                   | draft preview is not this
--   club_wod_result_attached  | club_wod          | a member puts their own
--                             |                   | logged result on the board
--   new_member_post_viewed    | new_member_posts  | the welcome card actually
--                             |                   | seen in a feed session
--   post_photo_attached       | post_photos       | a photo attached in either
--                             |                   | composer, including drafts
--                             |                   | that are never published
--   mention_inserted          | mentions          | somebody picked from the
--                             |                   | "@" picker
--   outward_share_completed   | outward_share     | the share sheet settled,
--                             |                   | including `cancelled`
--   streak_nudge_opened       | streak_risk_nudges| a streak_at_risk
--                             |                   | notification opened. THE
--                             |                   | ONE DELIBERATE DOUBLE: the
--                             |                   | same tap also writes
--                             |                   | notification_opened, which
--                             |                   | belongs to `notifications`.
--                             |                   | Per-module counts stay
--                             |                   | right; a SUM across modules
--                             |                   | does not, and query 2 does
--                             |                   | not take one
--   engagement_flag_actioned  | engagement_alerts | a coach reached out to,
--                             |                   | reviewed or dismissed a
--                             |                   | flag
--   coach_task_closed         | coach_tasks       | a task closed by a contact
--                             |                   | or marked not relevant.
--                             |                   | Staff-only by construction,
--                             |                   | like coach_tools
--   onboarding_challenge_     | onboarding_       | the offer answered, accept
--     responded               |   challenge       | or decline - props->>
--                             |                   | 'accepted' splits them
--   owner_report_viewed       | owner_report      | the report loaded for a
--                             |                   | club leader, once per visit
--   benchmark_opened          | benchmarks        | one benchmark's history
--                             |                   | opened on the progress
--                             |                   | screen
--   training_partners_tagged  | trained_together  | a workout post's author
--                             |                   | saved who trained with them
--   push_permission           | push_notifications| the browser's own answer,
--                             |                   | including a denial, which
--                             |                   | push_opt_in can never see
--   push_self_test            | push_notifications| the account-settings device
--                             |                   | test, received or not
--   club_tab_viewed           | shell*            | navigation, not a module.
--                             |                   | Query 6 splits it by
--                             |                   | props->>'tab'
--   app_opened                | shell*            | one row per page load, with
--                             |                   | display_mode and platform.
--                             |                   | A session, not a module —
--                             |                   | excluded from queries 2-5
--                             |                   | exactly like club_tab_viewed
--   write_failed              | platform*         | a failed community write.
--                             |                   | Health signal, not usage —
--                             |                   | excluded from queries 2-5
--   client_error              | platform*         | an uncaught error or an
--                             |                   | unhandled rejection (N10).
--                             |                   | Health signal, not usage —
--                             |                   | excluded like write_failed
--
-- 48 event names, which is every entry in `EVENTS` (42 until the five
-- built-after-their-switches names above were added, 47 until N10 added
-- client_error). `write_failed` was not in
-- metrics.md's trigger table when this file was written; the row is added in
-- the same change.
--
-- MODULES THAT EMIT NOTHING. None, as of the fourteen names added above.
-- This block used to read: "Eleven club_features keys have no event mapped to
-- them at all: announcements, member_of_week, welcome_flow, monthly_recap,
-- club_wod, new_member_posts, post_photos, mentions, outward_share,
-- streak_risk_nudges, engagement_alerts." Every one of those eleven now has
-- exactly one event of its own, at the surface that is the module's own
-- point, so query 5's "no telemetry" verdict no longer fires for any module
-- that has a feature behind it.
--
-- WHAT IS STILL UNMEASURABLE. This paragraph used to read: "the seven keys
-- 202609190002 added (coach_tasks, onboarding_challenge, benchmarks,
-- strength_percentages, gym_display, owner_report, arbox_attendance) are
-- switches that arrive BEFORE their features ... The branch that builds each
-- feature adds its event and its row here in the same change." Four of those
-- seven were then built without one, and so was trained_together
-- (202609220005), so for five modules with a real feature behind them query 5
-- was reporting "no telemetry" as if nothing existed. Each now has its event:
-- coach_tasks, onboarding_challenge, owner_report, benchmarks and
-- trained_together.
--
-- Three keys remain with no event:
--   gym_display, arbox_attendance - still `planned` switches with nothing
--     behind them. "No telemetry" is the correct answer for those two.
--   strength_percentages - BUILT (the percentage chips on the log screen,
--     app.js renderStrengthPctChips) and emitting nothing. This one IS a gap,
--     the same kind the five above were; it was not in the change that
--     closed them and is recorded here so query 5's verdict on it is not
--     mistaken for disuse.
--
-- THE TWO PROP-LEVEL SIGNALS in query 7 (post_created.has_media and
-- comment_created.mention_count) are kept. They are no longer the ONLY thing
-- that can speak for post_photos and mentions - both have their own event now
-- - but they answer a different question: the event counts attachments and
-- picks, the props count PUBLISHED posts and comments that carried one. Read
-- together they separate "nobody attaches photos" from "everybody attaches
-- photos and then deletes the draft".
--
-- ===========================================================================


-- ===========================================================================
-- 1. The map itself, as data.
--    Answers: what does this file think each event belongs to? Run it first
--    and read it against src/analytics.js. Every later query re-declares this
--    same list as a CTE so each block can be pasted on its own; if you edit
--    the map, edit it everywhere (the list appears in queries 1, 2, 4, 5).
-- ===========================================================================
select event_name, module, is_club_feature
from (values
  ('feed_viewed',             'feed',               true),
  ('post_impression',         'feed',               true),
  ('post_opened',             'feed',               true),
  ('post_created',            'feed',               true),
  ('workout_shared',          'feed',               true),
  ('reaction_added',          'feed',               true),
  ('comment_created',         'comments',           true),
  ('achievement_shared',      'achievements',       true),
  ('challenge_viewed',        'challenges',         true),
  ('challenge_joined',        'challenges',         true),
  ('challenge_completed',     'challenges',         true),
  ('leaderboard_viewed',      'leaderboards',       true),
  ('event_viewed',            'events',             true),
  ('event_rsvp',              'events',             true),
  ('directory_opened',        'directory',          true),
  ('weekly_recap_opened',     'weekly_recap',       true),
  ('weekly_recap_shared',     'weekly_recap',       true),
  ('coach_congratulate_sent', 'coach_tools',        true),
  ('push_opt_in',             'push_notifications', true),
  ('profile_opened',          'profiles',           false),
  ('member_followed',         'profiles',           false),
  ('notification_opened',     'notifications',      false),
  ('search_performed',        'search',             false),
  ('report_submitted',        'moderation',         false),
  ('attendance_recorded',     'attendance',         false),
  ('classmates_card_viewed',  'classmates_today',   false),
  ('announcement_viewed',     'announcements',      true),
  ('member_of_week_published','member_of_week',     true),
  ('welcome_sent',            'welcome_flow',       true),
  ('monthly_recap_viewed',    'monthly_recap',      true),
  ('club_wod_result_attached','club_wod',           true),
  ('new_member_post_viewed',  'new_member_posts',   true),
  ('post_photo_attached',     'post_photos',        true),
  ('mention_inserted',        'mentions',           true),
  ('outward_share_completed', 'outward_share',      true),
  ('streak_nudge_opened',     'streak_risk_nudges', true),
  ('engagement_flag_actioned','engagement_alerts',  true),
  ('coach_task_closed',       'coach_tasks',        true),
  ('onboarding_challenge_responded','onboarding_challenge', true),
  ('owner_report_viewed',     'owner_report',       true),
  ('benchmark_opened',        'benchmarks',         true),
  ('training_partners_tagged','trained_together',   true),
  ('push_permission',         'push_notifications', true),
  ('push_self_test',          'push_notifications', true),
  ('club_tab_viewed',         'shell',              false),
  ('app_opened',              'shell',              false),
  ('write_failed',            'platform',           false),
  ('client_error',            'platform',           false)
) as m(event_name, module, is_club_feature)
order by is_club_feature desc, module, event_name;


-- ===========================================================================
-- 2. Module usage, last 30 days.
--    Answers: for each module, how many distinct members touched it, how many
--    events it produced, and when it was last touched.
--
--    `member_users` / `staff_users` split the same way is_staff() does
--    (profiles.is_admin, or invite_redemptions.role = 'coach'), because
--    coach_tools is staff-only by construction and would otherwise read as a
--    module almost nobody uses. `anon_events` counts rows with a null user_id,
--    which the insert policy allows for a pre-profile session — they are real
--    events but they cannot be counted as people.
--
--    shell and platform are excluded: navigation and a failure signal are not
--    module usage. Query 6 reads shell, query 8 reads platform.
-- ===========================================================================
with module_map(event_name, module) as (values
  ('feed_viewed','feed'), ('post_impression','feed'), ('post_opened','feed'),
  ('post_created','feed'), ('workout_shared','feed'), ('reaction_added','feed'),
  ('comment_created','comments'),
  ('achievement_shared','achievements'),
  ('challenge_viewed','challenges'), ('challenge_joined','challenges'),
  ('challenge_completed','challenges'),
  ('leaderboard_viewed','leaderboards'),
  ('event_viewed','events'), ('event_rsvp','events'),
  ('directory_opened','directory'),
  ('weekly_recap_opened','weekly_recap'), ('weekly_recap_shared','weekly_recap'),
  ('coach_congratulate_sent','coach_tools'),
  ('push_opt_in','push_notifications'),
  ('profile_opened','profiles'), ('member_followed','profiles'),
  ('notification_opened','notifications'),
  ('search_performed','search'),
  ('report_submitted','moderation'),
  ('attendance_recorded','attendance'),
  ('classmates_card_viewed','classmates_today'),
  -- The eleven modules that used to emit nothing, plus the two push names.
  -- shell (club_tab_viewed, app_opened) and platform (write_failed, client_error) stay out
  -- of this map deliberately: navigation, a session and a failure signal are
  -- not module usage.
  ('announcement_viewed','announcements'),
  ('member_of_week_published','member_of_week'),
  ('welcome_sent','welcome_flow'),
  ('monthly_recap_viewed','monthly_recap'),
  ('club_wod_result_attached','club_wod'),
  ('new_member_post_viewed','new_member_posts'),
  ('post_photo_attached','post_photos'),
  ('mention_inserted','mentions'),
  ('outward_share_completed','outward_share'),
  ('streak_nudge_opened','streak_risk_nudges'),
  ('engagement_flag_actioned','engagement_alerts'),
  -- The five built after their switches (see the header).
  ('coach_task_closed','coach_tasks'),
  ('onboarding_challenge_responded','onboarding_challenge'),
  ('owner_report_viewed','owner_report'),
  ('benchmark_opened','benchmarks'),
  ('training_partners_tagged','trained_together'),
  ('push_permission','push_notifications'),
  ('push_self_test','push_notifications')
),
staff as (
  select p.id
  from public.profiles p
  where p.is_admin and p.deleted_at is null
  union
  select ir.user_id from public.invite_redemptions ir where ir.role = 'coach'
),
rows_30d as (
  select coalesce(m.module, '(unmapped) ' || e.event_name) as module,
         e.user_id,
         (s.id is not null) as is_staff
  from public.analytics_events e
  left join module_map m on m.event_name = e.event_name
  left join staff s on s.id = e.user_id
  where e.created_at >= now() - interval '30 days'
    -- app_opened joins the two already here: one row per page load is a
    -- session, not a module being used. Query 9 reads it on its own.
    and e.event_name not in ('club_tab_viewed', 'app_opened', 'write_failed', 'client_error')
)
select r.module,
       count(distinct r.user_id)                                          as unique_users,
       count(distinct r.user_id) filter (where not r.is_staff)            as member_users,
       count(distinct r.user_id) filter (where r.is_staff)                as staff_users,
       count(*)                                                           as event_count,
       count(*) filter (where r.user_id is null)                          as anon_events,
       round(count(*)::numeric / nullif(count(distinct r.user_id), 0), 1) as events_per_user
from rows_30d r
group by r.module
order by unique_users desc, event_count desc;


-- ===========================================================================
-- 3. The same 30 days, one row per event name.
--    Answers: which surface inside a module carries it. A module that looks
--    healthy in query 2 can be one event doing all the work — challenges is
--    the live case, where challenge_viewed fires on every entry to the Boards
--    sub-tab while challenge_joined needs a real decision.
--
--    `prop_split` is the one prop worth seeing beside the count, per event.
--    Reading it: search_performed splits community_search vs directory,
--    leaderboard_viewed splits the three boards, weekly_recap_* splits by
--    entry point. A `source = post_card` on challenge_viewed or event_viewed
--    dated before COMM-233 may actually be a Boards open (metrics.md,
--    "Closed in Phase 2") — a source split across that boundary is not
--    comparable.
-- ===========================================================================
select e.event_name,
       coalesce(e.props ->> 'source',    e.props ->> 'board',
                e.props ->> 'scope',     e.props ->> 'figure',
                e.props ->> 'tab',       e.props ->> 'post_type',
                e.props ->> 'type',      e.props ->> 'reason',
                e.props ->> 'kind',      e.props ->> 'rsvp_status',
                '(none)')                                  as prop_split,
       count(distinct e.user_id)                           as unique_users,
       count(*)                                            as event_count,
       min(e.created_at)                                   as first_seen,
       max(e.created_at)                                   as last_seen
from public.analytics_events e
where e.created_at >= now() - interval '30 days'
group by e.event_name, prop_split
order by e.event_name, event_count desc;


-- ===========================================================================
-- 4. Weekly trend per module.
--    Answers: is a module growing, flat or dying? Five Monday-based week
--    buckets covering the last 30 days, so the first and last are partial —
--    `is_partial` flags them rather than dropping them, the same way
--    analytics_week_buckets() does, because a three-day week printed next to a
--    seven-day one reads as a collapse that never happened.
--
--    Every module that produced at least one event in the window gets a row in
--    every week, including zero weeks: a module that stopped mid-month is a
--    gap, and a gap is invisible if the query only returns the weeks that have
--    rows. A module with no events at all in the window is absent here by
--    construction - that is query 5's finding, not a trend.
-- ===========================================================================
with module_map(event_name, module) as (values
  ('feed_viewed','feed'), ('post_impression','feed'), ('post_opened','feed'),
  ('post_created','feed'), ('workout_shared','feed'), ('reaction_added','feed'),
  ('comment_created','comments'),
  ('achievement_shared','achievements'),
  ('challenge_viewed','challenges'), ('challenge_joined','challenges'),
  ('challenge_completed','challenges'),
  ('leaderboard_viewed','leaderboards'),
  ('event_viewed','events'), ('event_rsvp','events'),
  ('directory_opened','directory'),
  ('weekly_recap_opened','weekly_recap'), ('weekly_recap_shared','weekly_recap'),
  ('coach_congratulate_sent','coach_tools'),
  ('push_opt_in','push_notifications'),
  ('profile_opened','profiles'), ('member_followed','profiles'),
  ('notification_opened','notifications'),
  ('search_performed','search'),
  ('report_submitted','moderation'),
  ('attendance_recorded','attendance'),
  ('classmates_card_viewed','classmates_today'),
  -- The eleven modules that used to emit nothing, plus the two push names.
  -- shell (club_tab_viewed, app_opened) and platform (write_failed, client_error) stay out
  -- of this map deliberately: navigation, a session and a failure signal are
  -- not module usage.
  ('announcement_viewed','announcements'),
  ('member_of_week_published','member_of_week'),
  ('welcome_sent','welcome_flow'),
  ('monthly_recap_viewed','monthly_recap'),
  ('club_wod_result_attached','club_wod'),
  ('new_member_post_viewed','new_member_posts'),
  ('post_photo_attached','post_photos'),
  ('mention_inserted','mentions'),
  ('outward_share_completed','outward_share'),
  ('streak_nudge_opened','streak_risk_nudges'),
  ('engagement_flag_actioned','engagement_alerts'),
  -- The five built after their switches (see the header).
  ('coach_task_closed','coach_tasks'),
  ('onboarding_challenge_responded','onboarding_challenge'),
  ('owner_report_viewed','owner_report'),
  ('benchmark_opened','benchmarks'),
  ('training_partners_tagged','trained_together'),
  ('push_permission','push_notifications'),
  ('push_self_test','push_notifications')
),
bounds as (
  select (now() - interval '30 days') as win_start, now() as win_end
),
weeks as (
  select w as week_start,
         (w + interval '7 days') as week_end,
         (w < b.win_start or w + interval '7 days' > b.win_end) as is_partial
  from bounds b,
       generate_series(date_trunc('week', b.win_start),
                       date_trunc('week', b.win_end),
                       interval '7 days') w
),
observed as (
  select distinct m.module
  from public.analytics_events e
  join module_map m on m.event_name = e.event_name
  where e.created_at >= (select win_start from bounds)
)
select o.module,
       w.week_start::date,
       w.is_partial,
       count(distinct e.user_id) as unique_users,
       count(e.id)               as event_count
from weeks w
cross join observed o
left join module_map m on m.module = o.module
left join public.analytics_events e
       on e.event_name = m.event_name
      and e.created_at >= w.week_start
      and e.created_at <  w.week_end
      and e.created_at >= (select win_start from bounds)
      and e.created_at <  (select win_end   from bounds)
group by o.module, w.week_start, w.is_partial
order by o.module, w.week_start;


-- ===========================================================================
-- 5. Modules with near-zero use — and modules nothing can measure.
--    Answers: what should be considered for removal, and what cannot be
--    judged yet. The two are reported in one list with a `verdict` column and
--    must not be confused: a module nothing measures is a telemetry gap, not
--    a member verdict, and deleting one on the strength of this query would
--    be deleting it on no evidence.
--
--    This paragraph used to name eleven such modules. All eleven have an
--    event now, and so do the five modules built after their switches
--    (coach_tasks, onboarding_challenge, owner_report, benchmarks,
--    trained_together). What still returns "no telemetry" is gym_display and
--    arbox_attendance - planned switches with nothing behind them, the one
--    case where "no telemetry" is not a gap to close - and
--    strength_percentages, which IS one (see the header).
--
--    Edit `near_zero_users` in the params CTE. 2 is a starting point for a
--    single gym: fewer than three distinct members in a month.
-- ===========================================================================
with params(near_zero_users) as (values (2)),
module_map(event_name, module) as (values
  ('feed_viewed','feed'), ('post_impression','feed'), ('post_opened','feed'),
  ('post_created','feed'), ('workout_shared','feed'), ('reaction_added','feed'),
  ('comment_created','comments'),
  ('achievement_shared','achievements'),
  ('challenge_viewed','challenges'), ('challenge_joined','challenges'),
  ('challenge_completed','challenges'),
  ('leaderboard_viewed','leaderboards'),
  ('event_viewed','events'), ('event_rsvp','events'),
  ('directory_opened','directory'),
  ('weekly_recap_opened','weekly_recap'), ('weekly_recap_shared','weekly_recap'),
  ('coach_congratulate_sent','coach_tools'),
  ('push_opt_in','push_notifications'),
  ('profile_opened','profiles'), ('member_followed','profiles'),
  ('notification_opened','notifications'),
  ('search_performed','search'),
  ('report_submitted','moderation'),
  ('attendance_recorded','attendance'),
  ('classmates_card_viewed','classmates_today'),
  -- The eleven modules that used to emit nothing, plus the two push names.
  -- shell (club_tab_viewed, app_opened) and platform (write_failed, client_error) stay out
  -- of this map deliberately: navigation, a session and a failure signal are
  -- not module usage.
  ('announcement_viewed','announcements'),
  ('member_of_week_published','member_of_week'),
  ('welcome_sent','welcome_flow'),
  ('monthly_recap_viewed','monthly_recap'),
  ('club_wod_result_attached','club_wod'),
  ('new_member_post_viewed','new_member_posts'),
  ('post_photo_attached','post_photos'),
  ('mention_inserted','mentions'),
  ('outward_share_completed','outward_share'),
  ('streak_nudge_opened','streak_risk_nudges'),
  ('engagement_flag_actioned','engagement_alerts'),
  -- The five built after their switches (see the header).
  ('coach_task_closed','coach_tasks'),
  ('onboarding_challenge_responded','onboarding_challenge'),
  ('owner_report_viewed','owner_report'),
  ('benchmark_opened','benchmarks'),
  ('training_partners_tagged','trained_together'),
  ('push_permission','push_notifications'),
  ('push_self_test','push_notifications')
),
-- Every module that could appear: the club_features registry plus the
-- untoggleable surfaces the map names. A module_key added by a later
-- migration shows up here automatically.
universe as (
  select cf.module_key as module, cf.enabled, true as is_club_feature
  from public.club_features cf
  union all
  select distinct m.module, null::boolean, false
  from module_map m
  where not exists (select 1 from public.club_features cf where cf.module_key = m.module)
),
usage as (
  select m.module,
         count(distinct e.user_id) as unique_users,
         count(*)                  as event_count,
         max(e.created_at)         as last_seen
  from public.analytics_events e
  join module_map m on m.event_name = e.event_name
  where e.created_at >= now() - interval '30 days'
  group by m.module
),
measurable as (select distinct module from module_map)
select u.module,
       u.is_club_feature,
       u.enabled,
       coalesce(g.unique_users, 0) as unique_users,
       coalesce(g.event_count, 0)  as event_count,
       g.last_seen,
       case
         when u.enabled is false
           then 'switched off - silence is expected, not a finding'
         when x.module is null
           then 'no telemetry - no event maps to this module, so it cannot be judged'
         when coalesce(g.event_count, 0) = 0
           then 'zero events in 30 days'
         when coalesce(g.unique_users, 0) <= (select near_zero_users from params)
           then 'near-zero - ' || coalesce(g.unique_users, 0) || ' distinct member(s) in 30 days'
         else 'in use'
       end as verdict
from universe u
left join usage g     on g.module = u.module
left join measurable x on x.module = u.module
order by (x.module is null),               -- unmeasurable last
         coalesce(g.unique_users, 0) asc,
         u.module;


-- ===========================================================================
-- 6. Which sub-tab members land on.
--    Answers: the navigation split behind query 2. club_tab_viewed is counted
--    once per entry into a sub-tab (a re-render of the same one records
--    nothing, leaving the Community tab resets it), so this is "visits", not
--    "renders". Tabs are feed, boards, directory, account, and the staff-only
--    coach and manage.
-- ===========================================================================
select coalesce(e.props ->> 'tab', '(none)')          as sub_tab,
       count(distinct e.user_id)                      as unique_users,
       count(*)                                       as visits,
       round(100.0 * count(*) / sum(count(*)) over (), 1) as pct_of_visits
from public.analytics_events e
where e.event_name = 'club_tab_viewed'
  and e.created_at >= now() - interval '30 days'
group by sub_tab
order by visits desc;


-- ===========================================================================
-- 7. Published-rate cross-check for post_photos and mentions.
--    Answers: of the posts and comments that were actually PUBLISHED, how
--    many carried a photo or a mention?
--
--    This block used to be titled "prop-level signal for two modules that
--    emit no event of their own", and that is no longer what it is. Both
--    modules have their own event now (post_photo_attached,
--    mention_inserted), and the two measurements are deliberately different
--    ends of the same funnel:
--      - the EVENT counts the act - a photo attached in a composer, a member
--        picked from the "@" picker - including drafts that are abandoned and
--        mentions that are typed and then deleted;
--      - the PROP below counts what survived to publication, off
--        post_created.has_media and comment_created.mention_count
--        (BUS_PROP_KEYS / BUS_COUNT_KEYS, src/analytics.js).
--    A high event count against a low published rate is a composer problem,
--    not a disused feature, and neither number can say that alone. Still a
--    rate rather than a module usage count, so still not folded into query 2.
-- ===========================================================================
select 'post_photos'                                              as module,
       'post_created.has_media'                                   as signal,
       count(*)                                                   as events,
       count(*) filter (where (e.props ->> 'has_media')::boolean)  as with_signal,
       count(distinct e.user_id) filter (where (e.props ->> 'has_media')::boolean) as users_with_signal
from public.analytics_events e
where e.event_name = 'post_created'
  and e.created_at >= now() - interval '30 days'
union all
select 'mentions',
       'comment_created.mention_count',
       count(*),
       count(*) filter (where coalesce((e.props ->> 'mention_count')::int, 0) > 0),
       count(distinct e.user_id) filter (where coalesce((e.props ->> 'mention_count')::int, 0) > 0)
from public.analytics_events e
where e.event_name = 'comment_created'
  and e.created_at >= now() - interval '30 days';


-- ===========================================================================
-- 8. Failed community writes, last 30 days.
--    Answers: is a module's silence in query 5 actually a broken module?
--    write_failed carries the action name and a coarse error code only. A
--    module with near-zero use AND a cluster of failures here is a bug
--    report, not a product finding — this is the event that exists because a
--    policy change once silently stopped every profile write and the only
--    signal was a member photographing their screen.
-- ===========================================================================
select e.props ->> 'action'    as action,
       e.props ->> 'code'      as error_code,
       count(*)                as failures,
       count(distinct e.user_id) as affected_users,
       max(e.created_at)       as last_seen
from public.analytics_events e
where e.event_name = 'write_failed'
  and e.created_at >= now() - interval '30 days'
group by action, error_code
order by failures desc;


-- ===========================================================================
-- 8b. Uncaught client errors, last 30 days (N10).
--    Answers: is the app throwing somewhere nobody has reported?
--    client_error carries the error class, which of our own .js files threw
--    and where, and fp - a hash of the message, never the message. Group by
--    fp to count one bug once; a new app_version with a new fp is a
--    regression.
-- ===========================================================================
select e.props ->> 'fp'          as fingerprint,
       e.props ->> 'kind'        as kind,
       e.props ->> 'name'        as error_class,
       e.props ->> 'file'        as file,
       e.props ->> 'line'        as line,
       min(e.props ->> 'app_version') as first_version,
       max(e.props ->> 'app_version') as last_version,
       count(*)                  as occurrences,
       count(distinct e.user_id) as affected_users,
       max(e.created_at)         as last_seen
from public.analytics_events e
where e.event_name = 'client_error'
  and e.created_at >= now() - interval '30 days'
group by fingerprint, kind, error_class, file, line
order by occurrences desc;


-- ===========================================================================
-- 9. Standalone (installed-to-home-screen) share — READ THE COMMENT FIRST.
--
--    Answers: nothing, yet. This is the honest result, not a missing query.
--
--    `analytics_events` has no display-mode prop and no app-session id. The
--    client knows whether it is running standalone — app.js isStandalone()
--    and cloud.js isStandalonePwa() both read
--    `matchMedia('(display-mode: standalone)')` — but neither value is ever
--    passed to analyticsTrack(), and HAND_PROP_KEYS/BUS_PROP_KEYS would drop
--    it if a call site tried. There is also no session concept in the table:
--    the only id resembling one is post_impression's `feed_session_id`, which
--    is minted per feed load (state.feed.sessionId, cloud.js), not per app
--    open, and exists only on that one event.
--
--    This query proves that rather than asserting it: it lists every distinct
--    prop key in the last 30 days. If `standalone` or `display_mode` is not in
--    the output, queries 9a and 9b are the only answers available.
-- ===========================================================================
select k.key                     as prop_key,
       count(*)                  as rows_carrying_it,
       count(distinct e.event_name) as on_n_events,
       string_agg(distinct e.event_name, ', ' order by e.event_name) as events
from public.analytics_events e
cross join lateral jsonb_object_keys(e.props) as k(key)
where e.created_at >= now() - interval '30 days'
group by k.key
order by rows_carrying_it desc;


-- ---------------------------------------------------------------------------
-- 9a. The nearest real measurement of standalone, and its bias.
--     Answers: of the bug reports filed in the last 90 days, what share came
--     from a member running the app installed to the home screen?
--     `bug_reports.diagnostics` (202609150002) is the only place in the schema
--     that records the flag, written by app.js supportDiagnosticsPayload().
--
--     THIS IS NOT A SESSION SHARE. The sample is members who hit a problem and
--     chose to report it, which is a handful of people and is plausibly
--     correlated with the thing being measured (iOS push, for one, only works
--     when installed). 90 days rather than 30 because at this volume 30 days
--     may return nothing at all. Read it as "installed members exist and
--     roughly this many of them write in", never as an adoption rate.
-- ---------------------------------------------------------------------------
select coalesce(b.diagnostics ->> 'standalone', '(not recorded)') as standalone,
       count(*)                                                   as reports,
       count(distinct b.reporter_id)                              as distinct_reporters,
       round(100.0 * count(*) / sum(count(*)) over (), 1)         as pct_of_reports
from public.bug_reports b
where b.created_at >= now() - interval '90 days'
group by standalone
order by reports desc;


-- ---------------------------------------------------------------------------
-- 9b. The denominator that a standalone share would need.
--     Answers: how many member-days the app was opened at all, last 30 days.
--     `activity_pings` is one row per member per day the app was open with
--     community active (cloud.js pingActivity()) — the closest thing to a
--     session count the schema holds, at day grain rather than session grain.
--
--     CAVEAT THAT CHANGES HOW YOU READ THIS. cloud.js records that this upsert
--     chained .catch() directly on a PostgrestFilterBuilder and therefore
--     never reached the server at all until that was fixed, so rows before the
--     fix are missing wholesale. A low number for an older week is that bug,
--     not member behaviour. Check where the row counts start.
--
--     TO ACTUALLY ANSWER QUERY 9: add `standalone: isStandalone()` to
--     club_tab_viewed's props (additive, so SCHEMA_VERSION does not move — it
--     needs a HAND_PROP_KEYS entry for that event, which today has none, plus
--     a metrics.md row). The share then becomes:
--
--       select e.props ->> 'standalone' as standalone,
--              count(distinct (e.user_id, e.created_at::date)) as member_days
--       from public.analytics_events e
--       where e.event_name = 'club_tab_viewed'
--         and e.created_at >= now() - interval '30 days'
--       group by standalone;
-- ---------------------------------------------------------------------------
select date_trunc('week', a.activity_date::timestamp)::date as week_start,
       count(*)                                             as member_days,
       count(distinct a.user_id)                            as distinct_members
from public.activity_pings a
where a.activity_date >= (current_date - 30)
group by week_start
order by week_start;


-- ===========================================================================
-- 10. New members in the last 90 days, with their first-month attendance.
--     Answers: are new members training, and does the number fall off?
--
--     JOINED is `invite_redemptions.redeemed_at`, inner-joined to profiles.
--     That is this schema's convention (retention_cohorts, member_segments,
--     recap_monthly_generate, analytics_dashboard all use it) and it carries
--     the limitation every one of them records: grant_coach_role() UPDATEs
--     redeemed_at, so promoting an existing member to coach re-dates their
--     join and can put a long-standing member in this list. There is no
--     immutable joined_at column in this schema. `role` is returned so you can
--     spot that case. The inner join drops anyone who redeemed a code and
--     abandoned the flow before creating a profile, which is what every other
--     member count in this module does.
--
--     FIRST MONTH is the half-open window [joined_at, joined_at + 30 days),
--     against `attendance_log.occurred_on` — one row per member per calendar
--     day, derived server-side by trigger from the member's own training log
--     (202608310001). It is not a staff check-in and not Arbox: a member who
--     trains and does not log it is invisible here. occurred_on is the
--     member's LOCAL calendar day while redeemed_at is a UTC timestamp, so a
--     session logged near midnight can land one day either side of the
--     boundary; at a 30-day window that is noise, not a correction to make.
--
--     `attendance_log` is used rather than the attendance_recorded event, on
--     metrics.md's own rule: the table is the source of truth for attendance
--     (the trigger writes it independently of the event, so a member on an
--     older cached build produces the row and no event), the event is the
--     source of truth for WCAM.
--
--     `days_elapsed < 30` marks a member whose first month is still running —
--     their count is not yet comparable to a complete one.
-- ===========================================================================
select p.id                                         as user_id,
       p.handle,
       ir.role,
       ir.redeemed_at                               as joined_at,
       (current_date - ir.redeemed_at::date)        as days_elapsed,
       ((current_date - ir.redeemed_at::date) < 30) as first_month_in_progress,
       count(a.occurred_on)                         as first_month_sessions,
       min(a.occurred_on)                           as first_session_on,
       max(a.occurred_on)                           as last_session_in_window,
       (p.deleted_at is not null)                   as account_deleted
from public.invite_redemptions ir
join public.profiles p on p.id = ir.user_id
left join public.attendance_log a
       on a.user_id = ir.user_id
      and a.occurred_on >= ir.redeemed_at::date
      and a.occurred_on <  (ir.redeemed_at + interval '30 days')::date
where ir.redeemed_at >= now() - interval '90 days'
group by p.id, p.handle, ir.role, ir.redeemed_at, p.deleted_at
order by ir.redeemed_at desc;


-- ---------------------------------------------------------------------------
-- 10a. The same cohort, summarised.
--      Answers: how many of the last 90 days' joiners never logged a session
--      in their first month. Complete first months only — a member who joined
--      last week has not had one yet, and including them would report every
--      recent joiner as a failure.
-- ---------------------------------------------------------------------------
with cohort as (
  select ir.user_id,
         ir.redeemed_at,
         to_char(date_trunc('month', ir.redeemed_at), 'YYYY-MM') as join_month,
         (select count(*)
            from public.attendance_log a
           where a.user_id = ir.user_id
             and a.occurred_on >= ir.redeemed_at::date
             and a.occurred_on <  (ir.redeemed_at + interval '30 days')::date) as sessions
  from public.invite_redemptions ir
  join public.profiles p on p.id = ir.user_id
  where ir.redeemed_at >= now() - interval '90 days'
    and ir.redeemed_at <  now() - interval '30 days'   -- first month complete
)
select join_month,
       count(*)                                        as joined,
       count(*) filter (where sessions = 0)            as never_logged_a_session,
       count(*) filter (where sessions between 1 and 3) as one_to_three,
       count(*) filter (where sessions >= 4)           as four_or_more,
       round(avg(sessions), 1)                         as avg_sessions,
       percentile_cont(0.5) within group (order by sessions) as median_sessions
from cohort
group by join_month
order by join_month desc;


-- ===========================================================================
-- 9. How the app is being run, and how far the push funnel gets.
--    Answers: the two questions the eleven-module pass was really about.
--
--    9a. INSTALL SHARE. app_opened is one row per page load carrying
--    display_mode ('standalone' | 'browser') and platform ('ios' | 'android'
--    | 'other'). Read the member column, not the session column: one member
--    who opens the app nine times a week is nine sessions and one install.
--    A member can legitimately appear in BOTH display modes - the installed
--    app on their phone, a browser tab on a laptop - so the two member counts
--    do not sum to the roster.
--
--    Note the floor: app_opened is written from the session-ready path, so a
--    session that never signs in produces no row. This measures members, not
--    visitors, which is the population every decision behind it is about.
-- ===========================================================================
select e.props ->> 'platform'                          as platform,
       e.props ->> 'display_mode'                      as display_mode,
       count(distinct e.user_id)                       as members,
       count(*)                                        as sessions,
       max(e.created_at)                               as last_seen
from public.analytics_events e
where e.event_name = 'app_opened'
  and e.created_at >= now() - interval '30 days'
group by platform, display_mode
order by members desc, sessions desc;


-- ===========================================================================
--    9b. THE PUSH FUNNEL, in the order a member walks it. Four rows, each
--    from its own event, and the gaps between them are the finding:
--      permission_default  - asked nothing of them yet (read off the Account
--                            tab, so it counts members who LOOKED)
--      permission_granted  - said yes
--      permission_denied   - said no. push_opt_in can never see these, which
--                            is why push_permission exists
--      opted_in            - a push_subscriptions row was actually written
--      self_test_received  - a notification really reached the device
--      self_test_missing   - the member ran the test and nothing arrived.
--                            This is the row to act on: a granted permission
--                            with no delivery is a broken install, not a
--                            preference.
-- ===========================================================================
select 'permission_default'  as step, count(distinct user_id) as members, count(*) as events
from public.analytics_events
where event_name = 'push_permission' and props ->> 'status' = 'default'
  and created_at >= now() - interval '30 days'
union all
select 'permission_granted', count(distinct user_id), count(*)
from public.analytics_events
where event_name = 'push_permission' and props ->> 'status' = 'granted'
  and created_at >= now() - interval '30 days'
union all
select 'permission_denied', count(distinct user_id), count(*)
from public.analytics_events
where event_name = 'push_permission' and props ->> 'status' = 'denied'
  and created_at >= now() - interval '30 days'
union all
select 'opted_in', count(distinct user_id), count(*)
from public.analytics_events
where event_name = 'push_opt_in' and created_at >= now() - interval '30 days'
union all
select 'self_test_received', count(distinct user_id), count(*)
from public.analytics_events
where event_name = 'push_self_test' and props ->> 'result' = 'received'
  and created_at >= now() - interval '30 days'
union all
select 'self_test_missing', count(distinct user_id), count(*)
from public.analytics_events
where event_name = 'push_self_test' and props ->> 'result' = 'not_received'
  and created_at >= now() - interval '30 days';
