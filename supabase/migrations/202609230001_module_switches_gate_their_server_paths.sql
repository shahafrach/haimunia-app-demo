-- Module switches gate the server paths that bypassed them (202609230001).
--
-- THE GAP. The admin panel says a module row marked "נאכף בשרת" is enforced
-- on the server. For the six content modules that was true of the TABLE
-- READ POLICIES only (202609010012, 202609060001, 202609060011). Every
-- SECURITY DEFINER function bypasses RLS, so each one that reads or writes a
-- gated table has to carry the switch itself - feed_leaderboard has since
-- 202609010012 - and these did not:
--
--   feed_page()                 'feed'          the club feed itself
--   post_create()               'feed'          the one member post writer
--   event_rsvp()                'events'
--   chal_progress()             'challenges'
--   ach_claim()                 'achievements'
--   community_streaks()         'leaderboards'  a ranked list of the club
--   INSERT on announcements     'announcements' (new BEFORE INSERT trigger)
--   notif_announcement_fanout() 'announcements' insert AND escalation
--
-- A member calling Supabase directly got a switched-off feature, and an
-- announcement published while the module was off still notified the club.
--
-- THE RULE ADDED, and nothing else. One line per function, placed AFTER the
-- existing auth and is_community_member() checks so the order of refusals a
-- member already sees is unchanged, raising '<module_key> disabled' (P0001) -
-- the message feed_leaderboard already raises for 'leaderboards'. With the
-- module on, every function does exactly what it did: who may do what is
-- not touched here.
--
-- The fan-out RETURNS rather than raises: it runs inside an insert or an
-- update that is otherwise legitimate (a session-less insert, see below, or
-- a staff edit), and "nobody is notified" is what off means for it.
--
-- THE BODIES ARE NOT RETYPED. Each is the latest applied definition,
-- extracted from its migration by exact-string match and re-emitted with the
-- gate inserted at one anchor that occurs exactly once - the same
-- full-recreation-with-one-added-gate shape 202609060009 used. create or
-- replace keeps each function's grants and comment.
--
-- THE ANNOUNCEMENT INSERT is a trigger rather than a clause on
-- announcements_insert_admin so the refusal says why: an RLS WITH CHECK
-- failure reads "new row violates row-level security policy", which tells a
-- coach nothing. It refuses only when auth.uid() is set - a member or
-- coach session. A session-less write (a migration, the dashboard, a test
-- fixture run as the bootstrap role) is not a member calling the API; it is
-- still silent while the module is off, because announcement_feed_card_insert
-- (202609220007) and the fan-out below both return early.
--
-- WHAT THIS DOES NOT CLOSE, listed so the panel does not claim it. Other
-- definer paths into the same modules stay ungated - pr_share/ach_share,
-- post_edit_caption/post_set_visibility and comments (feed),
-- chal_record_progress and club_summary (challenges), notif_on_achievement
-- and server-side unlocks (achievements), notif_on_event_cancelled and
-- chal_notify_ending_soon (events, challenges). cloud.js marks those four
-- rows serverPartial, and the panel says "נאכף בשרת חלקית" on them.

begin;

