-- Two-step login (TOTP) enforced by the database, not only by the screen.
--
-- A member who has a verified authenticator factor must hold an aal2 session
-- (password AND code) to read or write anything. A password-only session (aal1)
-- is good for exactly one thing: proving the code, or using the recovery code
-- (Edge Function mfa-recovery). Members without a factor are unaffected: for
-- them the check is true at once.
--
--   * public.aal_satisfied(): true when the caller has no verified factor, or
--     the JWT says aal2. Definer, so it can read auth.mfa_factors; the caller
--     never needs a grant on the auth schema.
--   * public.is_community_member() now also requires it. Every circle read and
--     every circle RPC already goes through that function.
--   * A RESTRICTIVE policy "aal2_required" on every public table that has a
--     policy for clients today: restrictive policies are ANDed with the
--     permissive ones, so no existing policy changes. Tables with no policy
--     (reachable only by definer functions or service_role) are left alone.
--     supabase/tests/0148_mfa_aal2_test.sql fails if a table with policies
--     lacks it, so a table added later cannot slip past.
--
-- FORWARD ONLY. Applied migrations are not edited.

create or replace function public.aal_satisfied()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = auth.uid() and f.status = 'verified'
      );
$$;
revoke all on function public.aal_satisfied() from public, anon;
grant execute on function public.aal_satisfied() to authenticated, service_role;

-- Same body as before (202610250004), plus the aal2 requirement.
create or replace function public.is_community_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.aal_satisfied() and exists (
    select 1
      from public.circle_members m
      join public.profiles p on p.id = m.user_id
     where m.user_id = auth.uid() and p.deleted_at is null
  );
$$;

do $$
declare t record;
begin
  for t in
    select distinct c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_policy p on p.polrelid = c.oid
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
       and p.polname <> 'aal2_required'
  loop
    execute format('drop policy if exists aal2_required on public.%I', t.relname);
    execute format(
      'create policy aal2_required on public.%I as restrictive for all to authenticated '
      || 'using ((select public.aal_satisfied())) with check ((select public.aal_satisfied()))',
      t.relname);
  end loop;
end $$;
