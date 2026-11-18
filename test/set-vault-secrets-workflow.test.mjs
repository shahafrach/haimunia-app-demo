// The Vault-secrets workflow and the helper behind it.
//
// Like rotate-vapid, the point is that nobody - no person, no session, no log -
// sees the service_role key. That property silently reverts in a later edit, so
// it is pinned here by what the files may not contain, and the helper is run as
// a real process against a local fake of the Management API.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { main, baseUrlFor, VERIFY_SQL } from "../scripts/set-vault-secrets.mjs";

const root = new URL("../", import.meta.url);
const wf = fs.readFileSync(new URL(".github/workflows/set-vault-secrets.yml", root), "utf8");
const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const helper = fs.readFileSync(new URL("scripts/set-vault-secrets.mjs", root), "utf8");
const helperCode = helper.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXNpZ25hdHVyZS0xMjM0";

test("it is run by hand and by nothing else, with a read-only token", () => {
  assert.match(code, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(code, /permissions:\s*\n\s+contents: read/);
});

test("every action is pinned to a commit SHA", () => {
  const uses = [...code.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const ref of uses) assert.match(ref, /^[^@]+@[0-9a-f]{40}$/, `${ref} must be pinned to a full SHA`);
});

test("the only secret read is SUPABASE_ACCESS_TOKEN; the ref comes from supabase/PROJECT_REF; it refuses without the token first", () => {
  const secrets = [...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(secrets)], ["SUPABASE_ACCESS_TOKEN"]);
  assert.match(code, /supabase\/PROJECT_REF/);
  const ref = fs.readFileSync(new URL("supabase/PROJECT_REF", root), "utf8").trim();
  assert.ok(!code.includes(ref) && !helper.includes(ref));
  const token = code.indexOf('-z "$SUPABASE_ACCESS_TOKEN"');
  assert.ok(token > -1 && code.indexOf("set-vault-secrets.mjs") > token);
});

