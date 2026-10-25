-- Circles schema.
--
-- The database model for circles (docs/circles/decisions.md): a circle is a
-- clubs row, membership is circle_members, and every row tied to a circle is
-- visible only to that circle's members, enforced by RLS. The functions that
-- create, join and share come in the Circles RPCs session; this migration
-- builds the tables, the helpers, the policies and the limits.
--
-- FORWARD ONLY. No applied migration is edited. Production has no users yet,
-- so rows tied to the seeded default club are deleted rather than migrated.
--
-- WHERE club_id STAYS, WHERE IT GOES. club_id becomes NOT NULL with no default
-- on the three tables whose rows belong to exactly one circle: workout_posts,
-- post_training_partners and invites. It is DROPPED from the six tables whose
-- rows belong to a person, not to a circle: profiles (one profile, the same in
-- every circle), achievement_definitions (a global catalogue),
-- member_achievements, notifications, notification_batches and
-- analytics_events. With no default, every kept function that inserts into
-- those six (notif_create, notif_queue_batched, ach_claim, the client's
-- analytics insert) would otherwise fail on every call.
--
-- PROFILE is display name and emoji: bio, is_admin, assigned_coach_id,
-- visible_to_club and the show_* / allow_* / in_leaderboards toggles are
-- dropped.
begin;

-- 1. The seeded default club and everything that hangs off it -----------------
delete from public.post_training_partners;
delete from public.reactions
 where post_id in (select id from public.workout_posts);
delete from public.workout_posts;
delete from public.invites;

-- 2. Realtime: no Realtime (decisions.md, Infrastructure) ---------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
      alter publication supabase_realtime drop table public.notifications;
    end if;
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reactions') then
      alter publication supabase_realtime drop table public.reactions;
    end if;
  end if;
end $$;

-- 3. Policies and functions that must go before their columns do --------------
drop policy if exists achievement_definitions_delete_admin on public.achievement_definitions;
drop policy if exists achievement_definitions_insert_admin on public.achievement_definitions;
drop policy if exists achievement_definitions_update_admin on public.achievement_definitions;
drop policy if exists analytics_events_read_analytics on public.analytics_events;
drop policy if exists clubs_delete_owner on public.clubs;
drop policy if exists clubs_insert_owner on public.clubs;
drop policy if exists clubs_write_owner on public.clubs;
drop policy if exists clubs_read on public.clubs;
drop policy if exists member_achievements_read on public.member_achievements;
drop policy if exists post_training_partners_read on public.post_training_partners;
drop policy if exists posts_feed_select on public.workout_posts;
drop policy if exists posts_insert_self on public.workout_posts;
drop policy if exists posts_select_admin_review on public.workout_posts;
drop policy if exists posts_update_self on public.workout_posts;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_read_authenticated on public.profiles;
drop policy if exists blocks_self_insert on public.blocks;
drop policy if exists reactions_insert_self on public.reactions;
drop policy if exists reactions_visible on public.reactions;

-- 4. clubs becomes the circle row ---------------------------------------------
drop trigger if exists clubs_guard_single_row_trigger on public.clubs;
drop function if exists public.clubs_guard_single_row();

-- 5. Profile: display name and emoji ------------------------------------------
drop trigger if exists profiles_protect_is_admin on public.profiles;
drop function if exists public.protect_is_admin();

alter table public.profiles
  drop column if exists bio,
  drop column if exists is_admin,
  drop column if exists assigned_coach_id,
  drop column if exists visible_to_club,
  drop column if exists show_workout_results,
  drop column if exists show_attendance,
  drop column if exists show_upcoming_booking,
  drop column if exists show_prs,
  drop column if exists show_achievements,
  drop column if exists in_leaderboards,
  drop column if exists allow_follows,
  drop column if exists allow_mentions,
  drop column if exists allow_messages,
  drop column if exists show_in_attendee_lists,
  drop column if exists club_id,
  add column emoji text not null default E'\U0001F642'
    constraint profiles_emoji_check check (char_length(emoji) between 1 and 16);

-- What protect_is_admin() guarded that still exists: the recovery stamp is set
-- by mark_recovery_verified() only.
create or replace function public.profiles_protect_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' then
    if coalesce(current_setting('app.allow_recovery_stamp', true), '') <> 'on' then
      new.recovery_verified_at = old.recovery_verified_at;
    end if;
  end if;
  return new;
end $$;
create trigger profiles_protect_columns
  before update on public.profiles
  for each row execute function public.profiles_protect_columns();

