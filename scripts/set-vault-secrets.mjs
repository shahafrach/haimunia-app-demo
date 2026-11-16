// Writes the Vault secrets and the Edge Function secret the scheduled Edge Function jobs need, without anyone
// seeing a key.
//
//   node scripts/set-vault-secrets.mjs --ref <project-ref> --result <path>
//   SUPABASE_ACCESS_TOKEN must be in the environment.
//
// It is the body of .github/workflows/set-vault-secrets.yml:
//   1. fetches the project's API keys from the Management API (api-keys, reveal=true) into memory and, as the
//      very next thing it does, prints an `::add-mask::` command for every key value so the runner redacts
//      them from every later log line;
//   2. DIAGNOSIS, read-only (F-023): compares what the Vault holds, what the Management API says the keys are,
//      and what the Edge Functions hold (the Management API's secrets list), by the first 8 hex characters
//      of each value's SHA-256 and nothing else. A key is never printed, logged or written; only those
//      prefixes and the booleans "these two are the same" reach --result;
//   3. updates the Vault rows `edge_functions_base_url` and `edge_functions_service_role_key` with
//      vault.update_secret (creates them only if missing), through the database query endpoint;
//   4. F-023, 202611160001: generates a new random cron secret (32 bytes, hex), masks it, and writes it as the
//      Edge Function secret EDGE_CRON_SECRET (secrets endpoint) and as the Vault secret
//      `edge_functions_cron_secret`, in that order. The scheduled calls authenticate with it from then on, so
//      the value the cron sends and the value the functions check are written by the same run and cannot
//      drift apart the way the service_role key did;
//   5. verifies WITHOUT revealing: Postgres says whether each secret exists and is no longer its placeholder,
//      and the cron secret's hash prefix in the Vault is compared with the functions' copy.
// Every value travels in a JSON request body and nowhere else; never in an argument, a URL, a file or a
// logged string. Every response body that could hold a key is read as JSON, used, and discarded; an error
// reports a status code and a step name, never a body.
//
// Exits 0 only when the base URL, the service_role key and the cron secret are set and the cron secret's
// two copies match. Nothing here touches the repository.
import { writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const API = "https://api.supabase.com";
const BASE_NAME = "edge_functions_base_url";
const KEY_NAME = "edge_functions_service_role_key";
const CRON_NAME = "edge_functions_cron_secret";
const CRON_FUNCTION_SECRET = "EDGE_CRON_SECRET";
const BASE_PLACEHOLDER = "PROJECT-REF-NOT-SET";
const KEY_PLACEHOLDER = "SERVICE-ROLE-KEY-NOT-SET";
const CRON_PLACEHOLDER = "CRON-SECRET-NOT-SET";

export function baseUrlFor(ref) {
  return `https://${ref}.supabase.co/functions/v1`;
}

/** The first 8 hex characters of a value's SHA-256: enough to tell two values apart, useless for recovering one. */
export function hashPrefix(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 8);
}

// vault.update_secret on the existing row; vault.create_secret only if missing.
// `value` must already be validated: it is placed inside a quoted literal.
function upsertSql(name, value, description) {
  return `do $vault$
begin
  if exists (select 1 from vault.secrets where name = '${name}') then
    perform vault.update_secret((select id from vault.secrets where name = '${name}'), '${value}');
  else
    perform vault.create_secret('${value}', '${name}', '${description}');
  end if;
end $vault$;`;
}

export const VERIFY_SQL = `select jsonb_build_object(
  'base_url_set', exists (select 1 from vault.decrypted_secrets
    where name = '${BASE_NAME}' and decrypted_secret not like '%${BASE_PLACEHOLDER}%'),
  'service_role_key_set', exists (select 1 from vault.decrypted_secrets
    where name = '${KEY_NAME}' and decrypted_secret <> '${KEY_PLACEHOLDER}'),
  'cron_secret_set', exists (select 1 from vault.decrypted_secrets
    where name = '${CRON_NAME}' and decrypted_secret <> '${CRON_PLACEHOLDER}' and length(decrypted_secret) >= 32)
) as result;`;

// Hash prefixes of what the Vault holds, computed in Postgres: the values never leave the database.
export const VAULT_PREFIX_SQL = `select jsonb_build_object(
  'service_role_key', (select left(encode(extensions.digest(convert_to(decrypted_secret, 'UTF8'), 'sha256'), 'hex'), 8)
    from vault.decrypted_secrets where name = '${KEY_NAME}'),
  'cron_secret', (select left(encode(extensions.digest(convert_to(decrypted_secret, 'UTF8'), 'sha256'), 'hex'), 8)
    from vault.decrypted_secrets where name = '${CRON_NAME}')
) as result;`;

