// Boots the real app (index.html + app.js, byte-for-byte off disk) inside a
// jsdom window backed by a fresh, isolated in-memory IndexedDB per call — so
// tests exercise the actual production code path, not a reimplementation of
// it, with no state leaking between tests.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import FDBFactory from "fake-indexeddb/lib/FDBFactory";
import FDBKeyRange from "fake-indexeddb/lib/FDBKeyRange";

const testDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(testDir);
const htmlPath = path.join(root, "index.html");
const appJsPath = path.join(root, "app.js");
const cloudJsPath = path.join(root, "cloud.js");
// app.js was split into a few self-contained files, loaded as separate
// <script> tags in index.html, in the same order below. Real browsers
// share one global *lexical* environment across classic <script> tags, so
// a top-level `let`/`const` in one is visible from a later one — verified
// against real Chromium via scripts/browser-check. jsdom's window.eval()
// does NOT reproduce that: each separate eval() call gets its own script
// scope, so a later call's `let X` from an earlier one throws
// ReferenceError. Concatenating into one string before a single eval()
// (below) sidesteps that jsdom-only gap without changing app.js itself.
const appSrcPaths = [
  path.join(root, "src", "constants.js"),
  path.join(root, "src", "format.js"),
  path.join(root, "src", "sanitize.js"),
  path.join(root, "src", "db.js"),
  // Same position index.html loads it in: after the core src files and
  // before app.js, which calls into it from render() and from boot.
  path.join(root, "src", "desktop-layout.js"),
];
function readAppSrc() {
  return appSrcPaths.map((p) => readFileSync(p, "utf8")).join("\n") + "\n" + readFileSync(appJsPath, "utf8");
}
// The shared platform modules (COMM-012 to COMM-015) load BEFORE cloud.js
// in index.html, not after, because cloud.js reaches them through window.
// They get their own eval() rather than joining the concatenation above
// for exactly that reason - the order has to match index.html. Each one
// is a self-contained IIFE that only publishes to window, so unlike the
// app src files they do not depend on a top-level `let` being visible
// across script tags, and the separate eval costs nothing.
// COMM-368. src/shared/safe-helpers.js belongs at the head of THIS list, not
// the app-src concatenation below: it is the first script index.html loads,
// before cloud.js, and cloud.js reads window.BoxLogSafe.esc off it (COMM-367).
// It publishes only to window, so a separate eval costs it nothing.
const platformSrcPaths = [
  path.join(root, "src", "shared", "safe-helpers.js"),
  path.join(root, "src", "eventbus.js"),
  path.join(root, "src", "analytics.js"),
  path.join(root, "src", "realtime.js"),
  path.join(root, "src", "image.js"),
  // The community write queue. Same position as index.html: before
  // cloud.js, which registers its handlers at load.
  path.join(root, "src", "outbox.js"),
];
function readPlatformSrc() {
  return platformSrcPaths.map((p) => readFileSync(p, "utf8")).join("\n");
}

