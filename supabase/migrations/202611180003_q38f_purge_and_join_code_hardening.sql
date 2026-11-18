-- 202611180003: abandoned club accounts are deleted after a year, safely; the join code is hardened (Q-38f).
--
-- Q-38d/e (owner, 2026-11-18): recovery is self-service. When Face ID and the recovery code are both gone, the
-- member opens a new account with the club's join code; the old one is left behind. purge_abandoned_profiles
-- deletes only anonymous accounts in no circle, so nothing ever reached it. Q-38f (security review) set how:
--
-- A. THE PURGE.
--   account_activity           one row per account: last_active_at (server-side, written by mark_active) and
--                              purge_warned_at. Its own table, no client grants: other members never see when
--                              someone was last active.
--   mark_active()              the apps call it when a signed-in session opens; at most one write per 6 hours.
--   account_last_activity(u)   the newest of: mark_active, sign-in, account creation, session refresh, refresh-
--                              token use, post, reaction. A member who stays signed in refreshes a token every
--                              time the app opens online, so an app that never calls mark_active still counts.
--   delete_account_now(u)      delete_my_account's body (202611150002), moved unchanged; delete_my_account keeps
--                              its checks and calls it. The purge deletes exactly what a member's own deletion
--                              deletes, through one body (Q-38e).
--   purge_abandoned_club_accounts(days 365, max_batch 25)
--                              permanent accounts in a circle, never the owner or coach of any circle (staff and
--                              sole owners), never one holding training data on the server.
--                              1. warn: 30 days before, one push, "open the app to keep it" (account_purge_warning).
--                              2. delete: still inactive 365 days and warned at least 30 days ago, after the last
--                                 activity. Any activity after the warning starts the clock again.
--                              3. gate: if more than max_batch accounts are due, nothing is deleted and the run
--                                 says aborted: a bug or a clock problem cannot empty the club in one night.
--   notif_push_pending          pushes account_purge_warning like reset_requested: personal, no preference row.
--   cron purge-abandoned-club-accounts at 04:41 daily.
--
-- C. THE JOIN CODE (202611180002).
--   code_hash becomes an HMAC under a Vault key (join_code_hmac_key, random, made here, never in the repository)
--   instead of a plain sha256: a leaked table no longer lets 8.5 * 10^11 codes be tried offline. The row made
--   before this keeps its sha256 until the next rotation, which writes the HMAC (join_circle accepts both).
--   join_circle's code path gains a per-IP limit (20 an hour, by cf-connecting-ip, the address under the same
--   key) and a global ceiling (300 wrong codes an hour across all callers, then codes wait; the long token is not
--   affected), on top of the 10 attempts an hour per account. transfer_rate_ok's counter pattern, its table.
--
-- Not here: a push to staff on each join (Q-38f c). It reverses an owner decision (decisions.md, Haimunia club:
-- "no join notification to the owner", 250 pushes on launch night), so it waits for the owner.

-- =====================================================================================================
-- A1. Activity
-- =====================================================================================================
create table public.account_activity (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  last_active_at  timestamptz,
  purge_warned_at timestamptz
);
alter table public.account_activity enable row level security;
revoke all on public.account_activity from public, anon, authenticated;
comment on table public.account_activity is
  'Server-side last activity and the purge warning per account (202611180003). No client grants; written by mark_active and purge_abandoned_club_accounts.';

create or replace function public.mark_active()
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  if exists (select 1 from auth.users u where u.id = v_uid and coalesce(u.is_anonymous, false)) then return; end if;
  insert into public.account_activity (user_id, last_active_at) values (v_uid, now())
  on conflict (user_id) do update set last_active_at = now()
   where public.account_activity.last_active_at is null
      or public.account_activity.last_active_at < now() - interval '6 hours';
end $$;
revoke all on function public.mark_active() from public, anon;
grant execute on function public.mark_active() to authenticated;

