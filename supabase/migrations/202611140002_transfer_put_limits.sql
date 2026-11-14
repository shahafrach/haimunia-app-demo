-- F-001 follow-up (owner decision 2026-11-14): transfer-put limits for the move week.
--
-- Members move from the gym's shared Wi-Fi, so many phones share one IP. The per-IP limit goes from 5 to
-- 30 puts a day, and a per-device limit of 3 a day is added. The device is a random id the app keeps in
-- localStorage; the Edge Function sends only an HMAC of it under the transfer domain (like the IP), so
-- the id itself is never stored. Both put origins get the same limits. A put with no device (the old app,
-- haimuniya.github.io, which sends none) is held only by the per-IP limit.
-- The global cap (40 pending blobs), the 24-hour expiry, single use and the take limit are unchanged.
--
-- transfer_put gains p_device_hash with a default, so the deployed Edge Function, which calls with four
-- named arguments, keeps working between this migration and its redeploy.

alter table public.transfer_attempts drop constraint transfer_attempts_action_check;
alter table public.transfer_attempts add constraint transfer_attempts_action_check
  check (action in ('put', 'take', 'put_device'));
comment on column public.transfer_attempts.ip_hash is
  'HMAC of the caller''s IP (action put, take) or of the app''s random device id (action put_device), under the transfer domain prefix. 202611120001, 202611140002.';

drop function public.transfer_put(text, text, text, text);

-- Called by the transfer-put Edge Function only. Returns a status, never raises for a refusal (a raise would roll
-- back the attempt count): stored | rate_limited | full | invalid | too_large | plaintext | exists.
create function public.transfer_put(p_lookup_hash text, p_iv_b64 text, p_ciphertext_b64 text, p_ip_hash text,
                                    p_device_hash text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_iv bytea;
  v_ct bytea;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then return 'invalid'; end if;
  if p_device_hash is not null and p_device_hash !~ '^[0-9a-f]{64}$' then return 'invalid'; end if;
  if not public.transfer_rate_ok(p_ip_hash, 'put', 30, 1440) then return 'rate_limited'; end if;
  if p_device_hash is not null and not public.transfer_rate_ok(p_device_hash, 'put_device', 3, 1440) then
    return 'rate_limited';
  end if;
  if p_lookup_hash is null or p_lookup_hash !~ '^[0-9a-f]{64}$' then return 'invalid'; end if;
  -- 5 MiB of ciphertext is at most 6,990,508 base64 characters.
  if p_ciphertext_b64 is null or char_length(p_ciphertext_b64) > 6990508 then return 'too_large'; end if;
  begin
    v_iv := decode(p_iv_b64, 'base64');
    v_ct := decode(p_ciphertext_b64, 'base64');
  exception when others then
    return 'invalid';
  end;
  if octet_length(v_iv) <> 12 or octet_length(v_ct) < 17 then return 'invalid'; end if;
  if octet_length(v_ct) > 5242880 then return 'too_large'; end if;
  if public.transfer_looks_plaintext(v_ct) then return 'plaintext'; end if;

  -- Serialise the global cap.
  perform pg_advisory_xact_lock(hashtextextended('transfer_put', 0));
  if (select count(*) from public.transfer_blobs b where b.created_at > now() - interval '24 hours') >= 40 then
    return 'full';
  end if;
  insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash)
  values (p_lookup_hash, v_iv, v_ct, p_ip_hash)
  on conflict (lookup_hash) do nothing;
  if not found then return 'exists'; end if;
  return 'stored';
end $$;
revoke all on function public.transfer_put(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.transfer_put(text, text, text, text, text) to service_role;
