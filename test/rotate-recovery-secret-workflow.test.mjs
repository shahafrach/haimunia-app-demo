// .github/workflows/rotate-recovery-secret.yml makes the HMAC key behind the
// recovery codes on the runner. Like rotate-vapid, nobody may ever see the key,
// so what the file may not contain is pinned next to what it must.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const wf = fs.readFileSync(new URL("../.github/workflows/rotate-recovery-secret.yml", import.meta.url), "utf8");
const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("it is run by hand and by nothing else, with a read-only token", () => {
  assert.match(code, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(code, /permissions:\s*\n\s+contents: read/);
});
test("every action is pinned to a commit SHA", () => {
  const uses = [...code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const ref of uses) assert.match(ref, /^[^@]+@[0-9a-f]{40}$/, ref);
});
test("the only secret it reads is SUPABASE_ACCESS_TOKEN", () => {
  assert.deepStrictEqual([...new Set([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))], ["SUPABASE_ACCESS_TOKEN"]);
});
test("the key is generated on the runner and set with --env-file, never on a command line", () => {
  assert.match(code, /umask 077/);
  assert.match(code, /openssl rand -hex 32\)" > "\$ENV_FILE"/);
  assert.match(code, /supabase secrets set --env-file "\$ENV_FILE" --project-ref "\$PROJECT_REF" >\/dev\/null 2>&1/);
  assert.doesNotMatch(code, /secrets set[^\n]*RECOVERY_CODE_HMAC_SECRET/);
});
test("nothing prints, uploads or caches the key or its file", () => {
  assert.doesNotMatch(code, /\bcat\b[^\n]*(ENV_FILE|recovery\.env)/);
  assert.doesNotMatch(code, /\b(printenv|set -x|xtrace)/);
  assert.doesNotMatch(code, /upload-artifact|actions\/cache|::add-mask|::debug/);
  assert.doesNotMatch(code, /echo[^\n]*\$\{?ENV_FILE/);
  assert.match(code, /if: always\(\)\s*\n\s+run: rm -f "\$RUNNER_TEMP\/recovery\.env"/);
});
test("it refuses to replace an existing key unless asked, and before generating anything", () => {
  const guard = code.indexOf("already exists");
  const gen = code.indexOf("openssl rand");
  assert.ok(guard > -1 && gen > guard);
  assert.match(code, /REPLACE: \$\{\{ inputs\.replace \}\}/);
  assert.ok(code.indexOf('-z "$SUPABASE_ACCESS_TOKEN"') < gen);
});
