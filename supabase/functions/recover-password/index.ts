// recover-password: POST { username, recovery_code, new_password }. No session
// is needed (the caller has lost their password), so the gateway's JWT check
// is off for this function (supabase/config.toml) and everything is decided in
// ../_shared/recovery.mjs: 5 attempts per 15 minutes per username hash and per
// IP hash, a constant-time compare, and one generic answer for every failure.
// On success it sets the password with the admin API, revokes every session and
// rotates the code; the new code comes back once.
//
// Secrets: RECOVERY_CODE_HMAC_SECRET (rotate-recovery-secret workflow).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the runtime.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleRecover, CORS_HEADERS } from "../_shared/recovery.mjs";

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
  try { body = await req.json(); } catch { /* the handler treats a missing body as a failure */ }
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

  const out = await handleRecover({ body, ip }, {
    secret,
    store: {
      lookupUser: async (username: string) => {
        const { data, error } = await supabase.rpc("recovery_lookup_user", { p_username: username });
        return error || !data ? null : String(data);
      },
      getRecoveryHmac: async (userId: string) => {
        const { data } = await supabase.from("recovery_codes").select("code_hmac").eq("user_id", userId).eq("kind", "recovery").maybeSingle();
        return data ? String(data.code_hmac) : null;
      },
      consumeReset: async (userId: string, code: string) => {
        const { data, error } = await supabase.rpc("recovery_consume_reset_code", { p_user_id: userId, p_code: code });
        return !error && data === true;
      },
      setPassword: async (userId: string, password: string) => {
        const { error } = await supabase.auth.admin.updateUserById(userId, { password });
        return !error;
      },
      revokeSessions: async (userId: string) => {
        const { error } = await supabase.rpc("recovery_revoke_sessions", { p_user_id: userId });
        if (error) throw error;
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
    },
  }).catch((e: unknown) => {
    // Never the cause in the answer: it is the same generic failure either way.
    console.error("recover-password failed", e instanceof Error ? e.message : "unknown");
    return { status: 400, body: { error: "recovery_failed" } };
  });
  return reply(out.status, out.body);
});
