// mfa-recovery: remove a member's authenticator factors with their recovery code.
// The gateway JWT check stays ON (the caller is signed in with a password), the
// logic is in ../_shared/mfa-recovery.mjs. Secrets: RECOVERY_CODE_HMAC_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { CORS_HEADERS } from "../_shared/recovery.mjs";
import { handleMfaRecovery } from "../_shared/mfa-recovery.mjs";

Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("RECOVERY_CODE_HMAC_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !secret) return reply(500, { error: "not_configured" });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: unknown = null;
  try { body = await req.json(); } catch { /* a missing body is a failure inside the handler */ }
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

  const out = await handleMfaRecovery({ authorization: req.headers.get("Authorization") || "", body, ip }, {
    secret,
    getUser: async (token: string) => {
      const { data, error } = await supabase.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id, is_anonymous: !!data.user.is_anonymous };
    },
    store: {
      countAttempts: async (keyHash: string, sinceMs: number) => {
        const { count } = await supabase.from("recovery_attempts").select("id", { count: "exact", head: true })
          .eq("key_hash", keyHash).gte("attempted_at", new Date(sinceMs).toISOString());
        return count ?? 0;
      },
      addAttempts: async (keyHashes: string[]) => {
        await supabase.from("recovery_attempts").insert(keyHashes.map((key_hash) => ({ key_hash })));
      },
      purgeAttempts: async (beforeMs: number) => {
        await supabase.from("recovery_attempts").delete().lt("attempted_at", new Date(beforeMs).toISOString());
      },
      getRecoveryHmac: async (userId: string) => {
        const { data } = await supabase.from("recovery_codes").select("code_hmac").eq("user_id", userId).eq("kind", "recovery").maybeSingle();
        return data ? String(data.code_hmac) : null;
      },
      consumeReset: async (userId: string, code: string) => {
        const { data, error } = await supabase.rpc("recovery_consume_reset_code", { p_user_id: userId, p_code: code });
        return !error && data === true;
      },
      removeTotpFactors: async (userId: string) => {
        const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId });
        if (error) return false;
        for (const f of data?.factors ?? []) {
          const r = await supabase.auth.admin.mfa.deleteFactor({ id: f.id, userId });
          if (r.error) return false;
        }
        return true;
      },
      putRecoveryCode: async (userId: string, hmac: string) => {
        const { error } = await supabase.from("recovery_codes").upsert(
          { user_id: userId, kind: "recovery", code_hmac: hmac, created_at: new Date().toISOString(), used_at: null },
          { onConflict: "user_id,kind" },
        );
        if (error) throw error;
      },
      clearReset: async (userId: string) => {
        await supabase.from("recovery_codes").delete().eq("user_id", userId).eq("kind", "reset");
      },
    },
  }).catch((e: unknown) => {
    console.error("mfa-recovery failed", e instanceof Error ? e.message : "unknown");
    return { status: 400, body: { error: "recovery_failed" } };
  });
  return reply(out.status, out.body);
});
