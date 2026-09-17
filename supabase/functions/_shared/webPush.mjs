// Web Push message encryption and VAPID signing, RFC 8291 + RFC 8188 + RFC 8292.
//
// WHY THIS IS A SEPARATE .mjs AND NOT INLINE IN THE FUNCTION. Nothing about
// a push send can be observed from here: it succeeds or it silently does not
// arrive on somebody's phone, and the Edge runtime has no browser to watch.
// So the bytes are built by a module with no I/O in it, and
// test/web-push-crypto.test.mjs runs THIS file - the same file the Edge
// Function imports - against RFC 8291's own published example. If the
// encryption is wrong, a node --test run says so, not a member who stopped
// getting notifications.
//
// Uses WebCrypto only (globalThis.crypto.subtle), which Deno and Node 18+
// both provide, so there is one implementation rather than one per runtime.

const enc = new TextEncoder();

export function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

// HKDF with a one-block output, which is all any step here needs (the longest
// is 32 bytes). Writing the general form would be more code and no more
// correct: every caller below takes 32 bytes or fewer.
async function hkdf(salt, ikm, info, length) {
  if (length > 32) throw new Error("hkdf: this one-block form tops out at 32 bytes");
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concat(info, Uint8Array.of(1)));
  return okm.slice(0, length);
}

// An EC public key is the X9.62 uncompressed point 0x04 || X || Y, which is
// what PushManager.subscribe hands back and what WebCrypto's "raw" format
// wants. The private half is a bare 32-byte scalar, and WebCrypto will not
// take that raw - hence the JWK detour.
function jwkFromKeyPair(publicBytes, privateBytes) {
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error("public key must be a 65-byte uncompressed P-256 point");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(publicBytes.slice(1, 33)),
    y: bytesToB64url(publicBytes.slice(33, 65)),
    ...(privateBytes ? { d: bytesToB64url(privateBytes) } : {}),
    ext: true,
  };
}

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: bytesToB64url(pub), privateKey: jwk.d };
}

/**
 * Encrypt one push message body (RFC 8291 §3, content coding RFC 8188).
 *
 * The `salt` and `serverKeys` parameters exist ONLY so the RFC's example can
 * be reproduced exactly. Real sends leave them out and get fresh randomness,
 * which is required: reusing a salt or an ephemeral key across messages to
 * the same subscriber leaks plaintext relationships.
 */
export async function encryptPushPayload({ payload, p256dh, auth, salt, serverKeys, recordSize = 4096 }) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  const plaintext = typeof payload === "string" ? enc.encode(payload) : new Uint8Array(payload);

  const saltBytes = salt ? b64urlToBytes(salt) : crypto.getRandomValues(new Uint8Array(16));

  let asPublic, asPrivateKey;
  if (serverKeys) {
    asPublic = b64urlToBytes(serverKeys.publicKey);
    asPrivateKey = await crypto.subtle.importKey(
      "jwk", jwkFromKeyPair(asPublic, b64urlToBytes(serverKeys.privateKey)),
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    );
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivateKey = pair.privateKey;
  }

  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asPrivateKey, 256),
  );

  // RFC 8291 §3.4. The info string binds the derived key to BOTH public keys,
  // in this order - user agent first. Swapping them produces a key that is
  // perfectly valid and that no browser can decrypt.
  const keyInfo = concat(enc.encode("WebPush: info"), Uint8Array.of(0), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cek = await hkdf(saltBytes, ikm, concat(enc.encode("Content-Encoding: aes128gcm"), Uint8Array.of(0)), 16);
  const nonce = await hkdf(saltBytes, ikm, concat(enc.encode("Content-Encoding: nonce"), Uint8Array.of(0)), 12);

  // 0x02 is the last-record delimiter (RFC 8188 §2). 0x01 would mean "another
  // record follows" and the browser would wait for one that never comes.
  const padded = concat(plaintext, Uint8Array.of(2));
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, padded),
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, recordSize, false);
  const header = concat(saltBytes, rs, Uint8Array.of(asPublic.length), asPublic);
  return concat(header, ciphertext);
}

/**
 * VAPID (RFC 8292): a JWT the push service checks to see that the same party
 * that the subscription was created for is the one sending.
 */
export async function buildVapidAuth({ endpoint, subject, publicKey, privateKey, expiresInSeconds = 12 * 60 * 60, now }) {
  const audience = new URL(endpoint).origin;
  const nowSec = Math.floor((now ?? Date.now()) / 1000);
  // 24h is the protocol maximum; 12h default leaves room for a clock skew in
  // either direction without ever presenting an already-expired token.
  const claims = { aud: audience, exp: nowSec + expiresInSeconds, sub: subject };
  const signingInput = `${bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${bytesToB64url(enc.encode(JSON.stringify(claims)))}`;

  const pub = b64urlToBytes(publicKey);
  const key = await crypto.subtle.importKey(
    "jwk", { ...jwkFromKeyPair(pub, b64urlToBytes(privateKey)), key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  // WebCrypto emits the raw r||s pair ES256 wants. Node's crypto.sign would
  // emit DER here, which push services reject - one reason this file uses
  // WebCrypto on both runtimes rather than the host's native crypto.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)));
  const jwt = `${signingInput}.${bytesToB64url(sig)}`;
  return { Authorization: `vapid t=${jwt}, k=${publicKey}` };
}
