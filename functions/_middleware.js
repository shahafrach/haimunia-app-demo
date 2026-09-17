// THE DEPLOY PUBLISHES THE REPOSITORY, SO THE REPOSITORY IS THE WEBSITE.
//
// There is no build step - Cloudflare Pages serves the repo root as the site
// root. That is what keeps a buildless app simple, and it also means
// supabase/migrations/*.sql, docs/audit/*.md, test/*.mjs and every runbook in
// this repo are live URLs. Verified 2026-09-17: all 200.
//
// WHY THIS IS A FUNCTION AND NOT _redirects. It was _redirects first, for one
// commit, and that file CANNOT do this job: Pages matches a static asset
// before it consults _redirects, so a rule can never shadow a file that
// exists - which is precisely the case here, since every path being blocked
// is a real file. Measured rather than assumed, after the rules silently did
// nothing: /CHANGES.md still returned 200 with the rule in place. _redirects
// was deleted rather than left in as decoration, because a file that looks
// like protection and is not is worse than no file.
//
// Middleware runs BEFORE asset resolution, so it can.
//
// WHAT THIS IS AND IS NOT. This is disclosure control: it keeps the schema,
// the security audits, the deploy runbooks and the tests off the public web.
// It is NOT a secret store and must never be treated as one - anything that
// would be damaging to publish still does not belong in this repository at
// all, because the git history is public whatever this file does. The join QR
// committed on 2026-09-16 is the case in point: removing it from the repo
// stopped it being served, and did nothing whatsoever about the code being
// valid.
//
// A prefix list, not an allow-list of app files. An allow-list is safer in
// principle and far more dangerous in practice here: miss one asset and the
// app breaks in production for everyone, with no build step to catch it. The
// blocked set is small, stable, and every entry is a directory nothing in
// index.html references.
const BLOCKED_PREFIXES = [
  "/docs/",
  "/design/",
  "/supabase/",
  "/test/",
  "/scripts/",
  "/.github/",
  "/.githooks/",
];

// Top-level notes and runbooks. Matched by extension rather than by name so a
// new one does not have to be remembered - which is how join-qr.png got
// published in the first place.
const BLOCKED_SUFFIXES = [".md", ".sql", ".mjs"];

function isBlocked(pathname) {
  const p = pathname.toLowerCase();
  if (BLOCKED_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  // Only at the top level: /src/*.mjs is app code and must keep serving.
  if (p.lastIndexOf("/") === 0 && BLOCKED_SUFFIXES.some((s) => p.endsWith(s))) return true;
  return false;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (isBlocked(url.pathname)) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Not cached: this is a boundary, and a boundary cached at the edge
        // is a boundary that keeps answering after it changes. The stale
        // join-qr.png sat in Cloudflare's cache for four hours after it was
        // removed from the deploy, on an s-maxage of seven days.
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    });
  }
  return context.next();
}
