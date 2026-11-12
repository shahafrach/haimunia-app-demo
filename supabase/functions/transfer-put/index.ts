// transfer-put: POST { lookup, iv, ciphertext } from the old Haimunia app
// (https://haimuniya.github.io) -> { status: "stored" }. One encrypted backup,
// kept at most 24 hours, deleted on the first take (docs/club/research.md, D).
// No account exists on either side of a transfer, so the gateway's JWT check is
// off (supabase/config.toml) and every rule is in ../_shared/transfer.mjs and the
// database function transfer_put (202611120001).
//
// Secrets: RECOVERY_CODE_HMAC_SECRET, used here only to hash the caller's IP
// under the transfer domain prefix. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are injected by the runtime.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleTransferPut, corsHeaders, PUT_ORIGIN } from "../_shared/transfer.mjs";

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(PUT_ORIGIN);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("RECOVERY_CODE_HMAC_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !secret) return reply(500, { error: "not_configured" });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const declared = Number(req.headers.get("content-length") || "0");
  let body: unknown = null;
  let bodyBytes = declared;
  try {
    const text = await req.text();
    bodyBytes = Math.max(declared, text.length);
    body = JSON.parse(text);
  } catch { /* the handler treats a missing body as invalid */ }
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

  const out = await handleTransferPut({ body, ip, origin: req.headers.get("origin"), bodyBytes }, {
    secret,
    put: async (lookupHash: string, ivB64: string, ciphertextB64: string, ipHash: string) => {
      const { data, error } = await supabase.rpc("transfer_put", {
        p_lookup_hash: lookupHash, p_iv_b64: ivB64, p_ciphertext_b64: ciphertextB64, p_ip_hash: ipHash,
      });
      if (error) throw error;
      return String(data);
    },
  }).catch((e: unknown) => {
    console.error("transfer-put failed", e instanceof Error ? e.message : "unknown");
    return { status: 500, body: { error: "failed" } };
  });
  return reply(out.status, out.body);
});