-- 6. club_id off the per-person tables ----------------------------------------
create or replace function public.protect_notification_content()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.allow_moderation_write', true), '') <> 'on' then
    new.user_id = old.user_id;
    new.type = old.type;
    new.category = old.category;
    new.title = old.title;
    new.body = old.body;
    new.source_type = old.source_type;
    new.source_id = old.source_id;
    new.deep_link = old.deep_link;
    new.push_sent_at = old.push_sent_at;
    new.created_at = old.created_at;
  end if;
  return new;
end $$;

alter table public.achievement_definitions drop column club_id;
alter table public.member_achievements drop column club_id;
alter table public.notifications drop column club_id;
alter table public.notification_batches drop column club_id;
alter table public.analytics_events drop column club_id;

-- 4b. Only now can the seeded club go: nothing references it any more.
delete from public.clubs;

alter table public.clubs
  drop column if exists attendee_lists_enabled,
  drop column if exists settings,
  add column type text not null
    constraint clubs_type_check check (type in ('couple', 'friends')),
  add column emoji text not null default E'\U0001F525'
    constraint clubs_emoji_check check (char_length(emoji) between 1 and 16),
  add column created_by uuid references public.profiles (id) on delete set null,
  add column mode text not null default 'together'
    constraint clubs_mode_check check (mode in ('together', 'weekly_competition')),
  add column benchmark_enabled boolean not null default false,
  add column invite_policy text not null default 'owner'
    constraint clubs_invite_policy_check check (invite_policy in ('owner', 'any_member')),
  add column welcome_line text not null default ''
    constraint clubs_welcome_line_check check (char_length(welcome_line) <= 200);

create index clubs_created_by_idx on public.clubs (created_by);

-- Type and creator are fixed at creation; a member cannot rewrite them through
-- the settings policy below.
create or replace function public.clubs_guard_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.type is distinct from old.type
     or new.created_by is distinct from old.created_by
     or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'a circle''s type, creator and id cannot change';
  end if;
  return new;
end $$;
create trigger clubs_guard_immutable_trigger
  before update on public.clubs
  for each row execute function public.clubs_guard_immutable();

-- 7. club_id on the circle-bound tables: NOT NULL, no default, cascade --------
drop function if exists public.default_club_id() cascade;

alter table public.workout_posts
  alter column club_id drop default,
  alter column club_id set not null,
  drop constraint workout_posts_club_id_fkey,
  add constraint workout_posts_club_id_fkey
    foreign key (club_id) references public.clubs (id) on delete cascade;
alter table public.post_training_partners
  alter column club_id drop default,
  alter column club_id set not null,
  drop constraint post_training_partners_club_id_fkey,
  add constraint post_training_partners_club_id_fkey
    foreign key (club_id) references public.clubs (id) on delete cascade;
alter table public.invites
  alter column club_id drop default,
  alter column club_id set not null,
  drop constraint invites_club_id_fkey,
  add constraint invites_club_id_fkey
    foreign key (club_id) references public.clubs (id) on delete cascade;

create index if not exists workout_posts_club_id_idx on public.workout_posts (club_id);
create index if not exists post_training_partners_club_id_idx on public.post_training_partners (club_id);
create index if not exists invites_club_id_idx on public.invites (club_id);

-- A post belongs to exactly one circle, for life; a tag belongs to its post's.
create or replace function public.circle_scope_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.club_id is distinct from old.club_id then
    raise exception 'a row cannot move to another circle';
  end if;
  return new;
end $$;
create trigger workout_posts_circle_immutable
  before update of club_id on public.workout_posts
  for each row execute function public.circle_scope_immutable();
create trigger post_training_partners_circle_immutable
  before update of club_id on public.post_training_partners
  for each row execute function public.circle_scope_immutable();

-- A tag takes its circle from its post, so post_tag_training_partners cannot
-- write a tag into a different circle than the post it tags, and the tagged
-- user must be in that circle.
create or replace function public.post_training_partners_set_circle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_club uuid;
begin
  select p.club_id into v_club from public.workout_posts p where p.id = new.post_id;
  if v_club is null then raise exception 'post not found'; end if;
  if not exists (select 1 from public.circle_members m
                  where m.club_id = v_club and m.user_id = new.tagged_user_id) then
    raise exception 'the tagged member is not in this circle';
  end if;
  new.club_id := v_club;
  return new;
end $$;
revoke all on function public.post_training_partners_set_circle() from public, anon;

