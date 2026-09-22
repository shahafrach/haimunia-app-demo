#!/usr/bin/env node
// The social feed pass, measured in a real engine at the two widths that
// matter: 390px (the phone the club actually uses) and 1440px (a laptop).
//
// WHY THIS SCRIPT EXISTS AT ALL, given the node suite already covers the
// same feed. Everything this branch changed about the feed is a LAYOUT
// claim - media above text, a reaction pill and its summary on one line, a
// row of faces that scrolls sideways instead of pushing the feed down, a
// sticky pill that floats over the list, a composer row whose camera is a
// real tap target. jsdom reports every rect as 0x0 at (0,0), so a node test
// cannot fail on any of it; the only honest place to assert it is Chromium.
// See CLAUDE.md, "Verification": a claim about geometry that was not
// measured in Chromium is a guess.
//
// THE SECOND WIDTH IS A REGRESSION GUARD, not a feature check. CLAUDE.md's
// "Member layouts on desktop must not change" is the rule this pass was
// most able to break by accident: every new rule it adds is unprefixed, so
// a stray width or a flex row could widen a member surface at 1440px.
// desktop-layout.mjs and desktop-column-widths.mjs own the shell's own
// numbers; what is checked here is that the FEED's new furniture stays
// inside the same column at 1440 that it occupies at 390.
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

