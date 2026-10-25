-- Circles RPCs, part 2: posts, reactions, "trained together", and the
-- notification triggers that hang off them.
--
-- A post belongs to exactly one circle, so sharing to several circles is one
-- call per circle and one post each (decisions.md: Sharing). Every function
-- here takes the circle (or a post, which has one) and checks that the caller
-- is a member of exactly that circle.
--
-- FORWARD ONLY. No applied migration is edited.
begin;

-- 1. One post per record PER CIRCLE ------------------------------------------
-- The old key (author, source_type, source_record_id) allowed a PR to be shared
-- once, in total. Sharing it to a second circle is a second post.
alter table public.workout_posts
  drop constraint workout_posts_author_id_source_type_source_record_id_key,
  add constraint workout_posts_author_club_source_key
    unique (author_id, club_id, source_type, source_record_id);

-- 2. Reactions: exactly three kinds ------------------------------------------
-- The fist bump first, then fire and clap (decisions.md: Sharing). The fist
-- bump was stored as 'cheer'; it is renamed, rows and default included. With
-- three kinds a member can hold all of them on a post, so there is no cap to
-- enforce beyond the set itself.
alter table public.reactions drop constraint reactions_kind_check;
update public.reactions set kind = 'fist_bump' where kind = 'cheer';
alter table public.reactions
  alter column kind set default 'fist_bump',
  add constraint reactions_kind_check check (kind in ('fist_bump', 'fire', 'clap'));

-- 3. Trained together: a tag is pending until the tagged member confirms ------
alter table public.post_training_partners add column confirmed_at timestamptz;

drop policy post_training_partners_read on public.post_training_partners;
-- The tagged member and the tagger see a pending tag; the circle sees it once
-- confirmed.
create policy post_training_partners_read on public.post_training_partners for select to authenticated
  using (
    public.is_circle_member(club_id)
    and (
      tagged_user_id = auth.uid()
      or tagged_by = auth.uid()
      or (confirmed_at is not null and public.post_visible_to_viewer(post_id))
    )
  );

-- What a card shows: confirmed partners only.
create or replace function public.post_training_partners_for(p_post_ids uuid[])
returns setof jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'post_id', tp.post_id,
    'user_id', tp.tagged_user_id,
    'display_name', pr.display_name,
    'handle', pr.handle
  )
  from public.post_training_partners tp
  join public.profiles pr on pr.id = tp.tagged_user_id
  where tp.post_id = any (coalesce(p_post_ids, array[]::uuid[]))
    and tp.confirmed_at is not null
  order by tp.post_id,
           tp.created_at asc,
           coalesce(nullif(btrim(pr.display_name), ''), pr.handle) asc,
           tp.tagged_user_id asc
  limit 200;
$$;

