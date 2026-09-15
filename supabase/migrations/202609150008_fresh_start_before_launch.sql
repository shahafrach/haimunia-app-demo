-- Empty the club before the real one arrives.
-- 2026-09-15, at the owner's explicit instruction: "Delete every user beside
-- admin and head coach / So it will be a start fresh / Delete all what shared
-- in feed until now / All app need to be clean."
--
-- THIS IS IRREVERSIBLE AND IT IS MEANT TO BE. Everything below is a hard
-- DELETE, not a soft one: the existing member-removal path
-- (admin_remove_member) is a soft delete plus a 30-day purge, which is right
-- for removing ONE member from a running club and wrong for this. A fresh
-- start that leaves thirty days of tombstones is not a fresh start.
--
-- CONFIRMED WITH THE OWNER BEFORE WRITING, because two parts of it are easy
-- to regret: `שלומי` and `shahaf` are the owner's OWN training accounts and
-- their cloud history goes with them, and the wipe covers everything members
-- generated rather than only the feed. Both answered explicitly. The offline
-- log on anybody's phone is untouched by this - it lives in IndexedDB on the
-- device and this database has never been its home.
--
-- THE GUARD. If either management account is missing this does nothing at
-- all. That is not defensive padding: on a fresh CI database created by
-- `supabase db reset` neither account exists, and an unguarded version of
-- this migration would delete every seeded fixture user in the test suite
-- and then be very hard to explain.
do $$
declare
  v_admin uuid;
  v_hc    uuid;
  v_users integer;
  v_posts integer;
begin
  select id into v_admin from auth.users where email = 'haimuniya@gmail.com';
  select id into v_hc    from auth.users where email = 'headcoach@members.haimuniya.invalid';

  if v_admin is null or v_hc is null then
    raise notice 'fresh_start: management accounts not present, skipping entirely';
    return;
  end if;

  -- -------------------------------------------------------------------
  -- 1. Everything ever shared, regardless of who shared it.
  -- -------------------------------------------------------------------
  -- "Delete all what shared in feed until now" - so this is not scoped to the
  -- members being removed. Posts by the management accounts go too, or the
  -- first member to arrive opens a feed with someone else's history in it.
  -- Leaf tables first: several of these would cascade from workout_posts
  -- anyway, but naming them makes the blast radius readable rather than
  -- something a reader has to reconstruct from FK definitions.
  delete from public.comment_mentions;
  delete from public.post_comments;
  delete from public.reactions;
  delete from public.saved_posts;
  delete from public.hidden_posts;
  delete from public.post_media;
  delete from public.pins;
  delete from public.workout_posts;
  delete from public.announcements;

  -- -------------------------------------------------------------------
  -- 2. Participation, and the things that only mean something with members.
  -- -------------------------------------------------------------------
  -- Challenge and club-WOD DEFINITIONS survive (the owner chose to keep the
  -- club setup rather than rebuild it); what goes is every trace of anyone
  -- having taken part. An event is different - it is a dated thing with a
  -- guest list, and a stale one with no attendees is worse than no event.
  delete from public.challenge_progress;
  delete from public.challenge_participants;
  delete from public.challenge_teams;
  delete from public.club_wod_results;
  delete from public.club_wod_sessions;
  delete from public.event_attendees;
  delete from public.events;
  delete from public.weekly_challenges;
  delete from public.weekly_challenges_archive;
  delete from public.member_of_week;
  delete from public.coach_congratulations;
  delete from public.coach_engagement_flags;
  delete from public.member_contact_log;
  delete from public.attendance_log;

  -- -------------------------------------------------------------------
  -- 3. Per-member records, history and derived state.
  -- -------------------------------------------------------------------
  delete from public.member_achievements;
  delete from public.private_records;
  delete from public.activity_pings;
  delete from public.onboarding_progress;
  delete from public.follows;
  delete from public.blocks;
  delete from public.posting_restrictions;
  delete from public.member_feed_weights;
  delete from public.community_health_scores;
  delete from public.weekly_recaps;
  delete from public.monthly_club_recaps;

  -- -------------------------------------------------------------------
  -- 4. Anything addressed to a person, and anything recorded about one.
  -- -------------------------------------------------------------------
  -- Notifications and push subscriptions go for both remaining accounts too:
  -- a management account opening the app to a backlog of alerts about members
  -- who no longer exist is exactly the "not clean" this is undoing.
  --
  -- admin_actions is the audit log. Clearing it is a real decision and not an
  -- obviously correct one - an audit log's whole value is that it is not
  -- edited. It goes because every row in it is about a member being deleted
  -- in this same migration, so what would remain is a record of moderation
  -- and role changes applied to people who are not in the database: unusable
  -- as history and actively misleading in the panel. The log starts again
  -- from the real club's first action.
  delete from public.notifications;
  delete from public.notification_batches;
  delete from public.notification_preferences;
  delete from public.push_subscriptions;
  delete from public.reports;
  delete from public.bug_reports;
  delete from public.admin_actions;
  delete from public.account_deletion_requests;

  -- -------------------------------------------------------------------
  -- 5. Telemetry and transient infrastructure.
  -- -------------------------------------------------------------------
  delete from public.feed_impressions;
  delete from public.feed_interactions;
  delete from public.analytics_events;
  delete from public.invite_attempts;
  delete from public.rate_limits;
  delete from public.request_idempotency;

  -- -------------------------------------------------------------------
  -- 6. Old invite codes stop working - deactivated, not deleted.
  -- -------------------------------------------------------------------
  -- A club that has just removed every member must not leave live codes that
  -- let any of them straight back in; "start fresh" has to mean the door is
  -- shut as well as the room being empty.
  --
  -- DEACTIVATED rather than deleted, deliberately. invite_redemptions.invite_id
  -- and .person_invite_id reference these tables with NO on-delete action, and
  -- the surviving head coach's redemption row is what carries their head_coach
  -- ROLE. A delete would either fail on that FK or, with one careless cascade,
  -- silently strip the head coach of the only thing that lets them into the
  -- club panel. Flipping `active` cannot touch it, and the head coach can
  -- issue fresh codes in seconds.
  update public.invite_codes set active = false where active;
  update public.invites set revoked_at = now()
   where revoked_at is null and redeemed_at is null;

  -- -------------------------------------------------------------------
  -- 7. The members themselves.
  -- -------------------------------------------------------------------
  -- Last, so the cascade has nothing left to do that step 1-6 has not already
  -- done explicitly. 202609060011 gave every FK to auth.users an explicit
  -- ON DELETE action precisely so a bulk delete like this cannot be blocked
  -- by one stray row - including invites.created_by, whose NOT NULL it had to
  -- drop to make that possible.
  with gone as (
    delete from auth.users where id not in (v_admin, v_hc) returning id
  )
  select count(*) into v_users from gone;

  select count(*) into v_posts from public.workout_posts;

  raise notice 'fresh_start: % member account(s) deleted, % post(s) remain, admin=% headcoach=% kept',
    v_users, v_posts, v_admin, v_hc;

  -- The club must not be left with nobody who can run it.
  if not exists (select 1 from public.profiles where id = v_admin)
     or not exists (select 1 from public.profiles where id = v_hc) then
    raise exception 'fresh_start: a management profile did not survive - refusing to leave the club unmanageable';
  end if;
  if not exists (select 1 from public.invite_redemptions where user_id = v_hc) then
    raise exception 'fresh_start: the head coach lost their role grant - refusing to leave the club panel unreachable';
  end if;
end $$;