function newDom(url, opts = {}) {
  const html = readFileSync(htmlPath, "utf8");
  const dom = new JSDOM(html, {
    // COMM-229. Overridable so a test can boot with a ?notif=... query
    // string (app.js reads it at its own top-level, before any script
    // below runs) - every other caller keeps the plain origin default.
    url: url || "https://example.test/",
    // "outside-only" parses the document but does NOT auto-run its <script>
    // tags (no network/file fetch needed for ./app.js or ./theme-init.js);
    // it still exposes window.eval so we can run app.js ourselves below.
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.indexedDB = new FDBFactory();
  window.IDBKeyRange = FDBKeyRange;

  // jsdom implements neither matchMedia nor a full randomUUID-capable crypto.
  //
  // The default answers false to every query, which is what every test
  // written before this seam existed assumes - jsdom has no layout, so
  // "false to everything" is the only honest default and it keeps every
  // existing test on the phone layout. A test that is ABOUT a media query
  // passes `matchMedia: (q) => ...` and gets a real, listenable
  // MediaQueryList back; window.__setMediaMatcher(fn) then swaps the
  // predicate and fires `change` at every live list, which is how a layout
  // that switches on resize can be exercised without a browser.
  let mediaMatcher = typeof opts.matchMedia === "function" ? opts.matchMedia : () => false;
  const mediaLists = [];
  window.matchMedia = (media) => {
    const handlers = [];
    const mql = {
      media: String(media || ""),
      get matches() { return !!mediaMatcher(String(media || "")); },
      addEventListener(type, fn) { if (type === "change") handlers.push(fn); },
      removeEventListener(type, fn) {
        if (type !== "change") return;
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      },
      addListener(fn) { handlers.push(fn); },
      removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
      __fire() { for (const fn of handlers.slice()) fn({ matches: mql.matches, media: mql.media }); },
    };
    mediaLists.push(mql);
    return mql;
  };
  window.__setMediaMatcher = (fn) => {
    mediaMatcher = typeof fn === "function" ? fn : () => false;
    for (const mql of mediaLists) mql.__fire();
  };
  // defineProperty rather than assignment: jsdom 30 made window.crypto an
  // accessor with no setter, so `window.crypto = ...` throws "Cannot set
  // property crypto of [object Window] which has only a getter" and takes
  // every test that boots the app down with it. Assignment worked on 25.
  Object.defineProperty(window, "crypto", {
    value: globalThis.crypto, configurable: true, writable: true,
  });

  // window.confirm has no jsdom implementation; default to "yes" for tests
  // that go through confirmation flows (e.g. import merge).
  window.confirm = () => true;
  window.alert = () => {};
  return window;
}

export async function bootApp(opts = {}) {
  const window = newDom(opts.url, opts);
  window.eval(readPlatformSrc());
  window.eval(readAppSrc());

  await waitFor(() => window.document.getElementById("loading").style.display === "none", 5000);
  return window;
}

// Boots cloud.js alongside app.js, in the same order the real
// index.html script tags do (cloud.js first, so its functions exist on
// window by the time app.js's render() can call
// window.renderCommunityApp), wired to a mock Supabase client instead of
// a real project - see helpers/mockSupabase.mjs. This is what lets a
// test actually execute the community/sync surface (refreshSession,
// the login/signup gates, publishing, moderation) instead of only
// regex-matching cloud.js's source text.
export async function bootCommunity(mock, opts = {}) {
  const window = newDom(opts.url, opts);
  window.HAIMUNIA_CONFIG = { supabaseUrl: "https://mockproj.supabase.co", supabasePublishableKey: "mock-key",
    // COMM-229. Same shape cloud-config.js ships - a test that stubs the
    // Push API needs a real (if fake) key here for vapidKeyToUint8Array to
    // decode, matching what a real browser is handed.
    notifPushVapidPublicKey: "BD16mHSAcS-jU5cV2xEqkNy09hCQ7MTjkY22CK8UrRw1JpI_5kjReL7tME6O4BFmQhuiaOVCWQ-nqsnoa1_0nAo" };
  // FIRST call gets the member client; every later one gets an independent
  // secondary. cloud.js creates exactly one extra client, lazily, when a
  // management panel is unlocked (makeMgmtClient()), so the ordering here is
  // not a guess about call counts - it is the only shape the app produces.
  // Handing out mock.client both times would have let the management sign-in
  // silently take over the member's session inside the mock, which is the one
  // thing these tests most need to be able to catch.
  // Exposed on window (as scripts/browser-check/lib/mockCloud.mjs does) so a
  // test can assert HOW MANY clients an interaction built - the difference
  // between one intent producing one management sign-in and a double tap
  // producing two, one of which nothing can ever revoke.
  window.__mockClientCount = 0;
  window.supabase = { createClient: () => (window.__mockClientCount++ === 0 ? mock.client : mock.secondaryClient()) };
  // Redesign, Phase 3: default every test to "already saw the first-run
  // intro carousel" - unlike syncEnabled/coachEngage below, cloud.js reads
  // this on every render (hasSeenIntroCarousel()), not just at module init,
  // so the vast majority of existing tests boot a member straight to
  // whatever screen they actually mean to test (the profile-completion
  // form, the tabbed UI, ...) instead of being intercepted by a carousel
  // they have no interest in. A test that DOES want the carousel passes
  // `localStorage: { "haimunia-demo:seenIntroCarousel": "0" }` (below) to
  // override this default back to unseen.
  window.localStorage.setItem("haimunia-demo:seenIntroCarousel", "1");
  // cloud.js reads this synchronously at module init (state.syncEnabled),
  // so it has to be set before cloud.js is eval'd below, not after.
  if (opts.syncEnabled) window.localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");
  // COMM-226. featureFlags.coachEngage is read the same way, once, at the
  // same module-init literal - any other localStorage-backed flag added
  // later can go through this same generic hook instead of a new
  // one-off opts.* special case each time.
  if (opts.localStorage) {
    for (const [key, value] of Object.entries(opts.localStorage)) window.localStorage.setItem(key, value);
  }
  // COMM-229. app.js's own `if ("serviceWorker" in navigator)` registration
  // block (including the "message" listener wired to
  // communityHandlePushDeepLink) runs synchronously, in the same tick that
  // hides the #loading indicator below - by the time this function's own
  // window is handed back there is no later point at which a test could
  // still inject navigator.serviceWorker and have that block see it, so
  // this has to land before readAppSrc() is eval'd, not after.
  if (opts.serviceWorkerStub) window.navigator.serviceWorker = opts.serviceWorkerStub;

  const cloudJs = readFileSync(cloudJsPath, "utf8");
  window.eval(readPlatformSrc());
  window.eval(cloudJs);
  window.eval(readAppSrc());

  await waitFor(() => window.document.getElementById("loading").style.display === "none", 5000);
  return window;
}

// ---- The community gate, after design spec section 7 ---------------------
//
// The gate used to be ONE screen that led with the login form, so a large
// number of tests used `#communityLogin` as their proxy for "the signed-out
// gate has rendered". It is now two screens: a neutral CHOICE screen (what
// the community is, "יש לי קוד הזמנה" as the primary action) with the login
// form one deliberate tap behind it, because for a club rolling this out
// every arriving member is new and the login form was the primary action
// almost nobody needed.
//
// These two helpers keep that distinction honest in the tests rather than
// papering over it. A test that only needs "the signed-out gate is up" waits
// for the gate; a test that genuinely exercises LOGGING IN opens the form
// explicitly, which is exactly what a returning member now does.
export async function waitForCommunityGate(window) {
  await waitFor(() => !!window.document.querySelector(
    '#content [data-community-action="start-signup"], #content #communityLogin'), 4000);
  return window.document.getElementById("content");
}
export async function openCommunityLogin(window) {
  await waitForCommunityGate(window);
  const btn = window.document.querySelector('#content [data-community-action="show-login"]');
  if (btn) btn.click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 4000);
  return window.document.getElementById("communityLogin");
}

// Design spec §3.6 removed the Rx default: `let wodRx = true` silently filed
// a beginner's session as "at the full prescribed weights", which is a
// data-integrity bug rather than a copy one. There is now a real third state
// - unanswered - and saveWod() refuses it outright, the same way saveSet()
// refuses a set with no movement chosen.
//
// Scenarios whose subject is something else entirely (EMOM shapes, the
// edit-navigation guard, the club catalogue) answer the question the way a
// member would and carry on. Rx=true is deliberate: it is what the removed
// default used to record, so every assertion those scenarios make about the
// stored entry keeps describing exactly the same data as before.
//
// A test that is ABOUT the choice itself should not use this - see
// test/wod-rx-choice.test.mjs, which drives the real toggle.
export function answerWodRx(window, rx = true) {
  window.setWodRx(rx);
}

export function waitFor(check, timeoutMs = 2000, intervalMs = 5) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let result;
      try { result = check(); } catch (e) { return reject(e); }
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(poll, intervalMs);
    })();
  });
}

