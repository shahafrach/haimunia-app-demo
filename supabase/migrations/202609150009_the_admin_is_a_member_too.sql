-- The admin account could sign in and still be nobody.
-- 2026-09-15: "how i can get in to the admin panel and head coach since i am
-- nobody, also i cant add members".
--
-- THE BUG, and it only became visible once the club was emptied. is_community
-- _member() requires three things: a live profile, a verified recovery method,
-- AND a redeemed invite. 202609150003 gave the head coach all three - it built
-- a real invite row and consumed it in the same statement - but gave the admin
-- account only the first two. is_admin was set instead, and that is a
-- different question: it answers "may this account administer", not "is this
-- account in the club".
--
-- So the owner, signing in with the account that runs the whole app, was
-- refused by every member-data read and write policy in the schema
-- (profiles_read_authenticated, posts_feed_select, announcements_read and
-- every write RPC) and met the redeem-an-invite gate instead of the club. The
-- management panels still worked - those are is_admin() gated, not
-- is_community_member() gated - but nothing else did. While there were four
-- other accounts on the club this was invisible: the owner used שלומי for
-- everything ordinary and the admin account only to administer. Deleting
-- those accounts removed the workaround and left the real gap exposed.
--
-- WHY OWNER AND NOT ADMIN. The rank ladder is member 10, coach 20, head_coach
-- 30, staff 40, admin 50, owner 60. This is the club's own account, the one
-- with the real mailbox behind it and the only one that can recover itself, so
-- owner is the honest label rather than a flattering one - and has_perm()
-- short-circuits on owner, which means the account that must never be locked
-- out of anything cannot be locked out by a missing permission row either.
--
-- The invite row is not a fiction to satisfy a constraint. A redemption must
-- name exactly one invite source (invite_redemptions_one_invite_source), and
-- the truth is that the club is issuing an invite to its own owner. It is
-- consumed in the same block that creates it, so there is no window in which
-- anyone could redeem it, and its code_hash digests a random value that is
-- never generated and never handed out - so even reversed it names no usable
-- code. invites.role permits only 'member' or 'coach', which is why the invite
-- carries 'coach' while the REDEMPTION carries 'owner'; those two columns
-- answer different questions, exactly as the head coach's own rows already do.
do $$
declare
  v_admin uuid;
begin
  select id into v_admin from auth.users where email = 'haimuniya@gmail.com';
  if v_admin is null then
    raise notice 'admin_is_a_member: no admin account on this database, skipping';
    return;
  end if;

  -- All three conditions, not just the one that was missing, so this is true
  -- of the account afterwards regardless of what it looked like before.
  update public.profiles
     set recovery_verified_at = coalesce(recovery_verified_at, now()),
         deleted_at = null
   where id = v_admin;

  insert into public.invites (id, code_hash, role, label, created_by, created_at, redeemed_at, redeemed_by)
  values ('aaaaaaaa-0915-4000-8000-000000000002'::uuid,
          encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
          'coach', 'בוטסטראפ: בעל/ת המועדון',
          v_admin, now(), now(), v_admin)
  on conflict (id) do nothing;

  insert into public.invite_redemptions (user_id, role, redeemed_at, person_invite_id)
  values (v_admin, 'owner', now(), 'aaaaaaaa-0915-4000-8000-000000000002'::uuid)
  on conflict (user_id) do update set role = 'owner';

  -- The point of the whole migration, asserted rather than assumed: if this
  -- account still is not a member of its own club, say so loudly instead of
  -- reporting success and leaving the owner locked out a second time.
  if not exists (
    select 1 from public.profiles p
    join public.invite_redemptions ir on ir.user_id = p.id
    where p.id = v_admin and p.deleted_at is null and p.recovery_verified_at is not null
  ) then
    raise exception 'admin_is_a_member: the admin account is still not a community member';
  end if;

  raise notice 'admin_is_a_member: % is now owner and a full member', v_admin;
end $$;
