-- Two repairs found by the first end-to-end user tests (docs/qa/user-tests-2026-10.md).
--
-- 1. "Signed up" is read from the database, not from the JWT.
--    Sign-up starts as an anonymous session and upgrades it with
--    supabase.auth.updateUser(), which saves the new user but keeps the access
--    token issued at anonymous sign-in (vendor/supabase.js, _updateUser:
--    `o.user = l.user; _saveSession(o)`, `o.access_token` untouched). That token's
--    `is_anonymous` claim stays true until it is refreshed (jwt_expiry is an
--    hour), so a member who had just signed up was refused by
--    create_founder_invite (202610290002) and bug_report_submit (202610290001),
--    both of which read the claim. Both now ask auth.users.is_anonymous, which
--    the upgrade has already set to false. The client also refreshes the session
--    right after the upgrade (src/community/auth.js, setCredentials). These were
--    the only two functions that read the claim; every other is_anonymous test in
--    the schema (the purge jobs, the incomplete-signup views) already reads
--    auth.users.
--
-- 2. Account deletion takes the member out of their circles.
--    request_account_deletion() marked the profile deleted and soft-deleted the
--    posts but left the circle_members rows, so a deleted partner still counted
--    in a circle's size and a Couple could not invite a replacement until the
--    purge, up to 30 days later. It now deletes the membership rows first; the
--    circle_members_after_delete trigger does the same cleanup as leave_circle.
--
-- FORWARD ONLY. create or replace keeps each function's grants and its entry in
-- tests.definer_reviewed.

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
  if exists (select 1 from auth.users u where u.id = auth.uid() and coalesce(u.is_anonymous, false))
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

create or replace function public.create_founder_invite()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  -- A signed-up member with a profile, in a circle or not. An anonymous session
  -- (mid sign-up) is not one.
  if exists (select 1 from auth.users u where u.id = auth.uid() and coalesce(u.is_anonymous, false))
     or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.deleted_at is null) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;

  -- check_rate_limit RETURNS false when over the limit; it does not raise.
  if not public.check_rate_limit('founder_invite', 3, 1440) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.invite_codes (code_hash, role, active, expires_at, max_uses)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), 'member', true,
          now() + interval '7 days', 1);
  return 'https://box-log.pages.dev/#invite=' || v_token;
end $$;

create or replace function public.request_account_deletion() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Out of every circle at once, with the cleanup leave_circle gets: the
  -- circle_members_after_delete trigger removes their posts, reactions, tags and
  -- benchmark results there, passes ownership to the longest-standing member,
  -- and deletes a circle whose last member this was. The member count and the
  -- Couple's second seat free up now, not at the purge 30 days later.
  delete from public.circle_members m where m.user_id = auth.uid();
  insert into public.account_deletion_requests(user_id) values (auth.uid())
  on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = auth.uid();
  delete from public.push_subscriptions where user_id = auth.uid();
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts set deleted_at = now() where author_id = auth.uid();
  perform set_config('app.allow_moderation_write', 'off', true);
end $$;
