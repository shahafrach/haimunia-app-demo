-- 202611120002: owner_create_club for an owner who signed up in the club app and has no profile
-- yet (a profile is created by join_circle, and there is no club to join before this runs).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select plan(6);

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
        'fresh_owner@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now());

select is((select count(*)::int from public.profiles where id = 'e0000000-0000-4000-8000-000000000001'), 0, 'the owner has no profile yet');
select is(public.owner_create_club('fresh_owner', 'האימוניה'), 'created', 'the club is created anyway');
select is((select count(*)::int from public.profiles where id = 'e0000000-0000-4000-8000-000000000001'), 1, 'with the same minimal profile join_circle makes');
select is((select role from public.circle_members m join public.clubs c on c.id = m.club_id
            where c.type = 'club' and m.user_id = 'e0000000-0000-4000-8000-000000000001'), 'owner', 'and the owner is its owner');
select is(public.owner_create_club('fresh_owner', 'האימוניה'), 'exists', 'a second call changes nothing');
select tests.set_auth('e0000000-0000-4000-8000-000000000001');
select throws_ok($$ select public.owner_create_club('fresh_owner', 'x') $$, '42501', null, 'still granted to no role');
select tests.clear_auth();

select * from finish();
rollback;
