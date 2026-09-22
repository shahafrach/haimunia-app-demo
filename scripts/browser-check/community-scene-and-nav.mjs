#!/usr/bin/env node
// The Community tab's chrome, measured in a real engine at 390x844 — the
// phone the club actually uses — and re-measured at 1440 as the member-
// layout regression guard CLAUDE.md asks for.
//
// WHY THIS SCRIPT EXISTS. Two of the three findings it covers are pure
// geometry, and jsdom reports every rect as 0x0 at (0,0):
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
//   2. THREE STACKED NAVIGATION LAYERS. The bottom bar, the community
//      sub-tabs, and the feed scope chips — 96px of chips, because four
//      Hebrew labels wrap onto two lines. The scopes are a filter rather
//      than a destination, so they collapsed into one <select> riding the
//      "הפיד שלי" section head. What is measured is that there are two
//      full-width nav rails left and not three, that the filter shares a
//      row with the heading instead of occupying one of its own, and that
//      no scope label truncates inside it — the reason a rail was tempting
//      in the first place.
//
// The third finding (undo on community deletes) is behaviour, and it is
// pinned in test/community-delete-undo.test.mjs. Only its one geometric
// claim is here: the toast has to appear over the scene without covering
// the bottom bar it floats above.
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
  // Above the desktop breakpoint the hamburger is gone and the sidebar is
  // the only nav, same distinction desktop-layout.mjs and
  // community-feed-social.mjs already make and for the same reason.
  const onSidebar = await page.locator("#desktopSidebar").isVisible();
  if (onSidebar) await page.click("#desktopSidebar .navrow[data-tab='community']");
  else await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector('[data-post-id="p1"]', { timeout: 10000 });
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

// ---- 2. two navigation layers, not three ---------------------------------
const nav = await page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const app = document.getElementById("app").getBoundingClientRect();
  // A "rail" here means what the finding meant: a full-width horizontal
  // strip of sibling controls that exists to move you somewhere. The bottom
  // bar and the community sub-tab bar are the two; anything else that spans
  // the column and holds three or more sibling buttons would be a third.
  const rails = [...document.querySelectorAll("#bottomTabBar, .subtabbar, .chip-row[role='tablist']")]
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => ({ sel: el.id ? "#" + el.id : el.className, ...r(el) }));
  const head = document.querySelector("#communityFeedTop .ach-section-head");
  const title = head && head.querySelector(".ach-section-title");
  const filter = document.getElementById("communityFeedFilters");
  const firstCard = document.querySelector('[data-post-id="p1"]');
  return {
    rails,
    tag: filter && filter.tagName,
    filterRect: filter && r(filter),
    titleRect: title && r(title),
    sameRow: !!(filter && title) && Math.abs((filter.getBoundingClientRect().top + filter.getBoundingClientRect().height / 2)
      - (title.getBoundingClientRect().top + title.getBoundingClientRect().height / 2)) < 8,
    insideColumn: !!filter && filter.getBoundingClientRect().right <= app.right + 0.5 && filter.getBoundingClientRect().left >= app.left - 0.5,
    firstCardTop: firstCard ? +firstCard.getBoundingClientRect().top.toFixed(1) : null,
  };
});
check("exactly two navigation rails are on screen, the bottom bar and the community sub-tabs", nav.rails.length === 2, JSON.stringify(nav.rails.map((x) => x.sel)));
check("the feed's scope filter is one control, not a rail of chips", nav.tag === "SELECT", String(nav.tag));
check("it rides the section head's own row rather than taking a row of its own", nav.sameRow, JSON.stringify({ filter: nav.filterRect, title: nav.titleRect }));
// 96px was the measured height of the two-line chip row this replaces.
check("and it is one line tall (<=56px, against the 96px the chips measured)", nav.filterRect && nav.filterRect.h <= 56, String(nav.filterRect && nav.filterRect.h));
check("a 44px tap target, like every other control on this screen", nav.filterRect && nav.filterRect.h >= 44, String(nav.filterRect && nav.filterRect.h));
check("it stays inside the app column", nav.insideColumn);

