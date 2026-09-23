-- מסך תצוגה במועדון — a screen on the wall of the training room.
--
-- WHAT IT IS. A television in a room anyone can walk through, showing today's
-- club WOD and who has posted a result. It is the last of 202609190002's seven
-- pre-seeded switches to stop saying בפיתוח.
--
-- THE HARD PART IS NOT THE SCREEN, IT IS WHO IT SIGNS IN AS. Three options
-- were on the table and the owner chose the third:
--
--   a member account left signed in       rejected. That device can read the
--                                         whole feed, post as that member, and
--                                         hold an unsupervised session in a
--                                         public room.
--   a shared display token                rejected. A bearer string taped to a
--                                         TV is a credential with no owner and
--                                         no revocation story.
--   a dedicated read-only role            chosen. The display is its own kind
--                                         of account, and the database decides
--                                         what that kind may see.
--
-- WHY THE DISPLAY ACCOUNT IS SAFE BY CONSTRUCTION, and not by a list of
-- policies someone has to keep complete. `is_community_member()` requires BOTH
-- a completed recovery method and an invite redemption. A display account is
-- created with `recovery_verified_at` null, so `is_community_member()` is
-- false for it, and every community read and write in this schema already
-- refuses a caller that fails that check. The display therefore starts with
-- access to NOTHING and is handed exactly one function below. Nothing had to
-- be taken away from it, which is the only kind of restriction that stays true
-- as the app grows.
--
-- WHAT IT MAY SEE, exactly: today's club WOD, and the results attached to
-- today's session for members whose `in_leaderboards` toggle is on. Names are
-- masked to a first name and a surname initial before they leave the database
-- — not in the client, because a screen in a public room is precisely where an
-- unmasked name would end up being read by someone who is not a member.

-- =====================================================================
-- 1. The role
-- =====================================================================
-- Rank 5, BELOW member (10). Every `role_rank(...) >= n` test in this schema
-- is a "has at least this much authority" test, so a display must sort under
-- the least-privileged human. Nothing grants on rank 5; the role exists to be
-- recognised, not to open doors.
insert into public.roles (code, label, rank)
values ('gym_display', 'מסך תצוגה', 5)
on conflict (code) do nothing;

create or replace function public.is_gym_display()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role_code() = 'gym_display', false);
$$;
revoke all on function public.is_gym_display() from public, anon;
grant execute on function public.is_gym_display() to authenticated;
comment on function public.is_gym_display() is
  'True when the caller is a gym display account (202609230005). Says nothing about what it may see - gym_display_board() is the only thing it can call.';

-- =====================================================================
-- 2. A display is not a clubmate
-- =====================================================================
-- ADDITIVE to 202609220007, not a rewrite of it. That migration's two clauses
-- are the owner's own rule and are left exactly as written: hide an account
-- with no invite_redemptions row at all, or one carrying profiles.is_admin
-- with no club role behind it. This adds a third clause for a role that did
-- not exist when that rule was stated.
--
-- Without it the television appears in the member directory, in search, and in
-- people-you-may-know, because it holds a redemption row and is not is_admin -
-- so 202609220007's predicate correctly calls it a clubmate. It is not one. It
-- is furniture.
create or replace function public.is_management_account(p_uid uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select
       -- 1. never joined the club at all (202609220007)
       not exists (
         select 1 from public.invite_redemptions ir where ir.user_id = p.id
       )
       -- 2. the legacy admin flag, with no club role behind it (202609220007)
       or (
         p.is_admin
         and not exists (
           select 1 from public.invite_redemptions ir
           where ir.user_id = p.id
             and ir.role in ('member', 'coach', 'head_coach', 'owner')
         )
       )
       -- 3. a gym display (202609230005). Not a person, so not a clubmate:
       --    it must not appear in the directory, in search, or in
       --    people-you-may-know.
       or exists (
         select 1 from public.invite_redemptions ir
         where ir.user_id = p.id and ir.role = 'gym_display'
       )
     from public.profiles p
     where p.id = p_uid
       and p.deleted_at is null
    ), false);
$$;

comment on function public.is_management_account(uuid) is
  'True for an account members must not be shown: one with no invite_redemptions row at all, one carrying profiles.is_admin with no club role (member, coach, head_coach, owner) redeemed, or a gym display (202609230005). Coaches, head coaches and owners are clubmates and stay visible. Says nothing about who is asking - hide_management_from_member() is the rule; this is its subject.';

