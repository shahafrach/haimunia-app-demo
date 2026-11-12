-- Haimunia club at full size (docs/club/research.md, section H): 250 members on one link, 3,000 posts,
-- 12,000 reactions, 250 push subscriptions. pgTAP runs in one transaction, so this measures database cost,
-- not network. Row counts and plans are asserted hard. Times are asserted with three times the target as
-- headroom (CI runners are noisy), and every measured value is printed with diag() so drift shows.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

-- 250 load users, L1..L250. The owner plus L1..L249 fill the club (250); L250 is the 251st.
create function tests.lid(i integer) returns uuid language sql immutable as
  $$ select ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid $$;
grant execute on function tests.lid(integer) to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', tests.lid(i), 'authenticated', 'authenticated',
       'load' || lpad(i::text, 3, '0') || '@members.haimuniya.invalid',
       '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()
  from generate_series(1, 250) i;
insert into public.profiles (id, handle, display_name, recovery_verified_at)
select tests.lid(i), 'load_' || lpad(i::text, 3, '0'), 'Load ' || i, now() from generate_series(1, 250) i;

select is(public.owner_create_club('owner', 'Load club'), 'created', 'the club is created');
create function tests.kid() returns uuid language sql stable security definer set search_path = '' as
  $$ select c.id from public.clubs c where c.type = 'club' $$;
grant execute on function tests.kid() to authenticated, service_role;

create table tests.timing (label text primary key, ms numeric not null);
create table tests.joins (i integer primary key, status text not null);
grant insert on tests.joins to authenticated;

select tests.set_auth(tests.uid('owner'));
select set_config('tests.tok', public.rotate_club_link(tests.kid()), true);
select tests.clear_auth();

-- =====================================================================================================
-- 1. 250 joins on one link, then the 251st
-- =====================================================================================================
do $$
declare
  v_tok text := current_setting('tests.tok');
  v_t0 timestamptz := clock_timestamp();
  i integer;
begin
  for i in 1..250 loop
    perform tests.set_auth(tests.lid(i));
    insert into tests.joins values (i, public.join_circle(v_tok) ->> 'status');
    perform tests.clear_auth();
  end loop;
  insert into tests.timing values ('250 joins', extract(epoch from clock_timestamp() - v_t0) * 1000);
end $$;
select is((select count(*)::int from tests.joins where i <= 249 and status = 'joined'), 249, '249 joins on the one link all succeed');
select is((select status from tests.joins where i = 250), 'circle_full', 'the 251st join is circle_full');
select is((select count(*)::int from public.circle_members where club_id = tests.kid()), 250, 'the club holds exactly 250');
select is((select count(*)::int from public.notifications where type = 'circle_joined'), 0, '250 joins: zero join notifications to the owner');

