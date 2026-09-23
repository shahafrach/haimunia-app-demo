-- The rest of the server paths into feed, events, challenges and
-- achievements, gated on the same switches — and the four panel rows go back
-- to the plain "נאכף בשרת" claim.
--
-- 202609230001 put the module switch inside the definer functions that
-- bypassed the read policies: feed_page, post_create, event_rsvp,
-- chal_progress, ach_claim, community_streaks, announcement publishing. It
-- said so honestly and marked feed, events, challenges and achievements
-- "נאכף בשרת חלקית", because other definer functions reached the same tables
-- with the switch off. Its description listed them. This migration is that
-- list, closed.
--
-- WHY THE BODIES ARE REPRODUCED WHOLE. Postgres has no "add a statement to a
-- function"; `create or replace` takes the entire body. Each body below was
-- read out of the live database with pg_get_functiondef() after all 186
-- migrations applied, so what is re-declared is what is actually running —
-- not a copy from whichever earlier migration first wrote it, which may have
-- been superseded since. The only edit is the inserted gate.
--
-- WHERE THE GATE SITS, and why it matters. Immediately after the caller's
-- identity is established and, where the function has one, after the
-- is_community_member() check — the same position 202609230001 chose, and
-- for the same reason: AFTER idem_begin()'s replay check. A call that already
-- succeeded still returns its prior result when the module is later switched
-- off. Idempotency is a promise about a request that happened; a feature
-- switch is a statement about new ones.
--
-- THREE OF THESE MUST NOT RAISE. A trigger that raises aborts the write it
-- hangs off, which would mean a switched-off achievements module prevents an
-- achievement from being RECORDED rather than merely not announced. Those
-- three return instead, each in its own function's existing idiom:
--   notif_on_achievement      -> return null  (its own skip path returns null)
--   notif_on_event_cancelled  -> return new   (its own skip path returns new)
--   chal_notify_ending_soon   -> return 0     (it returns a count of notices)
-- The underlying row is written either way; only the notification stops.
--
-- ach_share carries TWO gates, because it is two things: an achievement is
-- its subject and a feed post is its result. Either switch being off refuses
-- it, and the message says which.
--
-- Grants are not re-issued: `create or replace` preserves them, and every
-- function here keeps the grants its original migration set.
--
-- NOT IN SCOPE, and deliberately. community_search() and people_suggestions()
-- reference events, but they are search and suggestion surfaces rather than
-- event features; gating either whole function on `events` would empty a
-- member's search because the club switched events off. The event-derived
-- rows inside them want their own narrower treatment, which is a different
-- change with its own test. The panel claim is unaffected: neither function
-- writes, and both already drop what the caller may not see.

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
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

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
    if v_media_count > 0 then
      delete from public.post_media pm where pm.post_id = v_post_id;
    end if;
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

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;
      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        coalesce((v_item ->> 'position')::smallint, v_idx::smallint),
        nullif(v_item ->> 'width', '')::integer,
        nullif(v_item ->> 'height', '')::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

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
  if not public.club_feature_enabled('achievements') then raise exception 'achievements disabled'; end if;
  -- 202609230003. and the share is a feed post.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

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

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;
      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        coalesce((v_item ->> 'position')::smallint, v_idx::smallint),
        nullif(v_item ->> 'width', '')::integer,
        nullif(v_item ->> 'height', '')::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  update public.member_achievements
     set shared_at = now()
   where id = member_achievement_id and shared_at is null;

  perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
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
  v_has_media boolean;
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
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_edit_caption', 30, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if v_body = '' then
    v_has_media := v_row.photo_path is not null
      or exists (select 1 from public.post_media m where m.post_id = v_row.id);
    if not v_has_media then
      raise exception 'a post needs text or at least one photo';
    end if;
  end if;

  update public.workout_posts set body = nullif(v_body, '') where id = post_id;
end $function$;

CREATE OR REPLACE FUNCTION public.post_set_visibility(post_id uuid, visibility post_visibility)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_old_rank integer;
  v_new_rank integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. re-scoping a post is a feed write.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if visibility is null then raise exception 'visibility is required'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;
  if v_row.author_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_row.deleted_at is not null or v_row.status <> 'active' then
    raise exception 'post is no longer editable';
  end if;

  if v_row.visibility = visibility then return; end if;

  v_old_rank := case v_row.visibility
    when 'only_me' then 0
    when 'friends' then 1 when 'followers' then 1
    else 2 end;
  v_new_rank := case visibility
    when 'only_me' then 0
    when 'friends' then 1 when 'followers' then 1
    else 2 end;

  if v_new_rank > v_old_rank and public.is_posting_restricted(v_uid) then
    raise exception 'posting_restricted';
  end if;

  update public.workout_posts set visibility = post_set_visibility.visibility where id = post_id;
end $function$;

