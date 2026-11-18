-- 202611180003: a password reset the coach hands over, and the owner's own way back (Q-38, Q-38b; launch blocker).
--
-- WHY. The club app had no forgot-password path. The owner forgot his own password on 2026-11-18 and was stuck,
-- with no coach to help; older members will be too. The recovery code (202610300001) works only for a member who
-- kept it, and owner_issue_reset_code runs only from the SQL editor. Owner decisions (2026-11-18): one screen with
-- one field, the code the coach gives; the owner and the coach can reset a member; the owner's own fallback runs
-- from GitHub Actions, with no SQL by hand. No email, no SMS.
--
-- WHAT.
--   member_reset_codes             one live reset code per member: sha256 (hex, with a domain prefix) of an
--                                  8-character code from the Q-37 alphabet (join_code_generate), 24 hours, one use.
--                                  service_role only; no client role can read it.
--   club_issue_reset_code(club, member)
--                                  the owner or the coach of that club, for a member of that club. Never for the
--                                  caller (they are signed in) and never for the owner (a coach must not be able
--                                  to take over the owner's account). aal2 when the caller has MFA; 10 a day per
--                                  staff member; staff-logged as member_password_reset (club_staff_actions).
--                                  Returns the code once. A new code replaces the member's previous one.
--   member_reset_consume(code)     recover-password's code-only branch: spends a live code once and returns the
--                                  member's id and username, or null. service_role only.
--   owner_approve_reset_request(who, ref)
--                                  the owner's fallback, run by club-admin.yml (action approve_reset) through the
--                                  Management API. The owner asks for the self-service reset on his phone
--                                  (request-reset, 202611100001); the phone shows a short reference (the first 6
--                                  hex characters of that request's token HMAC). This ends the one-hour wait for
--                                  that request only, when the reference matches. Nothing usable is printed: the
--                                  repository is public, so its logs are, and the request token stays on the
--                                  phone. Granted to no role; refuses a call that carries an auth.uid().
--
-- GUESSING A RESET CODE. recover-password's code-only branch allows 5 attempts per 15 minutes per IP (the
-- recover-password IP key) and 60 per 15 minutes in all. With a handful of live codes in 31^8 = 8.5 * 10^11 that
-- is far beyond a lifetime of guessing; each code also dies after 24 hours or one use.

create table public.member_reset_codes (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  code_hash  text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  club_id    uuid references public.clubs (id) on delete cascade,
  issued_by  uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  check (expires_at > created_at)
);
alter table public.member_reset_codes enable row level security;
revoke all on public.member_reset_codes from public, anon, authenticated;
grant select, insert, update, delete on public.member_reset_codes to service_role;
comment on table public.member_reset_codes is
  'Password reset codes a club''s owner or coach issues (202611180003): sha256 of an 8-character code, 24 hours, one use, one per member. service_role only.';

-- The staff log learns the new action.
alter table public.club_staff_actions drop constraint club_staff_actions_action_check;
alter table public.club_staff_actions add constraint club_staff_actions_action_check check (action in (
  'member_remove', 'post_remove', 'link_rotate',
  'announcement_post', 'announcement_pin', 'announcement_unpin', 'announcement_delete',
  'member_password_reset'
));

create or replace function public.member_reset_hash(p_code text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest('haimunia:member-reset:v1:' || public.join_code_normalize(p_code), 'sha256'), 'hex')
$$;
revoke all on function public.member_reset_hash(text) from public, anon, authenticated;

create or replace function public.club_issue_reset_code(p_club_id uuid, p_user_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_code text;
begin
  -- F-028 (202611180001): a password-only session of a member with a verified MFA factor is refused.
  if not public.aal_satisfied() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if v_uid is null then raise exception 'not authorized'; end if;
  perform 1 from public.clubs c where c.id = p_club_id and c.type = 'club';
  if not found or not public.is_club_staff(p_club_id) then raise exception 'not authorized'; end if;
  if p_user_id is null or p_user_id = v_uid then raise exception 'not authorized'; end if;
  select m.role into v_role from public.circle_members m where m.club_id = p_club_id and m.user_id = p_user_id;
  if v_role is null then raise exception 'member not found'; end if;
  -- The owner's account is never reset from the app: a coach must not be able to take it over.
  if v_role = 'owner' then raise exception 'not authorized'; end if;
  if not public.check_rate_limit('club_issue_reset_code', 10, 1440) then raise exception 'rate_limited'; end if;

  v_code := public.join_code_generate();
  insert into public.member_reset_codes (user_id, code_hash, club_id, issued_by, created_at, expires_at, used_at)
  values (p_user_id, public.member_reset_hash(v_code), p_club_id, v_uid, now(), now() + interval '24 hours', null)
  on conflict (user_id) do update
     set code_hash = excluded.code_hash, club_id = excluded.club_id, issued_by = excluded.issued_by,
         created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = null;
  perform public.club_staff_log(p_club_id, 'member_password_reset', p_user_id);
  return v_code;
end $$;
revoke all on function public.club_issue_reset_code(uuid, uuid) from public, anon;
grant execute on function public.club_issue_reset_code(uuid, uuid) to authenticated;

create or replace function public.member_reset_consume(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := public.join_code_normalize(p_code);
  v_user uuid;
  v_email text;
begin
  if v_code !~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$' then return null; end if;
  update public.member_reset_codes r
     set used_at = now()
   where r.code_hash = public.member_reset_hash(v_code) and r.used_at is null and r.expires_at > now()
  returning r.user_id into v_user;
  if v_user is null then return null; end if;
  select u.email into v_email from auth.users u
   where u.id = v_user and not coalesce(u.is_anonymous, false) and u.deleted_at is null
     and u.email like '%@members.haimuniya.invalid';
  if v_email is null then return null; end if;
  return jsonb_build_object('user_id', v_user, 'username', split_part(v_email, '@', 1));
end $$;
revoke all on function public.member_reset_consume(text) from public, anon, authenticated;
grant execute on function public.member_reset_consume(text) to service_role;

create or replace function public.owner_approve_reset_request(p_who text, p_ref text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_ref text := upper(regexp_replace(coalesce(p_ref, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_row public.reset_requests;
begin
  -- Not a member-callable function: the grants give EXECUTE to nobody. An API call carries a JWT subject.
  if auth.uid() is not null then raise exception 'not authorized'; end if;
  if length(v_ref) <> 6 then return 'bad_ref'; end if;
  v_user := public.owner_user_by_name(p_who);
  if v_user is null then return 'no_such_user'; end if;
  select * into v_row from public.reset_requests r where r.user_id = v_user for update;
  if not found then return 'no_request'; end if;
  if v_row.cancelled_at is not null then return 'cancelled'; end if;
  if v_row.expires_at <= now() then return 'expired'; end if;
  if upper(left(v_row.token_hmac, 6)) <> v_ref then return 'no_match'; end if;
  if v_row.ready_at <= now() then return 'already'; end if;
  update public.reset_requests r set ready_at = greatest(now(), r.created_at + interval '1 millisecond')
   where r.user_id = v_user;
  return 'approved';
end $$;
revoke all on function public.owner_approve_reset_request(text, text) from public, anon, authenticated, service_role;
comment on function public.owner_approve_reset_request(text, text) is
  'Owner fallback (202611180003): ends the one-hour wait of the named member''s open self-service reset when the 6-character reference the phone shows matches. Granted to no role; club-admin.yml approve_reset. Returns one status word.';