-- 8. circle_members -----------------------------------------------------------
create table public.circle_members (
  club_id        uuid not null references public.clubs (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  role           text not null default 'member' check (role in ('owner', 'member')),
  joined_at      timestamptz not null default now(),
  share_defaults jsonb not null default '{}'::jsonb
    check (jsonb_typeof(share_defaults) = 'object' and pg_column_size(share_defaults) <= 2048),
  primary key (club_id, user_id)
);
create index circle_members_user_id_idx on public.circle_members (user_id);
alter table public.circle_members enable row level security;

create trigger post_training_partners_set_circle_trigger
  before insert on public.post_training_partners
  for each row execute function public.post_training_partners_set_circle();

-- Limits, enforced where the row is written so no code path can skip them:
-- 2 members in a couple, 20 in friends, 10 circles per person. Definer so the
-- count sees every row, not only the caller's. The circle row lock serialises
-- two joins to one circle; the advisory lock serialises one person's joins.
create or replace function public.circle_members_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_count integer;
  v_cap integer;
begin
  select c.type into v_type from public.clubs c where c.id = new.club_id for update;
  if v_type is null then raise exception 'circle not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  select count(*) into v_count from public.circle_members m where m.club_id = new.club_id;
  v_cap := case v_type when 'couple' then 2 else 20 end;
  if v_count >= v_cap then
    raise exception 'circle_full' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.circle_members m where m.user_id = new.user_id;
  if v_count >= 10 then
    raise exception 'too_many_circles' using errcode = 'P0001';
  end if;

  -- Both members of a couple are owners.
  if v_type = 'couple' then new.role := 'owner'; end if;
  return new;
end $$;
revoke all on function public.circle_members_guard() from public, anon;
create trigger circle_members_guard_trigger
  before insert on public.circle_members
  for each row execute function public.circle_members_guard();

-- A couple's members stay owners, and a role never changes through an update
-- of anything but role by the RPCs (there is no client UPDATE policy).
create or replace function public.circle_members_guard_role()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.club_id is distinct from old.club_id or new.user_id is distinct from old.user_id then
    raise exception 'a membership cannot move';
  end if;
  if new.role <> 'owner' and exists (select 1 from public.clubs c where c.id = new.club_id and c.type = 'couple') then
    raise exception 'both members of a couple are owners';
  end if;
  return new;
end $$;
create trigger circle_members_guard_role_trigger
  before update on public.circle_members
  for each row execute function public.circle_members_guard_role();

-- 9. circle_invites: the hash only, no client access --------------------------
create table public.circle_invites (
  id         uuid primary key default gen_random_uuid(),
  club_id    uuid not null references public.clubs (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses   integer not null default 1 check (max_uses between 1 and 20),
  uses       integer not null default 0 check (uses >= 0 and uses <= max_uses)
);
create index circle_invites_club_id_idx on public.circle_invites (club_id);
create index circle_invites_created_by_idx on public.circle_invites (created_by);
alter table public.circle_invites enable row level security;
revoke all on public.circle_invites from anon, authenticated;

-- 10. member_targets ----------------------------------------------------------
create table public.member_targets (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  weekly_target smallint not null check (weekly_target between 1 and 21),
  paused_until  date,
  updated_at    timestamptz not null default now()
);
alter table public.member_targets enable row level security;
create trigger member_targets_touch
  before update on public.member_targets
  for each row execute function public.touch_updated_at();

-- 11. Helpers -----------------------------------------------------------------
create or replace function public.is_circle_member(p_club_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.circle_members m
     where m.club_id = p_club_id and m.user_id = auth.uid()
  );
$$;
create or replace function public.is_circle_owner(p_club_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.circle_members m
     where m.club_id = p_club_id and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;
create or replace function public.my_circles()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.club_id from public.circle_members m where m.user_id = auth.uid();
$$;
revoke all on function public.is_circle_member(uuid) from public, anon;
revoke all on function public.is_circle_owner(uuid) from public, anon;
revoke all on function public.my_circles() from public, anon;
grant execute on function public.is_circle_member(uuid) to authenticated, service_role;
grant execute on function public.is_circle_owner(uuid) to authenticated, service_role;
grant execute on function public.my_circles() to authenticated, service_role;

-- Same circle as me? The one question every cross-member read asks. The old
-- per-field privacy toggles are gone, so the field name no longer matters.
create or replace function public.can_view_profile_field(p_target uuid, p_field text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    p_target = auth.uid()
    or (
      exists (
        select 1
          from public.circle_members mine
          join public.circle_members theirs on theirs.club_id = mine.club_id
         where mine.user_id = auth.uid() and theirs.user_id = p_target
      )
      and not exists (
        select 1 from public.blocks b
         where (b.blocker_id = auth.uid() and b.blocked_id = p_target)
            or (b.blocker_id = p_target and b.blocked_id = auth.uid())
      )
    )
  );
$$;

-- A post is visible to its author and to the other members of its circle.
-- Invoker, as before: it reads workout_posts under the caller's own RLS.
create or replace function public.post_visible_to_viewer(p_post_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.workout_posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and public.is_circle_member(p.club_id)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.author_id)
           or (b.blocker_id = p.author_id and b.blocked_id = auth.uid())
      )
      and (
        p.author_id = auth.uid()
        or (p.status = 'active' and p.visibility in ('public', 'club'))
      )
  );
$$;

-- Grants are explicit in this project (202608270002 locked the defaults).
-- Circles are created and deleted by RPCs, memberships written by RPCs only.
grant select on public.circle_members to authenticated;
grant select, insert, update, delete on public.member_targets to authenticated;
revoke insert, delete on public.clubs from authenticated;

-- 12. Policies ----------------------------------------------------------------
-- clubs: members read; the owner edits settings; create and delete are RPCs.
create policy clubs_read on public.clubs for select to authenticated
  using (public.is_circle_member(id));
create policy clubs_update_owner on public.clubs for update to authenticated
  using (public.is_circle_owner(id)) with check (public.is_circle_owner(id));

-- circle_members: I see the rosters of my circles. No client writes.
create policy circle_members_read on public.circle_members for select to authenticated
  using (club_id in (select public.my_circles()));

-- member_targets: mine only; the circle sees a percent through an RPC.
create policy member_targets_self_select on public.member_targets for select to authenticated
  using (user_id = auth.uid());
create policy member_targets_self_insert on public.member_targets for insert to authenticated
  with check (user_id = auth.uid());
create policy member_targets_self_update on public.member_targets for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy member_targets_self_delete on public.member_targets for delete to authenticated
  using (user_id = auth.uid());

-- profiles: mine, or someone who shares a circle with me.
create policy profiles_read_authenticated on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or (
      deleted_at is null
      and exists (select 1 from public.circle_members m where m.user_id = profiles.id)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = profiles.id)
           or (b.blocker_id = profiles.id and b.blocked_id = auth.uid())
      )
    )
  );
