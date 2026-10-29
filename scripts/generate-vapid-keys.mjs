// Generates a VAPID key pair for Web Push (RFC 8292) without ever printing the
// private half.
//
//   node scripts/generate-vapid-keys.mjs --out <path>
//
// The flag is --out, not --env-file: Node 22 reads --env-file as its OWN
// option even after the script name, tries to load <path> as a dotenv file
// before the script runs, and exits 9 when it does not exist yet. That is how
// the first rotate-vapid run failed (2026-10-28), before generating anything.
//
// writes VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to <path> (mode 0600, refuses
// to overwrite) and prints ONLY the public key on stdout. It is the first half
// of .github/workflows/rotate-vapid.yml: the pair is made on the runner, goes
// to the Supabase Edge Function secrets through `supabase secrets set
// --env-file`, and nobody - no person, no session, no log - sees the private
// key. Nothing here reads or writes the repository.
//
// Both keys are base64url. The public key is the uncompressed P-256 point
// (0x04 || X || Y, 65 bytes), which is what PushManager.subscribe wants as
// applicationServerKey; the private key is the 32-byte scalar d.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function b64urlToBuffer(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function generateVapidKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const prv = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([0x04]), b64urlToBuffer(pub.x), b64urlToBuffer(pub.y)]);
  return {
    publicKey: point.toString("base64url"),
    privateKey: b64urlToBuffer(prv.d).toString("base64url"),
  };
}

// The file body, and nothing else that could hold the private key.
export function envFileBody(pair) {
  return `VAPID_PUBLIC_KEY=${pair.publicKey}\nVAPID_PRIVATE_KEY=${pair.privateKey}\n`;
}

export function main(argv, out = process.stdout) {
  const i = argv.indexOf("--out");
  const file = i >= 0 ? argv[i + 1] : "";
  if (!file) {
    process.stderr.write("usage: generate-vapid-keys.mjs --out <path>\n");
    return 2;
  }
  const pair = generateVapidKeyPair();
  // flag "wx": never overwrite an existing file, and mode 0600 so only the
  // runner user can read it.
  writeFileSync(file, envFileBody(pair), { flag: "wx", mode: 0o600 });
  out.write(pair.publicKey + "\n");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = main(process.argv.slice(2));
}
