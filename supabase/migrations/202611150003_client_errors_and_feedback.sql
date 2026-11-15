-- 3.12.0 (club app): anonymous client error reports and the feedback box ("מה לא עובד טוב?").
--
-- Two insert-only tables for the Haimunia club apps, written by the browser through two SECURITY DEFINER
-- functions granted to anon and authenticated. Neither table has a user, username, name, device or IP column.
-- RLS is on with no policies, and every client grant is revoked: only service_role reads them (the owner, in
-- the SQL editor; docs/ops/FEEDBACK.md).
--
-- The existing bug_reports / bug_report_submit() does not fit and is unchanged: it needs a signed-in,
-- non-anonymous member, stores reporter_id, staff can read it, and nothing purges it.
--
-- Limits follow the transfer-put pattern (202611120001, 202611140002): a per-IP and, for feedback, a
-- per-device counter in public.transfer_attempts through transfer_rate_ok(), keyed by an HMAC under its own
-- domain prefix, never the raw value. The IP is cf-connecting-ip, else the last x-forwarded-for entry (never
-- the first, which a client can set). The hourly transfer_purge() already deletes counter rows older than
-- 2 days. The HMAC key is a random 32 bytes made here and kept in public.client_report_key, which has no
-- grant at all; only these definer functions read it. Refusals never raise (a raise would roll back the
-- counter): a call over a limit returns quietly and stores nothing. Bad fields raise 22023.
--
--   client_error_reports: 2,000 a day in total, 30 an hour per IP. Purged after 30 days.
--   app_feedback:         500 a day in total, 20 a day per IP, 5 a day per device. Purged after 12 months.

-- =====================================================================================================
-- The counters: three more actions in transfer_attempts (the transfer_rate_ok pattern)
-- =====================================================================================================
alter table public.transfer_attempts drop constraint transfer_attempts_action_check;
alter table public.transfer_attempts add constraint transfer_attempts_action_check
  check (action in ('put', 'take', 'put_device', 'client_error_ip', 'feedback_ip', 'feedback_device'));
comment on column public.transfer_attempts.ip_hash is
  'HMAC of the caller''s IP (actions put, take, client_error_ip, feedback_ip) or of an app''s random device id (put_device, feedback_device), each under its own domain prefix; never the raw value. Rows older than 2 days are deleted by transfer_purge(). 202611120001, 202611140002, 202611150003.';

-- =====================================================================================================
-- The HMAC key
-- =====================================================================================================
create table public.client_report_key (
  id boolean primary key default true check (id),
  key bytea not null
);
alter table public.client_report_key enable row level security;
revoke all on public.client_report_key from public, anon, authenticated, service_role;
insert into public.client_report_key (key) values (extensions.gen_random_bytes(32));

-- The app from the Origin header, as training_log_usage does; the client never chooses it.
create or replace function public.client_report_app()
returns text language plpgsql stable set search_path = '' as $$
declare v_headers json;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  return case v_headers ->> 'origin'
    when 'https://haimunia.pages.dev' then 'club'
    when 'https://haimuniya.github.io' then 'old'
    else 'unknown'
  end;
end $$;
revoke all on function public.client_report_app() from public, anon, authenticated, service_role;

-- HMAC(key, domain || value) as hex: the counters never hold the raw value.
create or replace function public.client_report_hash(p_domain text, p_value text)
returns text language plpgsql stable set search_path = '' as $$
declare v_key bytea;
begin
  select k.key into v_key from public.client_report_key k where k.id;
  return encode(extensions.hmac(convert_to(p_domain || coalesce(p_value, 'unknown'), 'UTF8'), v_key, 'sha256'), 'hex');
end $$;
revoke all on function public.client_report_hash(text, text) from public, anon, authenticated, service_role;

