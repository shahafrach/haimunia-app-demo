-- Two paged surfaces silently dropped rows that shared a timestamp.
--
-- Live bug hunt, fresh round 7 (2026-09-15), measured at realistic volume:
-- 300 audit rows seeded, 296 rendered; 200 notifications seeded, 199
-- rendered. Not a rounding artefact - the missing rows are exactly those
-- sharing the last-shown row's created_at and positioned after it.
--
-- HOW A ROW DISAPPEARS. Both functions page on created_at alone: the client
-- takes the last row's timestamp as the next cursor and the function asks for
-- `created_at < p_cursor`. Any row with the SAME timestamp as the last row on
-- a page is then neither on that page (it fell after the limit) nor on the
-- next one (it is not strictly less than the cursor). It is unreachable for
-- as long as it exists.
--
-- Ties are not exotic here. admin_actions rows are written by triggers and by
-- bulk operations - a moderator actioning a report writes report_review and
-- content_delete in ONE transaction, and notif_create fans a single event out
-- to every recipient in a loop. Rows sharing a timestamp to the microsecond
-- is the normal case for exactly the operations an audit log exists to record.
--
-- THE FIX IS A COMPOSITE CURSOR, (created_at, id), which is what feed_page's
-- own cursor already does deliberately - its comment calls the token "a row
-- identity, not an offset". These two were written before that lesson and
-- never revisited: the same sibling drift this hunt keeps finding, here
-- between two paging implementations of the same idea.
--
-- BOTH KEEP THEIR EXISTING SIGNATURE and gain an OPTIONAL id. A client that
-- sends only a timestamp behaves exactly as before, so an old cached client
-- is not broken by this deploying first - it simply keeps the old tie
-- behaviour until it updates.
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
  if not public.has_perm('community.analytics.view') then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  return query
    select a.* from public.admin_actions a
    where (
        p_cursor is null
        or (p_cursor_id is null and a.created_at < p_cursor)
        -- Strictly after the cursor ROW in the same (created_at desc, id desc)
        -- order the query itself uses, so a tie is walked rather than skipped.
        or (p_cursor_id is not null and (a.created_at, a.id) < (p_cursor, p_cursor_id))
      )
      and (coalesce(p_filters ->> 'action_type', '') = '' or a.action_type = p_filters ->> 'action_type')
      and (coalesce(p_filters ->> 'admin_id', '') = '' or a.admin_id = (p_filters ->> 'admin_id')::uuid)
      and (coalesce(p_filters ->> 'target_user_id', '') = '' or a.target_user_id = (p_filters ->> 'target_user_id')::uuid)
    order by a.created_at desc, a.id desc
    limit v_limit;
end $$;

comment on function public.admin_actions_page(timestamptz, integer, jsonb, uuid) is
  'COMM-009. One page of the admin audit log, newest first, cursor-paginated on (created_at, id) since 202609150015 - created_at alone silently dropped any row sharing the last-shown row''s timestamp, which is the NORMAL case here: a moderator actioning a report writes two rows in one transaction, and 300 seeded rows rendered 296. p_cursor_id is optional so a client sending only a timestamp behaves exactly as before. AUTH: security invoker; auth.uid() first, then has_perm(''community.analytics.view''), and the admin_actions_read_analytics policy underneath it. p_limit clamped 1..100. p_filters accepts action_type, admin_id and target_user_id. RETURNS setof public.admin_actions. Read-only.';

-- The notification centre, same defect, same fix. 200 seeded rows rendered
-- 199. notif_create() fans one event out to every recipient in a loop, so
-- rows sharing a timestamp are routine here too.
create or replace function public.notif_list(
  p_cursor timestamptz default null,
  p_limit integer default 20,
  p_cursor_id uuid default null
)
returns setof public.notifications
language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 40);
  return query
    select n.* from public.notifications n
    where n.user_id = auth.uid()
      and (
        p_cursor is null
        or (p_cursor_id is null and n.created_at < p_cursor)
        or (p_cursor_id is not null and (n.created_at, n.id) < (p_cursor, p_cursor_id))
      )
    order by n.created_at desc, n.id desc
    limit v_limit;
end $$;

comment on function public.notif_list(timestamptz, integer, uuid) is
  'One page of the caller''s own notifications, newest first, cursor-paginated on (created_at, id) since 202609150015. created_at alone dropped any row sharing the last-shown row''s timestamp - routine here, since notif_create() fans a single event out to every recipient in one loop; 200 seeded rows rendered 199. p_cursor_id is optional, so a client sending only a timestamp behaves exactly as before. AUTH: security invoker, own rows only via auth.uid(). p_limit clamped 1..40.';
