begin;

-- TRAINED TOGETHER. The author of a workout post says who was in the room
-- with them, the people they name are told, and any of them can take their
-- own name off it.
--
-- WHAT LANDS HERE
--   * club_features row 'trained_together', DISABLED - the switch before the
--     surface, the sequence 202609190002 established.
--   * public.attendance_classmates_on(date, int) - new. The classmates
--     signal for ANY day, and public.attendance_classmates_today(int) is
--     re-created as a one-line call into it, so there is one algorithm and
--     not two (CLAUDE.md, "Sibling drift").
--   * public.post_training_partners - new table, select-only to clients,
--     one read policy.
--   * public.post_tag_training_partners(uuid, uuid[]) - the only writer.
--   * public.post_training_partner_remove(uuid, uuid) - the only deleter.
--   * public.post_training_partners_for(uuid[]) - the batch read the feed
--     card uses. SECURITY INVOKER, deliberately; see its own header.
--   * notif_on_training_partner_tag() + its AFTER INSERT trigger, type
--     'trained_together'.
--
-- WHAT DOES NOT LAND HERE, and why. feed_page() is NOT re-created. Its
-- `returns table (...)` is fixed, so adding a `training_partners` column
-- means dropping and rebuilding the largest function in this schema - a
-- 400-line ranking body - to carry a list the card can fetch for itself in
-- one round trip per page. post_training_partners_for() is that round trip.
--
-- THE CONSENT GATE IS allow_mentions, not a new column. Being named on
-- somebody else's post is the same act, from the tagged member's side, as
-- being @-mentioned in a comment: your name, attached to content you did
-- not write, with a notification. A second toggle for it would mean a
-- member who turned tagging off in one place and not the other, and a
-- settings screen that has to explain the difference. The task asks for
-- allow_mentions and allow_mentions is the honest key.
--
--   SIBLING NOTED, NOT CHANGED. add_post_comment's five-argument form
--   (202609060014) accepts a mention target on
--   can_view_profile_field(target, 'allow_mentions'), and that call carries
--   can_view_profile_field's is_admin() short-circuit - so an ADMIN author
--   can mention a member who turned mentions off. This function makes the
--   identical call, on purpose, so the two paths cannot drift; the
--   short-circuit is module-wide behaviour (202608310005's header states it
--   for the classmates card) and narrowing it here would leave two
--   mention-consent rules in one schema, which is worse than one rule
--   somebody may later decide to narrow in both places at once.

-- ===========================================================================
-- 0. The switch.
-- ===========================================================================
-- Off, for the reason 202609190002 wrote down at length: nothing is taken
-- away by starting off, and the club turns it on when it is ready. Unlike
-- those seven, the feature behind this key ships in the same file - so the
-- registry row carries no `planned` marker, and no `clientOnly` marker
-- either, because the read policy and both write paths below really do
-- refuse while it is off.
insert into public.club_features (module_key, enabled) values ('trained_together', false)
-- Never `do update`: a row that already exists came from an admin's own
-- admin_set_club_feature() call, and a migration does not overwrite that.
-- Also what makes this statement a no-op on a replay.
on conflict (club_id, module_key) do nothing;

-- The guard 202609160006 introduced and 202609190002 generalised, restated
-- for THIS KEY ONLY rather than over the whole list again. Two other
-- branches are adding migrations against this same base (202609220003 and
-- 202609220004); a third copy of the full key list here would conflict with
-- either of them the moment one of them seeds a key of its own, and a guard
-- that causes merge conflicts is a guard people delete. The full-list
-- version still runs, in 202609190002, on every fresh database.
do $$
begin
  if not exists (
    select 1 from public.club_features cf where cf.module_key = 'trained_together'
  ) then
    raise exception 'club_features is missing a row for: trained_together';
  end if;
end $$;

