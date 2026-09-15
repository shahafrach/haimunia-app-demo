-- Bug reports, gathered in the admin panel (2026-09-15).
--
-- WHY THIS EXISTS. The support sheet shipped earlier today (app.js,
-- openSupport) composes a report locally and hands it to WhatsApp or mail.
-- That was the right call for the reporting PATH - a bug report must not
-- depend on a working client, network, session and RLS path, because
-- reporting a bug is exactly the moment those may be what is broken - and it
-- stays exactly as it is. What it does not do is COLLECT anything: a report
-- that lands in an inbox is one person's problem to triage by hand, with no
-- status, no history, and no way for a second admin to see it was handled.
-- This table is the collection half. The two are complements, not
-- alternatives, and the client tries this FIRST and falls back to the
-- handoff, never the reverse.
--
-- THE DELIBERATE ASYMMETRY. Anyone in the club may WRITE a report and may
-- read back ONLY their own. Reading everyone's is staff-only, and changing a
-- report's status is admin-only. A bug report carries a free-text description
-- a member wrote while frustrated, plus their device fingerprint - that is
-- not feed content and must not be club-visible, so there is deliberately no
-- "visible to members" path at all.

create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  -- on delete set null, NOT cascade: a report is evidence about the app, and
  -- it stays useful after the member who filed it deletes their account. The
  -- account-deletion promise is about personal data, and what survives here
  -- is an anonymous description of a defect - see the nulling trigger below,
  -- which strips the body's authorship link rather than keeping a dangling one.
  reporter_id uuid references auth.users(id) on delete set null,
  -- What the member typed. Bounded so a paste bomb cannot be stored: the
  -- client textarea has no maxlength (a member mid-report should never be cut
  -- off mid-sentence by a silent limit), so the bound lives here and the RPC
  -- truncates rather than rejecting - losing the tail of a very long report
  -- is strictly better than losing the report.
  body text not null check (char_length(body) between 1 and 4000),
  -- The device facts app.js's supportDiagnostics() already renders on screen
  -- before sending. jsonb rather than text so the admin panel can show them
  -- as fields and so a future query ("only iOS reports") is possible without
  -- a migration. Bounded for the same reason as body.
  diagnostics jsonb not null default '{}'::jsonb
    check (pg_column_size(diagnostics) <= 8192),
  -- open -> in_progress -> resolved / wont_fix. A closed vocabulary rather
  -- than free text, for the same reason every other status column in this
  -- schema is one: a typo must not create a fifth silent state.
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'wont_fix')),
  -- Staff-internal. NEVER exposed to the reporter - see the column-level
  -- reasoning in 202609120012, which had to fix exactly this mistake on two
  -- moderation tables: RLS decides which ROWS a query sees, never which
  -- COLUMNS, so a "read your own row" policy hands over every staff-internal
  -- column on it too. The reporter's own read below goes through a function
  -- that selects an explicit safe column list, not through a row policy.
  admin_note text check (admin_note is null or char_length(admin_note) <= 2000),
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);

-- DB-M3 (202609060015): every FK column outside club_id must lead an index.
create index bug_reports_reporter_id_idx on public.bug_reports(reporter_id);
create index bug_reports_handled_by_idx on public.bug_reports(handled_by);
-- The admin panel's own query: open reports first, newest first.
create index bug_reports_status_created_idx on public.bug_reports(status, created_at desc);

alter table public.bug_reports enable row level security;

-- No direct client SELECT at all, in either direction. Both reads go through
-- SECURITY DEFINER functions below that name their columns explicitly, so
-- admin_note and handled_by cannot leak to a reporter the way 202609120012
-- found them leaking on the moderation tables.
revoke all on public.bug_reports from anon, authenticated;

-- Writes go through bug_report_submit() only (definer, rate-limited), so
-- there is no insert policy and no client INSERT grant either. A member
-- cannot forge reporter_id because they never touch the table.

comment on table public.bug_reports is
  'In-app bug reports, collected for the admin panel (202609150002). Complements - never replaces - app.js''s openSupport() WhatsApp/mail handoff, which stays the fallback for an offline member, a member with Community switched off, and the case where the app itself is too broken to reach the database. No direct client access in either direction: writes go through bug_report_submit(), reads through bug_report_list_mine()/bug_report_list_all(), each naming its columns explicitly so staff-internal admin_note/handled_by cannot reach a reporter (the column-exposure class of bug 202609120012 had to fix on two moderation tables).';

