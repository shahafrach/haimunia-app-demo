-- 202610280001: body weight cannot be stored in private_records.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.set_auth(tests.uid('m1'));

select throws_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'bodyweight', 'bw-1', '{"weight":80}') $$,
  '23514', null,
  'a member cannot insert a bodyweight record');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'measurement', 'ms-1', '{"value":90}') $$,
  'the rest of the private log still backs up');

select tests.clear_auth();

select throws_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'bodyweight', 'bw-2', '{"weight":80}') $$,
  '23514', null,
  'not even the superuser can insert one: it is the CHECK, not RLS');

select is(
  (select count(*)::int from public.private_records where record_type = 'bodyweight'),
  0, 'no bodyweight row exists');

select * from finish();
rollback;
