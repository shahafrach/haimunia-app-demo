// The Haimunia transfer code (docs/club/research.md, section D; owner decision 2):
// the shared logic behind the transfer-put and transfer-take Edge Functions
// (supabase/functions/_shared/transfer.mjs), driven with a fake store that
// behaves like the database functions transfer_put / transfer_take.
//
// The client side here is the protocol the old app and the club app implement:
// 13 random bytes -> HKDF-SHA256 -> lookup (32 bytes) + AES-GCM-256 key; the
// backup is gzipped and encrypted on the phone with AAD "haimunia-transfer:v1".
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  handleTransferPut, handleTransferTake, sha256Hex, ipHash, decodesToJson,
  PUT_ORIGIN, TAKE_ORIGIN, PUT_ORIGINS, isPutOrigin, putCorsOrigin, MAX_BODY_BYTES, deviceHash,
} from "../supabase/functions/_shared/transfer.mjs";

const SECRET = "test-secret-not-a-real-one";
const AAD = new TextEncoder().encode("haimunia-transfer:v1");
const b64 = (u8) => Buffer.from(u8).toString("base64");
const hex = (u8) => Buffer.from(u8).toString("hex");

async function derive(codeBytes) {
  const base = await crypto.subtle.importKey("raw", codeBytes, "HKDF", false, ["deriveBits", "deriveKey"]);
  const salt = new Uint8Array(0);
  const lookup = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("haimunia-transfer:lookup:v1") }, base, 256));
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("haimunia-transfer:key:v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { lookup: hex(lookup), key };
}
async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function encryptBackup(backup) {
  const code = crypto.getRandomValues(new Uint8Array(13));
  const { lookup, key } = await derive(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(backup)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain));
  return { code, lookup, body: { lookup, iv: b64(iv), ciphertext: b64(ct) } };
}

// A fake database with transfer_put / transfer_take's rules.
function makeDb() {
  const db = { blobs: new Map(), puts: new Map(), devicePuts: new Map(), takes: new Map(), now: Date.now() };
  // 202611140002: 30 per IP, then 3 per device (only when the app sends one), per day.
  db.put = async (lookupHash, ivB64, ctB64, ip, device) => {
    const n = (db.puts.get(ip) || 0) + 1; db.puts.set(ip, n);
    if (n > 30) return "rate_limited";
    if (device != null) {
      const d = (db.devicePuts.get(device) || 0) + 1; db.devicePuts.set(device, d);
      if (d > 3) return "rate_limited";
    }
    if (db.blobs.size >= 40) return "full";
    if (db.blobs.has(lookupHash)) return "exists";
    db.blobs.set(lookupHash, { iv: ivB64, ct: ctB64, at: db.now });
    return "stored";
  };
  db.take = async (lookupHash, ip) => {
    const n = (db.takes.get(ip) || 0) + 1; db.takes.set(ip, n);
    if (n > 10) return { status: "rate_limited" };
    const row = db.blobs.get(lookupHash);
    db.blobs.delete(lookupHash);
    if (!row || db.now - row.at > 24 * 3600e3) return { status: "not_found" };
    return { status: "ok", iv: row.iv, ciphertext: row.ct };
  };
  return db;
}
const put = (db, body, extra = {}) => handleTransferPut({ body, ip: "203.0.113.5", origin: PUT_ORIGIN, ...extra }, { secret: SECRET, put: db.put });
const take = (db, body, extra = {}) => handleTransferTake({ body, ip: "198.51.100.7", origin: TAKE_ORIGIN, ...extra }, { secret: SECRET, take: db.take });

const fixture = JSON.parse(readFileSync(new URL("./fixtures/old-app-backup-v1.json", import.meta.url), "utf8"));
const withBodyWeight = { ...fixture, bodyweightEntries: [{ date: "2026-11-01", weight: 81.4 }], sessionNotes: { "2026-11-01": "felt good" } };

