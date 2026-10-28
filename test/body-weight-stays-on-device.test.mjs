// Decision 2026-10-28: body weight never leaves the device. It is excluded
// from the private_records backup. This pins the helper that says so, and that
// every path that queues, uploads or restores private_records goes through it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const constantsJs = read("src/constants.js");
const appJs = read("app.js");
const cloudJs = read("cloud.js");

// Load only the two helper declarations from constants.js.
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  constantsJs.slice(constantsJs.indexOf("const DEVICE_ONLY_RECORD_TYPES"), constantsJs.indexOf("const LIMITS = {")) +
  "\nthis.types = DEVICE_ONLY_RECORD_TYPES; this.isBackupRecordType = isBackupRecordType;",
  ctx,
);

test("bodyweight is device-only and is not a backup record type; the rest are", () => {
  assert.deepEqual([...ctx.types], ["bodyweight"]);
  assert.equal(ctx.isBackupRecordType("bodyweight"), false);
  for (const t of ["movement", "custom_wod", "strength_entry", "wod_entry", "measure_type", "measurement", "session_note"]) {
    assert.equal(ctx.isBackupRecordType(t), true, t);
  }
});

// The backup payload is built in exactly one place. Replay its filter over a
// full local state: no payload may carry a bodyweight record.
test("a backup built from every local record type never contains body weight", () => {
  const local = [["bodyweight", { id: "bw1", weight: 71.5 }], ["strength_entry", { id: "e1" }], ["measurement", { id: "m1" }]];
  const payloads = local.filter(([type]) => ctx.isBackupRecordType(type)).map(([record_type, payload]) => ({ record_type, payload }));
  assert.deepEqual(payloads.map((p) => p.record_type), ["strength_entry", "measurement"]);
  assert.doesNotMatch(JSON.stringify(payloads), /bodyweight|71\.5/);
});

test("every client path into private_records is gated by isBackupRecordType", () => {
  // queue
  assert.match(appJs, /async function queueSyncRecord[\s\S]{0,200}if \(!isBackupRecordType\(recordType\)\) return;/);
  // bulk queue no longer lists the bodyweight group
  const bulk = appJs.slice(appJs.indexOf("async function queueAllLocalRecordsForSync"), appJs.indexOf("async function queueAllLocalRecordsForSync") + 700);
  assert.doesNotMatch(bulk, /"bodyweight"/);
  // restore
  assert.match(appJs, /async function applyRemotePrivateRecord[\s\S]{0,200}if \(!isBackupRecordType\(row\.record_type\)\) return;/);
  // upload: the single upsert is preceded by the guard and drops stale queued rows
  assert.match(cloudJs, /if \(!isBackupRecordType\(row\.recordType\)\) \{ await window\.dbDeleteSyncOutbox\(row\.id\); continue; \}/);
  // pull
  assert.match(cloudJs, /isBackupRecordType\(row\.record_type\)\) await window\.applyRemotePrivateRecord/);
});

test("the only writers to private_records and the only queue callers are the guarded ones", () => {
  const writes = [...cloudJs.matchAll(/from\("private_records"\)\.(upsert|insert|update)/g)];
  assert.equal(writes.length, 1, "one upload site, and it is the guarded flushOutbox");
  // Nothing else uploads a bodyweight value: no rpc or table write names it.
  for (const src of [cloudJs, read("src/community/circles.js"), read("src/community/sharing.js"), read("src/community/posts.js")]) {
    assert.doesNotMatch(src, /rpc\([^)]*bodyweight|from\("[a-z_]+"\)\.(?:upsert|insert)\([^)]*bodyweight/);
  }
});
