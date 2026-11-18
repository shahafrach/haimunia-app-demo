// Q-38f (202611180003): shape of the purge and the join-code hardening (behaviour in pgTAP 0162, CI), the
// passkey revocation on recovery, and BOX-LOG's mark_active call.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { handleRecover, recoveryHmac } from "../supabase/functions/_shared/recovery.mjs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202611180003_q38f_purge_and_join_code_hardening.sql", import.meta.url), "utf8");
const body = (name) => {
  const m = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n(?:end \\$\\$|\\$\\$);`));
  assert.ok(m, name);
  return m[0];
};

test("one deletion body, used by delete_my_account and the purge", () => {
  const mine = body("delete_my_account");
  assert.match(mine, /aal_satisfied\(\)/);
  assert.match(mine, /check_rate_limit\('delete_my_account', 3, 60\)/);
  assert.match(mine, /perform public\.delete_account_now\(v_uid\);/);
  assert.doesNotMatch(mine, /delete from /);
  assert.match(body("purge_abandoned_club_accounts"), /perform public\.delete_account_now\(v_id\);/);
  assert.equal((sql.match(/delete from auth\.users/g) || []).length, 1);
});

test("the purge warns first, never touches staff or owners, and aborts on a big batch", () => {
  const p = body("purge_abandoned_club_accounts");
  assert.match(p, /m\.role in \('owner', 'coach'\)/, "never staff or an owner");
  assert.match(p, /not public\.account_holds_training_data\(u\.id\)/);
  assert.match(p, /a\.purge_warned_at > v_last and a\.purge_warned_at <= now\(\) - interval '30 days'/, "deleted only 30 days after a warning given after the last activity");
  assert.match(p, /'account_purge_warning'/);
  assert.match(p, /> greatest\(coalesce\(p_max_batch, 25\), 1\) then\s*return jsonb_build_object\('aborted', true/);
  assert.match(sql, /cron\.schedule\('purge-abandoned-club-accounts', '41 4 \* \* \*', \$\$select public\.purge_abandoned_club_accounts\(365, 25\)\$\$\)/);
  const act = body("account_last_activity");
  for (const s of ["public.account_activity", "u.last_sign_in_at", "s.refreshed_at", "auth.refresh_tokens", "p.published_at", "r.created_at"]) assert.ok(act.includes(s), s);
  assert.match(body("notif_push_pending"), /n\.type in \('reset_requested', 'account_purge_warning'\)/, "the warning is pushed without a preference row");
  assert.match(sql, /revoke all on public\.account_activity from public, anon, authenticated;/, "nobody sees anyone's last activity");
});

test("the join code: an HMAC under a Vault key, a per-IP limit and a global ceiling, the long token untouched", () => {
  assert.match(body("join_code_hmac"), /extensions\.hmac\('haimunia:join-code:v1:' \|\| public\.join_code_normalize\(p_code\), public\.join_code_key\(\), 'sha256'\)/);
  assert.match(body("rotate_club_invite"), /public\.join_code_hmac\(v_code\), v_uid, 'infinity', 100000\)/);
  const j = body("join_circle");
  assert.match(j, /transfer_rate_ok\(public\.request_ip_hash\(\), 'join_code', 20, 60\)/);
  assert.match(j, /a\.ip_hash = 'global' and a\.action = 'join_code_wrong'[\s\S]*a\.attempt_count >= 300/);
  assert.match(j, /i\.code_hash in \(v_code_hmac, v_code_sha\)/, "the row made before this keeps working until it is rotated");
  const tokenBranch = j.slice(j.indexOf("if p_token ~ '^[0-9a-f]{64}$' then"), j.indexOf("elsif v_code"));
  assert.doesNotMatch(tokenBranch, /transfer_rate_ok/, "the long token has no IP limit added");
  assert.match(body("request_ip_hash"), /'cf-connecting-ip'/);
  assert.doesNotMatch(sql, /x-forwarded-for/i);
  assert.match(sql, /vault\.create_secret\(encode\(extensions\.gen_random_bytes\(32\), 'hex'\), 'join_code_hmac_key'/);
  assert.doesNotMatch(sql, /notif_on_circle_join/, "no join push to staff: it reverses an owner decision and waits for him");
});

test("a recovery removes the account's passkeys", async () => {
  const revoked = [];
  const code = "ABCD-EFGH-JKLM-NPQR";
  const store = {
    lookupUser: async () => "u-dana", getRecoveryHmac: async () => recoveryHmac("s", code), consumeReset: async () => false,
    setPassword: async () => true, revokeSessions: async () => {}, revokePasskeys: async (id) => { revoked.push(id); },
    putRecoveryCode: async () => {}, clearReset: async () => {}, countAttempts: async () => 0, addAttempts: async () => {}, purgeAttempts: async () => {},
  };
  const out = await handleRecover({ body: { username: "dana", recovery_code: code, new_password: "Newpassw0rd!" }, ip: "203.0.113.7" }, { secret: "s", store });
  assert.equal(out.status, 200);
  assert.deepEqual(revoked, ["u-dana"]);
  const idx = fs.readFileSync(new URL("../supabase/functions/recover-password/index.ts", import.meta.url), "utf8");
  assert.match(idx, /\/auth\/v1\/admin\/users\/\$\{encodeURIComponent\(userId\)\}\/passkeys/);
});

test("BOX-LOG marks the account active once per app open with a session", () => {
  const src = fs.readFileSync(new URL("../src/community/notifications.js", import.meta.url), "utf8");
  assert.match(src, /if \(!markedActive && !state\.user\.is_anonymous\) \{\s*markedActive = true;\s*try \{ Promise\.resolve\(client\.rpc\("mark_active"\)\)/);
});
