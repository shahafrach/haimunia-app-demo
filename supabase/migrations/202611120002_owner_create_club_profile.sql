-- 202611120002: owner_create_club works for an owner who has no profile yet.
--
-- Found on the first real run (2026-11-12): the owner signed up in the club app and stopped at
-- "join by the link". No club exists yet, so there is no link, and no profile row either: in this
-- schema a profile is created by join_circle. owner_create_club then inserts a club whose
-- created_by, and a circle_members row whose user_id, both reference profiles(id), and fails.
-- owner_user_by_name also refused an account with no profile (it meant to refuse deleted ones).
-- The fix: owner_user_by_name refuses only an account whose profile is deleted, and
-- owner_create_club creates the same minimal profile join_circle creates (on conflict do nothing).
-- Nothing else changes. Both functions stay granted to no role.

begin;

create or replace function public.owner_user_by_name(p_who text)
returns uuid language plpgsql stable set search_path = '' as $$
declare v_id uuid;
begin
  if p_who ~ '^sha256:[0-9a-f]{64}$' then
    select u.id into v_id from auth.users u
     where u.email like '%@members.haimuniya.invalid'
       and encode(extensions.digest(split_part(u.email, '@', 1), 'sha256'), 'hex') = substr(p_who, 8)
       and not coalesce(u.is_anonymous, false) and u.deleted_at is null
     limit 1;
  else
    select u.id into v_id from auth.users u
     where u.email = lower(btrim(coalesce(p_who, ''))) || '@members.haimuniya.invalid'
       and not coalesce(u.is_anonymous, false) and u.deleted_at is null
     limit 1;
  end if;
  -- A deleted account is refused. An account with no profile yet (signed up, not yet in any
  -- circle) is a real member and is found: owner_create_club gives it its profile.
  if v_id is not null and exists (select 1 from public.profiles p where p.id = v_id and p.deleted_at is not null) then
    return null;
  end if;
  return v_id;
end $$;
revoke all on function public.owner_user_by_name(text) from public, anon, authenticated, service_role;

create or replace function public.owner_create_club(p_owner text, p_name text, p_emoji text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_name text;
  v_emoji text;
  v_id uuid;
begin
  if auth.uid() is not null then raise exception 'not authorized'; end if;
  if exists (select 1 from public.clubs c where c.type = 'club') then return 'exists'; end if;
  v_uid := public.owner_user_by_name(p_owner);
  if v_uid is null then return 'no_such_user'; end if;
  v_name := left(btrim(regexp_replace(coalesce(p_name, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g')), 40);
  if v_name = '' then raise exception 'a club needs a name'; end if;
  v_emoji := nullif(btrim(coalesce(p_emoji, '')), '');
  if v_emoji is not null and char_length(v_emoji) > 16 then raise exception 'emoji is too long'; end if;

  -- The owner may have signed up in the club app and stopped at "join by the link", which is
  -- before any profile exists (join_circle is what creates one). Give them the same minimal
  -- profile join_circle would, so the club and the membership below have their row.
  insert into public.profiles (id, handle)
  values (v_uid, 'u' || substr(md5(v_uid::text), 1, 20))
  on conflict (id) do nothing;

  insert into public.clubs (name, type, emoji, created_by)
  values (v_name, 'club', coalesce(v_emoji, E'\U0001F4AA'), v_uid)
  returning id into v_id;
  begin
    insert into public.circle_members (club_id, user_id, role, share_defaults)
    values (v_id, v_uid, 'owner', public.circle_share_defaults('club'));
  exception when others then
    if sqlerrm = 'too_many_circles' then
      delete from public.clubs where id = v_id;
      return 'too_many_circles';
    end if;
    raise;
  end;
  return 'created';
end $$;
revoke all on function public.owner_create_club(text, text, text) from public, anon, authenticated, service_role;

commit;
