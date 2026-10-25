// Launch-readiness audit (docs/audit/launch-readiness.md), items S1, S11, S12.
//
// S1  The legacy photo card evicted an expired signed URL from an inline
//     onerror="" attribute. The CSP has no 'unsafe-inline', so the browser
//     never ran it and the photo stayed broken. It is now a delegated,
//     capture-phase `error` listener in src/community/posts.js.
// S11 /.claude/ and /mockups/ were served publicly by Cloudflare Pages.
// S12 admin_reset_password still allowed the retired github.io origin.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

// ===== S1 =================================================================

test("S1: no served file carries an inline event-handler attribute the CSP would block", () => {
  const csp = read("index.html").match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(csp, "index.html must declare a CSP");
  const scriptSrc = (csp[1].match(/script-src[^;]*/) || [""])[0];
  assert.ok(scriptSrc, "the CSP must set script-src");
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, "this test assumes script-src forbids inline handlers");
  for (const f of ["index.html", "app.js", "cloud.js", "src/community/posts.js"]) {
    // A quoted attribute of the shape  onerror="…"  inside markup or a
    // template string. `el.onerror = fn` (a property, which the CSP allows)
    // does not match: it has no quote after the `=`.
    const hits = read(f).match(/<[a-z][a-z0-9-]*\b[^<>\n]*\son[a-z]+\s*=\s*["']/gi) || [];
    assert.deepEqual(hits, [], `${f} must not use inline on*="" handlers - the CSP blocks them silently`);
  }
});



const mw = await import(new URL("functions/_middleware.js", root).href);
async function serve(pathname) {
  let passedThrough = false;
  const res = await mw.onRequest({
    request: new Request("https://haimunia-app.pages.dev" + pathname),
    next: async () => { passedThrough = true; return new Response("asset", { status: 200 }); },
  });
  return { status: res.status, passedThrough };
}

test("S11: /.claude/ and /mockups/ are not public, in any case", async () => {
  for (const p of ["/.claude/settings.local.json", "/.claude/agents/schema.md",
                   "/mockups/01-record-edit.png", "/Mockups/02-history.png", "/.CLAUDE/settings.local.json"]) {
    const { status, passedThrough } = await serve(p);
    assert.equal(status, 404, `${p} must not be public`);
    assert.equal(passedThrough, false, `${p} must never reach the asset`);
  }
});

test("S11: the new prefixes do not swallow app assets with a similar name", async () => {
  for (const p of ["/assets/photos/club-stripe-wall-wide.jpeg", "/assets/club-photos/add-stripe-wall.jpg", "/app.js"]) {
    assert.equal((await serve(p)).status, 200, `${p} must still be served`);
  }
});

// ===== S12 ================================================================


test("S12: no Edge Function allows a github.io origin", () => {
  const fns = readdirSync(new URL("supabase/functions/", root), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`supabase/functions/${d.name}/index.ts`, root)))
    .map((d) => d.name);
  assert.ok(fns.includes("notif_push_send"), "the directory scan must find the functions");
  for (const f of fns) {
    const code = read(`supabase/functions/${f}/index.ts`).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /github\.io/, `${f} must not reference github.io outside comments`);
  }
});
