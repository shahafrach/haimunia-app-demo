// WHAT THE DEPLOY PUBLISHES, asserted on the rules rather than on the site.
//
// This repository IS the website: Cloudflare Pages serves the repo root, with
// no build step to stand between "committed" and "public". On 2026-09-16 a
// QR encoding a working 500-use club join code was committed to
// docs/owner-guide/ and was a live URL within the hour.
//
// functions/_middleware.js is the block. These tests exercise its own
// predicate, because the two ways to get this wrong are opposite and both
// silent: block too little and the schema, the security audits and the deploy
// runbooks stay public; block too much and the app 404s in production for
// every member, with no build step to catch it first.
//
// The middleware is a Cloudflare Function, so it never runs under node in the
// normal course of things and nothing else here would ever execute it.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const mw = await import(new URL("functions/_middleware.js", root).href);

// isBlocked is not exported - onRequest is the contract. Drive it the way
// Pages does, with a Request and a next() that reports whether it was reached.
async function serve(pathname) {
  let passedThrough = false;
  const res = await mw.onRequest({
    request: new Request("https://box-log.pages.dev" + pathname),
    next: async () => { passedThrough = true; return new Response("asset", { status: 200 }); },
  });
  return { status: res.status, passedThrough };
}

test("every path the app actually loads still reaches the asset", async () => {
  // Taken from index.html's own script/link tags plus the runtime fetches,
  // not from memory. A miss here is a production outage for every member.
  const html = readFileSync(new URL("index.html", root), "utf8");
  const referenced = new Set();
  for (const m of html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)) referenced.add("/" + m[1]);
  assert.ok(referenced.size >= 8, `index.html references few assets (${referenced.size}) - did the regex stop matching?`);

  for (const p of referenced) {
    const { status, passedThrough } = await serve(p);
    assert.equal(status, 200, `${p} must be served - it is referenced by index.html`);
    assert.ok(passedThrough, `${p} must reach the static asset`);
  }
});

test("the app's own entry points are served, including the ones index.html loads at runtime", async () => {
  for (const p of ["/", "/index.html", "/app.js", "/cloud.js", "/cloud-config.js", "/sw.js",
                   "/manifest.json", "/frame-guard.js", "/theme-init.js",
                   "/src/sanitize.js", "/src/eventbus.js", "/vendor/supabase.js"]) {
    const { status } = await serve(p);
    assert.equal(status, 200, `${p} must still be served`);
  }
});

test("the schema, the audits, the runbooks and the tests are not public", async () => {
  for (const p of [
    "/supabase/migrations/202608260001_community_foundation.sql",
    "/supabase/tests/0112_head_coach_removes_a_member_test.sql",
    "/docs/audit/RISK_REGISTER.md",
    "/docs/deploy/PER_CLUB_SETUP.md",
    "/docs/handover/SESSION_A_SERVER_AND_SAFETY.md",
    "/docs/owner-guide/join-qr.png",
    "/test/scan-indexes.test.mjs",
    "/scripts/browser-check/feed-rerender-storm.mjs",
    "/CHANGES.md",
    "/COMMUNITY_SETUP.md",
    "/.github/workflows/backup-database.yml",
  ]) {
    const { status, passedThrough } = await serve(p);
    assert.equal(status, 404, `${p} must not be public`);
    assert.equal(passedThrough, false, `${p} must never reach the asset`);
  }
});

test("the Worker source is not public (MONITORING.md §6)", async () => {
  // The repository root is the website. wrangler.toml holds no secret, but
  // tooling the app never fetches is not served - the same reason /scripts/
  // and /test/ are blocked.
  for (const p of ["/workers/keepalive/wrangler.toml", "/workers/keepalive/src/index.js", "/Workers/keepalive/wrangler.toml"]) {
    const { status, passedThrough } = await serve(p);
    assert.equal(status, 404, `${p} must not be public`);
    assert.equal(passedThrough, false, `${p} must never reach the asset`);
  }
});

test("/photos/ and the npm manifest are not public (launch-readiness S11)", async () => {
  for (const p of ["/photos/club-rig-wide.jpeg", "/Photos/club-rings-portrait.jpeg",
                   "/package.json", "/package-lock.json", "/PACKAGE.JSON"]) {
    const { status, passedThrough } = await serve(p);
    assert.equal(status, 404, `${p} must not be public`);
    assert.equal(passedThrough, false, `${p} must never reach the asset`);
  }
});

test("blocking /photos/ and package.json does not take the app's own assets or manifest with it", async () => {
  // The app's own images and fonts live under /assets/, and /manifest.json is the PWA
  // manifest - the reason package.json is an exact path, not a .json rule.
  const sw = readFileSync(new URL("sw.js", root), "utf8");
  const photos = [...sw.matchAll(/"\.(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(photos.length >= 2, `sw.js precaches few assets (${photos.length}) - did the regex stop matching?`);
  for (const p of [...photos, "/manifest.json", "/src/shared/safe-helpers.js"]) {
    assert.equal((await serve(p)).status, 200, `${p} must still be served`);
  }
  // Only the top-level manifest is blocked: a path merely ending in it is not.
  assert.equal((await serve("/src/shared/package.json")).status, 200);
});

test("the block is case-insensitive - a capitalised path is the same path", async () => {
  for (const p of ["/Docs/audit/RISK_REGISTER.md", "/SUPABASE/migrations/x.sql", "/Changes.MD"]) {
    const { status } = await serve(p);
    assert.equal(status, 404, `${p} must not be a way around the block`);
  }
});

test("the extension rule is top-level only, so app code under /src keeps serving", async () => {
  // .mjs is blocked at the root (stray scripts) and must NOT be blocked in
  // /src, which is real app code. Getting this backwards breaks the app.
  assert.equal((await serve("/something.mjs")).status, 404);
  assert.equal((await serve("/src/sanitize.js")).status, 200);
  assert.equal((await serve("/src/outbox.mjs")).status, 200,
    "a module under /src is app code, not a stray script");
});

test("a blocked response is never cached - a boundary that caches keeps answering after it moves", async () => {
  // Learned from the real thing: the join QR was removed from the deploy and
  // Cloudflare's edge kept serving it for hours on s-maxage=604800.
  const res = await mw.onRequest({
    request: new Request("https://box-log.pages.dev/docs/audit/RISK_REGISTER.md"),
    next: async () => new Response("asset", { status: 200 }),
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("cache-control") || "", /no-store/);
});

test("_redirects is gone, and stays gone", () => {
  // It was the first attempt and it cannot work: Pages resolves a static
  // asset BEFORE consulting _redirects, so a rule can never shadow a file
  // that exists - which is every path being blocked here. Leaving it in place
  // as decoration would be worse than nothing, because it reads as protection.
  assert.equal(existsSync(fileURLToPath(new URL("_redirects", root))), false,
    "_redirects cannot block existing files on Pages - use functions/_middleware.js");
});
