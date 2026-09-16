begin;

-- THE AUDIT LOG IS READABLE BY THE STAFF IT AUDITS. Closing that, for real
-- this time.
--
-- 202609150004 found this and said it plainly: "granting head_coach
-- analytics silently handed them the record of every staff action -
-- including their own - which is the one thing an audit log must not be."
-- It then changed admin_actions_page()'s gate to is_admin() and considered
-- the matter closed. It was not, for two separate reasons, and the pgTAP
-- assertion that would have caught both could not run - 202609150016
-- aborted the migration chain on any fresh database from 2026-09-16 06:38
-- until 202609160006 repaired it, so `supabase test db` never started.
--
-- REASON 1, THE ONE THAT WAS ALWAYS TRUE. The narrowing touched the
-- FUNCTION and never the POLICY. `authenticated` holds a direct SELECT
-- grant on public.admin_actions, and admin_actions_read_analytics has read
-- `has_perm('community.analytics.view')` unchanged since 202608280002. The
-- function is security INVOKER, so that policy is the real gate, and
-- anybody holding analytics.view could always read the table directly
-- without going near the RPC. Narrowing the function alone moved the lock
-- to a door that was never the way in.
--
-- REASON 2, SIBLING DRIFT. 202609150015 re-declared admin_actions_page to
-- add the tie-breaking cursor id, and copied its body from 202608280002 -
-- the ORIGINAL - rather than from 202609150004, the version eleven hours
-- older that had just narrowed the gate. That silently restored
-- has_perm('community.analytics.view'). The two then coexisted as separate
-- overloads (3-arg narrow, 4-arg wide) until 202609160002 dropped stale
-- overloads and removed the narrow one, leaving only the wide.
--
-- Net effect in production since 2026-09-15: a head coach could read every
-- admin action - password resets, role changes, member removals - including
-- the rows recording what was done to them. 202609160005 makes that sharper
-- by giving head_coach a removal power of their own; the record of who
-- removed whom must not be readable by the people doing the removing.
--
-- BOTH gates move to is_admin() here, and the policy is the one that
-- matters. The five analytics readers and recap_monthly_publish that also
-- touch admin_actions are all security definer, so they bypass RLS and are
-- unaffected.

drop policy if exists admin_actions_read_analytics on public.admin_actions;
create policy admin_actions_read_admin on public.admin_actions for select to authenticated
  using (public.is_admin());

comment on policy admin_actions_read_admin on public.admin_actions is
  'The audit log is readable by real admins only (profiles.is_admin), never by a named permission. Replaces admin_actions_read_analytics (202608280002), which gated on community.analytics.view and therefore widened the log to every role that permission was later granted to - head_coach, from 202609150004. A log the audited can read is not a log. Writes have no policy at all: log_admin_action() is security definer and is the only writer.';

create or replace function public.admin_actions_page(
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_filters jsonb default '{}'::jsonb,
  p_cursor_id uuid default null
) returns setof public.admin_actions
language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  -- is_admin(), NOT has_perm('community.analytics.view'). See this
  -- migration's header: the permission legitimately gates five analytics
  -- readers a head coach should have, and never should have gated this one.
  if not public.is_admin() then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  return query
    select a.* from public.admin_actions a
    where (
        p_cursor is null
        or (p_cursor_id is null and a.created_at < p_cursor)
        or (p_cursor_id is not null and (a.created_at, a.id) < (p_cursor, p_cursor_id))
      )
      and (coalesce(p_filters ->> 'action_type', '') = '' or a.action_type = p_filters ->> 'action_type')
      and (coalesce(p_filters ->> 'admin_id', '') = '' or a.admin_id = (p_filters ->> 'admin_id')::uuid)
      and (coalesce(p_filters ->> 'target_user_id', '') = '' or a.target_user_id = (p_filters ->> 'target_user_id')::uuid)
    order by a.created_at desc, a.id desc
    limit v_limit;
end $$;

comment on function public.admin_actions_page(timestamptz, integer, jsonb, uuid) is
  'COMM-009. One page of the admin audit log, newest first, cursor-paginated on (created_at, id) since 202609150015. AUTH: security invoker; auth.uid() first, then is_admin() - restored in 202609160007 after 202609150015 re-declared this function from the pre-202609150004 body and silently put the gate back on has_perm(''community.analytics.view''). The admin_actions_read_admin policy underneath it carries the same rule, and is the gate that actually matters: authenticated holds a direct SELECT grant on the table. p_limit clamped 1..100. p_filters accepts action_type, admin_id and target_user_id. RETURNS setof public.admin_actions. Read-only.';

commit;
