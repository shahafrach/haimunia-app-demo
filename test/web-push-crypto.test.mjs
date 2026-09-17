// B3. The encryption that decides whether a push notification arrives.
//
// This is the one piece of the app whose failure is completely silent: a
// wrong byte here means the push service accepts the request, returns 201,
// and the member's phone shows nothing. There is no error to read and no
// screen to look at. So it is verified against RFC 8291's own published
// example rather than against itself.
import { test } from "node:test";
import assert from "node:assert";
import {
  encryptPushPayload, buildVapidAuth, generateVapidKeys, b64urlToBytes, bytesToB64url,
} from "../supabase/functions/_shared/webPush.mjs";

// RFC 8291 section 5, verbatim.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const rfcArgs = {
  payload: RFC.plaintext,
  p256dh: RFC.uaPublic,
  auth: RFC.auth,
  salt: RFC.salt,
  serverKeys: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
  recordSize: 4096,
};

test("the encrypted body is byte-identical to RFC 8291's example", async () => {
  const body = await encryptPushPayload(rfcArgs);
  assert.equal(bytesToB64url(body), RFC.body,
    "this is the whole safety net for a feature with no observable failure");
});

test("the header carries salt, record size and the server's public key, in that order", async () => {
  const body = await encryptPushPayload(rfcArgs);
  assert.equal(bytesToB64url(body.slice(0, 16)), RFC.salt, "16-byte salt first");
  assert.equal(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false), 4096, "record size, big-endian");
  assert.equal(body[20], 65, "then the length of the key that follows");
  assert.equal(bytesToB64url(body.slice(21, 86)), RFC.asPublic, "then the key itself, uncompressed");
});

// The tests above would all still pass if the browser could not decrypt the
// result. This one decrypts it the way a browser does, with the user agent's
// PRIVATE key, and is the assertion that the message is actually readable.
async function decryptAsBrowser(body, { uaPublic, uaPrivate, auth }) {
  const enc = new TextEncoder();
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const ciphertext = body.slice(86);
  const uaPub = b64urlToBytes(uaPublic);
  const uaKey = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256",
    x: bytesToB64url(uaPub.slice(1, 33)), y: bytesToB64url(uaPub.slice(33, 65)),
    d: uaPrivate, ext: true,
  }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaKey, 256));

  const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
  const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign("HMAC",
    await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const hkdf = async (s, ikm, info, len) => (await hmac(await hmac(s, ikm), cat(info, Uint8Array.of(1)))).slice(0, len);

  const ikm = await hkdf(b64urlToBytes(auth), shared,
    cat(enc.encode("WebPush: info"), Uint8Array.of(0), uaPub, asPublic), 32);
  const cek = await hkdf(salt, ikm, cat(enc.encode("Content-Encoding: aes128gcm"), Uint8Array.of(0)), 16);
  const nonce = await hkdf(salt, ikm, cat(enc.encode("Content-Encoding: nonce"), Uint8Array.of(0)), 12);
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 },
    await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]), ciphertext));
  assert.equal(out[out.length - 1], 2, "last-record delimiter");
  return new TextDecoder().decode(out.slice(0, -1));
}

test("a browser holding the subscription's private key can read it back", async () => {
  const body = await encryptPushPayload(rfcArgs);
  assert.equal(await decryptAsBrowser(body, { uaPublic: RFC.uaPublic, uaPrivate: RFC.uaPrivate, auth: RFC.auth }), RFC.plaintext);
});

test("a real send round-trips with fresh randomness, not just the RFC's fixed inputs", async () => {
  // No salt and no serverKeys: the path production actually takes.
  const payload = JSON.stringify({ title: "הרצף שלך בסכנה", body: "לא התאמנת היום" });
  const body = await encryptPushPayload({ payload, p256dh: RFC.uaPublic, auth: RFC.auth });
  assert.equal(await decryptAsBrowser(body, { uaPublic: RFC.uaPublic, uaPrivate: RFC.uaPrivate, auth: RFC.auth }), payload,
    "including Hebrew, which is multi-byte and would break a length assumption");
});

test("two sends of the same message never produce the same bytes", async () => {
  const [a, b] = await Promise.all([
    encryptPushPayload({ payload: "x", p256dh: RFC.uaPublic, auth: RFC.auth }),
    encryptPushPayload({ payload: "x", p256dh: RFC.uaPublic, auth: RFC.auth }),
  ]);
  assert.notEqual(bytesToB64url(a), bytesToB64url(b),
    "a reused salt or ephemeral key across messages to one subscriber leaks plaintext relationships");
});

test("a wrong auth secret produces a message the browser cannot read", async () => {
  // The failure this guards is the one that looks like success: the push
  // service returns 201 for a body it cannot read and neither can the phone.
  const body = await encryptPushPayload({ payload: "x", p256dh: RFC.uaPublic, auth: bytesToB64url(new Uint8Array(16)) });
  await assert.rejects(() => decryptAsBrowser(body, { uaPublic: RFC.uaPublic, uaPrivate: RFC.uaPrivate, auth: RFC.auth }));
});

test("the VAPID header is a verifiable ES256 JWT for the endpoint's origin", async () => {
  const keys = await generateVapidKeys();
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123?x=1";
  const now = 1_700_000_000_000;
  const { Authorization } = await buildVapidAuth({
    endpoint, subject: "mailto:club@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey, now,
  });

  const [, t, k] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(Authorization) || [];
  assert.ok(t, `header is not in the form the push service parses: ${Authorization}`);
  assert.equal(k, keys.publicKey, "and it advertises the key the subscription was made with");

  const [h, p, s] = t.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlToBytes(h))), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  assert.equal(claims.aud, "https://fcm.googleapis.com", "audience is the ORIGIN, never the full endpoint");
  assert.equal(claims.sub, "mailto:club@example.com");
  assert.equal(claims.exp, now / 1000 + 12 * 60 * 60);
  assert.ok(claims.exp - now / 1000 <= 24 * 60 * 60, "24h is the protocol maximum");

  // Verify the signature rather than trusting that signing did not throw.
  const pub = b64urlToBytes(keys.publicKey);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(
    await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`)),
    true, "ES256 wants the raw r||s pair; Node's crypto.sign would have produced DER here and the push service would reject it");
});

test("generated keypairs are the shapes the browser and the push service expect", async () => {
  const { publicKey, privateKey } = await generateVapidKeys();
  const pub = b64urlToBytes(publicKey);
  assert.equal(pub.length, 65, "uncompressed P-256 point");
  assert.equal(pub[0], 0x04, "with the uncompressed marker applicationServerKey requires");
  assert.equal(b64urlToBytes(privateKey).length, 32);
  assert.ok(!/[+/=]/.test(publicKey + privateKey), "base64url, not base64 - a '+' in the key breaks subscribe()");
});
