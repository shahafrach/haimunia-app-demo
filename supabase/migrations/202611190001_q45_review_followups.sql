-- Q-45 (2026-11-19): follow-ups from the claude-review of demo #188. Forward only; 202611180003 is applied.
--
-- 1. The short join code's global ceiling: 300 -> 3000 wrong codes an hour. Each address can try 20 an hour and
--    each account 10, so at 300 any 15 addresses could stop code-joins for every club for an hour. At 3000 that
--    takes 150. Guessing stays out of reach: 31^8 is about 8.5e11 codes, so 3000 tries an hour finds a given
--    club's code with odds near 1 in 280 million per hour. The long link (64 hex) never had the ceiling and keeps
--    working throughout. Decided by fixes, owner to confirm.
-- 2. client_report_ip_hash (202611150003, client errors and feedback) reads only cf-connecting-ip, like every
--    other per-IP limit since Q-41 (request_ip_hash, _shared/clientIp.mjs). Without it the caller is in the one
--    shared 'unknown' bucket; x-forwarded-for and x-real-ip are no longer read.

create or replace function public.client_report_ip_hash(p_domain text)
returns text language plpgsql stable set search_path = '' as $$
declare
  v_headers json;
  v_ip text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(btrim(coalesce(v_headers ->> 'cf-connecting-ip', '')), '');
  return public.client_report_hash(p_domain, coalesce(v_ip, 'unknown'));
end $$;
revoke all on function public.client_report_ip_hash(text) from public, anon, authenticated, service_role;

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
    -- Q-38f: 20 code attempts an hour per address, and no code at all once 3000 wrong ones came in this hour (Q-45).
    if not public.transfer_rate_ok(public.request_ip_hash(), 'join_code', 20, 60) then
      return jsonb_build_object('status', 'rate_limited');
    end if;
    if exists (select 1 from public.transfer_attempts a
                where a.ip_hash = repeat('0', 64) and a.action = 'join_code_wrong'
                  and a.window_started_at > now() - interval '60 minutes' and a.attempt_count >= 3000) then
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