-- Masking happens in the database, not the client. A screen in a room anyone
-- walks through is exactly where a full name would be read by someone who is
-- not a member, and "the client only renders the initial" is a promise the
-- network tab disproves.
create or replace function public.gym_display_mask_name(p_name text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when p_name is null or btrim(p_name) = '' then ''
    -- One word: nothing to abbreviate, and inventing an initial would be
    -- worse than showing the name the member chose.
    when strpos(btrim(p_name), ' ') = 0 then btrim(p_name)
    else split_part(btrim(p_name), ' ', 1) || ' ' ||
         left(split_part(btrim(p_name), ' ', 2), 1) || '.'
  end;
$$;
revoke all on function public.gym_display_mask_name(text) from public, anon;
grant execute on function public.gym_display_mask_name(text) to authenticated;
comment on function public.gym_display_mask_name(text) is
  'A display name reduced to a first name and a surname initial, for the gym display (202609230005). A single-word name is returned unchanged rather than abbreviated into something the member never chose.';

-- =====================================================================
-- 3. The one thing a display may call
-- =====================================================================
-- Definer, because the display can read no table directly and should not be
-- able to. Everything it is allowed to know is assembled here and nowhere
-- else, so the answer to "what can the television see" is this function body
-- rather than the union of a dozen policies.
create or replace function public.gym_display_board()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_club uuid;
  v_session public.club_wod_sessions;
  v_wod_title text;
  v_results jsonb;
begin
  -- The switch first. An admin turning the module off must blank the screen,
  -- not merely hide a menu item somewhere.
  if not public.club_feature_enabled('gym_display') then
    raise exception 'gym_display disabled';
  end if;
  if not public.is_gym_display() then
    raise exception 'not authorized';
  end if;

  v_club := public.default_club_id();

  select * into v_session
  from public.club_wod_sessions s
  where s.club_id = v_club
    and s.session_date = (now() at time zone 'Asia/Jerusalem')::date
    and s.cancelled_at is null
  order by s.published_at desc
  limit 1;

  if v_session.id is null then
    return jsonb_build_object('wod', null, 'results', '[]'::jsonb,
                              'as_of', now());
  end if;

  -- TWO KINDS OF WOD, and only one of them is in the database. club_wods
  -- holds the club's OWN workouts and its wod_id is constrained to
  -- '^customwod-...'; the benchmark names (Fran, Grace, Helen) live in the
  -- client's WOD_LIBRARY and never had a row here. So `name` is filled in
  -- only for a custom WOD, and wod_id always travels with it - the screen
  -- resolves a built-in name the same way every other surface in the app
  -- does. Returning a guess here would put "fran" on a wall in lower case.
  select w.name into v_wod_title
  from public.club_wods w
  where w.wod_id = v_session.wod_id and w.club_id = v_club and w.retired_at is null;

  -- in_leaderboards is the member's own answer to "may my result be shown on
  -- a board", and a wall in a public room is the most literal board there is.
  -- A member who has it off is absent from this list entirely - not masked,
  -- not greyed, absent.
  select coalesce(jsonb_agg(row_to_json(r)::jsonb order by r.attached_at), '[]'::jsonb)
    into v_results
  from (
    select
      public.gym_display_mask_name(p.display_name) as name,
      res.result_text,
      res.rx,
      res.attached_at
    from public.club_wod_results res
    join public.profiles p on p.id = res.user_id
    where res.session_id = v_session.id
      and p.deleted_at is null
      and p.in_leaderboards
      and not public.is_management_account(p.id)
  ) r;

  return jsonb_build_object(
    'wod', jsonb_build_object(
      'wod_id', v_session.wod_id,
      'name', v_wod_title,
      'note', v_session.note,
      'session_date', v_session.session_date
    ),
    'results', v_results,
    'as_of', now()
  );
end;
$$;
revoke all on function public.gym_display_board() from public, anon;
grant execute on function public.gym_display_board() to authenticated;
comment on function public.gym_display_board() is
  'Everything a gym display may see (202609230005): today''s club WOD and the results attached to it, for members whose in_leaderboards toggle is on, with names masked to a first name and a surname initial. Refuses unless club_feature_enabled(''gym_display'') and is_gym_display(). The display can read no table directly, so this body is the complete answer to what the screen can know.';