-- =====================================================================================================
-- 2. 3,000 posts, 12,000 reactions, 250 push subscriptions
-- =====================================================================================================
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on)
select ('d0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, tests.lid(1 + (i % 249)), tests.kid(),
       'POST_WORKOUT', 'Load workout ' || i, 'active',
       now() - make_interval(mins => i * 7), (now() - make_interval(mins => i * 7))::date
  from generate_series(1, 3000) i;

-- Four reactions on each post, from four members other than its author.
insert into public.reactions (post_id, user_id, kind)
select ('d0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       tests.lid(1 + ((i + k * 37) % 249)), 'fire'
  from generate_series(1, 3000) i, generate_series(1, 4) k
 where 1 + ((i + k * 37) % 249) <> 1 + (i % 249);
select ok((select count(*) from public.reactions) >= 11900, 'about 12,000 reactions');
select ok((select count(*) from public.notifications where type = 'reaction') <= 3000,
  'reactions notify at most once per post per hour');

insert into public.push_subscriptions (user_id, endpoint, keys, app)
select tests.lid(i), 'https://push.example/load-' || i, '{"p256dh":"BPk","auth":"aGk"}', 'club'
  from generate_series(1, 249) i;
insert into public.notification_preferences (user_id, type, channel)
select tests.lid(i), 'reaction', 'push' from generate_series(1, 249) i
on conflict do nothing;
analyze public.workout_posts;
analyze public.reactions;
analyze public.circle_members;
analyze public.notifications;
analyze public.push_subscriptions;

-- =====================================================================================================
-- 3. One PR post fans out to nobody; one reaction writes at most one notification
-- =====================================================================================================
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d0000000-0000-4000-8000-999999999999', tests.lid(7), tests.kid(), 'POST_PR', 'Load PR', 'active', now(), current_date);
select is((select count(*)::int from public.notifications where type = 'pr_circle'), 0, 'a PR in a club of 250 writes 0 pr_circle rows');
create table tests.notif_before as select count(*) as n from public.notifications;
insert into public.reactions (post_id, user_id, kind) values ('d0000000-0000-4000-8000-999999999999', tests.lid(8), 'clap');
select ok((select count(*) from public.notifications) - (select n from tests.notif_before) <= 1, 'one reaction writes at most one notification');

-- =====================================================================================================
-- 4. Reads at club size
-- =====================================================================================================
do $$
declare
  v_t0 timestamptz;
  v_n integer;
begin
  perform tests.set_auth(tests.lid(3));
  v_t0 := clock_timestamp();
  select count(*) into v_n from public.circle_feed(tests.kid(), null, 30);
  perform set_config('tests.feed_rows', v_n::text, true);
  perform set_config('tests.feed_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::text, true);
  v_t0 := clock_timestamp();
  select count(*) into v_n from public.circle_members m where m.club_id = tests.kid();
  perform set_config('tests.members_rows', v_n::text, true);
  perform set_config('tests.members_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::text, true);
  perform tests.clear_auth();
  insert into tests.timing values ('feed page', current_setting('tests.feed_ms')::numeric),
                                  ('member list', current_setting('tests.members_ms')::numeric);
  v_t0 := clock_timestamp();
  select count(*) into v_n from public.notif_push_pending(200);
  insert into tests.timing values ('notif_push_pending(200)', extract(epoch from clock_timestamp() - v_t0) * 1000);
end $$;
select is(current_setting('tests.feed_rows')::int, 30, 'a member reads a 30-post feed page');
select is(current_setting('tests.members_rows')::int, 250, 'and the 250-member list');

-- The feed's own query, as circle_feed runs it, reads the new index, never a sequential scan of posts.
create function tests.feed_plan() returns text language plpgsql as $$
declare v_line text; v_out text := '';
begin
  for v_line in execute format(
    'explain select p.id from public.workout_posts p join public.profiles pr on pr.id = p.author_id
      where p.club_id = %L and p.deleted_at is null and p.status = ''active''
      order by p.published_at desc, p.id desc limit 30', tests.kid())
  loop v_out := v_out || v_line || E'\n'; end loop;
  return v_out;
end $$;
select ok(tests.feed_plan() like '%workout_posts_circle_feed_idx%', 'the feed page uses workout_posts_circle_feed_idx');
select ok(tests.feed_plan() not like '%Seq Scan on workout_posts%', 'and never a sequential scan of workout_posts');

-- =====================================================================================================
-- 5. Removing a member with 50 posts
-- =====================================================================================================
create table tests.victim as
  select author_id, count(*) as n from public.workout_posts where club_id = tests.kid()
   group by author_id order by count(*) desc, author_id limit 1;
select ok((select n from tests.victim) >= 12, 'the removed member has a dozen posts or more');
do $$
declare
  v_t0 timestamptz;
  v_victim uuid := (select author_id from tests.victim);
begin
  perform tests.set_auth(tests.uid('owner'));
  v_t0 := clock_timestamp();
  perform public.remove_member(tests.kid(), v_victim);
  perform tests.clear_auth();
  insert into tests.timing values ('remove member', extract(epoch from clock_timestamp() - v_t0) * 1000);
end $$;
select is((select count(*)::int from public.workout_posts where author_id = (select author_id from tests.victim)), 0, 'their posts are gone');
select is((select count(*)::int from public.reactions r
            where not exists (select 1 from public.workout_posts p where p.id = r.post_id)), 0, 'and the reactions on them');

-- =====================================================================================================
-- 6. Leak check at size: someone outside the club sees none of it
-- =====================================================================================================
select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.clubs where type = 'club'), 0, 'a non-member sees no club row');
select is((select count(*)::int from public.circle_members where club_id = tests.kid()), 0, 'no member row');
select is((select count(*)::int from public.workout_posts where club_id = tests.kid()), 0, 'no post');
select is((select count(*)::int from public.reactions), 0, 'no reaction');
select is((select count(*)::int from public.club_announcements), 0, 'no announcement');
select throws_ok(format('select * from public.circle_feed(%L)', tests.kid()), 'P0001', 'not authorized', 'and cannot call the feed');
select tests.clear_auth();

-- =====================================================================================================
-- 7. Times (targets x3 headroom; printed either way)
-- =====================================================================================================
select diag(label || ': ' || round(ms, 1) || ' ms') from tests.timing order by label;
select cmp_ok((select ms from tests.timing where label = 'feed page'), '<', 150::numeric, 'feed page < 150 ms (target 50)');
select cmp_ok((select ms from tests.timing where label = 'member list'), '<', 60::numeric, 'member list < 60 ms (target 20)');
select cmp_ok((select ms from tests.timing where label = 'notif_push_pending(200)'), '<', 300::numeric, 'notif_push_pending(200) < 300 ms (target 100)');
select cmp_ok((select ms from tests.timing where label = 'remove member'), '<', 600::numeric, 'remove a member < 600 ms (target 200)');

select * from finish();
rollback;
