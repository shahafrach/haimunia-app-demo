-- 202611180003: an account left behind is deleted after a year, the same way a member deletes it (Q-38d / Q-38e).
--
-- WHY. Recovery in the club is self-service only (owner decisions Q-38c, Q-38d, Q-38e, 2026-11-18): Face ID (a
-- passkey), the recovery code, or, when both are gone, "פתיחת חשבון חדש": a new username and the club's join
-- code. The training log never lived on the server, so nothing is lost. The old account stays behind, still a
-- member of the club. purge_abandoned_profiles (202610250004) deletes only ANONYMOUS accounts that are in no
-- circle, so it never reaches it.
--
-- WHAT.
--   delete_account_now(user)        the body delete_my_account had (202611150002), moved here unchanged and keyed
--                                   by an argument: every circle with leave_circle's cleanup, posts (their
--                                   notification text first), reactions, training-partner tags, push
--                                   subscriptions, notifications, the profile, the auth user. Granted to no role.
--                                   delete_my_account keeps its own checks (aal2, 3 an hour) and calls it, so
--                                   the purge and a member's own deletion are one code path, not two copies.
--   account_last_activity(user)     the newest of: sign-in, account creation, any session refresh, any refresh
--                                   token use, any post, any reaction. Granted to no role.
--   purge_abandoned_club_accounts(days default 365)
--                                   every permanent account in at least one circle whose last activity is older
--                                   than `days`, through delete_account_now. 365 days is long on purpose: a member
--                                   who stays signed in refreshes a token whenever the app opens online, and one
--                                   who logs offline for months is never cut off. An account that holds training
--                                   data on the server (BOX-LOG's cloud backup, account_holds_training_data) is
--                                   kept and counted, as purge_abandoned_profiles does. Granted to no role.
--   cron 'purge-abandoned-club-accounts' at 04:41 daily.

-- =====================================================================================================
-- 1. One deletion body
-- =====================================================================================================
create or replace function public.delete_account_now(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null then raise exception 'member is required' using errcode = 'P0001'; end if;

  -- a. Every circle, with leave_circle's cleanup (circle_members_after_delete).
  delete from public.circle_members m where m.user_id = p_user;

  -- b. Their posts anywhere else: the text other members were notified with goes first, then the posts.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications n
     set title = '', body = ''
   where n.source_type = 'post'
     and n.source_id in (select p.id from public.workout_posts p where p.author_id = p_user)
     and (n.title <> '' or n.body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);
  delete from public.workout_posts p where p.author_id = p_user;

  -- c. What they gave and what was theirs.
  delete from public.reactions r where r.user_id = p_user;
  delete from public.post_training_partners t where t.tagged_user_id = p_user or t.tagged_by = p_user;
  delete from public.push_subscriptions s where s.user_id = p_user;
  delete from public.notifications n where n.user_id = p_user;

  -- d. The profile, then the account.
  delete from public.profiles p where p.id = p_user;
  delete from auth.users u where u.id = p_user;
end $$;
revoke all on function public.delete_account_now(uuid) from public, anon, authenticated, service_role;
comment on function public.delete_account_now(uuid) is
  'Deletes one account at once (202611180003): the body of delete_my_account (202611150002). Granted to no role; called by delete_my_account and purge_abandoned_club_accounts only.';

-- delete_my_account: the checks from 202611150002, unchanged; the deletion is delete_account_now's.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  -- F-016: a member with two-step login needs the aal2 session (202611070002). A password-only session
  -- can prove the code and nothing else, least of all delete the account for good.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;

  -- check_rate_limit RETURNS false when over the limit; it does not raise.
  if not public.check_rate_limit('delete_my_account', 3, 60) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  perform public.delete_account_now(v_uid);
end $$;

-- =====================================================================================================
-- 2. Last activity, and the purge
-- =====================================================================================================
create or replace function public.account_last_activity(p_user uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select greatest(
    (select greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at)) from auth.users u where u.id = p_user),
    (select max(greatest(s.created_at, coalesce(s.updated_at, s.created_at), coalesce(s.refreshed_at::timestamptz, s.created_at)))
       from auth.sessions s where s.user_id = p_user),
    (select max(coalesce(t.updated_at, t.created_at)) from auth.refresh_tokens t where t.user_id = p_user::text),
    (select max(p.published_at) from public.workout_posts p where p.author_id = p_user),
    (select max(r.created_at) from public.reactions r where r.user_id = p_user)
  )
$$;
revoke all on function public.account_last_activity(uuid) from public, anon, authenticated, service_role;

create or replace function public.purge_abandoned_club_accounts(p_days integer default 365)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cutoff timestamptz := now() - (greatest(coalesce(p_days, 365), 90) || ' days')::interval;
  v_id uuid;
  v_deleted integer := 0;
  v_failed integer := 0;
  v_kept integer := 0;
begin
  if auth.uid() is not null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  for v_id in
    select u.id from auth.users u
     where not coalesce(u.is_anonymous, false)
       and exists (select 1 from public.circle_members m where m.user_id = u.id)
       and public.account_last_activity(u.id) <= v_cutoff
  loop
    if public.account_holds_training_data(v_id) then v_kept := v_kept + 1; continue; end if;
    begin
      perform public.delete_account_now(v_id);
      v_deleted := v_deleted + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('deleted', v_deleted, 'failed', v_failed, 'kept_with_data', v_kept);
end $$;
revoke all on function public.purge_abandoned_club_accounts(integer) from public, anon, authenticated, service_role;
comment on function public.purge_abandoned_club_accounts(integer) is
  'Deletes, through delete_account_now, every permanent account in a circle with no activity (sign-in, session or token refresh, post, reaction) for p_days (365; never under 90). Keeps an account that holds training data. Granted to no role; cron purge-abandoned-club-accounts. 202611180003.';

select cron.schedule('purge-abandoned-club-accounts', '41 4 * * *', $$select public.purge_abandoned_club_accounts(365)$$);
