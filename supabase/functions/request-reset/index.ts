// request-reset: the lost-code reset (fix plan F19, decided 2026-11-10).
//   POST { action: "request", username }                            -> { ok, request_token, ready_at }
//   POST { action: "complete", username, request_token, new_password } -> { ok, recovery_code }
// No session is needed (the caller has lost both the password and the recovery
// code), so the gateway's JWT check is off (supabase/config.toml) and every rule
// is in ../_shared/recovery.mjs: the same answer for a known and an unknown
// username, a 12-hour wait the account can cancel from any signed-in session
// (cancel_my_reset), a push to the account's devices, 3 requests per username
// per day, the recover-password IP limit, one generic answer for every failure.
//
// Secrets: RECOVERY_CODE_HMAC_SECRET (rotate-recovery-secret workflow), the same
// key recover-password uses, under its own domain prefix.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the runtime.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleResetRequest, CORS_HEADERS } from "../_shared/recovery.mjs";

const ms = (v: unknown) => (v ? new Date(String(v)).getTime() : null);

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

  const out = await handleResetRequest({ body, ip }, {
    secret,
    store: {
      lookupUser: async (username: string) => {
        const { data, error } = await supabase.rpc("recovery_lookup_user", { p_username: username });
        return error || !data ? null : String(data);
      },
      getResetRequest: async (userId: string) => {
        const { data } = await supabase.from("reset_requests")
          .select("token_hmac, ready_at, expires_at, cancelled_at, blocked_until").eq("user_id", userId).maybeSingle();
        if (!data) return null;
        return {
          token_hmac: String(data.token_hmac),
          ready_at: ms(data.ready_at), expires_at: ms(data.expires_at),
          cancelled_at: ms(data.cancelled_at), blocked_until: ms(data.blocked_until),
        };
      },
      putResetRequest: async (userId: string, r: { token_hmac: string; ready_at: number; expires_at: number }) => {
        const { error } = await supabase.from("reset_requests").upsert({
          user_id: userId, token_hmac: r.token_hmac, created_at: new Date().toISOString(),
          ready_at: new Date(r.ready_at).toISOString(), expires_at: new Date(r.expires_at).toISOString(),
          cancelled_at: null, blocked_until: null,
        }, { onConflict: "user_id" });
        if (error) throw error;
      },
      deleteResetRequest: async (userId: string) => {
        await supabase.from("reset_requests").delete().eq("user_id", userId);
      },
      notifyResetRequested: async (userId: string, readyAt: number) => {
        // A push that fails must not stop the request; the banner still shows on any signed-in device.
        const { error } = await supabase.rpc("reset_notify_requested", { p_user: userId, p_ready_at: new Date(readyAt).toISOString() });
        if (error) console.error("request-reset notify failed", error.message);
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
    console.error("request-reset failed", e instanceof Error ? e.message : "unknown");
    return { status: 400, body: { error: "recovery_failed" } };
  });
  return reply(out.status, out.body);
});
