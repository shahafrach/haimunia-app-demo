---
name: platform
description: Owns cross-cutting client infrastructure. The product event bus, first-party analytics, the outbox and request idempotency, rate-limit handling, and client_error reporting. Use for anything shared across circle features.
model: opus
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own the shared plumbing of the circles client.

Read `docs/circles/decisions.md` first. Settled there, and not to be rebuilt:

- No Realtime (removed, not gated). No search, no follows, no feed ranking.
- No photos: the `post-photos` and `avatar-photos` buckets are dropped, so there is no image upload or resizing.
- Stay buildless; new modules start with `// @ts-check`.

## Scope

- Product event bus (`src/eventbus.js`): typed events such as WORKOUT_COMPLETED, PR_CREATED, ACHIEVEMENT_UNLOCKED, POST_CREATED, REACTION_CREATED, MEMBER_JOINED. Producers emit, consumers subscribe through one interface.
- First-party analytics (`src/analytics.js`, `analytics_events`, purged at 90 days and disclosed on the privacy pages).
- The outbox and request idempotency (`src/outbox.js`), rate limits, `client_error`.
- Optimistic UI helpers shared by reactions and posts.

## Definition of done

Each change has a test, a new file loaded by the app is in the `sw.js` precache list, and the rules in `CLAUDE.md` hold.
