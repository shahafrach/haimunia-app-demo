// F19 (fix plan, 2026-11-10): the lost-code reset. A member with no recovery
// code resets with the username alone after a 12-hour wait that any signed-in
// session can cancel. These drive the shared logic the request-reset Edge
// Function wires (supabase/functions/_shared/recovery.mjs).
import { test } from "node:test";
import assert from "node:assert";
import {
  handleResetRequest, handleRecover, generateCode, recoveryHmac, GENERIC_FAILURE,
  RESET_WAIT_MS, RESET_VALID_MS, RESET_REQUESTS_PER_DAY, ATTEMPT_LIMIT,
} from "../supabase/functions/_shared/recovery.mjs";

const SECRET = "test-secret-not-a-real-one";
const PW = "Newpassw0rd!";

function makeWorld() {
  const w = {
    users: new Map([["dana", "u-dana"]]),
    passwords: new Map([["u-dana", "Oldpassw0rd"]]),
    sessions: new Map([["u-dana", 2]]),
    recovery: new Map(), reset: new Map(), requests: new Map(),
    attempts: [], pushes: [],
    now: Date.UTC(2026, 10, 10, 9, 0, 0),
  };
  w.store = {
    lookupUser: async (n) => w.users.get(n) || null,
    getRecoveryHmac: async (id) => w.recovery.get(id) || null,
    consumeReset: async () => false,
    setPassword: async (id, pw) => { w.passwords.set(id, pw); return true; },
    revokeSessions: async (id) => { w.sessions.set(id, 0); },
    putRecoveryCode: async (id, h) => { w.recovery.set(id, h); },
    clearReset: async (id) => { w.reset.delete(id); },
    countAttempts: async (k, since) => w.attempts.filter((a) => a.k === k && a.t >= since).length,
    addAttempts: async (ks) => { for (const k of ks) w.attempts.push({ k, t: w.now }); },
    purgeAttempts: async (before) => { w.attempts = w.attempts.filter((a) => a.t >= before); },
    getResetRequest: async (id) => w.requests.get(id) || null,
    putResetRequest: async (id, r) => { w.requests.set(id, { ...r, cancelled_at: null, blocked_until: null }); },
    deleteResetRequest: async (id) => { w.requests.delete(id); },
    notifyResetRequested: async (id, readyAt) => { w.pushes.push({ id, readyAt }); },
  };
  // What cancel_my_reset() does in the database.
  w.cancel = (id) => { const r = w.requests.get(id); r.cancelled_at = w.now; r.blocked_until = w.now + 24 * 3600e3; };
  w.call = (body, ip = "203.0.113.7") => handleResetRequest({ body, ip }, { secret: SECRET, store: w.store, now: () => w.now });
  return w;
}
const ask = (w, username = "dana", ip) => w.call({ action: "request", username }, ip);
const finish = (w, token, extra = {}, ip) => w.call({ action: "complete", username: "dana", request_token: token, new_password: PW, ...extra }, ip);

test("a request answers the same for a known and an unknown username, and stores only an HMAC", async () => {
  const w = makeWorld();
  const known = await ask(w, "dana");
  const unknown = await ask(w, "nobody_here", "203.0.113.8");
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
  assert.match(known.body.request_token, /^[0-9a-f]{64}$/);
  assert.equal(known.body.ready_at, new Date(w.now + RESET_WAIT_MS).toISOString());
  assert.equal(unknown.body.ready_at, known.body.ready_at);
  const row = w.requests.get("u-dana");
  assert.ok(row && row.token_hmac !== known.body.request_token, "the token itself is never stored");
  assert.equal(w.requests.size, 1, "nothing is stored for an unknown username");
  assert.deepEqual(w.pushes.map((p) => p.id), ["u-dana"], "the account's devices are told");
});

