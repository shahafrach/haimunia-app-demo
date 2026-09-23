begin;

-- Launch-readiness audit (docs/audit/launch-readiness.md), three of the
-- data-deletion gaps: B3 (photos outlive the account), B4 (two telemetry
-- tables are never purged) and the audit-log half of the restriction reason.
-- The fourth gap in the same batch, B5 (a backup-only member has no delete
-- button), is client-only and lives in cloud.js; it reuses
-- request_account_deletion() unchanged, so nothing about it is here.
--
-- Forward-only, as always: purge_due_accounts() (202608260001),
-- retention_purge_telemetry() (202609050005) and the purge-due-accounts
-- schedule (202609060011) are all applied, so every change to them is made
-- here rather than in those files.

-- =====================================================================
-- 1. Photos: queued at account deletion, removed through the Storage API
-- =====================================================================
-- purge_due_accounts() deletes auth.users rows and lets the foreign keys do
-- the rest. Nothing in storage.objects references auth.users, so every photo
-- a member uploaded - post photos and avatars - outlived the account that
-- PRIVACY.md says is gone after 30 days.
--
-- WHY NOT `delete from storage.objects` HERE. storage.objects is Storage's
-- metadata, not the file. Deleting the row from SQL leaves the bytes in the
-- backing store with nothing left pointing at them - the photo becomes
-- unreachable by us and still exists, which is worse than the gap it claims
-- to close. Current Storage also refuses a direct DELETE on that table
-- outright. The only real delete is the Storage API, which is HTTP, which a
-- trigger cannot wait on. So the deletion is split in two:
--
--   (a) HERE, in the same transaction as the account delete: a BEFORE DELETE
--       trigger on auth.users copies the (bucket, path) of every object the
--       member owns into public.storage_erasure_queue. It cannot be skipped
--       and cannot be forgotten by a caller, because it is not in a caller.
--   (b) The purge_abandoned_profiles Edge Function, already deployed and
--       already run nightly at 03:31 by cron_invoke_edge_function(), drains
--       the queue with storage.remove() and clears each row only after the
--       API confirms it. A failed remove leaves the row for the next night.
--
-- The trigger is on auth.users, not in purge_due_accounts(), for the same
-- reason bug_reports_anonymize_on_user_delete() (202609150002) is: it then
-- covers every path that removes an account - the 30-day purge, the
-- abandoned-profile purge, and a delete from the dashboard - with one copy
-- of the rule instead of three.
--
-- WHICH OBJECTS. Every bucket, not a list of two. Both buckets today
-- (post-photos, avatar-photos) are written under `<uid>/...` and their
-- policies enforce it; `owner` catches an object uploaded under a path that
-- does not follow the convention. Naming the buckets would make the third
-- bucket someone adds next year the next gap of exactly this shape.
create table if not exists public.storage_erasure_queue (
  bucket_id text not null,
  object_name text not null,
  queued_at timestamptz not null default now(),
  attempts integer not null default 0,
  primary key (bucket_id, object_name)
);
alter table public.storage_erasure_queue enable row level security;
-- No policy and no client grant: the trigger writes it with definer rights
-- and the service role reads it through the two functions below.
revoke all on public.storage_erasure_queue from public, anon, authenticated;

comment on table public.storage_erasure_queue is
  'Storage objects belonging to a deleted account, waiting for the Storage API to remove them (202609230001). Filled by storage_queue_erasure_on_user_delete() BEFORE DELETE ON auth.users; drained by the purge_abandoned_profiles Edge Function through storage_erasure_pending() / storage_erasure_done(). Holds a bucket and a path, never the file and never a user id: the path''s first segment is the deleted account''s uuid, which no longer resolves to anyone. A row that stays here past a night is a remove the API refused; attempts counts the drains that saw it. No client role can read or write it.';

create or replace function public.storage_queue_erasure_on_user_delete()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_erasure_queue (bucket_id, object_name)
  select o.bucket_id, o.name
    from storage.objects o
   where o.name is not null
     and (split_part(o.name, '/', 1) = old.id::text or o.owner = old.id)
  on conflict (bucket_id, object_name) do nothing;
  return old;
end $$;
revoke all on function public.storage_queue_erasure_on_user_delete() from public, anon, authenticated;

drop trigger if exists storage_queue_erasure_before_user_delete on auth.users;
create trigger storage_queue_erasure_before_user_delete
  before delete on auth.users
  for each row
  execute function public.storage_queue_erasure_on_user_delete();

