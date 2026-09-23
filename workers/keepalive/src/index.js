// One cheap read against the Supabase REST API, every two days, so the Free
// plan does not pause the project before launch.
//
// WHAT IT CALLS, and why that one. `public.job_health_status()` is the ONLY
// thing `anon` may execute in this project - 202609170001 revoked anon
// EXECUTE on everything else, and no table is anon-selectable (verified
// 2026-09-23: `has_function_privilege('anon', …)` returns exactly this one
// function, and `/rest/v1/profiles` answers 401). So it is both the cheapest
// and the only honest choice, and it is the same call a signed-out browser
// could make.
//
// It matters that this REACHES POSTGRES rather than stopping at the gateway.
// An RPC runs a real function in the database; a 401 from PostgREST might
// never touch it. That is the difference between a heartbeat and a ping that
// keeps a project alive on paper.
const PING_PATH = "/rest/v1/rpc/job_health_status";

// A publishable key is safe in plain text; a secret key is not, and the whole
// point of this Worker is that it needs no privilege at all. Refuse rather
// than run with one, so a well-meaning "it stopped working, try the other
// key" cannot quietly turn a public heartbeat into a privileged one.
function looksLikeSecretKey(key) {
  if (!key) return false;
  if (key.startsWith("sb_secret_")) return true;
  // Legacy JWT-shaped keys: the payload names the role.
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload && payload.role && payload.role !== "anon") return true;
    } catch { /* not a JWT we can read; fall through */ }
  }
  return false;
}

async function heartbeat(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    console.error("keepalive: SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is not set - did nothing");
    return { ok: false, reason: "missing config" };
  }
  if (looksLikeSecretKey(key)) {
    console.error("keepalive: refusing to run - SUPABASE_PUBLISHABLE_KEY looks like a secret/service-role key");
    return { ok: false, reason: "privileged key" };
  }

  const started = Date.now();
  try {
    const res = await fetch(url + PING_PATH, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const ms = Date.now() - started;
    const body = (await res.text()).slice(0, 200);

    if (!res.ok) {
      // Loud on purpose. A heartbeat that fails silently is how you discover
      // the project paused by opening the app.
      console.error(`keepalive: FAILED http=${res.status} in ${ms}ms body=${body}`);
      return { ok: false, status: res.status, ms, body };
    }
    console.log(`keepalive: ok http=${res.status} in ${ms}ms body=${body}`);
    return { ok: true, status: res.status, ms, body };
  } catch (err) {
    console.error(`keepalive: threw after ${Date.now() - started}ms: ${err && err.message}`);
    return { ok: false, reason: String(err && err.message) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(heartbeat(env));
  },
  // No public HTTP surface. `wrangler dev --test-scheduled` drives the cron
  // path locally; see docs/ops/MONITORING.md. Anything else gets 404 rather
  // than an endpoint anyone can hammer.
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