-- ---------------------------------------------------------------------------
-- feed_page
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.feed_page(p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 20, p_scope text DEFAULT 'for_you'::text)
 RETURNS TABLE(id uuid, post_type post_type, author_id uuid, author jsonb, body text, title text, result_text text, occurred_on date, visibility post_visibility, created_at timestamp with time zone, published_at timestamp with time zone, metadata jsonb, media jsonb, reaction_count integer, comment_count integer, feed_score numeric, next_cursor text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  -- =========================================================================
  -- SCORING WEIGHTS. This block is the only place any of them appear.
  -- Every component is normalised to 0..1 first and then multiplied by its
  -- weight here, so a weight is directly comparable to every other weight
  -- and tuning one is a one-line change with no other arithmetic to redo.
  -- The positive weights sum to 110. Nothing depends on that number, it is
  -- only there so they read as rough percentages.
  --
  -- IT SAID 104 UNTIL NOW, and that had been wrong since 202608310003. The
  -- 104 was the seven live weights while v_w_class was declared at 6 and
  -- multiplied by a hard 0; COMM-302 turned that component on and left the
  -- comment behind. Corrected here rather than acted on: NO WEIGHT MOVES IN
  -- THIS MIGRATION. Renormalising the block back down to 104 would change
  -- every existing feed score on deploy day, which is the one thing COMM-303
  -- must not do.
  --
  -- COMM-303. These eight are no longer `constant`: they are the DEFAULTS,
  -- and the section marked "per-user weights" in the body below may replace
  -- each of them with this member's own resolved weight before the scoring
  -- query runs. What it may not do is change their total - a personalized
  -- set sums to exactly what this block sums to, so personalization moves
  -- emphasis between components and never inflates the score. That total is
  -- computed from these values at call time and is nowhere hardcoded, so the
  -- next retune of any weight here needs no second edit anywhere.
  -- =========================================================================
  v_w_recency        numeric := 40;  -- how fresh the post is
  v_w_relationship   numeric := 18;  -- who the author is to the viewer
  v_w_coach          numeric := 10;  -- coach voice carries further
  v_w_achievement    numeric := 8;   -- PRs, achievements, milestones
  v_w_challenge      numeric := 6;   -- challenge and event content
  v_w_engagement     numeric := 10;  -- what the club already did with it
  v_w_personal       numeric := 12;  -- it is about, or involves, the viewer
  -- COMM-302, closing COMM-P01. This weight was reserved and multiplied by a
  -- hard 0 from 202608280019 until now, so that wiring an attendance source
  -- would be a value change here and nothing else. It is: the value now comes
  -- from public.classmate_day_counts(), normalised below. The weight itself
  -- has not moved. COMM-303 personalizes it exactly like the other seven -
  -- it is not special-cased as immovable, so a member who trains with the
  -- same people every week can have the class component carry more of their
  -- ranking than the club default gives it.
  v_w_class          numeric := 6;   -- the viewer and the author train together

  -- COMM-303. The defaults above, packed for feed_weights_resolve(). Built
  -- in the body from the eight variables themselves, so this is not a second
  -- copy of the numbers.
  v_w_defaults jsonb;
  v_weights    jsonb;

  -- =========================================================================
  -- ORDER (202609220003). Which of the two orders this club's feed is in,
  -- and the four tiers the chronological one keeps above the stream.
  --
  -- The tiers are the whole difference between "newest first" and "newest
  -- first, and you still cannot miss what the club pinned". They are a sort
  -- key, NOT a filter and NOT a score: a tier decides only what a post sorts
  -- above, and inside every tier the order is published_at descending with
  -- no arithmetic of any kind. Nothing here can show a post the ranked path
  -- would have hidden - the candidate query below is the one copy of what a
  -- member may see, and neither order touches it.
  -- =========================================================================
  v_order text;
  v_chrono boolean;
  -- How long the coach tier lasts. A club setting rather than a constant,
  -- read through club_feature_number() (202609220002) with the same shape
  -- coach_tasks' thresholds use: 72 hours shipped, clamped to [1, 336] (two
  -- weeks) server-side, and an empty field in the panel means the default
  -- rather than zero. It bounds a coach post from its publication and an
  -- announcement that carries no expiry of its own.
  v_coach_top_hours  numeric := 72;
  v_tier_pinned      constant numeric := 3;  -- staff pinned it to the top
  v_tier_coach       constant numeric := 2;  -- a coach post or a club announcement
  v_tier_club_wod    constant numeric := 1;  -- today's programming, while it is today's
  v_tier_stream      constant numeric := 0;  -- everything else, newest first

  -- Component shaping constants. Same block, same reason.
  -- Recency is an exponential half-life, not a cliff: 36 hours means
  -- yesterday's post is worth half of this morning's and a week-old post
  -- about 1.5% of it.
  v_recency_half_life_hours constant numeric := 36;
  -- COMM-301: the relationship component's own constants (mutual, follow,
  -- interaction, window) moved into public.relationship_score(), which is
  -- called below with v_anchor so the 30-day interaction window is measured
  -- from the same frozen session anchor as every other term. Only its weight
  -- is still stated here.
  -- Coach: an explicitly coach-voiced post is the full component, anything
  -- else written by a member at coach rank or above is half of it.
  v_coach_post       constant numeric := 1.0;
  v_coach_author     constant numeric := 0.5;
  -- Engagement is CAPPED. A comment is worth two reactions because it costs
  -- more to leave, and the whole term saturates, so a post that goes loud
  -- cannot outrank a week of everything else on volume alone.
  v_comment_weight   constant numeric := 2.0;
  v_engagement_saturation constant numeric := 12.0;
  -- COMM-302. The class component SATURATES, on the same reasoning and in
  -- the same shape as engagement above: eight days trained alongside this
  -- author inside classmate_day_counts()' 60-day window is the full
  -- component, and more does not buy more. Eight is roughly twice a week for
  -- a month - a real training partnership rather than a coincidence - and
  -- past that the answer to "do these two train together" stops changing.
  -- Scaling by the window length instead would make even a daily training
  -- partner worth a fraction of a point.
  v_class_saturation constant numeric := 8.0;
  -- Personal relevance: each signal adds, the sum is capped at 1.
  v_pers_mention     constant numeric := 1.0;  -- the body names the viewer
  v_pers_reply       constant numeric := 0.8;  -- someone replied to the viewer here
  v_pers_thread      constant numeric := 0.5;  -- the viewer is in this thread
  v_pers_participant constant numeric := 0.6;  -- viewer is in the linked challenge or event
  -- Repetition penalty: the Nth post by one member inside the window costs
  -- (N-1) steps, capped, so a member emptying their training log does not
  -- take the whole page. Subtracted from the total, never applied to an
  -- authorless system post.
  v_repetition_window_hours constant numeric := 24;
  v_repetition_step  constant numeric := 6;
  v_repetition_max   constant numeric := 18;

  -- =========================================================================
  -- DIVERSITY LIMITS (COMM-112). Also one place, also tunable.
  -- =========================================================================
  v_max_same_author  constant integer := 2;  -- consecutive posts by one member
  v_max_system_run   constant integer := 2;  -- consecutive system-generated posts
  v_max_workout_run  constant integer := 3;  -- consecutive workout cards
  -- After a run of this many workout cards the next slot prefers an
  -- achievement, coach, challenge or event card, when the page holds one.
  v_prefer_after_workouts constant integer := 2;

  -- How far back a page may reach and how many rows one session may rank.
  -- The cap is what keeps the scoring pass bounded; past it the feed ends
  -- with the caught-up marker rather than scanning the whole table.
  v_window_days      constant integer := 90;
  v_candidate_cap    constant integer := 600;

  v_uid uuid;
  v_handle text;
  v_limit integer;
  v_scope text;
  v_anchor timestamptz;
  v_cur_score numeric;
  v_cur_pub timestamptz;
  v_cur_id uuid;
  v_tail jsonb := '[]'::jsonb;
  v_tail_out jsonb := '[]'::jsonb;
  v_token jsonb;
  v_page jsonb := '[]'::jsonb;
  v_last jsonb;
  v_next text;

  -- diversity working set
  v_cand_id uuid[];
  v_cand_author uuid[];
  v_cand_kind text[];
  v_cand_score numeric[];
  v_used boolean[];
  v_ids uuid[] := array[]::uuid[];
  v_out_author uuid[] := array[]::uuid[];
  v_out_kind text[] := array[]::text[];
  v_out_score numeric[] := array[]::numeric[];
  v_n integer;
  v_slot integer;
  v_i integer;
  v_pick integer;
  v_run_author uuid;
  v_run_author_n integer := 0;
  v_run_system_n integer := 0;
  v_run_workout_n integer := 0;
  v_prefer boolean;
  v_e jsonb;
  v_a uuid;
  v_k text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230001. The feed module switch, enforced here and not only on the
  -- workout_posts read policy this definer function bypasses.
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_scope := lower(coalesce(p_scope, 'for_you'));
  -- COMM-111: an unknown scope falls back to for_you rather than raising, so
  -- an old client that has not learned a scope name still gets a feed.
  if v_scope not in ('for_you', 'following', 'achievements', 'coach', 'my_classes') then
    v_scope := 'for_you';
  end if;
  -- my_classes STAYS PARKED, deliberately, even though COMM-300 gave the
  -- module an attendance source and this migration wires it into the ranking
  -- above. A class-connection SCORE and a my-classes SCOPE are two different
  -- questions: the score asks "how much do these two members train
  -- together", which shared attendance days answer, and the scope asks
  -- "which posts belong to a class I attend", which they do not -
  -- attendance_log records days, not classes, and carries no class identity
  -- to filter a post by. Unparking the chip needs a source that has one, plus
  -- the client change to enable it, and neither is COMM-302. So this still
  -- answers empty rather than quietly answering something else, and the
  -- client still renders that chip disabled.
  if v_scope = 'my_classes' then
    return;
  end if;

  select p.handle into v_handle from public.profiles p where p.id = v_uid;

  -- --- which order (202609220003) ----------------------------------------
  -- One read per feed request, in the same place and for the same reason as
  -- the weights below: fixed for the whole call, so a page cannot be scored
  -- one way and cut another. An absent, misspelt or wrong-typed value reads
  -- as the default rather than raising - club_feature_choice()'s own
  -- discipline, inherited from club_feature_number().
  v_order := public.club_feature_choice('feed', 'order', 'chronological',
                                        array['chronological', 'ranked']);
  v_chrono := v_order = 'chronological';
  -- Read only where it is used. The ranked order has no tiers, so a ranked
  -- page does not pay for this second config read.
  if v_chrono then
    v_coach_top_hours := public.club_feature_number('feed', 'coach_top_hours', 72, 1, 336);
  end if;

  -- --- per-user weights (COMM-303) ---------------------------------------
  -- The eight defaults out, this member's eight resolved weights back. For a
  -- member with no member_feed_weights row - which is every member today,
  -- since nothing writes that table yet - feed_weights_resolve returns the
  -- object it was handed, so the unpack below reads each weight straight back
  -- out of the object the line above put it into and every score in this page
  -- is the one 202608310003 would have produced.
  --
  -- Placed HERE, after the auth check and after the parked my_classes scope
  -- has already returned, and before anything is scored: one lookup per feed
  -- request, never one per candidate row or one per page of a session. The
  -- weights are then fixed for the whole call, exactly like v_anchor, so
  -- diversity, the repetition penalty and the cursor all see one weight set.
  --
  -- This function is definer, so this reads past member_feed_weights_self_select
  -- - but only ever for v_uid, which is the one row that policy would have
  -- granted the caller anyway.
  --
  -- SKIPPED ENTIRELY IN CHRONOLOGICAL ORDER (202609220003). Not an
  -- optimisation for its own sake: feed_weights_resolve() is a per-member
  -- read whose only consumer is the scoring arithmetic below, and in this
  -- order that arithmetic is never evaluated. A club on the chronological
  -- feed pays for nothing the ranked feed needs, which is the same reasoning
  -- loadFeed()'s own module gate carries on the client.
  if not v_chrono then
    v_w_defaults := jsonb_build_object(
      'recency',      v_w_recency,
      'relationship', v_w_relationship,
      'coach',        v_w_coach,
      'achievement',  v_w_achievement,
      'challenge',    v_w_challenge,
      'engagement',   v_w_engagement,
      'personal',     v_w_personal,
      'class',        v_w_class);
    v_weights := coalesce(public.feed_weights_resolve(v_uid, v_w_defaults), v_w_defaults);
    if jsonb_typeof(v_weights) <> 'object' then v_weights := v_w_defaults; end if;

    -- Each coalesce leaves that weight at its default if the key is missing,
    -- so a short object costs a component its personalization rather than
    -- turning every score on the page null.
    v_w_recency      := coalesce((v_weights ->> 'recency')::numeric,      v_w_recency);
    v_w_relationship := coalesce((v_weights ->> 'relationship')::numeric, v_w_relationship);
    v_w_coach        := coalesce((v_weights ->> 'coach')::numeric,        v_w_coach);
    v_w_achievement  := coalesce((v_weights ->> 'achievement')::numeric,  v_w_achievement);
    v_w_challenge    := coalesce((v_weights ->> 'challenge')::numeric,    v_w_challenge);
    v_w_engagement   := coalesce((v_weights ->> 'engagement')::numeric,   v_w_engagement);
    v_w_personal     := coalesce((v_weights ->> 'personal')::numeric,     v_w_personal);
    v_w_class        := coalesce((v_weights ->> 'class')::numeric,        v_w_class);
  end if;

  -- --- cursor ------------------------------------------------------------
  -- Opaque on the wire: base64 of a small json object. A null, malformed or
  -- stale token restarts from the top instead of raising, because holding a
  -- stale cursor is a normal thing for a client to do.
  v_anchor := now();
  if p_cursor is not null and length(p_cursor) between 8 and 4000 then
    begin
      v_token := convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb;
      v_anchor := (v_token ->> 'a')::timestamptz;
      v_cur_score := (v_token ->> 's')::numeric;
      v_cur_pub := (v_token ->> 't')::timestamptz;
      v_cur_id := (v_token ->> 'i')::uuid;
      v_tail := coalesce(v_token -> 'p', '[]'::jsonb);
    exception when others then
      v_anchor := null; v_cur_score := null; v_cur_pub := null; v_cur_id := null;
      v_tail := '[]'::jsonb;
    end;
  end if;
  if v_anchor is null then v_anchor := now(); end if;
  -- A half-decoded token is treated as no token at all: a partial keyset
  -- would compare to null and silently return an empty page forever.
  if v_cur_score is null or v_cur_pub is null or v_cur_id is null then
    v_cur_score := null; v_cur_pub := null; v_cur_id := null;
  end if;

  -- --- score, then cut the page on the keyset ----------------------------
  select coalesce(
    jsonb_agg(jsonb_build_object('id', s.pid, 'a', s.aid, 'k', s.kind, 's', s.total, 't', s.pub)
              order by s.total desc, s.pub desc, s.pid desc),
    '[]'::jsonb)
  into v_page
  from (
    select sc.pid, sc.aid, sc.kind, sc.pub, sc.total
    from (
      with cand as (
        select p.id as pid,
               p.author_id as aid,
               p.post_type as ptype,
               p.published_at as pub,
               p.body as pbody,
               ((extract(epoch from (v_anchor - p.published_at)) / 3600.0))::numeric as age_hours,
               -- The three diversity classes plus a neutral one. An
               -- announcement is coach voice, not a system notice, so it is
               -- deliberately not counted against the system run.
               case
                 when p.post_type in ('POST_SYSTEM', 'POST_NEW_MEMBER') then 'system'
                 when p.post_type = 'POST_WORKOUT' then 'workout'
                 when p.post_type in (
                   'POST_ACHIEVEMENT', 'POST_PR', 'POST_ATTENDANCE_MILESTONE',
                   'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_CHALLENGE', 'POST_EVENT'
                 ) then 'boost'
                 else 'other'
               end as kind,
               case when coalesce(p.metadata ->> 'challenge_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'challenge_id')::uuid else p.source_id end as challenge_ref,
               case when coalesce(p.metadata ->> 'event_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'event_id')::uuid else p.source_id end as event_ref,
               -- 202609220003, for the announcement tier's expiry bound, and
               -- the one ref of the three that does NOT fall back to
               -- source_id. The two above may: a challenge card's source_id
               -- IS its challenge. An announcement card's is not its
               -- announcement - member_of_week_publish() writes
               -- source_type 'announcement' with the MEMBER_OF_WEEK row's id
               -- in source_id, so falling back the way the other two do
               -- would be joining public.announcements on a primary key from
               -- a different table. Metadata only, the same key shape the two
               -- above prefer, and no match simply means no expiry to read.
               case when coalesce(p.metadata ->> 'announcement_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'announcement_id')::uuid else null end as announcement_ref
        from public.workout_posts p
        where p.deleted_at is null
          and p.status = 'active'
          and p.published_at <= v_anchor
          and p.published_at >= v_anchor - make_interval(days => v_window_days)
          -- COMM-108: a post the member muted never comes back.
          and not exists (
            select 1 from public.hidden_posts h where h.user_id = v_uid and h.post_id = p.id)
          -- Reporting a post hides it from the reporter immediately, which
          -- is what the client already promises when a report is filed.
          and not exists (
            select 1 from public.reports rp where rp.post_id = p.id and rp.reporter_id = v_uid)
          -- COMM-125 block edges, in either direction. post_visible_to_viewer
          -- checks the same thing; this is stated separately because "the
          -- feed excludes blocked authors" has to be readable as its own rule.
          -- It is also what makes a block strictly stronger than the class
          -- component COMM-302 added: a blocked author never reaches the
          -- scoring pass at all, whatever their overlap with the viewer.
          and not exists (
            select 1 from public.blocks b
            where (b.blocker_id = v_uid and b.blocked_id = p.author_id)
               or (b.blocker_id = p.author_id and b.blocked_id = v_uid))
          -- The one place that says what each visibility label means. This
          -- function is definer, so RLS is not doing the filtering here and
          -- this call is what stands in for it.
          and public.post_visible_to_viewer(p.id)
          -- COMM-111 scopes.
          and (v_scope <> 'following' or exists (
                select 1 from public.follows f
                where f.follower_id = v_uid and f.followed_id = p.author_id))
          and (v_scope <> 'achievements' or p.post_type in (
                'POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE'))
          and (v_scope <> 'coach' or p.post_type in ('POST_COACH', 'POST_ANNOUNCEMENT'))
        order by p.published_at desc
        limit v_candidate_cap
      ),
      -- Relationship, class connection and author role depend on the author,
      -- not the post, so they resolve once per distinct author instead of
      -- once per row.
      -- `and not v_chrono` on these two CTEs, and nowhere else: their only
      -- consumer is the scoring arithmetic. A qual is applied before a scan's
      -- target list is computed, so in chronological order relationship_score(),
      -- classmate_day_counts() and two count subqueries per candidate row are
      -- not merely ignored - they never run.
      authors as (
        select distinct c.aid as aid from cand c where c.aid is not null and not v_chrono
      ),
      author_facts as (
        select a.aid as aid,
               -- COMM-301. Was an inline case/exists block here; identical
               -- arithmetic, same anchor, one copy.
               public.relationship_score(v_uid, a.aid, v_anchor) as rel_value,
               -- COMM-302. Was the constant 0. The helper is evaluated once
               -- for the whole page, not once per author, and it carries the
               -- show_attendance gate and the block check with it - an author
               -- who keeps their attendance private simply has no row here,
               -- so the coalesce below scores them 0.
               coalesce(cd.shared_days, 0) as class_days,
               (exists (select 1 from public.invite_redemptions ir
                        where ir.user_id = a.aid and public.role_rank(ir.role) >= 20)
                or exists (select 1 from public.profiles pf
                           where pf.id = a.aid and pf.is_admin and pf.deleted_at is null)
               ) as author_is_staff
        from authors a
        left join public.classmate_day_counts(v_anchor) cd on cd.user_id = a.aid
      ),
      counted as (
        select c.pid as pid,
               (select count(*) from public.reactions r where r.post_id = c.pid) as reactions,
               (select count(*) from public.post_comments pc
                where pc.post_id = c.pid and pc.deleted_at is null and pc.status = 'active') as comments
        from cand c
        where not v_chrono
      ),
      -- The Nth post by one author inside the repetition window. Ordering
      -- the partition newest first means every post counted ahead of an
      -- in-window post is itself in the window, so a plain row_number is
      -- exact and no second window predicate is needed.
      repeated as (
        select c.pid as pid,
               case when c.aid is null or c.age_hours > v_repetition_window_hours then 0
                    else (row_number() over (partition by c.aid order by c.pub desc))::integer - 1
               end as rep_index
        from cand c
      )
      select c.pid, c.aid, c.kind, c.pub,
             -- THE ONE PLACE THE TWO ORDERS DIFFER (202609220003). Both
             -- branches produce the same thing - a number the page is cut and
             -- sorted on, highest first, ties broken by published_at then id -
             -- so the keyset, the cursor and the caught-up marker below are
             -- one implementation serving both. CASE evaluates only the branch
             -- it takes, so the ranked arithmetic's four EXISTS subqueries do
             -- not run on a chronological page.
             case when v_chrono then
               case
                 -- Pinned first, because somebody decided so on purpose. Post
                 -- pins only: an announcement, challenge or event pin points
                 -- at a row in another table and renders in the pinned strip,
                 -- not as a feed card.
                 when exists (
                   select 1 from public.pins pn
                   where pn.target_type = 'post' and pn.target_id = c.pid) then v_tier_pinned
                 -- The coach's voice, in both of the shapes it takes - and
                 -- in both of them it is lifted FOR A WHILE, not forever.
                 -- Same two post types the 'coach' scope filters on and the
                 -- ranked order's v_coach_post arm names, so the three
                 -- cannot drift into three different ideas of what a coach
                 -- post is; what differs is when each stops being news.
                 --
                 -- A COACH POST: v_coach_top_hours from when it was
                 -- published. A club that posts twice a week would otherwise
                 -- accumulate a first page of coach cards until the 90-day
                 -- window dropped them, and "newest first" would stop being
                 -- what a member sees when they open the app.
                 when c.ptype = 'POST_COACH' then
                   case when c.pub > v_anchor - (v_coach_top_hours::double precision * interval '1 hour')
                        then v_tier_coach else v_tier_stream end
                 -- AN ANNOUNCEMENT: until it expires, and the club already
                 -- says when that is. announcements.expires_at is the date
                 -- staff typed into the announcement form, the same instant
                 -- announcements_read stops serving the row to a member, so
                 -- the feed and the announcements list now agree about when
                 -- an announcement stops being current instead of each
                 -- having an opinion. An announcement with no expiry, and a
                 -- card that names no announcement at all, fall back to the
                 -- same hours a coach post gets - "no expiry" means nobody
                 -- said when this stops mattering, not that it never does.
                 --
                 -- TODAY THAT FALLBACK IS EVERY CARD. The only producer of a
                 -- POST_ANNOUNCEMENT row in this schema is
                 -- member_of_week_publish() (202609010001), which writes no
                 -- announcement_id, and nothing turns a public.announcements
                 -- row into a feed card at all - there is no trigger and no
                 -- RPC that does it, whatever src/community/club.js's
                 -- "produced server-side from this row" comment says. The
                 -- expiry branch is therefore correct and unexercised in
                 -- production: it is here so that the day something does
                 -- post an announcement to the feed, writing the
                 -- announcement_id metadata key every other linked card
                 -- already writes is all that is needed.
                 when c.ptype = 'POST_ANNOUNCEMENT' then
                   case when coalesce(
                              (select an.expires_at from public.announcements an
                                where an.id = c.announcement_ref and an.deleted_at is null),
                              c.pub + (v_coach_top_hours::double precision * interval '1 hour')
                            ) > v_anchor
                        then v_tier_coach else v_tier_stream end
                 -- TODAY'S programming, and only today's. Read off
                 -- club_wod_sessions rather than the card's own metadata: the
                 -- session row is the fact, the metadata is a copy of it, and
                 -- a cancelled session has already had its post_id cleared
                 -- (202609080002) so it cannot match here. Yesterday's WOD
                 -- card is an ordinary post and falls to the stream, which is
                 -- exactly where a member looking for today's workout needs it
                 -- not to be.
                 when exists (
                   select 1 from public.club_wod_sessions cws
                   where cws.post_id = c.pid and cws.session_date = current_date) then v_tier_club_wod
                 else v_tier_stream
               end
             else
             round(
                 v_w_recency * power(0.5::numeric, c.age_hours / v_recency_half_life_hours)
               + v_w_relationship * coalesce(af.rel_value, 0)
               + v_w_coach * (case
                   when c.ptype in ('POST_COACH', 'POST_ANNOUNCEMENT') then v_coach_post
                   when coalesce(af.author_is_staff, false) then v_coach_author
                   else 0 end)
               + v_w_achievement * (case
                   when c.ptype in ('POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE')
                   then 1 else 0 end)
               + v_w_challenge * (case
                   when c.ptype in ('POST_CHALLENGE', 'POST_EVENT') then 1 else 0 end)
               + v_w_engagement * least(1.0,
                   (coalesce(cnt.comments, 0) * v_comment_weight + coalesce(cnt.reactions, 0)) / v_engagement_saturation)
               + v_w_personal * least(1.0,
                   (case when v_handle is not null and v_handle <> ''
                          and position(lower('@' || v_handle) in lower(coalesce(c.pbody, ''))) > 0
                         then v_pers_mention else 0 end)
                   + (case when exists (
                         select 1 from public.post_comments rc
                         join public.post_comments pc on pc.id = rc.parent_comment_id
                         where rc.post_id = c.pid and rc.deleted_at is null and pc.author_id = v_uid)
                       then v_pers_reply else 0 end)
                   + (case when exists (
                         select 1 from public.post_comments pc
                         where pc.post_id = c.pid and pc.author_id = v_uid and pc.deleted_at is null)
                       then v_pers_thread else 0 end)
                   + (case when exists (
                         select 1 from public.challenge_participants chp
                         where chp.user_id = v_uid and chp.challenge_id = c.challenge_ref)
                       or exists (
                         select 1 from public.event_attendees ea
                         where ea.user_id = v_uid and ea.event_id = c.event_ref)
                       then v_pers_participant else 0 end))
               -- COMM-302, closing COMM-P01. Shared training days over a
               -- saturation constant, capped at 1 - the engagement term's
               -- shape - so this reaches the same 0..1 ceiling every other
               -- component does before v_w_class applies. No shared days is
               -- 0, not a missing term.
               + v_w_class * least(1.0, coalesce(af.class_days, 0) / v_class_saturation)
               - least(rep.rep_index * v_repetition_step, v_repetition_max)
             , 6) end as total
      from cand c
      left join author_facts af on af.aid = c.aid
      -- LEFT join, where this was an inner join until 202609220003. In ranked
      -- order counted holds exactly one row per cand row, so left and inner
      -- return the same rows and the coalesce()s below the same numbers; the
      -- change is what allows counted to be empty in chronological order
      -- without the page losing every post.
      left join counted cnt on cnt.pid = c.pid
      join repeated rep on rep.pid = c.pid
    ) sc
    where v_cur_score is null
       or (sc.total, sc.pub, sc.pid) < (v_cur_score, v_cur_pub, v_cur_id)
    order by sc.total desc, sc.pub desc, sc.pid desc
    limit v_limit
  ) s;

  v_n := jsonb_array_length(v_page);
  if v_n = 0 then
    return;
  end if;

  -- --- diversity (COMM-112) ---------------------------------------------
  -- RANKED ONLY, since 202609220003. Diversity reorders a page: it moves a
  -- lower-scoring card above a higher-scoring one to break a run. That is
  -- exactly right for an order whose promise is relevance, and it is a
  -- contradiction in an order whose promise is "newest first" - a member
  -- watching a card they can see move is being told the dates are decoration.
  -- So the chronological page ships in the order the sort produced, runs and
  -- all, and the club that wants the runs broken switches the order back.
  select array_agg((e ->> 'id')::uuid order by ord),
         array_agg(nullif(e ->> 'a', '')::uuid order by ord),
         array_agg(e ->> 'k' order by ord),
         array_agg((e ->> 's')::numeric order by ord)
  into v_cand_id, v_cand_author, v_cand_kind, v_cand_score
  from jsonb_array_elements(v_page) with ordinality t(e, ord);

  if v_chrono then
    -- Already in (tier, published_at, id) order, which IS the order this page
    -- is promised in. The three out arrays are filled straight across so the
    -- cursor and the row query below are the same code on both paths.
    v_ids := v_cand_id;
    v_out_author := v_cand_author;
    v_out_kind := v_cand_kind;
    v_out_score := v_cand_score;
  else
    v_used := array_fill(false, array[v_n]);

    -- Seed the run counters from the tail of the previous page, so the limits
    -- hold across a page boundary and not only inside one page.
    begin
      for v_e in select value from jsonb_array_elements(v_tail) loop
        v_a := case when v_e ->> 'a' ~ '^[0-9a-fA-F]{8}-' then (v_e ->> 'a')::uuid else null end;
        v_k := coalesce(v_e ->> 'k', 'other');
        if v_a is not null and v_a = v_run_author then v_run_author_n := v_run_author_n + 1;
        else v_run_author := v_a; v_run_author_n := case when v_a is null then 0 else 1 end;
        end if;
        v_run_system_n := case when v_k = 'system' then v_run_system_n + 1 else 0 end;
        v_run_workout_n := case when v_k = 'workout' then v_run_workout_n + 1 else 0 end;
      end loop;
    exception when others then
      v_run_author := null; v_run_author_n := 0; v_run_system_n := 0; v_run_workout_n := 0;
    end;

    for v_slot in 1 .. v_n loop
      v_pick := null;
      -- After a workout run, prefer an achievement, coach, challenge or event
      -- card. A preference, not a rule: it applies only while the page still
      -- holds one.
      v_prefer := v_run_workout_n >= v_prefer_after_workouts;

      if v_prefer then
        for v_i in 1 .. v_n loop
          if not v_used[v_i] and v_cand_kind[v_i] = 'boost'
             and not (v_cand_author[v_i] is not null and v_cand_author[v_i] = v_run_author
                      and v_run_author_n >= v_max_same_author)
          then v_pick := v_i; exit; end if;
        end loop;
      end if;

      if v_pick is null then
        for v_i in 1 .. v_n loop
          if not v_used[v_i]
             and not (v_cand_author[v_i] is not null and v_cand_author[v_i] = v_run_author
                      and v_run_author_n >= v_max_same_author)
             and not (v_cand_kind[v_i] = 'system' and v_run_system_n >= v_max_system_run)
             and not (v_cand_kind[v_i] = 'workout' and v_run_workout_n >= v_max_workout_run)
          then v_pick := v_i; exit; end if;
        end loop;
      end if;

      -- COMM-112 validation rule: when the candidate set cannot satisfy a
      -- limit, relax that limit rather than return a shorter page.
      if v_pick is null then
        for v_i in 1 .. v_n loop
          if not v_used[v_i] then v_pick := v_i; exit; end if;
        end loop;
      end if;

      v_used[v_pick] := true;
      v_ids := v_ids || v_cand_id[v_pick];
      v_out_author := v_out_author || v_cand_author[v_pick];
      v_out_kind := v_out_kind || v_cand_kind[v_pick];
      v_out_score := v_out_score || v_cand_score[v_pick];

      if v_cand_author[v_pick] is not null and v_cand_author[v_pick] = v_run_author then
        v_run_author_n := v_run_author_n + 1;
      else
        v_run_author := v_cand_author[v_pick];
        v_run_author_n := case when v_cand_author[v_pick] is null then 0 else 1 end;
      end if;
      v_run_system_n := case when v_cand_kind[v_pick] = 'system' then v_run_system_n + 1 else 0 end;
      v_run_workout_n := case when v_cand_kind[v_pick] = 'workout' then v_run_workout_n + 1 else 0 end;
    end loop;

  end if;

  -- --- next cursor -------------------------------------------------------
  -- A short page is the end of the feed, so it carries no cursor and the
  -- client shows the caught-up marker instead of a load-more control. The
  -- boundary row is the last one in SCORE order, which is v_page's last
  -- element, not the last one on screen after the diversity reorder.
  if v_n >= v_limit then
    v_last := v_page -> (v_n - 1);
    for v_i in greatest(1, v_n - 2) .. v_n loop
      v_tail_out := v_tail_out || jsonb_build_array(
        jsonb_build_object('a', v_out_author[v_i], 'k', v_out_kind[v_i]));
    end loop;
    v_next := translate(encode(convert_to(
      jsonb_build_object(
        'a', v_anchor,
        's', (v_last ->> 's')::numeric,
        't', (v_last ->> 't')::timestamptz,
        'i', v_last ->> 'id',
        'p', v_tail_out
      )::text, 'utf8'), 'base64'), E'\n', '');
  end if;

  -- --- the rows ----------------------------------------------------------
  return query
  select p.id,
         p.post_type,
         p.author_id,
         case when p.author_id is null then null
              else jsonb_build_object(
                     'display_name', pr.display_name,
                     'handle', pr.handle,
                     'avatar_url', pr.avatar_url) end,
         p.body,
         p.title,
         -- COMM-018. show_workout_results off means the result is stripped
         -- from the row, NOT that the post disappears: the member still
         -- posted, the number is just not this viewer's to read.
         case when priv.hide_result then null else p.result_text end,
         p.occurred_on,
         p.visibility,
         p.created_at,
         p.published_at,
         case when priv.hide_result
              then p.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'
              else p.metadata end,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'storage_path', m.storage_path,
                     'alt_text', m.alt_text,
                     'position', m."position",
                     'width', m.width,
                     'height', m.height) order by m."position")
            from public.post_media m where m.post_id = p.id),
           case when p.photo_path is not null
                then jsonb_build_array(jsonb_build_object('storage_path', p.photo_path, 'position', 0))
                else '[]'::jsonb end),
         (select count(*)::integer from public.reactions r where r.post_id = p.id),
         (select count(*)::integer from public.post_comments pc
          where pc.post_id = p.id and pc.deleted_at is null and pc.status = 'active'),
         v_out_score[o.ord],
         v_next
  from unnest(v_ids) with ordinality o(pid, ord)
  join public.workout_posts p on p.id = o.pid
  left join public.profiles pr on pr.id = p.author_id
  cross join lateral (
    select (p.author_id is not null
            and p.post_type in ('POST_WORKOUT', 'POST_PR')
            and not public.can_view_profile_field(p.author_id, 'show_workout_results')) as hide_result
  ) priv
  order by o.ord;
