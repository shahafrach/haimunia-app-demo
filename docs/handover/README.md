# Handover

Start here.

| file | for |
|---|---|
| `SHARED_CONTEXT.md` | **everyone.** What the app is, the rules, how to verify, and the two defect patterns that keep recurring. |
| `OWNER_ACTIONS.md` | the owner. Four dashboard things, one real decision, one that cannot be fixed on this plan. |
| `SESSION_B_CLIENT_AND_PRODUCT.md` | the next agent session. Client work: BoxLog config, web push, the drift guard. |
| `SESSION_A_SERVER_AND_SAFETY.md` | reference. Closed 2026-09-17, kept because most items turned out to be something other than what they looked like. |
| `PROMPT_A.txt` / `PROMPT_B.txt` | paste-ready session openers. A is closed; B is live. |

Where things stand on 2026-09-17:

- **v4.71.0**, 171 migrations, zero drift — verified against production
  with `supabase migration list --linked` on 2026-09-17, not from this file.
  The 171st sat committed-but-unapplied for a day: the repo and the
  database are separate facts, and only the CLI knows the second one.
- **1890 JS tests**, **3492 pgTAP assertions**, **45 browser scenarios** — all green
- Backups run nightly, encrypted, and are **proven restorable** by a weekly drill
- The repo is private; one public surface, with internal paths blocked
- CI is green end to end after being dead for a day