-- Tag circle members on one of my workout posts. The tag is PENDING: it changes
-- nobody's numbers until the tagged member calls confirm_trained_together.
-- Returns how many tags the post now has (pending and confirmed).
create or replace function public.post_tag_training_partners(p_post_id uuid, p_members uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_post public.workout_posts;
  v_targets uuid[];
  v_count integer;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_post from public.workout_posts where id = p_post_id;
  if not found or v_post.deleted_at is not null or v_post.status <> 'active' then
    raise exception 'post not found';
  end if;
  -- The author, still in the post's circle, and nobody else.
  if v_post.author_id is distinct from v_uid or not public.is_circle_member(v_post.club_id) then
    raise exception 'not authorized';
  end if;
  if v_post.post_type <> 'POST_WORKOUT' then
    raise exception 'training partners are for workout posts';
  end if;
  if not public.check_rate_limit('post_tag_training_partners', 60, 10) then
    raise exception 'rate_limited';
  end if;
  if p_members is not null and array_length(p_members, 1) > 10 then
    raise exception 'at most 10 training partners per post';
  end if;

  select coalesce(array_agg(distinct t.target), array[]::uuid[]) into v_targets
  from unnest(coalesce(p_members, array[]::uuid[])) as t(target)
  where t.target is not null and t.target <> v_uid;

  -- Untagging is half of a set write and is not gated on the target.
  delete from public.post_training_partners
  where post_id = p_post_id and tagged_user_id <> all (v_targets);

  -- Only people in THIS circle, and not across a block. Anyone else is dropped
  -- silently, as a self-tag is.
  insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
  select p_post_id, t.target, v_uid
  from unnest(v_targets) as t(target)
  where exists (select 1 from public.circle_members m
                 where m.club_id = v_post.club_id and m.user_id = t.target)
    and exists (select 1 from public.profiles p where p.id = t.target and p.deleted_at is null)
    and not exists (select 1 from public.blocks b
                     where (b.blocker_id = v_uid and b.blocked_id = t.target)
                        or (b.blocker_id = t.target and b.blocked_id = v_uid))
  -- A re-save keeps the existing row, confirmed or not, and notifies nobody.
  on conflict (post_id, tagged_user_id) do nothing;

  select count(*) into v_count from public.post_training_partners where post_id = p_post_id;
  return v_count;
end $$;

-- The tagged member says "yes, I trained there". Idempotent. The tag then counts
-- toward their week (circle_week).
create or replace function public.confirm_trained_together(p_post_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  update public.post_training_partners t
     set confirmed_at = coalesce(t.confirmed_at, now())
   where t.post_id = p_post_id
     and t.tagged_user_id = v_uid
     and public.is_circle_member(t.club_id)
     and exists (select 1 from public.workout_posts p
                  where p.id = t.post_id and p.deleted_at is null and p.status = 'active');
  if not found then raise exception 'not authorized'; end if;
end $$;

-- Remove a tag: the author clears a name they put there; the tagged member
-- declines or withdraws their own (p_user_id null means me). Silent when
-- there is nothing to delete.
create or replace function public.post_training_partner_remove(p_post_id uuid, p_user_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_author uuid;
  v_club uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  v_target := coalesce(p_user_id, v_uid);

  select p.author_id, p.club_id into v_author, v_club
    from public.workout_posts p where p.id = p_post_id;
  if not found then return; end if;
  if not public.is_circle_member(v_club) then raise exception 'not authorized'; end if;
  if v_target <> v_uid and v_author is distinct from v_uid then
    raise exception 'not authorized';
  end if;

  delete from public.post_training_partners
  where post_id = p_post_id and tagged_user_id = v_target;
end $$;

-- 4. Reactions ----------------------------------------------------------------
drop function public.toggle_reaction(uuid, uuid);
create or replace function public.toggle_reaction(
  p_post_id uuid, p_idempotency_key uuid default null, p_kind text default 'fist_bump')
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_club uuid;
  v_existing boolean;
  v_replay boolean;
  v_prior jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- No kind means the fist bump. The key stays the second argument, so a caller
  -- that never learned about kinds (toggle_reaction(post, key)) still works.
  p_kind := coalesce(p_kind, 'fist_bump');
  if p_kind not in ('fist_bump', 'fire', 'clap') then
    raise exception 'unknown reaction';
  end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('toggle_reaction', p_idempotency_key, p_post_id::text || ':' || p_kind) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::boolean; end if;

  -- Taking my own reaction back is always allowed, even after leaving.
  select exists(select 1 from public.reactions
                 where post_id = p_post_id and user_id = v_uid and kind = p_kind) into v_existing;
  if v_existing then
    delete from public.reactions where post_id = p_post_id and user_id = v_uid and kind = p_kind;
    perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(false));
    return false;
  end if;

  -- Only on posts in a circle I am in.
  select p.club_id into v_club from public.workout_posts p
   where p.id = p_post_id and p.deleted_at is null and p.status = 'active';
  if v_club is null or not public.is_circle_member(v_club) or not public.post_visible_to_viewer(p_post_id) then
    raise exception 'not authorized';
  end if;
  if not public.check_rate_limit('reaction', 60, 10) then raise exception 'rate_limited'; end if;

  insert into public.reactions (post_id, user_id, kind) values (p_post_id, v_uid, p_kind);
  perform public.idem_complete('toggle_reaction', p_idempotency_key, to_jsonb(true));
  return true;
end $$;

-- 5. Posts --------------------------------------------------------------------
drop function public.post_create(text, public.post_visibility, jsonb, jsonb, uuid);
create or replace function public.post_create(
  p_club_id uuid, body text, p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_body text;
  v_post_id uuid;
  v_replay boolean;
  v_prior jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('post_create', p_idempotency_key, p_club_id::text) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_circle_member(p_club_id) then raise exception 'not authorized'; end if;
  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g');
  v_body := left(btrim(v_body), 1000);
  if v_body = '' then raise exception 'a post needs text'; end if;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  insert into public.workout_posts (author_id, club_id, post_type, body, status, published_at)
  values (v_uid, p_club_id, 'POST_TEXT', v_body, 'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  perform public.idem_complete('post_create', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;

-- Share a personal record to ONE circle. Figures are recomputed from the
-- caller's own record, never read from the request, with one exception: the
-- absolute weight. It is stored only if the client sends it (p_weight), which
-- it does only when the member chose to show weights in this circle. Without
-- it the post carries the lift and the percent improvement, and nothing
-- absolute: no kilograms in the text, no score_value.
drop function public.pr_share(text, text, jsonb, uuid);
create or replace function public.pr_share(
  p_club_id uuid, record_id text, note text default '',
  p_weight numeric default null, p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_body text;
  v_post_id uuid;
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
  v_pct numeric;
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
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('pr_share', p_idempotency_key, p_club_id::text || ':' || coalesce(record_id, '')) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_circle_member(p_club_id) then raise exception 'not authorized'; end if;

  if record_id is null or btrim(record_id) = '' or char_length(record_id) > 160 then
    raise exception 'record is required';
  end if;
  if p_weight is not null and (p_weight <= 0 or p_weight > 2000) then
    raise exception 'weight is out of range';
  end if;

  -- The caller's own record. A record that belongs to someone else is refused;
  -- an unknown id publishes a figure-less post, as before.
  select * into v_rec
  from public.private_records r
  where r.user_id = v_uid
    and r.record_type in ('strength_entry', 'wod_entry')
    and r.record_id = pr_share.record_id
    and r.deleted_at is null;
  if found then
    v_payload := coalesce(v_rec.payload, '{}'::jsonb);
    v_source_type := v_rec.record_type;
  elsif exists (
    select 1 from public.private_records r
    where r.record_id = pr_share.record_id
      and r.record_type in ('strength_entry', 'wod_entry')
      and r.user_id <> v_uid
  ) then
    raise exception 'not authorized';
  end if;

  -- Is this record already a post IN THIS CIRCLE?
  select * into v_prior_post
  from public.workout_posts p
  where p.author_id = v_uid
    and p.club_id = p_club_id
    and p.source_type in ('strength_entry', 'wod_entry')
    and p.source_record_id = pr_share.record_id
  limit 1;
  if found then
    if v_prior_post.post_type = 'POST_PR' then
      perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_prior_post.id));
      return v_prior_post.id;
    end if;
    if v_prior_post.post_type = 'POST_WORKOUT' then
      if v_prior_post.status <> 'active' then raise exception 'post is not available'; end if;
      v_upgrade := true;
    else
      raise exception 'this record already has a post';
    end if;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(coalesce(note, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g');
  v_body := left(btrim(v_body), 1000);

  if v_payload ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    v_occurred := (v_payload ->> 'date')::date;
  end if;
  v_exercise := nullif(v_payload ->> 'exerciseId', '');
  v_weight   := public.private_record_number(v_payload, 'weight');
  v_reps     := public.private_record_number(v_payload, 'reps');
  v_duration := public.private_record_number(v_payload, 'durationSeconds');
  v_est      := public.private_record_number(v_payload, 'est1RM');
  v_ts       := public.private_record_number(v_payload, 'ts');

  if v_exercise is not null then
    select nullif(left(btrim(coalesce(m.payload ->> 'name', '')), 120), '')
      into v_title
    from public.private_records m
    where m.user_id = v_uid and m.record_type = 'movement'
      and m.record_id = v_exercise and m.deleted_at is null;
  end if;

  -- The percent improvement over the previous best of the SAME movement at the
  -- SAME rep count, from the caller's own history. Computed from the record
  -- whether or not the weight is shown: a percent is not an absolute number.
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
      v_pct := round((v_weight - v_prev) / v_prev * 100, 1);
    end if;
  end if;

  if coalesce(v_payload ->> 'type', '') = 'duration' and v_duration is not null and v_duration > 0 then
    -- A time, not a weight.
    v_result := trim(trailing '.' from to_char(v_duration, 'FM999999990.99')) || ' שנ׳';
    v_score := v_duration;
  elsif v_pct is not null then
    v_result := '+' || trim(trailing '.' from to_char(v_pct, 'FM999999990.9')) || '%';
  end if;

  -- The absolute weight, only because the client sent it.
  if p_weight is not null and coalesce(v_payload ->> 'type', '') <> 'duration' then
    v_result := trim(trailing '.' from to_char(p_weight, 'FM999999990.99')) || ' ק"ג'
             || case when v_reps is not null and v_reps > 0
                     then ' × ' || trim(trailing '.' from to_char(v_reps, 'FM999999990')) else '' end;
    v_score := coalesce(v_est, p_weight);
    if v_prev is not null and v_prev > 0 and v_weight > v_prev then
      v_prev_result := trim(trailing '.' from to_char(v_prev, 'FM999999990.99')) || ' ק"ג'
                    || case when v_reps is not null and v_reps > 0
                            then ' × ' || trim(trailing '.' from to_char(v_reps, 'FM999999990')) else '' end;
      v_improvement := '+' || trim(trailing '.' from to_char(v_weight - v_prev, 'FM999999990.99')) || ' ק"ג';
    end if;
  end if;

  if v_title is not null then v_metadata := v_metadata || jsonb_build_object('movement', v_title); end if;
  if v_exercise is not null then v_metadata := v_metadata || jsonb_build_object('movement_id', v_exercise); end if;
  if v_pct is not null then v_metadata := v_metadata || jsonb_build_object('improvement_pct', v_pct); end if;
  if p_weight is not null and v_result is not null then
    v_metadata := v_metadata || jsonb_build_object('new_result', v_result);
  end if;
  if v_prev_result is not null then
    v_metadata := v_metadata || jsonb_build_object('previous_result', v_prev_result, 'improvement', v_improvement);
  end if;
  if v_occurred is not null then v_metadata := v_metadata || jsonb_build_object('achieved_on', v_occurred); end if;

  -- A PR card names the lift (movement id), shows a figure, or carries a note;
  -- a card with none of those says nothing.
  if v_result is null and v_body = '' and v_exercise is null
     and (not v_upgrade
          or coalesce(v_prior_post.result_text, v_prior_post.title, v_prior_post.body) is null)
  then
    raise exception 'a post needs text or a figure';
  end if;

  if v_upgrade then
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
  else
    perform set_config('app.allow_unrated_post_insert', 'on', true);
    perform set_config('app.allow_pr_achievement_write', 'on', true);
    insert into public.workout_posts (
      author_id, club_id, post_type, body, title, result_text,
      source_type, source_record_id, occurred_on, score_value, score_direction,
      metadata, status, published_at)
    values (
      v_uid, p_club_id, 'POST_PR', nullif(v_body, ''), v_title, v_result,
      v_source_type, pr_share.record_id, coalesce(v_occurred, current_date), v_score,
      case when v_score is null then null else 'higher' end,
      v_metadata, 'active', now())
    returning id into v_post_id;
    perform set_config('app.allow_pr_achievement_write', 'off', true);
    perform set_config('app.allow_unrated_post_insert', 'off', true);
  end if;

  perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;

-- Share an unlocked achievement to ONE circle.
drop function public.ach_share(uuid, text, jsonb, uuid);
create or replace function public.ach_share(
  p_club_id uuid, member_achievement_id uuid, caption text default '',
  p_idempotency_key uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_body text;
  v_post_id uuid;
  v_replay boolean;
  v_prior jsonb;
  v_ma public.member_achievements;
  v_def public.achievement_definitions;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('ach_share', p_idempotency_key, p_club_id::text || ':' || coalesce(member_achievement_id::text, '')) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_circle_member(p_club_id) then raise exception 'not authorized'; end if;
  if member_achievement_id is null then raise exception 'achievement is required'; end if;

  select * into v_ma from public.member_achievements ma where ma.id = member_achievement_id;
  if not found then raise exception 'achievement not found'; end if;
  if v_ma.user_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_ma.visibility = 'only_me' then raise exception 'a private achievement cannot be shared'; end if;
  if not v_ma.verified then raise exception 'achievement not verified'; end if;

  select * into v_def from public.achievement_definitions d where d.id = v_ma.achievement_id;
  if not found then raise exception 'achievement not found'; end if;

  -- Natural idempotency, per circle.
  select p.id into v_post_id
  from public.workout_posts p
  where p.author_id = v_uid
    and p.club_id = p_club_id
    and p.source_type = 'achievement'
    and p.source_record_id = member_achievement_id::text
  limit 1;
  if v_post_id is not null then
    update public.member_achievements set shared_at = now()
     where id = member_achievement_id and shared_at is null;
    perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
    return v_post_id;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(coalesce(caption, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g');
  v_body := left(btrim(v_body), 1000);

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  perform set_config('app.allow_pr_achievement_write', 'on', true);
  insert into public.workout_posts (
    author_id, club_id, post_type, visibility, body, title, result_text,
    source_type, source_record_id, source_id, occurred_on, metadata, status, published_at)
  values (
    v_uid, p_club_id, 'POST_ACHIEVEMENT', v_ma.visibility::public.post_visibility,
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

  update public.member_achievements set shared_at = now()
   where id = member_achievement_id and shared_at is null;

  perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;

-- 6. Notification plumbing, scoped to the circle -------------------------------
-- A block between two people is visible to the two of them, or to a trigger/job
-- with no caller; not to a third member asking about strangers.
create or replace function public.notif_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_a is not null and p_b is not null
    and (auth.uid() is null or auth.uid() in (p_a, p_b))
    and exists (
      select 1 from public.blocks b
       where (b.blocker_id = p_a and b.blocked_id = p_b)
          or (b.blocker_id = p_b and b.blocked_id = p_a)
    );
$$;

create or replace function public.notif_on_reaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := new.user_id;
  v_author uuid;
  v_club uuid;
begin
  select p.author_id, p.club_id into v_author, v_club
    from public.workout_posts p where p.id = new.post_id;
  if v_author is null or v_author = v_actor then return null; end if;
  -- Both people are in the post's circle, or nobody is told.
  if not exists (select 1 from public.circle_members m where m.club_id = v_club and m.user_id = v_author)
     or not exists (select 1 from public.circle_members m where m.club_id = v_club and m.user_id = v_actor) then
    return null;
  end if;
  if public.notif_blocked_between(v_author, v_actor) then return null; end if;
  if not public.notif_pref_allows(v_author, 'reaction') then return null; end if;

  perform public.notif_queue_batched(v_author, 'community', 'reaction', new.post_id);
  return null;
end $$;

-- A new tag asks the tagged member to confirm; it is told only if it is in the
-- post's circle.
create or replace function public.notif_on_training_partner_tag()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_post public.workout_posts;
begin
  select * into v_post from public.workout_posts where id = new.post_id;
  if not found then return null; end if;
  if new.tagged_user_id = new.tagged_by then return null; end if;
  if not exists (select 1 from public.circle_members m
                  where m.club_id = v_post.club_id and m.user_id = new.tagged_user_id) then
    return null;
  end if;

  perform public.notif_create(
    new.tagged_user_id, 'trained_together', 'community',
    'You were tagged as a training partner',
    coalesce(nullif(btrim(v_post.title), ''), ''),
    'post', new.post_id,
    '/community/feed?post=' || new.post_id::text
  );
  return null;
end $$;

-- 7. Grants -------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.post_tag_training_partners(uuid, uuid[])',
    'public.confirm_trained_together(uuid)',
    'public.post_training_partner_remove(uuid, uuid)',
    'public.toggle_reaction(uuid, uuid, text)',
    'public.post_create(uuid, text, uuid)',
    'public.pr_share(uuid, text, text, numeric, uuid)',
    'public.ach_share(uuid, uuid, text, uuid)',
    'public.post_training_partners_for(uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

commit;
