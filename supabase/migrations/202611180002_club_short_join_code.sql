-- 202611180002: a short join code for the club link (Q-37, launch blocker).
--
-- WHY. Joining the club needed the 64-hex token link (#join=<token>). On an iPhone a link opened in Safari never
-- reaches the installed app (a home-screen app has its own storage), so the token was lost and the member had to
-- paste 64 characters by hand. The owner could not do it; older members cannot. Owner decision (2026-11-18): a short
-- link and a QR code, and a code short enough to read off a screen and type.
--
-- WHAT.
--   circle_invites.code_hash   sha256 (hex) of an 8-character code, on the club's one link row only. Like the
--                              token, the code itself is never stored, and no client role can read the table
--                              (202610250003 revokes everything from anon and authenticated).
--   join_code_generate()       8 characters from 31 that cannot be confused when read aloud or off a screen:
--                              2-9 and A-Z without 0, O, 1, I, L. 31^8 is about 8.5 * 10^11 (39.6 bits). Bytes of
--                              248 and above are skipped so every character is equally likely.
--   join_code_normalize(text)  upper case, spaces and dashes removed: "abcd-2345", "ABCD 2345" are one code.
--   rotate_club_invite(uuid)   what rotate_club_link did, and the row now carries a code too. Returns
--                              {token, code}, once. Same checks: aal2 when the member has MFA, owner or coach of
--                              that club only, 5 rotations a day (the same rate-limit key), staff-logged.
--   rotate_club_link(uuid)     unchanged signature and result (the token), for the club app before this release.
--                              It is now a wrapper over rotate_club_invite, so there is one body, not two copies.
--   join_circle(text)          accepts the 64-hex token as before, or a code in any case with spaces or dashes.
--                              Both find the same row, so expiry ('infinity' for a club), max uses (the cap) and
--                              the per-account limit (10 attempts an hour, a wrong code counts) are the same.
--
-- GUESSING. Every attempt needs a signed-in account (anonymous sign-up is Turnstile-gated and limited per IP by
-- Supabase Auth), and each account has 10 attempts an hour. One IP at the launch limit (300 sign-ups an hour) makes
-- at most 3,000 guesses an hour against one live code in 8.5 * 10^11: about 30,000 years on average. A rotation
-- (the coach, from the app) ends a leaked code and link together.
--
-- Friends and couple invites are unchanged and have no code. No other table, policy or grant changes.

alter table public.circle_invites
  add column code_hash text unique check (code_hash ~ '^[0-9a-f]{64}$');

comment on column public.circle_invites.code_hash is
  'sha256 (hex) of the club link''s 8-character join code (202611180002). Club rows only; the code is never stored.';

create or replace function public.join_code_normalize(p_code text)
returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'))
$$;
revoke all on function public.join_code_normalize(text) from public, anon, authenticated;

create or replace function public.join_code_generate()
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; -- 31: no 0, O, 1, I, L
  v_out text := '';
  v_bytes bytea;
  v_b integer;
  i integer;
begin
  while char_length(v_out) < 8 loop
    v_bytes := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      v_b := get_byte(v_bytes, i);
      -- 248 = 8 * 31: below it, b % 31 is uniform.
      if v_b < 248 and char_length(v_out) < 8 then
        v_out := v_out || substr(v_alphabet, (v_b % 31) + 1, 1);
      end if;
    end loop;
  end loop;
  return v_out;
end $$;
revoke all on function public.join_code_generate() from public, anon, authenticated;

-- rotate_club_invite: rotate_club_link's body from 202611180001_staff_rpcs_require_aal2.sql, plus the code.
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
          encode(extensions.digest(v_code, 'sha256'), 'hex'), v_uid, 'infinity', 100000);
  perform public.club_staff_log(p_club_id, 'link_rotate', null);
  return jsonb_build_object('token', v_token, 'code', v_code);
end $$;
revoke all on function public.rotate_club_invite(uuid) from public, anon;
grant execute on function public.rotate_club_invite(uuid) to authenticated;

-- rotate_club_link: same signature, grants and result as 202611180001; the body is rotate_club_invite's.
create or replace function public.rotate_club_link(p_club_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  return public.rotate_club_invite(p_club_id) ->> 'token';
end $$;

-- join_circle: body as in 202610250004_circle_lifecycle_rpcs.sql, and a code finds the row as the token does.
create or replace function public.join_circle(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_code_hash text;
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
    v_code_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');
  else
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.deleted_at is not null) then
    return jsonb_build_object('status', 'invalid');
  end if;

  begin
    update public.circle_invites i set uses = i.uses + 1
     where ((v_hash is not null and i.token_hash = v_hash) or (v_code_hash is not null and i.code_hash = v_code_hash))
       and i.uses < i.max_uses and i.expires_at > now()
    returning i.club_id into v_club;
    if v_club is null then return jsonb_build_object('status', 'invalid'); end if;

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