end $function$;

-- ---------------------------------------------------------------------------
-- post_create
-- ---------------------------------------------------------------------------
create or replace function public.post_create(
  body text,
  visibility public.post_visibility,
  media jsonb,
  links jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
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
  if not public.club_feature_enabled('feed') then raise exception 'feed disabled'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  -- COMM-153 enforcement, before the rate limit so a restricted member burns
  -- no budget and gets the accurate reason.
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
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

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;

      -- Security hunt round 7: a "position" outside smallint range or a
      -- non-numeric "width"/"height" used to reach the column cast
      -- directly and raise a raw Postgres error. Validate the shape first
      -- and fall back to this item's own index / null, the same way a
      -- missing key already did, instead of letting the type mismatch
      -- surface as an unhandled exception.
      v_pos_text := v_item ->> 'position';
      if v_pos_text is not null and v_pos_text ~ '^-?[0-9]{1,9}$'
         and v_pos_text::bigint between -32768 and 32767 then
        v_pos := v_pos_text::smallint;
      else
        v_pos := v_idx::smallint;
      end if;

      v_width_text := nullif(v_item ->> 'width', '');
      if v_width_text is not null and v_width_text !~ '^[0-9]{1,9}$' then
        v_width_text := null;
      end if;

      v_height_text := nullif(v_item ->> 'height', '');
      if v_height_text is not null and v_height_text !~ '^[0-9]{1,9}$' then
        v_height_text := null;
      end if;

      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        v_pos,
        v_width_text::integer,
        v_height_text::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  perform public.idem_complete('post_create', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;

-- ---------------------------------------------------------------------------
-- event_rsvp
-- ---------------------------------------------------------------------------
create or replace function public.event_rsvp(
  p_event_id uuid,
  p_response text,
  p_idempotency_key uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_replay boolean;
  v_prior jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('event_rsvp', p_idempotency_key) i;
  if v_replay then return; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- 202609230001.
  if not public.club_feature_enabled('events') then raise exception 'events disabled'; end if;
  if p_response not in ('going', 'interested', 'not_going') then
    raise exception 'unknown rsvp response %', p_response;
  end if;
  if not exists (select 1 from public.events e where e.id = p_event_id and e.status = 'published') then
    raise exception 'event not open for rsvp';
  end if;
  insert into public.event_attendees (event_id, user_id, response)
  values (p_event_id, v_uid, p_response)
  on conflict (event_id, user_id) do update set response = excluded.response, registered_at = now();

  perform public.idem_complete('event_rsvp', p_idempotency_key, to_jsonb(p_response));
end $$;

-- ---------------------------------------------------------------------------
-- chal_progress
-- ---------------------------------------------------------------------------
create or replace function public.chal_progress(challenge_id uuid) returns public.challenge_progress_view
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_challenge public.challenges;
  v_result public.challenge_progress_view;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- "club member" here is deliberately looser than is_community_member():
  -- this is a read, and the Phase 0/1 rule is that read paths are not
  -- gated behind the recovery-verification write gate. my_role_code()
  -- already folds together a live invite_redemptions row and the legacy
  -- profiles.is_admin flag, so it is the one existing "has a real seat in
  -- this club" predicate.
  if public.my_role_code() is null then raise exception 'not authorized'; end if;
  -- 202609230001. challenges_read carries this switch; this definer read
  -- bypasses that policy, so it carries it too.
  if not public.club_feature_enabled('challenges') then raise exception 'challenges disabled'; end if;

  select * into v_challenge from public.challenges c where c.id = chal_progress.challenge_id;
  if not found then raise exception 'challenge not found'; end if;
  -- Same visibility as challenges_read: a draft is invisible to everyone
  -- but its creator and a challenge manager.
  if v_challenge.status = 'draft'
     and v_challenge.created_by is distinct from v_uid
     and not public.has_perm('community.challenge.create') then
    raise exception 'challenge not found';
  end if;

  v_result.challenge_id := v_challenge.id;
  v_result.challenge_type := v_challenge.challenge_type;
  v_result.title := v_challenge.title;
  v_result.ends_at := v_challenge.end_at;
  v_result.target_value := v_challenge.target_value;

  select cp.progress_value, cp.status into v_result.my_progress, v_result.my_status
  from public.challenge_participants cp
  where cp.challenge_id = v_challenge.id and cp.user_id = v_uid;

  select count(*) into v_result.participant_count
  from public.challenge_participants cp
  where cp.challenge_id = v_challenge.id and cp.status <> 'withdrawn';

  if v_challenge.challenge_type = 'cooperative' then
    select coalesce(sum(p.delta), 0) into v_result.club_total
    from public.challenge_progress p
    where p.challenge_id = v_challenge.id;
  end if;

  if v_challenge.challenge_type = 'team' then
    -- Summed from challenge_progress.team_id (snapshotted at insert time),
    -- not from challenge_participants.team_id, so a departed member's
    -- earlier contributions stay in their team's total. See the column
    -- comment above.
    select coalesce(jsonb_agg(
             jsonb_build_object('team_id', t.id, 'name', t.name, 'total', coalesce(tt.total, 0))
             order by t.name
           ), '[]'::jsonb)
    into v_result.team_totals
    from public.challenge_teams t
    left join (
      select p.team_id, sum(p.delta) as total
      from public.challenge_progress p
      where p.challenge_id = v_challenge.id and p.team_id is not null
      group by p.team_id
    ) tt on tt.team_id = t.id
    where t.challenge_id = v_challenge.id;
  end if;

  if v_challenge.challenge_type in ('individual_performance', 'coach') then
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'user_id', ranked.user_id,
               'name', coalesce(pr.display_name, pr.handle),
               'handle', pr.handle,
               'avatar_url', pr.avatar_url,
               'value', ranked.progress_value
             ) order by ranked.progress_value desc
           ), '[]'::jsonb)
    into v_result.leaderboard
    from (
      select cp.user_id, cp.progress_value
      from public.challenge_participants cp
      where cp.challenge_id = v_challenge.id
        and cp.status <> 'withdrawn'
        and public.can_view_profile_field(cp.user_id, 'in_leaderboards')
        and not public.notif_blocked_between(v_uid, cp.user_id)
      order by cp.progress_value desc
      limit 20
    ) ranked
    join public.profiles pr on pr.id = ranked.user_id;
  end if;

  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- ach_claim