test("a round trip: the old app puts, the club app takes once and decrypts the same backup", async () => {
  const db = makeDb();
  const { code, body } = await encryptBackup(withBodyWeight);
  assert.deepEqual(await put(db, body), { status: 200, body: { status: "stored" } });
  const { lookup, key } = await derive(code);
  const got = await take(db, { lookup });
  assert.equal(got.status, 200);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(got.body.iv, "base64"), additionalData: AAD },
    key, Buffer.from(got.body.ciphertext, "base64"));
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(plain)).toString("utf8")), withBodyWeight);
  assert.deepEqual(await take(db, { lookup }), { status: 404, body: { error: "not_found" } }, "a second take finds nothing");
});

test("owner decision 2: what the server stores is opaque, body weight included", async () => {
  const db = makeDb();
  const { body } = await encryptBackup(withBodyWeight);
  await put(db, body);
  const [[storedKey, row]] = [...db.blobs];
  const bytes = Buffer.from(row.ct, "base64");
  assert.throws(() => JSON.parse(bytes.toString("utf8")), "the blob is not JSON");
  assert.throws(() => gunzipSync(bytes), "nor gzip the server could open");
  for (const name of ['"entries"', '"bodyweightEntries"', '"weight"', '"sessionNotes"', '"app"', '"box-log"']) {
    assert.equal(bytes.indexOf(Buffer.from(name)), -1, `no ${name} in the stored bytes`);
  }
  assert.notEqual(storedKey, body.lookup, "the server keeps a hash of the lookup, not the lookup");
  assert.equal(storedKey, await sha256Hex(body.lookup));
});

test("a client bug that uploads plaintext is refused before the database", async () => {
  const db = makeDb();
  const plain = Buffer.from(JSON.stringify(withBodyWeight)).toString("base64");
  const out = await put(db, { lookup: "a".repeat(64), iv: b64(new Uint8Array(12)), ciphertext: plain });
  assert.deepEqual(out, { status: 400, body: { error: "plaintext" } });
  assert.equal(db.blobs.size, 0);
  assert.ok(decodesToJson(plain) && !decodesToJson(b64(crypto.getRandomValues(new Uint8Array(64)))));
});

test("origins: put from the old app or the club app (F-001), take only from the club app", async () => {
  const db = makeDb();
  const { body } = await encryptBackup(fixture);
  assert.equal((await put(db, body, { origin: null })).status, 403);
  assert.equal((await put(db, body)).status, 200, "the old app may put");
  assert.equal((await put(db, (await encryptBackup(fixture)).body, { origin: TAKE_ORIGIN })).status, 200, "the club app may put");
  assert.equal((await take(db, { lookup: body.lookup }, { origin: PUT_ORIGIN })).status, 403);
  assert.equal(db.blobs.size, 2, "a refused take does not consume either blob");
});

test("F-001: the put origin allowlist is exact: old origin allowed, new origin allowed, anything else refused", async () => {
  assert.deepEqual([...PUT_ORIGINS], ["https://haimuniya.github.io", "https://haimunia.pages.dev"]);
  assert.ok(isPutOrigin("https://haimuniya.github.io"));
  assert.ok(isPutOrigin("https://haimunia.pages.dev"));
  const refused = [
    null, undefined, "", "null", "https://evil.example", "http://haimunia.pages.dev", "http://haimuniya.github.io",
    "https://haimunia.pages.dev.evil.example", "https://preview.haimunia.pages.dev", "https://evil.github.io",
    "https://haimuniya.github.io/", "https://HAIMUNIA.pages.dev", "https://haimunia.pages.dev:443", " https://haimunia.pages.dev",
  ];
  for (const origin of refused) {
    assert.equal(isPutOrigin(origin), false, `refused: ${JSON.stringify(origin)}`);
    const db = makeDb();
    const out = await put(db, (await encryptBackup(fixture)).body, { origin });
    assert.deepEqual(out, { status: 403, body: { error: "origin" } }, `put refused from ${JSON.stringify(origin)}`);
    assert.equal(db.blobs.size, 0);
  }
  assert.equal(putCorsOrigin("https://haimunia.pages.dev"), "https://haimunia.pages.dev", "CORS echoes an allowed origin");
  assert.equal(putCorsOrigin("https://haimuniya.github.io"), "https://haimuniya.github.io");
  assert.equal(putCorsOrigin("https://evil.example"), PUT_ORIGIN, "CORS never echoes a refused origin");
});

