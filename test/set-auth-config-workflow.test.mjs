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
  assert.deepEqual(JSON.parse(body[1]), { external_anonymous_users_enabled: true, mailer_autoconfirm: true, mfa_totp_enroll_enabled: true, mfa_totp_verify_enabled: true,
    password_min_length: 10, password_required_characters: "" }, "Q-38g: the password rule is length only");
});

test("it reads both back and fails unless both are true", () => {
  assert.match(code, /\[ "\$state" = '\{"anonymous_sign_ins":true,"confirm_email_off":true,"totp_enroll":true,"totp_verify":true,"password_rule":true\}' \]/);
});

test("the token is never echoed", () => {
  for (const line of code.split("\n").filter((l) => /\becho\b/.test(l))) {
    assert.doesNotMatch(line, /SUPABASE_ACCESS_TOKEN\b(?!\s+is not set)/, line.trim());
  }
});

test("passkeys for the club app (Q-38c/e): its own host as the relying party, read back exactly", () => {
  const body = code.match(/--data-raw '(\{"passkey_enabled"[^']+\})'/);
  assert.ok(body, "a separate PATCH turns passkeys on");
  assert.deepEqual(JSON.parse(body[1]), { passkey_enabled: true, webauthn_rp_id: "haimunia.pages.dev", webauthn_rp_display_name: "האימוניה", webauthn_rp_origins: "https://haimunia.pages.dev" });
  assert.match(code, /\[ "\$pk" = '\{"passkeys":true,"rp_id":"haimunia\.pages\.dev","rp_origins":"https:\/\/haimunia\.pages\.dev"\}' \]/);
});

test("Q-50: CAPTCHA (Turnstile) and the anonymous limit are read back, never written, and fail the run when missing", () => {
  const at = code.indexOf("- name: verify CAPTCHA (Turnstile) is on");
  assert.ok(at > 0, "the guard step exists");
  assert.ok(at > code.indexOf("- name: set the anonymous sign-in limit"), "it runs after the limit may have been set");
  const step = code.slice(at);
  assert.doesNotMatch(step, /-X PATCH/, "read only: CAPTCHA stays as the owner set it");
  assert.match(step, /security_captcha_enabled===true/);
  assert.match(step, /captcha_provider!=="turnstile"/);
  assert.match(step, /rate_limit_anonymous_users/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.match(step, /process\.exit\(bad\.length\?1:0\)/);
  assert.doesNotMatch(step, /security_captcha_secret/, "the CAPTCHA secret never leaves the API answer");
  assert.doesNotMatch(code.match(/^\s+if: \$\{\{ inputs\.anon_limit != '' \}\}\n\s+env:[\s\S]*?(?=\n\s+- name:)/m)?.[0] || "", /verify CAPTCHA/, "the guard is not behind the anon_limit input");
});
