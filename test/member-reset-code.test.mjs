// Q-38 / Q-38b (202611180003): the reset code a club's coach or owner hands over, and the owner's own way back.
// The handler runs against an in-memory store (like test/recovery-edge-functions.test.mjs); the SQL is pinned in
// pgTAP 0162 (CI) and its shape here.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  handleMemberReset, normalizeMemberCode, requestRef, resetTokenHmac, handleResetRequest,
  GENERIC_FAILURE, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS, MEMBER_RESET_GLOBAL_LIMIT,
} from "../supabase/functions/_shared/recovery.mjs";

const SECRET = "test-secret-not-a-real-one";
const PW = "Newpassw0rd!";
const sql = fs.readFileSync(new URL("../supabase/migrations/202611180003_member_reset_code.sql", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../supabase/functions/recover-password/index.ts", import.meta.url), "utf8");

function world() {
  const w = {
    codes: new Map([["ABCD2345", { user_id: "u-dana", username: "dana", used: false }]]),
    passwords: new Map(), sessions: new Map([["u-dana", 2]]), attempts: [], now: Date.UTC(2026, 10, 18, 12),
    consumed: 0,
  };
  w.store = {
    consumeMemberReset: async (code) => {
      w.consumed++;
      const r = w.codes.get(code);
      if (!r || r.used) return null;
      r.used = true;
      return { user_id: r.user_id, username: r.username };
    },
    setPassword: async (id, pw) => { w.passwords.set(id, pw); return true; },
    revokeSessions: async (id) => { w.sessions.set(id, 0); },
    countAttempts: async (k, since) => w.attempts.filter((a) => a.k === k && a.t >= since).length,
    addAttempts: async (ks) => { for (const k of ks) w.attempts.push({ k, t: w.now }); },
    purgeAttempts: async (before) => { w.attempts = w.attempts.filter((a) => a.t >= before); },
  };
  w.call = (body, ip = "203.0.113.7") => handleMemberReset({ body, ip }, { secret: SECRET, store: w.store, now: () => w.now });
  return w;
}

test("a code from the coach and a new password: the password is set, every session ends, the username comes back", async () => {
  const w = world();
  const out = await w.call({ reset_code: "abcd-2345", new_password: PW });
  assert.deepEqual(out, { status: 200, body: { ok: true, username: "dana" } });
  assert.equal(w.passwords.get("u-dana"), PW);
  assert.equal(w.sessions.get("u-dana"), 0);
  assert.deepEqual(await w.call({ reset_code: "ABCD2345", new_password: PW }, "198.51.100.9"), { status: 400, body: GENERIC_FAILURE }, "one use");
});

test("every failure is the same answer; a weak password does not spend the code", async () => {
  const w = world();
  for (const body of [{ reset_code: "ZZZZ2345", new_password: PW }, { reset_code: "ABCD234", new_password: PW }, { reset_code: "ABCD2340", new_password: PW }, {}, null]) {
    assert.deepEqual(await w.call(body, "198.51.100." + Math.floor(Math.random() * 200)), { status: 400, body: GENERIC_FAILURE });
  }
  assert.deepEqual(await w.call({ reset_code: "ABCD2345", new_password: "short" }, "192.0.2.1"), { status: 400, body: GENERIC_FAILURE });
  assert.equal(w.codes.get("ABCD2345").used, false, "the code is still good");
  assert.equal((await w.call({ reset_code: "ABCD2345", new_password: PW }, "192.0.2.1")).status, 200);
});

test("5 attempts per 15 minutes per IP and 60 in all, counted before the code is looked at", async () => {
  const w = world();
  for (let i = 0; i < ATTEMPT_LIMIT; i++) await w.call({ reset_code: "ZZZZ2345", new_password: PW });
  const before = w.consumed;
  assert.equal((await w.call({ reset_code: "ABCD2345", new_password: PW })).status, 400, "the sixth from one IP is refused, even with the right code");
  assert.equal(w.consumed, before, "and the code was not even looked at");
  w.now += ATTEMPT_WINDOW_MS + 1;
  const v = world();
  for (let i = 0; i < MEMBER_RESET_GLOBAL_LIMIT; i++) await v.call({ reset_code: "ZZZZ2345", new_password: PW }, "10.0." + Math.floor(i / 4) + "." + i);
  assert.equal((await v.call({ reset_code: "ABCD2345", new_password: PW }, "192.0.2.200")).status, 400, "the global cap holds across IPs");
});

test("the code normalises like a join code: any case, spaces and dashes", () => {
  assert.equal(normalizeMemberCode(" ab cd–23-45 "), "ABCD2345");
});

test("recover-password routes { reset_code } without a username to the member reset, with member_reset_consume", () => {
  assert.match(index, /import \{ handleRecover, handleMemberReset, CORS_HEADERS \}/);
  assert.match(index, /typeof \(body as Record<string, unknown>\)\.reset_code === "string" &&\s*!\(body as Record<string, unknown>\)\.username/);
  assert.match(index, /supabase\.rpc\("member_reset_consume", \{ p_code: code \}\)/);
});

test("request-reset answers with a short reference: the start of the token's HMAC, never the token", async () => {
  const store = {
    lookupUser: async (u) => (u === "dana" ? "u-dana" : null),
    getResetRequest: async () => null, putResetRequest: async (id, r) => { store.saved = r; },
    notifyResetRequested: async () => {}, countAttempts: async () => 0, addAttempts: async () => {}, purgeAttempts: async () => {},
  };
  const out = await handleResetRequest({ body: { action: "request", username: "dana" }, ip: "203.0.113.7" }, { secret: SECRET, store, now: () => Date.UTC(2026, 10, 18) });
  assert.equal(out.status, 200);
  assert.match(out.body.request_ref, /^[0-9A-F]{6}$/);
  assert.equal(out.body.request_ref, store.saved.token_hmac.slice(0, 6).toUpperCase(), "what owner_approve_reset_request compares");
  assert.equal(out.body.request_ref, requestRef(await resetTokenHmac(SECRET, out.body.request_token)));
  const unknown = await handleResetRequest({ body: { action: "request", username: "nobody_here" }, ip: "203.0.113.8" }, { secret: SECRET, store, now: () => Date.UTC(2026, 10, 18) });
  assert.match(unknown.body.request_ref, /^[0-9A-F]{6}$/, "an unknown username gets one too: the answer does not say who exists");
});

test("the migration: hash only, service_role only, staff-checked issue, the owner never reset from the app, no role for the owner tool", () => {
  assert.match(sql, /create table public\.member_reset_codes \(\n  user_id    uuid primary key/);
  assert.match(sql, /revoke all on public\.member_reset_codes from public, anon, authenticated;\ngrant select, insert, update, delete on public\.member_reset_codes to service_role;/);
  assert.match(sql, /'haimunia:member-reset:v1:' \|\| public\.join_code_normalize\(p_code\)/);
  const issue = sql.match(/create or replace function public\.club_issue_reset_code[\s\S]*?\nend \$\$;/)[0];
  assert.match(issue, /\nbegin\n\s*-- F-028[^\n]*\n\s*if not public\.aal_satisfied\(\) then raise exception 'not authorized' using errcode = 'P0001'; end if;/, "aal check first");
  assert.match(issue, /public\.is_club_staff\(p_club_id\)/);
  assert.match(issue, /p_user_id = v_uid then raise exception 'not authorized'/, "never the caller");
  assert.match(issue, /if v_role = 'owner' then raise exception 'not authorized'/, "never the owner");
  assert.match(issue, /check_rate_limit\('club_issue_reset_code', 10, 1440\)/);
  assert.match(issue, /now\(\) \+ interval '24 hours'/);
  assert.match(issue, /club_staff_log\(p_club_id, 'member_password_reset', p_user_id\)/);
  assert.match(sql, /revoke all on function public\.member_reset_consume\(text\) from public, anon, authenticated;\ngrant execute on function public\.member_reset_consume\(text\) to service_role;/);
  assert.match(sql, /revoke all on function public\.owner_approve_reset_request\(text, text\) from public, anon, authenticated, service_role;/);
  assert.match(sql, /if auth\.uid\(\) is not null then raise exception 'not authorized'; end if;/);
  assert.doesNotMatch(sql, /\bgrant [^;]* to [^;]*\b(anon|public)\b/i);
});
