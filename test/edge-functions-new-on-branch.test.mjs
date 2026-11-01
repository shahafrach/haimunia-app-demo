import { test } from "node:test";
import assert from "node:assert";
import { functionsNewOnBranch } from "../scripts/edge-functions-new-on-branch.mjs";

const MAIN = ["supabase/functions/notif_push_send/index.ts", "supabase/functions/notif_push_send/deno.lock", "supabase/functions/purge_abandoned_profiles/index.ts", "supabase/functions/_shared/webPush.mjs"].join("\n");
const names = ["issue-recovery-code", "notif_push_send", "purge_abandoned_profiles", "recover-password"];

test("on a branch, only functions absent from main are excused", () => {
  const got = functionsNewOnBranch(names, { branch: "feature", run: () => MAIN });
  assert.deepEqual([...got].sort(), ["issue-recovery-code", "recover-password"]);
});
test("a function that is on main is never excused (it must be deployed)", () => {
  const got = functionsNewOnBranch(names, { branch: "feature", run: () => MAIN });
  assert.ok(!got.has("notif_push_send") && !got.has("purge_abandoned_profiles"));
});
test("on main itself nothing is excused", () => {
  assert.equal(functionsNewOnBranch(names, { branch: "main", run: () => MAIN }).size, 0);
});
test("if main cannot be read, or lists no functions, nothing is excused", () => {
  assert.equal(functionsNewOnBranch(names, { branch: "x", run: () => { throw new Error("no ref"); } }).size, 0);
  assert.equal(functionsNewOnBranch(names, { branch: "x", run: () => "" }).size, 0);
});
test("the check script uses it and still fails a 404 for a function not excused", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/check-edge-functions-deployed.mjs", import.meta.url), "utf8");
  assert.match(src, /res\.status === 404 && newHere\.has\(name\)/);
  assert.match(src, /404 NOT DEPLOYED[\s\S]{0,40}missing\+\+/);
});
