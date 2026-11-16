-- 202611160001: the scheduled Edge Function calls get their own secret (F-023).
--
-- WHY. From about 2026-11-13 every cron call that public.cron_invoke_edge_function() made to
-- notif_push_send (every 3 minutes) and purge_abandoned_profiles (daily) answered 401 {"error":"unauthorized"}.
-- Each function admits a caller only when Authorization equals "Bearer " + the SUPABASE_SERVICE_ROLE_KEY the
-- platform injects into it; the cron sends the Vault secret edge_functions_service_role_key. Re-running
-- set-vault-secrets (which writes the Management API's legacy "service_role" key into the Vault) on
-- 2026-11-16 did not help, so the value the functions hold and the value the Vault holds differ, and nothing
-- in this repository controls the former. Abandoned sign-ups were not purged in that time.
--
-- WHAT. A dedicated random secret that this project owns end to end:
--   * Vault secret edge_functions_cron_secret, created here as a placeholder;
--   * the same value as the Edge Function secret EDGE_CRON_SECRET;
--   both written in one run of .github/workflows/set-vault-secrets.yml, which generates the value and never
--   prints it. The functions accept "Bearer <EDGE_CRON_SECRET>" with a constant-time compare
--   (supabase/functions/_shared/cronAuth.mjs) and still accept the service_role key for a manual call.
--
-- cron_invoke_edge_function() sends the cron secret when it is set, and falls back to the service_role key
-- while the cron secret is still its placeholder, so applying this migration before the workflow runs
-- changes nothing for the worse. edge_functions_ready() (the same conditions, for job_health_check) follows.
-- Both keep their signatures, their SECURITY DEFINER + empty search_path, and their privileges (granted to
-- no role); create or replace keeps the existing revokes. No secret value appears in this file.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'edge_functions_cron_secret') then
    perform vault.create_secret(
      'CRON-SECRET-NOT-SET',
      'edge_functions_cron_secret',
      'The random secret the scheduled Edge Function calls authenticate with (202611160001, F-023). Written together with the Edge Function secret EDGE_CRON_SECRET by .github/workflows/set-vault-secrets.yml; never by hand, never in a migration. While it holds this placeholder, public.cron_invoke_edge_function() falls back to edge_functions_service_role_key.');
  end if;
end $$;

create or replace function public.cron_invoke_edge_function(p_slug text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_base text;
  v_cron text;
  v_key text;
  v_auth text;
  v_request_id bigint;
begin
  if p_slug is null or p_slug !~ '^[a-z][a-z0-9_-]{2,63}$' then
    raise exception 'unknown edge function %', p_slug;
  end if;

  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'edge_functions_base_url';
  select s.decrypted_secret into v_cron
    from vault.decrypted_secrets s where s.name = 'edge_functions_cron_secret';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'edge_functions_service_role_key';

  -- The cron secret first (F-023); the service_role key only while the cron secret is unset. A cron secret
  -- shorter than 32 characters counts as unset, as it does in _shared/cronAuth.mjs.
  if v_cron is not null and v_cron <> 'CRON-SECRET-NOT-SET' and length(v_cron) >= 32 then
    v_auth := v_cron;
  elsif v_key is not null and v_key <> 'SERVICE-ROLE-KEY-NOT-SET' then
    v_auth := v_key;
  end if;

  if v_base is null or v_base like '%PROJECT-REF-NOT-SET%' or v_auth is null then
    raise notice 'cron_invoke_edge_function(%): skipped, the edge_functions_* Vault secrets are unset or still placeholders', p_slug;
    return null;
  end if;

  v_request_id := net.http_post(
    url := rtrim(v_base, '/') || '/' || p_slug,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_auth
    ),
    timeout_milliseconds := 30000
  );

  insert into public.edge_function_invocations (request_id, slug)
  values (v_request_id, p_slug)
  on conflict (request_id) do nothing;

  return v_request_id;
end;
$$;
revoke all on function public.cron_invoke_edge_function(text) from public, anon, authenticated;
comment on function public.cron_invoke_edge_function(text) is
  'Scheduler bridge (202609050005, 202609230008, 202611160001). POSTs an empty JSON body to <edge_functions_base_url>/<p_slug> via pg_net with Authorization: Bearer <edge_functions_cron_secret>, or <edge_functions_service_role_key> while the cron secret is still its placeholder (F-023). Every value is read at run time from Supabase Vault; none is ever written into a migration. Returns NULL with a NOTICE and makes no request while the base URL or both credentials are unset. p_slug must match ^[a-z][a-z0-9_-]{2,63}$. Records the request id in public.edge_function_invocations so job_health_check() can attribute the answer. SECURITY DEFINER to read vault.decrypted_secrets, GRANTED TO NO ROLE: only the cron job owner calls it.';

create or replace function public.edge_functions_ready()
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_base text;
  v_cron text;
  v_key text;
begin
  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'edge_functions_base_url';
  select s.decrypted_secret into v_cron
    from vault.decrypted_secrets s where s.name = 'edge_functions_cron_secret';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'edge_functions_service_role_key';
  return v_base is not null and v_base not like '%PROJECT-REF-NOT-SET%'
     and (
       (v_cron is not null and v_cron <> 'CRON-SECRET-NOT-SET' and length(v_cron) >= 32)
       or (v_key is not null and v_key <> 'SERVICE-ROLE-KEY-NOT-SET')
     );
end;
$$;
revoke all on function public.edge_functions_ready() from public, anon, authenticated;
comment on function public.edge_functions_ready() is
  'True when the edge_functions_base_url Vault secret is set and at least one credential is: edge_functions_cron_secret (202611160001, F-023) or edge_functions_service_role_key. The same conditions cron_invoke_edge_function() checks. Returns a boolean, never a secret. Revoked from everyone: job_health_check() is the only caller.';
