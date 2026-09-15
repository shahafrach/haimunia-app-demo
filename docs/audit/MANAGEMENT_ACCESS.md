# How management access works

Written 2026-09-15, when management stopped being a property of the person
using the app and became an account of its own.

## What the owner asked for

Three messages, in order:

1. *"on ניהול מערכת there is need to be separate log in for admin, because
   this is the area for that."*
2. *"ניהול המועדון needs to also use password."*
3. *"no, i want it to be seperate from the regular user"* — alongside
   *"because i also train and use the app."*

The first two were satisfied by a step-up: the panel asked the signed-in
member to retype their own password. The third retires that design. Taken with
the fourth line, the requirement is precise and slightly awkward:

- Management must be **its own identity**, with its own credentials. The
  account the owner trains on must not carry admin power.
- Opening a management panel must **not cost them their session**. They log
  workouts on that phone. An admin login that signs them out — or worse, one
  that quietly writes their next workout to the admin account — is a failure.

## Why there are two Supabase clients

One client cannot hold two identities. supabase-js keeps a single session and
every request carries that session's JWT, which is exactly what Postgres RLS
reads to decide what the request may see. "Check these credentials, then keep
browsing as yourself" is not something the database can be asked to do: the
panel's contents are RLS-protected rows, so the request has to *be* the
management account or it gets nothing.

So there are two:

| | session | storage | lifetime |
|---|---|---|---|
| `client` | the member | `localStorage`, survives reloads | until sign-out |
| `mgmtClient` | the management account | **memory only** | until lock, sign-out or reload |

`mgmtClient` is created on unlock (`makeMgmtClient`) with
`persistSession: false`, which keeps it out of storage entirely — it cannot
outlive the tab, cannot be restored by a later visit, and cannot be read off
the device. `autoRefreshToken: false` means no background timer keeps it alive
unattended; the unlock window is 15 minutes and an access token is good for an
hour, so there is nothing to refresh.

A rejected alternative: stash the member's session, sign in as the admin on the
one client, and restore afterwards. It needs no routing work, but while the
panel is open the whole app is the admin — including any background sync — so
a workout flushed at the wrong moment lands on the wrong account. Not worth it.

## Routing: which client answers which question

`mgmtDb()` returns the management client when a management session is live and
the member client otherwise. Thirty-odd management loaders and mutations call
it — the bug inbox, the audit log, the roster, moderation, invites, roles,
password resets, module toggles, analytics, the onboarding editors.

The fallback is deliberate. A management read that runs while nothing is
unlocked behaves exactly as it did before this change, rather than throwing.
Boot-time `loadRestrictions()` is a real instance: it runs for any member
holding a moderation permission, long before a panel is opened. Writes are
reachable only from an unlocked panel, so they always run as management.

## Permission questions have two subjects

`hasPerm()`, `isStaff()` and `isAdmin()` answer about the signed-in member
everywhere in the app, and about the management account inside a management
tab. Without that split, every section of a freshly unlocked panel would
render "no permission" — the member deliberately holds nothing.

The switch is `inMgmtContext()`, which is keyed on the **current tab** rather
than on a flag set around the render call. The same three questions get asked
from three places — the render pass, the after-render pass that decides which
loaders to fire, and the action handlers — and a stack-scoped flag would have
covered the first while silently missing the other two. That combination
renders a panel and then refuses to fill it.

`isCoachTier()` is deliberately **not** context-aware. The coach board sits on
the member's own surfaces and belongs to whoever is holding the phone.

## Why both hamburger rows are visible to everyone

They used to appear only for a member whose own account was staff. That is no
longer possible: the owner's training account holds nothing, so a staff check
hides the rows from the one person they exist for, and there is no other way
in.

Showing them gives nothing away and grants nothing. Each lands on a gate that
wants management credentials, and every RPC behind it is RLS-enforced against
the management account's JWT. A member who taps through sees a login form and
stops. The alternative — a hidden gesture only the owner knows — is a secret
that protects nothing and cannot be handed to a new head coach.

The moderation badge came off those rows: it counted a queue the signed-in
member could see, and a member cannot see that queue.

## The two accounts

| panel | needs | account | signs in as |
|---|---|---|---|
| ניהול מערכת (the app) | admin | `haimuniya@gmail.com` | **the full address** — the username `admin` does not resolve, because this account's mailbox is a real one rather than a synthetic `@members.haimuniya.invalid` |
| ניהול המועדון (the club) | coach rank or above | `headcoach` | `headcoach` |

The gate accepts a **username or an email**. This is not a convenience: the
head coach account has no real mailbox — it signs in as `headcoach`, which the
app maps onto a synthetic `@members.haimuniya.invalid` address it has never
been shown. Demanding that form would lock the account out of its own panel.
The admin account has a real address because it is the one that must be able
to receive a password reset.

Credentials live only in Supabase Auth, as bcrypt hashes. Nothing in this
repository contains either password, and nothing should: GitHub Pages serves
every file in it to anyone who asks.

## What is still the real boundary

None of this is the security boundary. `is_admin()` in the database is, and it
is re-checked on every action regardless of anything on the client. What the
lock adds is that management credentials are needed at all, and that an
unattended phone in a gym is not an open admin panel.

## Outstanding

`שלומי` and `shahaf` — the owner's own training accounts — still carry
`profiles.is_admin = true`. Until that is cleared the separation is
client-side only: those accounts' JWTs still authorise admin RPCs directly.
Clearing it is a one-line production change and is the last step of this work.
