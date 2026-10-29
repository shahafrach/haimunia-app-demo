// set-auth-config.yml: sets exactly the two Supabase Auth settings BOX-LOG's
// sign-up needs (anonymous sign-ins on, email confirmation off), on the project
// in supabase/PROJECT_REF, and fails unless both read back true.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(new URL("../.github/workflows/set-auth-config.yml", import.meta.url), "utf8");
const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("manual only, read-only token scope, and a timeout", () => {
  assert.match(code, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+schedule:/m);
  assert.match(code, /permissions:\s*\n\s+contents: read/);
  assert.match(code, /timeout-minutes: \d+/);
});

test("the project comes from supabase/PROJECT_REF, never a literal ref", () => {
  assert.match(code, /PROJECT_REF="\$\(tr -d '\[:space:\]' < supabase\/PROJECT_REF\)"/);
  assert.doesNotMatch(code, /hvwakffluwvegedefoth/);
});

test("it PATCHes exactly the two settings and nothing else", () => {
  const body = code.match(/-d '(\{[^']+\})'/);
  assert.ok(body, "a JSON body is sent");
  assert.deepEqual(JSON.parse(body[1]), { external_anonymous_users_enabled: true, mailer_autoconfirm: true });
});

test("it reads both back and fails unless both are true", () => {
  assert.match(code, /\[ "\$state" = '\{"anonymous_sign_ins":true,"confirm_email_off":true\}' \]/);
});

test("the token is never echoed", () => {
  for (const line of code.split("\n").filter((l) => /\becho\b/.test(l))) {
    assert.doesNotMatch(line, /SUPABASE_ACCESS_TOKEN\b(?!\s+is not set)/, line.trim());
  }
});