comment on function public.storage_queue_erasure_on_user_delete() is
  'BEFORE DELETE trigger on auth.users (202609230001). Queues every storage.objects row in ANY bucket whose first path segment is the deleted account''s uuid, or whose owner is that account, into public.storage_erasure_queue for the Storage API to remove. Covers every account-removal path at once: purge_due_accounts(), purge_abandoned_profiles() and a dashboard delete. Does not delete from storage.objects itself - that would orphan the file in the backing store. Idempotent on (bucket_id, object_name).';

create or replace function public.storage_erasure_pending(p_limit integer default 500)
returns table (bucket_id text, object_name text)
language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
begin
  return query
  with picked as (
    select q.bucket_id, q.object_name
      from public.storage_erasure_queue q
     order by q.queued_at, q.bucket_id, q.object_name
     limit v_limit
  ),
  touched as (
    update public.storage_erasure_queue q
       set attempts = q.attempts + 1
      from picked p
     where q.bucket_id = p.bucket_id and q.object_name = p.object_name
    returning q.bucket_id, q.object_name
  )
  select t.bucket_id, t.object_name from touched t;
end $$;
revoke all on function public.storage_erasure_pending(integer) from public, anon, authenticated;
grant execute on function public.storage_erasure_pending(integer) to service_role;
comment on function public.storage_erasure_pending(integer) is
  'service_role only (202609230001). Returns up to p_limit (default 500, clamped 1..5000) queued storage objects, oldest first, and bumps each one''s attempts. Read by the purge_abandoned_profiles Edge Function, which removes them through the Storage API and then calls storage_erasure_done() for the ones the API confirmed. Deletes nothing itself.';