create or replace function public.account_last_activity(p_user uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select greatest(
    (select a.last_active_at from public.account_activity a where a.user_id = p_user),
    (select greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at)) from auth.users u where u.id = p_user),
    (select max(greatest(s.created_at, coalesce(s.updated_at, s.created_at), coalesce(s.refreshed_at::timestamptz, s.created_at)))
       from auth.sessions s where s.user_id = p_user),
    (select max(coalesce(t.updated_at, t.created_at)) from auth.refresh_tokens t where t.user_id = p_user::text),
    (select max(p.published_at) from public.workout_posts p where p.author_id = p_user),
    (select max(r.created_at) from public.reactions r where r.user_id = p_user)
  )
$$;
revoke all on function public.account_last_activity(uuid) from public, anon, authenticated, service_role;

-- =====================================================================================================
-- A2. One deletion body
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
-- A3. The purge: warn, then delete, behind a batch gate
-- =====================================================================================================
create or replace function public.purge_abandoned_club_accounts(p_days integer default 365, p_max_batch integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_days integer := greatest(coalesce(p_days, 365), 90);
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  v_warn_from timestamptz := now() - make_interval(days => v_days - 30);
  v_id uuid;
  v_last timestamptz;
  v_warned integer := 0;
  v_due uuid[] := '{}';
  v_deleted integer := 0;
  v_failed integer := 0;
begin
  if auth.uid() is not null then raise exception 'not authorized' using errcode = 'P0001'; end if;

  for v_id, v_last in
    select u.id, public.account_last_activity(u.id) from auth.users u
     where not coalesce(u.is_anonymous, false)
       and exists (select 1 from public.circle_members m where m.user_id = u.id)
       -- Never staff, never an owner: their circles would be left to the cleanup's fallback.
       and not exists (select 1 from public.circle_members m where m.user_id = u.id and m.role in ('owner', 'coach'))
       and not public.account_holds_training_data(u.id)
  loop
    if v_last > v_warn_from then continue; end if;
    -- Warned after the last activity, 30 days ago or more, and a year gone: due.
    if v_last <= v_cutoff and exists (select 1 from public.account_activity a where a.user_id = v_id
                                        and a.purge_warned_at > v_last and a.purge_warned_at <= now() - interval '30 days') then
      v_due := v_due || v_id;
      continue;
    end if;
    -- Not warned since the last activity: warn once.
    if not exists (select 1 from public.account_activity a where a.user_id = v_id and a.purge_warned_at > v_last) then
      insert into public.account_activity (user_id, purge_warned_at) values (v_id, now())
      on conflict (user_id) do update set purge_warned_at = now();
      insert into public.notifications (user_id, type, category, title, body, source_type, source_id, deep_link)
      values (v_id, 'account_purge_warning', 'training', 'החשבון במועדון לא היה בשימוש כמעט שנה',
              'אם לא פותחים את האפליקציה בחודש הקרוב, החשבון יימחק. האימונים בטלפון נשארים.',
              'account', gen_random_uuid(), '/');
      v_warned := v_warned + 1;
    end if;
  end loop;

  if coalesce(array_length(v_due, 1), 0) > greatest(coalesce(p_max_batch, 25), 1) then
    return jsonb_build_object('aborted', true, 'due', array_length(v_due, 1), 'warned', v_warned, 'deleted', 0);
  end if;
  if array_length(v_due, 1) is not null then
    foreach v_id in array v_due loop
      begin
        perform public.delete_account_now(v_id);
        v_deleted := v_deleted + 1;
      exception when others then
        v_failed := v_failed + 1;
      end;
    end loop;
  end if;
  return jsonb_build_object('aborted', false, 'warned', v_warned, 'deleted', v_deleted, 'failed', v_failed);
end $$;
revoke all on function public.purge_abandoned_club_accounts(integer, integer) from public, anon, authenticated, service_role;
comment on function public.purge_abandoned_club_accounts(integer, integer) is
  'Q-38f (202611180003): warns, then (30 days later, a year inactive) deletes through delete_account_now, permanent accounts in a circle that are no circle''s owner or coach and hold no training data. Aborts with nothing deleted when more than p_max_batch are due. Granted to no role; cron purge-abandoned-club-accounts.';

select cron.schedule('purge-abandoned-club-accounts', '41 4 * * *', $$select public.purge_abandoned_club_accounts(365, 25)$$);

-- notif_push_pending: body as in 202611120001_haimunia_club.sql; account_purge_warning is pushed like
-- reset_requested (a personal notice, no preference row).
create or replace function public.notif_push_pending(p_limit integer default 200)
returns table(notification_id uuid, subscription_id uuid, endpoint text, p256dh text,
              auth_secret text, title text, body text, deep_link text, notification_type text)
language sql security definer set search_path = '' as $$
  select n.id, s.id, s.endpoint,
         s.keys->>'p256dh', s.keys->>'auth',
         n.title, n.body, n.deep_link, n.type
    from public.notifications n
    join public.profiles pr on pr.id = n.user_id and pr.deleted_at is null
    join public.push_subscriptions s on s.user_id = n.user_id and s.revoked_at is null
   where n.push_sent_at is null
     and n.created_at > now() - interval '24 hours'
     and (n.circle_id is not null or n.type in ('workout_reminder', 'weekly_digest', 'reset_requested', 'account_purge_warning'))
     and (n.circle_id is null or s.app = public.circle_app(n.circle_id))
     and (n.circle_id is null
          or exists (select 1 from public.circle_members m
                      where m.club_id = n.circle_id and m.user_id = n.user_id))
     and (n.actor_id is null
          or exists (select 1 from public.circle_members m
                      where m.club_id = n.circle_id and m.user_id = n.actor_id))
     and (n.actor_id is null
          or not exists (select 1 from public.blocks b
                          where (b.blocker_id = n.user_id and b.blocked_id = n.actor_id)
                             or (b.blocker_id = n.actor_id and b.blocked_id = n.user_id)))
     and (n.source_type is distinct from 'post'
          or exists (select 1 from public.workout_posts p
                      where p.id = n.source_id and p.deleted_at is null))
     and (n.type in ('reset_requested', 'account_purge_warning')
          or exists (
            select 1 from public.notification_preferences np
             where np.user_id = n.user_id
               and np.type = public.notif_pref_key(n.type)
               and np.channel = 'push')
          or (n.type = 'reaction' and not exists (
            select 1 from public.notification_preferences np
             where np.user_id = n.user_id and np.type = 'reaction')))
     and coalesce(s.keys->>'p256dh', '') <> ''
     and coalesce(s.keys->>'auth', '') <> ''
   order by n.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- =====================================================================================================
-- C. The join code: HMAC under a Vault key, a per-IP limit and a global ceiling
-- =====================================================================================================
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'join_code_hmac_key') then
    -- Random, made in the database: the value is never in the repository or a log.
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'join_code_hmac_key',
      'The key of the club join code''s HMAC (202611180003, Q-38f). Made once in the database; rotating it ends the live code.');
  end if;