-- ===========================================================================
-- 1. The classmates signal, for a day that is not necessarily today.
-- ===========================================================================
-- attendance_classmates_today() (202608310005) answers "who else trained
-- today". The tagging suggestion needs "who else trained on the day this
-- post is about", which is the same question with the date unpinned - a
-- workout post carries occurred_on and is very often written the evening
-- after, or the next morning.
--
-- SO THE FUNCTION IS GENERALISED RATHER THAN COPIED. A second function with
-- the same join, the same privacy gate and the same ordering is precisely
-- the defect CLAUDE.md's "Sibling drift" section describes: a right line
-- with two copies, one of which is later fixed. attendance_classmates_on()
-- is the whole algorithm and attendance_classmates_today() becomes a call
-- into it with current_date.
--
-- EVERY BEHAVIOUR OF THE ORIGINAL IS PRESERVED, deliberately and to the
-- letter, because supabase/tests/0041 asserts on all of them:
--   * the caller's own show_attendance, read as a direct profiles column
--     (can_view_profile_field answers true for the caller before it reads
--     any toggle, so it cannot ask this question);
--   * the caller's own attendance_log row for the day as the anchor - no
--     row, no rows out;
--   * can_view_profile_field(candidate, 'show_attendance') per candidate,
--     which settles blocks in both directions, deleted profiles and
--     visible_to_club in one call;
--   * self excluded; order recorded_at desc, then display name falling back
--     to handle, then id; p_limit clamped 1..20;
--   * an empty set, never a raise, for all three ways of having nobody to
--     show - which is what makes the caller's own setting unobservable from
--     the response.
-- The only thing that is new is the parameter.
create or replace function public.attendance_classmates_on(p_day date, p_limit int default 6)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_day date;
  v_opted_in boolean;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if public.my_role_code() is null then raise exception 'not authorized'; end if;

  v_limit := greatest(1, least(coalesce(p_limit, 6), 20));
  -- A null day means today, so the delegating today() form below and a
  -- client that simply omits the argument answer the same thing.
  v_day := coalesce(p_day, current_date);

  select p.show_attendance into v_opted_in
  from public.profiles p
  where p.id = v_uid and p.deleted_at is null;
  if not coalesce(v_opted_in, false) then return; end if;

  return query
  with same_day as (
    select o.user_id as cand, o.recorded_at as logged_at
    from public.attendance_log me
    join public.attendance_log o
      on o.occurred_on = me.occurred_on
     and o.user_id <> me.user_id
    where me.user_id = v_uid
      and me.occurred_on = v_day
  )
  select jsonb_build_object(
    'user_id', t.cand,
    'display_name', pr.display_name,
    'handle', pr.handle,
    'avatar_url', pr.avatar_url
  )
  from same_day t
  join public.profiles pr on pr.id = t.cand
  where public.can_view_profile_field(t.cand, 'show_attendance')
  order by t.logged_at desc,
           coalesce(nullif(btrim(pr.display_name), ''), pr.handle) asc,
           t.cand asc
  limit v_limit;
end $$;
revoke all on function public.attendance_classmates_on(date, int) from public, anon;
grant execute on function public.attendance_classmates_on(date, int) to authenticated;

comment on function public.attendance_classmates_on(date, int) is
  'The classmates signal for one named day: members other than the caller with an attendance_log row for p_day, when the caller has one too. Generalised out of attendance_classmates_today() (202608310005) by 202609220005 so the tagging suggestion on a workout post can ask about the day the post is ABOUT rather than the day it is read - one algorithm, not two. Null p_day means current_date. Everything else is 202608310005''s contract unchanged: setof jsonb {user_id, display_name, handle, avatar_url}, no date, no time, no count; each candidate must pass can_view_profile_field(candidate, ''show_attendance''), which also settles block edges both ways, deleted profiles and visible_to_club; the CALLER''s own show_attendance is enforced as a direct profiles column read and off means an empty set, never a raise; self excluded; ordered most recently recorded first, then display name then id; p_limit clamped 1..20, null means 6. security definer for one boundary - attendance_log is own-row plus staff.';

-- The original signature, unchanged, now one line. Callers do not move:
-- directory.js still calls attendance_classmates_today(p_limit) and gets
-- exactly what it got before.
create or replace function public.attendance_classmates_today(p_limit int default 6)
returns setof jsonb
language sql stable security definer set search_path = '' as $$
  select * from public.attendance_classmates_on(current_date, p_limit);
$$;
revoke all on function public.attendance_classmates_today(int) from public, anon;
grant execute on function public.attendance_classmates_today(int) to authenticated;

