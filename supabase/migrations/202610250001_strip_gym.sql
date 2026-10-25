-- Strip gym.
--
-- Removes every feature on the "Drop" list of docs/circles/decisions.md and
-- sections 1 to 3 of docs/circles/audit.md: gym, staff, coach, Arbox and
-- gym-display features, text comments, mentions, saved and hidden posts, pins,
-- announcements, member of the week, recaps, search, follows and friends,
-- leaderboards, feed ranking and weights, reports and posting restrictions,
-- events, challenges, onboarding content, avatars, the post-photos and
-- avatar-photos buckets, sanitize_upload's trigger, and training_log_usage.
--
-- FORWARD ONLY. No applied migration is edited. The order is the one the
-- dependencies force: cron jobs, then everything that calls a dropped function
-- (views, triggers, policies), then the functions, then the tables.
--
-- WHAT STAYS: reactions, workout_posts, private_records, achievements,
-- notifications and push subscriptions, account deletion, rate limits,
-- request idempotency, invites and recovery, blocks, bug_reports (own rows),
-- profiles, clubs. Their policies are rewritten below only where they called
-- something dropped.
--
-- is_staff(), is_admin() and has_perm() stay as constant-false stubs so kept
-- policies still compile. The circles schema session replaces them.
-- admin_alert_recipients() stays as an empty stub for the same reason:
-- job_health_check() loops over it, and with no staff it alerts nobody.
-- That silence is accepted knowingly (audit section 1, note 4).
begin;

-- 1. Cron jobs first, so job_health_check never sees a job whose function is gone.
do $$
declare v text;
begin
  foreach v in array array[
    'chal-notify-ending-soon', 'coach-engagement-decline',
    'coach-engagement-decline-notify', 'community-health', 'recap-weekly',
    'recap_monthly', 'streak-at-risk-notify', 'training-log-usage-purge'
  ] loop
    if exists (select 1 from cron.job where jobname = v) then
      perform cron.unschedule(v);
    end if;
  end loop;
end $$;

-- 2. Views over dropped tables.
drop view if exists public.community_feed;
drop view if exists public.admin_user_directory;
drop view if exists public.weekly_challenge_leaderboard;

-- 3. Storage: the sanitize trigger, both buckets' policies, both buckets.
-- Direct deletes from storage tables are refused unless this setting is on.
drop trigger if exists sanitize_upload_after_write on storage.objects;
drop policy if exists avatar_photos_delete_own on storage.objects;
drop policy if exists avatar_photos_insert_own on storage.objects;
drop policy if exists avatar_photos_select_own_or_visible on storage.objects;
drop policy if exists avatar_photos_update_own on storage.objects;
drop policy if exists post_photos_delete_own on storage.objects;
drop policy if exists post_photos_insert_own on storage.objects;
drop policy if exists post_photos_select_if_media_visible on storage.objects;
drop policy if exists post_photos_select_if_post_visible on storage.objects;
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id in ('post-photos', 'avatar-photos');
delete from storage.buckets where id in ('post-photos', 'avatar-photos');

-- 4. Triggers on KEPT tables that call a dropped function.
drop trigger if exists workout_posts_photo_owner on public.workout_posts;
drop trigger if exists pins_unpin_dead_post on public.workout_posts;
drop trigger if exists pins_unpin_deleted_post on public.workout_posts;
drop trigger if exists invite_redemptions_seed_onboarding on public.invite_redemptions;
drop trigger if exists invite_redemptions_new_member_post on public.invite_redemptions;
drop trigger if exists private_records_attendance_log on public.private_records;
drop trigger if exists profiles_guard_staff_impersonation_trigger on public.profiles;
drop trigger if exists notif_bug_report_after_insert on public.bug_reports;
drop trigger if exists blocks_clear_follows_after_insert on public.blocks;

-- Triggers on auth.users that serve the dropped audit log and storage queue.
drop trigger if exists admin_actions_redact_before_user_delete on auth.users;
drop trigger if exists storage_queue_erasure_before_user_delete on auth.users;

-- 5. Stubs, so the policies that survive still compile.
create or replace function public.is_staff() returns boolean
  language sql stable set search_path = '' as $$ select false $$;
create or replace function public.is_admin() returns boolean
  language sql stable set search_path = '' as $$ select false $$;
create or replace function public.has_perm(p_permission text) returns boolean
  language sql stable set search_path = '' as $$ select false $$;
create or replace function public.admin_alert_recipients() returns setof uuid
  language sql stable set search_path = '' as $$ select null::uuid where false $$;
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.has_perm(text) from public, anon;
revoke execute on function public.admin_alert_recipients() from public, anon;

-- 6. Policies on kept tables that called a dropped function or table.
drop policy if exists clubs_delete_owner on public.clubs;
drop policy if exists clubs_insert_owner on public.clubs;
drop policy if exists clubs_write_owner on public.clubs;
create policy clubs_delete_owner on public.clubs for delete to authenticated
  using (public.is_admin());
create policy clubs_insert_owner on public.clubs for insert to authenticated
  with check (public.is_admin());
create policy clubs_write_owner on public.clubs for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists posts_feed_select on public.workout_posts;
create policy posts_feed_select on public.workout_posts for select to authenticated
  using (
    deleted_at is null
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = workout_posts.author_id)
         or (b.blocker_id = workout_posts.author_id and b.blocked_id = auth.uid())
    )
    and (
      author_id = auth.uid()
      or (public.is_community_member()
          and status = 'active'
          and visibility in ('public', 'club'))
    )
  );

drop policy if exists posts_insert_self on public.workout_posts;
create policy posts_insert_self on public.workout_posts for insert to authenticated
  with check (author_id = auth.uid() and public.is_community_member());

drop policy if exists member_achievements_read on public.member_achievements;
create policy member_achievements_read on public.member_achievements for select to authenticated
  using (
    public.is_community_member()
    and (user_id = auth.uid()
         or (visibility = 'club' and public.can_view_profile_field(user_id, 'show_achievements')))
  );

drop policy if exists post_training_partners_read on public.post_training_partners;
create policy post_training_partners_read on public.post_training_partners for select to authenticated
  using (
    tagged_user_id = auth.uid()
    or (exists (select 1 from public.workout_posts p where p.id = post_training_partners.post_id)
        and public.can_view_profile_field(tagged_user_id, 'visible_to_club'))
  );

-- 7. Kept helpers that read a dropped table or a dropped feature.
create or replace function public.account_holds_training_data(p_user_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_user_id is not null
     and exists (select 1 from public.private_records pr where pr.user_id = p_user_id);
$$;

create or replace function public.post_visible_to_viewer(p_post_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.workout_posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.author_id)
           or (b.blocker_id = p.author_id and b.blocked_id = auth.uid())
      )
      and (
        p.author_id = auth.uid()
        or (p.status = 'active' and p.visibility in ('public', 'club'))
      )
  );
$$;

-- 7b. Kept functions that called a dropped function, table or column.
-- Each is the definition in force before this migration with only the dropped
-- calls removed: feature-flag gates, has_perm and posting-restriction checks,
-- photo and media handling, follows/friends fan-out, the audit-log write.

