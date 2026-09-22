begin;

-- TWO OF 202609190002'S SEVEN SWITCHES GET SOMETHING TO SWITCH.
--
--   coach_tasks           a daily work list for whoever is on the floor
--   onboarding_challenge  a 30-day challenge a new member may accept
--
-- Both keys already exist and are OFF (202609190002 seeded them that way on
-- purpose). This migration is the other half of that handover: it builds the
-- features, and it makes both keys real server gates rather than names. The
-- two rows in cloud.js's registries lose `planned: true` - and lose
-- `clientOnly: true` as well, because after this file there IS an RLS clause
-- behind each of them, which is precisely the decision 202609190002 said the
-- building branch would be the one to make.
--
-- ONE MIGRATION, TWO FEATURES, deliberately. supabase/migrations/ is the one
-- directory two open branches cannot both touch (CLAUDE.md, "Parallel
-- work"), and these two share a config reader, a member predicate and the
-- same attendance source. Splitting them would have meant two files nobody
-- could land in parallel anyway.
--
-- =====================================================================
-- WHAT COACH TASKS IS, AND WHAT IT IS NOT
-- =====================================================================
-- It is not a new signal. Every rule below is computed from data this
-- schema already holds - invite_redemptions (when someone joined),
-- attendance_log (whether they have trained), member_contact_log (whether
-- anyone has spoken to them) - and the point of the feature is that a coach
-- stops having to assemble that by eye from three separate sections of the
-- dashboard.
--
-- THE FIVE RULES, all with their numbers in club_features.config so the club
-- can retune them without a migration:
--
--   welcome               a named coach greets a new member between day
--                         `welcome_from_day` (1) and `welcome_by_day` (7).
--   first_class_followup  after the member's FIRST attendance day, follow up
--                         within `first_class_followup_days` (3).
--   low_attendance        fewer than `low_attendance_min_sessions` (2)
--                         attendance days inside the first
--                         `low_attendance_window_days` (21) opens a personal
--                         contact task on day 21.
--   day_60_checkin        a check-in at day `checkin_day` (60).
--   no_contact_30         ANY member with no staff contact for
--                         `no_contact_days` (30) days.
--
-- The first four are scoped to a member's first `onboarding_window_days`
-- (90) days; the fifth is not, because "nobody has spoken to this member
-- since July" is not an onboarding question.
--
-- WHAT THE FIRST SYNC LOOKS LIKE ON A LIVE CLUB, said plainly because it
-- will surprise whoever flips the switch otherwise: member_contact_log has
-- one row per coach outreach ever logged, and most clubs have logged few.
-- So the first run of no_contact_30 opens one task for very nearly every
-- member, dated thirty days after they joined. That is the correct answer to
-- the question the rule asks - it is not a bug and it must not be quietly
-- suppressed - but it means the list starts long and shortens as the club
-- works through it. The read is capped at 100 rows and ordered overdue-first,
-- so the top of the list is the right place to start.
--
-- A TASK CLOSES WHEN A member_contact_log ROW EXISTS FOR THAT MEMBER AFTER
-- THE TASK OPENED. That sentence is the whole closing model, and it is
-- implemented twice on purpose, in two places that cannot disagree because
-- they share one predicate shape:
--   * coach_tasks_close_on_contact(), an AFTER INSERT trigger on
--     member_contact_log, so the row a coach just wrote closes the task in
--     the same transaction and the list is right on the next render; and
--   * the close pass inside coach_tasks_sync(), which re-asserts the same
--     rule over every open task - so a contact logged before this migration
--     existed, or by a path that somehow skipped the trigger, still closes
--     what it should.
-- `>=`, not `>`: a contact stamped at the exact instant a task opened is a
-- contact after it opened as far as a human is concerned, and the two
-- timestamps are computed from different clocks anyway.
--
-- WHY THE TASKS ARE ROWS AND NOT A VIEW. Every rule here is derivable, so a
-- read-only function over the three source tables would have worked and
-- would have needed no table at all. Rows were chosen for three reasons that
-- a view cannot give: a task carries WHO closed it and WHEN, which is the
-- audit a club asks for the first time two coaches both think the other one
-- called someone; `opened_at` is frozen at the moment the rule fired, so
-- retuning a threshold does not silently rewrite last month's history; and
-- RLS on a table is a real boundary, where "the function does not return it"
-- is a promise.
--
-- WHO MAY READ ONE. Staff, for their own club, and only while the module is
-- on. There is no member-facing policy of any kind: a member must never
-- read a row that says a coach has been told to chase them. That is the
-- same judgement coach_engagement_flags (COMM-011) already made for the
-- same reason, and it is why this table gets its own RLS rather than
-- leaning on member_contact_log's.
--
-- =====================================================================
-- WHAT THE ONBOARDING CHALLENGE IS
-- =====================================================================
-- One rolling club challenge row on the EXISTING challenges tables, of an
-- EXISTING challenge_type ('consistency'), which each new member is OFFERED
-- and may accept or decline. Nobody is ever enrolled without saying yes:
-- there is no path in this file that writes a challenge_participants row
-- except onboarding_challenge_respond(p_accept => true), called by the
-- member themselves.
--
-- ONE CHALLENGE ROW, NOT ONE PER MEMBER, and that is the shape decision a
-- reviewer should read before the code. A per-member challenge would have
-- put a row on the club's challenge board for every newcomer - challenges
-- are club-visible by RLS (challenges_read, 202609060011) and the board
-- lists them all - so a fifty-member club would have had fifty private
-- challenges on one public board. The alternative considered and rejected
-- was narrowing challenges_read by the long-unenforced `visibility` column,
-- which is a change to a policy four other read paths depend on and is not
-- this ticket's to make. So: one row, and the 30-day window is
-- PER PARTICIPANT, held on the offer row (started_at/ends_at) and applied by
-- the progress trigger below.
--
-- THE GOAL AND THE WINDOW ARE FROZEN AT ACCEPTANCE. goal_sessions and
-- window_days are copied onto the offer row when the member says yes, and
-- the completion test reads those copies, never the live config. An admin
-- retuning `goal_sessions` from 8 to 12 must not move the goalposts under
-- somebody who is on day 20 of an 8-session challenge.
--
-- PROGRESS COMES FROM attendance_log, whatever wrote it. The trigger hangs
-- off attendance_log itself rather than off private_records, so the day
-- arbox_attendance (another of 202609190002's seven) starts writing
-- attendance rows, this counts them with no change here.
--
-- =====================================================================

-- ---------------------------------------------------------------------------
-- 0. One config reader for both features
-- ---------------------------------------------------------------------------
-- club_features.config has existed since 202609010012 and has never held
-- anything: its own comment says "config exists only for a module that needs
-- sub-structure beyond a single on/off - none does today". These two modules
-- are the first that do, and admin_set_club_feature() already takes a
-- p_config jsonb, so the write path needed nothing.
--
-- ONE function, not one per module. The characteristic defect in this
-- codebase is a right line with copies, and "read a number out of a jsonb
-- config, fall back to a default, clamp it" is exactly the kind of line that
-- acquires a second copy the day a third module wants a threshold.
--
-- EVERY REJECTION FALLS BACK TO THE DEFAULT, silently, and nothing here
-- raises. The value is admin-supplied jsonb: it can be absent, null, a
-- string, an object, or a number outside anything sensible. A threshold
-- reader that throws would take the whole task list down over a typo in an
-- admin panel, so a bad value reads as "not configured" and the shipped
-- default applies.
create or replace function public.club_feature_number(
  p_module_key text,
  p_key text,
  p_default numeric,
  p_min numeric,
  p_max numeric
) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare
  v_raw jsonb;
  v_val numeric;
begin
  select cf.config -> p_key into v_raw
    from public.club_features cf
   where cf.club_id = public.default_club_id() and cf.module_key = p_module_key;

  if v_raw is null or jsonb_typeof(v_raw) not in ('number', 'string') then
    v_val := p_default;
  else
    begin
      v_val := (v_raw #>> '{}')::numeric;
    exception when others then
      v_val := p_default;
    end;
  end if;

  if v_val is null then v_val := p_default; end if;
  return least(greatest(v_val, p_min), p_max);
end $$;
revoke all on function public.club_feature_number(text, text, numeric, numeric, numeric) from public, anon;
grant execute on function public.club_feature_number(text, text, numeric, numeric, numeric) to authenticated;
comment on function public.club_feature_number(text, text, numeric, numeric, numeric) is
  'Reads one numeric setting out of club_features.config for p_module_key, clamped to [p_min, p_max]. Any absent, null, non-numeric or unparseable value falls back to p_default rather than raising: the value is admin-supplied jsonb and a threshold reader that throws would take a whole surface down over a typo. Shared by coach_tasks and onboarding_challenge so the "read a threshold" line has exactly one copy.';

-- ---------------------------------------------------------------------------
-- 1. Who counts as a member for these two features
-- ---------------------------------------------------------------------------
-- THIS PREDICATE IS A TWIN, and saying so is the point of this comment.
-- coach_new_members() (202609160003) carries the identical three clauses -
-- not deleted, role_rank(role) < 20, not is_admin - added there after staff
-- turned up in their own welcome queue. The same mistake is available here
-- and would be worse: a coach would be handed a task to welcome another
-- coach, and the head coach would get a "nobody has contacted this member in
-- 30 days" task about themselves.
--
-- It is restated rather than shared because coach_new_members() is a
-- deployed function with a different return shape and an applied migration
-- owns it. supabase/tests/0118 asserts the two member sets are equal for
-- every fixture, so a future edit to one that is not made to the other fails
-- rather than drifting.
--
-- A PROFILE WITH NO REDEMPTION ROW counts as a member (rank 10) and joins on
-- profiles.created_at, exactly as coach_new_members() decided: that is a
-- genuine signup mid-flow, which is precisely who a welcome task is for.
create or replace function public.coach_task_members()
returns table(
  user_id uuid,
  joined_at timestamptz,
  assigned_coach_id uuid,
  first_attendance_at timestamptz,
  last_contact_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select
    pr.id,
    coalesce(ir.redeemed_at, pr.created_at),
    pr.assigned_coach_id,
    (select min(al.recorded_at) from public.attendance_log al where al.user_id = pr.id),
    (select max(mcl.contacted_at) from public.member_contact_log mcl where mcl.user_id = pr.id)
  from public.profiles pr
  left join public.invite_redemptions ir on ir.user_id = pr.id
  where pr.deleted_at is null
    and coalesce(public.role_rank(ir.role), 10) < 20
    and not coalesce(pr.is_admin, false);
$$;
-- Internal. Nothing client-callable needs it and it reads three tables a
-- member may not read for themselves, so it is granted to nobody at all -
-- the definer functions below call it with the owner's rights.
revoke all on function public.coach_task_members() from public, anon, authenticated;
comment on function public.coach_task_members() is
  'Internal, granted to no role. The member set coach_tasks_sync() ranks: not deleted, role_rank(role) < 20, not is_admin - the SAME three clauses coach_new_members() carries since 202609160003, restated because that function is applied and owns its own body. supabase/tests/0118 pins the two sets equal. Also returns the member''s join instant, assigned coach, first attendance instant and last staff contact instant, which is every input the five rules need.';

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------
create table public.coach_tasks (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  rule_key text not null check (rule_key in (
    'welcome', 'first_class_followup', 'low_attendance', 'day_60_checkin', 'no_contact_30'
  )),
  -- The instant the rule fired, computed from the member's own history and
  -- the thresholds in force at the time. FROZEN: it is the conflict target
  -- below, so a sync that runs a thousand times produces one row, and it is
  -- what "a contact after the task opened" is measured against.
  opened_at timestamptz not null,
  due_on date not null,
  -- Whoever the member is assigned to, copied at open time. Null is normal
  -- and means "whoever picks it up" - the welcome rule asks for a NAMED
  -- coach, and a task with nobody's name on it is exactly the thing that
  -- rule exists to make visible.
  assigned_coach_id uuid references public.profiles(id) on delete set null,
  -- The numbers the rule fired on, so a coach reading the row a month later
  -- can see what it meant without re-deriving it from thresholds that may
  -- since have changed. Never read by any predicate.
  detail jsonb not null default '{}'::jsonb,
  closed_at timestamptz,
  closed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One row per (member, rule, firing instant). This is what makes
-- coach_tasks_sync() idempotent and what lets no_contact_30 fire again
-- thirty days after the contact that closed it: the new firing has a new
-- opened_at, so it is a new task rather than a conflict.
create unique index coach_tasks_once_per_firing_idx
  on public.coach_tasks(user_id, rule_key, opened_at);
-- The list read: open tasks for the club, oldest due first.
create index coach_tasks_open_idx
  on public.coach_tasks(club_id, due_on) where closed_at is null;
-- DB-M3 (202609060012, pinned by supabase/tests/0081 as a property over the
-- whole catalog rather than a list of names): every foreign key column
-- outside club_id leads an index, so a cascade delete of a profile does not
-- sequentially scan this table. user_id already leads
-- coach_tasks_once_per_firing_idx above; these are the other two.
--
-- Found by a local replay of the pgTAP suite, not by reading the rule -
-- which is the whole reason 0081 asserts the property instead of the names.
create index coach_tasks_assigned_coach_idx on public.coach_tasks(assigned_coach_id);
create index coach_tasks_closed_by_idx on public.coach_tasks(closed_by);

alter table public.coach_tasks enable row level security;
revoke all on public.coach_tasks from public, anon;
-- SELECT and UPDATE only. There is no insert or delete grant and no policy
-- for either, for any role including admin: coach_tasks_sync() is the only
-- writer, the same "no client write, the function owns it" shape
-- attendance_log (202608310001) and notification_batches (202608280018)
-- already use. A coach who could insert their own task could also mint one
-- against a member they wanted an excuse to contact.
grant select, update on public.coach_tasks to authenticated;

-- READ: staff, their own club, and only while the module is on. The module
-- gate is INSIDE the policy rather than only in the reader function, which
-- is what makes coach_tasks a server-enforced key and not a display hide.
create policy coach_tasks_staff_select on public.coach_tasks for select to authenticated
  using (
    public.is_staff()
    and club_id = public.default_club_id()
    and public.club_feature_enabled('coach_tasks')
  );

-- CLOSE: the same audience, and only ever from open to closed. The WITH
-- CHECK cannot express "and nothing else changed", so the guard trigger
-- below does that half; this policy decides WHO, the trigger decides WHAT.
create policy coach_tasks_staff_close on public.coach_tasks for update to authenticated
  using (
    public.is_staff()
    and club_id = public.default_club_id()
    and public.club_feature_enabled('coach_tasks')
    and closed_at is null
  )
  with check (
    public.is_staff()
    and club_id = public.default_club_id()
    and closed_at is not null
  );

comment on table public.coach_tasks is
  'A daily coach work list derived from invite_redemptions, attendance_log and member_contact_log. One row per (user_id, rule_key, opened_at) - see coach_tasks_once_per_firing_idx. Staff of the club read and close; there is NO member-facing policy at all and there must not be one, for the same reason coach_engagement_flags has none: a member must never read a row telling a coach to chase them. No client can insert or delete: coach_tasks_sync() is the only writer. Every policy carries club_feature_enabled(''coach_tasks''), so switching the module off is a real server gate, not a screen hide.';

-- ---------------------------------------------------------------------------
-- 3. The close guard
-- ---------------------------------------------------------------------------
-- Same shape as challenge_participants_guard_progress() (202609060005): a
-- transaction-local pin that only this file's own trigger sets, and a hard
-- refusal for everything else. auth.role() still reads 'authenticated'
-- inside a SECURITY DEFINER function, so definer rights alone would not
-- carry coach_tasks_close_on_contact()'s own UPDATE past this guard.
create or replace function public.coach_tasks_guard_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The service role, a dashboard fix and any future backfill are
  -- unaffected, exactly as challenge_participants_guard_progress() scopes
  -- itself.
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
  if coalesce(current_setting('app.allow_coach_task_close', true), '') = 'on' then return new; end if;

  if new.id is distinct from old.id
     or new.club_id is distinct from old.club_id
     or new.user_id is distinct from old.user_id
     or new.rule_key is distinct from old.rule_key
     or new.opened_at is distinct from old.opened_at
     or new.due_on is distinct from old.due_on
     or new.assigned_coach_id is distinct from old.assigned_coach_id
     or new.detail is distinct from old.detail
     or new.created_at is distinct from old.created_at then
    raise exception 'a coach task is closed, not edited';
  end if;
  if old.closed_at is not null then raise exception 'this task is already closed'; end if;
  if new.closed_at is null then raise exception 'a coach task is closed, not reopened'; end if;

  -- Stamped here rather than trusted from the client, the same author pin
  -- member_contact_log.contacted_by carries by DEFAULT: "who closed this"
  -- is the audit the table exists for and must not be settable.
  new.closed_at := now();
  new.closed_by := auth.uid();
  return new;
end $$;
revoke all on function public.coach_tasks_guard_update() from public, anon, authenticated;

create trigger coach_tasks_guard_update_trigger
  before update on public.coach_tasks
  for each row execute function public.coach_tasks_guard_update();

comment on function public.coach_tasks_guard_update() is
  'BEFORE UPDATE on coach_tasks. Refuses any change other than open -> closed (''a coach task is closed, not edited'' / ''not reopened'' / ''this task is already closed'', all P0001) and stamps closed_at/closed_by from the server rather than from the request. Bypassed inside the transaction-local app.allow_coach_task_close pin, which only coach_tasks_close_on_contact() and coach_tasks_sync() set around their own UPDATE. Skipped entirely when auth.role() is not ''authenticated''.';

-- ---------------------------------------------------------------------------
-- 4. The contact that closes a task
-- ---------------------------------------------------------------------------
create or replace function public.coach_tasks_close_on_contact() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Not gated on the module. A contact logged while coach_tasks is switched
  -- off still closes whatever was open: turning a module off must not leave
  -- a pile of tasks that were satisfied while nobody was looking, and the
  -- rows are unreadable either way while the key is off.
  perform set_config('app.allow_coach_task_close', 'on', true);
  update public.coach_tasks t
     set closed_at = new.contacted_at,
         closed_by = new.contacted_by
   where t.user_id = new.user_id
     and t.closed_at is null
     and t.opened_at <= new.contacted_at;
  perform set_config('app.allow_coach_task_close', 'off', true);
  return new;
end $$;
revoke all on function public.coach_tasks_close_on_contact() from public, anon, authenticated;

create trigger member_contact_log_closes_coach_tasks
  after insert on public.member_contact_log
  for each row execute function public.coach_tasks_close_on_contact();

comment on function public.coach_tasks_close_on_contact() is
  'AFTER INSERT on member_contact_log. Closes every open coach_tasks row for that member whose opened_at is at or before the new contact, stamping the contact''s own timestamp and author rather than now()/auth.uid() - the close belongs to the outreach, not to the transaction. Deliberately NOT gated on club_feature_enabled(''coach_tasks''): a contact logged while the module is off still satisfies whatever it satisfies.';

-- ---------------------------------------------------------------------------
-- 5. The sync
-- ---------------------------------------------------------------------------
-- Five inserts and one close pass. Each insert states its rule once, reads
-- its thresholds from club_features.config through club_feature_number(),
-- and conflicts harmlessly with whatever an earlier run already opened.
--
-- TASKS ARE OPENED AND THEN CLOSED, rather than never opened when a contact
-- already exists. That is one code path instead of two, it makes the close
-- rule the single sentence it is meant to be, and it leaves a real record
-- that the task existed and who satisfied it. The cost is bounded: the four
-- onboarding rules only look back onboarding_window_days.
create or replace function public.coach_tasks_sync() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_welcome_from integer;
  v_welcome_by integer;
  v_followup integer;
  v_low_days integer;
  v_low_min integer;
  v_checkin integer;
  v_quiet integer;
  v_window integer;
  v_opened integer := 0;
  v_n integer;
begin
  if not public.club_feature_enabled('coach_tasks') then return 0; end if;

  v_welcome_from := public.club_feature_number('coach_tasks', 'welcome_from_day', 1, 0, 90)::integer;
  v_welcome_by   := public.club_feature_number('coach_tasks', 'welcome_by_day', 7, 1, 180)::integer;
  v_followup     := public.club_feature_number('coach_tasks', 'first_class_followup_days', 3, 0, 60)::integer;
  v_low_days     := public.club_feature_number('coach_tasks', 'low_attendance_window_days', 21, 1, 180)::integer;
  v_low_min      := public.club_feature_number('coach_tasks', 'low_attendance_min_sessions', 2, 1, 30)::integer;
  v_checkin      := public.club_feature_number('coach_tasks', 'checkin_day', 60, 1, 365)::integer;
  v_quiet        := public.club_feature_number('coach_tasks', 'no_contact_days', 30, 1, 365)::integer;
  v_window       := public.club_feature_number('coach_tasks', 'onboarding_window_days', 90, 1, 730)::integer;
  -- A club that sets welcome_by_day below welcome_from_day has asked for a
  -- task that is overdue before it opens. Clamped rather than refused, the
  -- same shape coach_new_members() uses for p_within_days: this is a number
  -- typed into an admin panel, not a caller's argument.
  if v_welcome_by < v_welcome_from then v_welcome_by := v_welcome_from; end if;

  -- ---- rule 1: welcome, by a named coach, in days 1..7 -------------------
  insert into public.coach_tasks (user_id, rule_key, opened_at, due_on, assigned_coach_id, detail)
  select m.user_id,
         'welcome',
         m.joined_at + make_interval(days => v_welcome_from),
         (m.joined_at + make_interval(days => v_welcome_by))::date,
         m.assigned_coach_id,
         jsonb_build_object('joined_at', m.joined_at, 'from_day', v_welcome_from, 'by_day', v_welcome_by)
    from public.coach_task_members() m
   where m.joined_at + make_interval(days => v_welcome_from) <= now()
     and m.joined_at >= now() - make_interval(days => v_window)
  on conflict (user_id, rule_key, opened_at) do nothing;
  get diagnostics v_n = row_count; v_opened := v_opened + v_n;

  -- ---- rule 2: follow up after the first class ---------------------------
  -- opened_at is the first attendance row's own recorded_at, which is stable
  -- for the life of that row - attendance_log is append-only (202608310001)
  -- and nothing ever deletes a day already logged. A contact BEFORE the
  -- member's first session therefore does not close this task, which is the
  -- point: "how did your first class go" cannot be answered in advance.
  insert into public.coach_tasks (user_id, rule_key, opened_at, due_on, assigned_coach_id, detail)
  select m.user_id,
         'first_class_followup',
         m.first_attendance_at,
         (m.first_attendance_at + make_interval(days => v_followup))::date,
         m.assigned_coach_id,
         jsonb_build_object('first_attendance_at', m.first_attendance_at, 'within_days', v_followup)
    from public.coach_task_members() m
   where m.first_attendance_at is not null
     and m.joined_at >= now() - make_interval(days => v_window)
  on conflict (user_id, rule_key, opened_at) do nothing;
  get diagnostics v_n = row_count; v_opened := v_opened + v_n;

  -- ---- rule 3: fewer than 2 attendances in the first 21 days -------------
  -- Tested on the day the window closes, not continuously: opened_at is
  -- joined + low_attendance_window_days, so the task is about a window that
  -- has finished. attendance_log is append-only but a member can log a
  -- back-dated session later, which can retroactively satisfy a window this
  -- rule has already judged. The task is NOT withdrawn in that case - it
  -- closes when a coach makes contact, like every other task here - and the
  -- count that fired it is on the row in `detail` so a coach can see it was
  -- true when it fired.
  insert into public.coach_tasks (user_id, rule_key, opened_at, due_on, assigned_coach_id, detail)
  select m.user_id,
         'low_attendance',
         m.joined_at + make_interval(days => v_low_days),
         (m.joined_at + make_interval(days => v_low_days))::date,
         m.assigned_coach_id,
         jsonb_build_object(
           'window_days', v_low_days,
           'min_sessions', v_low_min,
           'sessions_in_window', (
             select count(*) from public.attendance_log al
              where al.user_id = m.user_id
                and al.occurred_on >= m.joined_at::date
                and al.occurred_on < (m.joined_at + make_interval(days => v_low_days))::date))
    from public.coach_task_members() m
   where m.joined_at + make_interval(days => v_low_days) <= now()
     and m.joined_at >= now() - make_interval(days => v_window)
     and (select count(*) from public.attendance_log al
           where al.user_id = m.user_id
             and al.occurred_on >= m.joined_at::date
             and al.occurred_on < (m.joined_at + make_interval(days => v_low_days))::date) < v_low_min
  on conflict (user_id, rule_key, opened_at) do nothing;
  get diagnostics v_n = row_count; v_opened := v_opened + v_n;

  -- ---- rule 4: check in at day 60 ----------------------------------------
  insert into public.coach_tasks (user_id, rule_key, opened_at, due_on, assigned_coach_id, detail)
  select m.user_id,
         'day_60_checkin',
         m.joined_at + make_interval(days => v_checkin),
         (m.joined_at + make_interval(days => v_checkin))::date,
         m.assigned_coach_id,
         jsonb_build_object('joined_at', m.joined_at, 'day', v_checkin)
    from public.coach_task_members() m
   where m.joined_at + make_interval(days => v_checkin) <= now()
     and m.joined_at >= now() - make_interval(days => v_window)
  on conflict (user_id, rule_key, opened_at) do nothing;
  get diagnostics v_n = row_count; v_opened := v_opened + v_n;

  -- ---- rule 5: nobody has spoken to this member in 30 days ---------------
  -- NOT scoped to the onboarding window, deliberately. This is the rule that
  -- covers the member who joined two years ago and has not been spoken to
  -- since, and scoping it to the first 90 days would leave exactly nobody in
  -- it. Its opened_at MOVES: thirty days after the contact that closed the
  -- last one, a new firing opens a new row, which is what makes this a
  -- recurring task rather than a one-off.
  insert into public.coach_tasks (user_id, rule_key, opened_at, due_on, assigned_coach_id, detail)
  select m.user_id,
         'no_contact_30',
         coalesce(m.last_contact_at, m.joined_at) + make_interval(days => v_quiet),
         (coalesce(m.last_contact_at, m.joined_at) + make_interval(days => v_quiet))::date,
         m.assigned_coach_id,
         jsonb_build_object('last_contact_at', m.last_contact_at, 'quiet_days', v_quiet)
    from public.coach_task_members() m
   where coalesce(m.last_contact_at, m.joined_at) + make_interval(days => v_quiet) <= now()
  on conflict (user_id, rule_key, opened_at) do nothing;
  get diagnostics v_n = row_count; v_opened := v_opened + v_n;

  -- ---- the close pass ----------------------------------------------------
  -- The same rule coach_tasks_close_on_contact() applies to one new row,
  -- applied to every open task: the EARLIEST member_contact_log row at or
  -- after opened_at closes it, and closing carries that contact's own
  -- timestamp and author. Deterministic (contacted_at, then id) so two runs
  -- can never disagree about which contact closed a task.
  perform set_config('app.allow_coach_task_close', 'on', true);
  update public.coach_tasks t
     set closed_at = c.contacted_at,
         closed_by = c.contacted_by
    from public.member_contact_log c
   where t.closed_at is null
     and c.user_id = t.user_id
     and c.contacted_at >= t.opened_at
     and c.id = (
       select c2.id from public.member_contact_log c2
        where c2.user_id = t.user_id and c2.contacted_at >= t.opened_at
        order by c2.contacted_at asc, c2.id asc
        limit 1);
  perform set_config('app.allow_coach_task_close', 'off', true);

  return v_opened;
end $$;
revoke all on function public.coach_tasks_sync() from public, anon;
-- Granted to authenticated because coach_tasks_list() calls it and the list
-- is a staff read; the function itself opens nothing a member could see and
-- is gated by the module key at its first line.
grant execute on function public.coach_tasks_sync() to authenticated;
comment on function public.coach_tasks_sync() is
  'Opens any coach_tasks row the five rules call for and closes every open task a member_contact_log row at or after its opened_at satisfies. Returns the number of tasks opened. Idempotent: every insert conflicts on (user_id, rule_key, opened_at). Returns 0 immediately when club_feature_enabled(''coach_tasks'') is false. Thresholds come from club_features.config via club_feature_number(): welcome_from_day 1, welcome_by_day 7, first_class_followup_days 3, low_attendance_window_days 21, low_attendance_min_sessions 2, checkin_day 60, no_contact_days 30, onboarding_window_days 90. Rules 1-4 are scoped to onboarding_window_days; no_contact_30 is not.';

-- ---------------------------------------------------------------------------
-- 6. The list, which syncs before it reads
-- ---------------------------------------------------------------------------
-- ONE function, not a STABLE reader plus a VOLATILE refresher wrapping it.
-- The wrapper shape needs the whole column list written out twice - Postgres
-- has no `returns setof <that function's row type>` for a function declared
-- `returns table(...)` - and a seventeen-column list with two copies is
-- exactly the drift this codebase keeps finding. So the read is volatile and
-- says so in its name.
create or replace function public.coach_tasks_refresh(
  p_include_closed boolean default false,
  p_limit integer default 100
)
returns table(
  id uuid,
  user_id uuid,
  handle text,
  display_name text,
  avatar_url text,
  rule_key text,
  opened_at timestamptz,
  due_on date,
  overdue boolean,
  assigned_coach_id uuid,
  assigned_coach_name text,
  joined_on date,
  days_since_join integer,
  sessions_logged integer,
  contacted_at timestamptz,
  closed_at timestamptz,
  detail jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer;
begin
  if not public.is_staff() then raise exception 'not authorized'; end if;
  -- Empty rather than an exception when the module is off. An admin
  -- switching a module off in one tab must not turn the coach's open tab
  -- into an error toast, and the RLS policy on the table says the same
  -- thing to anyone who asks the table directly.
  if not public.club_feature_enabled('coach_tasks') then return; end if;

  perform public.coach_tasks_sync();

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  return query
  select
    t.id,
    t.user_id,
    pr.handle,
    coalesce(nullif(pr.display_name, ''), pr.handle),
    pr.avatar_url,
    t.rule_key,
    t.opened_at,
    t.due_on,
    (t.closed_at is null and t.due_on < current_date),
    t.assigned_coach_id,
    coalesce(nullif(co.display_name, ''), co.handle),
    coalesce((select ir.redeemed_at from public.invite_redemptions ir where ir.user_id = pr.id), pr.created_at)::date,
    (current_date - coalesce((select ir.redeemed_at from public.invite_redemptions ir where ir.user_id = pr.id), pr.created_at)::date),
    -- A COUNT, NOT A LOG, for the reason coach_new_members() states at
    -- length: PRIVACY.md promises members that coaches see rates rather
    -- than a detailed log, and 202609060013 took raw attendance_log reads
    -- away from coach rank. This function is SECURITY DEFINER precisely so
    -- it can return the aggregate without handing the coach the rows.
    (select count(*) from public.attendance_log al where al.user_id = t.user_id)::integer,
    (select max(mcl.contacted_at) from public.member_contact_log mcl where mcl.user_id = t.user_id),
    t.closed_at,
    t.detail
  from public.coach_tasks t
  join public.profiles pr on pr.id = t.user_id
  left join public.profiles co on co.id = t.assigned_coach_id
  where t.club_id = public.default_club_id()
    and pr.deleted_at is null
    and (p_include_closed or t.closed_at is null)
  -- A work queue, not a roster: whatever is late comes first, then whatever
  -- is due soonest, then the oldest task, then the handle so the order is
  -- total and two renders of the same data never differ.
  order by
    (t.closed_at is null and t.due_on < current_date) desc,
    t.due_on asc,
    t.opened_at asc,
    pr.handle asc
  limit v_limit;
end $$;
revoke all on function public.coach_tasks_refresh(boolean, integer) from public, anon;
grant execute on function public.coach_tasks_refresh(boolean, integer) to authenticated;
comment on function public.coach_tasks_refresh(boolean, integer) is
  'The staff task list. Calls coach_tasks_sync() first, so the list a coach reads is never stale for want of somebody remembering to refresh it - hence the name rather than _list. AUTH: security definer, is_staff() or ''not authorized'' (P0001); opens nothing and returns NO rows when club_feature_enabled(''coach_tasks'') is false. Open tasks by default, overdue first then soonest due, ties broken by opened_at then handle. sessions_logged is an aggregate COUNT over attendance_log, never the rows behind it - see PRIVACY.md and coach_new_members(). p_limit clamped 1..500.';

-- ===========================================================================
-- PART 2. THE ONBOARDING CHALLENGE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 8. The one challenge row
-- ---------------------------------------------------------------------------
-- A fixed id, so every reader names the same row without a lookup by title
-- and without a "find or create" race. Same reasoning default_club_id()
-- already uses for the club itself.
create or replace function public.onboarding_challenge_id() returns uuid
language sql immutable set search_path = '' as $$
  select '0b0a0d17-0000-4000-8000-000000000001'::uuid;
$$;
revoke all on function public.onboarding_challenge_id() from public, anon;
grant execute on function public.onboarding_challenge_id() to authenticated;

-- EXISTING TABLE, EXISTING TYPE. challenge_type 'consistency' is one of the
-- six 202608280009 declared and is the right one: what this counts is
-- training days, not a load or a time.
--
-- STATUS 'draft', AND THAT IS THE MOST IMPORTANT LINE IN THIS FILE.
-- 'draft' in this schema means "not published to the club", and that is
-- exactly what this row is: a container the club never runs as a headline
-- challenge, because what runs is each member's own 30 days. It was 'active'
-- in the first draft of this migration and a local replay of the pgTAP suite
-- caught what that does - 0088 went red on five assertions, because
-- club_summary() (202609060027) picks `the active challenge with the soonest
-- end_at` for the club header and this row would have become it for every
-- member of the club, forever. chal_notify_ending_soon() (202608290006)
-- walks the same set. Neither is a place a container belongs.
--
-- 'draft' keeps it out of both with no edit to either deployed function, and
-- it buys three more guarantees for free, each of which would otherwise have
-- needed its own guard:
--   * challenge_participants_join_self requires c.status = 'active', so NO
--     member can self-join this challenge by any request they can make. The
--     only enrolment path is onboarding_challenge_respond(true).
--   * challenge_progress_insert_self and chal_record_progress (202609120009)
--     require the same, so neither a member nor a coach can hand-enter
--     progress against it. Progress is attendance_log or nothing.
--   * challenges_read shows a draft only to its author and to a
--     community.challenge.create holder, so it never appears on a member's
--     board. Coaches do see it; the client filters it out of the board list
--     by metric_type, which is a cosmetic hide over a real boundary rather
--     than the other way round.
-- The member never needs to read this row: everything their screen shows
-- comes from onboarding_challenge_state(), which is SECURITY DEFINER.
--
-- end_at is far away because the CHALLENGE is rolling - it is the member's
-- own 30-day window that ends, and that window lives on the offer row. The
-- (end_at > start_at) check is satisfied and nothing reads end_at for a
-- participant's deadline; chal_notify_ending_soon() would have, which is one
-- more reason this row is not active.
--
-- join_mode 'invite' says what this is: you are asked, you are not enrolled.
-- It is documentation rather than a gate - no policy in this schema reads
-- join_mode - and the real "never automatically" guarantee is the status
-- above plus the fact that onboarding_challenge_respond(true) is the only
-- writer of a participant row and it is called by the member.
--
-- created_by is null: the club created it, not a coach. challenges.created_by
-- has been nullable since 202608280009.
insert into public.challenges
  (id, club_id, title, description, challenge_type, metric_type, target_value,
   start_at, end_at, join_mode, visibility, status, created_by, config)
values (
  public.onboarding_challenge_id(),
  public.default_club_id(),
  'אתגר הכניסה',
  'שלושים הימים הראשונים במועדון. המטרה היא להגיע למספר אימונים בתוך חודש - בקצב שלך, בלי לחץ ובלי תחרות מול אף אחד.',
  'consistency',
  'onboarding_first_30_days',
  8,
  now(),
  '2099-12-31T00:00:00+00'::timestamptz,
  'invite',
  'club',
  'draft',
  null,
  '{"onboarding": true}'::jsonb
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 9. The offer
-- ---------------------------------------------------------------------------
-- The row that makes "accept or decline" a real choice with a real answer.
-- Without it a decline is indistinguishable from not having looked, and the
-- app would re-ask forever.
create table public.onboarding_challenge_offers (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  offered_at timestamptz not null default now(),
  responded_at timestamptz,
  response text check (response is null or response in ('accepted', 'declined')),
  -- FROZEN AT ACCEPTANCE, both of them. The live config decides what a NEW
  -- member is offered; it must never move the goalposts under somebody who
  -- is already running. Null until accepted.
  goal_sessions integer check (goal_sessions is null or goal_sessions between 1 and 60),
  window_days integer check (window_days is null or window_days between 1 and 365),
  started_at timestamptz,
  ends_at timestamptz,
  completed_at timestamptz
);
create index onboarding_challenge_offers_open_idx
  on public.onboarding_challenge_offers(club_id, responded_at);

alter table public.onboarding_challenge_offers enable row level security;
revoke all on public.onboarding_challenge_offers from public, anon;
-- SELECT only. Accepting and declining go through the definer RPC, which is
-- what lets "never enroll automatically" be a property of the schema rather
-- than of the client: there is no insert or update path a request can take.
grant select on public.onboarding_challenge_offers to authenticated;

create policy onboarding_challenge_offers_self_select
  on public.onboarding_challenge_offers for select to authenticated
  using (user_id = auth.uid() and public.club_feature_enabled('onboarding_challenge'));
-- Staff read it because "who was offered the challenge and who said no" is a
-- coach's question about their own club, and it is not sensitive: the member
-- is told they are being offered it. Same audience as the welcome queue.
create policy onboarding_challenge_offers_staff_select
  on public.onboarding_challenge_offers for select to authenticated
  using (public.is_staff()
         and club_id = public.default_club_id()
         and public.club_feature_enabled('onboarding_challenge'));

comment on table public.onboarding_challenge_offers is
  'One row per member who has been offered the 30-day onboarding challenge. response is null (offered, undecided), ''accepted'' or ''declined''. goal_sessions/window_days/started_at/ends_at are copied in at ACCEPTANCE and never re-read from config afterwards, so retuning the club setting cannot move the goalposts under a member mid-challenge. Members read their own row; staff read their club''s. No client write path of any kind: onboarding_challenge_respond() is the only writer, which is what makes "never enrolled automatically" a schema property.';

-- ---------------------------------------------------------------------------
-- 10. The member-facing read, which also makes the offer
-- ---------------------------------------------------------------------------
-- WHY THE OFFER IS CREATED HERE AND NOT BY A TRIGGER ON invite_redemptions.
-- That was the first shape and it was wrong twice over. post_new_member_on_join()
-- (202608290014) records that at redemption time "the profile usually does not
-- exist yet", and this table's user_id is a foreign key to profiles - so the
-- trigger would have been a no-op on the common path and a redemption-aborting
-- foreign key violation on the uncommon one. A member cannot see an offer
-- without opening the app, and this function is what the app calls when they
-- do, so creating it here is both safe and indistinguishable from the member's
-- point of view.
create or replace function public.onboarding_challenge_state() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_offer public.onboarding_challenge_offers;
  v_joined timestamptz;
  v_rank integer;
  v_is_admin boolean;
  v_offer_within integer;
  v_goal integer;
  v_days integer;
  v_progress integer;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- The gate 202609060009 put on every definer read that a bare anonymous
  -- session could otherwise reach.
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  if not public.club_feature_enabled('onboarding_challenge') then
    return jsonb_build_object('state', 'off');
  end if;
  -- The challenge lives on the challenges tables, and challenges_read
  -- (202609060011) is itself gated on club_feature_enabled('challenges'). A
  -- club that has switched challenges off has switched this off too, and
  -- saying so is more honest than offering something the member could not
  -- then open.
  if not public.club_feature_enabled('challenges') then
    return jsonb_build_object('state', 'off');
  end if;

  v_goal  := public.club_feature_number('onboarding_challenge', 'goal_sessions', 8, 1, 60)::integer;
  v_days  := public.club_feature_number('onboarding_challenge', 'window_days', 30, 1, 365)::integer;
  v_offer_within := public.club_feature_number('onboarding_challenge', 'offer_within_days', 30, 1, 365)::integer;

  select * into v_offer from public.onboarding_challenge_offers o where o.user_id = v_uid;

  if not found then
    -- Members only, and only while they are still new. Staff are not offered
    -- a newcomer's challenge; the same role_rank test coach_task_members()
    -- and coach_new_members() use.
    select coalesce(public.role_rank(ir.role), 10), coalesce(pr.is_admin, false),
           coalesce(ir.redeemed_at, pr.created_at)
      into v_rank, v_is_admin, v_joined
      from public.profiles pr
      left join public.invite_redemptions ir on ir.user_id = pr.id
     where pr.id = v_uid and pr.deleted_at is null;
    if not found or v_rank >= 20 or v_is_admin then
      return jsonb_build_object('state', 'none');
    end if;
    if v_joined < now() - make_interval(days => v_offer_within) then
      return jsonb_build_object('state', 'none');
    end if;
    insert into public.onboarding_challenge_offers (user_id) values (v_uid)
    on conflict (user_id) do nothing;
    select * into v_offer from public.onboarding_challenge_offers o where o.user_id = v_uid;
  end if;

  if v_offer.response is null then
    return jsonb_build_object(
      'state', 'offered',
      'goal_sessions', v_goal,
      'window_days', v_days,
      'challenge_id', public.onboarding_challenge_id(),
      'offered_at', v_offer.offered_at);
  end if;

  if v_offer.response = 'declined' then
    return jsonb_build_object('state', 'declined', 'responded_at', v_offer.responded_at);
  end if;

  -- Accepted. Progress is counted straight off attendance_log inside the
  -- member's own frozen window, which is the same number the completion test
  -- uses - one definition, not two.
  select count(*) into v_progress
    from public.attendance_log al
   where al.user_id = v_uid
     and al.occurred_on >= v_offer.started_at::date
     and al.occurred_on <= v_offer.ends_at::date;

  return jsonb_build_object(
    'state', case
               when v_offer.completed_at is not null then 'completed'
               when now() > v_offer.ends_at then 'expired'
               else 'accepted'
             end,
    'goal_sessions', v_offer.goal_sessions,
    'window_days', v_offer.window_days,
    'started_at', v_offer.started_at,
    'ends_at', v_offer.ends_at,
    'days_left', greatest(0, (v_offer.ends_at::date - current_date)),
    'progress', v_progress,
    'completed_at', v_offer.completed_at,
    'challenge_id', public.onboarding_challenge_id());
end $$;
revoke all on function public.onboarding_challenge_state() from public, anon;
grant execute on function public.onboarding_challenge_state() to authenticated;
comment on function public.onboarding_challenge_state() is
  'The caller''s own onboarding-challenge state, and the ONLY thing that creates an offer row. Returns {state: off|none|offered|declined|accepted|expired|completed, ...}. off = the onboarding_challenge or challenges module is switched off; none = not eligible (staff, admin, or joined more than offer_within_days ago). AUTH: security definer, auth.uid() then is_community_member() (202609060009''s gate). Creates the offer lazily on first read rather than from a trigger on invite_redemptions, because at redemption time the profile row this table''s foreign key needs usually does not exist yet. Progress is counted off attendance_log inside the member''s own frozen window.';

-- ---------------------------------------------------------------------------
-- 11. Accept or decline
-- ---------------------------------------------------------------------------
create or replace function public.onboarding_challenge_respond(p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_offer public.onboarding_challenge_offers;
  v_goal integer;
  v_days integer;
  v_now timestamptz := now();
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if p_accept is null then raise exception 'accept or decline is required'; end if;
  if not public.club_feature_enabled('onboarding_challenge')
     or not public.club_feature_enabled('challenges') then
    raise exception 'module disabled';
  end if;

  select * into v_offer from public.onboarding_challenge_offers o
   where o.user_id = v_uid for update;
  -- No offer, or one already answered. Deliberately an exception rather than
  -- a silent no-op: the client only renders the two buttons when state is
  -- 'offered', so reaching here means the two disagree and swallowing that
  -- would hide it.
  if not found then raise exception 'no open offer'; end if;
  if v_offer.responded_at is not null then raise exception 'this offer was already answered'; end if;

  if not p_accept then
    update public.onboarding_challenge_offers
       set response = 'declined', responded_at = v_now
     where user_id = v_uid;
    return public.onboarding_challenge_state();
  end if;

  v_goal := public.club_feature_number('onboarding_challenge', 'goal_sessions', 8, 1, 60)::integer;
  v_days := public.club_feature_number('onboarding_challenge', 'window_days', 30, 1, 365)::integer;

  update public.onboarding_challenge_offers
     set response = 'accepted',
         responded_at = v_now,
         goal_sessions = v_goal,
         window_days = v_days,
         started_at = v_now,
         ends_at = v_now + make_interval(days => v_days)
   where user_id = v_uid;

  -- THE ONE WRITE OF A PARTICIPANT ROW IN THIS WHOLE FILE, and it happens
  -- here, after the member said yes, in their own call.
  insert into public.challenge_participants (challenge_id, user_id)
  values (public.onboarding_challenge_id(), v_uid)
  on conflict (challenge_id, user_id) do nothing;

  -- The club's current goal, on the club's challenge row, so a coach looking
  -- at the challenge sees the setting that is actually in force. Per-member
  -- goals live on the offer and are not touched by this.
  update public.challenges
     set target_value = v_goal
   where id = public.onboarding_challenge_id()
     and target_value is distinct from v_goal;

  return public.onboarding_challenge_state();
end $$;
revoke all on function public.onboarding_challenge_respond(boolean) from public, anon;
grant execute on function public.onboarding_challenge_respond(boolean) to authenticated;
comment on function public.onboarding_challenge_respond(boolean) is
  'The member accepts (true) or declines (false) their onboarding challenge, and nobody else can do it for them. Raises ''no open offer'' or ''this offer was already answered'' (both P0001) rather than no-opping, and ''module disabled'' when onboarding_challenge or challenges is off. On accept it freezes goal_sessions and window_days onto the offer row, stamps the 30-day window, and inserts the ONE challenge_participants row this file ever writes. Returns onboarding_challenge_state().';

-- ---------------------------------------------------------------------------
-- 12. Progress, and the achievement at the end of it
-- ---------------------------------------------------------------------------
-- HUNG OFF attendance_log, NOT off private_records, and that is the whole
-- "whatever its source" requirement: the day arbox_attendance (another of
-- 202609190002's seven) starts writing attendance rows from the booking
-- system, this counts them without a line changing here.
--
-- WHY COMPLETION IS DECIDED HERE AND NOT BY challenge_progress_apply().
-- That trigger auto-completes only 'individual_target' and
-- 'individual_performance' challenges against challenges.target_value - one
-- number shared by every participant. This challenge's goal is per member
-- and frozen on their own offer row, so the test has to read that row. The
-- progress log is still written and still lands on
-- challenge_participants.progress_value through challenge_progress_apply, so
-- every existing challenge surface keeps working; only the completion
-- decision is ours.
create or replace function public.onboarding_challenge_progress_on_attendance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_offer public.onboarding_challenge_offers;
  v_challenge uuid := public.onboarding_challenge_id();
  v_days integer;
  v_def_id uuid;
  v_def_visibility text;
begin
  if not public.club_feature_enabled('onboarding_challenge') then return new; end if;

  select * into v_offer from public.onboarding_challenge_offers o
   where o.user_id = new.user_id
     and o.response = 'accepted'
     and o.completed_at is null;
  if not found then return new; end if;
  if v_offer.started_at is null or v_offer.ends_at is null then return new; end if;

  -- Inside the member's own window, by calendar day. attendance_log is
  -- already one row per member per day (202608310001), so one insert here is
  -- one day and there is nothing to de-duplicate.
  if new.occurred_on < v_offer.started_at::date or new.occurred_on > v_offer.ends_at::date then
    return new;
  end if;

  insert into public.challenge_progress (challenge_id, user_id, delta, source_type, source_id)
  values (v_challenge, new.user_id, 1, 'attendance', new.id);

  -- Counted off attendance_log rather than off the progress log we have just
  -- written: one definition of "how many days", shared with
  -- onboarding_challenge_state(), and immune to a progress row that some
  -- future path writes twice.
  select count(*) into v_days
    from public.attendance_log al
   where al.user_id = new.user_id
     and al.occurred_on >= v_offer.started_at::date
     and al.occurred_on <= v_offer.ends_at::date;

  if v_days < v_offer.goal_sessions then return new; end if;

  update public.onboarding_challenge_offers
     set completed_at = now()
   where user_id = new.user_id and completed_at is null;

  -- challenge_participants_guard_progress() (202609060005) permits exactly
  -- this: the member's OWN row moving 'active' -> 'completed'. No pin is
  -- needed and none is taken - this trigger runs in the member's own session
  -- because attendance_log rows are written by their own sync.
  update public.challenge_participants
     set status = 'completed', completed_at = now()
   where challenge_id = v_challenge
     and user_id = new.user_id
     and status = 'active';

  select d.id, d.visibility into v_def_id, v_def_visibility
    from public.achievement_definitions d
   where d.code = 'onboarding_challenge_done' and d.enabled;
  if found then
    -- member_achievements_once_idx decides "already holds it", atomically,
    -- which is why this is a plain on-conflict rather than an exists() test.
    insert into public.member_achievements (user_id, achievement_id, visibility)
    values (new.user_id, v_def_id, v_def_visibility)
    on conflict do nothing;
  end if;

  return new;
end $$;
revoke all on function public.onboarding_challenge_progress_on_attendance() from public, anon, authenticated;

create trigger attendance_log_onboarding_challenge
  after insert on public.attendance_log
  for each row execute function public.onboarding_challenge_progress_on_attendance();

comment on function public.onboarding_challenge_progress_on_attendance() is
  'AFTER INSERT on attendance_log, fired as attendance_log_onboarding_challenge. For a member with an accepted, uncompleted onboarding offer, and only for a day inside their own frozen window, writes one challenge_progress delta (source_type ''attendance'') and then tests completion against the count of attendance days in that window versus the goal frozen on the offer row - never against challenges.target_value, which is one number for everyone. On completion it stamps the offer, moves the participant to ''completed'' (the one transition challenge_participants_guard_progress permits for a member''s own row) and unlocks the onboarding_challenge_done achievement. Gated on club_feature_enabled(''onboarding_challenge'').';

-- ---------------------------------------------------------------------------
-- 13. The achievement
-- ---------------------------------------------------------------------------
-- Existing shape, existing category, existing trigger_type. CHALLENGE_COMPLETED
-- has been a legal trigger_type since 202608280007 and has had no producer
-- since; this is its first. Hebrew name, Hebrew description and an icon,
-- because supabase/tests/0074 requires all three of every ENABLED definition
-- and a blank badge on a member's profile is what that test exists to stop.
--
-- NO client_claimable KEY AT ALL. ach_claim() refuses a code it cannot
-- independently verify, and this one is not a claim a browser could make:
-- the count comes from attendance_log inside a window the server stamped.
insert into public.achievement_definitions
  (code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  ('onboarding_challenge_done',
   'אתגר הכניסה הושלם',
   'השלמת את אתגר שלושים הימים הראשונים במועדון',
   'challenge', 'CHALLENGE_COMPLETED', 1, false, 'club', '🎯', true,
   '{"metric": "onboarding_challenge"}'::jsonb)
on conflict (code) do nothing;

-- member_achievements_compute_verified() (202609120001) gains one clause.
--
-- READ THAT MIGRATION'S ARGUMENT BEFORE JUDGING THIS. `verified` is true only
-- for a claim independently checkable server-side, and false for every metric
-- whose only evidence is the member's own device - because ach_share() refuses
-- to turn an unverified claim into a public feed post. This achievement is in
-- the first group and not the second: the member never asserts it, ach_claim
-- cannot mint it, and the evidence behind it is attendance_log rows inside a
-- window this schema stamped, tested by a trigger the client cannot call. Its
-- own comment names exactly this case - "a genuinely new server-verifiable
-- metric" - and says the shape to reuse is config->>'metric'.
--
-- Recreated in full rather than patched, because that is the only mechanism
-- Postgres offers, and byte-identical to 202609120001 apart from the one
-- added disjunct.
create or replace function public.member_achievements_compute_verified() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_def public.achievement_definitions;
begin
  select * into v_def from public.achievement_definitions d where d.id = new.achievement_id;
  -- Authoritative, not advisory: overrides whatever the inserting function
  -- tried to set, so a future bug in ach_claim (or any new caller) cannot
  -- accidentally mark an unverifiable claim as verified.
  new.verified := (
    found
    and (
      v_def.trigger_type = 'ATTENDANCE_RECORDED'
      or coalesce(v_def.config ->> 'metric', '') = 'tenure_days'
      -- 202609220002. Server-derived end to end: attendance_log days inside a
      -- window onboarding_challenge_respond() stamped, tested by
      -- onboarding_challenge_progress_on_attendance(), with no client input
      -- at any step and no ach_claim path that can reach the code.
      or coalesce(v_def.config ->> 'metric', '') = 'onboarding_challenge'
    )
  );
  return new;
end $$;
revoke all on function public.member_achievements_compute_verified() from public, anon, authenticated;

commit;