async function query(fetchImpl, token, ref, sql, step) {
  const res = await fetchImpl(`${API}/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new Error(`${step}: HTTP ${res.status}`);
  }
  return res;
}

// The Edge Function secrets as the Management API lists them. Its `value` is normally the SHA-256 digest of
// the secret (what `supabase secrets list` shows); if it is ever the value itself, it is masked first and
// hashed here, so either way only a prefix is kept.
async function functionSecretPrefixes(fetchImpl, token, ref, out, names) {
  const res = await fetchImpl(`${API}/v1/projects/${ref}/secrets`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { await res.body?.cancel?.(); return { listed: false }; }
  const list = await res.json();
  const found = { listed: true };
  for (const name of names) {
    const row = Array.isArray(list) ? list.find((s) => s && s.name === name) : null;
    const v = row && typeof row.value === "string" ? row.value : null;
    if (v === null) { found[name] = null; continue; }
    if (/^[0-9a-f]{64}$/.test(v)) { found[name] = v.slice(0, 8); continue; }
    out.write(`::add-mask::${v}\n`);
    found[name] = hashPrefix(v);
  }
  return found;
}

async function vaultPrefixes(fetchImpl, token, ref) {
  try {
    const res = await query(fetchImpl, token, ref, VAULT_PREFIX_SQL, "vault prefixes");
    const rows = await res.json();
    const r = rows?.[0]?.result ?? {};
    const ok = (p) => (typeof p === "string" && /^[0-9a-f]{8}$/.test(p) ? p : null);
    return { service_role_key: ok(r.service_role_key), cron_secret: ok(r.cron_secret) };
  } catch (e) {
    return { service_role_key: null, cron_secret: null, error: e.message };
  }
}

const same = (a, b) => (a && b ? a === b : null);

export async function main(argv, env = process.env, fetchImpl = fetch, out = process.stdout) {
  const i = argv.indexOf("--ref");
  const ref = i >= 0 ? argv[i + 1] : "";
  const j = argv.indexOf("--result");
  const resultFile = j >= 0 ? argv[j + 1] : "";
  const token = env.SUPABASE_ACCESS_TOKEN || "";
  if (!/^[a-z0-9]{6,40}$/.test(ref || "") || !token || !resultFile) {
    process.stderr.write("usage: SUPABASE_ACCESS_TOKEN=... set-vault-secrets.mjs --ref <project-ref> --result <path>\n");
    return 2;
  }

  const keysRes = await fetchImpl(`${API}/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!keysRes.ok) {
    await keysRes.body?.cancel?.();
    process.stderr.write(`fetch service_role key: HTTP ${keysRes.status}\n`);
    return 1;
  }
  const keys = await keysRes.json();
  const list = Array.isArray(keys) ? keys.filter((k) => k && typeof k.api_key === "string" && k.api_key) : [];
  // Mask every revealed value before anything else touches one.
  for (const k of list) out.write(`::add-mask::${k.api_key}\n`);
  const entry = list.find((k) => k.name === "service_role");
  const key = entry ? entry.api_key : "";
  if (!/^[A-Za-z0-9._-]{20,}$/.test(key)) {
    process.stderr.write("no usable service_role key in the api-keys response\n");
    return 1;
  }

  // ---- 2. Diagnosis (read-only). Prefixes of hashes, never values. ----
  const secretKeys = {};
  for (const k of list) {
    if (k.name !== "service_role" && (k.type === "secret" || /^sb_secret_/.test(k.api_key))) {
      secretKeys[String(k.name || k.id || "secret").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)] = hashPrefix(k.api_key);
    }
  }
  const before = {
    legacy_service_role: hashPrefix(key),
    new_secret_keys: secretKeys,
    vault: await vaultPrefixes(fetchImpl, token, ref),
    functions: await functionSecretPrefixes(fetchImpl, token, ref, out, ["SUPABASE_SERVICE_ROLE_KEY", CRON_FUNCTION_SECRET]),
  };
  before.vault_key_is_legacy_key = same(before.vault.service_role_key, before.legacy_service_role);
  before.functions_key_is_legacy_key = same(before.functions.SUPABASE_SERVICE_ROLE_KEY, before.legacy_service_role);
  before.functions_key_is_a_new_secret_key = before.functions.SUPABASE_SERVICE_ROLE_KEY
    ? Object.values(secretKeys).includes(before.functions.SUPABASE_SERVICE_ROLE_KEY) : null;

  const cron = randomBytes(32).toString("hex");
  out.write(`::add-mask::${cron}\n`);

  try {
    await query(fetchImpl, token, ref,
      upsertSql(BASE_NAME, baseUrlFor(ref), "Base URL for this project''s Edge Functions, WITHOUT a trailing slash."),
      "write base url");
    await query(fetchImpl, token, ref,
      upsertSql(KEY_NAME, key, "The service_role key the scheduled Edge Function calls authenticate with."),
      "write service role key");

    // ---- 4. The cron secret: the functions' copy first, then the Vault's. ----
    const setRes = await fetchImpl(`${API}/v1/projects/${ref}/secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ name: CRON_FUNCTION_SECRET, value: cron }]),
    });
    if (!setRes.ok) {
      await setRes.body?.cancel?.();
      throw new Error(`write ${CRON_FUNCTION_SECRET}: HTTP ${setRes.status}`);
    }
    await setRes.body?.cancel?.();
    await query(fetchImpl, token, ref,
      upsertSql(CRON_NAME, cron, "The random secret the scheduled Edge Function calls authenticate with (202611160001)."),
      "write cron secret");

    // ---- 5. Verify. ----
    const res = await query(fetchImpl, token, ref, VERIFY_SQL, "verify");
    const rows = await res.json();
    const r = rows?.[0]?.result ?? {};
    const vaultAfter = await vaultPrefixes(fetchImpl, token, ref);
    const fnAfter = await functionSecretPrefixes(fetchImpl, token, ref, out, [CRON_FUNCTION_SECRET]);
    const expected = hashPrefix(cron);
    const result = {
      base_url_set: r.base_url_set === true,
      service_role_key_set: r.service_role_key_set === true,
      cron_secret_set: r.cron_secret_set === true,
      cron_secret_matches_functions: vaultAfter.cron_secret === expected && fnAfter[CRON_FUNCTION_SECRET] === expected,
      diagnosis_before: before,
    };
    writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result.base_url_set && result.service_role_key_set && result.cron_secret_set && result.cron_secret_matches_functions ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
