-- Circles RPCs, part 1: lifecycle, invites, joining, member settings.
--
-- The functions behind circle creation, settings, leaving, removal, invites and
-- joining (docs/circles/decisions.md: Product, Lifecycle, Auth), plus the
-- storage for the benchmark of the month. Sharing and the weekly view follow in
-- 202610250005 and 202610250006.
--
-- Every function here is SECURITY DEFINER with search_path '', closed to PUBLIC
-- and anon, and listed in tests.definer_reviewed (supabase/tests/0135).
--
-- ONE PATH FOR "A MEMBER IS GONE". Leaving, removal and account deletion all end
-- in a DELETE on circle_members, and the clean-up (the member's posts, reactions,
-- tags and benchmark results in that circle; ownership handoff; deleting an empty
-- circle) lives in one AFTER DELETE trigger. Three RPCs each carrying their own
-- copy of it would drift; a cascade from auth.users would carry none.
--
-- ANONYMOUS SIGN-INS STAY ON (decision of 2026-10-25, reversing the earlier "off").
-- Sign-up starts anonymous, joins a circle with join_circle, then upgrades to a
-- username and password. An anonymous user who is in no circle sees nothing:
-- every read policy resolves through circle membership.
--
-- FORWARD ONLY. No applied migration is edited.
begin;

-- 0. A fix to 202610250003: deleting an account must not be blocked ----------
-- clubs.created_by is ON DELETE SET NULL, and that cascade is an UPDATE of
-- created_by to NULL. clubs_guard_immutable refused ANY change to created_by,
-- so deleting the account of a circle's creator failed with "a circle's type,
-- creator and id cannot change" and the purge job (purge_due_accounts) would
-- have stalled on it. The creator can still never be CHANGED, only cleared.
create or replace function public.clubs_guard_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type is distinct from old.type
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'a circle''s type, creator and id cannot change';
  end if;
  return new;
end $$;

-- 1. The benchmark of the month: the owner's pick ----------------------------
-- The eight named benchmarks the app already has (BENCHMARK_WOD_IDS in app.js).
alter table public.clubs
  add column benchmark text
    constraint clubs_benchmark_check
    check (benchmark in ('fran', 'grace', 'helen', 'diane', 'cindy', 'murph', 'isabel', 'karen')),
  add column benchmark_month date
    constraint clubs_benchmark_month_check
    check (benchmark_month is null or extract(day from benchmark_month) = 1);

-- Choosing a benchmark stamps the current month (Asia/Jerusalem), whichever path
-- wrote it, so a pick can never carry a month the owner did not choose it in.
create or replace function public.clubs_stamp_benchmark_month()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.benchmark is null then
    new.benchmark_month := null;
  else
    new.benchmark_month := date_trunc('month', now() at time zone 'Asia/Jerusalem')::date;
  end if;
  return new;
end $$;
revoke all on function public.clubs_stamp_benchmark_month() from public, anon;
create trigger clubs_stamp_benchmark_month_trigger
  before insert or update of benchmark on public.clubs
  for each row execute function public.clubs_stamp_benchmark_month();

