// Writes the two Vault secrets the scheduled Edge Function jobs need, without
// anyone seeing the service_role key.
//
//   node scripts/set-vault-secrets.mjs --ref <project-ref> --result <path>
//   SUPABASE_ACCESS_TOKEN must be in the environment.
//
// It is the body of .github/workflows/set-vault-secrets.yml:
//   1. fetches the service_role key from the Management API (api-keys,
//      reveal=true) into memory and, as the very next thing it does, prints the
//      `::add-mask::` command so the runner redacts it from every later log
//      line;
//   2. updates the existing Vault rows `edge_functions_base_url` and
//      `edge_functions_service_role_key` with vault.update_secret (creates them
//      only if missing), through the database query endpoint. The key travels
//      in the JSON request body and nowhere else; it is never put in an
//      argument, a URL, a file or a logged string. The key is checked against
//      the JWT alphabet first, so it cannot break out of the SQL literal;
//   3. verifies WITHOUT revealing: asks Postgres whether each secret exists
//      and is no longer its placeholder, and writes only those two booleans
//      (JSON) to --result. stdout carries nothing but the ::add-mask:: command.
// Every response body that could contain the key is discarded unread; an error
// reports a status code and a step name, never a body.
//
// Exits 0 only when both booleans are true. Nothing here touches the repository.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.supabase.com";
const BASE_NAME = "edge_functions_base_url";
const KEY_NAME = "edge_functions_service_role_key";
const BASE_PLACEHOLDER = "PROJECT-REF-NOT-SET";
const KEY_PLACEHOLDER = "SERVICE-ROLE-KEY-NOT-SET";

export function baseUrlFor(ref) {
  return `https://${ref}.supabase.co/functions/v1`;
}

// vault.update_secret on the existing row; vault.create_secret only if missing.
// `value` must already be validated: it is placed inside a dollar-quoted literal.
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
    where name = '${KEY_NAME}' and decrypted_secret <> '${KEY_PLACEHOLDER}')
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
  const entry = Array.isArray(keys) ? keys.find((k) => k && k.name === "service_role") : null;
  const key = entry && typeof entry.api_key === "string" ? entry.api_key : "";
  // Mask before anything else touches the value.
  if (key) out.write(`::add-mask::${key}\n`);
  if (!/^[A-Za-z0-9._-]{20,}$/.test(key)) {
    process.stderr.write("no usable service_role key in the api-keys response\n");
    return 1;
  }

  try {
    await query(fetchImpl, token, ref,
      upsertSql(BASE_NAME, baseUrlFor(ref), "Base URL for this project''s Edge Functions, WITHOUT a trailing slash."),
      "write base url");
    await query(fetchImpl, token, ref,
      upsertSql(KEY_NAME, key, "The service_role key the scheduled Edge Function calls authenticate with."),
      "write service role key");
    const res = await query(fetchImpl, token, ref, VERIFY_SQL, "verify");
    const rows = await res.json();
    const r = rows?.[0]?.result ?? {};
    const result = { base_url_set: r.base_url_set === true, service_role_key_set: r.service_role_key_set === true };
    writeFileSync(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    return result.base_url_set && result.service_role_key_set ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