create policy profiles_insert_self on public.profiles for insert to authenticated
  with check (
    id = auth.uid()
    and recovery_verified_at is null
    and exists (select 1 from public.invite_redemptions ir where ir.user_id = auth.uid())
  );

-- workout_posts: the circle's members only.
create policy posts_feed_select on public.workout_posts for select to authenticated
  using (
    deleted_at is null
    and public.is_circle_member(club_id)
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = workout_posts.author_id)
         or (b.blocker_id = workout_posts.author_id and b.blocked_id = auth.uid())
    )
    and (
      author_id = auth.uid()
      or (status = 'active' and visibility in ('public', 'club'))
    )
  );
create policy posts_insert_self on public.workout_posts for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.is_community_member()
    and public.is_circle_member(club_id)
  );
create policy posts_update_self on public.workout_posts for update to authenticated
  using (author_id = auth.uid() and public.is_circle_member(club_id))
  with check (author_id = auth.uid() and public.is_circle_member(club_id));

-- post_training_partners and reactions have no circle of their own to check
-- against the viewer except through their post.
create policy post_training_partners_read on public.post_training_partners for select to authenticated
  using (
    public.is_circle_member(club_id)
    and (tagged_user_id = auth.uid() or public.post_visible_to_viewer(post_id))
  );
create policy reactions_visible on public.reactions for select to authenticated
  using (public.post_visible_to_viewer(post_id));
create policy reactions_insert_self on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and public.post_visible_to_viewer(post_id));

-- member_achievements: mine. Sharing an achievement is a post, in a circle.
create policy member_achievements_read on public.member_achievements for select to authenticated
  using (user_id = auth.uid());

-- blocks: only between people who share a circle.
create policy blocks_self_insert on public.blocks for insert to authenticated
  with check (
    blocker_id = auth.uid()
    and exists (select 1 from public.circle_members m where m.user_id = blocked_id)
  );

-- achievement_definitions keeps its read policy (a global catalogue) and loses
-- its admin write policies: there is no admin. analytics_events keeps the
-- insert-own policy and loses its staff read policy.

-- Trigger functions are invoker functions: without this they carry the default
-- EXECUTE for PUBLIC (0113 pins that no public function is anon-callable).
revoke all on function public.clubs_guard_immutable() from public, anon;
revoke all on function public.circle_scope_immutable() from public, anon;
revoke all on function public.profiles_protect_columns() from public, anon;
revoke all on function public.circle_members_guard_role() from public, anon;

-- 13. The staff stubs are used by nothing now ---------------------------------
drop function if exists public.is_staff();
drop function if exists public.is_admin();
drop function if exists public.has_perm(text);

commit;
