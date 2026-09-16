-- New-member feed posts are a choice, and not one the club made (2026-09-16).
--
-- REPORTED, looking at the live feed: "there is no need for welcome on feed for
-- every member". The feed's first two cards were both "שמחים שהגעת למועדון" -
-- one of them for ניהול, the MANAGEMENT account, which is not a member joining
-- a club at all (202609150010: management is not a membership).
--
-- TWO FAULTS, and the second is the one worth remembering.
--
-- 1. A coach, head coach or admin redeeming their invite produced a "please
--    welcome our new member" card, exactly as 202609160003 found for the coach
--    dashboard's welcome queue. Same wrong assumption - that every redemption
--    is a newcomer - in a second place, found the same day. Sibling drift,
--    again, and this time the sibling was a trigger rather than a query.
--
-- 2. THE TOGGLE FOR THIS ALREADY EXISTED AND DID NOT WORK. `welcome_flow` is
--    registered clientOnly, so switching it off hid one client-side section
--    while this trigger went on writing the posts into everyone's feed. A
--    switch that quietly governs less than its label claims is worse than no
--    switch: the owner turns it off, still sees the posts, and now distrusts
--    every other switch on the panel. Per the standing instruction that every
--    function has a real toggle in the admin panel, this one is enforced where
--    the writing happens.
--
-- `new_member_posts` is its own key rather than a second meaning for
-- welcome_flow, because they are different questions: welcome_flow is the
-- COACH's tool for greeting newcomers personally, which is useful and stays
-- on; this is an automatic card in front of the whole club, which the owner
-- does not want. Folding them together would mean turning off one to silence
-- the other.
--
-- Default OFF for this club, because that is the state that was asked for.
-- club_feature_enabled() defaults to TRUE for an unknown key, so the row has to
-- exist for "off" to mean anything.

insert into public.club_features (club_id, module_key, enabled)
select public.default_club_id(), 'new_member_posts', false
on conflict (club_id, module_key) do update set enabled = false;

create or replace function public.post_new_member_on_join() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  -- The switch, honoured where the row is actually written rather than where
  -- it is merely displayed. Checked FIRST so a club with this off pays nothing
  -- for it - no profile lookup, no duplicate scan.
  if not public.club_feature_enabled('new_member_posts') then
    return new;
  end if;

  -- Staff are not newcomers to welcome. A coach redeeming a coach invite, or
  -- the management account redeeming anything, is a colleague arriving - and
  -- the club does not need a card inviting it to congratulate them on joining.
  -- role_rank is the same ranking is_staff() uses: member 10, coach 20 and up.
  if coalesce(public.role_rank(new.role), 10) >= 20 then
    return new;
  end if;

  -- May find nothing: the profile usually does not exist yet. That is a
  -- normal outcome, not an error, and must not stop the post.
  select coalesce(nullif(btrim(p.display_name), ''), p.handle)
    into v_name
    from public.profiles p
   where p.id = new.user_id and p.deleted_at is null;

  -- One welcome post per member, ever. Deliberately a guard rather than a
  -- unique index: a unique violation here would abort the enclosing redemption
  -- and block a real person from joining the club over a duplicate feed post,
  -- which is far worse than the duplicate. Unchanged from the original.
  if exists (
    select 1 from public.workout_posts
    where post_type = 'POST_NEW_MEMBER'
      and (metadata ->> 'member_id') = new.user_id::text
  ) then
    return new;
  end if;

  insert into public.workout_posts
    (author_id, post_type, visibility, body, metadata, status, published_at, club_id,
     source_type, source_id, occurred_on)
  values (
    null, 'POST_NEW_MEMBER', 'club',
    coalesce(v_name, 'חבר/ה חדש/ה') || ' הצטרפ/ה למועדון',
    jsonb_build_object(
      'member_id', new.user_id,
      'joined_on', new.redeemed_at
    ) || case
           when v_name is null then '{}'::jsonb
           else jsonb_build_object('member_name', v_name)
         end,
    'active', new.redeemed_at, public.default_club_id(),
    'member', new.user_id, new.redeemed_at::date
  );

  return new;
end $$;
revoke all on function public.post_new_member_on_join() from public, anon, authenticated;
comment on function public.post_new_member_on_join() is
  'AFTER INSERT ON public.invite_redemptions (202609160004). Writes one POST_NEW_MEMBER card per member, ever - but only when the club_features module ''new_member_posts'' is on (default OFF, and enforced HERE rather than in the client, unlike the clientOnly welcome_flow key it used to be conflated with), and never for a redemption whose role_rank clears 20: staff are colleagues arriving, not newcomers to welcome.';

-- The two cards already on the feed. Soft-removed rather than deleted: this is
-- the same 'removed' status moderation uses, so the rows stay auditable and a
-- club that turns the module back on has not lost its history. They are exactly
-- what the report was about, so leaving them would make the fix look broken.
update public.workout_posts
   set status = 'removed'
 where post_type = 'POST_NEW_MEMBER'
   and status = 'active';