-- ---------------------------------------------------------------------------
create or replace function public.ach_claim(p_codes text[]) returns setof public.ach_claim_row
language plpgsql security definer set search_path = '' as $$
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
  if not public.club_feature_enabled('achievements') then raise exception 'achievements disabled'; end if;

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
end $$;

-- ---------------------------------------------------------------------------
-- community_streaks
-- ---------------------------------------------------------------------------
create or replace function public.community_streaks(p_limit int default 50)
returns table (
  user_id uuid,
  handle text,
  display_name text,
  current_streak integer,
  last_activity_on date
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  -- 202609230001. A ranked list of the club, so it answers to the same
  -- switch as feed_leaderboard, with the same message.
  if not public.club_feature_enabled('leaderboards') then raise exception 'leaderboards disabled'; end if;
  return query
  with islands as (
    select ap.user_id, ap.activity_date,
           (ap.activity_date - (row_number() over (partition by ap.user_id order by ap.activity_date))::integer * interval '1 day')::date as grp
    from public.activity_pings ap
  ),
  runs as (
    select i.user_id, i.grp, count(*)::integer as run_length, max(i.activity_date) as run_end
    from islands i
    group by i.user_id, i.grp
  ),
  latest_run as (
    select distinct on (r.user_id) r.user_id, r.run_length, r.run_end
    from runs r
    order by r.user_id, r.run_end desc
  )
  select pr.id as user_id, pr.handle, pr.display_name,
         case when lr.run_end >= current_date - 1 then coalesce(lr.run_length, 0) else 0 end as current_streak,
         case
           when pr.id = auth.uid() or public.can_view_profile_field(pr.id, 'show_attendance')
             then lr.run_end
           else null
         end as last_activity_on
  from public.profiles pr
  left join latest_run lr on lr.user_id = pr.id
  where pr.deleted_at is null
    and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = pr.id) or (b.blocker_id = pr.id and b.blocked_id = auth.uid()))
    and (
      pr.id = auth.uid()
      or (
        public.is_community_member()
        and pr.visible_to_club
        and pr.in_leaderboards
        and public.can_view_profile_field(pr.id, 'visible_to_club')
        and public.can_view_profile_field(pr.id, 'in_leaderboards')
      )
    )
  order by current_streak desc
  limit v_limit;
