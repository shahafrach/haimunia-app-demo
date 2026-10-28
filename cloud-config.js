// ⚠ THIS FILE POINTS AT PRODUCTION, AND IT IS COMMITTED.
// The URL below is a live Supabase project with real members' data, and this
// file is what Cloudflare Pages serves. Repointing it at localhost for
// testing and committing that aims every installed PWA at a machine that is
// not there. To test locally, override it at RUNTIME instead - serve a copy,
// or set window.HAIMUNIA_CONFIG before this script loads - and leave the
// tracked file alone.
//
// Public browser configuration only. The publishable key is intentionally
// safe to ship when every exposed table is protected by RLS. Never put a
// Supabase secret/service-role key in this repository.
window.HAIMUNIA_CONFIG = Object.freeze({
  supabaseUrl: "https://hvwakffluwvegedefoth.supabase.co",
  supabasePublishableKey: "sb_publishable_MRSX0PLMZjoDIX4iuDbI2g_G2EdMRu6",
  // THE ONE PLACE THE CLIENT READS THE VAPID PUBLIC KEY (base64url, the
  // uncompressed EC point 0x04 || X || Y that PushManager.subscribe wants as
  // applicationServerKey). A public key is meant to be exposed to the browser;
  // the private half is a Supabase Edge Function secret and is in no file.
  //
  // IT IS A PLACEHOLDER UNTIL THE ROTATE-VAPID WORKFLOW HAS RUN. The key that
  // used to be here belonged to the deleted Supabase project. To fill it in:
  // run the "rotate-vapid" workflow (Actions, workflow_dispatch), copy the
  // public key from that run's job summary over the placeholder below, commit,
  // deploy. The private key is generated on the runner and set as the Edge
  // Function secret there; no person or session ever sees it.
  //
  // WHILE THIS IS THE PLACEHOLDER (or anything that is not a 65-byte P-256
  // point) THE CLIENT FAILS CLOSED: it makes no subscribe attempt, does not
  // ask for notification permission, and says push is not set up yet.
  //
  // CHANGING THIS VALUE INVALIDATES EVERY EXISTING SUBSCRIPTION: a
  // PushSubscription is bound to the key it was created with. The client
  // notices a subscription made under another key and re-subscribes.
  notifPushVapidPublicKey: "BLhw6lvS2RbwEFSLw1HuHyCqfrdpGFzxvOa-M8fT6J0liZBSHsC5cfWWArpBUVZ0UNnpeuHp6gUlyAYcqedDQ7o",

  // Launch-readiness audit, SEC-004: bot protection on account creation.
  //
  // Anonymous sign-in is enabled (it is how every signup bootstraps - see
  // COMMUNITY_SETUP.md "Sign-in has no email"), so without a CAPTCHA an
  // attacker can mint unlimited free `authenticated` identities in a loop.
  // That is the raw material for feed scraping, telemetry/storage flooding
  // and invite-code guessing at scale.
  //
  // A SITE KEY IS PUBLIC by design - it is meant to ship in the browser,
  // exactly like supabasePublishableKey above. The matching SECRET key is
  // never in this repo: it goes in the Supabase dashboard only
  // (Authentication -> Bot and Abuse Protection), which is what actually
  // verifies the token server-side.
  //
  // LEAVE THIS EMPTY STRING to keep CAPTCHA off. The client treats "" as
  // "not configured" and behaves exactly as it did before this feature
  // existed, so a project that has not enabled it in the dashboard yet is
  // not broken by this file. Turning it on is: set the provider + secret
  // in the dashboard, paste the site key here, deploy.
  // See COMMUNITY_SETUP.md "CAPTCHA on sign-up" for the full runbook.
  // DECISION (2026-09-07): staying OFF. The owner declined a third-party
  // CAPTCHA provider, and the measurement backed it: an account that signs up
  // but never redeems an invite can read nothing (posts and profiles are
  // gated on is_community_member(); comments/reactions/media inherit that
  // gate through post_visible_to_viewer(), which is SECURITY INVOKER) and
  // write nothing. Redemption is rate-limited to 5 tries / 15 min. What is
  // left is empty auth.users rows - a quota nuisance, not a leak.
  //
  // REVERSED (2026-09-17), before going live. The analysis above is still
  // correct and is exactly why this was never urgent - it is a quota and
  // abuse problem, not a leak. What changed is the cost of the other side:
  // Turnstile is free, the client was already built and tested, and the CSP
  // already carries the provider host, so turning it on is one field rather
  // than a project. Opening the club to real members is the moment to stop
  // leaving a free identity factory running.
  //
  // The site key below is Cloudflare Turnstile, Managed mode, scoped to the
  // hostname box-log.pages.dev. A CUSTOM DOMAIN WOULD NEED ADDING TO
  // THAT WIDGET'S HOSTNAME LIST - the same third place a new origin has to
  // be registered, alongside the CSP in index.html and ALLOWED_ORIGINS in
  // admin_reset_password.
  //
  // ORDER MATTERS IF THIS IS EVER RE-DONE: deploy the site key FIRST, then
  // enable enforcement in the Supabase dashboard. Backwards, the server
  // demands a token the client is not sending yet and every signup fails.
  captchaProvider: "turnstile", // Turnstile is the only provider
  captchaSiteKey: "0x4AAAAAAE6mfjw79idh0ptH",

  // Support and bug reporting (2026-09-15), added after the first real-phone
  // session produced four "not working" reports that had no route back into
  // the app - they reached the developer only because the tester happened to
  // be the owner. A member without that channel had nowhere to put them.
  //
  // WHY A HANDOFF AND NOT A TABLE. Reporting a bug is exactly the moment the
  // app may be the broken thing: a Supabase insert needs a working client, a
  // network, a session and an intact RLS path, which is a lot of machinery to
  // trust while the member is telling you something is wrong. WhatsApp is
  // this club's actual channel (99% penetration, its own research in
  // docs/community/contracts.md) and it retries, queues offline and leaves
  // the member holding a copy of what they sent. The report is composed
  // locally, so it works with no network and with Community switched off
  // entirely - which is most of this app's surface.
  //
  // Both are optional. Leave a value empty and the app simply does not offer
  // that route; leave BOTH empty and the reporter still gets the "copy the
  // report" fallback, so the feature is never a dead end.
  //
  // supportWhatsApp: international format, digits only, no + and no spaces
  // (this is wa.me's own required shape). Israeli mobile 05X-XXX-XXXX becomes
  // 9725XXXXXXXX.
  supportWhatsApp: "",
  // TODO(owner): this is still the former gym's inbox and must be replaced with
  // a BOX-LOG address. It is not blank only because
  // test/support-and-bug-report.test.mjs requires one real support channel.
  // This file is public by construction, so use an address meant to be written to.
  supportEmail: "haimuniya@gmail.com",

  // ==========================================================================
  // BRANDING. The product name, for a second club.
  //
  // THE CLUB'S OWN NAME IS NOT HERE, and must not be added. It lives in the
  // `clubs` table and is read at runtime - inviteShareText() already does
  // exactly this: `הצטרפות ל${club} באפליקציית ${appName}`, where the club
  // comes from the database and only the app name is fixed. Two different
  // things, and conflating them is how a config ends up with a value that
  // contradicts the database.
  //
  // So this is the PRODUCT name: what the app calls itself on the home screen,
  // in its title bar, and in a push notification. BOX-LOG is the name
  // everywhere a member sees one.
  // ==========================================================================
  brand: Object.freeze({
    appName: "BOX-LOG",
    // Used where the name stands alone as a wordmark, and in push titles.
    // Kept separate from appName only so a latin-script deployment can drop
    // the definite article a Hebrew name might carry; set it to the same
    // string when there is no difference.
    wordmark: "BOX-LOG",
    // The top athlete level and the capstone achievement both read "אלוף
    // <name>" today. It is spelled out rather than composed, because "אלוף " +
    // appName is right for a club name and wrong for a product one - a member
    // of another circle is the champion of THEIR circle, not of the software.
    championTitle: "אלוף BOX-LOG",
  }),

  // ==========================================================================
  // NOT CONFIGURABLE, AND HERE SO NOBODY MAKES THEM SO.
  //
  // Both of these look exactly like branding, appear ~40 times between them,
  // and changing either on a LIVE club destroys data. They are listed rather
  // than omitted because the next person setting up a second club will grep
  // for "haimunia", find them, and reasonably assume they belong in this file.
  //
  //   haimunia-demo:            the localStorage key prefix, ~38 uses.
  //                             Every member's training log, their settings and
  //                             their outbox live under it. Change it on a live
  //                             deployment and every phone silently starts
  //                             empty, with the real data still on disk under
  //                             the old prefix and nothing reading it.
  //
  //   members.haimuniya.invalid the synthetic email domain, 3 uses. Logins are
  //                             username-only, and usernameToEmail() maps a
  //                             handle onto this domain to make a Supabase auth
  //                             identity. Those addresses are already written
  //                             into auth.users. Change it and every existing
  //                             member is locked out - not degraded, locked
  //                             out, with no self-service reset because the
  //                             addresses were never deliverable.
  //
  // A genuinely NEW club, with no members and no local data yet, may pick its
  // own values for both by editing them at source - before anyone signs in.
  // After that they are permanent.
  //
  // window.haimunia* (6 names) is not branding at all: it is the interface
  // between app.js and cloud.js. Renaming it changes nothing a member sees.
  // ==========================================================================
});