test("nothing prints, uploads, caches or summarises the key", () => {
  assert.doesNotMatch(code, /\b(printenv|set -x|xtrace)|env\s*$/m);
  assert.match(code, /set \+x/);
  assert.doesNotMatch(code, /upload-artifact|actions\/cache|::debug|tee\b|--debug|curl|\bjq\b/);
  assert.doesNotMatch(code, /echo[^\n]*\$\{?\w*(KEY|SERVICE|TOKEN)/i);
  // The summary block holds the project ref and the result file, nothing else.
  const summary = code.slice(code.indexOf('echo "## Vault secrets"'), code.indexOf("GITHUB_STEP_SUMMARY"));
  assert.ok(summary.length > 100);
  assert.doesNotMatch(summary, /\$\{?(KEY|SERVICE|SUPABASE_ACCESS_TOKEN)/i);
  assert.match(summary, /cat "\$RESULT_FILE"/);
  // stdout must reach the runner so ::add-mask:: takes effect: not piped or redirected.
  assert.doesNotMatch(code.replace(/\|\|/g, ""), /set-vault-secrets\.mjs[^\n]*(\||>)/);
  // The helper logs no key and no response body.
  assert.doesNotMatch(helperCode, /console\./);
  assert.doesNotMatch(helperCode.replace(/.*::add-mask::.*/, ""), /(write|Error)\([^\n]*(\$\{(key|entry)\b|\bkey\)|await res\.text)/);
  assert.doesNotMatch(helperCode, /\.text\(\)/);
});

test("the helper masks the key before using it and passes it only in a JSON body", () => {
  assert.ok(helperCode.indexOf("::add-mask::") > -1);
  assert.ok(helperCode.indexOf("::add-mask::") < helperCode.indexOf("upsertSql(KEY_NAME"));
  assert.match(helperCode, /body: JSON\.stringify\(\{ query: sql \}\)/);
  assert.match(helperCode, /api-keys\?reveal=true/);
  assert.match(helperCode, /vault\.update_secret/);
  assert.doesNotMatch(helperCode, /\?[^`'"]*\$\{key\}/, "never in a URL");
  assert.equal(baseUrlFor("abcdef"), "https://abcdef.supabase.co/functions/v1");
  assert.doesNotMatch(VERIFY_SQL, /select\s+decrypted_secret/, "verification returns booleans, not values");
});

// ---- the helper as a real process -------------------------------------------

// A fake Management API with state: the Vault rows the helper writes, the Edge Function secrets (listed, as
// the real API does, by the SHA-256 digest of each value), and the revealed API keys.
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
function fakeApi({ keys = [{ name: "service_role", api_key: KEY }], verify = null, failWrite = false, vault = {}, fnSecrets = { SUPABASE_SERVICE_ROLE_KEY: KEY } } = {}) {
  const seen = [];
  const state = { vault: { ...vault }, fn: { ...fnSecrets } };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/api-keys")) return res.end(JSON.stringify(keys));
      if (req.url.endsWith("/secrets") && req.method === "GET") {
        return res.end(JSON.stringify(Object.entries(state.fn).map(([name, v]) => ({ name, value: sha(v) }))));
      }
      if (req.url.endsWith("/secrets") && req.method === "POST") {
        for (const { name, value } of JSON.parse(body)) state.fn[name] = value;
        res.statusCode = 201; return res.end("{}");
      }
      if (failWrite && body.includes("update_secret")) { res.statusCode = 500; return res.end(JSON.stringify({ message: body })); }
      const q = body ? JSON.parse(body).query : "";
      const w = q.match(/where name = '([a-z_]+)'\) then\n\s+perform vault\.update_secret\(\(select id from vault\.secrets where name = '[a-z_]+'\), '([^']*)'\)/);
      if (w) { state.vault[w[1]] = w[2]; return res.end("[]"); }
      if (q.includes("extensions.digest")) {
        const p = (n) => (state.vault[n] === undefined ? null : sha(state.vault[n]).slice(0, 8));
        return res.end(JSON.stringify([{ result: { service_role_key: p("edge_functions_service_role_key"), cron_secret: p("edge_functions_cron_secret") } }]));
      }
      if (q.includes("jsonb_build_object")) {
        const v = state.vault;
        return res.end(JSON.stringify([{ result: verify ?? {
          base_url_set: !!v.edge_functions_base_url, service_role_key_set: !!v.edge_functions_service_role_key,
          cron_secret_set: (v.edge_functions_cron_secret || "").length >= 32 } }]));
      }
      res.end("[]");
    });
  });
  return { server, seen, state };
}

// A preload that redirects https://api.supabase.com to the fake, so the real
// script runs unmodified in a real process.
function run(port, resultFile, extra = {}) {
  const preload = path.join(path.dirname(resultFile), "redirect.mjs");
  fs.writeFileSync(preload, `const f = globalThis.fetch;
globalThis.fetch = (u, o) => f(String(u).replace("https://api.supabase.com", "http://127.0.0.1:${port}"), o);\n`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", preload, "scripts/set-vault-secrets.mjs", "--ref", "abcdefghij", "--result", resultFile],
      { cwd: new URL("../", import.meta.url), env: { ...process.env, SUPABASE_ACCESS_TOKEN: "sbp_test", ...extra } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (status) => resolve({ status, out, err }));
  });
}

async function withFake(opts, fn) {
  const { server, seen, state } = fakeApi(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  try { await fn(server.address().port, path.join(dir, "result.json"), seen, state); }
  finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("as a real process: masks first, writes every secret, prints only masks, the result holds booleans and hash prefixes", async () => {
  await withFake({}, async (port, resultFile, seen, state) => {
    const r = await run(port, resultFile);
    assert.equal(r.status, 0, r.err);
    const lines = r.out.trim().split("\n");
    assert.ok(lines.every((l) => l.startsWith("::add-mask::")), "stdout is mask commands and nothing else");
    assert.equal(lines[0], `::add-mask::${KEY}`, "the key is masked first");
    const cron = state.fn.EDGE_CRON_SECRET;
    assert.match(cron, /^[0-9a-f]{64}$/, "a fresh 32-byte random cron secret");
    assert.ok(lines.includes(`::add-mask::${cron}`), "and it is masked too");
    assert.equal(state.vault.edge_functions_cron_secret, cron, "the Vault and the functions hold the same cron secret");
    const text = fs.readFileSync(resultFile, "utf8");
    for (const v of [KEY, cron]) assert.ok(!r.err.includes(v) && !text.includes(v), "no value in stderr or the result");
    const result = JSON.parse(text);
    assert.equal(result.base_url_set, true);
    assert.equal(result.service_role_key_set, true);
    assert.equal(result.cron_secret_set, true);
    assert.equal(result.cron_secret_matches_functions, true);
    // Every string in the diagnosis is an 8-hex prefix or a key name.
    const strings = JSON.stringify(result.diagnosis_before).match(/"[^"]*"/g).map((x) => x.slice(1, -1));
    for (const v of strings) assert.ok(/^[0-9a-f]{8}$/.test(v) || /^[A-Za-z_-]+$/.test(v), `unexpected value in the result: ${v}`);
    assert.ok(seen.every((x) => !x.url.includes(KEY) && !x.url.includes(cron)), "no value in a URL");
    const post = seen.findIndex((x) => x.method === "POST" && x.url.endsWith("/secrets"));
    const vaultCron = seen.findIndex((x) => x.body.includes("edge_functions_cron_secret") && x.body.includes("update_secret"));
    assert.ok(post > -1 && vaultCron > post, "the functions' copy is written first, then the Vault's");
    assert.ok(seen.filter((x) => x.url.endsWith("/database/query")).every((q) => q.auth === "Bearer sbp_test"));
  });
});

test("as a real process: the diagnosis says which key the functions hold, by hash prefix only (F-023)", async () => {
  const NEW = "sb_secret_" + "n".repeat(40);
  await withFake({
    keys: [{ name: "service_role", api_key: KEY }, { name: "default", type: "secret", api_key: NEW }],
    vault: { edge_functions_service_role_key: KEY },
    fnSecrets: { SUPABASE_SERVICE_ROLE_KEY: NEW },
  }, async (port, resultFile) => {
    const r = await run(port, resultFile);
    assert.equal(r.status, 0, r.err);
    const d = JSON.parse(fs.readFileSync(resultFile, "utf8")).diagnosis_before;
    assert.equal(d.legacy_service_role, sha(KEY).slice(0, 8));
    assert.deepStrictEqual(d.new_secret_keys, { default: sha(NEW).slice(0, 8) });
    assert.equal(d.vault.service_role_key, sha(KEY).slice(0, 8));
    assert.equal(d.functions.SUPABASE_SERVICE_ROLE_KEY, sha(NEW).slice(0, 8));
    assert.equal(d.vault_key_is_legacy_key, true);
    assert.equal(d.functions_key_is_legacy_key, false, "the mismatch behind the 401s is visible");
    assert.equal(d.functions_key_is_a_new_secret_key, true);
    assert.ok(!r.out.replace(/::add-mask::[^\n]*\n/g, "").length, "stdout holds masks only");
    assert.ok(r.out.includes(`::add-mask::${NEW}`), "the new secret key is masked as well");
  });
});

test("as a real process: a response body that echoes the key never reaches stdout or stderr", async () => {
  await withFake({ failWrite: true }, async (port, resultFile) => {
    const r = await run(port, resultFile);
    assert.equal(r.status, 1);
    assert.ok(!r.err.includes(KEY) && !r.out.replace(`::add-mask::${KEY}\n`, "").includes(KEY));
    assert.match(r.err, /write base url: HTTP 500/);
    assert.ok(!fs.existsSync(resultFile));
  });
});

test("as a real process: a secret still a placeholder fails the run", async () => {
  await withFake({ verify: { base_url_set: true, service_role_key_set: false, cron_secret_set: true } }, async (port, resultFile) => {
    const r = await run(port, resultFile);
    assert.equal(r.status, 1);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(result.service_role_key_set, false);
  });
});

test("as a real process: if the functions' cron secret cannot be written, the Vault copy is not touched and the run fails", async () => {
  const { server, seen, state } = fakeApi({});
  const orig = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (req.method === "POST" && req.url.endsWith("/secrets")) { res.statusCode = 403; return res.end(JSON.stringify({ message: "forbidden" })); }
    return orig(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  try {
    const r = await run(server.address().port, path.join(dir, "result.json"));
    assert.equal(r.status, 1);
    assert.match(r.err, /write EDGE_CRON_SECRET: HTTP 403/);
    assert.equal(state.vault.edge_functions_cron_secret, undefined, "the Vault still holds its placeholder");
    assert.ok(!seen.some((x) => x.body.includes("edge_functions_cron_secret') then")), "no cron write was sent to the Vault");
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("as a real process: no service_role key, an unsafe key, or no token writes nothing", async () => {
  await withFake({ keys: [{ name: "anon", api_key: "x".repeat(40) }] }, async (port, resultFile, seen) => {
    assert.equal((await run(port, resultFile)).status, 1);
    assert.equal(seen.filter((s) => s.url.endsWith("/database/query")).length, 0);
  });
  await withFake({ keys: [{ name: "service_role", api_key: "a".repeat(30) + "'; drop table x;--" }] }, async (port, resultFile, seen) => {
    assert.equal((await run(port, resultFile)).status, 1);
    assert.equal(seen.filter((s) => s.url.endsWith("/database/query")).length, 0);
  });
  assert.equal(await main(["--ref", "abcdefghij", "--result", "x"], {}, async () => { throw new Error("no network"); }, { write() {} }), 2);
});