CREATE OR REPLACE FUNCTION public.add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_parent public.post_comments;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. a comment hangs off a feed post.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  -- COMM-153 enforcement point 2. Checked before the rate limit so a
  -- restricted member burns no budget and gets the accurate reason.
  if public.is_posting_restricted(auth.uid()) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_comment', 20, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;

  if p_parent_comment_id is not null then
    select * into v_parent from public.post_comments where id = p_parent_comment_id;
    if not found then raise exception 'parent comment not found'; end if;
    if v_parent.post_id <> p_post_id then raise exception 'parent comment is on another post'; end if;
    if v_parent.parent_comment_id is not null then raise exception 'reply depth is capped at 2'; end if;
    if v_parent.deleted_at is not null or v_parent.status <> 'active' then
      raise exception 'parent comment is no longer available';
    end if;
  end if;

  insert into public.post_comments (post_id, author_id, body, parent_comment_id)
  values (p_post_id, auth.uid(), left(coalesce(p_body, ''), 1000), p_parent_comment_id)
  returning id into v_id;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.add_post_comment(p_post_id uuid, p_body text, p_parent_comment_id uuid, p_mentions uuid[], p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_uid uuid;
  v_targets uuid[];
  v_replay boolean;
  v_prior jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. a comment hangs off a feed post.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('add_post_comment', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if p_mentions is not null and array_length(p_mentions, 1) > 10 then
    raise exception 'at most 10 mentions per comment';
  end if;

  v_id := public.add_post_comment(p_post_id, p_body, p_parent_comment_id);
  if p_mentions is null or array_length(p_mentions, 1) is null then
    perform public.idem_complete('add_post_comment', p_idempotency_key, to_jsonb(v_id));
    return v_id;
  end if;

  select array_agg(distinct t.target) into v_targets
  from unnest(p_mentions) as t(target)
  where t.target is not null and t.target <> v_uid;
  if v_targets is null then
    perform public.idem_complete('add_post_comment', p_idempotency_key, to_jsonb(v_id));
    return v_id;
  end if;

  insert into public.comment_mentions (comment_id, mentioned_user_id)
  select v_id, t.target
  from unnest(v_targets) as t(target)
  where exists (select 1 from public.profiles p where p.id = t.target and p.deleted_at is null)
    and public.can_view_profile_field(t.target, 'allow_mentions')
  on conflict do nothing;

  perform public.idem_complete('add_post_comment', p_idempotency_key, to_jsonb(v_id));
  return v_id;
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
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;
  insert into public.reactions(post_id, user_id, kind) values (p_post_id, auth.uid(), 'cheer');
  perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(true));
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.coach_congratulate(p_kind text, p_target_user_id uuid, p_occurred_at timestamp with time zone, p_post_id uuid, p_parent_comment_id uuid, p_body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_claim_id uuid;
  v_comment_id uuid;
  v_post_id uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. it writes a comment or a post.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  v_kind := lower(btrim(coalesce(p_kind, '')));
  if v_kind not in ('pr', 'anniversary', 'challenge_completion') then
    raise exception 'invalid kind';
  end if;
  if p_target_user_id is null or p_occurred_at is null then
    raise exception 'invalid item';
  end if;

  -- The claim. on conflict do nothing: a second call for the same
  -- (coach, kind, member, moment) - concurrent, retried, or a deliberate
  -- repeat - wins nothing and falls through to `if v_claim_id is null`
  -- below, writing no comment/post at all. This is the actual security
  -- boundary; everything after it only runs once, ever, per real event.
  -- Keyed on v_kind (normalized), not p_kind, so a spelling variant of
  -- the same real event collides with the first claim instead of
  -- minting a new one.
  insert into public.coach_congratulations (coach_id, kind, target_user_id, occurred_at)
  values (v_uid, v_kind, p_target_user_id, p_occurred_at)
  on conflict (coach_id, kind, target_user_id, occurred_at) do nothing
  returning id into v_claim_id;

  if v_claim_id is null then
    return null;
  end if;

  if p_post_id is not null then
    v_comment_id := public.add_post_comment(p_post_id, p_body, p_parent_comment_id);
  else
    v_post_id := public.post_create(p_body, 'club', '[]'::jsonb, null);
    if v_post_id is not null then
      update public.workout_posts set post_type = 'POST_COACH'
        where id = v_post_id and author_id = v_uid;
    end if;
  end if;

  update public.coach_congratulations
    set comment_id = v_comment_id, post_id = v_post_id
    where id = v_claim_id;

  return coalesce(v_comment_id, v_post_id);
end $function$;

CREATE OR REPLACE FUNCTION public.club_wod_session_publish(p_wod_id text, p_session_date date DEFAULT NULL::date, p_note text DEFAULT ''::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_replay boolean;
  v_prior jsonb;
  v_ctrl text;
  v_wod_id text;
  v_date date;
  v_note text;
  v_wod public.club_wods;
  v_existing public.club_wod_sessions;
  v_found boolean := false;
  v_session public.club_wod_sessions;
  v_post_id uuid;
  v_club_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('club_wod_session_publish', p_idempotency_key) i;
  -- A replay re-reads the board rather than returning a stored copy of it,
  -- so a retried request never hands back a stale roll call.
  if v_replay then
    return public.club_wod_board_json(nullif(v_prior #>> '{}', '')::uuid);
  end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. the session card is a feed post.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  v_wod_id := btrim(coalesce(p_wod_id, ''));
  select * into v_wod from public.club_wods w where w.wod_id = v_wod_id;
  if not found then raise exception 'wod not found'; end if;
  -- A retired WOD is still READABLE (a member's history depends on it) but
  -- is out of circulation for new logs and new challenges - programming it
  -- to a day would be putting it straight back in.
  if v_wod.retired_at is not null then raise exception 'wod is retired'; end if;

  v_date := coalesce(p_session_date, current_date);
  -- The feed bound, decision 1. Yesterday covers a coach who forgot;
  -- tomorrow covers posting tonight for the morning class. A week of
  -- programming at once is a SCHEDULING feature and is deliberately not
  -- this one.
  if v_date < current_date - 1 or v_date > current_date + 1 then
    raise exception 'a session can only be posted for yesterday, today or tomorrow';
  end if;

  -- cleanStr()'s class exactly: 0x01-0x1F and 0x7F, built with chr() rather
  -- than [[:cntrl:]] for post_create's reason (202608280023) - a character
  -- class must not depend on the database LC_CTYPE when the text is Hebrew.
  v_ctrl := '[' || chr(1) || '-' || chr(31) || chr(127) || ']';
  v_note := left(btrim(regexp_replace(coalesce(p_note, ''), v_ctrl, '', 'g')), 500);

  select * into v_existing from public.club_wod_sessions s
   where s.wod_id = v_wod_id and s.session_date = v_date;
  v_found := found;

  if v_found and v_existing.cancelled_at is null then
    -- Idempotent for a double tap or a retried request: the identical note
    -- returns the board that is already there and writes nothing, not even
    -- an audit row.
    if v_existing.note = v_note then
      perform public.idem_complete('club_wod_session_publish', p_idempotency_key,
                                   to_jsonb(v_existing.id));
      return public.club_wod_board_json(v_existing.id);
    end if;
    -- club_wod_publish()'s snapshot rule, asked of this shape: a coach who
    -- retyped the note is TOLD it did not land, instead of quietly
    -- believing it did. Cancel and re-publish is the correction path, and
    -- it keeps the board.
    raise exception 'session already posted';
  end if;

  -- Security hunt round 7: serialize the day cap's count-check-insert
  -- section per (club, date) before counting. Held for the rest of this
  -- transaction, so it also covers the insert further down - a second
  -- concurrent caller for the same day blocks here until the first
  -- commits, then counts the now-committed row.
  v_club_id := public.default_club_id();
  perform pg_advisory_xact_lock(hashtext('club_wod_session_publish:' || v_club_id::text || ':' || v_date::text));

  -- The per-day cap, counted over LIVE sessions. Applied on the re-publish
  -- path too: the cap is about the feed, not about this row's history.
  if (select count(*) from public.club_wod_sessions s
       where s.club_id = v_club_id
         and s.session_date = v_date
         and s.cancelled_at is null) >= 4 then
    raise exception 'too many sessions posted for that day';
  end if;

  if v_found then
    -- Re-publishing a cancelled session is a NEW DECISION, not a retry, so
    -- it gets a fresh card and a fresh audit row. THE BOARD SURVIVES: the
    -- results are keyed on the session, not on the post, so members who had
    -- already attached do not have to do it again.
    update public.club_wod_sessions
       set cancelled_at = null, cancelled_by = null, cancelled_reason = null,
           note = v_note, published_by = v_uid, published_at = now(), post_id = null
     where id = v_existing.id
    returning * into v_session;
  else
    insert into public.club_wod_sessions (wod_id, session_date, note, published_by)
    values (v_wod_id, v_date, v_note, v_uid)
    returning * into v_session;
  end if;

  -- THE CARD. It carries NO member figures at all - no result_text, no
  -- comparison_key, no score_value, no rx - because it is programming, and
  -- every result lives in club_wod_results where the privacy rules are.
  -- That is also why feed_page's hide_result lateral (POST_WORKOUT and
  -- POST_PR only) has nothing to strip from it.
  --
  -- source_type and source_id are left NULL on purpose: source_type drives
  -- the client's "open the workout" deep link, and this card opens a BOARD.
  -- The session id travels in metadata, which feed_page passes through
  -- untouched for every post type outside POST_WORKOUT / POST_PR.
  perform set_config('app.allow_unrated_post_insert', 'on', true);
  insert into public.workout_posts (
    author_id, post_type, visibility, title, body, occurred_on,
    metadata, status, published_at)
  values (
    v_uid, 'POST_CLUB_WOD', 'club', v_wod.name, nullif(v_note, ''), v_date,
    jsonb_build_object(
      'club_wod_session_id', v_session.id,
      'club_wod_id', v_wod.wod_id,
      'session_date', v_date,
      'score_type', v_wod.score_type),
    'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  update public.club_wod_sessions set post_id = v_post_id
   where id = v_session.id
  returning * into v_session;

  perform public.log_admin_action(
    'club_wod_session_published', 'club_wod_session', v_session.id,
    null,
    jsonb_build_object('wod_id', v_wod.wod_id, 'name', v_wod.name,
                       'session_date', v_date, 'post_id', v_post_id),
    v_wod.score_type);

  perform public.idem_complete('club_wod_session_publish', p_idempotency_key,
                               to_jsonb(v_session.id));
  return public.club_wod_board_json(v_session.id);
end $function$;

CREATE OR REPLACE FUNCTION public.community_profile(user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_target uuid;
  v_p public.profiles;
  v_out jsonb;
  v_role text;
  v_since timestamptz;
  v_hide_result boolean;
  v_days integer;
  v_freq numeric;
  v_anchor date;
  v_streak integer;
  v_json jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. it returns the member's feed posts.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;

  v_target := coalesce(user_id, v_uid);
  if v_target <> v_uid and not public.is_community_member() then
    raise exception 'recovery method required';
  end if;

  -- A block edge in either direction ends the question before any row is
  -- read. can_view_profile_field() would return false for every field
  -- anyway, but returning the bare header to a blocked member is still a
  -- confirmation they should not get.
  if v_target <> v_uid and exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_target)
       or (b.blocker_id = v_target and b.blocked_id = v_uid)
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_p from public.profiles p where p.id = v_target and p.deleted_at is null;
  if not found then raise exception 'profile not found'; end if;

  -- Role and tenure both come from the first invite redemption, which is
  -- the only server-side record of when a member joined the club and what
  -- they joined as. profiles.created_at is the fallback for a row that
  -- predates the invite gate.
  select ir.role, ir.redeemed_at into v_role, v_since
  from public.invite_redemptions ir
  where ir.user_id = v_target
  order by ir.redeemed_at asc
  limit 1;

  -- The three fields a fully private member still returns, plus handle,
  -- which the client needs to render a name at all when display_name is
  -- empty. profiles has no first_name or last_name column, so those two
  -- documented keys are simply absent and the client falls back to
  -- display_name, then handle.
  v_out := jsonb_build_object(
    'id', v_p.id,
    'display_name', nullif(v_p.display_name, ''),
    'handle', v_p.handle,
    'avatar_url', v_p.avatar_url,
    'role', coalesce(v_role, 'member'),
    'member_since', coalesce(v_since, v_p.created_at),
    -- False on your own profile, so the overlay does not offer you a
    -- Follow button pointed at yourself.
    'allow_follows', (v_target <> v_uid and public.can_view_profile_field(v_target, 'allow_follows'))
  );

  if not public.can_view_profile_field(v_target, 'visible_to_club') then
    return v_out;
  end if;

  v_out := v_out || jsonb_build_object(
    'follower_count', (select count(*)::integer from public.follows f where f.followed_id = v_target),
    'following_count', (select count(*)::integer from public.follows f where f.follower_id = v_target)
  );

  select jsonb_build_object('id', c.id, 'title', c.title, 'ends_at', c.end_at)
    into v_json
  from public.challenge_participants cp
  join public.challenges c on c.id = cp.challenge_id
  where cp.user_id = v_target
    and cp.status = 'active'
    and c.status = 'active'
    and now() >= c.start_at and now() <= c.end_at
  order by c.end_at asc
  limit 1;
  if v_json is not null then
    v_out := v_out || jsonb_build_object('active_challenge', v_json);
  end if;

  -- --- training numbers, COMM-018 --------------------------------------
  -- training_frequency and recent_workouts are still derived from posts the
  -- member chose to publish. A member who trains and never posts reads as
  -- zero in those two, and that is the honest answer for the question they
  -- ask. current_streak below no longer asks that question.
  if public.can_view_profile_field(v_target, 'show_workout_results') then
    select count(distinct coalesce(p.occurred_on, p.created_at::date))::integer
      into v_days
    from public.workout_posts p
    where p.author_id = v_target
      and p.deleted_at is null and p.status = 'active'
      and p.post_type in ('POST_WORKOUT', 'POST_PR')
      and coalesce(p.occurred_on, p.created_at::date) >= current_date - 27;

    if coalesce(v_days, 0) > 0 then
      v_freq := round(v_days / 4.0, 1);
      v_out := v_out || jsonb_build_object('training_frequency',
        case when v_freq = trunc(v_freq) then trunc(v_freq)::integer::text
             else to_char(v_freq, 'FM990.9') end || ' בשבוע');
    end if;

    -- Week streak, COMM-306: verified attendance days (attendance_log,
    -- COMM-300), counted the same way consistency_week_streaks() counts them
    -- set-wide - a week counts when the member trained in it at all, so a
    -- three times a week pattern scores exactly like a daily one. The streak
    -- may end on the current week or the previous one: a member who has not
    -- trained yet this week has not lost their streak.
    --
    -- Gated on show_attendance as well as show_workout_results, so an
    -- attendance-derived number never travels past attendance's own toggle.
    -- Absent key means hidden, the same as every other field here. A member
    -- with no attendance days at all is 0, not an error and not an absence:
    -- zero is a real value here for the same reason it is on the board.
    if public.can_view_profile_field(v_target, 'show_attendance') then
      select max(w.wk) into v_anchor
      from (
        select distinct date_trunc('week', a.occurred_on::timestamp)::date as wk
        from public.attendance_log a
        where a.user_id = v_target
      ) w;

      v_streak := 0;
      if v_anchor is not null and v_anchor >= date_trunc('week', current_date::timestamp)::date - 7 then
        -- Once a week is missing, every later row falls behind the expected
        -- date and stays behind, so this counts the contiguous run and
        -- nothing after it.
        select count(*)::integer into v_streak
        from (
          select w.wk, row_number() over (order by w.wk desc) as rn
          from (
            select distinct date_trunc('week', a.occurred_on::timestamp)::date as wk
            from public.attendance_log a
            where a.user_id = v_target
          ) w
        ) s
        where s.wk = v_anchor - ((s.rn - 1) * 7)::integer;
      end if;
      v_out := v_out || jsonb_build_object('current_streak', coalesce(v_streak, 0));
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'date', r.d) order by r.d desc), '[]'::jsonb)
      into v_json
    from (
      select coalesce(nullif(p.title, ''), left(coalesce(p.body, ''), 80)) as title,
             coalesce(p.occurred_on, p.created_at::date) as d
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type = 'POST_WORKOUT'
        and public.post_visible_to_viewer(p.id)
      order by coalesce(p.occurred_on, p.created_at::date) desc
      limit 5
    ) r;
    v_out := v_out || jsonb_build_object('recent_workouts', v_json);
  end if;

  -- --- PRs, gated by show_prs ------------------------------------------
  -- Absent key hides the Progress tab, empty array shows the no-PRs state.
  if public.can_view_profile_field(v_target, 'show_prs') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'movement', r.movement, 'result', r.result, 'achieved_on', r.d) order by r.d desc), '[]'::jsonb)
      into v_json
    from (
      select coalesce(p.metadata ->> 'movement', nullif(p.title, ''), '') as movement,
             coalesce(p.metadata ->> 'new_result', nullif(p.result_text, ''), '') as result,
             coalesce(p.occurred_on, p.created_at::date) as d
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type = 'POST_PR'
        and public.post_visible_to_viewer(p.id)
      order by coalesce(p.occurred_on, p.created_at::date) desc
      limit 20
    ) r;
    v_out := v_out || jsonb_build_object('prs', v_json);
  end if;

  -- --- achievements, gated by show_achievements ------------------------
  -- The per-unlock visibility column is applied on top of the toggle, the
  -- same three-way rule member_achievements_read spells out, so an
  -- only_me unlock never appears on someone else's screen.
  if public.can_view_profile_field(v_target, 'show_achievements') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', r.title, 'badge_icon', r.icon, 'code', r.code,
             'unlocked_at', r.unlocked_at) order by r.unlocked_at desc), '[]'::jsonb)
      into v_json
    from (
      select d.name as title, d.icon as icon, d.code as code, ma.unlocked_at as unlocked_at
      from public.member_achievements ma
      join public.achievement_definitions d on d.id = ma.achievement_id
      where ma.user_id = v_target
        and (
          v_target = v_uid
          or ma.visibility = 'club'
          or (ma.visibility = 'friends' and public.are_friends(v_target))
        )
      order by ma.unlocked_at desc
      limit 24
    ) r;
    v_out := v_out || jsonb_build_object('achievements', v_json);
    if jsonb_array_length(v_json) > 0 then
      v_out := v_out || jsonb_build_object('recent_achievement', jsonb_build_object(
        'title', v_json -> 0 ->> 'title', 'badge_icon', v_json -> 0 ->> 'badge_icon'));
    end if;
  end if;

  -- --- posts -----------------------------------------------------------
  -- Card contract rows, the same shape feed_page returns, so
  -- renderPostCard() renders the Posts tab with no special case. Each row
  -- still passes post_visible_to_viewer(), so an only_me or friends post
  -- never reaches a viewer the author did not choose, profile tab or not.
  v_hide_result := not public.can_view_profile_field(v_target, 'show_workout_results');

  select coalesce(jsonb_agg(r.j order by r.ts desc), '[]'::jsonb) into v_json
  from (
    select jsonb_build_object(
             'id', p.id,
             'post_type', p.post_type::text,
             'author_id', p.author_id,
             'author', jsonb_build_object(
               'display_name', v_p.display_name, 'handle', v_p.handle, 'avatar_url', v_p.avatar_url),
             'display_name', v_p.display_name,
             'handle', v_p.handle,
             'body', p.body,
             'title', p.title,
             'result_text', case when v_hide_result and p.post_type in ('POST_WORKOUT', 'POST_PR')
                                 then null else p.result_text end,
             'occurred_on', p.occurred_on,
             'visibility', p.visibility::text,
             'created_at', p.created_at,
             'published_at', p.published_at,
             'metadata', case when v_hide_result and p.post_type in ('POST_WORKOUT', 'POST_PR')
                              then p.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'
                              else p.metadata end,
             'media', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'storage_path', m.storage_path,
                        'alt_text', m.alt_text,
                        'decorative', m.decorative,
                        'position', m."position",
                        'width', m.width,
                        'height', m.height) order by m."position")
               from public.post_media m where m.post_id = p.id),
               case when p.photo_path is not null
                    then jsonb_build_array(jsonb_build_object('storage_path', p.photo_path, 'position', 0))
                    else '[]'::jsonb end),
             'reaction_count', (select count(*)::integer from public.reactions rr where rr.post_id = p.id),
             'comment_count', (select count(*)::integer from public.post_comments pc
                               where pc.post_id = p.id and pc.deleted_at is null and pc.status = 'active')
           ) as j,
           coalesce(p.created_at, p.published_at) as ts
    from public.workout_posts p
    where p.author_id = v_target
      and p.deleted_at is null and p.status = 'active'
      and public.post_visible_to_viewer(p.id)
    order by coalesce(p.created_at, p.published_at) desc
    limit 10
  ) r;
  v_out := v_out || jsonb_build_object('posts', v_json);

  return v_out;
