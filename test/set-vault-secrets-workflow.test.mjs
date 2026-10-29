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

function fakeApi({ keys = [{ name: "service_role", api_key: KEY }], verify = { base_url_set: true, service_role_key_set: true }, failWrite = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/api-keys")) return res.end(JSON.stringify(keys));
      if (failWrite && body.includes("update_secret")) { res.statusCode = 500; return res.end(JSON.stringify({ message: body })); }
      if (body.includes("jsonb_build_object")) return res.end(JSON.stringify([{ result: verify }]));
      res.end("[]");
    });
  });
  return { server, seen };
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
  const { server, seen } = fakeApi(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  try { await fn(server.address().port, path.join(dir, "result.json"), seen); }
  finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("as a real process: masks first, writes both secrets, prints only the mask, result holds only booleans", async () => {
  await withFake({}, async (port, resultFile, seen) => {
    const r = await run(port, resultFile);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, `::add-mask::${KEY}\n`, "stdout is the mask command and nothing else");
    assert.ok(!r.err.includes(KEY));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), { base_url_set: true, service_role_key_set: true });
    assert.ok(!fs.readFileSync(resultFile, "utf8").includes(KEY));
    const queries = seen.filter((s) => s.url.endsWith("/database/query"));
    assert.equal(queries.length, 3);
    assert.ok(queries.every((q) => q.auth === "Bearer sbp_test"));
    assert.ok(queries[0].body.includes("https://abcdefghij.supabase.co/functions/v1"));
    assert.ok(queries[1].body.includes(KEY) && queries[1].body.includes("vault.update_secret"));
    assert.ok(seen.every((s) => !s.url.includes(KEY)), "the key is never in a URL");
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
  await withFake({ verify: { base_url_set: true, service_role_key_set: false } }, async (port, resultFile) => {
    const r = await run(port, resultFile);
    assert.equal(r.status, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), { base_url_set: true, service_role_key_set: false });
  });
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