// Every scope still reachable, and none of them truncated inside the control
// — truncation is the failure a dropdown trades a rail for, so it is checked
// rather than assumed.
const scopes = await page.evaluate(() => {
  const sel = document.getElementById("communityFeedFilters");
  const out = [];
  const before = sel.value;
  for (const o of sel.options) {
    sel.value = o.value;
    out.push({ value: o.value, label: o.textContent, fits: sel.scrollWidth <= sel.clientWidth + 1 });
  }
  sel.value = before;
  return out;
});
check("all four scopes are offered, in order", JSON.stringify(scopes.map((s) => s.value)) === JSON.stringify(["for_you", "following", "achievements", "coach"]), JSON.stringify(scopes.map((s) => s.value)));
check("and no scope label is clipped by the control", scopes.every((s) => s.fits), JSON.stringify(scopes.filter((s) => !s.fits)));

// Choosing one actually filters: the control is navigation-equivalent to the
// chips it replaced, not a decoration.
await page.selectOption("#communityFeedFilters", "achievements");
await page.waitForFunction(() => {
  const p = document.getElementById("communityFeedPanel");
  return p && /הישגים/.test(p.getAttribute("aria-label") || "");
}, null, { timeout: 5000 });
check("choosing a scope switches the feed region it names", true);
await page.selectOption("#communityFeedFilters", "for_you");
await page.waitForSelector('[data-post-id="p1"]', { timeout: 5000 });

// ---- 3. the undo toast, where it has to sit ------------------------------
await page.click('[data-post-id="p1"] [data-community-action="toggle-post-menu"]');
await page.waitForSelector('[data-post-id="p1"] .post-menu', { timeout: 5000 });
await page.click('[data-community-action="post-delete"]');
await page.waitForSelector('[data-community-action="confirm-yes"]', { timeout: 5000 });
await page.click('[data-community-action="confirm-yes"]');
await page.waitForSelector("#appToastBar", { timeout: 5000 });
const toast = await page.evaluate(() => {
  const bar = document.getElementById("appToastBar");
  const inner = bar.firstElementChild;
  const undo = bar.querySelector('[data-action="toast-action"]');
  const tabbar = document.querySelector("#bottomTabBar").getBoundingClientRect();
  const b = inner.getBoundingClientRect();
  return {
    text: (bar.textContent || "").trim(),
    undo: undo ? (undo.textContent || "").trim() : null,
    clearsTabBar: b.bottom <= tabbar.top + 0.5,
    inViewport: b.top >= 0 && b.bottom <= window.innerHeight + 0.5,
    postGone: document.querySelector('[data-post-id="p1"]') === null,
  };
});
check("deleting your own post removes it and offers an undo", toast.postGone && toast.undo === "בטלו", JSON.stringify(toast));
check("the toast floats clear of the bottom bar it sits above", toast.clearsTabBar && toast.inViewport, JSON.stringify(toast));
await page.click('#appToastBar [data-action="toast-action"]');
await page.waitForSelector('[data-post-id="p1"]', { timeout: 5000 });
check("and tapping בטלו puts the post back on the feed", true);

check("no console errors on the community tab", errors.length === 0, errors.join(" | "));

// ===========================================================================
// 1440px — the member-layout regression guard.
// ===========================================================================
console.log("\n--- 1440px ---");
{
  const { page: wide, errors: wideErrors } = await openCommunity(1440, 900);
  const geo = await wide.evaluate(() => {
    const app = document.getElementById("app").getBoundingClientRect();
    const filter = document.getElementById("communityFeedFilters").getBoundingClientRect();
    const head = document.querySelector("#communityFeedTop .ach-section-head").getBoundingClientRect();
    return {
      appW: +app.width.toFixed(1), appX: +app.x.toFixed(1),
      filterW: +filter.width.toFixed(1), filterH: +filter.height.toFixed(1),
      inside: filter.right <= app.right + 0.5 && filter.left >= app.left - 0.5,
      onHeadRow: Math.abs((filter.top + filter.height / 2) - (head.top + head.height / 2)) < 8,
      staff: document.documentElement.getAttribute("data-staff"),
    };
  });
  // CLAUDE.md: member layouts on desktop must not change. This member is not
  // staff, so nothing about the shell may key on the laptop at all — and the
  // new control must stay inside the same column it occupies on the phone.
  check("a member at 1440 is not in the staff shell", geo.staff === null, JSON.stringify(geo.staff));
  check("the scope filter stays inside the member column at 1440", geo.inside, JSON.stringify(geo));
  check("and still rides the section head's row rather than a rail of its own", geo.onHeadRow, JSON.stringify(geo));
  check("no console errors at 1440", wideErrors.length === 0, wideErrors.join(" | "));
}

await browser.close();
await target.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
