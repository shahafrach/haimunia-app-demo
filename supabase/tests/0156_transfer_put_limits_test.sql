-- 202611140002: transfer_put allows 30 puts per IP and 3 per device a day, 1 MiB per code and 150 MB in all. A put with no device (the old
-- app sends none) is held only by the IP limit. Rate checks run before the blob is stored.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

delete from public.transfer_blobs;
delete from public.transfer_attempts;
-- Keep the global cap (300 pending) out of the way: every put below sends invalid base64, which is checked
-- after both rate limits and stores nothing.
create function tests.put(p_ip text, p_device text) returns text language sql as
  $$ select public.transfer_put(repeat('a', 64), '***', 'AAAA', p_ip, p_device) $$;
grant execute on function tests.put(text, text) to service_role;

select ok(not has_function_privilege('authenticated', 'public.transfer_put(text, text, text, text, text)', 'execute'), 'authenticated cannot call transfer_put');
select ok(not has_function_privilege('anon', 'public.transfer_put(text, text, text, text, text)', 'execute'), 'nor anon');
select is((select count(*)::int from pg_proc where proname = 'transfer_put' and pronamespace = 'public'::regnamespace), 1, 'the old four-argument overload is gone');

set local role service_role;
-- Per IP: 30 a day, devices or not.
select is((select count(*)::int from generate_series(1, 30) i where tests.put(repeat('1', 64), null) = 'invalid'), 30,
  'thirty puts from one IP with no device pass the rate limit');
select is(tests.put(repeat('1', 64), null), 'rate_limited', 'the 31st from that IP in a day is refused');
select is(tests.put(repeat('1', 64), repeat('d', 64)), 'rate_limited', 'a device does not lift the IP limit');

-- Per device: 3 a day, across IPs.
select is(tests.put(repeat('2', 64), repeat('9', 64)), 'invalid', 'device put 1');
select is(tests.put(repeat('3', 64), repeat('9', 64)), 'invalid', 'device put 2, another IP');
select is(tests.put(repeat('4', 64), repeat('9', 64)), 'invalid', 'device put 3, another IP');
select is(tests.put(repeat('5', 64), repeat('9', 64)), 'rate_limited', 'the fourth from one device in a day is refused, whatever the IP');
select is(tests.put(repeat('5', 64), repeat('8', 64)), 'invalid', 'another device on that IP still passes');
select is(tests.put(repeat('5', 64), null), 'invalid', 'and so does a put with no device');

-- A real put stores under the new signature.
select is(public.transfer_put(repeat('b', 64), translate(encode(extensions.gen_random_bytes(12), 'base64'), E'\n', ''),
  translate(encode(extensions.gen_random_bytes(64), 'base64'), E'\n', ''), repeat('6', 64), repeat('7', 64)), 'stored', 'a put with a device is stored');
select is(public.transfer_put(repeat('c', 64), translate(encode(extensions.gen_random_bytes(12), 'base64'), E'\n', ''),
  translate(encode(extensions.gen_random_bytes(64), 'base64'), E'\n', ''), repeat('6', 64)), 'stored', 'four arguments still work (the old app, and the Edge Function before its redeploy)');
reset role;
select is((select count(*)::int from public.transfer_attempts where action = 'put_device'), 3, 'one window per device (9, 8, 7), beside the IP windows');
select ok((select bool_and(ip_hash ~ '^[0-9a-f]{64}$') from public.transfer_attempts), 'only hashes are stored');
select is((select count(*)::int from public.transfer_blobs b where b.ip_hash = repeat('7', 64)), 0, 'the device hash is not written to the blob');

-- The global cap: 300 pending blobs over 24 hours (was 40). Two are stored above.
insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash)
select encode(extensions.digest('cap' || i, 'sha256'), 'hex'), extensions.gen_random_bytes(12), extensions.gen_random_bytes(64), repeat('e', 64)
  from generate_series(1, 297) i;
set local role service_role;
select is(public.transfer_put(repeat('d', 64), translate(encode(extensions.gen_random_bytes(12), 'base64'), E'\n', ''),
  translate(encode(extensions.gen_random_bytes(64), 'base64'), E'\n', ''), repeat('a', 64)), 'stored', 'the 300th pending blob is stored');
select is(public.transfer_put(repeat('f', 64), translate(encode(extensions.gen_random_bytes(12), 'base64'), E'\n', ''),
  translate(encode(extensions.gen_random_bytes(64), 'base64'), E'\n', ''), repeat('a', 64)), 'full', 'the 301st is refused as full');
reset role;
update public.transfer_blobs set created_at = now() - interval '25 hours' where lookup_hash like 'c%' or lookup_hash = repeat('d', 64);
set local role service_role;
select is(public.transfer_put(repeat('f', 64), translate(encode(extensions.gen_random_bytes(12), 'base64'), E'\n', ''),
  translate(encode(extensions.gen_random_bytes(64), 'base64'), E'\n', ''), repeat('a', 64)), 'stored', 'blobs older than 24 hours do not count toward the cap');
reset role;

-- Storage: at most 1 MiB of ciphertext per code.
delete from public.transfer_blobs;
delete from public.transfer_attempts;
create function tests.put_bytes(p_lookup text, p_ct bytea) returns text language sql as
  $$ select public.transfer_put(p_lookup, translate(encode(extensions.gen_random_bytes(12), 'base64'), E'\n', ''),
       translate(encode(p_ct, 'base64'), E'\n', ''), repeat('7', 64)) $$;
grant execute on function tests.put_bytes(text, bytea) to service_role;
set local role service_role;
select is(tests.put_bytes(repeat('1', 64), decode(repeat('ab', 1048576), 'hex')), 'stored', 'exactly 1 MiB of ciphertext is stored');
select is(tests.put_bytes(repeat('2', 64), decode(repeat('ab', 1048577), 'hex')), 'too_large', 'one byte over 1 MiB is too_large');
reset role;
select throws_ok($$ insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash)
  values (repeat('3', 64), extensions.gen_random_bytes(12), decode(repeat('ab', 1048577), 'hex'), repeat('7', 64)) $$,
  '23514', null, 'and the table refuses a row over 1 MiB');

-- Storage: at most 150 MB (150,000,000 bytes) in the table, expired-but-unpurged rows included.
delete from public.transfer_blobs;
insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash)
select encode(extensions.digest('bytes' || i, 'sha256'), 'hex'), extensions.gen_random_bytes(12), decode(repeat('ab', 1048576), 'hex'), repeat('e', 64)
  from generate_series(1, 143) i;   -- 149,946,368 bytes
select is((select sum(octet_length(ciphertext))::bigint from public.transfer_blobs), 149946368::bigint, 'setup: 143 MiB pending');
set local role service_role;
select is(tests.put_bytes(repeat('4', 64), decode(repeat('ab', 50000), 'hex')), 'stored', '50 KB more still fits under 150 MB');
select is(tests.put_bytes(repeat('5', 64), decode(repeat('ab', 10000), 'hex')), 'full', '10 KB more would pass 150 MB: full, the same answer as the count cap');
reset role;
update public.transfer_blobs set created_at = now() - interval '25 hours';
set local role service_role;
select is(tests.put_bytes(repeat('6', 64), decode(repeat('ab', 10000), 'hex')), 'full', 'expired rows still count until the purge removes them');
select ok(public.transfer_purge() >= 144, 'the hourly purge removes them');
select is(tests.put_bytes(repeat('6', 64), decode(repeat('ab', 10000), 'hex')), 'stored', 'and then there is room again');
reset role;

select * from finish();
rollback;
