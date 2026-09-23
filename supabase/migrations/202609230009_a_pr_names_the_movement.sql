-- COMM-105 / launch-readiness S17: a PR on a built-in lift announced itself
-- as "שיא אישי" instead of naming the movement.
--
-- WHY IT ONLY HAPPENED FOR SOME PRs, which is what made it survive review.
-- pr_share() resolves a movement name by looking up private_records for a
-- record of type 'movement' - and only a CUSTOM movement is ever synced
-- there. The built-in library (Back Squat, Deadlift, Strict Press, and the
-- other seventy-odd) lives in the client and has no row in this database at
-- all. So a PR on a custom lift got its name and a PR on a built-in one got
-- nothing, the post was written with a null title, and the feed card fell
-- through to the post-type label. Most PRs are on built-in lifts, so the
-- common case was the broken one.
--
-- THE SERVER DOES NOT LEARN THE NAMES, and should not. That list belongs to
-- the client and changes with it; a copy here would be a second definition to
-- keep in step, which is the defect this codebase already has more than
-- enough of. What the server can do is record WHICH movement it was and let
-- the renderer resolve the name from the same library it draws every other
-- screen from - the same split 202609230005 uses for a built-in WOD id on the
-- gym display.
--
-- The body below is the live definition, read with pg_get_functiondef() after
-- 192 migrations, with one block added. Existing posts are not rewritten: a
-- post already carrying a resolved title keeps it, and an old built-in PR
-- keeps its fallback until the member shares a new one. Backfilling would
-- mean inventing a movement_id for rows whose payload may no longer exist.
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
