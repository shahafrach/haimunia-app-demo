// B3. The Web Push sender: the half that was never built.
//
// Everything around it has shipped and sat idle. push_subscriptions has held
// endpoints since COMM-005, sw.js has had a `push` handler since COMM-229,
// streak_at_risk_notify() has run daily on cron writing rows, and
// notifications.push_sent_at has been null on every row ever written, because
// nothing has ever put one on a phone.
//
// This file contains NO policy. Who gets a push - preference rows, revoked
// endpoints, deleted profiles, the 24-hour floor - is decided by
// notif_push_pending() in 202609170002, where pgTAP can test it against a
// real Postgres. Here there is only: fetch, encrypt, POST, record.
//
// Local run:
//   supabase functions serve notif_push_send
//   curl -X POST http://127.0.0.1:54321/functions/v1/notif_push_send \
//     -H "Authorization: Bearer <service_role key>"
//
// Secrets (Edge Function secrets, never the repo):
//   VAPID_PRIVATE_KEY  the 32-byte d value, base64url
//   VAPID_PUBLIC_KEY   must match cloud-config.js's notifPushVapidPublicKey
// Both are written by the rotate-vapid workflow, which generates the pair on
// the runner so that no person and no session ever sees the private half.
// The subject (RFC 8292 contact) is a URL, not an email address: VAPID_SUBJECT
// in _shared/webPush.mjs.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { encryptPushPayload, buildVapidAuth, VAPID_SUBJECT } from "../_shared/webPush.mjs";

// Same constant-shape comparison recap_weekly uses (SEC-017): a plain !==
// short-circuits at the first differing byte, which is a timing channel for
// recovering the service-role key.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  return diff === 0;
}

type Pending = {
  notification_id: string;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  title: string;
  body: string;
  deep_link: string | null;
  notification_type: string;
};

// What sw.js's push handler reads, and the field names are load-bearing.
// The first draft of this function sent `url`; sw.js reads
// `payload.deep_link || payload.deepLink` and would have fallen back to "./"
// on every single notification - every push opening the home screen instead
// of the comment, challenge or event it was about. Nothing would have errored.
// test/web-push-payload-contract.test.mjs now pins both sides together.
function payloadFor(row: Pending): string {
  return JSON.stringify({
    title: row.title,
    body: row.body,
    deep_link: row.deep_link || "./",
    // Collapses repeat notifications of one kind into a single entry on the
    // lock screen rather than a stack of near-identical rows.
    tag: row.notification_type,
  });
}

export async function sendPending(
  supabase: SupabaseClient,
  vapid: { publicKey: string; privateKey: string; subject: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ attempted: number; delivered: number; revoked: number; failed: number }> {
  const { data, error } = await supabase.rpc("notif_push_pending", { p_limit: 200 });
  if (error) throw new Error(`notif_push_pending failed: ${error.message}`);
  const rows = (data ?? []) as Pending[];
  if (!rows.length) return { attempted: 0, delivered: 0, revoked: 0, failed: 0 };

  // A notification can have several subscriptions (phone and laptop). It is
  // delivered if ANY of them took it, and only the ones the push service
  // rejected as gone get retired.
  const deliveredNotifications = new Set<string>();
  const failedNotifications = new Set<string>();
  const deadSubscriptions = new Set<string>();

  for (const row of rows) {
    let response: Response;
    try {
      const body = await encryptPushPayload({
        payload: payloadFor(row),
        p256dh: row.p256dh,
        auth: row.auth_secret,
      });
      const auth = await buildVapidAuth({
        endpoint: row.endpoint,
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      });
      response = await fetchImpl(row.endpoint, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          // Seconds the push service may hold this if the device is offline.
          // 6 hours: a reaction that lands tomorrow morning is noise, and
          // this is the only knob that bounds that.
          TTL: "21600",
          Urgency: "normal",
        },
        body,
      });
    } catch (_err) {
      // An endpoint that would not resolve or encrypt is a transient failure,
      // not a dead subscription. Leaving push_sent_at null lets the next run
      // retry it; the 24-hour floor in notif_push_pending stops that being
      // forever.
      failedNotifications.add(row.notification_id);
      console.error("notif_push_send: send threw", { subscription: row.subscription_id });
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      // The push service's word that this endpoint is gone - the only signal
      // that exists for a device that never reopens the app.
      deadSubscriptions.add(row.subscription_id);
      failedNotifications.add(row.notification_id);
    } else if (response.ok) {
      deliveredNotifications.add(row.notification_id);
    } else {
      failedNotifications.add(row.notification_id);
      console.error("notif_push_send: push service refused", { status: response.status });
    }
  }

  // Delivery wins over failure: one dead laptop endpoint must not hold back a
  // notification the member's phone already received, or every run would
  // re-send it to the phone until the row aged out.
  for (const id of deliveredNotifications) failedNotifications.delete(id);

  let markedSent = 0;
  if (deliveredNotifications.size) {
    const { data: marked, error: markErr } = await supabase.rpc("notif_push_mark_sent", {
      p_ids: [...deliveredNotifications],
    });
    if (markErr) throw new Error(`notif_push_mark_sent failed: ${markErr.message}`);
    markedSent = marked ?? 0;
  }
  if (deadSubscriptions.size) {
    const { error: revokeErr } = await supabase.rpc("notif_push_revoke", {
      p_subscription_ids: [...deadSubscriptions],
    });
    if (revokeErr) throw new Error(`notif_push_revoke failed: ${revokeErr.message}`);
  }

  return {
    attempted: rows.length,
    delivered: markedSent,
    revoked: deadSubscriptions.size,
    failed: failedNotifications.size,
  };
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("notif_push_send: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
    return new Response(JSON.stringify({ error: "missing service credentials" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  // As in recap_weekly: the platform's verify_jwt only proves SOME valid JWT,
  // which the publishable key in cloud-config.js satisfies. This function
  // reads every member's endpoints and notification bodies, so the check is
  // for the service-role key specifically.
  if (!timingSafeEqualStrings(req.headers.get("Authorization") || "", `Bearer ${serviceRoleKey}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    // Refusing loudly rather than returning 200 with nothing sent. An
    // unprovisioned sender that reports success is the exact shape of failure
    // this project keeps finding (see docs/handover/SHARED_CONTEXT.md).
    console.error("notif_push_send: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not provisioned");
    return new Response(JSON.stringify({ error: "vapid keys not provisioned" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  try {
    const result = await sendPending(supabase, { publicKey, privateKey, subject: VAPID_SUBJECT });
    if (result.attempted) console.log("notif_push_send:", result);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (_err) {
    console.error("notif_push_send: run failed");
    return new Response(JSON.stringify({ error: "notif_push_send run failed" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
