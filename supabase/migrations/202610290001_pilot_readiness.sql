-- Pilot readiness (202610290001): the first circle can be started, and a
-- member can reach the owner without an email address or a phone number.
--
-- 1. bootstrap_owner_invite(). A new account can only join through an invite,
--    and only a circle member can mint one, so on an empty database nobody can
--    start. This function breaks the loop. It is for the owner alone: it is
--    granted to NO role, so it is reachable only from the Supabase SQL editor
--    (which runs as postgres) and never from the API. It mints a row in
--    invite_codes, which redeem_invite_code() already knows how to spend:
--    role 'member', one use, one hour. Redeeming writes one invite_redemptions
--    row and nothing else; that row is what create_circle() accepts from a
--    person who has no circle yet. It grants no circle access by itself.
--    Only the sha256 of the token is stored; the token is returned once, as a
--    full invite URL with the token after the # (never in a query string).
--
-- 2. bug_report_submit(). The "פנייה" form in Me files into bug_reports
--    (owner decision 2026-10-28: no support email, no phone). What changes:
--      * a member who has left every circle may still write (Me stays
--        reachable with no circle, and access and deletion requests go here);
--      * the diagnostics column keeps ONE key, app_version, whatever the
--        client sends: a message and a version, nothing about the device;
--      * 5 per hour instead of 10, and now actually enforced: the old body
--        called check_rate_limit with PERFORM and ignored its false.
--    The table keeps no client grant at all; the owner reads it in the
--    Supabase dashboard (Table Editor, bug_reports).

create or replace function public.bootstrap_owner_invite()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
begin
  -- Not a member-callable function: the grants below give EXECUTE to nobody.
  -- This is the second lock, for a grant added later by mistake: an API call
  -- carries a JWT subject, the SQL editor does not.
  if auth.uid() is not null then
    raise exception 'not authorized';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.invite_codes (code_hash, role, active, expires_at, max_uses)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), 'member', true,
          now() + interval '1 hour', 1);
  return 'https://box-log.pages.dev/#invite=' || v_token;
end $$;

revoke all on function public.bootstrap_owner_invite() from public, anon, authenticated, service_role;

comment on function public.bootstrap_owner_invite() is
  'Owner-only bootstrap (202610290001). Mints a one-use invite_codes row valid for one hour and returns the full invite URL, token after #, once. Only the sha256 of the token is stored. EXECUTE is granted to no role: run it from the Supabase SQL editor as postgres. Refuses any call that carries an auth.uid(). Redeeming it (redeem_invite_code) lets the redeemer create their first circle and grants nothing else.';

create or replace function public.bug_report_submit(p_body text, p_diagnostics jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_body text;
  v_version text;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  -- A signed-up member with a profile, in a circle or not. An anonymous
  -- session (mid sign-up) is not one.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.deleted_at is null) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then raise exception 'body required' using errcode = 'P0001'; end if;
  v_body := left(v_body, 4000);

  -- The only thing kept besides the message: the app version, if it looks
  -- like one. Anything else in p_diagnostics is dropped here, not stored.
  v_version := coalesce(p_diagnostics ->> 'app_version', p_diagnostics ->> 'version', '');
  if v_version !~ '^[0-9A-Za-z._-]{1,32}$' then v_version := ''; end if;

  -- check_rate_limit RETURNS false when over the limit; it does not raise.
  -- The earlier body called it with PERFORM, which threw the answer away, so
  -- the 10 per hour it promised was never enforced.
  if not public.check_rate_limit('bug_report_submit', 5, 60) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.bug_reports (reporter_id, body, diagnostics)
  values (auth.uid(), v_body, jsonb_build_object('app_version', v_version))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.bug_report_submit(text, jsonb) from public, anon;
grant execute on function public.bug_report_submit(text, jsonb) to authenticated;
comment on function public.bug_report_submit(text, jsonb) is
  'Files a "פנייה" (support request) for the calling member (202609150002, narrowed by 202610290001). Needs a signed-up member with a profile; being in a circle is not required. Stores the message (trimmed, cut at 4000) and the app version ONLY: diagnostics is rebuilt as {"app_version": ...}. Rate-limited 5 per hour. Raises ''not authorized'', ''body required'' and ''rate_limited'', all P0001. The table has no client grant; the owner reads it in the Supabase dashboard.';
