-- The tie-break reaches every list (2026-09-16). Round 10, drift sweep.
--
-- 202609150015 fixed a real defect - a cursor paginated on a bare timestamp
-- silently drops every row sharing the last-shown row's timestamp - for
-- admin_actions_page and notif_list, and its own comment called it "the same
-- sibling drift this hunt keeps finding". It then left three siblings unfixed.
-- Written down and not carried across, one migration after naming the pattern.
--
-- THE THREE. All three already ORDER BY with a tie-break (or, for
-- admin_invite_list, with none at all) while filtering on the timestamp alone,
-- so the total order was stable and the cursor still skipped:
--   admin_member_roster        coalesce(ir.redeemed_at, p.created_at), p.id
--   admin_incomplete_signups   ir.redeemed_at, u.id
--   admin_invite_list          i.created_at  (no tie-break at all)
-- admin_member_roster's comment even ends "a duplicated timestamp is still a
-- real edge here" - the gap was known, documented, and left open.
--
-- WHY IT IS THE NORMAL CASE, NOT AN EDGE. A club onboards in one sitting: a
-- batch of invites created in one transaction shares created_at to the
-- microsecond, and a batch redeemed together shares redeemed_at. With a page
-- size of 25 and 27 members holding one timestamp, paging ends early and the
-- members past the boundary are unreachable - not misordered, absent, with
-- "load more" gone because the short page reads as the end.
--
-- ALSO FIXED HERE: 202609150015 added p_cursor_id with `create or replace`,
-- which does not replace when the argument list changes - it OVERLOADS. So
-- production carries both the fixed and the original admin_actions_page and
-- notif_list, the originals still granted to authenticated and still carrying
-- the bug. The live client always sends p_cursor_id so it resolves to the
-- fixed one, which is why this was invisible; but any caller omitting it gets
-- the broken function, and two candidates can make PostgREST refuse to choose
-- at all. They are dropped here, and every function below is created at its
-- new signature and its old one dropped explicitly.
--
-- ONE DELIBERATE BEHAVIOUR CHANGE: the roster and ghost lists tie-broke with
-- `p.id` / `u.id` ASCENDING under a DESCENDING date. A tuple comparison only
-- means "strictly earlier in this ordering" when the tuple's columns are
-- ordered the same way the ORDER BY orders them, so with an ascending
-- tie-break, `(date, id) < (cursor_date, cursor_id)` would exclude precisely
-- the tied rows that should come NEXT and re-include ones already shown - a
-- worse bug than the one being fixed. Both tie-breaks therefore become DESC,
-- matching 202609150015. The visible effect is the order of members sharing one
-- timestamp, which was arbitrary before and is arbitrary now.
--
-- Backward compatible: p_cursor_id defaults to null and a null means "page the
-- old way", so a client that has not updated (a cached service worker, a phone
-- that has not reloaded) keeps working exactly as before.

-- 1. The stale overloads from 202609150015.
drop function if exists public.admin_actions_page(timestamptz, integer, jsonb);
drop function if exists public.notif_list(timestamptz, integer);

-- 2. admin_member_roster.
drop function if exists public.admin_member_roster(timestamptz, integer);
create or replace function public.admin_member_roster(
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_cursor_id uuid default null)
returns table(
  id uuid, handle text, display_name text, avatar_url text, is_admin boolean, role text,
  redeemed_at timestamptz, last_activity_on date
)
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- Clamped 1..100, admin_actions_page and mod_queue's convention.
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
    select p.id, p.handle, p.display_name, p.avatar_url, p.is_admin, ir.role, ir.redeemed_at,
      (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = p.id) as last_activity_on
    from public.profiles p
    left join public.invite_redemptions ir on ir.user_id = p.id
    where p.deleted_at is null
      and (
        p_cursor is null
        -- No cursor id: the pre-202609160002 behaviour, for clients that have
        -- not reloaded yet. Still skips ties, and deliberately so - changing
        -- what an old client gets mid-page is worse than leaving it as it was.
        or (p_cursor_id is null and coalesce(ir.redeemed_at, p.created_at) < p_cursor)
        -- The composite compares as a tuple, so it means exactly "strictly
        -- earlier in the ORDER BY below" - the row-wise < is what makes the
        -- tie-break do any work at all.
        or (p_cursor_id is not null
            and (coalesce(ir.redeemed_at, p.created_at), p.id) < (p_cursor, p_cursor_id))
      )
    order by coalesce(ir.redeemed_at, p.created_at) desc, p.id desc
    limit v_limit;
end $$;
revoke all on function public.admin_member_roster(timestamptz, integer, uuid) from public, anon;
grant execute on function public.admin_member_roster(timestamptz, integer, uuid) to authenticated;
comment on function public.admin_member_roster(timestamptz, integer, uuid) is
  'One page of the club roster, newest join first, cursor-paginated on (join date, id) since 202609160002 - the coalesced join date alone dropped every member sharing the last-shown member''s timestamp, which is the normal case for a club that onboarded in one sitting. p_cursor_id is optional; null pages the old way. AUTH: security definer, auth.uid() then is_staff(). p_limit clamped 1..100. Read-only.';

