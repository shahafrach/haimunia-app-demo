// The VAPID rotation workflow and the generator behind it.
//
// The whole point of .github/workflows/rotate-vapid.yml is that nobody - no
// person, no session, no log - ever sees the private key. A privacy property of
// a workflow file is exactly the kind that silently reverts in a later edit
// ("let me just print it to debug"), so it is pinned here by what the file may
// not contain, next to what it must.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createECDH } from "node:crypto";
import { generateVapidKeyPair, main } from "../scripts/generate-vapid-keys.mjs";
import { buildVapidAuth, b64urlToBytes, VAPID_SUBJECT } from "../supabase/functions/_shared/webPush.mjs";

const root = new URL("../", import.meta.url);
const wf = fs.readFileSync(new URL(".github/workflows/rotate-vapid.yml", root), "utf8");
// Everything that is not a comment: comments may talk about the private key.
const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("it is run by hand and by nothing else", () => {
  assert.match(code, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m,
    "a key rotation that something else can start is a rotation nobody chose");
  assert.match(code, /permissions:\s*\n\s+contents: read/, "read-only token");
});

test("every action is pinned to a commit SHA", () => {
  const uses = [...code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3, "checkout, setup-node and setup-cli at least");
  for (const ref of uses) assert.match(ref, /^[^@]+@[0-9a-f]{40}$/, `${ref} must be pinned to a full SHA`);
});

test("the only secret it reads is the existing SUPABASE_ACCESS_TOKEN, and the project ref comes from supabase/PROJECT_REF", () => {
  const secrets = [...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(secrets)], ["SUPABASE_ACCESS_TOKEN"]);
  assert.match(code, /supabase\/PROJECT_REF/);
  const ref = fs.readFileSync(new URL("supabase/PROJECT_REF", root), "utf8").trim();
  assert.ok(ref.length > 5);
  assert.ok(!code.includes(ref), "the project ref is read from the file, not copied into the workflow");
});

test("the pair is generated on the runner and set with --env-file, never on a command line", () => {
  assert.match(code, /node scripts\/generate-vapid-keys\.mjs --env-file "\$ENV_FILE"/);
  assert.match(code, /supabase secrets set --env-file "\$ENV_FILE" --project-ref "\$PROJECT_REF"/);
  assert.doesNotMatch(code, /VAPID_PRIVATE_KEY\s*=|\$\{?VAPID_PRIVATE/, "no runnable line assigns or expands the private key");
  assert.doesNotMatch(code, /secrets set[^\n]*VAPID_/, "no key=value argument on the command line");
  assert.match(code, /umask 077/);
});

test("nothing prints, uploads or caches the private key or the file that holds it", () => {
  assert.doesNotMatch(code, /\bcat\b[^\n]*(ENV_FILE|vapid\.env)/);
  assert.doesNotMatch(code, /\b(printenv|env\b\s*$|set -x|xtrace)/m);
  assert.doesNotMatch(code, /upload-artifact|actions\/cache|::add-mask|::debug/);
  assert.doesNotMatch(code, /echo[^\n]*\$\{?(ENV_FILE|PRIVATE\w*)/);
  // The CLI's own output is discarded, so an error cannot carry the key.
  assert.match(code, /secrets set[^\n]*>\/dev\/null 2>&1/);
});

test("the job summary carries the public key only, and the file is deleted even on failure", () => {
  assert.match(code, /echo "\$PUBLIC_KEY"/);
  const summary = code.slice(code.indexOf('echo "## VAPID key rotated"'), code.indexOf("GITHUB_STEP_SUMMARY"));
  assert.ok(summary.length > 100, "found the summary block");
  assert.doesNotMatch(summary, /\$\{?(ENV_FILE|PRIVATE\w*)|PRIVATE_KEY=/);
  assert.match(code, /if: always\(\)\s*\n\s+run: rm -f "\$RUNNER_TEMP\/vapid\.env"/);
});

test("it refuses to run without the token, before generating anything", () => {
  const token = code.indexOf('-z "$SUPABASE_ACCESS_TOKEN"');
  const gen = code.indexOf("generate-vapid-keys.mjs");
  assert.ok(token > -1 && gen > token);
});

// ---- the generator -------------------------------------------------------------

test("the generated pair is a P-256 pair in the shape PushManager and the sender expect", async () => {
  const pair = generateVapidKeyPair();
  const pub = b64urlToBytes(pair.publicKey);
  const prv = b64urlToBytes(pair.privateKey);
  assert.strictEqual(pub.length, 65);
  assert.strictEqual(pub[0], 0x04, "uncompressed point");
  assert.strictEqual(prv.length, 32);
  assert.match(pair.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.match(pair.privateKey, /^[A-Za-z0-9_-]{43}$/);
  // The public key really is the one derived from the private key.
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(prv));
  assert.strictEqual(ecdh.getPublicKey().toString("base64url"), pair.publicKey);
  // And the sender can sign with it, with the subject being a URL.
  const auth = await buildVapidAuth({ endpoint: "https://push.example/abc", subject: VAPID_SUBJECT, ...pair });
  assert.match(auth.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.notStrictEqual(generateVapidKeyPair().publicKey, pair.publicKey, "a new pair every time");
});

test("the CLI writes both keys to a private file and prints only the public key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vapid-"));
  const file = path.join(dir, "vapid.env");
  let out = "";
  const code0 = main(["--env-file", file], { write: (s) => { out += s; } });
  assert.strictEqual(code0, 0);
  const body = fs.readFileSync(file, "utf8");
  const [pubLine, prvLine] = body.trim().split("\n");
  const pub = pubLine.replace("VAPID_PUBLIC_KEY=", "");
  const prv = prvLine.replace("VAPID_PRIVATE_KEY=", "");
  assert.strictEqual(out.trim(), pub, "stdout is the public key");
  assert.ok(!out.includes(prv), "the private key never reaches stdout");
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => main(["--env-file", file], { write() {} }), /EEXIST/, "never overwrites a file");
  fs.rmSync(dir, { recursive: true });
});

test("the CLI needs --env-file and prints nothing without it", () => {
  let out = "";
  const origErr = process.stderr.write;
  process.stderr.write = () => true;
  try { assert.strictEqual(main([], { write: (s) => { out += s; } }), 2); } finally { process.stderr.write = origErr; }
  assert.strictEqual(out, "");
});
