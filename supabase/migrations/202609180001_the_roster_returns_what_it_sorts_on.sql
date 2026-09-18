-- The roster returns what it sorts on (2026-09-18).
--
-- THE DEFECT. admin_member_roster orders and pages on
-- `coalesce(ir.redeemed_at, p.created_at)` and returns `ir.redeemed_at`.
-- For a profile with no invite_redemptions row at all - a signup abandoned
-- between redemption and the profile form, or a pre-invite-gate legacy
-- account - the value the function actually sorted and filtered on is
-- `p.created_at`, and no caller can see it. So there is no correct p_cursor
-- for the page after one ending in such a row:
--
--   * sending that row's redeemed_at means sending NULL, which the function
--     reads as "no lower bound at all" and restarts from the very top -
--     the same 25 rows, forever;
--   * sending nothing means the list ends there.
--
-- The client chose the second (loadRoster() in cloud.js stops offering
-- "load more" the moment a page's last row has a null redeemed_at), which
-- is correct in the sense that nothing shown is wrong - but a club's legacy
-- tail is unreachable in one browsing session, and 202609160002's tie-break
-- work made no difference to it, because the missing half was never the
-- tie-break: it was the sort key itself.
--
-- This was known, written down in docs/community/backlog.md's COMM-377
-- paragraph as "a real, flagged gap ... worked around rather than papered
-- over", and the fix it proposed there is the one taken here.
--
-- THE FIX. Return the coalesced value as its own column, `sort_key`. The
-- function now exposes every value it orders on, so the cursor pair
-- (sort_key, id) the client sends back is exactly the tuple the WHERE
-- clause compares - which is what the composite comparison needed in order
-- to mean anything for these rows.
--
-- redeemed_at is left EXACTLY as it was: null for a member with no
-- redemption, because that is the truth about that member and the roster
-- row renders it as "—" rather than inventing a join date. sort_key is the
-- paging key, not a second opinion about when someone joined.
--
-- WHY A DROP. `create or replace function` cannot add an OUT column - it
-- refuses with "cannot change return type of existing function" - so the
-- function is dropped and recreated at the SAME argument list. No overload
-- is created: this is one function before and one after, which is what pgTAP
-- 0060's overload-count assertion holds the line on.
--
-- ORDER OF DEPLOY. Safe in both directions, and deliberately so. The
-- argument list does not change, so PostgREST resolves the call identically
-- and no PGRST202 window exists. An old client ignores the extra column and
-- keeps its old stop-early behaviour; a new client against an un-migrated
-- database finds sort_key undefined and falls back to redeemed_at, which is
-- exactly today's behaviour. Neither half has to ship first.
--
-- SIBLINGS CHECKED (CLAUDE.md's sibling-drift rule). Every other
-- cursor-paged function in this schema returns the column it sorts on:
-- admin_actions_page, notif_list and mod_queue sort on a created_at they
-- return as part of a `setof <table>`/`setof mod_queue_item`;
-- admin_invite_list sorts on i.created_at and puts it in its jsonb;
-- admin_incomplete_signups sorts on ir.redeemed_at through an INNER join, so
-- that value is never null and never coalesced. feed_page and its relatives
-- carry an opaque encoded cursor that holds its own keys. The three other
-- `order by coalesce(...)` sites in the schema - community_profile's recent
-- workouts, PRs and posts - are LIMIT-only with no cursor at all, and they
-- already select the coalesced value out as `d`/`ts`. admin_member_roster
-- was the only one.

drop function if exists public.admin_member_roster(timestamptz, integer, uuid);
create or replace function public.admin_member_roster(
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_cursor_id uuid default null)
returns table(
  id uuid, handle text, display_name text, avatar_url text, is_admin boolean, role text,
  redeemed_at timestamptz, last_activity_on date, sort_key timestamptz
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
      (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = p.id) as last_activity_on,
      -- The one new thing in this migration. Identical expression to the
      -- ORDER BY below, character for character, and it must stay that way:
      -- the moment they differ, the cursor pages on something the client
      -- cannot see again.
      coalesce(ir.redeemed_at, p.created_at) as sort_key
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
  'One page of the club roster, newest join first, cursor-paginated on (join date, id) since 202609160002 - the coalesced join date alone dropped every member sharing the last-shown member''s timestamp, which is the normal case for a club that onboarded in one sitting. Since 202609180001 the function also RETURNS that coalesced join date as sort_key: it orders and filters on coalesce(invite_redemptions.redeemed_at, profiles.created_at), and a member with no invite_redemptions row has a null redeemed_at, so before sort_key existed no caller could build the cursor for the page after such a row and paging stopped there. sort_key is the paging key and the only value that belongs in p_cursor; redeemed_at stays null for a member who never redeemed an invite, because that is the truth about them. p_cursor_id is optional; null pages the old way. AUTH: security definer, auth.uid() then is_staff(). p_limit clamped 1..100. Read-only.';
