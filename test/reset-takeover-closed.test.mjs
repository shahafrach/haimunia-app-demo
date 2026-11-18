// Q-41 (2026-11-18, security review): the live takeover chain, closed.
//   1. request-reset gave anyone who knew a username a new password and a fresh recovery code after an hour.
//   2. That fresh code then removed two-step login through mfa-recovery, past F-028's aal2.
// Now: request-reset answers 410 (test/reset-request-edge-function.test.mjs); a code handed out by a reset is
// stored under its own domain and mfa-recovery refuses it, and refuses the owner's reset code too; mfa-recovery
// ends the account's other sessions; the per-IP limits read only cf-connecting-ip.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { handleRecover, handleIssue, normalizeCode } from "../supabase/functions/_shared/recovery.mjs";
import { handleMfaRecovery } from "../supabase/functions/_shared/mfa-recovery.mjs";
import { clientIp } from "../supabase/functions/_shared/clientIp.mjs";

const SECRET = "test-secret-not-a-real-one";
const PW = "Newpassw0rd!";

function world() {
  const w = { recovery: new Map(), reset: new Map(), factors: ["totp-1"], attempts: [], revokedAll: 0, revokedOthers: [], now: Date.UTC(2026, 10, 18, 12) };
  w.store = {
    lookupUser: async (u) => (u === "owner_x" ? "u-owner" : null),
    getRecoveryHmac: async (id) => w.recovery.get(id) || null,
    consumeReset: async (id, code) => {
      const r = w.reset.get(id);
      if (!r || r.used || r.code !== normalizeCode(code)) return false;
      r.used = true; return true;
    },
    setPassword: async () => true,
    revokeSessions: async () => { w.revokedAll++; },
    revokeOtherSessions: async (t) => { w.revokedOthers.push(t); },
    putRecoveryCode: async (id, h) => { w.recovery.set(id, h); },
    clearReset: async (id) => { w.reset.delete(id); },
    removeTotpFactors: async () => { w.factors = []; return true; },
    countAttempts: async (k, since) => w.attempts.filter((a) => a.k === k && a.t >= since).length,
    addAttempts: async (ks) => { for (const k of ks) w.attempts.push({ k, t: w.now }); },
    purgeAttempts: async () => {},
  };
  const deps = { secret: SECRET, store: w.store, now: () => w.now, getUser: async (t) => (t === "tok-owner" ? { id: "u-owner", is_anonymous: false } : null) };
  w.issue = () => handleIssue({ authorization: "Bearer tok-owner" }, deps);
  w.recover = (body, ip = "203.0.113.7") => handleRecover({ body, ip }, deps);
  w.mfa = (code, ip = "198.51.100.7") => handleMfaRecovery({ authorization: "Bearer tok-owner", body: { recovery_code: code }, ip }, deps);
  return w;
}

test("the chain is closed: a code that came out of a reset never removes two-step login", async () => {
  const w = world();
  const own = (await w.issue()).body.recovery_code;
  const out = await w.recover({ username: "owner_x", recovery_code: own, new_password: PW });
  assert.equal(out.status, 200, "the member's own code still resets the password");
  const fresh = out.body.recovery_code;
  assert.equal((await w.mfa(fresh)).status, 400, "the code the reset handed out cannot remove the factor");
  assert.deepEqual(w.factors, ["totp-1"], "two-step login is still on");
  // It still works for what a recovery code is for: the next password reset.
  assert.equal((await w.recover({ username: "owner_x", recovery_code: fresh, new_password: PW }, "192.0.2.9")).status, 200);
});

test("the owner's reset code resets a password but never removes two-step login", async () => {
  const w = world();
  w.reset.set("u-owner", { code: "ABCDEFGHJKLMNPQR", used: false });
  assert.equal((await w.mfa("ABCD-EFGH-JKLM-NPQR")).status, 400);
  assert.deepEqual(w.factors, ["totp-1"]);
  assert.equal(w.reset.get("u-owner").used, false, "and it is not even spent there");
});

test("the member's own code (made while signed in) removes the factor, and every other session ends", async () => {
  const w = world();
  const own = (await w.issue()).body.recovery_code;
  const out = await w.mfa(own);
  assert.equal(out.status, 200);
  assert.deepEqual(w.factors, []);
  assert.deepEqual(w.revokedOthers, ["tok-owner"], "the admin API is asked to end the token's other sessions");
});

test("per-IP limits read only cf-connecting-ip; x-forwarded-for is never trusted", () => {
  const h = (o) => new Headers(o);
  assert.equal(clientIp(h({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "1.2.3.4" })), "203.0.113.5");
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4" })), "unknown", "a spoofable header alone is one shared bucket");
  assert.equal(clientIp(h({})), "unknown");
  for (const fn of ["mfa-recovery", "recover-password", "request-reset", "transfer-put", "transfer-take"]) {
    const src = fs.readFileSync(new URL(`../supabase/functions/${fn}/index.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /x-forwarded-for/i, fn);
    assert.match(src, /const ip = clientIp\(req\.headers\);/, fn);
  }
  const any = fs.readdirSync(new URL("../supabase/functions/", import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shared")
    .filter((d) => /x-forwarded-for/i.test(fs.readFileSync(new URL(`../supabase/functions/${d.name}/index.ts`, import.meta.url), "utf8")));
  assert.deepEqual(any.map((d) => d.name), [], "no Edge Function reads x-forwarded-for");
});

test("mfa-recovery's Deno wiring ends the other sessions through the admin API", () => {
  const src = fs.readFileSync(new URL("../supabase/functions/mfa-recovery/index.ts", import.meta.url), "utf8");
  assert.match(src, /supabase\.auth\.admin\.signOut\(accessToken, "others"\)/);
});
