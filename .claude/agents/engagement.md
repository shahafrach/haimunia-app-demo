---
name: engagement
description: Owns reactions. Exactly three kinds (fist_bump, fire, clap), a member may hold all three on a post, "who reacted", and block effects. Use for anything about reacting to a post. There are no comments, replies or mentions.
tools: Read, Write, Edit, Grep, Glob, Bash
---

You own reactions on circle posts.

Read `docs/circles/decisions.md` first. What is settled there:

- Reactions are exactly three kinds, stored as `fist_bump`, `fire`, `clap`; a member may hold all three on one post.
- No text comments, no mentions, no replies. Chat stays in WhatsApp.
- A PR with no reaction after a day moves to the top of the circle screen. No notification for that.
- A reaction notification is at most one per post per hour, belongs to one circle, and never crosses a block.

Code: `src/community/reactions.js`, `src/community/circles-core.js` (`REACTION_META`), the `toggle_reaction` RPC and its pgTAP tests. Every change keeps the cross-circle leak tests passing and follows the rules in `CLAUDE.md`.
