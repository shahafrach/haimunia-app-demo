#!/usr/bin/env node
// Test 4 - the two Edge Functions without a session (Q-50, Grok backend PRR 2026-11-19).
//
// API level, no browser: these functions are called by a phone that has no account (transfer) or has
// lost its password (recovery), so the request is the whole contract.
//
//   transfer-put -> transfer-take: an encrypted blob goes in from the club app's origin, comes out once,
//   byte for byte, and is gone from the database after the first take. A second take finds nothing,
//   and a take from another origin is refused.
//   recover-password: a member with a recovery code sets a new password with it and gets a new code
//   once. Then the limit: after five attempts in the window the RIGHT code is refused too, with the same
//   answer as a wrong one, and the password does not change. With the attempts cleared the same code works,
//   so the refusal was the limit and not the code.
//
// Against the LOCAL stack only (lib/config.mjs assertLocalOnly), with `supabase functions serve` running.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { API_URL, ANON_KEY, ARTIFACTS_DIR, assertLocalOnly } from "./lib/config.mjs";
import { count, q, sql } from "./lib/db.mjs";

assertLocalOnly();

const NAME = "04-transfer-recovery";
const OUT = path.join(ARTIFACTS_DIR, NAME);
fs.mkdirSync(OUT, { recursive: true });
const results = [];
function check(ok, what, detail = "") {
  results.push({ ok: !!ok, what, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? " - " + detail : ""}`);
}

const CLUB = "https://haimunia.pages.dev";
// One address for this run, so the per-IP buckets are this test's own (clientIp reads only cf-connecting-ip).
const IP = `198.51.100.${1 + (Date.now() % 250)}`;
const fn = (name) => `${API_URL}/functions/v1/${name}`;
async function call(name, body, headers = {}) {
  const res = await fetch(fn(name), {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json", "cf-connecting-ip": IP, ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}
async function auth(pathAndQuery, body, token = ANON_KEY) {
  const res = await fetch(`${API_URL}/auth/v1/${pathAndQuery}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 1. Transfer ---------------------------------------------------------------------------------------
{
  const lookup = randomBytes(32).toString("hex");
  const lookupHash = createHash("sha256").update(lookup).digest("hex");
  const iv = randomBytes(12).toString("base64");
  const ciphertext = randomBytes(4096).toString("base64");

  const put = await call("transfer-put", { lookup, iv, ciphertext }, { Origin: CLUB });
  check(put.status === 200 && put.json?.status === "stored", "transfer-put stores the blob", `${put.status} ${JSON.stringify(put.json)}`);
  check(count(`select count(*) from public.transfer_blobs where lookup_hash = ${q(lookupHash)}`) === 1,
    "the database holds one row, under the sha256 of the lookup");
  check(count(`select count(*) from public.transfer_blobs where lookup_hash = ${q(lookup)}`) === 0, "and never the lookup itself");

  const foreign = await call("transfer-take", { lookup }, { Origin: "https://example.com" });
  check(foreign.status === 403, "a take from another origin is refused", String(foreign.status));

  const take = await call("transfer-take", { lookup }, { Origin: CLUB });
  check(take.status === 200 && take.json?.iv === iv && take.json?.ciphertext === ciphertext,
    "transfer-take returns the same IV and ciphertext, byte for byte", String(take.status));
  check(count(`select count(*) from public.transfer_blobs where lookup_hash = ${q(lookupHash)}`) === 0, "and the row is gone after the first take");

  const again = await call("transfer-take", { lookup }, { Origin: CLUB });
  check(again.status === 404, "a second take finds nothing", `${again.status} ${JSON.stringify(again.json)}`);
}

// 2. Recovery ---------------------------------------------------------------------------------------
{
  const username = `rec_${Date.now().toString(36)}`;
  const email = `${username}@members.haimuniya.invalid`;
  const first = "first-password-1234";
  const second = "second-password-5678";
  const third = "third-password-9012";

  const signup = await auth("signup", { email, password: first });
  const token = signup.json?.access_token;
  check(signup.status === 200 && !!token, "a member account exists (local sign-up)", String(signup.status));

  const issued = await call("issue-recovery-code", {}, { Authorization: `Bearer ${token}` });
  const code = issued.json?.recovery_code;
  check(issued.status === 200 && typeof code === "string" && code.length >= 16, "issue-recovery-code returns a code once", String(issued.status));
  const uid = sql(`select id from auth.users where email = ${q(email)}`)[0]?.[0];
  check(count(`select count(*) from public.recovery_codes where user_id = ${q(uid)} and kind = 'recovery'`) === 1, "only its HMAC is stored, one row");

  const ok = await call("recover-password", { username, recovery_code: code, new_password: second });
  const next = ok.json?.recovery_code;
  check(ok.status === 200 && ok.json?.ok === true && typeof next === "string" && next !== code, "recover-password sets the new password and rotates the code", String(ok.status));
  check((await auth("token?grant_type=password", { email, password: second })).status === 200, "the new password signs in");
  check((await auth("token?grant_type=password", { email, password: first })).status !== 200, "the old one does not");

  const reused = await call("recover-password", { username, recovery_code: code, new_password: third });
  check(reused.status === 400 && reused.json?.error === "recovery_failed", "the used code is dead", String(reused.status));

  // One success and one reuse so far; three more wrong codes make five attempts in the window.
  const wrong = [];
  for (let i = 0; i < 3; i++) wrong.push(await call("recover-password", { username, recovery_code: "ABCD-EFGH-JKLM-NPQR", new_password: third }));
  check(wrong.every((r) => r.status === 400 && r.json?.error === "recovery_failed"), "wrong codes get the generic failure", wrong.map((r) => r.status).join(","));
  const attempts = count(`select count(*) from public.recovery_attempts`);
  check(attempts >= 10, "every attempt is counted, by username and by address", String(attempts));

  const limited = await call("recover-password", { username, recovery_code: next, new_password: third });
  check(limited.status === wrong[0].status && JSON.stringify(limited.json) === JSON.stringify(wrong[0].json),
    "with the limit spent, the RIGHT code gets exactly the answer a wrong one does", `${limited.status} ${JSON.stringify(limited.json)}`);
  check((await auth("token?grant_type=password", { email, password: third })).status !== 200, "and the password did not change");
  check((await auth("token?grant_type=password", { email, password: second })).status === 200, "the current password still works");

  sql(`delete from public.recovery_attempts`);
  const after = await call("recover-password", { username, recovery_code: next, new_password: third });
  check(after.status === 200 && after.json?.ok === true, "with the attempts cleared the same code works, so the refusal was the limit", String(after.status));
}

const failed = results.filter((r) => !r.ok);
const md = [
  `## Test 4: transfer and password recovery (API)`,
  "",
  `${results.length - failed.length} of ${results.length} checks passed.`,
  "",
  ...results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.what}${r.detail && !r.ok ? ` (${r.detail})` : ""}`),
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), md);
process.exit(failed.length ? 1 : 0);
