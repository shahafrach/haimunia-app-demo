# Feedback and client error reports (3.12.0)

What the club app sends without a member's name, where it lands, and how the owner reads it. Migration
`202611150003_client_errors_and_feedback.sql`; pgTAP `supabase/tests/0158_client_errors_and_feedback_test.sql`.

## What is stored

| Table | Written by | What | Kept |
|---|---|---|---|
| `app_feedback` | `feedback_submit()` (anon, authenticated) | The text typed in "מה לא עובד טוב?", the screen, the app version, the device type (`ios`, `android`, `desktop`, `other`), whether the app is installed | 12 months |
| `client_error_reports` | `client_error_report()` (anon, authenticated) | The error kind, a sanitized message of at most 200 characters (no member text), the screen, the version, the file, line and column, an 8-hex fingerprint | 30 days |

Neither table has a user, username, name, device or IP column. The app (`club`, `old` or `unknown`) comes
from the request's Origin header, never from the caller. Limits: feedback 5 a day per device, 20 a day per
IP and 500 a day in total; errors 30 an hour per IP and 2,000 a day. The counters are HMACs in
`transfer_attempts` and are deleted after 2 days. The IP is `cf-connecting-ip` (set by Cloudflare), else the
last `x-forwarded-for` entry (the one the gateway appended), never the first, which a client can set.

No client role can read either table (RLS on, no policies, every grant revoked). Read them in the Supabase
SQL editor, which runs as the owner.

## The weekly read

Paste into the SQL editor (Supabase dashboard, project `hvwakffluwvegedefoth`, SQL editor, new query):

```sql
-- Feedback of the last 7 days: per screen, how many, and the 20 newest of each.
select screen, n, jsonb_pretty(newest) as newest
  from public.feedback_by_screen(current_date - 7);
```

The same, one row per message:

```sql
select created_at, app, app_version, screen, device_type, standalone, body
  from public.app_feedback
 where created_at >= current_date - 7
 order by created_at desc;
```

Error reports of the last 7 days, grouped by fingerprint (one line per distinct failure):

```sql
select fp, kind, name, min(message) as message, file, line, app_version, screen,
       count(*) as reports, max(created_at) as last_seen
  from public.client_error_reports
 where created_at >= current_date - 7
 group by fp, kind, name, file, line, app_version, screen
 order by reports desc, last_seen desc
 limit 50;
```

`feedback_by_screen()` is granted to no role and refuses a call that carries a member's session, so it
only runs from the SQL editor.

## Deleting a message early

The privacy policy offers early deletion by mail to haimuniya@gmail.com. The member describes what they
wrote and when; there is no name to search by. Find it and delete it:

```sql
select id, created_at, screen, body from public.app_feedback
 where created_at::date = '2026-11-20' and body ilike '%a few words they quoted%';

delete from public.app_feedback where id = '<the id>';
```

## Purges

Both run daily from `cron` and need nothing from the owner:

- `client-error-reports-purge` at 04:29 UTC: error reports older than 30 days.
- `app-feedback-purge` at 04:41 UTC: feedback older than 12 months.
