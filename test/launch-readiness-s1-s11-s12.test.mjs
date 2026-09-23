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

test("S1: a legacy post photo that fails to load is evicted and re-signed, with a non-empty alt", async () => {
  const VERIFIED = new Date().toISOString();
  const profiles = [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
  ];
  const mock = createMockSupabase({
    profiles,
    invite_redemptions: profiles.map((p) => ({ user_id: p.id, invite_id: "inv-1", role: "member", redeemed_at: VERIFIED })),
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    // No post_type: this is a legacy workout_posts row, the one card that
    // still reads photo_path rather than `media`.
    feed_page_rows: [{
      id: "p-legacy", author_id: "u2", author: { display_name: "נועם", handle: "noam" },
      title: "Fran", result_text: "4:21", photo_path: "u2/legacy.jpg", visibility: "club",
      created_at: VERIFIED, published_at: VERIFIED, reaction_count: 0, comment_count: 0,
    }],
    reactions: [], post_comments: [], follows: [], blocks: [], hidden_posts: [], saved_posts: [],
    attendance_log: [], feed_impressions: [], feed_interactions: [], analytics_events: [],
    club_wod_board_rows: [], community_streaks: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();

  // The legacy card carries no data-post-id; the image is keyed by its path.
  const photo = () => window.document.querySelector('img.post-photo[data-k="u2/legacy.jpg"]');
  await waitFor(() => photo(), 4000);
  const img = photo();
  assert.equal(img.getAttribute("onerror"), null, "no inline handler");
  assert.equal(img.dataset.evict, "photo");
  assert.equal(img.dataset.k, "u2/legacy.jpg");
  assert.equal(img.getAttribute("alt"), "Fran", "the photo is described by the post's title, not alt=\"\"");

  // An expired signature: the browser fires `error` on the <img>. It does
  // not bubble - only a capture-phase document listener sees it. The
  // eviction drops the cache entry and re-renders; the card then re-signs,
  // so a fresh <img> element replaces the broken one.
  img.dispatchEvent(new window.Event("error", { bubbles: false }));
  await waitFor(() => photo() && photo() !== img, 4000);
  assert.equal(photo().dataset.k, "u2/legacy.jpg", "the replacement is the same photo, freshly signed");

  // Once per path: a photo that fails again, freshly signed, is evicted and
  // left for the next feed load rather than re-signed in a loop.
  const second = photo();
  second.dispatchEvent(new window.Event("error", { bubbles: false }));
  await waitFor(() => !photo(), 4000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(photo(), null, "no second re-sign for the same path");
});

test("S1: the global evict hook is gone - nothing left for an inline handler to call", () => {
  for (const f of ["cloud.js", "src/community/posts.js", "app.js"]) {
    assert.doesNotMatch(read(f), /__haimuniaEvictSignedUrl/, `${f}`);
  }
  assert.match(read("src/community/posts.js"),
    /document\.addEventListener\("error", \(event\) => \{[\s\S]*?evictSignedUrl\(img\.dataset\.evict, img\.dataset\.k\);[\s\S]*?\}, true\);/,
    "a capture-phase listener, because `error` does not bubble");
});

// ===== S11 ================================================================

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

test("S12: admin_reset_password no longer allows the retired github.io origin", () => {
  const ts = read("supabase/functions/admin_reset_password/index.ts");
  const set = ts.match(/const ALLOWED_ORIGINS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(set, "ALLOWED_ORIGINS must still be an explicit set");
  const origins = [...set[1].matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  assert.deepEqual(origins, ["https://haimunia-app.pages.dev", "http://localhost:3000", "http://127.0.0.1:3000"]);
  assert.ok(!origins.some((o) => /github\.io/.test(o)), "no github.io origin");
});

test("S12: no Edge Function allows a github.io origin", () => {
  const fns = readdirSync(new URL("supabase/functions/", root), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`supabase/functions/${d.name}/index.ts`, root)))
    .map((d) => d.name);
  assert.ok(fns.includes("admin_reset_password"), "the directory scan must find the functions");
  for (const f of fns) {
    const code = read(`supabase/functions/${f}/index.ts`).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /github\.io/, `${f} must not reference github.io outside comments`);
  }
});
