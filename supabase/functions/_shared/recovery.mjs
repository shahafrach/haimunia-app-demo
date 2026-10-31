// Password recovery without email: the logic behind the Edge Functions
// issue-recovery-code and recover-password, kept free of Deno and of the
// network so Node tests can run it (test/recovery-edge-functions.test.mjs).
// The index.ts files only wire real dependencies into the handlers below.
//
// The scheme (docs/circles/decisions.md, "Home and recovery"):
//   * a recovery code is 4 groups of 4 characters from a 32-symbol alphabet
//     with no 0 O 1 I: 16 x 5 = 80 bits;
//   * only an HMAC-SHA256 of it is stored, keyed by the Edge Function secret
//     RECOVERY_CODE_HMAC_SECRET, under a domain prefix so the same secret can
//     never be turned into a different kind of tag;
//   * a code is shown once and rotated on every use;
//   * the owner can issue a one-hour, one-use "reset" code from the SQL editor
//     (owner_issue_reset_code); recover-password accepts it like a recovery code;
//   * every failure of recover-password is the same answer.

export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 16;
export const RECOVERY_DOMAIN = "box-log:recovery-code:v1:";
export const ATTEMPT_DOMAIN = "box-log:recovery-attempt:v1:";
export const ATTEMPT_LIMIT = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const GENERIC_FAILURE = Object.freeze({ error: "recovery_failed" });

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** 4 groups of 4 from the alphabet, from `bytes` (16 random bytes; each gives 5 bits). */
export function codeFromBytes(bytes) {
  if (!bytes || bytes.length < CODE_LENGTH) throw new Error("need 16 random bytes");
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[bytes[i] & 31];
  return raw.match(/.{4}/g).join("-");
}
export function generateCode(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return codeFromBytes(randomBytes(CODE_LENGTH));
}
/** The comparable form: upper case, only characters a code can contain. */
export function normalizeCode(input) {
  return String(input == null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export function looksLikeCode(input) {
  const n = normalizeCode(input);
  return n.length === CODE_LENGTH && [...n].every((c) => CODE_ALPHABET.includes(c));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}
export function recoveryHmac(secret, code) {
  return hmacHex(secret, RECOVERY_DOMAIN + normalizeCode(code));
}
/** A comparison that does not stop at the first differing character. */
export function timingSafeEqualStrings(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The same rule as the client (src/community/auth.js passwordRuleError) and supabase/config.toml. */
export function passwordOk(pw) {
  const p = String(pw == null ? "" : pw);
  return p.length >= 10 && p.length <= 72 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p);
}
export function usernameOk(u) { return /^[a-z0-9_]{3,24}$/.test(u); }

export const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});
function json(status, body) {
  return { status, body };
}
const fail = () => json(400, GENERIC_FAILURE);

/**
 * issue-recovery-code. An authenticated, permanent account makes (or rotates)
 * its own recovery code. Returns the code once; only its HMAC is stored.
 * deps: { secret, getUser(token) -> {id, is_anonymous} | null, store, randomBytes? }
 */
export async function handleIssue(req, deps) {
  if (!deps.secret) return json(500, { error: "not_configured" });
  const m = /^Bearer\s+(\S+)$/i.exec(req.authorization || "");
  const user = m ? await deps.getUser(m[1]) : null;
  if (!user || !user.id || user.is_anonymous) return json(401, { error: "unauthorized" });
  const code = generateCode(deps.randomBytes);
  await deps.store.putRecoveryCode(user.id, await recoveryHmac(deps.secret, code));
  return json(200, { recovery_code: code });
}

/**
 * recover-password. `req` is { body, ip }. Every failure, the rate limit
 * included, is the same status and the same body.
 * deps: { secret, store, now?, randomBytes? }
 * store: lookupUser(username) -> id|null; getRecoveryHmac(id) -> string|null;
 *   consumeReset(id, code) -> bool; setPassword(id, pw) -> bool; revokeSessions(id);
 *   putRecoveryCode(id, hmac); clearReset(id); countAttempts(keyHash, sinceMs) -> n;
 *   addAttempts(keyHashes); purgeAttempts(beforeMs)
 */
export async function handleRecover(req, deps) {
  if (!deps.secret) return json(500, { error: "not_configured" });
  const now = (deps.now || Date.now)();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const code = typeof body.recovery_code === "string" ? body.recovery_code : "";
  const password = typeof body.new_password === "string" ? body.new_password : "";
  const ip = String(req.ip || "unknown");

  // Throttle on what the caller claims and where they come from, before looking at anything.
  const userKey = await hmacHex(deps.secret, ATTEMPT_DOMAIN + "user:" + username);
  const ipKey = await hmacHex(deps.secret, ATTEMPT_DOMAIN + "ip:" + ip);
  const since = now - ATTEMPT_WINDOW_MS;
  const [byUser, byIp] = await Promise.all([deps.store.countAttempts(userKey, since), deps.store.countAttempts(ipKey, since)]);
  if (byUser >= ATTEMPT_LIMIT || byIp >= ATTEMPT_LIMIT) return fail();
  await deps.store.addAttempts([userKey, ipKey]);
  await deps.store.purgeAttempts(now - 24 * 60 * 60 * 1000);

  // Both checks always run, so the time taken does not say which one a code matched.
  const shapeOk = usernameOk(username) && looksLikeCode(code) && passwordOk(password);
  const userId = shapeOk ? await deps.store.lookupUser(username) : null;
  const stored = userId ? await deps.store.getRecoveryHmac(userId) : null;
  const given = await recoveryHmac(deps.secret, code);
  const recoveryMatch = timingSafeEqualStrings(stored || "0".repeat(64), given) && !!stored;
  const resetMatch = userId ? await deps.store.consumeReset(userId, code) : false;
  if (!shapeOk || !userId || !(recoveryMatch || resetMatch)) return fail();

  if (!(await deps.store.setPassword(userId, password))) return fail();
  await deps.store.revokeSessions(userId);
  // Rotate: the code that was just used is dead whichever kind it was.
  const next = generateCode(deps.randomBytes);
  await deps.store.putRecoveryCode(userId, await recoveryHmac(deps.secret, next));
  await deps.store.clearReset(userId);
  return json(200, { ok: true, recovery_code: next });
}