comment on function public.attendance_classmates_today(int) is
  'COMM-307 post-class trained-with-you card, closing COMM-P05. Since 202609220005 this is attendance_classmates_on(current_date, p_limit) and nothing else - the body moved so the tagging suggestion and this card could not drift apart. Its contract is unchanged and supabase/tests/0041 still describes it: members other than the caller with an attendance_log row for today, when the caller has one too; setof jsonb {user_id, display_name, handle, avatar_url} and no other field; per-candidate can_view_profile_field(candidate, ''show_attendance'') carrying blocks, deleted profiles and visible_to_club; the caller''s own show_attendance enforced as a direct column read, off meaning an empty set rather than a raise; self excluded; recorded_at desc then display name then id; p_limit clamped 1..20, null means 6.';

-- ===========================================================================
-- 2. The table.
-- ===========================================================================
-- Shaped on comment_mentions (202608280021) because it is the same kind of
-- row: a member's id attached to somebody else's content, written only by a
-- definer function that re-checked consent first.
create table public.post_training_partners (
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  tagged_user_id uuid not null references public.profiles(id) on delete cascade,
  -- Always the post author today, since only the author may tag. Stored
  -- anyway: the removal path needs to distinguish "the author took it off"
  -- from "the tagged member took it off" without a second lookup, and a
  -- future coach-tags-the-class path would write a different value here.
  tagged_by uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  created_at timestamptz not null default now(),
  primary key (post_id, tagged_user_id)
);
-- "Where am I tagged, most recent first" - the notification deep link and
-- any future own-tags screen. post_id needs no index of its own: it leads
-- the primary key.
create index post_training_partners_user_idx on public.post_training_partners(tagged_user_id, created_at desc);
-- tagged_by is a foreign key to profiles ON DELETE CASCADE, and an unindexed
-- FK column makes that cascade sequentially scan this table. DB-M3, pinned
-- by supabase/tests/0081, which fails on any public FK column outside
-- club_id that has no leading index - it caught this one.
create index post_training_partners_tagged_by_idx on public.post_training_partners(tagged_by);

alter table public.post_training_partners enable row level security;
revoke all on public.post_training_partners from public, anon;
-- Select only, exactly like comment_mentions: no insert, update or delete
-- grant and no policy for any of the three. The two functions below are the
-- complete list of ways a row here is created or destroyed.
grant select on public.post_training_partners to authenticated;

-- WHO CAN READ A TAG.
--
-- The whole policy is gated on the module, so "off" means the tags are
-- genuinely unqueryable and not merely unrendered - which is what lets the
-- registry row claim server enforcement. It takes the author's own tags with
-- it, the same "off is off, including your own" choice 202609010012 made for
-- member_achievements.
--
-- Then, either:
--   * you are the tagged member - so a tag on a post you can no longer see
--     (its visibility narrowed, the author blocked you) is still yours to
--     find and take off. A tag you cannot see is a tag you cannot remove.
--   * or you can read the post, AND the tagged member is someone you are
--     allowed to be shown.
--
-- The post check is a bare `exists` on workout_posts and that is the point:
-- a subquery in a policy runs as the querying member, so workout_posts'
-- own posts_feed_select policy applies to it in full - deleted posts, block
-- edges, visibility scopes, and the 'feed' module gate, none of them
-- restated here and none of them able to drift from the original.
--
-- can_view_profile_field(tagged_user_id, 'visible_to_club') is the second
-- half, and it is the same one call the classmates card relies on: it is
-- false across a block edge in either direction, false for a deleted
-- profile, and false for a member hidden from the club. So a member you have
-- blocked is not named on a post you are reading, and neither is a member
-- who has hidden themselves - without three more predicates saying so.
create policy post_training_partners_read on public.post_training_partners for select to authenticated using (
  public.club_feature_enabled('trained_together')
  and (
    tagged_user_id = auth.uid()
    or (
      exists (select 1 from public.workout_posts p where p.id = post_id)
      and public.can_view_profile_field(tagged_user_id, 'visible_to_club')
    )
  )
);

