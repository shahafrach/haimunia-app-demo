// The Haimunia transfer code (docs/club/research.md, section D): the logic behind
// the Edge Functions transfer-put and transfer-take, kept free of Deno and of the
// network so Node tests can run it (test/transfer-edge-functions.test.mjs).
// The index.ts files only wire real dependencies into the handlers below.
//
// The server never sees the code or the key. The old app derives two values from
// the code with HKDF: `lookup` (32 bytes, sent here as hex) and the AES-GCM key
// (kept on the phone). It sends { lookup, iv, ciphertext }. This side stores the
// sha256 of the lookup, the IV and the ciphertext, through the database functions
// transfer_put / transfer_take (202611120001), which also hold the limits:
// 5 puts per IP per day, 40 pending blobs in all, 10 takes per IP per 15 minutes,
// one take per blob, 24 hours at most. The IP itself is never stored, only an
// HMAC of it under this file's own domain prefix.

// Puts come from the old app and, since F-001 (owner decision 2026-11-14), from the
// club app's Safari tab, which hands its log to the club app installed on the home
// screen. Takes still come only from the club app. Limits, expiry and single use
// are the database's and do not depend on the origin.
export const PUT_ORIGIN = "https://haimuniya.github.io";
export const TAKE_ORIGIN = "https://haimunia.pages.dev";
export const PUT_ORIGINS = Object.freeze([PUT_ORIGIN, TAKE_ORIGIN]);

/** True only for an exact match with one of the allowed put origins. */
export function isPutOrigin(origin) {
  return typeof origin === "string" && PUT_ORIGINS.includes(origin);
}
/** The origin to echo in Access-Control-Allow-Origin for a put request. */
export function putCorsOrigin(origin) {
  return isPutOrigin(origin) ? origin : PUT_ORIGIN;
}
export const IP_DOMAIN = "haimunia:transfer-ip:v1:";
export const MAX_CIPHERTEXT_BYTES = 5 * 1024 * 1024;
// base64 of 5 MiB, plus room for the rest of the JSON body.
export const MAX_BODY_BYTES = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4 + 4096;

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(String(text))));
}
export async function ipHash(secret, ip) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(IP_DOMAIN + String(ip || "unknown"))));
}

export function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isB64 = (s) => typeof s === "string" && s.length % 4 === 0 && B64.test(s);
const isLookup = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** True when the base64 decodes to JSON: a client that forgot to encrypt. The database checks again. */
export function decodesToJson(b64) {
  try {
    const text = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(text, (c) => c.charCodeAt(0))));
    return true;
  } catch {
    return false;
  }
}

function originRefused(origin, allowed) {
  // A browser always sends Origin on a cross-origin POST. Anything else is not the app.
  return origin !== allowed;
}

/**
 * transfer-put. req: { body, ip, origin, bodyBytes }.
 * deps: { secret, put(lookupHash, ivB64, ciphertextB64, ipHash) -> status string }
 * Answers: 200 { status: "stored" } | 400 { error } | 403 { error: "origin" } | 413 | 429 | 503 { error: "full" }
 */
export async function handleTransferPut(req, deps) {
  if (!deps.secret) return { status: 500, body: { error: "not_configured" } };
  if (!isPutOrigin(req.origin)) return { status: 403, body: { error: "origin" } };
  if (req.bodyBytes != null && req.bodyBytes > MAX_BODY_BYTES) return { status: 413, body: { error: "too_large" } };
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (!isLookup(b.lookup) || !isB64(b.iv) || !isB64(b.ciphertext)) return { status: 400, body: { error: "invalid" } };
  if (decodesToJson(b.ciphertext)) return { status: 400, body: { error: "plaintext" } };
  const status = await deps.put(await sha256Hex(b.lookup), b.iv, b.ciphertext, await ipHash(deps.secret, req.ip));
  switch (status) {
    case "stored": return { status: 200, body: { status: "stored" } };
    case "rate_limited": return { status: 429, body: { error: "rate_limited" } };
    case "full": return { status: 503, body: { error: "full" } };
    case "too_large": return { status: 413, body: { error: "too_large" } };
    case "plaintext": return { status: 400, body: { error: "plaintext" } };
    case "exists": return { status: 409, body: { error: "exists" } };
    default: return { status: 400, body: { error: "invalid" } };
  }
}

/**
 * transfer-take. req: { body, ip, origin }.
 * deps: { secret, take(lookupHash, ipHash) -> { status, iv?, ciphertext? } }
 * Answers: 200 { iv, ciphertext } | 404 { error: "not_found" } | 400 | 403 | 429
 */
export async function handleTransferTake(req, deps) {
  if (!deps.secret) return { status: 500, body: { error: "not_configured" } };
  if (originRefused(req.origin, TAKE_ORIGIN)) return { status: 403, body: { error: "origin" } };
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (!isLookup(b.lookup)) return { status: 400, body: { error: "invalid" } };
  const out = (await deps.take(await sha256Hex(b.lookup), await ipHash(deps.secret, req.ip))) || {};
  if (out.status === "ok") return { status: 200, body: { iv: out.iv, ciphertext: out.ciphertext } };
  if (out.status === "rate_limited") return { status: 429, body: { error: "rate_limited" } };
  if (out.status === "not_found") return { status: 404, body: { error: "not_found" } };
  return { status: 400, body: { error: "invalid" } };
}
