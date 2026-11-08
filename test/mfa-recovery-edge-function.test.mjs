// mfa-recovery (supabase/functions/_shared/mfa-recovery.mjs): the recovery code removes a member's
// authenticator factors and is replaced. Every failure is one answer; five tries per 15 minutes.
// The Deno wiring in mfa-recovery/index.ts and the Auth admin calls are not covered here.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { handleMfaRecovery } from "../supabase/functions/_shared/mfa-recovery.mjs";
import { generateCode, recoveryHmac, handleIssue } from "../supabase/functions/_shared/recovery.mjs";

const SECRET = "test-secret-not-a-real-one";

async function world() {
  const code = generateCode();
  const w = { factors: ["f1"], recovery: new Map([["u-dana", await recoveryHmac(SECRET, code)]]), reset: new Set(), attempts: [], now: Date.UTC(2026, 10, 7, 12), code, failRemove: false };
  w.deps = {
    secret: SECRET, now: () => w.now,
    getUser: async (t) => (t === "good" ? { id: "u-dana", is_anonymous: false } : t === "anon" ? { id: "u-anon", is_anonymous: true } : null),
    store: {
      countAttempts: async (k, since) => w.attempts.filter((a) => a.k === k && a.t >= since).length,
      addAttempts: async (ks) => { for (const k of ks) w.attempts.push({ k, t: w.now }); },
      purgeAttempts: async () => {},
      getRecoveryHmac: async (id) => w.recovery.get(id) || null,
      consumeReset: async () => false,
      removeTotpFactors: async () => { if (w.failRemove) return false; w.factors = []; return true; },
      putRecoveryCode: async (id, h) => { w.recovery.set(id, h); },
      clearReset: async () => {},
    },
  };
  return w;
}
const call = (w, over = {}) => handleMfaRecovery({ authorization: "Bearer good", body: { recovery_code: w.code }, ip: "1.2.3.4", ...over }, w.deps);

test("a good code removes the factors, rotates the code and returns the new one once", async () => {
  const w = await world();
  const out = await call(w);
  assert.equal(out.status, 200);
  assert.deepEqual(w.factors, []);
  assert.match(out.body.recovery_code, /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
  assert.notEqual(out.body.recovery_code, w.code);
  assert.equal((await call(w)).status, 400, "the code that was just used is dead");
});

test("no session, an anonymous session, a wrong or malformed code: nothing is removed", async () => {
  const w = await world();
  assert.equal((await call(w, { authorization: "" })).status, 401);
  assert.equal((await call(w, { authorization: "Bearer anon" })).status, 401);
  assert.equal((await call(w, { body: { recovery_code: "AAAA-AAAA-AAAA-AAAA" } })).status, 400);
  assert.equal((await call(w, { body: { recovery_code: "nope" } })).status, 400);
  assert.equal((await call(w, { body: {} })).status, 400);
  assert.deepEqual(w.factors, ["f1"]);
});

test("six wrong tries lock it, even for the right code, until the window passes", async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) assert.equal((await call(w, { body: { recovery_code: "AAAA-AAAA-AAAA-AAAA" } })).status, 400);
  const locked = await call(w);
  assert.equal(locked.status, 400);
  assert.deepEqual(locked.body, { error: "recovery_failed" });
  assert.deepEqual(w.factors, ["f1"]);
  w.now += 16 * 60 * 1000;
  assert.equal((await call(w)).status, 200);
});

test("if the factors cannot be removed the code is not burned", async () => {
  const w = await world();
  w.failRemove = true;
  assert.equal((await call(w)).status, 400);
  w.failRemove = false;
  assert.equal((await call(w)).status, 200);
});

test("issue-recovery-code refuses a password-only session of a member with two-step login", async () => {
  const stored = [];
  const deps = (missing) => ({ secret: SECRET, getUser: async () => ({ id: "u-dana", is_anonymous: false }), secondFactorMissing: async () => missing,
    store: { putRecoveryCode: async (id, h) => { stored.push(h); } } });
  const req = { authorization: "Bearer t" };
  assert.equal((await handleIssue(req, deps(true))).status, 403);
  assert.equal(stored.length, 0);
  assert.equal((await handleIssue(req, deps(false))).status, 200);
});

test("the function keeps the gateway JWT check on and never logs a code", () => {
  const cfg = fs.readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.ok(!/\[functions\.mfa-recovery\]/.test(cfg), "no verify_jwt = false entry for mfa-recovery");
  const src = fs.readFileSync(new URL("../supabase/functions/mfa-recovery/index.ts", import.meta.url), "utf8");
  assert.ok(!/console\.(log|error)\([^)]*(secret|code)\b/i.test(src.replace(/mfa-recovery failed/, "")));
});
