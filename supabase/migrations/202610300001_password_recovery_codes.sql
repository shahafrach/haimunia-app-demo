-- Password recovery without email (202610300001).
--
-- Members sign in with a username mapped to <name>@members.haimuniya.invalid,
-- so Supabase's email reset can never reach anyone. Recovery is a code the
-- member keeps (docs/circles/decisions.md, "Home and recovery"):
--
--   * issue-recovery-code (Edge Function, authenticated) makes a code of four
--     groups of four characters from a 32-symbol alphabet (80 bits), stores only
--     an HMAC-SHA256 of it keyed by the Edge Function secret
--     RECOVERY_CODE_HMAC_SECRET, and returns it once. kind = 'recovery'.
--   * recover-password (Edge Function, no session) checks a code, sets the new
--     password with the admin API, revokes every session and rotates the code.
--   * owner_issue_reset_code(username), run from the Supabase SQL editor, gives
--     a friend who lost the code a one-use code valid for one hour. kind =
--     'reset'. Postgres cannot read an Edge Function secret, so a reset code is
--     stored as an HMAC keyed by a random per-row salt instead. The code is 80
--     random bits and lives for an hour, so the salt is all it needs.
--
-- Nothing here is reachable from a browser: both tables have no client grant at
-- all, and every function below is granted to service_role only (or to
-- authenticated, for the one that reports whether the caller has a code), never
-- to anon. FORWARD ONLY.

create table public.recovery_codes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('recovery', 'reset')),
  code_hmac  text not null,
  salt       text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  used_at    timestamptz,
  primary key (user_id, kind),
  check ((kind = 'recovery' and salt is null and expires_at is null)
      or (kind = 'reset' and salt is not null and expires_at is not null))
);
alter table public.recovery_codes enable row level security;
revoke all on public.recovery_codes from public, anon, authenticated;
grant select, insert, update, delete on public.recovery_codes to service_role;

comment on table public.recovery_codes is
  'Password recovery codes (202610300001). Only HMACs, never a code. kind recovery: HMAC-SHA256 keyed by the Edge Function secret RECOVERY_CODE_HMAC_SECRET, rotated on every use. kind reset: issued by owner_issue_reset_code from the SQL editor, HMAC keyed by a per-row salt, one use, expires_at an hour after issue. No policy and no grant for anon or authenticated; the Edge Functions use service_role.';

-- Attempts at recover-password, by the hash of the username and of the IP: 5 per
-- 15 minutes per key is counted by the Edge Function. Only hashes are stored.
create table public.recovery_attempts (
  id           bigint generated always as identity primary key,
  key_hash     text not null,
  attempted_at timestamptz not null default now()
);
create index recovery_attempts_key_idx on public.recovery_attempts (key_hash, attempted_at);
alter table public.recovery_attempts enable row level security;
revoke all on public.recovery_attempts from public, anon, authenticated;
grant select, insert, delete on public.recovery_attempts to service_role;

comment on table public.recovery_attempts is
  'recover-password attempts (202610300001): an HMAC of the username or of the IP address and a time. The Edge Function counts the last 15 minutes and deletes rows older than a day. service_role only.';

-- ---------------------------------------------------------------------------
-- The code alphabet is shared with the Edge Function (supabase/functions/_shared/recovery.mjs).
-- ---------------------------------------------------------------------------
create or replace function public.recovery_lookup_user(p_username text)
returns uuid language sql security definer stable set search_path = '' as $$
  select u.id from auth.users u
   where u.email = lower(btrim(p_username)) || '@members.haimuniya.invalid'
     and not coalesce(u.is_anonymous, false)
     and u.deleted_at is null
   limit 1;
$$;
revoke all on function public.recovery_lookup_user(text) from public, anon, authenticated;
grant execute on function public.recovery_lookup_user(text) to service_role;
comment on function public.recovery_lookup_user(text) is
  'recover-password helper (202610300001): the auth user id behind a username (its synthetic address), or null. A permanent account only. service_role only.';