-- ===========================================================================
-- 3. The writer.
-- ===========================================================================
-- SET SEMANTICS, not append. The client sends the complete list it wants the
-- post to carry and this function makes the table match it: targets that are
-- new and pass the gate are inserted, targets that are gone are deleted.
-- Append-only would mean a composer that can add a wrong name and never take
-- it back, and two RPCs for one screen.
--
-- A REJECTED TARGET IS SKIPPED, NOT RAISED - add_post_comment's rule, for
-- add_post_comment's reason: the client has already filtered the list to
-- people it believes are taggable, so raising would turn "one of your tags
-- did not go through" into "your tags did not go through". The return value
-- is how many rows the post now carries, so a caller that cares can see that
-- it is not what they sent.
create or replace function public.post_tag_training_partners(p_post_id uuid, p_members uuid[])
returns int
language plpgsql security definer set search_path = '' as $$
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
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.club_feature_enabled('trained_together') then
    raise exception 'trained_together disabled';
  end if;
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
end $$;
revoke all on function public.post_tag_training_partners(uuid, uuid[]) from public, anon;
grant execute on function public.post_tag_training_partners(uuid, uuid[]) to authenticated;

comment on function public.post_tag_training_partners(uuid, uuid[]) is
  'The only writer of public.post_training_partners. SET semantics: the post ends up carrying exactly the accepted members of p_members, so a target dropped from the list is deleted. Author-only, POST_WORKOUT-only, active posts only; refuses while club_feature_enabled(''trained_together'') is false. Gated like any other community write - is_community_member(), is_posting_restricted(), check_rate_limit(''post_tag_training_partners'', 60, 10) - and capped at 10 targets, which raises rather than trimming. Self is dropped silently. A target is accepted only if their profile is live and can_view_profile_field(target, ''allow_mentions'') is true, the same consent call add_post_comment makes for a comment mention, carrying block edges both ways and visible_to_club with it; a rejected target is SKIPPED, not raised, so one bad name does not lose the rest. Removal of an existing tag is never gated on the target still passing that check. Returns the number of tags the post carries afterwards. on conflict do nothing, so re-saving an unchanged list fires no trigger and re-notifies nobody.';

