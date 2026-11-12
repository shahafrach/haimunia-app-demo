# Club ownership

The Haimunia club has one owner and at most one coach (docs/circles/decisions.md, "Haimunia club").

- When the owner leaves the club or deletes the account, the **coach becomes the owner** and the coach seat is empty.
- With **no coach**, the club has **no owner**. Members keep using it. Nobody can remove members, rotate the link or post announcements until an owner is set.
- A club is never deleted automatically and never handed to a random member.

## Set an owner

The member must already be in the club. Either way works:

**Workflow (no SQL):** Actions, `club-admin`, Run workflow, `action = set_owner`, `who = <username>`. The log shows one word: `set`, `already`, `not_member`, `no_such_user` or `no_club`.

**SQL editor:**

```sql
select public.owner_set_club_owner('<username>');
```

The previous owner, if there is one, becomes a member. A coach who becomes the owner leaves the coach seat empty.

## The other owner actions

| Action | Workflow | SQL editor |
|---|---|---|
| Create the club (once) | `action = create_club`, `who = <owner username>` | `select public.owner_create_club('<username>', 'האימוניה');` |
| Name the coach | `action = set_coach`, `who = <username>` | `select public.owner_set_coach('<username>');` |
| Usage totals | `action = usage_report` | `select public.training_log_usage_report(12);` |

These functions are granted to no role. Only the SQL editor and the Management API (which `club-admin.yml` uses with `SUPABASE_ACCESS_TOKEN`) can run them. The repository is public, so the workflow masks the username and sends only its sha256.