create table public.benchmark_results (
  club_id      uuid not null references public.clubs (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  benchmark    text not null
    check (benchmark in ('fran', 'grace', 'helen', 'diane', 'cindy', 'murph', 'isabel', 'karen')),
  month        date not null check (extract(day from month) = 1),
  result       text not null check (char_length(result) between 1 and 40),
  rx_or_scaled text not null check (rx_or_scaled in ('rx', 'scaled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (club_id, user_id, benchmark, month)
);
create index benchmark_results_user_id_idx on public.benchmark_results (user_id);
alter table public.benchmark_results enable row level security;
create trigger benchmark_results_touch
  before update on public.benchmark_results
  for each row execute function public.touch_updated_at();

-- "Have I logged mine?" A policy on benchmark_results cannot ask that of
-- benchmark_results itself (Postgres refuses the recursion), so the question is
-- a definer helper that reads only the caller's own row.
create or replace function public.has_logged_benchmark(p_club_id uuid, p_benchmark text, p_month date)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.benchmark_results r
     where r.club_id = p_club_id and r.benchmark = p_benchmark and r.month = p_month
       and r.user_id = auth.uid()
  );
$$;
revoke all on function public.has_logged_benchmark(uuid, text, date) from public, anon;
grant execute on function public.has_logged_benchmark(uuid, text, date) to authenticated, service_role;

grant select, insert, update, delete on public.benchmark_results to authenticated;

-- A member sees others' results only after logging their own for the same
-- benchmark and month. Enforced here, not in the client.
create policy benchmark_results_read on public.benchmark_results for select to authenticated
  using (
    public.is_circle_member(club_id)
    and (user_id = auth.uid() or public.has_logged_benchmark(club_id, benchmark, month))
  );
-- Writes: mine, in a circle I am in, for the benchmark the owner picked this month.
create policy benchmark_results_insert_self on public.benchmark_results for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_circle_member(club_id)
    and exists (
      select 1 from public.clubs c
       where c.id = benchmark_results.club_id
         and c.benchmark_enabled
         and c.benchmark = benchmark_results.benchmark
         and c.benchmark_month = benchmark_results.month
         and c.benchmark_month = date_trunc('month', now() at time zone 'Asia/Jerusalem')::date
    )
  );
create policy benchmark_results_update_self on public.benchmark_results for update to authenticated
  using (user_id = auth.uid() and public.is_circle_member(club_id))
  with check (
    user_id = auth.uid()
    and public.is_circle_member(club_id)
    and exists (
      select 1 from public.clubs c
       where c.id = benchmark_results.club_id
         and c.benchmark_enabled
         and c.benchmark = benchmark_results.benchmark
         and c.benchmark_month = benchmark_results.month
         and c.benchmark_month = date_trunc('month', now() at time zone 'Asia/Jerusalem')::date
    )
  );
create policy benchmark_results_delete_self on public.benchmark_results for delete to authenticated
  using (user_id = auth.uid());

-- 2. A member is gone: clean up after them ------------------------------------
create or replace function public.circle_members_after_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_next uuid;
begin
  -- The circle itself is being deleted (the last member left, or a cascade from
  -- clubs): the cascade removes everything, nothing to hand off.
  perform 1 from public.clubs c where c.id = old.club_id for update;
  if not found then return null; end if;

  -- Their notification text about posts that are about to go.
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.notifications n
     set title = '', body = ''
   where n.source_type = 'post'
     and n.source_id in (select p.id from public.workout_posts p
                          where p.club_id = old.club_id and p.author_id = old.user_id)
     and (n.title <> '' or n.body <> '');
  perform set_config('app.allow_moderation_write', 'off', true);

  -- Decision: leaving or removal deletes the member's posts and reactions in
  -- this circle. The private log stays on the device. Reactions on their posts
  -- and tags on their posts cascade with the post.
  delete from public.reactions r
   using public.workout_posts p
   where r.post_id = p.id and p.club_id = old.club_id and r.user_id = old.user_id;
  delete from public.post_training_partners t
   where t.club_id = old.club_id and t.tagged_user_id = old.user_id;
  delete from public.workout_posts p
   where p.club_id = old.club_id and p.author_id = old.user_id;
  delete from public.benchmark_results b
   where b.club_id = old.club_id and b.user_id = old.user_id;

  -- The last member to leave deletes the circle.
  if not exists (select 1 from public.circle_members m where m.club_id = old.club_id) then
    delete from public.clubs where id = old.club_id;
    return null;
  end if;

  -- An owner who leaves passes ownership to the longest-standing member.
  if not exists (select 1 from public.circle_members m
                  where m.club_id = old.club_id and m.role = 'owner') then
    select m.user_id into v_next
      from public.circle_members m
     where m.club_id = old.club_id
     order by m.joined_at, m.user_id
     limit 1;
    update public.circle_members set role = 'owner'
     where club_id = old.club_id and user_id = v_next;
  end if;
  return null;
end $$;
revoke all on function public.circle_members_after_delete() from public, anon;
create trigger circle_members_after_delete_trigger
  after delete on public.circle_members
  for each row execute function public.circle_members_after_delete();

-- 3. Defaults per circle type -------------------------------------------------
-- Couple: shares workouts and PRs, absolute weights hidden. Friends: PRs and
-- percents, workouts only as a weekly count. Keys are the only ones
-- set_share_defaults accepts.
create or replace function public.circle_share_defaults(p_type text)
returns jsonb language sql immutable set search_path = '' as $$
  select case p_type
    when 'couple' then jsonb_build_object(
      'share_workouts', true, 'share_prs', true, 'share_percent', true,
      'share_weekly_count', true, 'show_weights', false)
    else jsonb_build_object(
      'share_workouts', false, 'share_prs', true, 'share_percent', true,
      'share_weekly_count', true, 'show_weights', false)
  end;
$$;
revoke all on function public.circle_share_defaults(text) from public, anon;
grant execute on function public.circle_share_defaults(text) to authenticated, service_role;

-- 4. Circles ------------------------------------------------------------------
create or replace function public.create_circle(p_type text, p_name text, p_emoji text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_emoji text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_type is null or p_type not in ('couple', 'friends') then
    raise exception 'unknown circle type';
  end if;

  -- No public sign-up: a circle is created by someone who got in through an
  -- invite (a circle invite, or the bootstrap code redeem_invite_code takes).
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if not (public.is_community_member()
          or exists (select 1 from public.invite_redemptions ir where ir.user_id = v_uid)) then
    raise exception 'not authorized';
  end if;
  if not public.check_rate_limit('create_circle', 10, 60) then raise exception 'rate_limited'; end if;

  v_name := left(btrim(regexp_replace(coalesce(p_name, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']', '', 'g')), 41);
  if v_name = '' then raise exception 'a circle needs a name'; end if;
  if char_length(v_name) > 40 then raise exception 'circle name is too long'; end if;
  v_emoji := nullif(btrim(coalesce(p_emoji, '')), '');
  if v_emoji is not null and char_length(v_emoji) > 16 then raise exception 'emoji is too long'; end if;

  -- Same default as clubs.emoji (202610250003).
  insert into public.clubs (name, type, emoji, created_by)
  values (v_name, p_type, coalesce(v_emoji, E'\U0001F525'), v_uid)
  returning id into v_id;

  -- The limits (10 circles per person) are enforced by circle_members_guard.
  insert into public.circle_members (club_id, user_id, role, share_defaults)
  values (v_id, v_uid, 'owner', public.circle_share_defaults(p_type));
  return v_id;
end $$;

-- Owner only. p_settings holds any of: name, emoji, mode, benchmark_enabled,
-- invite_policy, welcome_line, benchmark (null clears it). Unknown keys and
-- wrong types are refused, so the settings screen cannot half-apply a change.
create or replace function public.update_circle(p_club_id uuid, p_settings jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_name text;
  v_emoji text;
  v_mode text;
  v_enabled boolean;
  v_policy text;
  v_welcome text;
  v_benchmark text;
begin
  if auth.uid() is null or not public.is_circle_owner(p_club_id) then
    raise exception 'not authorized';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' or p_settings = '{}'::jsonb then
    raise exception 'settings are required';
  end if;

  for v_key, v_val in select * from jsonb_each(p_settings) loop
    case v_key
      when 'name' then
        if jsonb_typeof(v_val) <> 'string' then raise exception 'name must be text'; end if;
        v_name := btrim(v_val #>> '{}');
        if char_length(v_name) not between 1 and 40 then raise exception 'name must be 1 to 40 characters'; end if;
      when 'emoji' then
        if jsonb_typeof(v_val) <> 'string' then raise exception 'emoji must be text'; end if;
        v_emoji := btrim(v_val #>> '{}');
        if char_length(v_emoji) not between 1 and 16 then raise exception 'emoji must be 1 to 16 characters'; end if;
      when 'mode' then
        v_mode := v_val #>> '{}';
        if jsonb_typeof(v_val) <> 'string' or v_mode not in ('together', 'weekly_competition') then
          raise exception 'unknown mode';
        end if;
      when 'benchmark_enabled' then
        if jsonb_typeof(v_val) <> 'boolean' then raise exception 'benchmark_enabled must be true or false'; end if;
        v_enabled := (v_val #>> '{}')::boolean;
      when 'invite_policy' then
        v_policy := v_val #>> '{}';
        if jsonb_typeof(v_val) <> 'string' or v_policy not in ('owner', 'any_member') then
          raise exception 'unknown invite policy';
        end if;
      when 'welcome_line' then
        if jsonb_typeof(v_val) <> 'string' then raise exception 'welcome_line must be text'; end if;
        v_welcome := btrim(v_val #>> '{}');
        if char_length(v_welcome) > 200 then raise exception 'welcome line is too long'; end if;
      when 'benchmark' then
        if jsonb_typeof(v_val) not in ('string', 'null') then raise exception 'unknown benchmark'; end if;
        v_benchmark := v_val #>> '{}';
        if v_benchmark is not null
           and v_benchmark not in ('fran', 'grace', 'helen', 'diane', 'cindy', 'murph', 'isabel', 'karen') then
          raise exception 'unknown benchmark';
        end if;
      else
        raise exception 'unknown setting %', v_key;
    end case;
  end loop;

  update public.clubs c set
    name              = coalesce(v_name, c.name),
    emoji             = coalesce(v_emoji, c.emoji),
    mode              = coalesce(v_mode, c.mode),
    benchmark_enabled = coalesce(v_enabled, c.benchmark_enabled),
    invite_policy     = coalesce(v_policy, c.invite_policy),
    welcome_line      = coalesce(v_welcome, c.welcome_line),
    -- The month is stamped by clubs_stamp_benchmark_month when this column is set.
    benchmark         = case when p_settings ? 'benchmark' then v_benchmark else c.benchmark end
   where c.id = p_club_id;
end $$;

create or replace function public.leave_circle(p_club_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Posts, reactions, ownership handoff and the empty-circle delete are the
  -- trigger's (circle_members_after_delete).
  delete from public.circle_members m where m.club_id = p_club_id and m.user_id = v_uid;
  if not found then raise exception 'not authorized'; end if;
end $$;

-- Owner only. An owner cannot be removed (an owner who wants out leaves, and
-- ownership passes on), and removing yourself is leave_circle.
create or replace function public.remove_member(p_club_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if auth.uid() is null or not public.is_circle_owner(p_club_id) then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then raise exception 'member is required'; end if;
  if p_user_id = auth.uid() then raise exception 'use leave_circle'; end if;
  select m.role into v_role from public.circle_members m
   where m.club_id = p_club_id and m.user_id = p_user_id;
  if v_role is null then raise exception 'member not found'; end if;
  if v_role = 'owner' then raise exception 'an owner cannot be removed'; end if;
  delete from public.circle_members m where m.club_id = p_club_id and m.user_id = p_user_id;
end $$;

-- 5. Invites ------------------------------------------------------------------
-- Returns the raw token ONCE; only its sha256 is stored. 32 random bytes as 64
-- hex characters, 7-day expiry, a use limit, 20 per circle per day. Who may
-- invite follows clubs.invite_policy. The default use limit is 1 for a couple
-- and 5 for friends; p_max_uses (1 to 20) overrides it.
create or replace function public.create_circle_invite(p_club_id uuid, p_max_uses integer default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_type text;
  v_policy text;
  v_members integer;
  v_cap integer;
  v_max integer;
  v_token text;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  -- The circle row lock serialises two invites to one circle, so the daily cap
  -- below cannot be raced past.
  select c.type, c.invite_policy into v_type, v_policy
    from public.clubs c where c.id = p_club_id for update;
  if v_type is null or not public.is_circle_member(p_club_id) then
    raise exception 'not authorized';
  end if;
  if v_policy = 'owner' and not public.is_circle_owner(p_club_id) then
    raise exception 'not authorized';
  end if;

  select count(*) into v_members from public.circle_members m where m.club_id = p_club_id;
  v_cap := case v_type when 'couple' then 2 else 20 end;
  if v_members >= v_cap then
    raise exception 'circle_full';
  end if;

  if (select count(*) from public.circle_invites i
       where i.club_id = p_club_id and i.created_at > now() - interval '1 day') >= 20 then
    raise exception 'invite_limit';
  end if;

  v_max := coalesce(p_max_uses, case v_type when 'couple' then 1 else 5 end);
  if v_max < 1 or v_max > 20 then raise exception 'uses must be between 1 and 20'; end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.circle_invites (club_id, token_hash, created_by, expires_at, max_uses)
  values (p_club_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid,
          now() + interval '7 days', v_max);
  return v_token;
end $$;

-- Joins ONE circle. Every call, valid token or not, spends one of the caller's
-- 10 attempts per hour (rate_limits), so guessing is slow. It RETURNS a status
-- instead of raising for refusals: a raise would roll back the attempt count.
--   joined         {status, club_id}
--   already_member {status, club_id}   the invite is not spent
--   circle_full | too_many_circles     the invite is not spent
--   rate_limited | invalid             invalid covers unknown, expired and used up
-- A fresh anonymous account has no profile yet; a successful join creates a
-- bare one (display name and emoji are set afterwards).
create or replace function public.join_circle(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_club uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.check_rate_limit('join_circle', 10, 60) then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.deleted_at is not null) then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  begin
    update public.circle_invites i set uses = i.uses + 1
     where i.token_hash = v_hash and i.uses < i.max_uses and i.expires_at > now()
    returning i.club_id into v_club;
    if v_club is null then return jsonb_build_object('status', 'invalid'); end if;

    if exists (select 1 from public.circle_members m where m.club_id = v_club and m.user_id = v_uid) then
      raise exception 'already_member';
    end if;

    insert into public.profiles (id, handle)
    values (v_uid, 'u' || substr(md5(v_uid::text), 1, 20))
    on conflict (id) do nothing;

    insert into public.circle_members (club_id, user_id, share_defaults)
    select v_club, v_uid, public.circle_share_defaults(c.type)
      from public.clubs c where c.id = v_club;
    return jsonb_build_object('status', 'joined', 'club_id', v_club);
  exception when others then
    -- The block's writes (the use, the profile, the member) are rolled back; the
    -- attempt counted above is not.
    if sqlerrm in ('already_member', 'circle_full', 'too_many_circles') then
      return jsonb_build_object('status', sqlerrm, 'club_id', case when sqlerrm = 'already_member' then v_club end);
    end if;
    raise;
  end;
end $$;

-- 6. Membership predicate -----------------------------------------------------
-- "Member of at least one circle." It was "recovery verified and invite
-- redeemed"; both of those now live elsewhere (the recovery stamp on the
-- profile, the bootstrap code below), and what every member-data policy needs
-- to know is whether the caller is in a circle at all. Reads only the caller's
-- own membership rows.
create or replace function public.is_community_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1
      from public.circle_members m
      join public.profiles p on p.id = m.user_id
     where m.user_id = auth.uid() and p.deleted_at is null
  );
$$;

-- redeem_invite_code: kept ONLY to bootstrap the first circle owner. An operator
-- mints a code in invite_codes (service role; there is no admin RPC), the first
-- person redeems it, creates a profile (profiles_insert_self requires the
-- redemption) and calls create_circle. Redeeming grants NO circle access by
-- itself: it writes one invite_redemptions row, which is_community_member()
-- ignores. Everyone after that joins through join_circle. The per-person
-- `invites` branch is gone with the admin tooling that minted them.
create or replace function public.redeem_invite_code(p_code text, p_actor_key text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_uid_key text;
  v_actor_key text;
  v_attempts integer;
  v_invite_id uuid;
  v_existing_role text;
  v_hash text;
begin
  v_uid := auth.uid();
  if v_uid is null then return 'invalid'; end if;

  select role into v_existing_role from public.invite_redemptions where user_id = v_uid;
  if v_existing_role is not null then return v_existing_role; end if;

  v_uid_key := 'uid:' || v_uid::text;
  -- The raw actor key never lands in a column, only its digest.
  if p_actor_key is null or char_length(p_actor_key) = 0 or char_length(p_actor_key) > 128 then
    v_actor_key := null;
  else
    v_actor_key := 'ak:' || encode(extensions.digest(p_actor_key, 'sha256'), 'hex');
  end if;

  v_attempts := public.bump_invite_attempt(v_uid_key, v_uid);
  if v_actor_key is not null then
    v_attempts := greatest(v_attempts, public.bump_invite_attempt(v_actor_key, v_uid));
  end if;
  if v_attempts > 5 then return 'rate_limited'; end if;
  if p_code is null or p_code !~ '^[a-f0-9]{40,128}$' then return 'invalid'; end if;

  v_hash := encode(extensions.digest(p_code, 'sha256'), 'hex');
  update public.invite_codes set use_count = use_count + 1
   where code_hash = v_hash
     and role = 'member' and active and revoked_at is null
     and (expires_at is null or expires_at > now()) and use_count < max_uses
  returning id into v_invite_id;

  if v_invite_id is not null then
    insert into public.invite_redemptions (user_id, invite_id, role)
    values (v_uid, v_invite_id, 'member');
    return 'member';
  end if;
  return 'invalid';
end $$;

-- Replaced by create_circle_invite (a circle invite, not a community-wide code).
drop function public.create_member_invite(timestamp with time zone, integer);

-- 7. Member settings ----------------------------------------------------------
-- What I share in this circle. Merged over the stored defaults; only the five
-- known keys, only booleans.
create or replace function public.set_share_defaults(p_club_id uuid, p_defaults jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
begin
  if auth.uid() is null or not public.is_circle_member(p_club_id) then
    raise exception 'not authorized';
  end if;
  if p_defaults is null or jsonb_typeof(p_defaults) <> 'object' or p_defaults = '{}'::jsonb then
    raise exception 'defaults are required';
  end if;
  for v_key, v_val in select * from jsonb_each(p_defaults) loop
    if v_key not in ('share_workouts', 'share_prs', 'share_percent', 'share_weekly_count', 'show_weights') then
      raise exception 'unknown setting %', v_key;
    end if;
    if jsonb_typeof(v_val) <> 'boolean' then raise exception '% must be true or false', v_key; end if;
  end loop;
  update public.circle_members m
     set share_defaults = m.share_defaults || p_defaults
   where m.club_id = p_club_id and m.user_id = auth.uid();
end $$;

-- A personal weekly target, the same in every circle (member_targets is one row
-- per person). Any workout counts.
create or replace function public.set_weekly_target(p_target integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_community_member() then raise exception 'not authorized'; end if;
  if p_target is null or p_target < 1 or p_target > 21 then
    raise exception 'target must be between 1 and 21';
  end if;
  insert into public.member_targets (user_id, weekly_target)
  values (auth.uid(), p_target)
  on conflict (user_id) do update set weekly_target = excluded.weekly_target;
end $$;

-- Pause until a date (inclusive), or null to resume. The circle sees "paused"
-- and no percent. A member with no target yet gets 3, which they can change.
create or replace function public.set_pause(p_until date)
returns void language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  if auth.uid() is null or not public.is_community_member() then raise exception 'not authorized'; end if;
  if p_until is not null and (p_until < v_today or p_until > v_today + 180) then
    raise exception 'pause must end within the next 180 days';
  end if;
  insert into public.member_targets (user_id, weekly_target, paused_until)
  values (auth.uid(), 3, p_until)
  on conflict (user_id) do update set paused_until = excluded.paused_until;
end $$;

-- 8. Grants: explicit, authenticated only -------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.create_circle(text, text, text)',
    'public.update_circle(uuid, jsonb)',
    'public.leave_circle(uuid)',
    'public.remove_member(uuid, uuid)',
    'public.create_circle_invite(uuid, integer)',
    'public.join_circle(text)',
    'public.redeem_invite_code(text, text)',
    'public.is_community_member()',
    'public.set_share_defaults(uuid, jsonb)',
    'public.set_weekly_target(integer)',
    'public.set_pause(date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

commit;
