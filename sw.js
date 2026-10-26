// Service worker for BOX-LOG.
// Version is the single source of truth for the cache name — bumping
// APP_VERSION in app.js is what ships an update. Don't edit SW_VERSION by
// hand: run `npm run sync-version` (see app.js) to copy it here.
const SW_VERSION = "4.81.0";
// "haimunia-demo-v..." — deliberately distinct from the production app's
// own "haimunia-v..." cache prefix. Both service workers were once scoped
// to one origin (a shared GitHub Pages host, before the move to Cloudflare Pages
// on 2026-09-16) and could be again, and the activate handler below
// deletes any Cache Storage entry that isn't the current CACHE name —
// with a shared prefix, this demo's own cleanup could delete the real
// app's cached assets (Cache Storage is origin-wide, not scoped per SW).
const CACHE = `haimunia-demo-v${SW_VERSION}`;

// Required: the offline training log cannot render/run without these. A miss
// here fails the whole install (the old service worker — and its own cache —
// stays in control, per the Cache/Service Worker spec's normal failed-
// install behavior), rather than silently activating a shell that's missing
// its own HTML or JS. src/constants.js, format.js, sanitize.js and db.js are
// core dependencies app.js calls unconditionally (sanitizers, esc(), uid(),
// openDB()) — there's no guard around them, so they stay required. So is
// src/shared/safe-helpers.js (COMM-368): esc()/uid()/clean*() are DEFINED
// there now, and src/constants.js reads window.BoxLogSafe at its own top
// level, so a miss on it takes down the offline log outright.
const REQUIRED_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./frame-guard.js",
  "./theme-init.js",
  "./src/shared/safe-helpers.js",
  "./src/constants.js",
  "./src/format.js",
  "./src/sanitize.js",
  "./src/db.js",
  // Required, not optional: app.js calls applyDesktopLayout() on every
  // render. A miss would leave a staff laptop on the phone layout with
  // no signal that anything had gone wrong.
];
// Optional: everything the core offline training log tolerates being absent
// (a font falls back, an icon is missing, the Community tab shows its own
// loading/error state) — a miss degrades that one feature but never breaks
// install or the core app. cloud.js and its community-only src/* deps belong
// here: app.js already guards every cloud.js integration point defensively
// (e.g. `typeof renderCommunityApp === "function"`, and PR-created events
// wrap `bus.emit(...)` in a try/catch), so a failed fetch of any of these
// must not take down offline support for the training log too.
const OPTIONAL_ASSETS = [
  "./src/community/outward.js",
  "./src/community/achievements.js",
  "./src/community/notifications.js",
  "./src/community/reactions.js",
  "./src/community/privacy.js",
  "./src/community/posts.js",
  "./src/community/share-prompt.js",
  "./src/share-cards.js",
  "./src/community/auth.js",
  "./cloud.js",
  "./src/eventbus.js",
  "./src/analytics.js",
  "./src/dormancy.js",
  "./src/outbox.js",
  "./vendor/supabase.js",
  // Settings links to these two styled pages (app.js), not the raw .md
  // source files - precaching the .md files meant the actual legal pages
  // a member taps were never cached and silently fell back to the network
  // (or failed) offline.
  "./privacy.html",
  "./terms.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./assets/mark.svg",
  "./assets/icon-barbell.png",
  "./assets/icon-chevrons.png",
  "./assets/logo-full.svg",
  "./assets/medal-bronze.png",
  "./assets/medal-silver.png",
  "./assets/medal-gold.png",
  "./assets/fonts/rubik-400-latin.woff2",
  "./assets/fonts/rubik-400-hebrew.woff2",
  "./assets/fonts/rubik-600-latin.woff2",
  "./assets/fonts/rubik-600-hebrew.woff2",
  "./assets/fonts/rubik-700-latin.woff2",
  "./assets/fonts/rubik-700-hebrew.woff2",
  "./assets/fonts/rubik-800-latin.woff2",
  "./assets/fonts/rubik-800-hebrew.woff2",
  "./assets/fonts/rubik-900-latin.woff2",
  "./assets/fonts/rubik-900-hebrew.woff2",
  "./assets/fonts/jbmono-500-latin.woff2",
  "./assets/fonts/jbmono-700-latin.woff2",
  "./assets/fonts/anton-400-latin.woff2",
  "./assets/fonts/secularone-400-hebrew.woff2",
];
const ASSETS = [...REQUIRED_ASSETS, ...OPTIONAL_ASSETS];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // addAll() is all-or-nothing across the whole list; doing required
      // assets as their own strict Promise.all() means a miss here is
      // exactly as fatal as it should be, without also failing on an
      // optional asset miss the way a single addAll() over everything would.
      await Promise.all(REQUIRED_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await Promise.allSettled(
        OPTIONAL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" }))
            .catch((err) => console.warn("[sw] precache miss:", url, err))
        )
      );
    })
  );
  // No skipWaiting() here on purpose. The page shows an update banner and the
  // user decides when to swap; activating under a running page would leave the
  // old app.js talking to a new cache.
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Only ever delete this demo's OWN old cache versions — Cache
      // Storage is shared across the whole origin, not scoped per service
      // worker, so a bare "!== CACHE" here would also delete the real
      // production app's cache the first time both apps have run in the
      // same browser.
      await Promise.all(keys.filter((k) => k.startsWith("haimunia-demo-v") && k !== CACHE).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      await self.clients.claim();
    })()
  );
});