end $$;

-- ---------------------------------------------------------------------------
-- notif_announcement_fanout
-- ---------------------------------------------------------------------------
create or replace function public.notif_announcement_fanout(p_id uuid, p_off_only boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.announcements;
  v_member uuid;
begin
  select * into v_row from public.announcements where id = p_id;
  if not found or v_row.deleted_at is not null then return; end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then return; end if;
  -- 202609230001. The announcements module off sends nothing, on the
  -- insert pass and on an escalation alike.
  if not public.club_feature_enabled('announcements') then return; end if;

  for v_member in
    select p.id
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_row.author_id
      and exists (select 1 from public.invite_redemptions ir where ir.user_id = p.id)
      and not exists (
        select 1 from public.notifications n
        where n.user_id = p.id and n.type = 'announcement' and n.source_id = v_row.id
      )
      and (
        not p_off_only
        or exists (
          select 1 from public.notification_preferences np
          where np.user_id = p.id and np.type = 'announcements' and np.channel = 'off'
        )
      )
  loop
    perform public.notif_create(
      v_member, 'announcement', 'club',
      v_row.title, v_row.body,
      'announcement', v_row.id,
      '/community/feed?announcement=' || v_row.id::text
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- announcements: the insert refuses while the module is off
-- ---------------------------------------------------------------------------
create or replace function public.announcements_module_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.club_feature_enabled('announcements') then
    raise exception 'announcements disabled';
  end if;
  return new;
end $$;
revoke all on function public.announcements_module_gate() from public, anon, authenticated;
comment on function public.announcements_module_gate() is
  'BEFORE INSERT on announcements (202609230001). Raises ''announcements disabled'' (P0001) when a session (auth.uid() set) inserts while club_feature_enabled(''announcements'') is false. announcements_insert_admin still decides WHO may publish; this decides only WHETHER the module is on. A session-less insert passes, and is silent anyway: announcement_feed_card_insert and notif_announcement_fanout both return early while the module is off.';

drop trigger if exists announcements_module_gate on public.announcements;
create trigger announcements_module_gate before insert on public.announcements
  for each row execute function public.announcements_module_gate();

-- Two comments re-stamped so their AUTH sentence names the new gate.
comment on function public.feed_page(text, integer, text) is
  'One page of the club feed, in whichever order club_features.config -> feed -> order names: chronological (the default) or ranked. CHRONOLOGICAL sorts on a tier and then on published_at descending, id descending, with no arithmetic - pinned posts, then coach posts and club announcements that are still current, then today''s club WOD (by its club_wod_sessions row, so a cancelled session cannot qualify), then everything else newest first - and it does NOT run the COMM-112 diversity pass, because a card that moves is the opposite of what a dated order promises. RANKED is unchanged from 202608280019/202608310006: eight weighted components, per-member weights through feed_weights_resolve(), the repetition penalty and the diversity pass. THE TWO ORDERS SHARE ONE CANDIDATE QUERY, so what a member may see is identical in both: deleted and non-active posts, hidden_posts, the caller''s own reports, block edges in either direction, post_visible_to_viewer() and the COMM-111 scopes. Both are cut on the same (ordering value, published_at, id) keyset with the same opaque cursor and the same frozen anchor, inside the same 90-day window and 600-row candidate cap. feed_score carries the tier rather than a score on a chronological page. HOW LONG THE COACH TIER LASTS: a coach post for club_features.config -> feed -> coach_top_hours (default 72, clamped [1, 336] by club_feature_number) from publication; an announcement until announcements.expires_at, resolved through the card''s metadata announcement_id and NOT through source_id, or the same hours from publication when it names no announcement or that announcement has no expiry. AUTH unchanged: auth.uid() (''not authorized'') then is_community_member() (''recovery method required''), then club_feature_enabled(''feed'') (''feed disabled'', 202609230001).';
comment on function public.community_streaks(int) is
  'Supabase Security Advisor remediation, security_definer_view finding on the view of the same name (202608270001/202609060002). Function form of the identical query: club activity streaks aggregated over activity_pings (days the member opened the app), one row per member, ordered by current_streak desc, capped at p_limit (clamped 1-100, default 50, matching feed_leaderboard''s own ceiling pattern). SECURITY DEFINER because activity_pings is owner-only RLS (activity_pings_self_select) and this has to aggregate across every member''s rows to compute a streak - every equivalent access check is re-applied by hand: deleted_at, both directions of blocks, is_community_member(), the subject''s visible_to_club/in_leaderboards (raw column AND can_view_profile_field so an admin''s own rank cannot decide what the club is told), and last_activity_on gated additionally on show_attendance (null unless the caller is the subject, an admin, or the subject opted in) - self always sees their own row and date regardless. CONTRACT phase complete (202609150001): the view public.community_streaks has been dropped, cloud.js reads this function via .rpc("community_streaks"), and this function is now the only way to read a streak. Do not re-create the view - the Advisor finding is on the view, and it only stays closed while the view stays gone. Raises ''leaderboards disabled'' (P0001) while club_feature_enabled(''leaderboards'') is false (202609230001), the same switch and message as feed_leaderboard.';

commit;