// One photo post with two comments and three reactions, one plain text post,
// and a classmate who trained today. Enough to put every new piece of
// furniture on the screen at once, which is the point: the rules are checked
// against each other, not one at a time on an otherwise empty feed.
const PHOTO_POST = {
  id: "p1", post_type: "POST_PHOTO", author_id: "u2",
  author: { display_name: "נועם", handle: "noam" },
  body: "בוקר טוב, סיימתי את האימון",
  visibility: "club", created_at: at(3), published_at: at(3),
  reaction_count: 3, comment_count: 2,
  media: [{ url: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", alt_text: "אימון" }],
  metadata: {},
};
const TEXT_POST = {
  id: "p2", post_type: "POST_TEXT", author_id: "u3",
  author: { display_name: "יעל", handle: "yael" },
  body: "מי בא לאימון של הערב?",
  visibility: "club", created_at: at(40), published_at: at(40),
  reaction_count: 0, comment_count: 0, media: [], metadata: {},
};

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
    { id: "u3", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  feed_page_rows: [PHOTO_POST, TEXT_POST],
  // `profiles` is seeded onto each row because the mock's select() is a
  // no-op - an embed is whatever the fixture already carries, the same
  // convention every post_comments fixture in this repo uses.
  reactions: [
    { post_id: "p1", user_id: "u3", kind: "cheer", created_at: at(2), profiles: { handle: "yael", display_name: "יעל", avatar_url: null } },
    { post_id: "p1", user_id: "u2", kind: "cheer", created_at: at(1), profiles: { handle: "noam", display_name: "נועם", avatar_url: null } },
    { post_id: "p1", user_id: "u1", kind: "cheer", created_at: at(0), profiles: { handle: "dana", display_name: "דנה", avatar_url: null } },
  ],
  post_comments: [
    { id: "c1", post_id: "p1", author_id: "u3", body: "כל הכבוד!", parent_comment_id: null, created_at: at(2), edited_at: null, deleted_at: null, status: "active" },
    { id: "c2", post_id: "p1", author_id: "u1", body: "מכה", parent_comment_id: null, created_at: at(1), edited_at: null, deleted_at: null, status: "active" },
  ],
  attendance_log: [{ user_id: "u2", occurred_on: TODAY, recorded_at: VERIFIED }],
  private_records: [], follows: [], blocks: [], analytics_events: [],
  notifications: [], notification_preferences: [], saved_posts: [], hidden_posts: [],
  feed_impressions: [], feed_interactions: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();

// The caller's own attendance row: what the private_records trigger would
// write server-side once they log. Seeded rather than driven - that pipeline
// is community-classmates-card.mjs's job and this script does not re-run it.
seedTables.attendance_log.push({ user_id: "u1", occurred_on: TODAY, recorded_at: VERIFIED });

async function openFeed(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = await consoleErrorCollector(page);
  await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
  await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  await dismissWelcomeModal(page);
  // Above the desktop breakpoint the hamburger is hidden and the sidebar is
  // the only nav, so switchTab()'s id-based route cannot reach the tab -
  // desktop-layout.mjs makes the same distinction and for the same reason
  // (the sidebar renders from the same getNavItems() registry without the
  // mobile ids, so it is reached through data-tab).
  const onSidebar = await page.locator("#desktopSidebar").isVisible();
  if (onSidebar) await page.click("#desktopSidebar .navrow[data-tab='community']");
  else await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector('[data-post-id="p1"]', { timeout: 10000 });
  return { page, errors };
}

const rect = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
}, sel);

// ===========================================================================
// 390px — the phone.
// ===========================================================================
console.log("\n--- 390px ---");
{
  const { page, errors } = await openFeed(390, 844);

  // ---- ONE CARD: media above text, above the result block ----------------
  const order = await page.evaluate(() => {
    const card = document.querySelector('[data-post-id="p1"]');
    const img = card.querySelector("img.post-photo");
    const body = card.querySelector(".post-body");
    if (!img || !body) return null;
    return { imgTop: img.getBoundingClientRect().top, bodyTop: body.getBoundingClientRect().top };
  });
  check("the photo is painted above the text on a photo post", !!order && order.imgTop < order.bodyTop, JSON.stringify(order));

  // ---- the type tag is on the head, not glued to the timestamp -----------
  const tag = await page.evaluate(() => {
    const t = document.querySelector('[data-post-id="p1"] .post-type-tag');
    const time = document.querySelector('[data-post-id="p1"] .post-time');
    if (!t || !time) return null;
    const tr = t.getBoundingClientRect(), mr = time.getBoundingClientRect();
    // Same line (the tag sits on the time row), and it is a real pill: it has
    // its own painted background box, which a `· word` never had.
    return { text: t.textContent.trim(), sameLine: Math.abs((tr.top + tr.height / 2) - (mr.top + mr.height / 2)) < 6, w: tr.width, h: tr.height };
  });
  check("the photo card carries a painted type tag on the head's time line", !!tag && tag.sameLine && tag.w > 0 && tag.h > 0, JSON.stringify(tag));

  // ---- nothing destructive left loose on the card ------------------------
  const loose = await page.evaluate(() => {
    const card = document.querySelector('[data-post-id="p1"]');
    const inMenu = (el) => !!el.closest(".post-menu");
    return [...card.querySelectorAll("[data-community-action]")]
      .filter((el) => ["post-hide", "post-save", "report", "post-delete", "post-edit-caption", "delete-post"].includes(el.getAttribute("data-community-action")))
      .filter((el) => !inMenu(el))
      .map((el) => el.getAttribute("data-community-action"));
  });
  check("hide, save, report, edit and delete are only ever inside the ⋯ menu", loose.length === 0, loose.join(","));

  // ---- the reaction pill and its summary, on one line --------------------
  const pillRow = await page.evaluate(() => {
    const pill = document.querySelector('[data-post-id="p1"] .reaction-pill');
    const sum = document.querySelector('[data-post-id="p1"] .reaction-summary');
    if (!pill || !sum) return null;
    const p = pill.getBoundingClientRect(), s = sum.getBoundingClientRect();
    return {
      icon: !!pill.querySelector("svg.reaction-icon"),
      count: (pill.textContent || "").trim(),
      summary: (sum.textContent || "").trim(),
      sameLine: Math.abs((p.top + p.height / 2) - (s.top + s.height / 2)) < 8,
      pillH: p.height,
    };
  });
  check("the reaction pill draws the dumbbell icon and its count", !!pillRow && pillRow.icon && pillRow.count === "3", JSON.stringify(pillRow));
  check("the summary names a member and sits on the same line as the pill", !!pillRow && pillRow.sameLine && /ועוד\s*2/.test(pillRow.summary), JSON.stringify(pillRow));
  check("the pill is a real tap target (>=28px tall)", !!pillRow && pillRow.pillH >= 28, String(pillRow && pillRow.pillH));

  // ---- tapping the summary lists who reacted -----------------------------
  await page.click('[data-post-id="p1"] .reaction-summary');
  await page.waitForSelector('[data-cloud-dialog="reactors"]', { timeout: 5000 });
  const reactors = await page.textContent('[data-cloud-dialog="reactors"]');
  check("tapping the summary opens the who-reacted sheet and names the reactors", /נועם/.test(reactors) && /יעל/.test(reactors), reactors.replace(/\s+/g, " ").slice(0, 120));
  const trapped = await page.evaluate(() => {
    const dlg = document.querySelector('[data-cloud-dialog="reactors"]');
    return !!dlg && dlg.contains(document.activeElement);
  });
  check("the sheet takes focus, like every other dialog in the registry", trapped);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-cloud-dialog="reactors"]', { state: "detached", timeout: 5000 });
  check("Escape closes it — it is in CLOUD_DIALOGS, not a one-off overlay", true);

  // ---- comments: the two latest, with time and a reply link --------------
  const comments = await page.evaluate(() => {
    const wrap = document.querySelector('[data-post-id="p1"] .comment-preview-wrap');
    if (!wrap) return null;
    const rows = [...wrap.querySelectorAll(".comment-preview .comment-row")];
    return {
      count: rows.length,
      replies: rows.filter((r) => r.querySelector('[data-community-action="comment-reply"]')).length,
      times: rows.filter((r) => /לפני|עכשיו/.test(r.textContent)).length,
      hasBox: !!wrap.querySelector("[data-comment-input]"),
    };
  });
  check("the two latest comments render under the card without opening the thread", !!comments && comments.count === 2, JSON.stringify(comments));
  check("each previewed comment carries a time and a reply link", !!comments && comments.replies === 2 && comments.times === 2, JSON.stringify(comments));
  check("an inline comment box sits at the bottom of the card", !!comments && comments.hasBox);

  // ...including on a post with no comments at all.
  const emptyBox = await page.evaluate(() => !!document.querySelector('[data-post-id="p2"] .comment-preview-wrap [data-comment-input]'));
  check("the comment box is on every card, not only on ones that already have a thread", emptyBox);

  // ---- "התאמנו היום" is a strip at the top of the feed -------------------
  const strip = await page.evaluate(() => {
    const s = document.querySelector('[data-classmates-today="ready"]');
    const firstCard = document.querySelector('[data-post-id="p1"]');
    const filters = document.getElementById("communityFeedFilters");
    if (!s || !firstCard || !filters) return null;
    const row = s.querySelector(".classmates-strip-row");
    return {
      aboveFeed: s.getBoundingClientRect().top < firstCard.getBoundingClientRect().top,
      aboveFilters: s.getBoundingClientRect().top < filters.getBoundingClientRect().top,
      h: s.getBoundingClientRect().height,
      scrolls: !!row && getComputedStyle(row).overflowX === "auto",
      follow: !!s.querySelector('[data-community-action="follow"]'),
      names: (s.textContent || "").trim(),
    };
  });
  check("the classmates strip is above the feed's own cards", !!strip && strip.aboveFeed, JSON.stringify(strip && strip.aboveFeed));
  check("it names the classmate, keeps its Follow control, and scrolls sideways rather than stacking", !!strip && /נועם/.test(strip.names) && strip.follow && strip.scrolls, JSON.stringify(strip));
  // 111px measured on this build: a 12px heading, a 44px face, its name and
  // the follow control. The bound is the claim ("it is a strip, and it is
  // not the height of a stacked list of rows"), not the measurement.
  check("and it is short — a strip, not the stacked card it replaced (<=130px)", !!strip && strip.h <= 130, String(strip && strip.h));

  // ---- the composer row --------------------------------------------------
  const composer = await page.evaluate(() => {
    const row = document.querySelector(".post-composer-row");
    const trigger = row && row.querySelector(".post-composer-trigger");
    const photo = row && row.querySelector('[data-community-action="open-composer-photo"]');
    if (!row || !trigger || !photo) return null;
    const t = trigger.getBoundingClientRect(), p = photo.getBoundingClientRect();
    return {
      prompt: (trigger.textContent || "").trim(),
      sameLine: Math.abs((t.top + t.height / 2) - (p.top + p.height / 2)) < 6,
      photoW: p.width, photoH: p.height,
      insideViewport: row.getBoundingClientRect().right <= window.innerWidth + 0.5,
    };
  });
  check('the composer row reads "מה עשית היום?"', !!composer && composer.prompt.includes("מה עשית היום?"), JSON.stringify(composer && composer.prompt));
  check("the photo button sits on the same line and is a 40px tap target", !!composer && composer.sameLine && composer.photoW >= 40 && composer.photoH >= 40, JSON.stringify(composer));

  // ---- the photo button opens the existing composer, with its picker -----
  await page.click('[data-community-action="open-composer-photo"]');
  await page.waitForSelector('[data-cloud-dialog="composer"]', { timeout: 5000 });
  const composerHasFileInput = await page.evaluate(() => !!document.querySelector('[data-cloud-dialog="composer"] [data-composer-file]'));
  check("it opens the SAME composer, with the module's one file input — no second upload path", composerHasFileInput);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-cloud-dialog="composer"]', { state: "detached", timeout: 5000 });

  // ---- a realtime post becomes a pill, and does not move the feed --------
  const beforeTop = (await rect(page, '[data-post-id="p1"]')).y;
  await page.evaluate(() => {
    window.__mock.emitRealtime("feed-posts", { eventType: "INSERT", new: { id: "p-live", author_id: "u3", post_type: "POST_TEXT" } });
  });
  await page.waitForSelector(".new-posts-pill", { timeout: 5000 });
  const afterTop = (await rect(page, '[data-post-id="p1"]')).y;
  const pillText = await page.textContent(".new-posts-pill");
  check("a post arriving over realtime shows as a pill", /פוסט חדש/.test(pillText), pillText.trim());
  check("and the card the member was reading did not move", Math.abs(afterTop - beforeTop) < 1, `${beforeTop} -> ${afterTop}`);
  const pillFloats = await page.evaluate(() => {
    const w = document.querySelector(".new-posts-pill-wrap");
    return w ? { position: getComputedStyle(w).position, h: w.getBoundingClientRect().height } : null;
  });
  check("the pill floats over the list rather than taking a row of its own", !!pillFloats && pillFloats.position === "sticky" && pillFloats.h === 0, JSON.stringify(pillFloats));

  // ---- no horizontal overflow anywhere on the feed -----------------------
  const overflow = await page.evaluate(() => {
    const w = window.innerWidth;
    const bad = [];
    for (const el of document.querySelectorAll("#content *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // An element inside a deliberately horizontally-scrolling row is
      // allowed to extend past the viewport; the ROW is what must not.
      if (el.closest(".classmates-strip-row, [style*='overflow-x']")) continue;
      if (r.right > w + 1 || r.left < -1) bad.push(`${el.className || el.tagName}@${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { docScroll: document.documentElement.scrollWidth, w, bad: bad.slice(0, 6) };
  });
  check("nothing on the feed overflows 390px horizontally", overflow.docScroll <= overflow.w + 1 && overflow.bad.length === 0, JSON.stringify(overflow));

  check("no console errors at 390px", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// 1440px — the laptop. A MEMBER, so CLAUDE.md's "member layouts on desktop
// must not change" is the thing under test.
// ===========================================================================
console.log("\n--- 1440px ---");
{
  const { page, errors } = await openFeed(1440, 900);

  const layout = await page.evaluate(() => ({
    layoutAttr: document.documentElement.getAttribute("data-layout"),
    staffAttr: document.documentElement.getAttribute("data-staff"),
  }));
  check("a member at 1440px gets no staff shell", layout.staffAttr !== "1", JSON.stringify(layout));

  const widths = await page.evaluate(() => {
    const pick = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : null; };
    return {
      card: pick('[data-post-id="p1"]'),
      composer: pick(".post-composer-row"),
      strip: pick(".classmates-strip"),
      section: pick("#communityFeedTop"),
    };
  });
  // The new furniture must live in the SAME column the feed already had -
  // the composer row, the classmates strip and a post card are all children
  // of #communityFeedTop and none of them may be wider than it.
  check("the composer row stays inside the feed column", widths.composer !== null && widths.composer <= widths.section, JSON.stringify(widths));
  check("the classmates strip stays inside the feed column", widths.strip !== null && widths.strip <= widths.section, JSON.stringify(widths));
  check("a post card stays inside the feed column", widths.card !== null && widths.card <= widths.section, JSON.stringify(widths));

  // Same three layout facts as at 390, re-measured: a rule that only holds
  // at phone width is a rule that will break on the first laptop.
  const wide = await page.evaluate(() => {
    const card = document.querySelector('[data-post-id="p1"]');
    const img = card.querySelector("img.post-photo");
    const body = card.querySelector(".post-body");
    const pill = card.querySelector(".reaction-pill");
    const sum = card.querySelector(".reaction-summary");
    const rowEls = [...document.querySelectorAll(".post-composer-row > *")].map((e) => e.getBoundingClientRect());
    return {
      mediaFirst: !!img && !!body && img.getBoundingClientRect().top < body.getBoundingClientRect().top,
      pillSameLine: !!pill && !!sum && Math.abs(pill.getBoundingClientRect().top - sum.getBoundingClientRect().top) < 12,
      // Vertical CENTRES, not tops: the two are different heights and the
      // row centres them, so comparing tops measures the height difference
      // rather than whether they wrapped.
      composerOneRow: rowEls.length >= 2 && Math.abs((rowEls[0].top + rowEls[0].height / 2) - (rowEls[1].top + rowEls[1].height / 2)) < 6,
      comments: card.querySelectorAll(".comment-preview .comment-row").length,
    };
  });
  check("media still comes first at 1440px", wide.mediaFirst, JSON.stringify(wide));
  check("the pill and its summary still share a line at 1440px", wide.pillSameLine, JSON.stringify(wide));
  check("the composer row is still one row at 1440px", wide.composerOneRow, JSON.stringify(wide));
  check("the two-comment preview is unchanged at 1440px", wide.comments === 2, String(wide.comments));

  const docScroll = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  check("no horizontal page scroll at 1440px", docScroll.s <= docScroll.w + 1, JSON.stringify(docScroll));

  check("no console errors at 1440px", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-feed-social: FAILED" : "\ncommunity-feed-social: all checks passed");
process.exit(failed ? 1 : 0);