// The update banner in index.html triggers the swap explicitly.
//
// PUSH_SELF_TEST is the account-settings "send a test notification to this
// device" control. The worker draws the notification from its OWN
// registration - the same surface the push handler below uses, which is the
// point of testing it here rather than from the page - and then reports the
// receipt back to whoever asked.
//
// IT REPORTS; IT DOES NOT INSERT. A service worker has no Supabase client and
// deliberately cannot read cloud-config.js (see the push handler's own note
// on why importScripts there is not worth pulling the keys into this scope),
// so the analytics row goes through the page's existing writer -
// analyticsTrack(), the one writer of public.analytics_events - reached by
// posting back exactly as notificationclick already does. The id is echoed
// unchanged so a receipt cannot resolve a run other than its own.
self.addEventListener("message", (e) => {
  if (!e.data) return;
  if (e.data.type === "SKIP_WAITING") { self.skipWaiting(); return; }
  if (e.data.type === "PUSH_SELF_TEST") {
    const id = e.data.id;
    e.waitUntil(
      self.registration.showNotification("BOX-LOG", {
        body: "זו התראת בדיקה. ההתראות במכשיר הזה עובדות.",
        icon: "./icon-192.png",
        badge: "./icon-192-maskable.png",
        // A tag, so a member who taps the button twice replaces the first
        // test notification instead of stacking two identical ones.
        tag: "haimunia-push-self-test",
        data: { deepLink: "./", selfTest: true },
      }).then(async () => {
        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of allClients) c.postMessage({ type: "PUSH_SELF_TEST_RECEIVED", id: id });
      }).catch(() => { /* nothing arrived; the page's own timeout is the answer */ })
    );
  }
});