-- =====================================================================
-- Submit
-- =====================================================================
-- Rate-limited with the same helper every other member-facing write uses.
-- 10 per hour is deliberately generous: a member hitting a genuinely broken
-- screen may legitimately file several in a row, and the failure mode of a
-- tight limit here is that the app silently refuses to accept a bug report,
-- which is the worst possible thing for this particular table to do.
create or replace function public.bug_report_submit(p_body text, p_diagnostics jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_body text;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if not public.is_community_member() then raise exception 'not authorized' using errcode = 'P0001'; end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then raise exception 'body required' using errcode = 'P0001'; end if;
  -- Truncate rather than reject: see the table comment. A member who wrote
  -- 5000 characters about a defect should not be told to write less.
  v_body := left(v_body, 4000);

  perform public.check_rate_limit('bug_report_submit', 10, 60);

  insert into public.bug_reports (reporter_id, body, diagnostics)
  values (auth.uid(), v_body, coalesce(p_diagnostics, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.bug_report_submit(text, jsonb) from public, anon;
grant execute on function public.bug_report_submit(text, jsonb) to authenticated;
comment on function public.bug_report_submit(text, jsonb) is
  'Files a bug report for the calling community member (202609150002). SECURITY DEFINER: the table has no client grants, so reporter_id is set from auth.uid() here and cannot be forged. Rate-limited 10/hour - generous on purpose, because refusing a bug report is the worst failure this table can have. Body is TRUNCATED at 4000 chars rather than rejected. Raises ''not authorized'' (no session or not a member) and ''body required'' (empty after trim), both P0001.';

-- =====================================================================
-- Read: the reporter's own
-- =====================================================================
-- Explicit safe column list. admin_note and handled_by are absent by
-- construction, not by policy - the reporter learns the status of their own
-- report and nothing about who inside the club looked at it.
create or replace function public.bug_report_list_mine()
returns table (id uuid, body text, status text, created_at timestamptz)
language sql security definer set search_path = '' as $$
  select r.id, r.body, r.status, r.created_at
  from public.bug_reports r
  where r.reporter_id = auth.uid() and auth.uid() is not null
  order by r.created_at desc
  limit 50;
$$;
revoke all on function public.bug_report_list_mine() from public, anon;
grant execute on function public.bug_report_list_mine() to authenticated;
comment on function public.bug_report_list_mine() is
  'A member''s own bug reports, newest first, capped at 50 (202609150002). Returns id/body/status/created_at ONLY - admin_note and handled_by are staff-internal and are absent from the return type by construction, so the column-exposure failure 202609120012 fixed on the moderation tables cannot recur here.';

-- =====================================================================
-- Read: the admin panel
-- =====================================================================
create or replace function public.bug_report_list_all(p_status text default null, p_limit int default 100)
returns table (
  id uuid, reporter_id uuid, reporter_handle text, reporter_display_name text,
  body text, diagnostics jsonb, status text, admin_note text,
  handled_by uuid, handled_at timestamptz, created_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 200));
begin
  -- is_staff(), matching who can already see the moderation queue and the
  -- audit log this panel sits beside. Reading a bug report is not a
  -- privileged action relative to those; ACTING on one (below) is admin-only.
  if not public.is_staff() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  return query
  select r.id, r.reporter_id, pr.handle, pr.display_name,
         r.body, r.diagnostics, r.status, r.admin_note,
         r.handled_by, r.handled_at, r.created_at
  from public.bug_reports r
  left join public.profiles pr on pr.id = r.reporter_id
  where p_status is null or r.status = p_status
  -- Open first, then newest: the panel's job is "what still needs a human".
  order by (r.status = 'open') desc, r.created_at desc
  limit v_limit;
end $$;
revoke all on function public.bug_report_list_all(text, int) from public, anon;
grant execute on function public.bug_report_list_all(text, int) to authenticated;
comment on function public.bug_report_list_all(text, int) is
  'Every bug report, for the admin panel (202609150002). is_staff() gated - the same access the moderation queue and audit log beside it already use; ACTING on a report is admin-only (bug_report_set_status). Open reports sort first, then newest. p_limit clamped 1-200.';

-- =====================================================================
-- admin_actions vocabulary
-- =====================================================================
-- action_type is a CLOSED vocabulary (a CHECK, not free text) so that a typo
-- cannot mint a silent new action class - the same reasoning bug_reports.status
-- follows above. Closing a bug report is a real admin action and belongs in the
-- same audit trail as deleting a post, so the vocabulary is extended by exactly
-- one value rather than the action being logged under a vaguely-related
-- existing one. Rebuilt in full rather than appended to, because a CHECK
-- constraint has no "add one value" form; the 29 existing values are carried
-- over verbatim.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check
  check (action_type = any (array[
    'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
    'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
    'content_pin', 'content_unpin', 'report_review', 'member_of_week_publish',
    'monthly_recap_publish', 'club_feature_toggle', 'invite_created',
    'invite_revoked', 'shared_code_created', 'shared_code_status_changed',
    'onboarding_content_updated', 'member_password_reset', 'announcement_edit',
    'member_remove', 'invite_reclaimed', 'club_wod_published', 'club_wod_edited',
    'club_wod_retired', 'club_wod_restored', 'club_wod_session_published',
    'club_wod_session_cancelled',
    -- New in 202609150002.
    'bug_report_status'
  ]));

-- target_type is a second, independent closed vocabulary on the same table,
-- and it needs the new object class too. Extended the same way and for the
-- same reason.
alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check
  check (target_type = any (array[
    'post', 'comment', 'member', 'role', 'challenge', 'achievement', 'event',
    'announcement', 'report', 'club', 'monthly_club_recap',
    'challenge_participant', 'challenge_team', 'invite', 'invite_code',
    'onboarding_step', 'club_wod', 'club_wod_session',
    -- New in 202609150002.
    'bug_report'
  ]));

-- =====================================================================
-- Act: change status
-- =====================================================================
create or replace function public.bug_report_set_status(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = 'P0001'; end if;
  if p_status not in ('open', 'in_progress', 'resolved', 'wont_fix') then
    raise exception 'invalid status' using errcode = 'P0001';
  end if;

  update public.bug_reports
  set status = p_status,
      admin_note = case when p_note is null then admin_note else left(btrim(p_note), 2000) end,
      -- Cleared when a report is reopened, so "who closed this" never points
      -- at someone for a report that is open again.
      handled_by = case when p_status = 'open' then null else auth.uid() end,
      handled_at = case when p_status = 'open' then null else now() end
  where id = p_id;
  if not found then raise exception 'report not found' using errcode = 'P0001'; end if;

  -- Same audit trail every other admin action in this module writes, so a
  -- report quietly marked wont_fix is as traceable as a post deletion.
  -- admin_actions' real column names: admin_id / action_type (not actor_id /
  -- action). club_id defaults via default_club_id().
  insert into public.admin_actions (admin_id, action_type, target_type, target_id, after_data)
  values (auth.uid(), 'bug_report_status', 'bug_report', p_id,
          jsonb_build_object('status', p_status, 'has_note', p_note is not null));
end $$;
revoke all on function public.bug_report_set_status(uuid, text, text) from public, anon;
grant execute on function public.bug_report_set_status(uuid, text, text) to authenticated;
comment on function public.bug_report_set_status(uuid, text, text) is
  'Moves a bug report through open/in_progress/resolved/wont_fix (202609150002). is_admin() gated, deliberately stricter than the is_staff() read beside it. Reopening to ''open'' CLEARS handled_by/handled_at so the record never names someone for a report that is open again. Writes an admin_actions row (bug_report_status), so closing a report is as traceable as deleting a post. Raises ''not authorized'', ''invalid status'', ''report not found'', all P0001.';

-- =====================================================================
-- Account deletion: keep the defect, drop the person
-- =====================================================================
-- reporter_id is `on delete set null` above, which unlinks the account but
-- leaves whatever the member typed. A bug description can easily name its
-- author ("my profile photo", a handle, a real name), so the row's free text
-- is cleared at the same moment - what survives is the device fingerprint and
-- the status, which is the part that is genuinely about the app.
create or replace function public.bug_reports_anonymize_on_user_delete()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.bug_reports
  set body = '[הדיווח נמחק יחד עם החשבון]'
  where reporter_id = old.id;
  return old;
end $$;
revoke all on function public.bug_reports_anonymize_on_user_delete() from public, anon, authenticated;

drop trigger if exists bug_reports_anonymize_before_user_delete on auth.users;
create trigger bug_reports_anonymize_before_user_delete
  before delete on auth.users
  for each row
  execute function public.bug_reports_anonymize_on_user_delete();
