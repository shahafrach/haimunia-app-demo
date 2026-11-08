-- Feedback inbox (Home port, feature 3): the reading side of the in-app support form.
--
-- Home's feedback table has kind + status and the owner reads it all. BOX-LOG's form already stores
-- reports in bug_reports with a status and staff RPCs. What was missing is the inbox bookkeeping:
--   * read_at: set when a report has been read and summarised, so "new feedback" means read_at is null;
--   * tag: bug | idea | question | other, put on by whoever reads it (the reporter picks nothing).
-- Both are staff-internal: bug_reports has no client grant at all (reporters read their own through
-- bug_report_list_mine, which selects an explicit column list that does not include these).
-- Read and marked by the feedback-inbox workflow through the Management API (docs/feedback-inbox.md).
-- FORWARD ONLY.
begin;

alter table public.bug_reports
  add column read_at timestamptz,
  add column tag text check (tag is null or tag in ('bug', 'idea', 'question', 'other'));

-- The inbox query: unread, oldest first.
create index bug_reports_unread_idx on public.bug_reports (created_at) where read_at is null;

commit;