-- HMAC(key, domain || value) as hex. For the IP, in order of trust:
--   1. cf-connecting-ip: set by Cloudflare at the edge from the TCP peer; a client-sent value is overwritten.
--   2. the LAST x-forwarded-for entry: proxies append the peer they saw, so the last entry is the one a
--      client cannot choose (the first entry is whatever the client sent, and was the review finding on #178).
--   3. x-real-ip, else 'unknown' (one shared bucket for callers without any of these).
create or replace function public.client_report_ip_hash(p_domain text)
returns text language plpgsql stable set search_path = '' as $$
declare
  v_headers json;
  v_ip text;
  v_xff text[];
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(btrim(coalesce(v_headers ->> 'cf-connecting-ip', '')), '');
  if v_ip is null then
    v_xff := string_to_array(coalesce(v_headers ->> 'x-forwarded-for', ''), ',');
    if coalesce(array_length(v_xff, 1), 0) > 0 then v_ip := nullif(btrim(v_xff[array_length(v_xff, 1)]), ''); end if;
  end if;
  if v_ip is null then v_ip := nullif(btrim(coalesce(v_headers ->> 'x-real-ip', '')), ''); end if;
  return public.client_report_hash(p_domain, coalesce(v_ip, 'unknown'));
end $$;
revoke all on function public.client_report_ip_hash(text) from public, anon, authenticated, service_role;

-- The screens both apps name; anything else is refused.
create or replace function public.client_report_screen_ok(p_screen text)
returns boolean language sql immutable set search_path = '' as $$
  select p_screen in ('add', 'history', 'calendar', 'wod', 'club', 'settings', 'other')
$$;
revoke all on function public.client_report_screen_ok(text) from public, anon, authenticated, service_role;

-- =====================================================================================================
-- 1. Client error reports
-- =====================================================================================================
create table public.client_error_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  app text not null check (app in ('club', 'old', 'unknown')),
  app_version text not null check (app_version ~ '^[0-9A-Za-z._-]{1,20}$'),
  screen text not null check (public.client_report_screen_ok(screen)),
  kind text not null check (kind in ('error', 'unhandledrejection', 'storage')),
  name text check (name is null or name ~ '^[A-Za-z]{1,40}$'),
  message text not null check (char_length(message) <= 200),
  file text not null check (file = 'other' or file ~ '^[A-Za-z0-9_-]{1,60}\.js$'),
  line integer check (line is null or line between 0 and 10000000),
  col integer check (col is null or col between 0 and 10000000),
  fp text not null check (fp ~ '^[0-9a-f]{8}$')
);
create index client_error_reports_created_idx on public.client_error_reports (created_at);
alter table public.client_error_reports enable row level security;
revoke all on public.client_error_reports from public, anon, authenticated;
comment on table public.client_error_reports is
  'Anonymous client error reports from the Haimunia club apps (3.12.0): kind, a sanitized short message, the screen, the version, the file/line and an 8-hex fingerprint. No user, device or IP column. Insert only through client_error_report(); RLS on, no policies, only service_role reads. 2,000 a day, 30 an hour per IP (HMAC). Purged after 30 days. 202611150003.';

create or replace function public.client_error_report(
  p_app_version text, p_screen text, p_kind text, p_name text, p_message text,
  p_file text, p_line integer, p_col integer, p_fp text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_msg text := regexp_replace(coalesce(p_message, ''), '[[:cntrl:]]', ' ', 'g');
begin
  if coalesce(p_app_version, '') !~ '^[0-9A-Za-z._-]{1,20}$'
     or not public.client_report_screen_ok(p_screen)
     or p_kind is null or p_kind not in ('error', 'unhandledrejection', 'storage')
     or (p_name is not null and p_name !~ '^[A-Za-z]{1,40}$')
     or char_length(v_msg) > 200
     or coalesce(p_file, '') !~ '^(other|[A-Za-z0-9_-]{1,60}\.js)$'
     or (p_line is not null and (p_line < 0 or p_line > 10000000))
     or (p_col is not null and (p_col < 0 or p_col > 10000000))
     or coalesce(p_fp, '') !~ '^[0-9a-f]{8}$' then
    raise exception 'invalid report' using errcode = '22023';
  end if;
  if (select count(*) from public.client_error_reports r where r.created_at > now() - interval '1 day') >= 2000 then
    return;
  end if;
  if not public.transfer_rate_ok(public.client_report_ip_hash('club-error:ip:v1:'), 'client_error_ip', 30, 60) then
    return;
  end if;
  insert into public.client_error_reports (app, app_version, screen, kind, name, message, file, line, col, fp)
  values (public.client_report_app(), p_app_version, p_screen, p_kind, p_name, v_msg, p_file, p_line, p_col, p_fp);
end $$;
revoke all on function public.client_error_report(text, text, text, text, text, text, integer, integer, text) from public;
grant execute on function public.client_error_report(text, text, text, text, text, text, integer, integer, text) to anon, authenticated;

create or replace function public.client_error_reports_purge()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.client_error_reports where created_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function public.client_error_reports_purge() from public, anon, authenticated;
select cron.schedule('client-error-reports-purge', '29 4 * * *', $$select public.client_error_reports_purge()$$);

-- =====================================================================================================
-- 2. Feedback ("מה לא עובד טוב?")
-- =====================================================================================================
create table public.app_feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  app text not null check (app in ('club', 'old', 'unknown')),
  app_version text not null check (app_version ~ '^[0-9A-Za-z._-]{1,20}$'),
  screen text not null check (public.client_report_screen_ok(screen)),
  device_type text not null check (device_type in ('ios', 'android', 'desktop', 'other')),
  standalone boolean not null default false,
  body text not null check (char_length(body) between 1 and 1000)
);
create index app_feedback_created_idx on public.app_feedback (created_at);
alter table public.app_feedback enable row level security;
revoke all on public.app_feedback from public, anon, authenticated;
comment on table public.app_feedback is
  'The feedback box of the Haimunia club apps (3.12.0): the typed text, the screen, the version, the device type and whether the app is installed. No user, username, name, device or IP column. Insert only through feedback_submit(); RLS on, no policies, only service_role reads (docs/ops/FEEDBACK.md). 500 a day, 20 a day per IP, 5 a day per device (HMACs). Purged after 12 months. 202611150003.';