test("F-001: limits are the same for both put origins (30 puts per IP per day are shared)", async () => {
  const db = makeDb();
  for (let i = 0; i < 30; i++) {
    const origin = i % 2 ? TAKE_ORIGIN : PUT_ORIGIN;
    assert.equal((await put(db, (await encryptBackup(fixture)).body, { origin })).status, 200);
  }
  assert.equal((await put(db, (await encryptBackup(fixture)).body, { origin: TAKE_ORIGIN })).status, 429);
});

test("F-001: a code put from the club app is taken once by the installed club app", async () => {
  const db = makeDb();
  const { code, body } = await encryptBackup(withBodyWeight);
  assert.equal((await put(db, body, { origin: TAKE_ORIGIN })).status, 200);
  const { lookup } = await derive(code);
  assert.equal((await take(db, { lookup })).status, 200);
  assert.equal((await take(db, { lookup })).status, 404, "single use holds for the new origin");
});

const DEVICE = "3f2b8c1e-9d4a-4b7e-8f21-6c5d0a9e7b13";
const withDevice = async (device = DEVICE) => ({ ...(await encryptBackup(fixture)).body, device });

test("per device: 3 puts a day, the same from both origins and across IPs; the IP limit still holds", async () => {
  const db = makeDb();
  assert.equal((await put(db, await withDevice(), { origin: PUT_ORIGIN })).status, 200);
  assert.equal((await put(db, await withDevice(), { origin: TAKE_ORIGIN, ip: "203.0.113.20" })).status, 200);
  assert.equal((await put(db, await withDevice(), { origin: TAKE_ORIGIN, ip: "203.0.113.21" })).status, 200);
  assert.deepEqual(await put(db, await withDevice(), { origin: PUT_ORIGIN, ip: "203.0.113.22" }), { status: 429, body: { error: "rate_limited" } },
    "the fourth from one device is refused, whatever the origin or IP");
  assert.equal((await put(db, await withDevice("another-device-0000000001"))).status, 200, "another device on the same IP passes");
  assert.equal((await put(db, (await encryptBackup(fixture)).body)).status, 200, "a put with no device (the old app) is held only by the IP limit");
});

test("shared gym Wi-Fi: 30 members on one IP each put once; the 31st is refused", async () => {
  const db = makeDb();
  for (let i = 0; i < 30; i++) {
    const origin = i % 2 ? TAKE_ORIGIN : PUT_ORIGIN;
    assert.equal((await put(db, await withDevice("member-device-" + String(i).padStart(10, "0")), { origin })).status, 200, `member ${i + 1}`);
  }
  assert.equal((await put(db, await withDevice("member-device-0000000099"))).status, 429);
});

test("the device id is checked for shape and only its HMAC reaches the database", async () => {
  const db = makeDb();
  for (const device of ["", "short", "x".repeat(65), "has space in it 123", 42, { a: 1 }]) {
    assert.deepEqual(await put(db, { ...(await encryptBackup(fixture)).body, device }), { status: 400, body: { error: "invalid" } }, JSON.stringify(device));
  }
  assert.equal(db.puts.size, 0, "a bad device is refused before the database");
  const seen = [];
  await handleTransferPut({ body: await withDevice(), ip: "203.0.113.5", origin: TAKE_ORIGIN },
    { secret: SECRET, put: async (_l, _iv, _ct, _ip, dev) => { seen.push(dev); return "stored"; } });
  assert.match(seen[0], /^[0-9a-f]{64}$/);
  assert.equal(seen[0], await deviceHash(SECRET, DEVICE));
  assert.notEqual(seen[0], await ipHash(SECRET, DEVICE), "a different domain prefix from the IP hash");
  await handleTransferPut({ body: (await encryptBackup(fixture)).body, ip: "203.0.113.5", origin: PUT_ORIGIN },
    { secret: SECRET, put: async (_l, _iv, _ct, _ip, dev) => { seen.push(dev); return "stored"; } });
  assert.equal(seen[1], null, "no device sent, none passed on");
});

