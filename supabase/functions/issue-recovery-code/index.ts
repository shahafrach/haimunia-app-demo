// issue-recovery-code: an authenticated member makes (or rotates) their own
// password recovery code. The code is returned once; only its HMAC is stored
// (public.recovery_codes, kind 'recovery'). All of the logic is in
// ../_shared/recovery.mjs so Node tests can run it.
//
// Secrets (Edge Function secrets, never the repo):
//   RECOVERY_CODE_HMAC_SECRET  set by the rotate-recovery-secret workflow
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the runtime.
//
// An anonymous session is refused: a recovery code belongs to a username and
// password, and the member has to have set both first.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleIssue, CORS_HEADERS } from "../_shared/recovery.mjs";

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

  const out = await handleIssue({ authorization: req.headers.get("Authorization") || "" }, {
    secret,
    getUser: async (token: string) => {
      const { data, error } = await supabase.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id, is_anonymous: !!data.user.is_anonymous };
    },
    store: {
      putRecoveryCode: async (userId: string, hmac: string) => {
        const { error } = await supabase.from("recovery_codes").upsert(
          { user_id: userId, kind: "recovery", code_hmac: hmac, created_at: new Date().toISOString(), used_at: null },
          { onConflict: "user_id,kind" },
        );
        if (error) throw error;
      },
    },
  }).catch((e: unknown) => {
    console.error("issue-recovery-code failed", e instanceof Error ? e.message : "unknown");
    return { status: 500, body: { error: "failed" } };
  });
  return reply(out.status, out.body);
});