CREATE OR REPLACE FUNCTION public.post_create(body text, visibility post_visibility, media jsonb, links jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_type public.post_type;
  v_metadata jsonb := '{}'::jsonb;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_pos_text text;
  v_pos smallint;
  v_width_text text;
  v_height_text text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('post_create', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230001. A post goes onto the feed, so the feed switch refuses it.
  -- COMM-153 enforcement, before the rate limit so a restricted member burns
  -- no budget and gets the accurate reason.
  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;
  if v_body = '' and v_media_count = 0 then
    raise exception 'a post needs text or at least one photo';
  end if;

  if links is not null and jsonb_typeof(links) = 'object' then
    if coalesce(links ->> 'workout_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('workout_id', links ->> 'workout_id');
    end if;
    if coalesce(links ->> 'achievement_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('achievement_id', links ->> 'achievement_id');
    end if;
    if coalesce(links ->> 'event_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('event_id', links ->> 'event_id');
    end if;
  end if;

  v_post_type := case
    when v_media_count > 0 and v_body = '' then 'POST_PHOTO'::public.post_type
    else 'POST_TEXT'::public.post_type
  end;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  insert into public.workout_posts (author_id, post_type, visibility, body, metadata, status, published_at)
  values (v_uid, v_post_type, coalesce(visibility, 'club'),
          nullif(v_body, ''), v_metadata, 'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  if v_media_count > 0 then raise exception 'photos are not supported'; end if;

  perform public.idem_complete('post_create', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $function$;

CREATE OR REPLACE FUNCTION public.post_edit_caption(post_id uuid, body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_body text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;
  if v_row.author_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_row.deleted_at is not null or v_row.status <> 'active' then
    raise exception 'post is no longer editable';
  end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. editing a post is a feed write.
  if not public.check_rate_limit('post_edit_caption', 30, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  -- Photos went with post_media, so a post is its text. The message keeps its
  -- old wording because the client's error map and outbox key on it.
  if v_body = '' then
    raise exception 'a post needs text or at least one photo';
  end if;

  update public.workout_posts set body = nullif(v_body, '') where id = post_id;
end $function$;

CREATE OR REPLACE FUNCTION public.pr_share(record_id text, note text DEFAULT ''::text, media jsonb DEFAULT '[]'::jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_rec public.private_records;
  v_prior_post public.workout_posts;
  v_upgrade boolean := false;
  v_payload jsonb := '{}'::jsonb;
  v_source_type text := 'strength_entry';
  v_metadata jsonb := '{}'::jsonb;
  v_title text;
  v_result text;
  v_prev_result text;
  v_improvement text;
  v_occurred date;
  v_weight numeric;
  v_reps numeric;
  v_duration numeric;
  v_est numeric;
  v_prev numeric;
  v_score numeric;
  v_exercise text;
  v_ts numeric;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('pr_share', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. a PR share writes a feed post.

  -- 160 is private_records.record_id's own CHECK: an id longer than that
  -- cannot name a record in this database, so it is rejected as malformed
  -- rather than silently treated as case (c).
  if record_id is null or btrim(record_id) = '' or char_length(record_id) > 160 then
    raise exception 'record is required';
  end if;

  -- Case (a): the caller's own row. deleted_at is honoured - a record the
  -- member has since deleted is not something to publish figures from.
  select * into v_rec
  from public.private_records r
  where r.user_id = v_uid
    and r.record_type in ('strength_entry', 'wod_entry')
    and r.record_id = pr_share.record_id
    and r.deleted_at is null;

  if found then
    v_payload := coalesce(v_rec.payload, '{}'::jsonb);
    v_source_type := v_rec.record_type;
  else
    -- Case (b). Checked only when the caller does not own the id, so the
    -- normal path never pays for it.
    if exists (
      select 1 from public.private_records r
      where r.record_id = pr_share.record_id
        and r.record_type in ('strength_entry', 'wod_entry')
        and r.user_id <> v_uid
    ) then
      raise exception 'not authorized';
    end if;
    -- Case (c) falls through with an empty payload and publishes no figures.
  end if;

  -- ---------------------------------------------------------------
  -- The prior-post probe. THIS is what 202609060019 got wrong: it
  -- returned whatever post held the record's unique slot without ever
  -- asking what KIND of post it was.
  -- ---------------------------------------------------------------
  select * into v_prior_post
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type in ('strength_entry', 'wod_entry')
    and p.source_record_id = pr_share.record_id
  limit 1;

  if found then
    -- Already the PR post. True idempotency: a double tap on "שיתוף", or a
    -- retry after a dropped response, converges on the first post and writes
    -- nothing. Ahead of the rate limit, so it costs no budget.
    if v_prior_post.post_type = 'POST_PR' then
      perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_prior_post.id));
      return v_prior_post.id;
    end if;

    -- The legacy workout share for this same record. Upgrade it in place;
    -- see the header for every field this does and does not move.
    if v_prior_post.post_type = 'POST_WORKOUT' then
      if v_prior_post.status <> 'active' then
        raise exception 'post is not available';
      end if;
      v_upgrade := true;
    else
      -- Not reachable from any shipped writer - post_create never sets
      -- source_record_id, and publishWorkout/pr_share are the only producers
      -- of a strength_entry/wod_entry row - but refusing loudly beats
      -- silently rewriting a post whose shape this function does not know.
      raise exception 'this record already has a post';
    end if;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  -- Body normalisation is post_create's, byte for byte.
  v_body := regexp_replace(
    coalesce(note, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;

  -- ---------------------------------------------------------------
  -- Everything below is recomputed from the record. Nothing is read
  -- from the request.
  -- ---------------------------------------------------------------
  if v_payload ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    v_occurred := (v_payload ->> 'date')::date;
  end if;

  v_exercise := nullif(v_payload ->> 'exerciseId', '');
  v_weight   := public.private_record_number(v_payload, 'weight');
  v_reps     := public.private_record_number(v_payload, 'reps');
  v_duration := public.private_record_number(v_payload, 'durationSeconds');
  v_est      := public.private_record_number(v_payload, 'est1RM');
  v_ts       := public.private_record_number(v_payload, 'ts');

  -- Only a custom movement is ever synced, so this resolves for some PRs
  -- and not others by design; see 202609060019's header.
  if v_exercise is not null then
    select nullif(left(btrim(coalesce(m.payload ->> 'name', '')), 120), '')
      into v_title
    from public.private_records m
    where m.user_id = v_uid and m.record_type = 'movement'
      and m.record_id = v_exercise and m.deleted_at is null;
  end if;

  if coalesce(v_payload ->> 'type', '') = 'duration' and v_duration is not null and v_duration > 0 then
    v_result := trim(trailing '.' from to_char(v_duration, 'FM999999990.99')) || ' שנ׳';
    if v_weight is not null and v_weight > 0 then
      v_result := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג · ' || v_result;
    end if;
    v_score := v_duration;
  elsif v_weight is not null and v_reps is not null and v_reps > 0 then
    v_result := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג × '
             || trim(trailing '.' from to_char(v_reps, 'FM999999990'));
    v_score := coalesce(v_est, v_weight);
  end if;

  -- The previous best for the SAME movement at the SAME rep count, from the
  -- caller's own history, excluding this record and anything logged after
  -- it. The only source of previous_result / improvement anywhere here.
  if v_exercise is not null and v_weight is not null and v_reps is not null and v_reps > 0 then
    select max(public.private_record_number(r.payload, 'weight')) into v_prev
    from public.private_records r
    where r.user_id = v_uid
      and r.record_type = 'strength_entry'
      and r.deleted_at is null
      and r.record_id <> pr_share.record_id
      and r.payload ->> 'exerciseId' = v_exercise
      and public.private_record_number(r.payload, 'reps') = v_reps
      and (v_ts is null or coalesce(public.private_record_number(r.payload, 'ts'), 0) < v_ts);

    if v_prev is not null and v_prev > 0 and v_weight > v_prev then
      v_prev_result := trim(trailing '.' from to_char(v_prev, 'FM999999990.99')) || ' ק"ג × '
                    || trim(trailing '.' from to_char(v_reps, 'FM999999990'));
      v_improvement := '+' || trim(trailing '.' from to_char(v_weight - v_prev, 'FM999999990.99')) || ' ק"ג';
    end if;
  end if;

  if v_title is not null then
    v_metadata := v_metadata || jsonb_build_object('movement', v_title);
  end if;
  -- COMM-105 / launch-readiness S17. The movement id, ALWAYS, whether or not
  -- the name resolved above.
  --
  -- v_title only resolves for a CUSTOM movement, because only a custom
  -- movement is ever synced to private_records - the built-in library
  -- (Back Squat, Deadlift, Strict Press) lives in the client and has no row
  -- here. So for most PRs, which are on built-in lifts, v_title was null, the
  -- post got no title, and the card fell through to the post-type label and
  -- announced every one of them as "שיא אישי".
  --
  -- The server cannot name a built-in movement and should not learn how: that
  -- list belongs to the client and changes with it. What it CAN do is say
  -- which movement it was, and let the renderer resolve the name out of the
  -- same library it already draws every other screen from - exactly what the
  -- gym display does with a built-in WOD id (202609230005).
  if v_exercise is not null then
    v_metadata := v_metadata || jsonb_build_object('movement_id', v_exercise);
  end if;
  if v_result is not null then
    v_metadata := v_metadata || jsonb_build_object('new_result', v_result);
  end if;
  if v_prev_result is not null then
    v_metadata := v_metadata || jsonb_build_object('previous_result', v_prev_result, 'improvement', v_improvement);
  end if;
  if v_occurred is not null then
    v_metadata := v_metadata || jsonb_build_object('achieved_on', v_occurred);
  end if;

  -- post_create's rule, asked of this shape: a card with no figures, no
  -- caption and no photo says nothing at all. On the upgrade path the card
  -- already exists and already carries a title and a result, so the check
  -- applies only to what is actually on the row.
  if v_result is null and v_body = '' and v_media_count = 0
     and (not v_upgrade
          or coalesce(v_prior_post.result_text, v_prior_post.title, v_prior_post.body) is null)
  then
    raise exception 'a post needs text or at least one photo';
  end if;

  if v_upgrade then
    -- deleted_at, score_value and score_direction are guarded by
    -- workout_posts_guard_moderated_fields; post_type is guarded by
    -- workout_posts_guard_privileged_type (202609110004). Both pins are
    -- transaction-local and unrelated to each other, nested here because
    -- this one statement moves columns both of them own.
    perform set_config('app.allow_moderation_write', 'on', true);
    perform set_config('app.allow_pr_achievement_write', 'on', true);
    update public.workout_posts p
       set post_type       = 'POST_PR',
           source_type     = v_source_type,
           body            = coalesce(nullif(v_body, ''), p.body),
           title           = coalesce(v_title, p.title),
           result_text     = coalesce(v_result, p.result_text),
           occurred_on     = coalesce(v_occurred, p.occurred_on),
           score_value     = coalesce(v_score, p.score_value),
           score_direction = case when coalesce(v_score, p.score_value) is null
                                  then null else 'higher' end,
           metadata        = coalesce(p.metadata, '{}'::jsonb) || v_metadata,
           deleted_at      = null
     where p.id = v_prior_post.id
    returning p.id into v_post_id;
    perform set_config('app.allow_pr_achievement_write', 'off', true);
    perform set_config('app.allow_moderation_write', 'off', true);

    -- The PR prompt has its own photo picker, so the media it sends IS the
    -- card's media. Only ever runs when the caller actually supplied some:
    -- a PR share with no photo destroys nothing. publishWorkout's own photo
    -- lives in workout_posts.photo_path, a different column, and survives
    -- either way.
  else
    perform set_config('app.allow_unrated_post_insert', 'on', true);
    perform set_config('app.allow_pr_achievement_write', 'on', true);
    insert into public.workout_posts (
      author_id, post_type, visibility, body, title, result_text,
      source_type, source_record_id, occurred_on, score_value, score_direction,
      metadata, status, published_at)
    values (
      v_uid, 'POST_PR', 'club', nullif(v_body, ''), v_title, v_result,
      v_source_type, pr_share.record_id, coalesce(v_occurred, current_date), v_score,
      case when v_score is null then null else 'higher' end,
      v_metadata, 'active', now())
    returning id into v_post_id;
    perform set_config('app.allow_pr_achievement_write', 'off', true);
    perform set_config('app.allow_unrated_post_insert', 'off', true);
  end if;

  if v_media_count > 0 then raise exception 'photos are not supported'; end if;

  perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $function$;

CREATE OR REPLACE FUNCTION public.ach_share(member_achievement_id uuid, caption text DEFAULT ''::text, media jsonb DEFAULT '[]'::jsonb, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_ma public.member_achievements;
  v_def public.achievement_definitions;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('ach_share', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. the achievement is the subject.
  -- 202609230003. and the share is a feed post.

  if member_achievement_id is null then raise exception 'achievement is required'; end if;

  select * into v_ma from public.member_achievements ma where ma.id = member_achievement_id;
  if not found then raise exception 'achievement not found'; end if;
  -- The ownership boundary. Not 'achievement not found': the row does exist
  -- and refusing it as missing would be a lie to the one member whose
  -- achievement it is not.
  if v_ma.user_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_ma.visibility = 'only_me' then raise exception 'a private achievement cannot be shared'; end if;
  -- Security hunt round 6 (202609120001). member_achievements.verified is
  -- computed server-side, unconditionally, by member_achievements_verified_trg
  -- - a member holding a genuine row for an unverifiable (client-claimed)
  -- metric still gets the local celebration and the badge count, just not a
  -- public social-proof post manufactured from a claim nothing here
  -- actually checked.
  if not v_ma.verified then raise exception 'achievement not verified'; end if;

  select * into v_def from public.achievement_definitions d where d.id = v_ma.achievement_id;
  if not found then raise exception 'achievement not found'; end if;

  -- Natural idempotency, same reasoning as pr_share's.
  select p.id into v_post_id
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type = 'achievement'
    and p.source_record_id = member_achievement_id::text
  limit 1;
  if v_post_id is not null then
    update public.member_achievements
       set shared_at = now()
     where id = member_achievement_id and shared_at is null;
    perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
    return v_post_id;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(caption, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  perform set_config('app.allow_pr_achievement_write', 'on', true);
  insert into public.workout_posts (
    author_id, post_type, visibility, body, title, result_text,
    source_type, source_record_id, source_id, occurred_on, metadata, status, published_at)
  values (
    v_uid, 'POST_ACHIEVEMENT', v_ma.visibility::public.post_visibility,
    nullif(v_body, ''), left(v_def.name, 120), nullif(left(v_def.description, 240), ''),
    'achievement', member_achievement_id::text, member_achievement_id,
    v_ma.unlocked_at::date,
    jsonb_strip_nulls(jsonb_build_object(
      'achievement_id', v_ma.id,
      'code', v_def.code,
      'title', v_def.name,
      'badge_icon', v_def.icon,
      'explanation', nullif(v_def.description, ''),
      'earned_on', v_ma.unlocked_at::date)),
    'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_pr_achievement_write', 'off', true);
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  if v_media_count > 0 then raise exception 'photos are not supported'; end if;

  update public.member_achievements
     set shared_at = now()
   where id = member_achievement_id and shared_at is null;

  perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $function$;

CREATE OR REPLACE FUNCTION public.post_tag_training_partners(p_post_id uuid, p_members uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_post public.workout_posts;
  v_targets uuid[];
  v_count int;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- The write gate, not the read gate: this creates content that reaches
  -- another member's notification stream, so it is is_community_member()
  -- (a verified recovery method) and the posting restriction, the same two
  -- add_post_comment checks in the same order.
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- Generous: editing the list on one post costs several calls as the member
  -- ticks names, and this is a per-10-minute budget, not a per-post one.
  if not public.check_rate_limit('post_tag_training_partners', 60, 10) then
    raise exception 'rate_limited';
  end if;

  -- The same cap add_post_comment puts on mentions, for the same reason: a
  -- post naming forty members is a fan-out, not a memory of a class. Checked
  -- before anything is written.
  if p_members is not null and array_length(p_members, 1) > 10 then
    raise exception 'at most 10 training partners per post';
  end if;

  -- security definer, so workout_posts' RLS is not doing this for us. Every
  -- condition the policy would have applied is stated.
  select * into v_post from public.workout_posts where id = p_post_id;
  if not found then raise exception 'post not found'; end if;
  if v_post.deleted_at is not null or v_post.status <> 'active' then
    raise exception 'post not found';
  end if;
  -- THE AUTHOR AND NOBODY ELSE. Not a coach, not an admin: this is the
  -- author saying who they trained with, and a third party writing it would
  -- be putting words in their mouth as surely as editing the body would.
  if v_post.author_id is distinct from v_uid then raise exception 'not authorized'; end if;
  -- Workout posts only. The other twelve post types are an announcement, an
  -- achievement, a linked event - none of them is a session anybody else was
  -- present at, and a "we trained together" line under a club announcement
  -- would be nonsense the card would still have to render.
  if v_post.post_type <> 'POST_WORKOUT' then
    raise exception 'training partners are for workout posts';
  end if;

  select coalesce(array_agg(distinct t.target), array[]::uuid[]) into v_targets
  from unnest(coalesce(p_members, array[]::uuid[])) as t(target)
  -- Self is dropped silently. The author is on their own post by definition
  -- and a self-tag would notify nobody and render the author's name twice.
  where t.target is not null and t.target <> v_uid;

  -- Untagging is half of a set write, and it is NOT gated on the target
  -- still passing the consent check below - a member who has since turned
  -- allow_mentions off, or blocked the author, must still be removable.
  delete from public.post_training_partners
  where post_id = p_post_id and tagged_user_id <> all (v_targets);

  insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
  select p_post_id, t.target, v_uid
  from unnest(v_targets) as t(target)
  where exists (select 1 from public.profiles p where p.id = t.target and p.deleted_at is null)
    -- The consent gate. One call, and it is the identical call
    -- add_post_comment makes about a comment mention - see this file's
    -- header for why the is_admin() short-circuit it carries is left alone
    -- here rather than narrowed in one of two twins.
    and public.can_view_profile_field(t.target, 'allow_mentions')
  -- A re-save of the same list must not re-notify: the conflict keeps the
  -- original row, so no INSERT fires and the trigger below does not run.
  on conflict (post_id, tagged_user_id) do nothing;

  select count(*) into v_count from public.post_training_partners where post_id = p_post_id;
  return v_count;
end $function$;

CREATE OR REPLACE FUNCTION public.ach_claim(p_codes text[])
 RETURNS SETOF ach_claim_row
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_codes text[];
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Same gate every other community write carries. Reading achievements
  -- stays open; awarding one does not.
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230001. Awarding is refused while the module is off. The client
  -- (claimCommunityAchievements) reads the error as "retry later", so a
  -- threshold crossed while it is off is claimed once it is back on.

  -- A null or empty array is a no-op, not an error: the client calls this
  -- on every sync and usually has nothing to claim.
  if p_codes is null or array_length(p_codes, 1) is null then return; end if;
  if array_length(p_codes, 1) > 50 then raise exception 'at most 50 codes per call'; end if;

  -- The write side is bounded by the definitions themselves (once per
  -- non-repeatable code), but a repeatable client-claimable definition
  -- would otherwise be an unbounded insert loop, so the call itself is
  -- limited the same way every other member write path is.
  if not public.check_rate_limit('ach_claim', 30, 10) then raise exception 'rate_limited'; end if;

  select array_agg(distinct t.code) into v_codes
  from unnest(p_codes) as t(code)
  where t.code is not null and t.code <> '';
  if v_codes is null then return; end if;

  return query
  with accepted as (
    select d.id, d.code, d.visibility, d.repeatable
    from public.achievement_definitions d
    where d.code = any(v_codes)
      and d.enabled
      and d.trigger_type <> 'ATTENDANCE_RECORDED'
      and coalesce(d.config ->> 'client_claimable', '') = 'true'
      -- A non-repeatable code already held is silently absent from the
      -- result rather than an error, so a replay after a reinstall
      -- celebrates nothing.
      and (
        d.repeatable
        or not exists (
          select 1 from public.member_achievements ma
          where ma.user_id = v_uid and ma.achievement_id = d.id
        )
      )
      -- Tenure is independently verified against invite_redemptions, a
      -- server-set timestamp, rather than trusted from the client like the
      -- other client_claimable metrics. Anything not tenure-metered short
      -- circuits true here and is unaffected.
      and (
        coalesce(d.config ->> 'metric', '') <> 'tenure_days'
        or exists (
          select 1 from public.invite_redemptions ir
          where ir.user_id = v_uid
            and ir.redeemed_at <= now() - (d.threshold || ' days')::interval
        )
      )
  ), ins as (
    insert into public.member_achievements (user_id, achievement_id, visibility)
    select v_uid, a.id, a.visibility from accepted a
    -- member_achievements_once_idx is what actually holds the once rule
    -- under two concurrent claims; the NOT EXISTS above only narrows the
    -- common case. A lost race is swallowed, never surfaced.
    on conflict do nothing
    returning id, achievement_id, visibility
  )
  select a.code, ins.id, ins.visibility
  from ins join accepted a on a.id = ins.achievement_id;
end $function$;

CREATE OR REPLACE FUNCTION public.toggle_reaction(p_post_id uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing boolean;
  v_replay boolean;
  v_prior jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('toggle_reaction', p_idempotency_key, p_post_id::text) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::boolean; end if;

  select exists(select 1 from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer') into v_existing;
  if v_existing then
    delete from public.reactions where post_id = p_post_id and user_id = auth.uid() and kind = 'cheer';
    perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(false));
    return false;
  end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. a reaction hangs off a feed post.
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.reactions(post_id, user_id, kind) values (p_post_id, auth.uid(), 'cheer');
  perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(true));
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.post_delete(post_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_is_mod boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;

  v_is_mod := false;

  if v_row.author_id is distinct from v_uid and not v_is_mod then
    raise exception 'not authorized';
  end if;

  if v_row.deleted_at is not null and v_row.status = 'removed' then return; end if;

  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts
    set deleted_at = now(), status = 'removed'
  where id = post_id;
  perform set_config('app.allow_moderation_write', 'off', true);

  -- Security hunt round 4 (202609110005): same redaction as
  -- comment_moderate(), for any notification snapshot pointing at this post
  -- directly (e.g. a 'new_report' alert, whose source_type/source_id point
  -- at the reported target per 202609050003) - not the post's OWN comments,
  -- which are a separate content type this function never touches. Its own
  -- pin window, separate from the one above: unrelated tables, unrelated
  -- guard triggers.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications
     set title = '', body = ''
   where source_type = 'post' and source_id = post_id
     and (title <> '' or body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);

end $function$;

CREATE OR REPLACE FUNCTION public.notif_create(p_user uuid, p_type text, p_category text, p_title text, p_body text, p_source_type text, p_source_id uuid, p_deep_link text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if p_user is null then return null; end if;
  if p_type is null or p_type !~ '^[a-z][a-z0-9_.]{2,63}$' then
    raise exception 'unknown notification type %', p_type;
  end if;
  if p_category not in ('community', 'training', 'challenges', 'events', 'club') then
    raise exception 'unknown notification category %', p_category;
  end if;

  -- Recipient is never the actor, except the self-directed types.
  if v_actor is not null and p_user = v_actor
     and p_type not in ('achievement_unlocked', 'weekly_recap') then
    return null;
  end if;

  if public.notif_blocked_between(p_user, v_actor) then
    return null;
  end if;

  if not public.notif_pref_allows(p_user, p_type) then
    return null;
  end if;

  if exists (
    select 1 from public.notifications n
    where n.user_id = p_user
      and n.type = p_type
      and n.source_id is not distinct from p_source_id
      and n.created_at > now() - public.notif_dedupe_window()
  ) then
    return null;
  end if;

  insert into public.notifications
    (user_id, type, category, title, body, source_type, source_id, deep_link)
  values (
    p_user, p_type, p_category,
    coalesce(left(p_title, 160), ''),
    coalesce(left(p_body, 500), ''),
    p_source_type, p_source_id, p_deep_link
  )
  returning id into v_id;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.notif_push_pending(p_limit integer DEFAULT 200)
 RETURNS TABLE(notification_id uuid, subscription_id uuid, endpoint text, p256dh text, auth_secret text, title text, body text, deep_link text, notification_type text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select n.id, s.id, s.endpoint,
         s.keys->>'p256dh', s.keys->>'auth',
         n.title, n.body, n.deep_link, n.type
    from public.notifications n
    join public.profiles pr on pr.id = n.user_id and pr.deleted_at is null
    join public.push_subscriptions s on s.user_id = n.user_id and s.revoked_at is null
   where n.push_sent_at is null
     and n.created_at > now() - interval '24 hours'
     and exists (
       select 1 from public.notification_preferences np
        where np.user_id = n.user_id
          and np.type = public.notif_pref_key(n.type)
          and np.channel = 'push'
     )
     and coalesce(s.keys->>'p256dh', '') <> ''
     and coalesce(s.keys->>'auth', '') <> ''
   order by n.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$function$;

CREATE OR REPLACE FUNCTION public.workout_posts_guard_privileged_type()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pinned boolean;
begin
  -- An UPDATE that names post_type in its SET list fires this trigger even
  -- when the value does not move. Editing the caption of a real post must
  -- not be refused.
  if tg_op = 'UPDATE' and new.post_type is not distinct from old.post_type then
    return new;
  end if;

  if new.post_type in ('POST_PR', 'POST_ACHIEVEMENT') then
    -- Unlike the staff-only labels below, this check is scoped to real
    -- authenticated callers only - matching workout_posts_guard_moderated_fields'
    -- own precedent ("skipped entirely when auth.role() is not
    -- authenticated - service role, dashboard, backfills unaffected").
    -- The threat model here is a real client bypassing pr_share()/
    -- ach_share() over PostgREST; a superuser/service-role/backfill
    -- context (fixture setup, a future admin tool) is not part of it, and
    -- several existing pgTAP fixtures across this suite seed a POST_PR row
    -- directly as bootstrap-superuser test data.
    if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
    v_pinned := coalesce(current_setting('app.allow_pr_achievement_write', true), '') = 'on';
    if v_pinned then return new; end if;
    -- The one pre-existing, still-live exception: publishAchievement()
    -- (cloud.js) shares a LOCAL, client-only achievement badge (app.js's
    -- own offline achievement engine, distinct from and older than the
    -- server-tracked member_achievements/ach_share() system) via a direct
    -- upsert with no post_type column at all, relying on default_post_type()
    -- to derive POST_ACHIEVEMENT from source_type='achievement'. There is
    -- no server record to verify a LOCAL badge against - by original
    -- design, same as POST_WORKOUT (publishWorkout, never guarded here
    -- either): a member's own self-reported log entry, trusted exactly as
    -- much as it always has been, no more. Distinguished from a REAL
    -- ach_share() row (source_record_id = a genuine member_achievements.id,
    -- always uuid-shaped) by shape: a local badge slug ("sessions-50",
    -- "pr-squat-gold", "tenure-<id>", "streak-<tier>", ...) never is.
    -- A uuid-shaped source_record_id gets NO exemption and still requires
    -- the pin, so this cannot be used to smuggle a fake ach_share()-style
    -- row past the real check.
    if new.post_type = 'POST_ACHIEVEMENT'
       and new.source_type = 'achievement'
       and new.source_record_id is not null
       and new.source_record_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then
      return new;
    end if;
    raise exception 'post type requires server-verified evidence';
  end if;

  if new.post_type not in (
    'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_SYSTEM', 'POST_NEW_MEMBER',
    'POST_CLUB_WOD'
  ) then
    return new;
  end if;

  -- Server-authored rows. Every real producer of these labels is here.
  if new.author_id is null then
    return new;
  end if;

  -- No member holds staff status any more (is_staff()/is_admin() are stubs
  -- returning false), so an authored row carrying one of these labels is
  -- refused for everyone. The old exemption for profiles.is_admin is gone:
  -- the column survives only until the account tables are reshaped, and a
  -- flag nothing can set must not remain a way past a guard.
  raise exception 'post type is staff only';
end $function$;

CREATE OR REPLACE FUNCTION public.clubs_guard_single_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- A BEFORE INSERT trigger fires BEFORE the RLS WITH CHECK policy, so an
  -- unconditional raise here would preempt clubs_insert_owner and hand a
  -- plain member a P0001 "single_club_invariant" message where RLS would
  -- (and should) have given them a plain 42501 permission-denied - both
  -- leaking this invariant's reasoning to someone not authorized to insert
  -- at all, and breaking 0001_clubs_and_rbac_test's "a plain member cannot
  -- insert a club" assertion, which is the RLS boundary and not this
  -- trigger's business. Caught on the first real pgTAP run. So: defer to RLS
  -- for anyone RLS will refuse anyway, and only speak up for a caller who
  -- WOULD otherwise succeed - the owner, and any non-authenticated session
  -- (service role, dashboard, a future backfill), which is exactly the
  -- SEC-008 case this guard exists for.
  if coalesce(auth.role(), '') = 'authenticated' then
    return new;
  end if;

  if (select count(*) from public.clubs) >= 1 then
    raise exception 'single_club_invariant: this schema has no multi-tenant filtering yet (202608280001), so a second clubs row would silently cross-tenant-leak every unfiltered read policy - see SECURITY_AUDIT.md SEC-008 before adding one';
  end if;
  return new;
end $function$;

-- The preference key a notification type maps to. Seven of the ten arms named
-- types whose producers are dropped above (comment_reply, comment_on_post,
-- comment_also, mention, coach_mention, announcement, friend_achievement,
-- event_cancelled); a mapping for a type nothing can write is dead text that
-- reads as live. reaction keeps its plural preference key; every other type
-- is its own key.
CREATE OR REPLACE FUNCTION public.notif_pref_key(p_type text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_type
    when 'reaction' then 'reactions'
    else p_type
  end;
$function$;

CREATE OR REPLACE FUNCTION public.retention_purge_telemetry(p_days integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 3650);
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  v_deleted integer := 0;
  v_n integer;
begin
  delete from public.analytics_events where created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  -- Launch-readiness N11. A push subscription the browser has already revoked
  -- is a dead endpoint plus the keys that went with it, kept forever.
  --
  -- NINETY DAYS, NOT v_days. This deliberately does not follow the caller's
  -- retention argument: v_days is the community-activity promise
  -- (PRIVACY.md), and a revoked push endpoint is not community activity - it
  -- is a device registration that has already been withdrawn. Tying them
  -- together would mean a future change to one silently moving the other.
  --
  -- Not deleted the instant it is revoked, because revoked_at is also what
  -- stops notif_push_pending() re-selecting a dead endpoint; a short tail
  -- keeps that cheap and leaves room to see what happened after a delivery
  -- incident.
  delete from public.push_subscriptions
   where revoked_at is not null
     and revoked_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  return v_deleted;
end $function$;

CREATE OR REPLACE FUNCTION public.default_post_type()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.post_type is null then
    new.post_type := case
      when new.source_type = 'achievement' then 'POST_ACHIEVEMENT'
      when new.source_type in ('strength_entry', 'wod_entry') then 'POST_WORKOUT'
      else 'POST_TEXT'
    end::public.post_type;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.post_training_partners_for(p_post_ids uuid[])
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'post_id', tp.post_id,
    'user_id', tp.tagged_user_id,
    'display_name', pr.display_name,
    'handle', pr.handle
  )
  from public.post_training_partners tp
  join public.profiles pr on pr.id = tp.tagged_user_id
  where tp.post_id = any (coalesce(p_post_ids, array[]::uuid[]))
  -- A total order, so two members tagged in the same transaction do not
  -- swap places between two renders of the same card.
  order by tp.post_id,
           tp.created_at asc,
           coalesce(nullif(btrim(pr.display_name), ''), pr.handle) asc,
           tp.tagged_user_id asc
  -- 20 posts a page, 10 tags a post, and the ceiling is never reached in
  -- practice - it is here so a hand-made call with a thousand ids cannot
  -- ask the database for an unbounded result.
  limit 200;
$function$;

CREATE OR REPLACE FUNCTION public.notif_on_achievement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := new.user_id;
  v_name text;
begin
  -- 202609230003. gated on the module that owns it.
  select d.name into v_name
  from public.achievement_definitions d where d.id = new.achievement_id;

  perform public.notif_create(
    v_user, 'achievement_unlocked', 'training',
    'Achievement unlocked', coalesce(v_name, ''),
    'achievement', new.id,
    '/community/account/achievements?ma=' || new.id::text
  );

  -- Friend fan-out only when the unlocker exposes achievements at all.
  return null;
end $function$;

-- 8. Policies and triggers on the tables about to go. They reference dropped
-- functions, so they have to leave before the functions do.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and tablename = any (array['admin_actions', 'announcements', 'attendance_log', 'challenge_participants', 'challenge_progress', 'challenge_teams', 'challenges', 'club_features', 'club_wod_results', 'club_wod_sessions', 'club_wods', 'coach_congratulations', 'coach_engagement_flags', 'coach_tasks', 'comment_mentions', 'community_health_scores', 'event_attendees', 'events', 'feed_impressions', 'feed_interactions', 'follows', 'hidden_posts', 'intro_carousel_content', 'member_contact_log', 'member_feed_weights', 'member_of_week', 'monthly_club_recaps', 'onboarding_challenge_offers', 'onboarding_progress', 'onboarding_step_content', 'owner_reports', 'permissions', 'pins', 'post_comments', 'post_media', 'posting_restrictions', 'reports', 'role_permissions', 'roles', 'saved_posts', 'storage_erasure_queue', 'training_log_usage', 'weekly_challenges', 'weekly_challenges_archive', 'weekly_recaps'])
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
  for r in
    select c.relname, t.tgname from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
      and c.relname = any (array['admin_actions', 'announcements', 'attendance_log', 'challenge_participants', 'challenge_progress', 'challenge_teams', 'challenges', 'club_features', 'club_wod_results', 'club_wod_sessions', 'club_wods', 'coach_congratulations', 'coach_engagement_flags', 'coach_tasks', 'comment_mentions', 'community_health_scores', 'event_attendees', 'events', 'feed_impressions', 'feed_interactions', 'follows', 'hidden_posts', 'intro_carousel_content', 'member_contact_log', 'member_feed_weights', 'member_of_week', 'monthly_club_recaps', 'onboarding_challenge_offers', 'onboarding_progress', 'onboarding_step_content', 'owner_reports', 'permissions', 'pins', 'post_comments', 'post_media', 'posting_restrictions', 'reports', 'role_permissions', 'roles', 'saved_posts', 'storage_erasure_queue', 'training_log_usage', 'weekly_challenges', 'weekly_challenges_archive', 'weekly_recaps'])
  loop
    execute format('drop trigger %I on public.%I', r.tgname, r.relname);
  end loop;
end $$;

-- 9. Functions, old overloads included. No CASCADE: a dependency that is not
-- listed above must fail this migration, not silently remove a kept policy.
drop function if exists public.add_post_comment(p_post_id uuid, p_body text);
drop function if exists public.add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid);
drop function if exists public.add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid, p_mentions uuid[], p_idempotency_key uuid);
drop function if exists public.admin_actions_page(p_cursor timestamp with time zone, p_limit integer, p_filters jsonb, p_cursor_id uuid);
drop function if exists public.admin_actions_redact_on_user_delete();
drop function if exists public.admin_check_password_reset_rate_limit();
drop function if exists public.admin_grant_coach(p_user_id uuid);
drop function if exists public.admin_grant_coach(p_user_id uuid, p_role text);
drop function if exists public.admin_incomplete_signups(p_cursor timestamp with time zone, p_limit integer, p_cursor_id uuid);
drop function if exists public.admin_invite_code_create(p_role text, p_expires_at timestamp with time zone, p_max_uses integer);
drop function if exists public.admin_invite_code_list();
drop function if exists public.admin_invite_code_set_active(p_code_id uuid, p_active boolean);
drop function if exists public.admin_invite_create(p_role text, p_label text, p_expires_at timestamp with time zone);
drop function if exists public.admin_invite_list(p_status text, p_cursor timestamp with time zone, p_limit integer, p_cursor_id uuid);
drop function if exists public.admin_invite_revoke(p_invite_id uuid);
drop function if exists public.admin_log_password_reset(p_user_id uuid);
drop function if exists public.admin_member_roster(p_cursor timestamp with time zone, p_limit integer, p_cursor_id uuid);
drop function if exists public.admin_reclaim_invite(p_user_id uuid, p_note text, p_older_than_days integer);
drop function if exists public.admin_remove_member(p_user_id uuid);
drop function if exists public.admin_revoke_coach(p_user_id uuid);
drop function if exists public.admin_search_members(p_query text);
drop function if exists public.admin_set_club_feature(p_module_key text, p_enabled boolean, p_config jsonb);
drop function if exists public.analytics_breakdown(p_event text, p_prop text, p_from timestamp with time zone, p_to timestamp with time zone);
drop function if exists public.analytics_dashboard(p_period_start date, p_period_end date);
drop function if exists public.analytics_event_uuid(p_props jsonb, p_key text);
drop function if exists public.analytics_ratio(p_num numeric, p_den numeric);
drop function if exists public.analytics_wcam_events();
drop function if exists public.analytics_week_buckets(p_start date, p_end date);
drop function if exists public.announcement_feed_card_insert();
drop function if exists public.announcement_feed_card_sync();
drop function if exists public.announcement_priority_rank(p_priority text);
drop function if exists public.announcements_audit_cross_author_edit();
drop function if exists public.announcements_module_gate();
drop function if exists public.announcements_priority_sync();
drop function if exists public.are_friends(p_other uuid);
drop function if exists public.attendance_classmates_on(p_day date, p_limit integer);
drop function if exists public.attendance_classmates_today(p_limit integer);
drop function if exists public.attendance_log_from_record();
drop function if exists public.attendance_milestones_on_log();
drop function if exists public.attendance_parse_day(p_raw text);
drop function if exists public.attendance_session_record_types();
drop function if exists public.attendance_week_streak(p_user uuid, p_exclude_day date);
drop function if exists public.audit_identity_label(p_user uuid);
drop function if exists public.blocks_clear_follows();
drop function if exists public.bug_report_alert_recipients();
drop function if exists public.bug_report_list_all(p_status text, p_limit integer);
drop function if exists public.bug_report_set_status(p_id uuid, p_status text, p_note text);
drop function if exists public.can_upload_post_photo(p_name text);
drop function if exists public.can_write_own_avatar(p_name text);
drop function if exists public.chal_notify_ending_soon();
drop function if exists public.chal_progress(challenge_id uuid);
drop function if exists public.chal_reassign_team(p_challenge_id uuid, p_user_id uuid, p_team_id uuid);
drop function if exists public.chal_record_progress(p_challenge_id uuid, p_user_id uuid, p_delta numeric, p_note text, p_idempotency_key uuid);
drop function if exists public.chal_set_captain(p_team_id uuid, p_user_id uuid);
drop function if exists public.challenge_participants_guard_progress();
drop function if exists public.challenge_participants_guard_team();
drop function if exists public.challenge_progress_apply();
drop function if exists public.challenge_progress_stamp_team();
drop function if exists public.challenge_teams_block_delete();
drop function if exists public.challenge_teams_guard_captain();
drop function if exists public.challenge_teams_release_captain();
drop function if exists public.classmate_day_counts(p_as_of timestamp with time zone);
drop function if exists public.club_feature_choice(p_module_key text, p_key text, p_default text, p_allowed text[]);
drop function if exists public.club_feature_enabled(p_module_key text, p_sub_key text);
drop function if exists public.club_feature_enabled_at(p_module_key text);
drop function if exists public.club_feature_number(p_module_key text, p_key text, p_default numeric, p_min numeric, p_max numeric);
drop function if exists public.club_features_for_caller();
drop function if exists public.club_features_stamp_enabled_at();
drop function if exists public.club_summary();
drop function if exists public.club_wod_attach_result(p_session_id uuid, p_record_id text, p_entry jsonb, p_idempotency_key uuid);
drop function if exists public.club_wod_board(p_session_id uuid);
drop function if exists public.club_wod_board_json(p_session_id uuid);
drop function if exists public.club_wod_boards(p_from date, p_to date);
drop function if exists public.club_wod_challenge_conflict(p_wod_id text, p_include_started boolean);
drop function if exists public.club_wod_detach_result(p_session_id uuid);
drop function if exists public.club_wod_edit(p_wod_id text, p_name text, p_description text);
drop function if exists public.club_wod_json(w club_wods);
drop function if exists public.club_wod_publish(p_wod_id text, p_name text, p_score_type text, p_description text, p_emom_movements jsonb, p_emom_target_reps jsonb, p_emom_minutes integer, p_time_cap_seconds integer);
drop function if exists public.club_wod_restore(p_wod_id text);
drop function if exists public.club_wod_retire(p_wod_id text, p_reason text);
drop function if exists public.club_wod_session_cancel(p_session_id uuid, p_reason text);
drop function if exists public.club_wod_session_publish(p_wod_id text, p_session_date date, p_note text, p_idempotency_key uuid);
drop function if exists public.club_wods_list();
drop function if exists public.coach_activity_signal_status();
drop function if exists public.coach_assign_coach(p_user_id uuid, p_coach_id uuid);
drop function if exists public.coach_celebrate_feed(p_days integer);
drop function if exists public.coach_congratulate(p_kind text, p_target_user_id uuid, p_occurred_at timestamp with time zone, p_post_id uuid, p_parent_comment_id uuid, p_body text);
drop function if exists public.coach_detect_engagement_decline();
drop function if exists public.coach_inactive_members(p_since date);
drop function if exists public.coach_new_members(p_within_days integer);
drop function if exists public.coach_notify_engagement_flags();
drop function if exists public.coach_task_members();
drop function if exists public.coach_tasks_close_on_contact();
drop function if exists public.coach_tasks_guard_update();
drop function if exists public.coach_tasks_refresh(p_include_closed boolean, p_limit integer);
drop function if exists public.coach_tasks_sync();
drop function if exists public.comment_delete(p_comment_id uuid);
drop function if exists public.comment_edit(p_comment_id uuid, p_body text);
drop function if exists public.comment_moderate(p_comment_id uuid, p_action text);
drop function if exists public.community_health_component(p_value numeric, p_sub_score numeric, p_weight numeric, p_weight_total numeric, p_detail jsonb);
drop function if exists public.community_health_generate(p_week_start date);
drop function if exists public.community_health_history(p_weeks integer);
drop function if exists public.community_profile(user_id uuid);
drop function if exists public.community_search(p_query text, p_limit integer);
drop function if exists public.community_streaks(p_limit integer);
drop function if exists public.consistency_week_streaks();
drop function if exists public.enforce_comment_depth();
drop function if exists public.enforce_event_capacity();
drop function if exists public.enforce_pin_target();
drop function if exists public.enforce_post_media_ownership();
drop function if exists public.enforce_post_photo_ownership();
drop function if exists public.event_rsvp(p_event_id uuid, p_response text, p_idempotency_key uuid);
drop function if exists public.feed_leaderboard(p_mode text, p_challenge_id uuid, p_scope text, p_limit integer);
drop function if exists public.feed_page(p_cursor text, p_limit integer, p_scope text);
drop function if exists public.feed_record_impressions(p_rows jsonb);
drop function if exists public.feed_record_interaction(p_post_id uuid, p_kind text, p_feed_session_id uuid);
drop function if exists public.feed_weights_resolve(p_user uuid, p_defaults jsonb);
drop function if exists public.grant_coach_role(p_user_id uuid);
drop function if exists public.grant_coach_role_by_handle(p_handle text);
drop function if exists public.gym_display_board();
drop function if exists public.gym_display_mask_name(p_name text);
drop function if exists public.hide_management_from_member(p_uid uuid);
drop function if exists public.intro_carousel_content_audit();
drop function if exists public.intro_carousel_content_pin();
drop function if exists public.is_gym_display();
drop function if exists public.is_management_account(p_uid uuid);
drop function if exists public.is_posting_restricted(p_user uuid);
drop function if exists public.list_orphaned_avatar_photos(p_older_than interval);
drop function if exists public.list_orphaned_post_photos(p_older_than interval);
drop function if exists public.log_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_action_detail text, p_note text, p_target_user_id uuid);
drop function if exists public.management_user_ids();
drop function if exists public.member_of_week_candidate_set(p_category text, p_week_start date, p_limit integer);
drop function if exists public.member_of_week_candidates(p_week_start date);
drop function if exists public.member_of_week_category(p_week_start date);
drop function if exists public.member_of_week_category_label(p_category text);
drop function if exists public.member_of_week_publish(p_week_start date, p_user_id uuid, p_reason text);
drop function if exists public.member_role_rank(p_user_id uuid);
drop function if exists public.member_roles(p_ids uuid[]);
drop function if exists public.member_segments(p_as_of date);
drop function if exists public.mod_alert_recipients(p_club_id uuid);
drop function if exists public.mod_lift_restriction(p_restriction_id uuid, p_reason text);
drop function if exists public.mod_queue(p_status text, p_cursor timestamp with time zone, p_limit integer);
drop function if exists public.mod_restrict_member(p_user uuid, p_type text, p_expires_at timestamp with time zone, p_reason text, p_report_id uuid);
drop function if exists public.mod_review(p_report_id uuid, p_decision text, p_note text, p_expires_at timestamp with time zone);
drop function if exists public.monthly_club_recaps_freeze();
drop function if exists public.my_permissions();
drop function if exists public.my_posting_restrictions();
drop function if exists public.my_role_code();
drop function if exists public.normalize_post_media_alt();
drop function if exists public.notif_announcement_fanout(p_id uuid, p_off_only boolean);
drop function if exists public.notif_is_operational(p_type text, p_source_id uuid);
drop function if exists public.notif_on_announcement();
drop function if exists public.notif_on_bug_report();
drop function if exists public.notif_on_challenge_complete();
drop function if exists public.notif_on_challenge_join();
drop function if exists public.notif_on_comment();
drop function if exists public.notif_on_event_cancelled();
drop function if exists public.notif_on_mention();
drop function if exists public.notif_on_report();
drop function if exists public.notif_streak_at_risk();
drop function if exists public.onboarding_challenge_id();
drop function if exists public.onboarding_challenge_progress_on_attendance();
drop function if exists public.onboarding_challenge_respond(p_accept boolean);
drop function if exists public.onboarding_challenge_state();
drop function if exists public.onboarding_progress_pin_shown();
drop function if exists public.onboarding_step_content_audit();
drop function if exists public.onboarding_step_content_pin();
drop function if exists public.owner_report_generate(p_month_start date);
drop function if exists public.owner_report_list(p_month_start date, p_metric text, p_limit integer);
drop function if exists public.owner_report_members(p_month_start date, p_metric text);
drop function if exists public.owner_report_on_recap();
drop function if exists public.owner_report_recipients();
drop function if exists public.owner_report_subject(p_uid uuid);
drop function if exists public.owner_report_viewer();
drop function if exists public.people_suggestions(p_limit integer);
drop function if exists public.pin_clear(p_target_type text, p_target_id uuid);
drop function if exists public.pin_set(p_target_type text, p_target_id uuid, p_note text);
drop function if exists public.post_new_member_on_join();
drop function if exists public.post_set_visibility(post_id uuid, visibility post_visibility);
drop function if exists public.profiles_guard_staff_impersonation();
drop function if exists public.recap_monthly_generate(p_month_start date);
drop function if exists public.recap_monthly_publish(p_id uuid);
drop function if exists public.recap_weekly_classmates(p_user uuid, p_week_start date, p_limit integer);
drop function if exists public.recompute_feed_weights(p_limit integer);
drop function if exists public.redeem_invite_code(p_code text);
drop function if exists public.registration_funnel(p_period_start date, p_period_end date);
drop function if exists public.relationship_score(p_viewer uuid, p_other uuid, p_as_of timestamp with time zone);
drop function if exists public.report(p_target_type text, p_target_id uuid, p_reason text, p_note text);
drop function if exists public.retention_cohorts(p_cohort_months integer);
drop function if exists public.retention_member_weeks(p_months integer);
drop function if exists public.retention_min_cohort_size();
drop function if exists public.retention_onboarding_correlation();
drop function if exists public.retention_welcome_correlation();
drop function if exists public.review_report(p_report_id uuid, p_status report_status, p_resolution_notes text);
drop function if exists public.role_rank(p_code text);
drop function if exists public.seed_onboarding_progress();
drop function if exists public.storage_erasure_done(p_bucket text, p_names text[]);
drop function if exists public.storage_erasure_pending(p_limit integer);
drop function if exists public.storage_invoke_sanitize();
drop function if exists public.storage_queue_erasure_on_user_delete();
drop function if exists public.submit_report(p_post_id uuid, p_reason text);
drop function if exists public.training_log_usage_before_insert();
drop function if exists public.training_log_usage_purge();
drop function if exists public.training_log_usage_report(p_weeks integer);
drop function if exists public.unpin_target();
drop function if exists public.wod_entry_normalize(p_entry jsonb);
drop function if exists public.wod_entry_result_text(p_entry jsonb);

-- The one foreign key from a kept table into a dropped one. The column stays
-- (it records the role an invite carried); the roles table does not.
alter table public.invite_redemptions drop constraint if exists invite_redemptions_role_fkey;

-- 10. Tables. Also no CASCADE.
drop table
  public.activity_pings,
  public.admin_actions,
  public.announcements,
  public.attendance_log,
  public.challenge_participants,
  public.challenge_progress,
  public.challenge_teams,
  public.challenges,
  public.club_features,
  public.club_wod_results,
  public.club_wod_sessions,
  public.club_wods,
  public.coach_congratulations,
  public.coach_engagement_flags,
  public.coach_tasks,
  public.comment_mentions,
  public.community_health_scores,
  public.event_attendees,
  public.events,
  public.feed_impressions,
  public.feed_interactions,
  public.follows,
  public.hidden_posts,
  public.intro_carousel_content,
  public.member_contact_log,
  public.member_feed_weights,
  public.member_of_week,
  public.monthly_club_recaps,
  public.onboarding_challenge_offers,
  public.onboarding_progress,
  public.onboarding_step_content,
  public.owner_reports,
  public.permissions,
  public.pins,
  public.post_comments,
  public.post_media,
  public.posting_restrictions,
  public.reports,
  public.role_permissions,
  public.roles,
  public.saved_posts,
  public.storage_erasure_queue,
  public.training_log_usage,
  public.weekly_challenges,
  public.weekly_challenges_archive,
  public.weekly_recaps;

-- 11. Columns that only the dropped features used.
alter table public.profiles drop column if exists avatar_url;
alter table public.workout_posts drop column if exists photo_path;
drop type if exists public.report_status;

commit;
