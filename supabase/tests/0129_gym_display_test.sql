-- The gym display (202609230005) — a screen in a public room.
--
-- What this file is really defending: a television left signed in, in a room
-- anyone walks through, must not become a way to read the club. So it asserts
-- both halves — that the display CAN see today's WOD, and that it can see
-- nothing else, including the things a member takes for granted.
--
-- The display fixture deliberately has recovery_verified_at NULL, because
-- that is the property the whole design leans on: is_community_member() is
-- false for it, and every community path in this schema already refuses a
-- caller that fails that check.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- ---------------------------------------------------------------------------
-- Fixtures: one display, one member who is on the leaderboard, one who is not.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'd1290000-0000-4000-8000-000000000001'::uuid,
        'authenticated', 'authenticated', 'display@haimuniya.example',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

-- recovery_verified_at NULL on purpose - see the header.
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values ('d1290000-0000-4000-8000-000000000001'::uuid, 'gym_screen', 'מסך המועדון', null)
on conflict (id) do nothing;

insert into public.invite_redemptions (user_id, invite_id, role)
values ('d1290000-0000-4000-8000-000000000001'::uuid,
        '11111111-2222-4333-8444-555555555555', 'gym_display')
on conflict (user_id) do nothing;

-- The module ships DISABLED (202609190002 seeded all seven off), which is the
-- right default for a screen that shows member names in a public room. The
-- club turns it on deliberately; this fixture does the same, and the switch
-- gets its own assertion further down.
update public.club_features set enabled = true where module_key = 'gym_display';

-- m1 opts in to boards, m2 opts out. Two-word names so the masking is visible.
update public.profiles set display_name = 'דנה כהן',  in_leaderboards = true  where id = tests.uid('m1');
update public.profiles set display_name = 'נועה לוי', in_leaderboards = false where id = tests.uid('m2');

-- Today's club WOD, with a result from each. A CUSTOM wod: club_wods.wod_id
-- is constrained to '^customwod-...', because the benchmark names live in the
-- client's WOD_LIBRARY and never had a row here.
insert into public.club_wods (wod_id, name, club_id, score_type, published_by, published_at)
values ('customwod-0129', 'אימון הבוקר', public.default_club_id(), 'time', tests.uid('coach'), now())
on conflict (wod_id) do nothing;

insert into public.club_wod_sessions (id, club_id, wod_id, session_date, note, published_by, published_at)
values ('50129000-0000-4000-8000-000000000001', public.default_club_id(), 'customwod-0129',
        (now() at time zone 'Asia/Jerusalem')::date, 'בהצלחה', tests.uid('coach'), now());

insert into public.club_wod_results (session_id, user_id, result_text, rx, occurred_on, attached_at)
values ('50129000-0000-4000-8000-000000000001', tests.uid('m1'), '3:21', true,
        (now() at time zone 'Asia/Jerusalem')::date, now()),
       ('50129000-0000-4000-8000-000000000001', tests.uid('m2'), '4:02', false,
        (now() at time zone 'Asia/Jerusalem')::date, now() + interval '1 second');

-- =====================================================================
-- The masking, on its own
-- =====================================================================
select is(public.gym_display_mask_name('דנה כהן'), 'דנה כ.',
  'a two-word name becomes a first name and a surname initial');
select is(public.gym_display_mask_name('דנה'), 'דנה',
  'a single-word name is returned unchanged, not abbreviated into something the member never chose');
select is(public.gym_display_mask_name('   '), '',
  'a blank name is blank, not a stray full stop');
select is(public.gym_display_mask_name(null), '',
  'and a null name does not become the text "null" on a wall');

-- =====================================================================
-- What the display CAN see
-- =====================================================================
select tests.set_auth('d1290000-0000-4000-8000-000000000001'::uuid);

select ok(public.is_gym_display(), 'the display account is recognised as a display');
select ok(not public.is_community_member(),
  'and is NOT a community member - which is what refuses it everywhere else, by construction');