end $$;

-- The counters live in transfer_attempts: the code's per-IP count under an IP HMAC (64 hex, as the table
-- requires), and the global wrong-code count under the all-zero key, which no HMAC can produce by chance.
alter table public.transfer_attempts drop constraint transfer_attempts_action_check;
alter table public.transfer_attempts add constraint transfer_attempts_action_check
  check (action in ('put', 'take', 'put_device', 'join_code', 'join_code_wrong'));

create or replace function public.join_code_key()
returns text language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'join_code_hmac_key' limit 1
$$;
revoke all on function public.join_code_key() from public, anon, authenticated, service_role;

create or replace function public.join_code_hmac(p_code text)
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac('haimunia:join-code:v1:' || public.join_code_normalize(p_code), public.join_code_key(), 'sha256'), 'hex')
$$;
revoke all on function public.join_code_hmac(text) from public, anon, authenticated, service_role;

-- The caller's address as PostgREST passes it, the Q-41 rule: cf-connecting-ip only, else one shared bucket.
create or replace function public.request_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_ip text;
begin
  begin
    v_ip := nullif(btrim(current_setting('request.headers', true)::json ->> 'cf-connecting-ip'), '');
  exception when others then v_ip := null;
  end;
  return encode(extensions.hmac('haimunia:join-ip:v1:' || coalesce(v_ip, 'unknown'), public.join_code_key(), 'sha256'), 'hex');
