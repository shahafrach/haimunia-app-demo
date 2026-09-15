-- One-time bootstrap of the club's own admin and head-coach accounts
-- (2026-09-15), at the club owner's request.
--
-- THE CHICKEN AND EGG THIS SOLVES. Every role in this module is granted by
-- someone who already holds a higher one: admin_grant_coach() and
-- admin_set_role() both require is_admin(). That is correct and stays, but it
-- has no answer for the very first admin, and "promote yourself by hand in the
-- SQL editor" is not a step that should live in a person's memory instead of
-- in the repository.
--
-- WHY IT IS SAFE TO RUN ANYWHERE, including a fresh local stack and CI. Every
-- statement below is keyed on an auth.users row matched BY EMAIL and is a
-- no-op when that row does not exist. A developer's laptop has no user with
-- these addresses, so this migration does nothing there - it is not
-- environment-dependent, it is account-dependent, which is a property the
-- database itself can check rather than something the runner has to know.
-- It is also idempotent: re-running promotes an already-promoted account to
-- the same state.
--
-- WHY NO PASSWORD APPEARS HERE. The accounts themselves were created through
-- the ordinary /auth/v1/signup endpoint, so their credentials live in
-- auth.users as a bcrypt hash and nowhere else. This file only grants ROLES to
-- accounts that already exist. A password in a migration would be a password
-- in the repository, and this repository is served publicly by GitHub Pages.
--
-- WHY THE ADMIN ACCOUNT USES A REAL EMAIL AND THE HEAD COACH DOES NOT. Every
-- ordinary member is username-only, mapped onto the non-routable
-- @members.haimuniya.invalid domain, which is what lets this club collect no
-- email addresses at all. The exception is the account that must be
-- recoverable WITHOUT another admin - the sole admin's own - because "ask an
-- admin to reset it" has no answer when the locked-out person is the only
-- admin. A real address makes Supabase's own password-reset mail work for
-- exactly that one account. cloud.js's login() accepts either form.

-- =====================================================================
-- 1. The admin
-- =====================================================================
insert into public.profiles (id, handle, display_name, recovery_verified_at)
select u.id, 'admin', 'ניהול', now()
from auth.users u
where u.email = 'haimuniya@gmail.com'
on conflict (id) do nothing;

-- Separate from the insert on purpose: an account that already had a profile
-- (it logged into the app before this ran) must still be promoted, and
-- `on conflict do nothing` above would have skipped it silently.
update public.profiles p
set is_admin = true,
    -- A profile created by the app starts with recovery_verified_at null until
    -- credentials are set; this account has real credentials by construction.
    recovery_verified_at = coalesce(p.recovery_verified_at, now())
from auth.users u
where u.id = p.id and u.email = 'haimuniya@gmail.com';

-- =====================================================================
-- 2. The head coach
-- =====================================================================
insert into public.profiles (id, handle, display_name, recovery_verified_at)
select u.id, 'headcoach', 'מאמן/ת ראשי/ת', now()
from auth.users u
where u.email = 'headcoach@members.haimuniya.invalid'
on conflict (id) do nothing;

-- my_role_code() resolves a role from invite_redemptions.role (or the legacy
-- is_admin flag), taking the highest-ranked of the two. A head coach is a
-- redeemed role, not an is_admin flag - that distinction is the whole point of
-- the rank ladder, and setting is_admin here would have silently made them an
-- admin instead of a head coach.
--
-- A redemption MUST name exactly one invite source
-- (invite_redemptions_one_invite_source: num_nonnulls(invite_id,
-- person_invite_id) = 1), so a real invite row is created for it rather than
-- a redemption with neither. The two columns are NOT interchangeable and the
-- names invert what you would guess: invite_id references invite_codes (a
-- shared, multi-use club code) while person_invite_id references invites (a
-- single named person). This is a per-person grant, so it is the latter. That is not a fiction to satisfy a constraint -
-- it is the truth: the club is issuing an invite to its own head coach, and
-- the audit trail should say so, attributed to the admin account above as the
-- creator.
--
-- code_hash is a sha256 of a code that is deliberately never generated and
-- never handed out: this invite is consumed in the same statement block that
-- creates it, so there is no window in which anyone could redeem it. Storing
-- a digest of a random value rather than of a known string means that even if
-- the hash were somehow reversed it names no usable code.
insert into public.invites (id, code_hash, role, label, created_by, created_at, redeemed_at, redeemed_by)
select 'aaaaaaaa-0915-4000-8000-000000000001'::uuid,
       encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
       'coach', 'בוטסטראפ: מאמן/ת ראשי/ת',
       (select a.id from auth.users a where a.email = 'haimuniya@gmail.com'),
       now(), now(), u.id
from auth.users u
where u.email = 'headcoach@members.haimuniya.invalid'
on conflict (id) do nothing;

insert into public.invite_redemptions (user_id, role, redeemed_at, person_invite_id)
select u.id, 'head_coach', now(), 'aaaaaaaa-0915-4000-8000-000000000001'::uuid
from auth.users u
where u.email = 'headcoach@members.haimuniya.invalid'
  and exists (select 1 from public.invites i where i.id = 'aaaaaaaa-0915-4000-8000-000000000001'::uuid)
on conflict (user_id) do update set role = 'head_coach';