select is(
  public.gym_display_board() -> 'wod' ->> 'name', 'אימון הבוקר',
  'the board carries today''s club WOD by name, for a custom WOD');
select is(
  public.gym_display_board() -> 'wod' ->> 'wod_id', 'customwod-0129',
  'and always its wod_id, which is how the screen names a BUILT-IN wod - those
   live in the client''s WOD_LIBRARY and have no row here');

select is(
  (select count(*) from jsonb_array_elements(public.gym_display_board() -> 'results')),
  1::bigint,
  'exactly one result - the member who opted out of leaderboards is ABSENT, not masked');

select is(
  public.gym_display_board() -> 'results' -> 0 ->> 'name', 'דנה כ.',
  'and the one result carries a masked name, masked in the database rather than in the client');

select is_empty(
  $$ select 1 from jsonb_array_elements(public.gym_display_board() -> 'results') e
     where e ->> 'name' like '%לוי%' $$,
  'the opted-out member''s name appears nowhere in the payload at all');

-- =====================================================================
-- What the display CANNOT see
-- =====================================================================
-- The point of the design: it was never granted these, rather than having
-- them taken away, so this stays true as the app grows.
select throws_ok($$ select * from public.feed_page(null, 20, 'for_you') $$,
  'P0001', 'recovery method required', 'a display cannot read the feed');
select throws_ok($$ select public.community_profile(tests.uid('m1')) $$,
  'P0001', 'recovery method required', 'nor a member profile');
-- It CAN see its own profile row, through the same self-only policy every
-- account has, and that is fine: the row is the display's own. What must be
-- empty is everybody else's, and that is what is asserted - measured at 1
-- visible profile and 0 belonging to anyone else.
select is_empty(
  $$ select 1 from public.profiles
     where id <> 'd1290000-0000-4000-8000-000000000001'::uuid $$,
  'no OTHER member''s profile row is readable directly - only its own, like any account');
select is_empty($$ select 1 from public.club_wod_results $$,
  'nor the results table it is showing, which it reaches only through the definer function');

-- =====================================================================
-- The switch, and who else may call the board
-- =====================================================================
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'gym_display';
select tests.set_auth('d1290000-0000-4000-8000-000000000001'::uuid);
select throws_ok($$ select public.gym_display_board() $$,
  'P0001', 'gym_display disabled',
  'switching the module off blanks the screen at the server, not just in a menu');
select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'gym_display';

-- A member is not a display. The board is not a second way to read the club.
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.gym_display_board() $$,
  'P0001', 'not authorized', 'an ordinary member cannot call the board');
select tests.clear_auth();
select tests.set_auth(tests.uid('coach'));
select throws_ok($$ select public.gym_display_board() $$,
  'P0001', 'not authorized', 'and neither can a coach - the role is the gate, not the rank');
select tests.clear_auth();

-- =====================================================================
-- A display is furniture, not a clubmate
-- =====================================================================
select ok(public.is_management_account('d1290000-0000-4000-8000-000000000001'::uuid),
  'the display is hidden from members the same way the technical account is');

-- 202609220007''s own two clauses are untouched by that addition.
select ok(not public.is_management_account(tests.uid('owner')),
  'the owner is still a clubmate');
select ok(not public.is_management_account(tests.uid('coach')),
  'and so is a coach');
select ok(not public.is_management_account(tests.uid('admin')),
  'and so is an is_admin account that redeemed a club role');

select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select jsonb_array_elements(public.community_search('מסך', 50) -> 'members') $$,
  'a member searching for the screen by name finds nothing');
select is_empty(
  $$ select jsonb_array_elements(public.community_search('gym_screen', 50) -> 'members') $$,
  'nor by handle');
select tests.clear_auth();

-- =====================================================================
-- anon reaches none of it
-- =====================================================================
select ok(not has_function_privilege('anon', 'public.gym_display_board()', 'execute'),
  'anon cannot call the board');
select ok(not has_function_privilege('anon', 'public.is_gym_display()', 'execute'),
  'anon cannot ask whether it is a display');

select * from finish();
rollback;
