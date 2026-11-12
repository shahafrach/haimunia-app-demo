// transfer-take: POST { lookup } from the new Haimunia club app
// (https://haimunia.pages.dev) -> { iv, ciphertext }, once. The row is deleted in
// the same statement that returns it, so a second take finds nothing
// (docs/club/research.md, D). No account is involved, so the gateway's JWT check
// is off (supabase/config.toml) and every rule is in ../_shared/transfer.mjs and
// the database function transfer_take (202611120001).
//
// Secrets: RECOVERY_CODE_HMAC_SECRET, used here only to hash the caller's IP
// under the transfer domain prefix. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are injected by the runtime.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleTransferTake, corsHeaders, TAKE_ORIGIN } from "../_shared/transfer.mjs";

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(TAKE_ORIGIN);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("RECOVERY_CODE_HMAC_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !secret) return reply(500, { error: "not_configured" });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: unknown = null;
  try { body = await req.json(); } catch { /* the handler treats a missing body as invalid */ }
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

  const out = await handleTransferTake({ body, ip, origin: req.headers.get("origin") }, {
    secret,
    take: async (lookupHash: string, ipHash: string) => {
      const { data, error } = await supabase.rpc("transfer_take", { p_lookup_hash: lookupHash, p_ip_hash: ipHash });
      if (error) throw error;
      return data as { status: string; iv?: string; ciphertext?: string };
    },
  }).catch((e: unknown) => {
    console.error("transfer-take failed", e instanceof Error ? e.message : "unknown");
    return { status: 500, body: { error: "failed" } };
  });
  return reply(out.status, out.body);
});
