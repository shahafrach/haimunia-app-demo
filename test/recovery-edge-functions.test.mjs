// The password recovery Edge Functions (issue-recovery-code, recover-password).
// Their logic lives in supabase/functions/_shared/recovery.mjs with every
// dependency injected, so it runs here against an in-memory store that behaves
// like the database + admin API behind index.ts. What is NOT covered here: the
// Deno wiring in the two index.ts files and the SQL helpers (pgTAP 0147).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  CODE_ALPHABET, generateCode, codeFromBytes, normalizeCode, looksLikeCode, recoveryHmac, hmacHex,
  timingSafeEqualStrings, passwordOk, handleIssue, handleRecover, GENERIC_FAILURE, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS,
} from "../supabase/functions/_shared/recovery.mjs";

const SECRET = "test-secret-not-a-real-one";
const GOOD_PW = "Newpassw0rd!";

function makeWorld() {
  const w = {
    users: new Map([["dana", "u-dana"], ["yoav", "u-yoav"]]),
    passwords: new Map([["u-dana", "Oldpassw0rd"], ["u-yoav", "Oldpassw0rd"]]),
    sessions: new Map([["u-dana", 2], ["u-yoav", 1]]),
    recovery: new Map(),
    reset: new Map(),
    attempts: [],
    now: Date.UTC(2026, 9, 30, 12, 0, 0),
    failSetPassword: false,
  };
  w.store = {
    lookupUser: async (name) => w.users.get(name) || null,
    getRecoveryHmac: async (id) => w.recovery.get(id) || null,
    consumeReset: async (id, code) => {
      const r = w.reset.get(id);
      if (!r || r.used || w.now > r.expires || r.code !== normalizeCode(code)) return false;
      r.used = true;
      return true;
    },
    setPassword: async (id, pw) => { if (w.failSetPassword) return false; w.passwords.set(id, pw); return true; },
    revokeSessions: async (id) => { w.sessions.set(id, 0); },
    putRecoveryCode: async (id, h) => { w.recovery.set(id, h); },
    clearReset: async (id) => { w.reset.delete(id); },
    countAttempts: async (k, since) => w.attempts.filter((a) => a.k === k && a.t >= since).length,
    addAttempts: async (ks) => { for (const k of ks) w.attempts.push({ k, t: w.now }); },
    purgeAttempts: async (before) => { w.attempts = w.attempts.filter((a) => a.t >= before); },
  };
  w.deps = () => ({ secret: SECRET, store: w.store, now: () => w.now });
  return w;
}
async function issueFor(w, id) {
  const out = await handleIssue({ authorization: "Bearer tok-" + id }, {
    secret: SECRET, store: w.store,
    getUser: async (t) => (t === "tok-" + id ? { id, is_anonymous: false } : null),
  });
  assert.equal(out.status, 200);
  return out.body.recovery_code;
}
const recover = (w, body, ip = "203.0.113.7") => handleRecover({ body, ip }, w.deps());

test("a code is four groups of four from the 32-symbol alphabet: 80 bits", () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.ok(!/[01OI]/.test(CODE_ALPHABET), "no look-alikes");
  const c = generateCode();
  assert.match(c, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
  assert.notEqual(generateCode(), c);
  assert.equal(codeFromBytes(new Uint8Array(16)), "2222-2222-2222-2222");
  assert.equal(codeFromBytes(new Uint8Array(16).fill(255)), "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  assert.equal(Math.log2(32 ** 16), 80);
});
test("typed codes are forgiven their dashes, spaces and case, nothing else", () => {
  assert.equal(normalizeCode(" abcd-efgh jklm-npqr "), "ABCDEFGHJKLMNPQR");
  assert.ok(looksLikeCode("abcd efgh jklm npqr"));
  assert.ok(!looksLikeCode("ABCD-EFGH-JKLM"));
  assert.ok(!looksLikeCode("ABCD-EFGH-JKLM-NPQ0"), "0 is not in the alphabet");
});
test("the stored tag is an HMAC under a domain prefix, never the code", async () => {
  const h = await recoveryHmac(SECRET, "abcd-efgh-jklm-npqr");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await recoveryHmac(SECRET, "ABCDEFGHJKLMNPQR"), "dashes and case do not change it");
  assert.notEqual(h, await recoveryHmac(SECRET + "x", "ABCDEFGHJKLMNPQR"), "a different key, a different tag");
  assert.notEqual(h, await hmacHex(SECRET, "ABCDEFGHJKLMNPQR"), "the domain prefix is part of the message");
  assert.ok(timingSafeEqualStrings(h, h) && !timingSafeEqualStrings(h, h.slice(0, -1) + "0") && !timingSafeEqualStrings(h, "x"));
});
test("the password rule is the client's", () => {
  assert.ok(passwordOk(GOOD_PW));
  for (const bad of ["short1A", "alllowercase1", "ALLUPPERCASE1", "NoDigitsHereAtAll", ""]) assert.ok(!passwordOk(bad), bad);
});

