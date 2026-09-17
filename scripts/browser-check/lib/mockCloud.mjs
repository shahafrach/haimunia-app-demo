// Installs an in-page mock Supabase backend before the real app boots, for
// browser-check scripts that need to exercise the Community module.
//
// Why this exists: cloud-config.js points at the real, live production
// Supabase project (see docs/community/ and the module's own build notes) —
// it is the app's actual backend, with real member data on it. There is no
// local Supabase available in this environment either. Driving challenge
// creates, RSVPs, coach-tools writes, etc. against production from an
// unattended CI browser run is not something this repo does, ever — a
// single script bug could write real garbage into a real club's data.
//
// So this reuses test/helpers/mockSupabase.mjs — the exact same in-memory,
// RLS-faithful mock every node integration test boots cloud.js against —
// but evaluates it inside a real Chromium page instead of jsdom, using the
// same technique test/helpers/boot.mjs's bootCommunity() uses: replace
// window.supabase.createClient with a factory that returns the mock client,
// before cloud.js's own top-level `window.supabase.createClient(...)` call
// runs. The only new problem a real browser adds is that the real
// vendor/supabase.js bundle would otherwise overwrite window.supabase right
// after our init script sets it (script tag order: vendor/supabase.js loads
// before cloud.js in index.html) — solved below by serving a no-op in its
// place instead of trying to race it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockSupabasePath = path.join(here, "../../../test/helpers/mockSupabase.mjs");

function mockSupabaseSource() {
  const src = readFileSync(mockSupabasePath, "utf8");
  const stripped = src.replace(/^export function createMockSupabase/m, "function createMockSupabase");
  if (stripped === src) {
    throw new Error(
      "mockCloud: test/helpers/mockSupabase.mjs's `export function createMockSupabase` shape changed — update the strip regex in scripts/browser-check/lib/mockCloud.mjs before trusting these browser scenarios again."
    );
  }
  return stripped;
}

// Call once, before the single page.goto() a check script does. seedTables
// is the same shape createMockSupabase() already takes everywhere else
// (table name -> array of rows). opts.user, if given, is handed to
// mock.setUser() before cloud.js's boot-time client.auth.getSession() call
// runs, so the app boots already signed in as that member — the same
// pattern every community-*.test.mjs uses via seeded()/mock.setUser().
// Live bug hunt (2026-09-11): a round-7 agent testing interrupted async
// operations found that once the real service worker (sw.js) is installed
// and controlling a page, a page.reload() can have its ./vendor/supabase.js
// request served from the SW'S OWN cache rather than by the page.route()
// stub below - route interception attaches to the page's network layer, and
// a Service Worker satisfying a fetch from its own Cache Storage does not
// reliably go through the same layer. Confirmed: window.supabase.createClient
// visibly became the REAL factory after such a reload. No request to
// *.supabase.co was ever observed firing (the blanket route(/supabase\.co/)
// abort below is a second, independent net and held throughout), so this
// was not a confirmed production leak - but any script that calls
// page.reload() after a service worker has activated should pass
// `serviceWorkers: "block"` to browser.newPage()/newContext() to remove the
// bypass vector entirely. Not defaulted here: scripts/browser-check/
// update-flow.mjs deliberately exercises the REAL service-worker
// install/update lifecycle against this same mock and would break if
// service workers were blocked unconditionally for every installMockCloud
// caller.
export async function installMockCloud(page, seedTables = {}, opts = {}) {
  // Defensive net: if anything ever reaches past the stub below (a bug in
  // this harness, a future code path that bypasses window.supabase), fail
  // the request outright rather than let it reach the real project.
  await page.route(/supabase\.co/, (route) => route.abort());

  await page.route("**/vendor/supabase.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "// stubbed for browser-check community scenarios — see lib/mockCloud.mjs\n" })
  );

  // THE CAPTCHA PROVIDER, stubbed the same way and for the same two reasons:
  // a scenario must not reach a third party, and it must not depend on this
  // machine having network at all.
  //
  // This became load-bearing the moment captchaSiteKey stopped being ""
  // (2026-09-17). Before that, captchaEnabled() was false and every auth call
  // short-circuited straight through. With a real key, withCaptcha() waits for
  // a token from challenges.cloudflare.com, and - correctly, by design - it
  // REFUSES rather than failing open when the script cannot load. Two
  // scenarios went from passing to a 20s timeout on the signup screen, which
  // was the app behaving exactly as specified and the harness lying about the
  // world.
  //
  // Stubbing the SCRIPT rather than patching captchaEnabled() keeps the real
  // path under test: loadCaptchaScript resolves, getCaptchaToken renders,
  // the callback fires, and the token travels into the auth call the way it
  // does in production. Only Cloudflare is replaced.
  const captchaStub = `
    window.turnstile = {
      render: function (el, opts) {
        // Synchronous callback: the real widget is invisible and resolves on
        // its own, so no scenario should have to wait or click for it.
        if (opts && typeof opts.callback === "function") opts.callback("browser-check-captcha-token");
        return "browser-check-widget-id";
      },
      execute: function () {},
      reset: function () {},
      remove: function () {},
    };
    window.hcaptcha = window.turnstile;
  `;
  // ORDER IS LOAD-BEARING AND IS THE OPPOSITE OF READING ORDER. Playwright
  // matches routes LAST-REGISTERED-FIRST, so the broad abort has to be
  // registered BEFORE the specific stub, or it wins and aborts the very
  // request the stub exists to answer. Registered the other way round - which
  // is how it reads naturally - the scenarios still time out and the stub
  // above looks broken.
  await page.route(/challenges\.cloudflare\.com|hcaptcha\.com/, (route) => route.abort());
  for (const pattern of ["**/turnstile/v0/api.js*", "**/hcaptcha.com/1/api.js*"]) {
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: captchaStub })
    );
  }

  const userLine = opts.user ? `window.__mock.setUser(${JSON.stringify(opts.user)});` : "";
  // Redesign, Phase 3: same default test/helpers/boot.mjs's bootCommunity()
  // sets, for the identical reason - cloud.js's hasSeenIntroCarousel() is
  // read on every render, so without this every scenario here that reaches
  // a fresh signup gets intercepted by the first-run carousel instead of
  // whatever it actually means to test. opts.seenIntroCarousel === false
  // overrides this back to genuinely unseen, for the one scenario that
  // actually wants the carousel to appear.
  const glue = `${mockSupabaseSource()}
localStorage.setItem("haimunia-demo:seenIntroCarousel", ${opts.seenIntroCarousel === false ? '"0"' : '"1"'});
window.__mock = createMockSupabase(${JSON.stringify(seedTables)});
// FIRST call gets the member client; every later one gets an independent
// secondary. cloud.js creates exactly one extra client, lazily, when a
// management panel is unlocked (makeMgmtClient()) - it holds the separate
// management session, and handing out the member client both times would let
// that sign-in quietly take over the member's session inside the mock, which
// is the one thing these scenarios most need to be able to catch.
window.__mockClientCount = 0;
window.supabase = { createClient: function () {
  return (window.__mockClientCount++ === 0) ? window.__mock.client : window.__mock.secondaryClient();
} };
${userLine}
window.__mockReady = true;
`;
  await page.addInitScript({ content: glue });
}

// Runs a handler-registration / seed-mutation function inside the page, in
// the mock's own execution context — for registering RPC stand-ins
// (mock.onRpc(name, fn)) that mirror what a specific node test file already
// verified for that RPC, or for reaching into mock.db between steps of a
// scenario the way the node tests do with `mock.db.<table>`.
export async function withMock(page, fn, arg) {
  return page.evaluate(fn, arg);
}
