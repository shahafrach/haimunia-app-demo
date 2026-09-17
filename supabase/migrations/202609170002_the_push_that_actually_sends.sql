begin;

-- B3. The delivery half of web push.
--
-- Everything else has existed since COMM-005/COMM-229: the push_subscriptions
-- table, the sw.js handler, the client subscribe flow, notifications.
-- push_sent_at as the delivery marker, and streak_at_risk_notify() writing
-- rows on a daily cron. What never existed is the thing that takes a row and
-- puts it on a phone, so notifications.push_sent_at has been null on every
-- row ever written and streak_risk_nudges has been switched off on the
-- grounds that an in-app-only nudge reaches exactly the people who are not
-- at risk.
--
-- WHY THE SELECTION LIVES HERE AND NOT IN THE EDGE FUNCTION. Who receives a
-- push is a privacy decision - preference rows, revoked endpoints, deleted
-- profiles - and this repo can test SQL (pgTAP, against a real Postgres) far
-- better than it can test TypeScript running in Deno against a push service.
-- The Edge Function is deliberately left with no policy in it at all: it
-- calls these three functions, encrypts, and posts.
--
-- All three are service_role only. They are not SECURITY DEFINER for
-- convenience - notif_push_pending returns other members' endpoints and
-- notification bodies, which is precisely what no client role may ever read.

-- 1. What still needs sending.
--
-- The 24-hour floor is deliberate. A push is a notification about something
-- that just happened; delivering a two-day-old "your streak is at risk" after
-- an outage is worse than delivering nothing, and without a floor an endpoint
-- that fails permanently would be retried until the heat death of the club.
create or replace function public.notif_push_pending(p_limit integer default 200)
returns table (
  notification_id uuid,
  subscription_id uuid,
  endpoint text,
  p256dh text,
  auth_secret text,
  title text,
  body text,
  deep_link text,
  notification_type text
)
language sql
security definer
set search_path = ''
as $$
  select n.id, s.id, s.endpoint,
         s.keys->>'p256dh', s.keys->>'auth',
         n.title, n.body, n.deep_link, n.type
    from public.notifications n
    join public.profiles pr on pr.id = n.user_id and pr.deleted_at is null
    join public.push_subscriptions s on s.user_id = n.user_id and s.revoked_at is null
   where n.push_sent_at is null
     and n.created_at > now() - interval '24 hours'
     -- A missing preference row means in_app (notif_pref_allows's own rule),
     -- so push requires an EXPLICIT opt-in on the coarse key the settings
     -- screen writes. Nobody is pushed to by default.
     and exists (
       select 1 from public.notification_preferences np
        where np.user_id = n.user_id
          and np.type = public.notif_pref_key(n.type)
          and np.channel = 'push'
     )
     -- Both halves of the subscription are needed to encrypt. A row missing
     -- either is unusable, and silently encrypting against a null would
     -- produce a body no browser can read.
     and coalesce(s.keys->>'p256dh', '') <> ''
     and coalesce(s.keys->>'auth', '') <> ''
   order by n.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function public.notif_push_pending(integer) from public, anon, authenticated;
grant execute on function public.notif_push_pending(integer) to service_role;

comment on function public.notif_push_pending(integer) is
  'Rows the push sender still owes delivery on: unsent, under 24h old, recipient alive, recipient explicitly opted this type to push, subscription live and complete. Service role only - it returns other members endpoints and notification bodies.';

-- 2. Marking delivery. Idempotent: `push_sent_at is null` in the predicate
-- means a second call for the same id is a no-op rather than a re-stamp, so
-- an Edge Function retry after a timeout cannot move the timestamp.
create or replace function public.notif_push_mark_sent(p_ids uuid[])
returns integer
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.notifications
       set push_sent_at = now()
     where id = any(coalesce(p_ids, '{}'::uuid[]))
       and push_sent_at is null
    returning 1
  )
  select count(*)::integer from updated;
$$;
revoke all on function public.notif_push_mark_sent(uuid[]) from public, anon, authenticated;
grant execute on function public.notif_push_mark_sent(uuid[]) to service_role;

-- 3. Retiring an endpoint the push service has told us is gone (404/410).
--
-- COMM-229 logged this as the missing half of subscription hygiene: the
-- client reconciles its own endpoint when it next opens, but a device that
-- never opens the app again leaves its row live forever. This is the other
-- side - the only signal that a subscription is dead when nobody is holding
-- the phone.
create or replace function public.notif_push_revoke(p_subscription_ids uuid[])
returns integer
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.push_subscriptions
       set revoked_at = now()
     where id = any(coalesce(p_subscription_ids, '{}'::uuid[]))
       and revoked_at is null
    returning 1
  )
  select count(*)::integer from updated;
$$;
revoke all on function public.notif_push_revoke(uuid[]) from public, anon, authenticated;
grant execute on function public.notif_push_revoke(uuid[]) to service_role;

-- 4. The schedule. Same mechanism recap_weekly uses (202609050005): pg_cron
-- fires cron_invoke_edge_function, which POSTs with the service-role key read
-- from Vault at run time, and is INERT on any stack whose edge_functions_*
-- Vault secrets are still the committed placeholders - so `supabase start`
-- locally does not begin pushing at a hostname that does not exist.
--
-- Every three minutes, not every minute: streak nudges arrive on one daily
-- cron tick and the rest of the traffic in this club is a few dozen people
-- reacting to each other's posts. Three minutes is below anyone's threshold
-- for "did that not send?" and is 480 wake-ups a day rather than 1440.
select cron.schedule('notif-push-send', '*/3 * * * *',
  $$select public.cron_invoke_edge_function('notif_push_send')$$);

commit;
