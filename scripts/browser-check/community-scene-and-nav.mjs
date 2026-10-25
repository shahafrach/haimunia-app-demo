#!/usr/bin/env node
// The Community tab's chrome, measured in a real engine at 390x844 — the
// phone the club actually uses — and re-measured at 1440 as the member-
// layout regression guard CLAUDE.md asks for.
//
// WHY THIS SCRIPT EXISTS. The finding it covers is pure geometry, and jsdom
// reports every rect as 0x0 at (0,0):
//
//   1. THE WORDMARK APPEARED TWICE. The community scene photo is the club's
//      logo wall, and the painted "האימוניה" on it landed at y=54-100 —
//      directly under the fixed header's own ./assets/logo-full.png at
//      y=20-50. Sixty pixels apart, same word, twice. Community now takes
//      its own framing of the same photograph, below the paint. That claim
//      is checked HERE BY READING PIXELS, not by reading the stylesheet:
//      the script paints the band twice in the same run — once with the
//      shared crop every other scene uses, once with Community's own — and
//      counts near-white pixels on the red wall. The wall is a saturated
//      orange-red and the lettering is off-white, so the wordmark is a
//      light-pixel cluster and its absence is a number, not an opinion.
//      A self-calibrating check: it proves the difference it claims to
//      make, rather than asserting a threshold nobody can re-derive.
//
// The feed scope filter and the undo-on-delete toast that this script used to
// measure went with the feed in the strip-gym change; the wordmark check and
// the 1440 member-layout guard stay.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const BASE = Date.now() - 5 * 60000;
const at = (min) => new Date(BASE - min * 60000).toISOString();

// One post, owned by the caller, so the ⋯ menu offers delete and the undo
// toast can be driven for real.
const OWN_POST = {
  id: "p1", post_type: "POST_TEXT", author_id: "u1",
  author: { display_name: "דנה", handle: "dana" },
  body: "בוקר טוב, סיימתי את האימון",
  visibility: "club", created_at: at(3), published_at: at(3),
  reaction_count: 0, comment_count: 0, media: [], metadata: {},
};

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  ],
  invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  feed_page_rows: [OWN_POST],
  attendance_log: [{ user_id: "u1", occurred_on: TODAY, recorded_at: VERIFIED }],
  post_comments: [], private_records: [], follows: [], blocks: [], analytics_events: [],
  notifications: [], notification_preferences: [], saved_posts: [], hidden_posts: [],
  reactions: [], feed_impressions: [], feed_interactions: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();

async function openCommunity(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = await consoleErrorCollector(page);
  await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
  await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector("#communityHead", { timeout: 10000 });
  await page.waitForTimeout(400);
  return { page, errors };
}

// ===========================================================================
// 390px — the phone.
// ===========================================================================
console.log("\n--- 390px ---");
const { page, errors } = await openCommunity(390, 844);

// ---- 1. the wordmark, counted in pixels ----------------------------------
//
// The band sampled starts at y=66, the first row below the fixed 64px header
// (the safe-area inset is 0 in a desktop Chromium viewport), so the header's
// own white logo is never in frame — what is counted is the photograph and
// nothing else. 60 rows is the band the wall's lettering occupies under the
// shared crop, narrowed until the only thing inside it is wall: any deeper
// reaches the wooden floor, which is light enough to swamp the signal.
// The wall's paint is saturated red-orange (roughly #d33 to #f60 once the
// scrim is applied) and the lettering is a flat off-white, so "near-white"
// is all three channels over 190 with very little spread between them —
// which no part of a red wall under a dark scrim reaches, and which every
// glyph of the wordmark does.
const BAND = { x: 0, y: 66, width: 390, height: 60 };

async function countLightPixels() {
  const shot = await page.screenshot({ clip: BAND });
  // Decoded in the page rather than with an image library: Chromium already
  // has a PNG decoder, and this script must not grow a dependency to read
  // its own screenshot.
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let light = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
      if (min > 190 && max - min < 40) light++;
    }
    return { light, total: c.width * c.height };
  }, shot.toString("base64"));
}

const shipped = await countLightPixels();

// Now paint the SAME band with the crop every other scene page uses — the
// one Community had until this change — and count again. Nothing else on
// the page moves: this overrides two background properties on one pseudo
// element and is reverted immediately afterwards.
await page.addStyleTag({
  content: `.scene-page--community .scene-page__media::after{ background-size:auto max(450px, 54svh) !important; background-position:center top !important; }`,
});
await page.waitForTimeout(250);
const asBefore = await countLightPixels();
await page.evaluate(() => { const t = document.head.querySelectorAll("style"); t[t.length - 1].remove(); });
await page.waitForTimeout(250);
const restored = await countLightPixels();

// Measured on this build: 652 near-white pixels with the shared crop, 0 with
// Community's own. The bounds are wide on purpose - the claim is "the
// lettering is in frame" versus "it is not", not a pixel count anyone should
// have to reproduce to the unit.
check(
  "the shared crop really does put the wall's wordmark in the band under the header (the finding, reproduced)",
  asBefore.light > 250,
  `${asBefore.light} near-white px of ${asBefore.total}`,
);
check(
  "Community's own crop frames the photo below the paint — the wordmark is gone from the band",
  shipped.light < 60 && shipped.light < asBefore.light / 10,
  `${shipped.light} near-white px vs ${asBefore.light} with the shared crop`,
);
check("and removing the override puts the measurement back where it was", Math.abs(restored.light - shipped.light) <= 40, `${restored.light} vs ${shipped.light}`);

// The photo still has to FILL the band it was re-framed inside: a crop that
// clears the wordmark by leaving navy where the photo should be is not a fix.
const fills = await page.evaluate(() => {
  const media = document.querySelector(".scene-page__media");
  const after = getComputedStyle(media, "::after");
  const h = parseFloat(after.backgroundSize.split(" ").pop());
  const y = parseFloat(after.backgroundPosition.split(" ").pop());
  const sheetTop = document.querySelector(".scene-sheet").getBoundingClientRect().top;
  return { h, y, sheetTop, covers: h + y >= sheetTop, skipped: -y / h };
});
check("the re-framed photo still covers the whole visible band, down to the sheet", fills.covers, JSON.stringify(fills));
check("and it skips at least the top quarter of the source frame, where the paint is", fills.skipped >= 0.25, String(fills.skipped.toFixed(3)));

check("no console errors on the community tab", errors.length === 0, errors.join(" | "));

// ===========================================================================
// 1440px — the member-layout regression guard.
// ===========================================================================
console.log("\n--- 1440px ---");
{
  const { page: wide, errors: wideErrors } = await openCommunity(1440, 900);
  const geo = await wide.evaluate(() => {
    const app = document.getElementById("app").getBoundingClientRect();
    const head = document.getElementById("communityHead").getBoundingClientRect();
    return {
      appW: +app.width.toFixed(1),
      inside: head.right <= app.right + 0.5 && head.left >= app.left - 0.5,
      staff: document.documentElement.getAttribute("data-staff"),
    };
  });
  // CLAUDE.md: member layouts on desktop must not change. Nothing about the
  // shell may key on the laptop at all, and the account head must stay inside
  // the same column it occupies on the phone.
  check("a member at 1440 is not in a staff shell", geo.staff === null, JSON.stringify(geo.staff));
  check("the account head stays inside the member column at 1440", geo.inside, JSON.stringify(geo));
  check("no console errors at 1440", wideErrors.length === 0, wideErrors.join(" | "));
}

await browser.close();
await target.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