// COMM-229. Behind NOTIF_PUSH_ENABLED client-side (cloud.js); this handler
// itself has nothing to gate on — a push event only ever arrives if this
// device actually has a live subscription, which only exists once the
// flag was on when it was created. Actually sending a push is out of this
// ticket's scope (notif_push_send, a separate service-role job, not built
// here) — this is the receiving half, ready for when that exists.
self.addEventListener("push", (e) => {
  let payload = {};
  if (e.data) {
    // A malformed or plain-text payload still shows something rather than
    // throwing and dropping the notification silently.
    try { payload = e.data.json(); } catch (err) {
      try { payload = { body: e.data.text() }; } catch (err2) { payload = {}; }
    }
  }
  // A SERVICE WORKER CANNOT READ cloud-config.js. It runs in its own global
  // scope with no access to the page's window, so window.brandName() - which
  // every other display of the product name now goes through - is unreachable
  // here. importScripts("./cloud-config.js") would work and is not worth it:
  // it would pull the whole config, including the Supabase keys, into the
  // worker for one fallback string that is only ever used when the server
  // omits a title.
  //
  // So this one stays literal, and PER_CLUB_SETUP.md lists it with the other
  // static spots. Setting up a second club is a short, named list of files -
  // not a search through 21,000 lines.
  const title = payload.title || "BOX-LOG";
  const deepLink = payload.deep_link || payload.deepLink || "./";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "./icon-192.png",
    badge: payload.badge || "./icon-192-maskable.png",
    tag: payload.tag || undefined,
    // Read back by notificationclick below — the deep link is the whole
    // reason this notification exists, so it travels with the
    // Notification object itself rather than needing a second payload.
    data: { deepLink: deepLink },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const deepLink = (e.notification.data && e.notification.data.deepLink) || "./";
  e.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of allClients) {
        if ("focus" in c) {
          // The service worker never touches app state directly (the same
          // split SKIP_WAITING above uses) — it focuses the window and
          // hands the deep link to the page, which does the actual
          // navigation (app.js's own serviceWorker "message" listener,
          // wired to cloud.js's communityHandlePushDeepLink).
          c.postMessage({ type: "PUSH_NOTIFICATION_CLICK", deepLink: deepLink });
          return c.focus();
        }
      }
      // No window was open to focus: open one directly at the deep link,
      // via the same ?tab=/?notif= query-param convention the manifest
      // shortcuts already use (see the fetch handler's ignoreSearch
      // comment below) — app.js reads ?notif= at boot and hands it to the
      // community layer once its session is ready.
      if (self.clients.openWindow) {
        return self.clients.openWindow("./index.html?tab=community&notif=" + encodeURIComponent(deepLink));
      }
    })()
  );
});

// Only app-shell files get written back to the cache, so a stray same-origin
// request can't grow the cache without bound.
// Security hunt (2026-09-11): this used to compare with url.pathname.endsWith("/"+rel),
// a suffix match - a same-origin request to /anything/app.js would also count
// as precached, not just the real ./app.js at the shell's own base path. No
// code path in this app currently builds a fetch() URL like that (checked),
// so it wasn't reachable, but the suffix match was strictly looser than the
// exact set of files install() actually cached, and cheap to tighten. Each
// asset is now resolved to its real absolute URL relative to this service
// worker's own location (works at any deploy base path, same as ASSETS'
// own "./"-relative entries already assumed) and compared for an exact
// pathname match instead.
function isPrecached(url) {
  return ASSETS.some((a) => new URL(a, self.location).pathname === url.pathname);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Only ever touch our own origin. The previous version cached every
  // successful GET from anywhere, which meant unbounded growth and let any
  // third-party response sit in the app's cache indefinitely.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return;

  // Environment configuration must never be served stale. It may change
  // independently of the app shell when switching demo/staging projects.
  if (url.pathname.endsWith("/cloud-config.js")) {
    e.respondWith(fetch(req, { cache: "no-store" }).catch(() => new Response("window.HAIMUNIA_CONFIG={};", { headers: { "Content-Type": "application/javascript" } })));
    return;
  }

  // Navigations: serve the shell. Matching with ignoreSearch is what makes the
  // manifest shortcuts (./index.html?tab=add) work offline — an exact-URL match
  // missed on the query string and fell through to a network error.
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        try {
          const preload = await e.preloadResponse;
          if (preload) return preload;
          return await fetch(req);
        } catch (err) {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(req, { ignoreSearch: true })) ||
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } })
          );
        }
      })()
    );
    return;
  }

  // Same-origin assets: stale-while-revalidate, but only re-cache things that
  // are part of the app shell.
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          // Security hunt (2026-09-11): res.redirected was never checked here.
          // A same-origin redirect still yields type:"basic"/ok:true per the
          // Fetch spec, so if a precached path were ever redirected, this
          // would have cached the REDIRECTED body under the ORIGINAL trusted
          // key - confirmed live by actually redirecting a precached path and
          // watching the redirected content get served back later, fully
          // offline. No mechanism on this app's real static-hosting origin
          // can currently produce such a redirect (checked), so this was not
          // reachable in production, but it was strictly looser than the
          // "only cache what was actually asked for" invariant this whole
          // block exists to enforce, and cheap to close outright.
          if (res && res.ok && !res.redirected && res.type === "basic" && isPrecached(url)) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