// The admin panel's step-up lock (2026-09-15) asks for the password again
// before it renders, even for an account that is already signed in as admin.
// That is deliberate and is tested in test/admin-panel-step-up-lock.test.mjs.
//
// Every OTHER test that needs to look at an admin surface has to get past it,
// and does so HONESTLY - by seeding a credential on the mock and submitting
// the real form - rather than through a back door in production code. A test
// seam that skips the gate would mean the gate is never exercised on the path
// the other 1600 tests take, which is how a lock quietly stops working.
//
// Call BEFORE bootCommunity() to seed, then AFTER opening the admin panel to
// submit. Returns quietly if no gate is present, so a caller that lands on a
// club surface (which has no lock) needs no branch.
export const ADMIN_STEP_UP_PASSWORD = "Aa123456789!";
// The management account's address. A fixed, obviously-fake value: the real
// one lives only in Supabase Auth and must never appear in this repo, which
// GitHub Pages serves in full to anyone who asks.
export const ADMIN_STEP_UP_EMAIL = "manage@example.test";
export function seedAdminStepUp(mock, userId, email) {
  if (mock && typeof mock.seedCredentials === "function") {
    // Two addresses, one account. The caller's own (usually the member's
    // synthetic @members.haimuniya.invalid address) is registered because
    // some tests sign in with it directly; ADMIN_STEP_UP_EMAIL is registered
    // as well so unlockAdminPanel() can open the gate with no argument.
    //
    // That both resolve to the same user is a property of the FIXTURE, not of
    // the app: here the member and the management account happen to be one
    // person, which keeps the ~150 existing panel tests reading as they did.
    // The app itself never assumes it - the separation is asserted directly
    // in admin-panel-step-up-lock.test.mjs, where they are different accounts.
    if (email) mock.seedCredentials(userId, email, ADMIN_STEP_UP_PASSWORD);
    mock.seedCredentials(userId, ADMIN_STEP_UP_EMAIL, ADMIN_STEP_UP_PASSWORD);
  }
  return mock;
}
export async function unlockAdminPanel(window, email) {
  // Both management panels are locked (2026-09-15) and share one form id; the
  // panel it belongs to is in data-panel. Callers do not need to care - this
  // submits whichever gate is on screen.
  //
  // The gate asks for an EMAIL as well as a password, because management is a
  // separate identity from the member using the app - it is not a re-check of
  // whoever is signed in. Defaults to ADMIN_STEP_UP_EMAIL, the address
  // seedAdminStepUp() registers by default; pass one explicitly to model a
  // different management account, or a wrong one.
  const form = window.document.getElementById("panelUnlock");
  if (!form) return false; // not a management panel, or already unlocked
  form.elements.email.value = email || ADMIN_STEP_UP_EMAIL;
  form.elements.password.value = ADMIN_STEP_UP_PASSWORD;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  return true;
}
