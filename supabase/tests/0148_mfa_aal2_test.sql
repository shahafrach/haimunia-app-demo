-- 202611070002: two-step login enforced by the database.
--
-- Defended here:
--   1. aal_satisfied() is true for a member with no verified factor, and for a member with one only when
--      the JWT says aal2 (a password-only session is refused, an unverified factor does not count).
--   2. aal_satisfied() is closed to anon and PUBLIC, open to authenticated and service_role.
--   3. Every public table that has a client policy also has the restrictive aal2_required policy, so a
--      table added later without it fails here. Tables with no policy are left alone.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', 'plain@members.haimuniya.invalid', false, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e2', 'authenticated', 'authenticated', 'twostep@members.haimuniya.invalid', false, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-0000000000e3', 'authenticated', 'authenticated', 'halfway@members.haimuniya.invalid', false, now(), now());

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('eeeeeeee-1111-4000-8000-0000000000f2', 'eeeeeeee-0000-4000-8000-0000000000e2', 'BOX-LOG', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP'),
  ('eeeeeeee-1111-4000-8000-0000000000f3', 'eeeeeeee-0000-4000-8000-0000000000e3', 'BOX-LOG', 'totp', 'unverified', now(), now(), 'JBSWY3DPEHPK3PXP');

-- Claims with an explicit aal, on top of what tests.set_auth sets.
create or replace function tests.set_auth_aal(p_uid uuid, p_aal text) returns void
language plpgsql as $fn$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_uid::text, 'role', 'authenticated', 'aud', 'authenticated', 'aal', p_aal)::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_uid::text, true);
  perform pg_catalog.set_config('role', 'authenticated', true);
end
$fn$;

-- 1. The rule
select tests.set_auth_aal('eeeeeeee-0000-4000-8000-0000000000e1', 'aal1');
select ok(public.aal_satisfied(), 'no factor: an aal1 session is enough');

select tests.set_auth_aal('eeeeeeee-0000-4000-8000-0000000000e2', 'aal1');
select ok(not public.aal_satisfied(), 'verified factor: a password-only (aal1) session is refused');
select tests.set_auth_aal('eeeeeeee-0000-4000-8000-0000000000e2', 'aal2');
select ok(public.aal_satisfied(), 'verified factor: an aal2 session passes');

select tests.set_auth_aal('eeeeeeee-0000-4000-8000-0000000000e3', 'aal1');
select ok(public.aal_satisfied(), 'an unverified (abandoned) enrolment does not lock the member out');

select tests.clear_auth();
select ok(public.aal_satisfied(), 'no JWT at all (service_role, jobs): not blocked here');

-- 2. Who may call it
select ok(not has_function_privilege('anon', 'public.aal_satisfied()', 'execute'), 'anon cannot execute aal_satisfied');
select ok(has_function_privilege('authenticated', 'public.aal_satisfied()', 'execute'), 'authenticated can (the policies call it)');
select ok(has_function_privilege('service_role', 'public.aal_satisfied()', 'execute'), 'service_role can');
select is((select prosecdef from pg_proc where oid = 'public.aal_satisfied()'::regprocedure), true, 'it is a definer function');
select ok((select 'search_path=""' = any (proconfig) from pg_proc where oid = 'public.aal_satisfied()'::regprocedure), 'with an empty search_path');

-- 3. Every table with a client policy has the restrictive one
select is_empty(
  $$ select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
        and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname <> 'aal2_required')
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'aal2_required' and not p.polpermissive) $$,
  'every table with a client policy also carries the restrictive aal2_required policy');
select ok(
  (select not polpermissive from pg_policy where polrelid = 'public.profiles'::regclass and polname = 'aal2_required'),
  'and it is RESTRICTIVE on profiles (ANDed with the existing policies, never an extra way in)');

select * from finish();
rollback;
