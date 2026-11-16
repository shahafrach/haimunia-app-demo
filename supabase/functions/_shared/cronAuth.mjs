// Who may call the scheduled Edge Functions (notif_push_send, purge_abandoned_profiles). F-023, 202611160001.
//
// The cron calls (public.cron_invoke_edge_function) authenticate with a dedicated random secret,
// EDGE_CRON_SECRET: written once by .github/workflows/set-vault-secrets.yml both to the Vault
// (edge_functions_cron_secret) and to this project's Edge Function secrets, so the two cannot drift the way
// the service_role key did (from about 2026-11-13 every cron call answered 401, because the key in the Vault
// and the key the functions hold were no longer the same value).
//
// The service_role key is still accepted, for a manual ops call and for the fallback the SQL keeps while the
// cron secret is unset. Both comparisons are constant-time: a plain === short-circuits at the first
// differing byte, which is a timing channel for recovering either value (SEC-017).
//
// Plain JavaScript so node --test can exercise it (test/edge-cron-secret.test.mjs). Nothing here logs.

/** Constant-shape comparison of two strings. */
export function timingSafeEqualStrings(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(String(a));
  const bBytes = enc.encode(String(b));
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  return diff === 0;
}

// A cron secret shorter than this is treated as unset: a typo or an empty value must never be a password.
export const MIN_CRON_SECRET_LENGTH = 32;

/**
 * True when the Authorization header is "Bearer <EDGE_CRON_SECRET>" (when that secret is set and long
 * enough) or "Bearer <service_role key>". Both are always compared, so the time taken does not say which
 * one is configured.
 * @param {string|null} authorization the request's Authorization header
 * @param {{ cronSecret?: string|null, serviceRoleKey?: string|null }} secrets
 */
export function isScheduledCaller(authorization, secrets) {
  const header = typeof authorization === "string" ? authorization : "";
  const cron = typeof secrets?.cronSecret === "string" && secrets.cronSecret.length >= MIN_CRON_SECRET_LENGTH ? secrets.cronSecret : "";
  const service = typeof secrets?.serviceRoleKey === "string" ? secrets.serviceRoleKey : "";
  const cronOk = timingSafeEqualStrings(header, `Bearer ${cron || "\u0000unset-cron-secret"}`) && cron !== "";
  const serviceOk = timingSafeEqualStrings(header, `Bearer ${service || "\u0000unset-service-key"}`) && service !== "";
  return cronOk || serviceOk;
}
