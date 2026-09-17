begin;

-- The owner asked for an admin switch that turns push off for the whole club.
--
-- Scope, decided explicitly: PUSH ONLY. The bell, the notification centre and
-- every in-app notification keep working. What stops is delivery that leaves
-- the app and interrupts somebody, which is the part an owner would ever want
-- to switch off in a hurry - and switching off notification GENERATION would
-- take the community side's whole mechanism with it, not just its delivery.
--
-- It is a club_features row like the other twenty, not a bespoke setting, so
-- it appears in the same admin panel with the same shape and the same audit
-- trail through admin_set_club_feature.
--
-- AND IT IS ENFORCED HERE, not only in the client. Five of the toggles added
-- on 2026-09-15 are clientOnly and the panel says so. This one is not: the
-- check lives inside notif_push_pending, so switching it off stops delivery
-- even for a device already subscribed, a notification already written, and a
-- cron already running. A kill switch that only hides a button is not a kill
-- switch.

insert into public.club_features (module_key, enabled)
values ('push_notifications', true)
on conflict (club_id, module_key) do nothing;

-- Default ON, matching every other module: the club that never opens this
-- panel keeps the behaviour it had the day before this migration.

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
   where public.club_feature_enabled('push_notifications')
     and n.push_sent_at is null
     and n.created_at > now() - interval '24 hours'
     and exists (
       select 1 from public.notification_preferences np
        where np.user_id = n.user_id
          and np.type = public.notif_pref_key(n.type)
          and np.channel = 'push'
     )
     and coalesce(s.keys->>'p256dh', '') <> ''
     and coalesce(s.keys->>'auth', '') <> ''
   order by n.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function public.notif_push_pending(integer) from public, anon, authenticated;
grant execute on function public.notif_push_pending(integer) to service_role;

comment on function public.notif_push_pending(integer) is
  'Rows the push sender still owes delivery on: club push module on, unsent, under 24h old, recipient alive, recipient explicitly opted this type to push, subscription live and complete. Service role only - it returns other members endpoints and notification bodies.';

-- NOTHING IS MARKED SENT WHILE THE MODULE IS OFF, and that is deliberate.
-- notif_push_pending simply returns no rows, so a notification written during
-- an off period keeps push_sent_at null and becomes deliverable again the
-- moment the module is switched back on - as long as it is still inside the
-- 24-hour window. Turning push off for an afternoon does not silently consume
-- that afternoon's notifications.

-- The twenty-key assertion in 202609160006 cannot be edited (it is applied),
-- so this migration asserts its own row rather than extending that list. The
-- next person adding a module should do the same.
do $$
begin
  if not exists (select 1 from public.club_features where module_key = 'push_notifications') then
    raise exception 'push_notifications has no club_features row, so the admin panel would render a toggle with nothing behind it';
  end if;
end $$;

commit;
