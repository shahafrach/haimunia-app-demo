-- 202611160001 (F-023): the scheduled Edge Function calls authenticate with their own Vault secret.
--   1. The placeholder edge_functions_cron_secret exists; neither function is callable by anon or a member.
--   2. With placeholders only, nothing is ready and no request is made.
--   3. With the cron secret set, the cron call carries "Bearer <cron secret>", never the service_role key.
--   4. With only the service_role key set (cron secret still a placeholder or too short), it falls back to it.
-- Every value below is a made-up test value inside a rolled-back transaction.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions;
select * from no_plan();

select ok(exists (select 1 from vault.secrets where name = 'edge_functions_cron_secret'),
  'the cron secret has its Vault row');
select is((select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_cron_secret'),
  'CRON-SECRET-NOT-SET', 'and it ships as the placeholder: no value is ever committed');

select ok(not has_function_privilege('anon', 'public.cron_invoke_edge_function(text)', 'execute'), 'anon cannot fire a cron call');
select ok(not has_function_privilege('authenticated', 'public.cron_invoke_edge_function(text)', 'execute'), 'nor can a member');
select ok(not has_function_privilege('anon', 'public.edge_functions_ready()', 'execute'), 'anon cannot ask whether it is configured');
select ok(not has_function_privilege('authenticated', 'public.edge_functions_ready()', 'execute'), 'nor can a member');

create function pg_temp.set_secret(p_name text, p_value text) returns void language sql as $fn$
  select vault.update_secret((select id from vault.secrets where name = p_name), p_value)
$fn$;
create function pg_temp.auth_of(p_request_id bigint) returns text language sql as $fn$
  select q.headers->>'Authorization' from net.http_request_queue q where q.id = p_request_id
$fn$;

-- 2. Placeholders only.
select pg_temp.set_secret('edge_functions_base_url', 'https://PROJECT-REF-NOT-SET.supabase.co/functions/v1');
select pg_temp.set_secret('edge_functions_service_role_key', 'SERVICE-ROLE-KEY-NOT-SET');
select pg_temp.set_secret('edge_functions_cron_secret', 'CRON-SECRET-NOT-SET');
select ok(not public.edge_functions_ready(), 'placeholders only: not ready');
select is(public.cron_invoke_edge_function('notif_push_send'), null::bigint, 'placeholders only: no request is made');

-- 3. The cron secret set (and a service_role key too): the cron secret is what is sent.
select pg_temp.set_secret('edge_functions_base_url', 'https://example.invalid/functions/v1');
select pg_temp.set_secret('edge_functions_service_role_key', 'test-service-role-key-not-real');
select pg_temp.set_secret('edge_functions_cron_secret', repeat('ab', 32));
select ok(public.edge_functions_ready(), 'base URL and cron secret set: ready');
select is(pg_temp.auth_of(public.cron_invoke_edge_function('notif_push_send')), 'Bearer ' || repeat('ab', 32),
  'the cron call carries the cron secret, not the service_role key');
select ok(exists (select 1 from public.edge_function_invocations where slug = 'notif_push_send'),
  'and it is still recorded for job_health_check()');

-- 4. Fallback: the cron secret still a placeholder, or too short to count.
select pg_temp.set_secret('edge_functions_cron_secret', 'CRON-SECRET-NOT-SET');
select is(pg_temp.auth_of(public.cron_invoke_edge_function('purge_abandoned_profiles')), 'Bearer test-service-role-key-not-real',
  'cron secret unset: it falls back to the service_role key, as before this migration');
select pg_temp.set_secret('edge_functions_cron_secret', 'short');
select is(pg_temp.auth_of(public.cron_invoke_edge_function('purge_abandoned_profiles')), 'Bearer test-service-role-key-not-real',
  'a cron secret under 32 characters counts as unset');
select pg_temp.set_secret('edge_functions_service_role_key', 'SERVICE-ROLE-KEY-NOT-SET');
select ok(not public.edge_functions_ready(), 'neither credential set: not ready');
select is(public.cron_invoke_edge_function('purge_abandoned_profiles'), null::bigint, 'and no request is made');

select throws_ok($$ select public.cron_invoke_edge_function('../evil') $$, 'P0001', 'unknown edge function ../evil',
  'the slug is still validated');

select * from finish();
rollback;