end $$;
revoke all on function public.request_ip_hash() from public, anon, authenticated, service_role;

-- rotate_club_invite: body as in 202611180002_club_short_join_code.sql; the code is stored as the HMAC.
create or replace function public.rotate_club_invite(p_club_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
  v_code text;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if v_uid is null then raise exception 'not authorized'; end if;
  perform 1 from public.clubs c where c.id = p_club_id and c.type = 'club' for update;
  if not found or not public.is_club_staff(p_club_id) then raise exception 'not authorized'; end if;
  if not public.check_rate_limit('rotate_club_link', 5, 1440) then raise exception 'rate_limited'; end if;

  delete from public.circle_invites i where i.club_id = p_club_id;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_code := public.join_code_generate();
  insert into public.circle_invites (club_id, token_hash, code_hash, created_by, expires_at, max_uses)
  values (p_club_id, encode(extensions.digest(v_token, 'sha256'), 'hex'),
          public.join_code_hmac(v_code), v_uid, 'infinity', 100000);
  perform public.club_staff_log(p_club_id, 'link_rotate', null);
  return jsonb_build_object('token', v_token, 'code', v_code);
end $$;

-- join_circle: body as in 202611180002_club_short_join_code.sql; the code path is limited per IP and globally,
-- and matches the HMAC (or the sha256 of the row made before this migration, until it is rotated).
create or replace function public.join_circle(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_code_hmac text;
  v_code_sha text;
  v_code text;
  v_club uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.check_rate_limit('join_circle', 10, 60) then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  v_code := public.join_code_normalize(p_token);
  if p_token ~ '^[0-9a-f]{64}$' then
    v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  elsif v_code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$' then
    -- Q-38f: 20 code attempts an hour per address, and no code at all once 300 wrong ones came in this hour.
    if not public.transfer_rate_ok(public.request_ip_hash(), 'join_code', 20, 60) then
      return jsonb_build_object('status', 'rate_limited');
    end if;
    if exists (select 1 from public.transfer_attempts a
                where a.ip_hash = repeat('0', 64) and a.action = 'join_code_wrong'
                  and a.window_started_at > now() - interval '60 minutes' and a.attempt_count >= 300) then
      return jsonb_build_object('status', 'rate_limited');
    end if;
    v_code_hmac := public.join_code_hmac(v_code);
    v_code_sha := encode(extensions.digest(v_code, 'sha256'), 'hex');
  else
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.deleted_at is not null) then
    return jsonb_build_object('status', 'invalid');
  end if;

  begin
    update public.circle_invites i set uses = i.uses + 1
     where ((v_hash is not null and i.token_hash = v_hash)
            or (v_code_hmac is not null and i.code_hash in (v_code_hmac, v_code_sha)))
       and i.uses < i.max_uses and i.expires_at > now()
    returning i.club_id into v_club;
    if v_club is null then
      if v_code_hmac is not null then perform public.transfer_rate_ok(repeat('0', 64), 'join_code_wrong', 1000000, 60); end if;
      return jsonb_build_object('status', 'invalid');
    end if;

    if exists (select 1 from public.circle_members m where m.club_id = v_club and m.user_id = v_uid) then
      raise exception 'already_member';
    end if;

    insert into public.profiles (id, handle)
    values (v_uid, 'u' || substr(md5(v_uid::text), 1, 20))
    on conflict (id) do nothing;

    insert into public.circle_members (club_id, user_id, share_defaults)
    select v_club, v_uid, public.circle_share_defaults(c.type)
      from public.clubs c where c.id = v_club;
    return jsonb_build_object('status', 'joined', 'club_id', v_club);
  exception when others then
    -- The block's writes (the use, the profile, the member) are rolled back; the
    -- attempt counted above is not.
    if sqlerrm in ('already_member', 'circle_full', 'too_many_circles') then
      return jsonb_build_object('status', sqlerrm, 'club_id', case when sqlerrm = 'already_member' then v_club end);
    end if;
    raise;
  end;
end $$;
