-- The admin flag belongs to the management account, and to nothing else.
-- 2026-09-15, at the owner's instruction: "Remove admin from them."
--
-- WHAT THIS FINISHES. The client half landed in e399761: management is a
-- separate identity now, with its own credentials typed into a gate, and the
-- app no longer asks whether the signed-in member is an admin before letting
-- them open a management panel. The owner's stated reason is that they also
-- train on this app and want the two kept apart.
--
-- But until this migration the separation was CLIENT-SIDE ONLY. Three
-- accounts carried profiles.is_admin:
--
--     admin      (haimuniya@gmail.com)  - the management account
--     שלומי      - the owner's own training account
--     shahaf     - the owner's second personal account
--
-- public.is_admin() reads that column, and RLS reads is_admin(). So those two
-- personal accounts' tokens authorised every admin RPC in the database
-- directly - the audit log, role grants, password resets, member removal -
-- no matter what the client did or did not render. A separation that exists
-- only in the UI is not a separation; it is a convention that the next bug
-- breaks. This is the half that makes it real.
--
-- EXPRESSED AS A RULE, NOT AS TWO NAMES. Naming the two handles would fix
-- today and say nothing about tomorrow. The rule is the thing worth writing
-- down: the is_admin COLUMN is reserved for the bootstrap management account,
-- the one 202609150003 created and the only one with a real mailbox behind it
-- (which is what lets it receive a password reset). Everyone else who needs
-- admin authority gets it the modern way - a redeemed role of 'admin' or
-- 'owner', which public.is_admin() already honours through role_rank() >= 50.
-- Nobody loses a route to authority here; they lose a second, older one that
-- bypasses the role model.
--
-- SAFE ON A DATABASE THAT HAS NO SUCH ACCOUNT. On a fresh CI database
-- (supabase start) no auth user has that address, so the subquery is NULL,
-- `p.id is distinct from NULL` is true for every row, and this would clear
-- the flag everywhere. That is why the guard below refuses to run at all
-- unless the management account is actually present: a migration that
-- silently de-admins an entire fixture database is a worse outcome than one
-- that does nothing.

do $$
declare
  v_mgmt uuid;
  v_cleared int;
begin
  select u.id into v_mgmt from auth.users u where u.email = 'haimuniya@gmail.com';

  if v_mgmt is null then
    -- No management account on this database - a fresh CI or local instance.
    -- Nothing to separate FROM, so there is nothing to do.
    raise notice 'admin_is_its_own_account: no management account present, skipping';
    return;
  end if;

  update public.profiles p
     set is_admin = false
   where p.is_admin
     and p.id <> v_mgmt;
  get diagnostics v_cleared = row_count;

  raise notice 'admin_is_its_own_account: cleared profiles.is_admin from % account(s)', v_cleared;

  -- The management account must still hold it, or this migration has just
  -- locked everyone out of the admin panel. Belt and braces: the update above
  -- excludes it by id, so this can only fail if the flag was already missing.
  if not exists (select 1 from public.profiles where id = v_mgmt and is_admin) then
    raise exception 'admin_is_its_own_account: the management account does not hold is_admin - refusing to leave the club with no admin at all';
  end if;
end $$;

comment on column public.profiles.is_admin is
  'Reserved for the bootstrap management account (202609150006). Every other account that needs admin authority holds a redeemed role of admin/owner instead, which public.is_admin() honours through role_rank() >= 50. Kept as a column because the bootstrap account has to be able to exist before any invite does. A personal account must never carry this: management is a separate identity from the member using the app, and this column is what public.is_admin() - and therefore RLS - actually reads.';