end $function$;

CREATE OR REPLACE FUNCTION public.chal_record_progress(p_challenge_id uuid, p_user_id uuid, p_delta numeric, p_note text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_note text;
  v_id uuid;
  v_replay boolean;
  v_prior jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. gated on the module that owns it.
  if not public.club_feature_enabled('challenges') then raise exception 'challenges disabled'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('chal_record_progress', p_idempotency_key,
    p_challenge_id::text || '|' || p_user_id::text) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_challenge_id is null or p_user_id is null then raise exception 'challenge and target participant are required'; end if;
  if p_delta is null then raise exception 'delta is required'; end if;

  if not exists (select 1 from public.challenges where id = p_challenge_id and status = 'active') then
    raise exception 'challenge is not active';
  end if;

  if not exists (
    select 1 from public.challenge_participants
    where challenge_id = p_challenge_id and user_id = p_user_id and status = 'active'
  ) then
    raise exception 'not an active participant';
  end if;

  v_note := nullif(left(btrim(coalesce(p_note, '')), 500), '');

  insert into public.challenge_progress
    (challenge_id, user_id, delta, source_type, note, entered_by)
  values (p_challenge_id, p_user_id, p_delta, 'coach_entry', v_note, v_uid)
  returning id into v_id;

  perform public.idem_complete('chal_record_progress', p_idempotency_key, to_jsonb(v_id));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.chal_reassign_team(p_challenge_id uuid, p_user_id uuid, p_team_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_challenge public.challenges;
  v_old_team uuid;
  v_status text;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. gated on the module that owns it.
  if not public.club_feature_enabled('challenges') then raise exception 'challenges disabled'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_challenge_id is null or p_user_id is null then
    raise exception 'challenge and target participant are required';
  end if;

  select * into v_challenge from public.challenges where id = p_challenge_id;
  if not found then raise exception 'challenge not found'; end if;
  -- team_id is meaningless on any other challenge_type: nothing reads it and
  -- chal_progress only builds team_totals for a 'team' challenge.
  if v_challenge.challenge_type <> 'team' then raise exception 'not a team challenge'; end if;

  select cp.team_id, cp.status into v_old_team, v_status
  from public.challenge_participants cp
  where cp.challenge_id = p_challenge_id and cp.user_id = p_user_id
  for update;
  if not found or v_status = 'withdrawn' then raise exception 'not an active participant'; end if;

  if p_team_id is not null and not exists (
    select 1 from public.challenge_teams t
    where t.id = p_team_id and t.challenge_id = p_challenge_id
  ) then
    raise exception 'team does not belong to this challenge';
  end if;

  update public.challenge_participants
  set team_id = p_team_id
  where challenge_id = p_challenge_id and user_id = p_user_id;

  -- target_id is the member. challenge_participants has a composite primary
  -- key and so no single id to point at; the challenge lives in the payload.
  perform public.log_admin_action(
    'challenge_edit', 'challenge_participant', p_user_id,
    pg_catalog.jsonb_build_object('challenge_id', p_challenge_id, 'team_id', v_old_team),
    pg_catalog.jsonb_build_object('challenge_id', p_challenge_id, 'team_id', p_team_id)
  );
end $function$;

CREATE OR REPLACE FUNCTION public.chal_set_captain(p_team_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_team public.challenge_teams;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. gated on the module that owns it.
  if not public.club_feature_enabled('challenges') then raise exception 'challenges disabled'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_team_id is null then raise exception 'team is required'; end if;

  select * into v_team from public.challenge_teams where id = p_team_id for update;
  if not found then raise exception 'team not found'; end if;

  -- The same predicate challenge_teams_guard_captain() enforces underneath.
  -- Checked here too so the client gets this message rather than the
  -- trigger's, and so the refusal happens before anything is written.
  if p_user_id is not null and not exists (
    select 1 from public.challenge_participants cp
    where cp.challenge_id = v_team.challenge_id
      and cp.user_id = p_user_id
      and cp.team_id = p_team_id
      and cp.status <> 'withdrawn'
  ) then
    raise exception 'captain must be an active participant on this team';
  end if;

  -- Transaction-local, cleared immediately after the one UPDATE it exists
  -- for. See the note on challenge_teams_guard_captain() above.
  perform set_config('app.allow_captain_set', 'on', true);
  update public.challenge_teams set captain_id = p_user_id where id = p_team_id;
  perform set_config('app.allow_captain_set', 'off', true);

  perform public.log_admin_action(
    'challenge_edit', 'challenge_team', p_team_id,
    pg_catalog.jsonb_build_object('challenge_id', v_team.challenge_id, 'captain_id', v_team.captain_id),
    pg_catalog.jsonb_build_object('challenge_id', v_team.challenge_id, 'captain_id', p_user_id)
  );
end $function$;

CREATE OR REPLACE FUNCTION public.club_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_club public.clubs;
  v_members integer;
  v_challenge jsonb;
  v_unread integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230003. its payload is the club's live challenges.
  if not public.club_feature_enabled('challenges') then raise exception 'challenges disabled'; end if;

  select * into v_club from public.clubs c where c.id = public.default_club_id();
  -- Definer, so this is the real member count and not "everyone this viewer
  -- has not blocked", which is what a client-side count through
  -- profiles_read_authenticated would have produced.
  select count(*)::integer into v_members from public.profiles p where p.deleted_at is null;

  -- comparison_key is null on this branch by construction: public.challenges
  -- has no such column. Callers branch on `source`, not on the null.
  select jsonb_build_object('id', c.id, 'title', c.title, 'source', 'challenge',
                            'starts_at', c.start_at, 'ends_at', c.end_at,
                            'comparison_key', null)
    into v_challenge
  from public.challenges c
  where c.status = 'active' and now() >= c.start_at and now() <= c.end_at
  order by c.end_at asc
  limit 1;
  -- challenges is Phase 2 (COMM-201) and is empty today, so the current
  -- weekly challenge is the fallback and is what actually renders in V1.
  --
  -- Same row loadWeeklyChallenge() selects: current_date inside the window,
  -- `order by ends_on asc limit 1`. The two orderings have to stay identical
  -- or the client would validate one row and render another.
  if v_challenge is null then
    select jsonb_build_object('id', w.id, 'title', w.title, 'source', 'weekly',
                              'starts_at', w.starts_on, 'ends_at', w.ends_on,
                              'comparison_key', w.comparison_key)
      into v_challenge
    from public.weekly_challenges w
    where current_date >= w.starts_on and current_date <= w.ends_on
    order by w.ends_on asc
    limit 1;
  end if;

  select count(*)::integer into v_unread
  from public.notifications n where n.user_id = v_uid and n.read_at is null;

  return jsonb_build_object(
    'name', coalesce(v_club.name, ''),
    -- TODO COMM-115: clubs has no image column. The mark reads
    -- settings->>'image_url' when an admin has set one and the client falls
    -- back to a lettermark. Promote it to a real column when club branding
    -- gets its own ticket rather than inventing one here.
    'image_url', v_club.settings ->> 'image_url',
    'member_count', coalesce(v_members, 0),
    'active_challenge', v_challenge,
    'unread_notifications', coalesce(v_unread, 0)
  );
end $function$;

CREATE OR REPLACE FUNCTION public.coach_celebrate_feed(p_days integer DEFAULT 7)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_days int;
  v_since timestamptz;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- 202609230003. it reads challenge completions.
  if not public.club_feature_enabled('challenges') then raise exception 'challenges disabled'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- COMM-223 clamps the window to 1..30 rather than rejecting it: this is a
  -- read a dashboard makes on load, and a bad number is a client bug, not
  -- something worth turning into an error toast in front of a coach.
  v_days := least(greatest(coalesce(p_days, 7), 1), 30);
  v_since := now() - (v_days || ' days')::interval;

  return query
  with prs as (
    select
      'pr'::text as kind,
      p.author_id as user_id,
      p.created_at as occurred_at,
      p.id as post_id,
      jsonb_build_object(
        'movement', coalesce(nullif(p.metadata ->> 'movement', ''), nullif(p.title, ''), ''),
        'result',   coalesce(nullif(p.metadata ->> 'new_result', ''), nullif(p.result_text, ''), '')
      ) as detail
    from public.workout_posts p
    where p.post_type = 'POST_PR'
      and p.created_at >= v_since
      and p.deleted_at is null
      and p.status = 'active'
      and p.author_id is not null
      and public.can_view_profile_field(p.author_id, 'show_prs')
      and public.post_visible_to_viewer(p.id)
  ),
  -- The tenure arithmetic is ach_claim()'s, not a new one. 202608290002
  -- made membership tenure a server-checked fact keyed on
  -- config->>'metric' = 'tenure_days' and threshold-in-days against
  -- invite_redemptions.redeemed_at; Celebrate asks the same question with
  -- one extra bound, so a definition added later (a ten-year badge, say) is
  -- picked up here with no further migration, and the day a member's
  -- anniversary lands in this feed is the same day they can claim the
  -- badge. Neither side gets to disagree about when a year has passed.
  --
  --   ach_claim:  redeemed_at <= now() - threshold days      ("reached it")
  --   here:       ... and the crossing itself, redeemed_at + threshold
  --               days, fell inside the window, which is the same
  --               comparison shifted: redeemed_at > v_since - threshold
  --               days.
  annis as (
    select
      'anniversary'::text as kind,
      ir.user_id as user_id,
      ir.redeemed_at + (d.threshold || ' days')::interval as occurred_at,
      null::uuid as post_id,
      jsonb_build_object(
        'code',  d.code,
        'title', d.name,
        -- threshold is numeric, so the cast is not decoration: without it
        -- a one-year anniversary serialises as 1.0000000000000000 and the
        -- client has to guess. 365/730/1095/1825 all divide exactly.
        'years', (d.threshold / 365)::integer
      ) as detail
    from public.invite_redemptions ir
    join public.achievement_definitions d
      on coalesce(d.config ->> 'metric', '') = 'tenure_days'
     and d.enabled
     and d.threshold >= 365
    where ir.redeemed_at <= now() - (d.threshold || ' days')::interval
      and ir.redeemed_at > v_since - (d.threshold || ' days')::interval
      and public.can_view_profile_field(ir.user_id, 'visible_to_club')
  ),
  comps as (
    select
      'challenge_completion'::text as kind,
      cp.user_id as user_id,
      cp.completed_at as occurred_at,
      null::uuid as post_id,
      jsonb_build_object(
        'challenge_id', c.id,
        'title',        c.title
      ) as detail
    from public.challenge_participants cp
    join public.challenges c on c.id = cp.challenge_id
    where cp.completed_at is not null
      and cp.completed_at >= v_since
      and cp.status <> 'withdrawn'
      and c.status <> 'draft'
      and public.can_view_profile_field(cp.user_id, 'in_leaderboards')
  ),
  items as (
    select * from prs
    union all select * from annis
    union all select * from comps
  )
  -- A plain jsonb shape, flat and self-describing, so the client can render
  -- a row without joining anything back or trusting anything it computed
  -- itself. post_id is null exactly when there is no source post, which is
  -- what COMM-225 branches on to pick add_post_comment over post_create.
  select jsonb_build_object(
           'kind',         i.kind,
           'user_id',      i.user_id,
           'handle',       pf.handle,
           'display_name', coalesce(nullif(pf.display_name, ''), pf.handle),
           'avatar_url',   pf.avatar_url,
           'occurred_at',  i.occurred_at,
           'post_id',      i.post_id,
           'detail',       i.detail
         )
  from items i
  join public.profiles pf on pf.id = i.user_id and pf.deleted_at is null
  order by i.occurred_at desc
  limit 100;
end $function$;

CREATE OR REPLACE FUNCTION public.chal_notify_ending_soon()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_challenge record;
  v_participant record;
  v_written integer := 0;
begin
  -- 202609230003. gated on the module that owns it.
  if not public.club_feature_enabled('challenges') then return 0; end if;
  for v_challenge in
    select id, title, end_at
    from public.challenges
    where status = 'active'
      and ending_soon_notified_at is null
      and end_at > now()
      and end_at <= now() + interval '48 hours'
  loop
    for v_participant in
      select user_id from public.challenge_participants
      where challenge_id = v_challenge.id and status = 'active'
    loop
      if public.notif_create(
        v_participant.user_id, 'challenge_ending_soon', 'challenges',
        'Challenge ending soon',
        v_challenge.title,
        'challenge', v_challenge.id,
        '/community/boards?challenge=' || v_challenge.id::text
      ) is not null then
        v_written := v_written + 1;
      end if;
    end loop;

    update public.challenges
    set ending_soon_notified_at = now()
    where id = v_challenge.id;
  end loop;

  return v_written;
end $function$;

CREATE OR REPLACE FUNCTION public.notif_on_achievement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := new.user_id;
  v_name text;
  v_visible boolean;
  v_friend uuid;
begin
  -- 202609230003. gated on the module that owns it.
  if not public.club_feature_enabled('achievements') then return null; end if;
  select d.name into v_name
  from public.achievement_definitions d where d.id = new.achievement_id;

  perform public.notif_create(
    v_user, 'achievement_unlocked', 'training',
    'Achievement unlocked', coalesce(v_name, ''),
    'achievement', new.id,
    '/community/account/achievements?ma=' || new.id::text
  );

  -- Friend fan-out only when the unlocker exposes achievements at all.
  select (p.deleted_at is null and p.visible_to_club and p.show_achievements)
    into v_visible
  from public.profiles p where p.id = v_user;
  if not coalesce(v_visible, false) or new.visibility = 'only_me' then
    return null;
  end if;

  for v_friend in
    select f1.followed_id
    from public.follows f1
    join public.follows f2
      on f2.follower_id = f1.followed_id and f2.followed_id = f1.follower_id
    where f1.follower_id = v_user
  loop
    if not public.notif_blocked_between(v_user, v_friend)
       and public.notif_pref_allows(v_friend, 'friend_achievement') then
      perform public.notif_queue_batched(v_friend, 'training', 'friend_achievement', new.id);
    end if;
  end loop;

  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.notif_on_event_cancelled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attendee uuid;
begin
  -- 202609230003. gated on the module that owns it.
  if not public.club_feature_enabled('events') then return new; end if;
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;

  for v_attendee in
    select a.user_id
    from public.event_attendees a
    where a.event_id = new.id
      and a.response in ('going', 'interested')
  loop
    perform public.notif_create(
      v_attendee, 'event_cancelled', 'events',
      'Event cancelled',
      new.title,
      'event', new.id,
      '/community/feed?event=' || new.id::text
    );
  end loop;

  return new;
end $function$;
