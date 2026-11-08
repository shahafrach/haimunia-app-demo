// mfa-recovery: the way back in when the authenticator app is lost.
//   POST { recovery_code } with the member's own session (password only, aal1)
//   -> { ok: true, recovery_code: <new> }
// The member proves they hold the recovery code they saved at sign-up. The
// server then removes their TOTP factors and rotates the code, which is shown
// once. The session needs no second factor for this call (that is the point),
// so it is throttled hard: 5 tries per 15 minutes per member and per address,
// one generic answer for every failure. Kept free of Deno and of the network so
// Node tests can run it (test/mfa-recovery-edge-function.test.mjs).
import {
  ATTEMPT_DOMAIN, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS, generateCode, hmacHex,
  looksLikeCode, recoveryHmac, timingSafeEqualStrings,
} from "./recovery.mjs";

const json = (status, body) => ({ status, body });
const FAIL = () => json(400, { error: "recovery_failed" });

/**
 * req: { authorization, body, ip }
 * deps: { secret, getUser(token) -> {id,is_anonymous}|null, randomBytes?, now?, store }
 * store: countAttempts(keyHash, sinceMs) -> n; addAttempts(keyHashes); purgeAttempts(beforeMs);
 *   getRecoveryHmac(userId) -> string|null; consumeReset(userId, code) -> bool;
 *   removeTotpFactors(userId) -> bool; putRecoveryCode(userId, hmac); clearReset(userId)
 */
export async function handleMfaRecovery(req, deps) {
  if (!deps.secret) return json(500, { error: "not_configured" });
  const now = (deps.now || Date.now)();
  const m = /^Bearer\s+(\S+)$/i.exec(req.authorization || "");
  const user = m ? await deps.getUser(m[1]) : null;
  if (!user || !user.id || user.is_anonymous) return json(401, { error: "unauthorized" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const code = typeof body.recovery_code === "string" ? body.recovery_code : "";

  const userKey = await hmacHex(deps.secret, ATTEMPT_DOMAIN + "mfa-user:" + user.id);
  const ipKey = await hmacHex(deps.secret, ATTEMPT_DOMAIN + "mfa-ip:" + String(req.ip || "unknown"));
  const since = now - ATTEMPT_WINDOW_MS;
  const [byUser, byIp] = await Promise.all([deps.store.countAttempts(userKey, since), deps.store.countAttempts(ipKey, since)]);
  if (byUser >= ATTEMPT_LIMIT || byIp >= ATTEMPT_LIMIT) return FAIL();
  await deps.store.addAttempts([userKey, ipKey]);
  await deps.store.purgeAttempts(now - 24 * 60 * 60 * 1000);

  const stored = await deps.store.getRecoveryHmac(user.id);
  const given = await recoveryHmac(deps.secret, code);
  const recoveryMatch = timingSafeEqualStrings(stored || "0".repeat(64), given) && !!stored;
  const resetMatch = await deps.store.consumeReset(user.id, code);
  if (!looksLikeCode(code) || !(recoveryMatch || resetMatch)) return FAIL();

  if (!(await deps.store.removeTotpFactors(user.id))) return FAIL();
  const next = generateCode(deps.randomBytes);
  await deps.store.putRecoveryCode(user.id, await recoveryHmac(deps.secret, next));
  await deps.store.clearReset(user.id);
  return json(200, { ok: true, recovery_code: next });
}
