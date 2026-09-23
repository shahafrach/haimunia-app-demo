-- COMM-315 / launch-readiness N7: the member of the week was never told.
--
-- The feature exists so a club can say "we noticed you". The card went on the
-- board and a post went in the feed, and the one person it was about was the
-- only one not notified - they found out if they happened to scroll past it.
--
-- The body below is the live definition read with pg_get_functiondef(), with
-- one block added before the return. Everything else is untouched.
CREATE OR REPLACE FUNCTION public.member_of_week_publish(p_week_start date, p_user_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_week date;
  v_rotation text;
  v_category text;
  v_reason text;
  v_p public.profiles;
  v_name text;
  v_id uuid := gen_random_uuid();
  v_post_id uuid;
  v_label text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;
  if p_user_id is null then raise exception 'member required'; end if;

  -- Same normalisation member_of_week_candidates() applies, so a coach
  -- publishing the week they were just shown always lands on that week.
  -- Null means the current week, which is what a "publish" button with no
  -- date picker means.
  v_week := date_trunc('week', coalesce(p_week_start, current_date)::timestamp)::date;

  -- --- once per week ---------------------------------------------------
  -- Checked and raised before anything is written, so the caller gets
  -- 'week already published' rather than a raw 23505 from the unique
  -- constraint below it. The constraint still stands and is still the thing
  -- that makes the rule true; this is the readable error on top of it.
  -- Explicitly NOT an upsert: weekly_recaps upserts because a recap is a
  -- regenerated summary, whereas this is a public act of recognition that
  -- has already been posted to the feed, and quietly replacing it would
  -- leave the post naming one member and the row naming another.
  if exists (select 1 from public.member_of_week m where m.week_start = v_week) then
    raise exception 'week already published';
  end if;

  select * into v_p from public.profiles p
  where p.id = p_user_id and p.deleted_at is null;
  if not found then raise exception 'member not found'; end if;
  if not v_p.visible_to_club then
    raise exception 'member is not visible to the club';
  end if;

  -- --- no two weeks running --------------------------------------------
  -- A real refusal, not a suggestion-level nicety: the candidate list
  -- already hides last week's member, and this is what makes that true
  -- even for a coach's pick, a hand-written client call, or a week whose
  -- suggestions were never fetched at all.
  if exists (
    select 1 from public.member_of_week m
    where m.week_start = v_week - 7 and m.user_id = p_user_id
  ) then
    raise exception 'member was recognised last week';
  end if;

  -- --- category ---------------------------------------------------------
  v_rotation := public.member_of_week_category(v_week);
  if v_rotation <> 'coachs_pick' and exists (
    select 1 from public.member_of_week_candidate_set(v_rotation, v_week, 3) c
    where c.user_id = p_user_id
  ) then
    v_category := v_rotation;
  else
    v_category := 'coachs_pick';
  end if;

  -- --- reason -----------------------------------------------------------
  -- The same control-character class post_create strips: 0x01-0x08 and
  -- 0x0B-0x1F, keeping tab and newline, built with chr() so it does not
  -- depend on the database LC_CTYPE and cannot strip Hebrew on a C-locale
  -- build.
  v_reason := regexp_replace(
    coalesce(p_reason, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_reason := left(btrim(v_reason), 500);

  if v_category = 'coachs_pick' and v_reason = '' then
    raise exception 'reason required for a coach''s pick';
  end if;

  -- --- the post ---------------------------------------------------------
  v_name := coalesce(nullif(btrim(v_p.display_name), ''), v_p.handle);
  v_label := public.member_of_week_category_label(v_category);

  insert into public.workout_posts
    (author_id, post_type, visibility, title, body, metadata, status,
     published_at, club_id, source_type, source_id, occurred_on)
  values (
    null, 'POST_ANNOUNCEMENT', 'club',
    'חבר/ת השבוע',
    left(v_name || ' — ' || v_label || case when v_reason = '' then '' else E'\n' || v_reason end, 1000),
    -- metadata.title is what renderAnnouncementPostCard reads first; the
    -- rest is the same flat, self-describing shape every other producer in
    -- this schema writes, so a card can be rendered without joining back.
    jsonb_build_object(
      'title',            'חבר/ת השבוע',
      'member_of_week',   true,
      'member_id',        p_user_id,
      'member_name',      v_name,
      'category',         v_category,
      'category_label',   v_label,
      'week_start',       v_week,
      'reason',           v_reason
    ),
    'active', now(), public.default_club_id(),
    -- source_id points at the member_of_week row, whose id is generated
    -- above so the two rows can reference each other in one transaction.
    'announcement', v_id, v_week
  )
  returning id into v_post_id;

  insert into public.member_of_week
    (id, week_start, category, user_id, reason, post_id, published_by)
  values (v_id, v_week, v_category, p_user_id, v_reason, v_post_id, v_uid);

  -- One audit row, written inside the same transaction, so a failed log
  -- fails the whole publish. Same shape pin_set() uses.
  perform public.log_admin_action(
    'member_of_week_publish', 'member', p_user_id, null,
    jsonb_build_object(
      'member_of_week_id', v_id,
      'week_start',        v_week,
      'category',          v_category,
      'rotation_category', v_rotation,
      'post_id',           v_post_id,
      'reason',            v_reason
    )
  );

  -- COMM-315 / launch-readiness N7. TELL THE MEMBER.
  --
  -- The whole feature is a club saying "we noticed you", and until now the
  -- one person it was about was the only one not told: the card went on the
  -- board, the post went in the feed, and the member found out if they
  -- happened to scroll past it. The admin_actions row above has recorded the
  -- publish since 202609010001; nothing has ever reached the member.
  --
  -- notif_create() is best-effort here on purpose. A notification that cannot
  -- be written - a preference row set to off, a member since deleted - must
  -- not roll back the publish itself: the choice is the club's and has
  -- already been made, and losing it because a notification failed would be a
  -- worse outcome than a quiet notification.
  --
  -- Type 'member_of_week', category 'club'. notif_pref_key() has no arm for
  -- it, so it keys on itself and notif_pref_allows() returns true unless a
  -- member explicitly turns it off - which is the right default for something
  -- that happens to one person a week at most.
  begin
    perform public.notif_create(
      p_user_id, 'member_of_week', 'club',
      'נבחרתם לחבר/ת השבוע!',
      coalesce(nullif(btrim(v_reason), ''), 'המועדון בחר בכם השבוע.'),
      'member_of_week', v_id,
      '/community/boards');
  exception when others then
    raise notice 'member_of_week_publish: the member was not notified (%)', sqlerrm;
  end;

  return v_id;
end $function$;