-- ===========================================================================
-- 4. The deleter.
-- ===========================================================================
-- Two people may take a tag off, and the tagged member is the important one:
-- "can remove the tag" is the whole reason being tagged is acceptable at all.
--
-- NO MODULE GATE, no recovery gate and no posting restriction on this path.
-- It is the same judgement comment_delete (202608280021) recorded: taking
-- your own name off somebody else's content is not a community write, and a
-- restricted, unverified member - or a member in a club that has since
-- switched the module off - must never be stuck wearing a tag they want
-- gone.
create or replace function public.post_training_partner_remove(p_post_id uuid, p_user_id uuid default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_author uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Null means "me", so the card's own remove button sends one argument and
  -- cannot accidentally name somebody else.
  v_target := coalesce(p_user_id, v_uid);

  select author_id into v_author from public.workout_posts where id = p_post_id;
  -- The author may clear a name they put there; anyone may clear their own.
  -- Nobody else, including staff: a tag is a statement by the author about
  -- the tagged member, and only the two of them are party to it.
  if v_target <> v_uid and v_author is distinct from v_uid then
    raise exception 'not authorized';
  end if;

  -- Idempotent and silent when there is nothing to delete. A tag that was
  -- already removed - by the author, by the other party, by the post being
  -- deleted - is the state the caller asked for.
  delete from public.post_training_partners
  where post_id = p_post_id and tagged_user_id = v_target;
end $$;
revoke all on function public.post_training_partner_remove(uuid, uuid) from public, anon;
grant execute on function public.post_training_partner_remove(uuid, uuid) to authenticated;

comment on function public.post_training_partner_remove(uuid, uuid) is
  'The only deleter of a single public.post_training_partners row (post_tag_training_partners also deletes, as the other half of its set write). p_user_id null means the caller. Permitted for the tagged member on their own tag and for the post author on any tag on their post, and for nobody else - staff included. DELIBERATELY UNGATED on club_feature_enabled(''trained_together''), is_community_member() and is_posting_restricted(), the same reasoning comment_delete() records: removing your own name is not a community write, and a member must always be able to take it off. Idempotent - removing a tag that is not there is a silent no-op.';

-- ===========================================================================
-- 5. The batch read.
-- ===========================================================================
-- One call per feed page: the tags for every post on screen, with the names
-- the card prints, in the order the card prints them.
--
-- SECURITY INVOKER - the default, stated here because every other function
-- in this file is a definer and the difference is the entire security model
-- of this one. A definer would have to re-implement the read policy above
-- (the module gate, the post's own visibility, the block edges, the
-- visible_to_club filter) inside its body, which is exactly the duplicated
-- predicate CLAUDE.md warns about. As an invoker it is a convenience over
-- the member's own SELECT: post_training_partners_read decides what comes
-- back, profiles' own read policy decides what the join can name, and this
-- function adds no visibility of any kind. It is a shape, not a boundary.
create or replace function public.post_training_partners_for(p_post_ids uuid[])
returns setof jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'post_id', tp.post_id,
    'user_id', tp.tagged_user_id,
    'display_name', pr.display_name,
    'handle', pr.handle,
    'avatar_url', pr.avatar_url
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
$$;
revoke all on function public.post_training_partners_for(uuid[]) from public, anon;
grant execute on function public.post_training_partners_for(uuid[]) to authenticated;

comment on function public.post_training_partners_for(uuid[]) is
  'The feed card''s batch read: every training-partner tag on the given posts that the CALLER is allowed to see, as setof jsonb {post_id, user_id, display_name, handle, avatar_url}. SECURITY INVOKER on purpose and the only non-definer function in 202609220005 - post_training_partners_read and profiles'' own read policy do all the filtering (the trained_together module gate, the post''s own visibility, block edges both ways, visible_to_club), so this function adds no visibility and duplicates no predicate. Ordered post, then created_at, then display name, then id. Capped at 200 rows: a page is 20 posts and a post is at most 10 tags.';

-- ===========================================================================
-- 6. The notification.
-- ===========================================================================
-- AFTER INSERT on the table rather than inside the writer, the shape the
-- whole trigger set uses (202608280027): the rows are the source of truth,
-- so any future writer - a coach tagging a class, a backfill - notifies
-- without having to remember to.
--
-- notif_create() then applies, for the second time and independently, the
-- block edge and the recipient's own preference for the type, and its
-- one-hour de-dupe on (user, type, source_id) collapses a member who saves
-- the same list twice. 'trained_together' has no arm in notif_pref_key(), so
-- the server's identity fallback makes the preference key the literal type
-- name - which is what the client's NOTIF_TYPES row must then use, the way
-- new_report and streak_at_risk already do.
--
-- The title is English, like every other non-serverTitle type: notif_create
-- writes it, the client renders its own Hebrew label over it. The body is
-- the workout's own title, which the tagged member could already read on the
-- post the link goes to - no result, no score, nothing the post does not say.
create or replace function public.notif_on_training_partner_tag() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_post public.workout_posts;
begin
  select * into v_post from public.workout_posts where id = new.post_id;
  if not found then return null; end if;
  if new.tagged_user_id = new.tagged_by then return null; end if;

  perform public.notif_create(
    new.tagged_user_id, 'trained_together', 'community',
    'You were tagged as a training partner',
    coalesce(nullif(btrim(v_post.title), ''), ''),
    'post', new.post_id,
    '/community/feed?post=' || new.post_id::text
  );
  return null;
end $$;
revoke all on function public.notif_on_training_partner_tag() from public, anon, authenticated;

create trigger post_training_partners_notify after insert on public.post_training_partners
  for each row execute function public.notif_on_training_partner_tag();

comment on table public.post_training_partners is
  'Who the author of a workout post says trained with them (202609220005). Select-only to clients; post_tag_training_partners() is the only writer and post_training_partner_remove() the only single-row deleter. Readable while club_feature_enabled(''trained_together'') is true, by the tagged member always - so a tag on a post they can no longer see is still theirs to remove - and otherwise by anyone who can read the post AND can_view_profile_field(tagged_user_id, ''visible_to_club''). An insert notifies the tagged member as type ''trained_together''.';

commit;