test("shape checks and the body cap", async () => {
  const db = makeDb();
  assert.equal((await put(db, { lookup: "xyz", iv: "AAAA", ciphertext: "AAAA" })).status, 400);
  assert.equal((await put(db, { lookup: "a".repeat(64), iv: "***", ciphertext: "AAAA" })).status, 400);
  assert.equal((await put(db, null)).status, 400);
  assert.equal((await put(db, {}, { bodyBytes: MAX_BODY_BYTES + 1 })).status, 413);
  assert.equal((await take(db, { lookup: "A".repeat(64) })).status, 400, "the lookup is lower-case hex");
  assert.equal((await handleTransferPut({ body: {}, origin: PUT_ORIGIN }, { secret: "", put: db.put })).status, 500);
});

test("the database's answers map to HTTP: 429, 503, 409", async () => {
  const db = makeDb();
  for (let i = 0; i < 30; i++) assert.equal((await put(db, (await encryptBackup(fixture)).body)).status, 200);
  assert.deepEqual(await put(db, (await encryptBackup(fixture)).body), { status: 429, body: { error: "rate_limited" } });
  const full = makeDb();
  for (let i = 0; i < 40; i++) full.blobs.set("k" + i, { iv: "", ct: "", at: full.now });
  assert.deepEqual(await put(full, (await encryptBackup(fixture)).body), { status: 503, body: { error: "full" } });
  const dup = makeDb();
  const { body } = await encryptBackup(fixture);
  await put(dup, body);
  assert.equal((await put(dup, body, { ip: "203.0.113.9" })).status, 409);
  const takes = makeDb();
  for (let i = 0; i < 10; i++) await take(takes, { lookup: "b".repeat(64) });
  assert.equal((await take(takes, { lookup: "b".repeat(64) })).status, 429);
});

test("the IP is never stored, only an HMAC of it under the transfer domain", async () => {
  const seen = [];
  const { body } = await encryptBackup(fixture);
  await handleTransferPut({ body, ip: "203.0.113.5", origin: PUT_ORIGIN },
    { secret: SECRET, put: async (_l, _iv, _ct, ip) => { seen.push(ip); return "stored"; } });
  assert.match(seen[0], /^[0-9a-f]{64}$/);
  assert.equal(seen[0], await ipHash(SECRET, "203.0.113.5"));
  assert.notEqual(seen[0], await ipHash("another-secret", "203.0.113.5"));
});

test("the code is at least 100 bits and the lookup cannot be turned back into the key", async () => {
  const { code, lookup } = await encryptBackup(fixture);
  assert.ok(code.length * 8 >= 100);
  const again = await derive(code);
  assert.equal(again.lookup, lookup, "the same code always finds its blob");
  const other = await derive(crypto.getRandomValues(new Uint8Array(13)));
  assert.notEqual(other.lookup, lookup);
});

test("both functions are wired and need no session", () => {
  for (const [name, handler] of [["transfer-put", "handleTransferPut"], ["transfer-take", "handleTransferTake"]]) {
    const src = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
    assert.match(src, new RegExp(`${handler}\\(`));
    assert.match(src, /cf-connecting-ip/);
    assert.doesNotMatch(src, /Access-Control-Allow-Origin": "\*"/);
  }
  const toml = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(toml, /\[functions\.transfer-put\]\nverify_jwt = false/);
  assert.match(toml, /\[functions\.transfer-take\]\nverify_jwt = false/);
});