-- 3. admin_incomplete_signups. Same change, same reasons; the body is
--    otherwise character-for-character what 202609060023 shipped.
drop function if exists public.admin_incomplete_signups(timestamptz, integer);
create or replace function public.admin_incomplete_signups(
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_cursor_id uuid default null)
returns table(
  user_id uuid, username text, label text, role text, invite_source text,
  redeemed_at timestamptz, signed_up_at timestamptz, last_sign_in_at timestamptz,
  stalled_days integer, purgeable_after_reclaim boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
    select
      u.id,
      case when u.email like '%@members.haimuniya.invalid'
           then pg_catalog.split_part(u.email, '@', 1) end,
      i.label,
      ir.role,
      case when ir.invite_id is not null then 'shared_code' else 'person_invite' end,
      ir.redeemed_at,
      u.created_at,
      u.last_sign_in_at,
      (extract(day from (now() - ir.redeemed_at)))::integer,
      -- Whether purge_abandoned_profiles() would eventually collect this
      -- account once admin_reclaim_invite() has removed the redemption row
      -- that currently disqualifies it. Unchanged from 202609060023.
      coalesce(u.is_anonymous, false)
    from auth.users u
    join public.invite_redemptions ir on ir.user_id = u.id
    left join public.invites i on i.id = ir.person_invite_id
    where not exists (select 1 from public.profiles p where p.id = u.id)
      and (
        p_cursor is null
        or (p_cursor_id is null and ir.redeemed_at < p_cursor)
        or (p_cursor_id is not null and (ir.redeemed_at, u.id) < (p_cursor, p_cursor_id))
      )
    order by ir.redeemed_at desc, u.id desc
    limit v_limit;
end $$;
revoke all on function public.admin_incomplete_signups(timestamptz, integer, uuid) from public, anon;
grant execute on function public.admin_incomplete_signups(timestamptz, integer, uuid) to authenticated;
comment on function public.admin_incomplete_signups(timestamptz, integer, uuid) is
  'Redeemed invites with no profile yet ("ghosts"), cursor-paginated on (redeemed_at, user_id) since 202609160002 - a batch of invites redeemed together shares one timestamp and the bare-timestamp cursor dropped all but the last of them. p_cursor_id optional; null pages the old way. AUTH: security definer, auth.uid() then is_staff(). Read-only.';

-- 4. admin_invite_list. This one had NO tie-break in its ORDER BY at all, so
--    its page boundary was not even deterministic between two calls.
drop function if exists public.admin_invite_list(text, timestamptz, integer);
create or replace function public.admin_invite_list(
  p_status text default 'all',
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_cursor_id uuid default null)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_limit  integer;
  v_status text;
  v_now    timestamptz := now();
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.member.invite') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  v_status := coalesce(nullif(p_status, ''), 'all');
  if v_status not in ('all', 'pending', 'redeemed', 'revoked', 'expired') then
    raise exception 'invalid status';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
    select jsonb_build_object(
             'id', i.id,
             'role', i.role,
             'label', i.label,
             'created_at', i.created_at,
             'expires_at', i.expires_at,
             'revoked_at', i.revoked_at,
             'redeemed_at', i.redeemed_at,
             'redeemed_by', i.redeemed_by,
             'redeemed_by_display_name', p.display_name,
             'redeemed_by_handle', p.handle,
             'status', public.invite_status(i.revoked_at, i.redeemed_at, i.expires_at, v_now))
    from public.invites i
    -- A left join, unchanged from 202609030001: the redeemer may not have a
    -- profile yet, and the invite must still list during exactly the window an
    -- admin is most likely to be looking.
    left join public.profiles p on p.id = i.redeemed_by
    where (
        p_cursor is null
        or (p_cursor_id is null and i.created_at < p_cursor)
        or (p_cursor_id is not null and (i.created_at, i.id) < (p_cursor, p_cursor_id))
      )
      and (v_status = 'all'
           or public.invite_status(i.revoked_at, i.redeemed_at, i.expires_at, v_now) = v_status)
    order by i.created_at desc, i.id desc
    limit v_limit;
end $$;
revoke all on function public.admin_invite_list(text, timestamptz, integer, uuid) from public, anon;
grant execute on function public.admin_invite_list(text, timestamptz, integer, uuid) to authenticated;
comment on function public.admin_invite_list(text, timestamptz, integer, uuid) is
  'One page of invites, newest first, cursor-paginated on (created_at, id) since 202609160002 - previously ordered by created_at with no tie-break at all, so a batch of invites created in one transaction had a non-deterministic page boundary and lost rows across it. p_cursor_id optional; null pages the old way. AUTH: security definer, auth.uid() then community.member.invite or is_admin(). Returns SETOF jsonb, id included so the client can send it back as the cursor id. Read-only.';