create or replace function public.recovery_revoke_sessions(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- refresh_tokens go with their session (on delete cascade); the explicit
  -- delete covers rows the cascade would not reach.
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
end $$;
revoke all on function public.recovery_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.recovery_revoke_sessions(uuid) to service_role;
comment on function public.recovery_revoke_sessions(uuid) is
  'recover-password helper (202610300001): signs a member out everywhere after a password recovery. service_role only.';

-- Spends a reset code. True only for the right code, unused and unexpired, and
-- it marks it used in the same statement, so a reset code works exactly once.
create or replace function public.recovery_consume_reset_code(p_user_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  v_n int;
begin
  if length(v_norm) <> 16 then return false; end if;
  update public.recovery_codes r
     set used_at = now()
   where r.user_id = p_user_id and r.kind = 'reset'
     and r.used_at is null and r.expires_at > now()
     and r.code_hmac = encode(extensions.hmac('box-log:reset-code:v1:' || v_norm, r.salt, 'sha256'), 'hex');
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;
revoke all on function public.recovery_consume_reset_code(uuid, text) from public, anon, authenticated;
grant execute on function public.recovery_consume_reset_code(uuid, text) to service_role;
comment on function public.recovery_consume_reset_code(uuid, text) is
  'recover-password helper (202610300001): true once for the right, unused, unexpired reset code (marks it used), false otherwise. service_role only.';

-- Does the caller have a recovery code yet? The Me screen prompts the members
-- who signed up before codes existed. Returns when it was made, or null.
create or replace function public.my_recovery_code_created_at()
returns timestamptz language sql security definer stable set search_path = '' as $$
  select r.created_at from public.recovery_codes r
   where r.user_id = auth.uid() and r.kind = 'recovery';
$$;
revoke all on function public.my_recovery_code_created_at() from public, anon;
grant execute on function public.my_recovery_code_created_at() to authenticated;
comment on function public.my_recovery_code_created_at() is
  'When the caller''s recovery code was made, or null when there is none (202610300001). Reads only the caller''s own row; never the code or its HMAC.';

-- The owner's fallback for a friend who lost the code. Granted to NO role: it is
-- reachable only from the Supabase SQL editor (which runs as postgres), like
-- bootstrap_owner_invite().   select public.owner_issue_reset_code('username');
create or replace function public.owner_issue_reset_code(p_username text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_user uuid;
  v_bytes bytea := extensions.gen_random_bytes(16);
  v_norm text := '';
  v_salt text;
  i int;
begin
  -- Not a member-callable function: the grants give EXECUTE to nobody. This is
  -- the second lock: an API call carries a JWT subject, the SQL editor does not.
  if auth.uid() is not null then
    raise exception 'not authorized';
  end if;

  v_user := public.recovery_lookup_user(p_username);
  if v_user is null then
    raise exception 'no such member: %', coalesce(p_username, '');
  end if;

  for i in 0..15 loop
    v_norm := v_norm || substr(c_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  v_salt := encode(extensions.gen_random_bytes(16), 'hex');

  -- One reset code per member at a time: a new one replaces the old.
  insert into public.recovery_codes (user_id, kind, code_hmac, salt, created_at, expires_at, used_at)
  values (v_user, 'reset',
          encode(extensions.hmac('box-log:reset-code:v1:' || v_norm, v_salt, 'sha256'), 'hex'),
          v_salt, now(), now() + interval '1 hour', null)
  on conflict (user_id, kind) do update
     set code_hmac = excluded.code_hmac, salt = excluded.salt, created_at = excluded.created_at,
         expires_at = excluded.expires_at, used_at = null;

  return substr(v_norm, 1, 4) || '-' || substr(v_norm, 5, 4) || '-' || substr(v_norm, 9, 4) || '-' || substr(v_norm, 13, 4);
end $$;
revoke all on function public.owner_issue_reset_code(text) from public, anon, authenticated, service_role;
comment on function public.owner_issue_reset_code(text) is
  'Owner-only password reset (202610300001). Returns a one-use reset code for the named member, valid for one hour, stored only as a salted HMAC. EXECUTE is granted to no role: run it from the Supabase SQL editor as postgres. Refuses any call that carries an auth.uid(). recover-password accepts it in place of the recovery code.';