test("issue: an authenticated member gets a code once and only its HMAC is stored", async () => {
  const w = makeWorld();
  const code = await issueFor(w, "u-dana");
  assert.ok(looksLikeCode(code));
  assert.equal(w.recovery.get("u-dana"), await recoveryHmac(SECRET, code));
  assert.ok(![...w.recovery.values()].some((v) => v.includes(normalizeCode(code))), "the code is not stored");
  const again = await issueFor(w, "u-dana");
  assert.notEqual(again, code, "asking again rotates it");
  assert.equal(w.recovery.get("u-dana"), await recoveryHmac(SECRET, again));
});
test("issue: no session, a bad token and an anonymous session are refused", async () => {
  const w = makeWorld();
  const base = { secret: SECRET, store: w.store, getUser: async (t) => (t === "good" ? { id: "u-dana", is_anonymous: false } : t === "anon" ? { id: "u-x", is_anonymous: true } : null) };
  for (const authorization of ["", "Bearer nope", "Bearer anon", "Basic good"]) {
    const out = await handleIssue({ authorization }, base);
    assert.equal(out.status, 401, authorization);
  }
  assert.equal(w.recovery.size, 0);
  assert.equal((await handleIssue({ authorization: "Bearer good" }, { ...base, secret: "" })).status, 500, "no secret, no code");
});

test("recover: the right code changes the password, ends every session, rotates the code and returns the new one once", async () => {
  const w = makeWorld();
  const code = await issueFor(w, "u-dana");
  const out = await recover(w, { username: "Dana", recovery_code: code.toLowerCase().replace(/-/g, " "), new_password: GOOD_PW });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.ok(looksLikeCode(out.body.recovery_code));
  assert.notEqual(normalizeCode(out.body.recovery_code), normalizeCode(code));
  assert.equal(w.passwords.get("u-dana"), GOOD_PW);
  assert.equal(w.sessions.get("u-dana"), 0, "every session is revoked");
  assert.equal(w.sessions.get("u-yoav"), 1, "and only that member's");
  assert.equal(w.recovery.get("u-dana"), await recoveryHmac(SECRET, out.body.recovery_code), "the new code is the stored one");
  // The old code is dead; the new one works.
  const replay = await recover(w, { username: "dana", recovery_code: code, new_password: "Another1Password" });
  assert.deepEqual([replay.status, replay.body], [400, GENERIC_FAILURE]);
  assert.equal(w.passwords.get("u-dana"), GOOD_PW);
  const second = await recover(w, { username: "dana", recovery_code: out.body.recovery_code, new_password: "Another1Password" });
  assert.equal(second.status, 200);
});

test("recover: every failure is the same status and the same body", async () => {
  const w = makeWorld();
  const code = await issueFor(w, "u-dana");
  const other = generateCode();
  const cases = {
    "wrong code": { username: "dana", recovery_code: other, new_password: GOOD_PW },
    "unknown user": { username: "nobody", recovery_code: code, new_password: GOOD_PW },
    "someone else's code": { username: "yoav", recovery_code: code, new_password: GOOD_PW },
    "member with no code": { username: "yoav", recovery_code: other, new_password: GOOD_PW },
    "weak password": { username: "dana", recovery_code: code, new_password: "weak" },
    "malformed code": { username: "dana", recovery_code: "hello", new_password: GOOD_PW },
    "no username": { recovery_code: code, new_password: GOOD_PW },
    "no body": null,
    "not an object": "dana",
  };
  const seen = new Set();
  let ip = 0;
  for (const [name, body] of Object.entries(cases)) {
    const out = await recover(w, body, "198.51.100." + ip++);
    assert.equal(out.status, 400, name);
    assert.deepEqual(out.body, GENERIC_FAILURE, name);
    seen.add(JSON.stringify([out.status, out.body]));
  }
  assert.equal(seen.size, 1);
  assert.equal(w.passwords.get("u-dana"), "Oldpassw0rd", "nothing changed");
  assert.equal(w.sessions.get("u-dana"), 2);
  w.failSetPassword = true;
  const out = await recover(w, { username: "dana", recovery_code: code, new_password: GOOD_PW }, "198.51.100.99");
  assert.deepEqual([out.status, out.body], [400, GENERIC_FAILURE], "an admin API failure looks the same");
  assert.equal(w.sessions.get("u-dana"), 2, "and revokes nothing");
});

