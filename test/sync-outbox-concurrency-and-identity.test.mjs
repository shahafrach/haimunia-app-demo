// Two CRITICAL defects in the member's own training-log backup.
//
// Live bug hunt, fresh round 2 (2026-09-15), both reproduced live in Chromium
// by an agent driving the real app, and both silent: local IndexedDB stayed
// correct in each case, so nothing the member could see was wrong. Only the
// cloud copy was, and only until someone looked.
//
//   1. flushOutbox() had no mutex. queueSyncRecord() dispatches
//      "haimunia-sync-needed" on EVERY local write and that event calls
//      flushOutbox() fire-and-forget, so two edits to one entry inside a
//      single network round trip started two flushes over the same outbox
//      row. They finished out of order; the STALE upload landed last and
//      overwrote the newer one; then both deleted the same row, leaving
//      nothing queued to correct it. Permanent drift, self-healing only if
//      the member happened to edit that exact record again.
//
//   2. A queued row was uploaded under whoever was signed in when it DRAINED.
//      The row carried no owner and flushOutbox() stamped state.user.id at
//      flush time. Member A logs offline, signs out, member B signs in on the
//      same phone, the queue drains - and A's private training data lands in
//      the cloud tagged with B's user_id. A's backup silently loses it; B's
//      silently gains an entry they never logged.
//
// jsdom cannot execute cloud.js (see community-invite-gate.test.mjs's note),
// so these assert at the source level, the same shape every other
// ordering-sensitive test in this repo uses - plus a behavioural test of the
// queue-time half, which app.js CAN be driven for.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function flushOutboxBody() {
  const at = cloudJs.indexOf("async function flushOutbox()");
  assert.ok(at > -1, "flushOutbox() must exist");
  // Ends at the community-outbox section header that follows it.
  const end = cloudJs.indexOf("// The community write queue", at);
  assert.ok(end > at, "the end of flushOutbox() must be locatable");
  return cloudJs.slice(at, end);
}

test("only one outbox flush runs at a time", () => {
  const body = flushOutboxBody();
  assert.match(cloudJs, /let outboxFlushing = false;/, "there is an in-flight flag");
  assert.match(body, /if \(outboxFlushing\) \{ outboxFlushQueued = true; return; \}/,
    "a second flush defers instead of running concurrently");
  assert.match(body, /outboxFlushing = true;/, "the flag is taken");
  assert.match(body, /finally \{\s*outboxFlushing = false;\s*\}/,
    "and always released, or one failed flush wedges syncing for the session");
});

test("a write queued DURING a flush is not dropped", () => {
  // The lock alone would lose it: queueSyncRecord fires the event, the flush
  // is already running, the call returns, and nothing re-reads the outbox.
  const body = flushOutboxBody();
  assert.match(body, /do \{\s*\n\s*outboxFlushQueued = false;/,
    "the flush loops rather than running once");
  assert.match(body, /\} while \(outboxFlushQueued\);/,
    "and re-runs when something was queued while it was busy");
});

test("an outbox row is uploaded only by the member who created it", () => {
  const body = flushOutboxBody();
  assert.match(body, /if \(row\.userId && row\.userId !== me\) continue;/,
    "a row belonging to someone else must be left queued, not uploaded as this member");
  // The owner must come from the ROW, never re-read at flush time.
  assert.match(body, /const me = state\.user && state\.user\.id;/, "the current member is resolved once");
  assert.match(body, /user_id: me,/, "and used for the upload");
  // The control: the old code read state.user.id directly into the payload
  // with no comparison against the row at all.
  assert.ok(!/const payload = \{ user_id: state\.user\.id, record_type: row\.recordType/.test(cloudJs),
    "the unbound version must be gone");
});

test("the owner is stamped at queue time, which is the only moment it is certainly right", () => {
  const at = appJs.indexOf("async function queueSyncRecord(");
  assert.ok(at > -1, "queueSyncRecord must exist");
  const body = appJs.slice(at, appJs.indexOf("\n}", at));
  assert.match(body, /window\.communityMemberId/,
    "app.js asks cloud.js who the member is");
  assert.match(body, /userId: owner/, "and records it on the row");
  assert.match(cloudJs, /window\.communityMemberId = function \(\) \{ return \(state\.user && state\.user\.id\) \|\| null; \};/,
    "cloud.js exposes it");
});

test("rows queued before this shipped are still flushed, not stranded", () => {
  // A row with no userId predates the fix and has no recorded origin. Skipping
  // it would strand a member's real pending backup forever; adopting it is
  // exactly the old behaviour and the best available answer. The guard is
  // written `row.userId && ...` precisely so a missing value falls through.
  const body = flushOutboxBody();
  assert.match(body, /if \(row\.userId && row\.userId !== me\) continue;/,
    "a missing owner must not be treated as a mismatch");
  assert.ok(!/if \(row\.userId !== me\) continue;/.test(body),
    "an unguarded comparison would strand every legacy row");
});