test("the reset completes only after 12 hours, once, with the right token", async () => {
  const w = makeWorld();
  const { request_token } = (await ask(w)).body;
  w.now += RESET_WAIT_MS - 60e3;
  assert.deepEqual([(await finish(w, request_token)).status, (await finish(w, request_token)).body], [400, GENERIC_FAILURE], "a minute early is refused");
  w.now += 2 * 60e3;
  assert.equal((await finish(w, "f".repeat(64))).status, 400, "a wrong token is refused");
  const ok = await finish(w, request_token);
  assert.equal(ok.status, 200);
  assert.match(ok.body.recovery_code, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
  assert.equal(w.passwords.get("u-dana"), PW);
  assert.equal(w.sessions.get("u-dana"), 0, "every session is ended");
  assert.equal(w.recovery.get("u-dana"), await recoveryHmac(SECRET, ok.body.recovery_code), "the new code is the one stored");
  assert.equal((await finish(w, request_token)).status, 400, "the token is spent");
});

test("a cancel stops the reset and blocks new requests for 24 hours, silently", async () => {
  const w = makeWorld();
  const { request_token } = (await ask(w)).body;
  w.cancel("u-dana");
  w.now += RESET_WAIT_MS + 1000;
  assert.equal((await finish(w, request_token)).status, 400, "a cancelled request never completes");
  const again = await ask(w, "dana", "198.51.100.1");
  assert.equal(again.status, 200, "the caller cannot tell the account is blocked");
  w.now += RESET_WAIT_MS + 1000;
  assert.equal((await finish(w, again.body.request_token, {}, "198.51.100.1")).status, 400, "a request inside the block was not stored");
  assert.equal(w.passwords.get("u-dana"), "Oldpassw0rd");
});

test("a request expires 24 hours after its wait ends", async () => {
  const w = makeWorld();
  const { request_token } = (await ask(w)).body;
  w.now += RESET_WAIT_MS + RESET_VALID_MS + 1000;
  assert.equal((await finish(w, request_token)).status, 400);
});

test("a new request replaces the open one and restarts the wait", async () => {
  const w = makeWorld();
  const first = (await ask(w)).body.request_token;
  w.now += RESET_WAIT_MS - 3600e3;
  const second = (await ask(w, "dana", "198.51.100.2")).body.request_token;
  w.now += 3600e3 + 1000;
  assert.equal((await finish(w, first)).status, 400, "the replaced token is dead");
  assert.equal((await finish(w, second, {}, "198.51.100.2")).status, 400, "and the new one waits its own 12 hours");
  w.now += RESET_WAIT_MS;
  assert.equal((await finish(w, second, {}, "198.51.100.3")).status, 200);
});

test("3 requests per username per day, from any address", async () => {
  const w = makeWorld();
  for (let i = 0; i < RESET_REQUESTS_PER_DAY; i++) assert.equal((await ask(w, "dana", "198.51.100." + i)).status, 200);
  assert.deepEqual([(await ask(w, "dana", "198.51.100.99")).status, (await ask(w, "dana", "198.51.100.98")).body], [400, GENERIC_FAILURE]);
  w.now += 24 * 3600e3 + 1000;
  assert.equal((await ask(w, "dana", "198.51.100.97")).status, 200, "the next day it works again");
});

test("completion attempts are limited per address, and malformed ones do not spend the username's", async () => {
  const w = makeWorld();
  const { request_token } = (await ask(w)).body;
  w.now += RESET_WAIT_MS + 1000;
  for (let i = 0; i < ATTEMPT_LIMIT * 2; i++) await finish(w, "nope", {}, "198.51.100." + i);
  const ok = await finish(w, request_token, {}, "203.0.113.200");
  assert.equal(ok.status, 200, "junk from many addresses did not lock the member out");
});

test("a bad request shape or a weak password is the generic failure", async () => {
  const w = makeWorld();
  assert.deepEqual([(await w.call({})).status, (await w.call({})).body], [400, GENERIC_FAILURE]);
  assert.equal((await ask(w, "דנה")).status, 400);
  const { request_token } = (await ask(w)).body;
  w.now += RESET_WAIT_MS + 1000;
  assert.equal((await finish(w, request_token, { new_password: "short" })).status, 400);
  assert.equal(w.passwords.get("u-dana"), "Oldpassw0rd");
});

test("the recovery-code path is untouched: a code still works while a reset waits", async () => {
  const w = makeWorld();
  const code = generateCode();
  w.recovery.set("u-dana", await recoveryHmac(SECRET, code));
  await ask(w);
  const out = await handleRecover({ body: { username: "dana", recovery_code: code, new_password: PW }, ip: "192.0.2.9" }, { secret: SECRET, store: w.store, now: () => w.now });
  assert.equal(out.status, 200);
});

test("the Edge Function wires this handler, runs without a session, and is deployable by name", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../supabase/functions/request-reset/index.ts", import.meta.url), "utf8");
  assert.match(src, /handleResetRequest\(\{ body, ip \}/);
  assert.ok(!/console\.(log|error)\([^)]*(token|password|secret)\b/i.test(src), "no token, password or secret is logged");
  const cfg = fs.readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(cfg, /\[functions\.request-reset\]\s*\nverify_jwt = false/);
  const deploy = fs.readFileSync(new URL("../.github/workflows/deploy-edge-functions.yml", import.meta.url), "utf8");
  assert.match(deploy, /options: \[[^\]]*request-reset[^\]]*\]/);
  assert.ok(fs.existsSync(new URL("../supabase/functions/request-reset/deno.lock", import.meta.url)), "it has its own lockfile");
});
