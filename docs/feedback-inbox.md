# Feedback inbox: how to ask a session to read it

Members send feedback from **אני → פנייה** (see [ops/SUPPORT.md](ops/SUPPORT.md)). It lands in `bug_reports`
(message, app version, time, status). Two columns make it an inbox: `read_at` (null = new) and `tag`
(`bug`, `idea`, `question`, `other`, set by whoever reads it). Reporters never see either.

## What you say to a future session

> Read and summarise the new feedback. Run the **feedback-inbox** workflow with `mark_read` = false, group
> the messages by tag (tag them yourself: bug, idea, question, other), list the top three things to fix and
> any message that needs a personal answer. Don't mark anything read until I say so.

When you are happy with the summary:

> Mark those as read: run **feedback-inbox** again with `mark_read` = true and the same `limit`.

## What the session does

1. Dispatch the workflow (GitHub MCP `actions_run_trigger`, workflow `feedback-inbox.yml`; inputs `mark_read`, `limit`).
2. Read the log of its one job (`get_job_logs`): the reports are the JSON between `FEEDBACK-BEGIN` and `FEEDBACK-END`.
3. Summarise in English unless you ask otherwise: counts per tag, themes, the exact quote for anything urgent.
4. Do **not** include anything beyond what is printed. The script never selects the reporter's id, username or device
   facts, and the session should not try to find out who wrote a message. A request that needs an answer goes to the
   circle's WhatsApp chat (SUPPORT.md).
5. Marking read sets `read_at` on exactly the ids printed in that run, so a report that arrives between the two runs
   stays new.

## Setup

Nothing. The workflow uses the `SUPABASE_ACCESS_TOKEN` secret that `set-auth-config` already needs. After the
migration `202611080003_feedback_inbox.sql` is applied (label `deploy-backend`), the first run works.
Tags and status can also be changed by hand in the Supabase Table Editor (`bug_reports`).
