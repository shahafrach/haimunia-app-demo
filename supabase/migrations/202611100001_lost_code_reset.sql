-- Lost recovery code: the self-service reset (fix plan F19, decided 2026-11-10).
--
-- A member with no recovery code asks for a reset with the username alone. The
-- request-reset Edge Function (supabase/functions/_shared/recovery.mjs) keeps
-- one row per account here: an HMAC of a random request token, when the
-- 12-hour wait ends and when the request expires (24 hours after that). Any
-- signed-in session of the account sees it (my_pending_reset) and can cancel it
-- (cancel_my_reset), which blocks new requests for 24 hours. The account's
-- devices get a push when it is asked for (type reset_requested), sent even if
-- the member's other notification switches are off.
--
-- No approval by anyone. The accepted risk, recorded with the decision: anyone
-- who knows a username can take that account over after 12 hours unless a
-- signed-in session cancels. Members never see each other's usernames
-- (test/username-not-exposed.test.mjs).
--
-- FORWARD ONLY. notif_push_pending is re-created whole from 202611080001 with
-- the change marked.
begin;

create table public.reset_requests (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  token_hmac    text not null check (token_hmac ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  ready_at      timestamptz not null,
  expires_at    timestamptz not null,
  cancelled_at  timestamptz,
  blocked_until timestamptz,
  check (expires_at > ready_at and ready_at > created_at)
);
alter table public.reset_requests enable row level security;
revoke all on public.reset_requests from public, anon, authenticated;
grant select, insert, update, delete on public.reset_requests to service_role;

comment on table public.reset_requests is
  'Lost-code password resets (202611100001). One row per account: an HMAC of the request token (never the token), the end of the 12-hour wait, the expiry, and a cancel with its 24-hour block. Written only by the request-reset Edge Function (service_role); the member reads and cancels their own through my_pending_reset and cancel_my_reset.';

-- The caller's own open request, if any: when the wait ends. Nothing else of the row.
create or replace function public.my_pending_reset()
returns table(ready_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.ready_at, r.created_at
    from public.reset_requests r
   where r.user_id = auth.uid()
     and r.cancelled_at is null
     and r.expires_at > now();
$$;
revoke all on function public.my_pending_reset() from public, anon;
grant execute on function public.my_pending_reset() to authenticated;
comment on function public.my_pending_reset() is
  'Lost-code reset (202611100001): the caller''s own open request, ready_at and created_at only. Reads auth.uid() rows only.';

-- A signed-in session says "not me": the request is dead and the account takes
-- no new one for 24 hours. An anonymous session owns no account to protect.
create or replace function public.cancel_my_reset()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_n integer;
begin
  if v_uid is null then return false; end if;
  if exists (select 1 from auth.users u where u.id = v_uid and coalesce(u.is_anonymous, false)) then
    return false;
  end if;
  update public.reset_requests
     set cancelled_at = now(), blocked_until = now() + interval '24 hours'
   where user_id = v_uid and cancelled_at is null and expires_at > now();
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.cancel_my_reset() from public, anon;
grant execute on function public.cancel_my_reset() to authenticated;
comment on function public.cancel_my_reset() is
  'Lost-code reset (202611100001): cancels the caller''s own open request and blocks new ones for 24 hours. Permanent accounts only; touches auth.uid() rows only.';

-- The Edge Function tells the account's devices. Personal (no circle), category training,
-- content-free beyond "a reset was asked for". service_role only.
create or replace function public.reset_notify_requested(p_user uuid, p_ready_at timestamptz)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_user is null then return null; end if;
  insert into public.notifications (user_id, type, category, title, body, source_type, source_id, deep_link)
  values (p_user, 'reset_requested', 'training', 'התבקש איפוס לסיסמה שלך',
          'לא אתם? פתחו את האפליקציה ובטלו. בלי ביטול, הסיסמה תתאפס בעוד 12 שעות.',
          'reset', gen_random_uuid(), '/tab/reset')
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.reset_notify_requested(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.reset_notify_requested(uuid, timestamptz) to service_role;
comment on function public.reset_notify_requested(uuid, timestamptz) is
  'Lost-code reset (202611100001): one reset_requested notification for the account; pushed by notif_push_pending regardless of preference rows. service_role only.';

-- CHANGE: reset_requested is a personal type and is pushed with no preference row.
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
     and (n.circle_id is not null or n.type in ('workout_reminder', 'weekly_digest', 'reset_requested'))
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
     and (n.type = 'reset_requested'
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

commit;