create or replace function public.storage_erasure_done(p_bucket text, p_names text[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from public.storage_erasure_queue q
   where q.bucket_id = p_bucket
     and q.object_name = any (coalesce(p_names, array[]::text[]));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.storage_erasure_done(text, text[]) from public, anon, authenticated;
grant execute on function public.storage_erasure_done(text, text[]) to service_role;
comment on function public.storage_erasure_done(text, text[]) is
  'service_role only (202609230001). Clears the named objects in p_bucket from public.storage_erasure_queue once the Storage API has removed them, and returns how many rows it cleared. Called by the purge_abandoned_profiles Edge Function only after storage.remove() returned no error for that batch.';

-- The drain runs inside the 03:31 purge_abandoned_profiles run. The 30-day
-- purge ran at 03:59, so a member purged tonight kept their photos until
-- 03:31 TOMORROW. Moving the purge to 03:29 puts it two minutes ahead of the
-- drain, so the photos go the same night as the account. cron.schedule
-- upserts on the job name, so this changes the schedule of the existing job
-- (same jobid) rather than adding a second one.
select cron.schedule('purge-due-accounts', '29 3 * * *',
  $$select public.purge_due_accounts()$$);

-- =====================================================================
-- 2. activity_pings and feed_interactions join the 90-day retention
-- =====================================================================
-- PRIVACY.md defines community activity as the days you opened the app plus
-- feed, post and reaction events, and says it is deleted after 90 days.
-- retention_purge_telemetry() only ever covered feed_impressions and
-- analytics_events. The same function now covers all four, so the promise
-- has one clock, not two.
--
-- WHAT THIS COSTS, stated plainly because it is irreversible:
--   * community_streaks() computes a streak from activity_pings, so a run of
--     consecutive app-open days is now visible for at most the window. At
--     the default 90 that is a 90-day streak ceiling. No achievement or
--     notification is keyed on an app-open streak that long - the weekly
--     training streak reads attendance_log, which this does not touch.
--   * last_activity_on / last_seen (roster, coach queues) is null for a
--     member who has not opened the app in 90 days, rather than a date.
--   * The only reader of feed_interactions history, the classmate and
--     suggestion signals, looks back 60 days, inside the window.
--
-- activity_pings is keyed by the day the member opened the app, so it is
-- purged on activity_date; created_at is also checked so a row carrying a
-- future activity_date cannot outlive the window by construction.
create index if not exists activity_pings_activity_date_idx
  on public.activity_pings(activity_date);
create index if not exists feed_interactions_created_at_idx
  on public.feed_interactions(created_at);

create or replace function public.retention_purge_telemetry(p_days integer default 90)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 3650);
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  v_deleted integer := 0;
  v_n integer;
begin
  delete from public.feed_impressions where shown_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.analytics_events where created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.feed_interactions where created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.activity_pings
   where activity_date < v_cutoff::date or created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  return v_deleted;
end $$;
revoke all on function public.retention_purge_telemetry(integer) from public, anon, authenticated;
comment on function public.retention_purge_telemetry(integer) is
  'COMM-P retention, widened by 202609230001. Deletes rows older than p_days from the four community-activity tables PRIVACY.md promises to delete after 90 days: public.feed_impressions (shown_at), public.analytics_events (created_at), public.feed_interactions (created_at) and public.activity_pings (activity_date, or created_at, whichever is older than the window). Returns the TOTAL number of rows removed across all four - the same "rows written" integer convention notif_batch_flush_due() and recompute_feed_weights() return. p_days defaults to 90 and is clamped to 1..3650; null is treated as 90. IRREVERSIBLE: there is no soft-delete and no archive; an app-open streak is visible for at most p_days, and last_activity_on is null for a member absent longer than that. SECURITY DEFINER with the grant as the only gate and NO auth.uid() check, the documented exception every scheduled job in this schema carries (notif_batch_flush_due, recompute_feed_weights, seed_onboarding_progress): a cron job has no session to check. GRANTED TO NO ROLE - it runs as the job owner, and nothing a client can reach may call it. Scheduled daily as ''telemetry-retention-purge''.';

-- =====================================================================
-- 3. The restriction reason in the audit log goes with the account
-- =====================================================================
-- mod_restrict_member() and mod_lift_restriction() copy the staff member's
-- free-text reason into admin_actions twice: after_data.reason (or
-- .lift_reason) and the note column. posting_restrictions itself cascades
-- from profiles, so the original row goes with the account; the audit copy
-- never did, because admin_actions has no foreign key on purpose - the row
-- has to outlive the account. A reason like "posted about his injury" is
-- exactly the text that must not.
--
-- Same shape as bug_reports_anonymize_on_user_delete() (202609150002): the
-- row stays, what happened stays (action, restriction type, dates, who
-- acted), and the free text a person wrote about the member is replaced.
--
-- WHICH ROWS. Every row about the deleted member (target_user_id, or a
-- member target_id on a row written before 202609060022 backfilled it) whose
-- action carries a moderator's free text about them:
--   member_restrict    - note and after_data.reason, from mod_restrict_member
--   member_unrestrict  - note and after_data.lift_reason, from mod_lift_restriction
--   report_review      - note, from mod_review() and review_report(). A
--                        restrict_temp / restrict_permanent decision passes the
--                        SAME text to mod_restrict_member as its reason, so
--                        redacting only the member_restrict copy would leave
--                        its twin one row over.
-- Rows the deleted member wrote about someone ELSE are left alone: that text
-- is about the other member, whose account still exists.
create or replace function public.admin_actions_redact_on_user_delete()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_marker constant text := '[הנימוק נמחק יחד עם החשבון]';
begin
  update public.admin_actions a
     set note = case when nullif(btrim(a.note), '') is null then a.note else c_marker end,
         after_data = case
           when a.after_data is null or jsonb_typeof(a.after_data) <> 'object' then a.after_data
           else (
             select jsonb_object_agg(
                      e.key,
                      case
                        when e.key in ('reason', 'lift_reason', 'note')
                             and coalesce(e.value #>> '{}', '') <> ''
                          then to_jsonb(c_marker)
                        else e.value
                      end)
               from jsonb_each(a.after_data) e
           )
         end
   where a.action_type in ('member_restrict', 'member_unrestrict', 'report_review')
     and (a.target_user_id = old.id
          or (a.target_type = 'member' and a.target_id = old.id));
  return old;
end $$;
revoke all on function public.admin_actions_redact_on_user_delete() from public, anon, authenticated;

drop trigger if exists admin_actions_redact_before_user_delete on auth.users;
create trigger admin_actions_redact_before_user_delete
  before delete on auth.users
  for each row
  execute function public.admin_actions_redact_on_user_delete();

comment on function public.admin_actions_redact_on_user_delete() is
  'BEFORE DELETE trigger on auth.users (202609230001). On every admin_actions row about the deleted member (target_user_id, or target_type member + target_id) whose action_type is member_restrict, member_unrestrict or report_review, replaces the free-text note and any non-empty after_data reason / lift_reason / note with ''[הנימוק נמחק יחד עם החשבון]''. Everything else on the row - who acted, what, when, restriction type, expiry - is kept, so the log still reads as the sequence of decisions it was. Same pattern as bug_reports_anonymize_on_user_delete().';

commit;
