-- Lost-code reset: the wait is one hour, not twelve (owner's decision, 2026-11-10).
--
-- The wait itself is set by the request-reset Edge Function
-- (RESET_WAIT_MS in supabase/functions/_shared/recovery.mjs); the database
-- stores whatever ready_at it is given. Only the push text names the wait, so
-- reset_notify_requested() is re-created whole from 202611100001 with the
-- changed sentence. FORWARD ONLY: 202611100001 is applied and stays as it is.
begin;

create or replace function public.reset_notify_requested(p_user uuid, p_ready_at timestamptz)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_user is null then return null; end if;
  insert into public.notifications (user_id, type, category, title, body, source_type, source_id, deep_link)
  values (p_user, 'reset_requested', 'training', 'התבקש איפוס לסיסמה שלך',
          -- CHANGE: "בעוד 12 שעות" -> "בעוד שעה".
          'לא אתם? פתחו את האפליקציה ובטלו. בלי ביטול, הסיסמה תתאפס בעוד שעה.',
          'reset', gen_random_uuid(), '/tab/reset')
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.reset_notify_requested(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.reset_notify_requested(uuid, timestamptz) to service_role;

comment on table public.reset_requests is
  'Lost-code password resets (202611100001; wait shortened to one hour in 202611100002). One row per account: an HMAC of the request token (never the token), the end of the one-hour wait, the expiry, and a cancel with its 24-hour block. Written only by the request-reset Edge Function (service_role); the member reads and cancels their own through my_pending_reset and cancel_my_reset.';

commit;
