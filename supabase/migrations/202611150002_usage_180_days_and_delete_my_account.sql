-- Two changes for the Haimunia club apps (owner, 2026-11-15).
--
-- 1. Usage counts are purged after 180 days, not 400. training_log_usage_purge() and the table comment come
--    from 202611120001 and 202611130001, both applied, so the change is made here (forward only).
--
-- 2. delete_my_account(): a member deletes their own account now, from the club app's settings. Unlike
--    request_account_deletion() (marks the profile and waits 30 days for purge_due_accounts), nothing waits:
--      a. Out of every circle, the way leave_circle does it: deleting the circle_members rows fires
--         circle_members_after_delete, which removes their posts, reactions, tags, benchmark results and
--         announcements in that circle and passes a club's ownership to the coach (decisions.md, Clubs).
--      b. Every post they wrote anywhere is deleted for real, not soft deleted. Other members' notifications
--         about those posts lose their text first, as in circle_members_after_delete.
--      c. Reactions they gave, their push subscriptions and their own notifications are deleted.
--      d. The profile, then the auth user. The foreign keys do the rest, and the auth.users delete triggers
--         (storage_erasure_queue, bug report anonymising) run as for every other account removal.
--    club_staff_actions (202611140001) keeps its rows: they hold ids and time only, and actor_id has no
--    foreign key, so nothing cascades there.
--    The training log on the phone is untouched. A BOX-LOG cloud backup (private_records, keyed to
--    auth.users with on delete cascade) goes with the account.
--    Rate limited to 3 calls an hour (check_rate_limit, as bug_report_submit). Like every caller of
--    check_rate_limit, the count is written in the call's own transaction: a call that raises rolls it back,
--    and a call that succeeds removes the account and its rate_limits row (on delete cascade). The limit is
--    a backstop against a burst inside one window, not a lockout.

-- =====================================================================================================
-- 1. Usage counts: 180 days
-- =====================================================================================================
create or replace function public.training_log_usage_purge()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.training_log_usage
   where day < (now() at time zone 'Asia/Jerusalem')::date - 180;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function public.training_log_usage_purge() from public, anon, authenticated;

comment on table public.training_log_usage is
  'Pseudonymous per-device, per-day usage counts from the Haimunia club apps (the old app on haimuniya.github.io and the new one on haimunia.pages.dev). Insert-only for anon (device_id, event, screen, app); app is always overwritten from the Origin header. No role can select a row; totals through training_log_usage_report() (granted to no role). At most 2,000 rows a day, purged after 180 days. 202611120001, 202611130001, 202611150002.';

-- =====================================================================================================
-- 2. delete_my_account()
-- =====================================================================================================
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authorized' using errcode = 'P0001'; end if;

  -- check_rate_limit RETURNS false when over the limit; it does not raise.
  if not public.check_rate_limit('delete_my_account', 3, 60) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- a. Every circle, with leave_circle's cleanup (circle_members_after_delete).
  delete from public.circle_members m where m.user_id = v_uid;

  -- b. Their posts anywhere else: the text other members were notified with goes first, then the posts.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications n
     set title = '', body = ''
   where n.source_type = 'post'
     and n.source_id in (select p.id from public.workout_posts p where p.author_id = v_uid)
     and (n.title <> '' or n.body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);
  delete from public.workout_posts p where p.author_id = v_uid;

  -- c. What they gave and what was theirs.
  delete from public.reactions r where r.user_id = v_uid;
  delete from public.post_training_partners t where t.tagged_user_id = v_uid or t.tagged_by = v_uid;
  delete from public.push_subscriptions s where s.user_id = v_uid;
  delete from public.notifications n where n.user_id = v_uid;

  -- d. The profile, then the account.
  delete from public.profiles p where p.id = v_uid;
  delete from auth.users u where u.id = v_uid;
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
comment on function public.delete_my_account() is
  'The caller deletes their own account at once: out of every circle (leave_circle''s cleanup), posts deleted for real, reactions given, push subscriptions, notifications, profile, then the auth user. Staff audit rows (ids only) stay. 3 calls an hour. 202611150002.';

