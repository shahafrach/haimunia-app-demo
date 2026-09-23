-- An announcement becomes its own feed card.
--
-- THE GAP. 202609220003 taught the chronological feed to hold a
-- POST_ANNOUNCEMENT card in the coach tier until announcements.expires_at,
-- resolved through the card's metadata announcement_id. It also said, in its
-- own header and on the tier itself, that the branch was unexercised: nothing
-- in this schema turned a public.announcements row into a feed card at all.
-- There was no trigger and no RPC, whatever src/community/club.js's
-- "produced server-side from this row" comment claimed, and the only
-- producer of a POST_ANNOUNCEMENT row was member_of_week_publish(), which has
-- no announcements row to name. So an announcement a coach published reached
-- the archive and the notification centre and never the feed.
--
-- WHAT THIS DOES. One AFTER INSERT trigger on public.announcements writes the
-- card, in the same transaction as the announcement:
--   post_type     POST_ANNOUNCEMENT
--   metadata      {title, announcement_id, priority} - announcement_id is the
--                 key 202609220003's announcement_ref reads, which is the
--                 whole point: the feed's expiry rule now has something to
--                 resolve. title is what renderAnnouncementPostCard reads
--                 first, the same key member_of_week_publish() writes.
--   source_type   'announcement', source_id = the announcement's id. Here
--                 source_id genuinely IS the announcement, unlike the member
--                 of the week card; the feed still resolves through metadata
--                 only, deliberately, and that does not change.
--   published_at  the announcement's created_at, so the card is dated when
--                 the announcement was, not when some later step noticed it.
--   body          left(body, 1000). The card renders through postBodyHtml(),
--                 capped at POST_BODY_MAX (1000); the composer already caps
--                 input there (club.js postAnnouncement), and this is the
--                 same cap member_of_week_publish() applies, for a row
--                 written by some other path.
--
-- VISIBILITY IS NOT WIDENED, and every rule a member already meets still
-- decides what they see:
--   * The write gate is unchanged. announcements_insert_admin (is_staff())
--     still decides who can publish; this trigger only ever runs after an
--     insert that policy already let through, and adds no policy, no grant
--     and no RPC anybody can call.
--   * The card is visibility 'club' and goes through posts_feed_select /
--     post_visible_to_viewer() and feed_page()'s whole candidate query like
--     every other card: deleted, removed, hidden and reported posts stay out,
--     and it requires a community member exactly as announcements_read does.
--   * AUTHORLESS (author_id null), the shape every other club-voice card in
--     this schema has (member_of_week_publish, post_new_member_on_join). Two
--     reasons. The announcement is the CLUB speaking, which is what the card
--     renders ("הודעת מועדון", the 📣 mark). And announcements_read has no
--     block clause: a member who has blocked a coach still reads that coach's
--     announcements in the archive, because a notice about the club is not
--     that coach's content. Attributing the card to the coach would have made
--     the feed hide from that member a notice the archive shows them - a new
--     visibility rule, introduced by accident.
--   * Nothing is written while the announcements module is off. A card is not
--     minted for a notice announcements_read would refuse to serve.
--   * Nothing is written for an announcement already expired when it is
--     inserted (a backdated row, or a correction typed after the fact): it
--     is not readable by a member, and a card for it would be the one way to
--     read it.
--
-- THE CARD FOLLOWS ITS ANNOUNCEMENT. An AFTER UPDATE OR DELETE trigger keeps the two in
-- step for the edits that change what a member reads:
--   * withdrawn: the announcement's deleted_at set, or the row deleted
--     outright, soft-deletes the card. Without it a notice that had been
--     withdrawn would have stayed readable in the feed for ninety days.
--     Today both happen only outside a member session - announcements_read
--     requires deleted_at is null, and Postgres applies that SELECT policy to
--     an UPDATE's new row, so no authenticated session can soft-delete one
--     (0079 pins it), and authenticated holds no DELETE grant. The card
--     follows whichever path does it.
--   * title, body, priority: copied onto the card.
-- expires_at needs no copy. feed_page() reads it live off public.announcements
-- through the announcement_id key on every page, which is why the key exists.
--
-- AFTER EXPIRY, the card leaves the coach tier and falls to the stream, where
-- it stays as a dated post - exactly the rule 202609220003 defined and 0120
-- pins ("one whose expires_at has passed is in the stream, and no number of
-- hours brings it back"). This migration applies that rule; it does not
-- change it.
--
-- THE TWO GUARDS THIS WRITES THROUGH, and why each pin is taken:
--   * workout_posts_guard_insert_rate_limit (202609060012) charges an
--     authenticated insert one post_create token. The insert here is the
--     announcement's, already a staff action through its own policy, and is
--     not a second post by the coach - so it takes
--     app.allow_unrated_post_insert, the pin post_create() takes for the same
--     reason, around the one INSERT.
--   * workout_posts_guard_moderated_fields refuses an authenticated change to
--     deleted_at. The withdraw path takes app.allow_moderation_write, the pin
--     post_delete() takes, around the one UPDATE. No authenticated withdraw
--     exists today (above), so on today's paths the guard has already
--     stepped aside for a non-authenticated role; the pin is what keeps a
--     future staff RPC that withdraws an announcement from silently leaving
--     its card behind.
-- Both are transaction-local and both are restored to what they were, so a
-- pin the caller already held is not dropped by this trigger.
--
-- ONE CARD PER ANNOUNCEMENT, as an index rather than as a hope: a partial
-- unique index on the metadata key, for POST_ANNOUNCEMENT only. No existing
-- row carries the key (202609220003 said so, and this is the first producer),
-- so it builds on a live table without a conflict.
--
-- NO BACKFILL. Announcements written before this migration keep having no
-- card. Minting cards for them now would drop weeks of old notices into the
-- feed at once, and the ones still current are already on the member's club
-- home and in the archive. Deliberate, and stated so it is not mistaken for
-- an oversight.

begin;

create unique index if not exists workout_posts_announcement_card_idx
  on public.workout_posts ((metadata ->> 'announcement_id'))
  where post_type = 'POST_ANNOUNCEMENT' and metadata ? 'announcement_id';

create or replace function public.announcement_feed_card_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prev text;
begin
  if new.deleted_at is not null then return new; end if;
  if not public.club_feature_enabled('announcements') then return new; end if;
  if new.expires_at is not null and new.expires_at <= now() then return new; end if;

  v_prev := coalesce(current_setting('app.allow_unrated_post_insert', true), '');
  perform pg_catalog.set_config('app.allow_unrated_post_insert', 'on', true);

  insert into public.workout_posts
    (author_id, post_type, visibility, title, body, metadata, status,
     published_at, source_type, source_id, occurred_on)
  values (
    null, 'POST_ANNOUNCEMENT', 'club',
    new.title,
    left(new.body, 1000),
    jsonb_build_object(
      'title',           new.title,
      'announcement_id', new.id,
      'priority',        new.priority
    ),
    'active', new.created_at,
    'announcement', new.id, (new.created_at)::date
  )
  on conflict ((metadata ->> 'announcement_id'))
    where post_type = 'POST_ANNOUNCEMENT' and metadata ? 'announcement_id'
    do nothing;

  perform pg_catalog.set_config('app.allow_unrated_post_insert', v_prev, true);
  return new;
end $$;
revoke all on function public.announcement_feed_card_insert() from public, anon, authenticated;

drop trigger if exists announcements_feed_card_insert on public.announcements;
create trigger announcements_feed_card_insert
  after insert on public.announcements
  for each row execute function public.announcement_feed_card_insert();

comment on function public.announcement_feed_card_insert() is
  '202609220008. AFTER INSERT on announcements. Writes the announcement''s own POST_ANNOUNCEMENT feed card: authorless, visibility club, published_at = the announcement''s created_at, body capped at 1000, metadata {title, announcement_id, priority}. announcement_id is what feed_page()''s chronological order resolves announcements.expires_at through, so the coach tier holds the card until the announcement expires. Writes nothing when the announcement is already deleted or already expired, or while the announcements module is off. One card per announcement (workout_posts_announcement_card_idx). Takes app.allow_unrated_post_insert around its one INSERT and restores the previous value, so publishing an announcement does not also spend a post_create rate-limit token.';

create or replace function public.announcement_feed_card_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prev text;
  v_key text := old.id::text;
begin
  if tg_op = 'DELETE' or (new.deleted_at is not null and old.deleted_at is null) then
    v_prev := coalesce(current_setting('app.allow_moderation_write', true), '');
    perform pg_catalog.set_config('app.allow_moderation_write', 'on', true);
    update public.workout_posts
       set deleted_at = now()
     where post_type = 'POST_ANNOUNCEMENT'
       and metadata ->> 'announcement_id' = v_key
       and deleted_at is null;
    perform pg_catalog.set_config('app.allow_moderation_write', v_prev, true);
    return null;
  end if;

  if new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.priority is distinct from old.priority then
    update public.workout_posts
       set title = new.title,
           body = left(new.body, 1000),
           metadata = metadata || jsonb_build_object('title', new.title, 'priority', new.priority)
     where post_type = 'POST_ANNOUNCEMENT'
       and metadata ->> 'announcement_id' = v_key
       and deleted_at is null;
  end if;
  return null;
end $$;
revoke all on function public.announcement_feed_card_sync() from public, anon, authenticated;

drop trigger if exists announcements_feed_card_sync on public.announcements;
create trigger announcements_feed_card_sync
  after update of title, body, priority, deleted_at or delete on public.announcements
  for each row execute function public.announcement_feed_card_sync();

comment on function public.announcement_feed_card_sync() is
  '202609220008. AFTER UPDATE OF title, body, priority, deleted_at OR DELETE on announcements. Keeps the announcement''s feed card in step: a soft-delete or a hard delete soft-deletes the card (under app.allow_moderation_write, restored afterwards), and a title, body or priority edit is copied onto it. expires_at is not copied - feed_page() reads it live through metadata announcement_id.';

commit;