test("recover: 5 attempts per 15 minutes per username, then even the right code is refused, and the window slides", async () => {
  const w = makeWorld();
  const code = await issueFor(w, "u-dana");
  for (let i = 0; i < ATTEMPT_LIMIT; i++) {
    const out = await recover(w, { username: "dana", recovery_code: generateCode(), new_password: GOOD_PW }, "198.51.100." + i);
    assert.equal(out.status, 400);
  }
  const blocked = await recover(w, { username: "dana", recovery_code: code, new_password: GOOD_PW }, "198.51.100.200");
  assert.deepEqual([blocked.status, blocked.body], [400, GENERIC_FAILURE], "the sixth attempt, from a fresh address, is the generic failure");
  assert.equal(w.passwords.get("u-dana"), "Oldpassw0rd");
  assert.equal(w.attempts.length, ATTEMPT_LIMIT * 2, "a blocked attempt is not counted again");
  w.now += ATTEMPT_WINDOW_MS + 1000;
  const later = await recover(w, { username: "dana", recovery_code: code, new_password: GOOD_PW }, "198.51.100.201");
  assert.equal(later.status, 200, "after 15 minutes the right code works");
});
test("recover: malformed requests from many addresses do not lock the member out (audit L8)", async () => {
  const w = makeWorld();
  const code = await issueFor(w, "u-dana");
  const junk = [
    { username: "dana", recovery_code: "", new_password: GOOD_PW },
    { username: "dana", recovery_code: "nope", new_password: GOOD_PW },
    { username: "dana", recovery_code: generateCode(), new_password: "short" },
    { username: "dana", recovery_code: "0000-OOOO-1111-IIII", new_password: GOOD_PW },
  ];
  for (let i = 0; i < ATTEMPT_LIMIT * 3; i++) {
    const out = await recover(w, junk[i % junk.length], "198.51.100." + i);
    assert.deepEqual([out.status, out.body], [400, GENERIC_FAILURE], "junk still gets the generic answer");
  }
  const real = await recover(w, { username: "dana", recovery_code: code, new_password: GOOD_PW }, "203.0.113.50");
  assert.equal(real.status, 200, "the member's own code still works after 15 junk requests");
});
test("recover: 5 attempts per 15 minutes per IP, across usernames", async () => {
  const w = makeWorld();
  const code = await issueFor(w, "u-dana");
  for (let i = 0; i < ATTEMPT_LIMIT; i++) {
    await recover(w, { username: "guess" + i, recovery_code: generateCode(), new_password: GOOD_PW }, "192.0.2.1");
  }
  const blocked = await recover(w, { username: "dana", recovery_code: code, new_password: GOOD_PW }, "192.0.2.1");
  assert.deepEqual([blocked.status, blocked.body], [400, GENERIC_FAILURE]);
  const elsewhere = await recover(w, { username: "dana", recovery_code: code, new_password: GOOD_PW }, "192.0.2.2");
  assert.equal(elsewhere.status, 200, "another address is not affected");
  assert.ok(w.attempts.every((a) => /^[0-9a-f]{64}$/.test(a.k)), "attempts are stored as hashes");
  assert.ok(!JSON.stringify(w.attempts).includes("192.0.2.1") && !JSON.stringify(w.attempts).includes("dana"), "no address or username in the rows");
});

test("recover: an owner-issued reset code works once, then the recovery code is replaced, and an expired one is refused", async () => {
  const w = makeWorld();
  w.reset.set("u-yoav", { code: "ABCDEFGHJKLMNPQR", used: false, expires: w.now + 3600_000 });
  const out = await recover(w, { username: "yoav", recovery_code: "abcd-efgh-jklm-npqr", new_password: GOOD_PW });
  assert.equal(out.status, 200);
  assert.equal(w.passwords.get("u-yoav"), GOOD_PW);
  assert.equal(w.sessions.get("u-yoav"), 0);
  assert.ok(w.recovery.has("u-yoav"), "the member now has a recovery code");
  assert.ok(!w.reset.has("u-yoav"), "the reset code is gone");
  w.reset.set("u-dana", { code: "ABCDEFGHJKLMNPQR", used: false, expires: w.now - 1 });
  const expired = await recover(w, { username: "dana", recovery_code: "ABCDEFGHJKLMNPQR", new_password: GOOD_PW });
  assert.deepEqual([expired.status, expired.body], [400, GENERIC_FAILURE]);
});

test("the Edge Function entry points wire these handlers and nothing else decides", () => {
  const issue = fs.readFileSync(new URL("../supabase/functions/issue-recovery-code/index.ts", import.meta.url), "utf8");
  const rec = fs.readFileSync(new URL("../supabase/functions/recover-password/index.ts", import.meta.url), "utf8");
  assert.match(issue, /handleIssue/);
  assert.match(rec, /handleRecover/);
  for (const src of [issue, rec]) {
    assert.match(src, /Deno\.env\.get\("RECOVERY_CODE_HMAC_SECRET"\)/);
    assert.ok(!/console\.(log|error)\([^)]*(secret|code)\b/i.test(src.replace(/recovery-code failed|recover-password failed/g, "")), "no log line carries a code or the secret");
  }
  const cfg = fs.readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(cfg, /\[functions\.recover-password\]\s*\nverify_jwt = false/);
  assert.doesNotMatch(cfg, /\[functions\.issue-recovery-code\]/, "issue-recovery-code keeps the gateway's JWT check");
  const deploy = fs.readFileSync(new URL("../.github/workflows/deploy-edge-functions.yml", import.meta.url), "utf8");
  assert.match(deploy, /options: \[[^\]]*issue-recovery-code[^\]]*recover-password[^\]]*\]/, "both are deployable by name");
});