create or replace function public.feedback_submit(
  p_app_version text, p_screen text, p_device_type text, p_standalone boolean, p_body text, p_device text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), '[\x01-\x09\x0B-\x1F\x7F]', ' ', 'g'));
begin
  if coalesce(p_app_version, '') !~ '^[0-9A-Za-z._-]{1,20}$'
     or not public.client_report_screen_ok(p_screen)
     or p_device_type is null or p_device_type not in ('ios', 'android', 'desktop', 'other')
     or char_length(v_body) not between 1 and 1000
     or coalesce(p_device, '') !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'invalid feedback' using errcode = '22023';
  end if;
  if (select count(*) from public.app_feedback f where f.created_at > now() - interval '1 day') >= 500 then
    return;
  end if;
  if not public.transfer_rate_ok(public.client_report_ip_hash('club-feedback:ip:v1:'), 'feedback_ip', 20, 1440) then
    return;
  end if;
  if not public.transfer_rate_ok(public.client_report_hash('club-feedback:device:v1:', p_device), 'feedback_device', 5, 1440) then
    return;
  end if;
  insert into public.app_feedback (app, app_version, screen, device_type, standalone, body)
  values (public.client_report_app(), p_app_version, p_screen, p_device_type, coalesce(p_standalone, false), v_body);
end $$;
revoke all on function public.feedback_submit(text, text, text, boolean, text, text) from public;
grant execute on function public.feedback_submit(text, text, text, boolean, text, text) to anon, authenticated;

create or replace function public.app_feedback_purge()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.app_feedback where created_at < now() - interval '12 months';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;
revoke all on function public.app_feedback_purge() from public, anon, authenticated;
select cron.schedule('app-feedback-purge', '41 4 * * *', $$select public.app_feedback_purge()$$);

-- =====================================================================================================
-- 3. The weekly read (owner only)
-- =====================================================================================================
-- Granted to no role and refuses any call with an auth.uid(), like the owner_* functions: the SQL editor only.
-- One row per screen since p_since: how many, and the 20 newest (created_at, app_version, device_type, body).
create or replace function public.feedback_by_screen(p_since date)
returns table (screen text, n bigint, newest jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is not null then raise exception 'not authorized'; end if;
  return query
    select f.screen, count(*)::bigint,
           (select jsonb_agg(jsonb_build_object('created_at', x.created_at, 'app_version', x.app_version,
                                                'device_type', x.device_type, 'body', x.body) order by x.created_at desc)
              from (select g.created_at, g.app_version, g.device_type, g.body
                      from public.app_feedback g
                     where g.screen = f.screen and g.created_at >= p_since
                     order by g.created_at desc limit 20) x)
      from public.app_feedback f
     where f.created_at >= p_since
     group by f.screen
     order by count(*) desc, f.screen;
end $$;
revoke all on function public.feedback_by_screen(date) from public, anon, authenticated;
