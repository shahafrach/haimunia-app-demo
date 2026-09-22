#!/usr/bin/env node
// The feed polish pass, measured on the phone it was reported from: 390x844,
// real Chromium, RTL.
//
// WHY THIS SCRIPT EXISTS AND NOT ANOTHER NODE TEST. Every defect this pass
// fixes was reported from a screenshot, and six of the seven are claims about
// GEOMETRY: a menu that opens past the left edge of the screen and has its
// items clipped, a badge that wraps to a second line, a name that wraps under
// a heavy underline, a primary button that drops onto its own row under every
// card, an icon that has to sit inside a field, a number that lands on the
// wrong side of the words it belongs to. jsdom reports every rect as 0x0 at
// (0,0), so a node test cannot fail on any of them - see CLAUDE.md,
// "Verification": a claim about geometry that was not measured in Chromium is
// a guess. The node suite (test/community-feed-polish.test.mjs) covers the
// half that is about MARKUP and behaviour; this covers the half that is about
// pixels.
//
// THE SEVENTH is the club-WOD card, and it is not geometry: it is who sees
// it. It is measured here anyway, in the same run and at the same width,
// because "a member sees nothing and a coach sees the card" is exactly the
// kind of claim that is easy to assert against the renderer and hard to be
// sure of against the app - two personas, one build, one viewport.
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
const at = (min) => new Date(Date.now() - min * 60000).toISOString();

// The author is a HEAD COACH with a long display name, on purpose: that is
// the worst case for the head row - the longest name this club can produce
// beside the longest badge the app can draw ("מאמן/ת ראשי/ת"), which is the
// exact pair that wrapped onto two lines in the screenshot.
const LONG_NAME = "יונתן בן-אברהם הכהן מזרחי";
const OWN_POST = {
  id: "p-own", post_type: "POST_TEXT", author_id: "u1",
  author: { display_name: "דנה", handle: "dana" },
  body: "בוקר טוב, סיימתי את האימון",
  visibility: "club", created_at: at(3), published_at: at(3),
  reaction_count: 1, comment_count: 2, media: [], metadata: {},
};
const COACH_POST = {
  id: "p-coach", post_type: "POST_TEXT", author_id: "u2",
  author: { display_name: LONG_NAME, handle: "yonatan" },
  body: "מי בא לאימון של הערב?",
  visibility: "club", created_at: at(40), published_at: at(40),
  reaction_count: 0, comment_count: 0, media: [], metadata: {},
};

const PROFILES = [
  { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true, in_leaderboards: true },
  { id: "u2", handle: "yonatan", display_name: LONG_NAME, is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true, in_leaderboards: true },
  { id: "u3", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true, in_leaderboards: true },
];

// u1 is the member this scenario signs in as; u2 is the head coach whose card
// carries the badge. The club has notifications and photos on, so the bell and
// the composer camera are both on screen to be looked at.
function baseTables(extra) {
  return Object.assign({
    profiles: PROFILES,
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "head_coach", redeemed_at: VERIFIED },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה", member_count: 12, unread_notifications: 2 }],
    feed_page_rows: [OWN_POST, COACH_POST],
    post_comments: [
      { id: "c1", post_id: "p-own", author_id: "u3", body: "כל הכבוד!", parent_comment_id: null, created_at: at(2), edited_at: null, deleted_at: null, status: "active" },
      { id: "c2", post_id: "p-own", author_id: "u2", body: "מכה", parent_comment_id: null, created_at: at(1), edited_at: null, deleted_at: null, status: "active" },
    ],
    reactions: [{ post_id: "p-own", user_id: "u3", kind: "cheer", created_at: at(2), profiles: { handle: "yael", display_name: "יעל", avatar_url: null } }],
    attendance_log: [], private_records: [], follows: [], blocks: [], analytics_events: [],
    notifications: [], notification_preferences: [], saved_posts: [], hidden_posts: [],
    feed_impressions: [], feed_interactions: [], community_streaks: [],
    club_wod_board_rows: [], club_wods: [],
  }, extra || {});
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);
const browser = await chromium.launch();

// 390x844 throughout. This whole script is about one screen size: the phone
// the defects were photographed on.
async function openFeed(tables, user, beforeTab) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = await consoleErrorCollector(page);
  await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
  await installMockCloud(page, tables, { user });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
  // Registered after navigation and before the Community tab is opened, the
  // same window every other scenario uses for an RPC the mock has no
  // built-in for: window.__mock exists as soon as navigation completes, and
  // nothing in the module has asked for anything yet.
  if (beforeTab) await page.evaluate(beforeTab);
  await dismissWelcomeModal(page);
  await switchTab(page, "tabCommunityBtn");
  await page.waitForSelector("#communityClubTop", { timeout: 10000 });
  return { page, errors };
}

// ===========================================================================
// ONE: the card itself — the menu, the name, the badge, the icons, the box.
// ===========================================================================
console.log("\n--- 390x844: the post card ---");
{
  const { page, errors } = await openFeed(baseTables(), { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  await page.waitForSelector('[data-post-id="p-coach"]', { timeout: 10000 });
  // The badge is drawn from member_roles(), which is fetched after the first
  // paint - wait for the role to land rather than racing it.
  await page.waitForSelector('[data-post-id="p-coach"] .badge-tag', { timeout: 10000 });

  // ---- 3. the author name: one line, ellipsed, not underlined ------------
  const nameBox = await page.evaluate(() => {
    const btn = document.querySelector('[data-post-id="p-coach"] .post-author');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    // One line: the painted box is no taller than a single line of this font.
    // scrollWidth > clientWidth is the ellipsis actually engaging.
    return {
      tag: btn.tagName, action: btn.getAttribute("data-community-action"),
      h: r.h || r.height, lineH: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4,
      decoration: cs.textDecorationLine, overflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
      truncated: btn.scrollWidth > btn.clientWidth + 1,
      right: r.right, left: r.left,
    };
  });
  check("the author name is still a profile link (a real button with view-profile)",
    !!nameBox && nameBox.tag === "BUTTON" && nameBox.action === "view-profile", JSON.stringify(nameBox && nameBox.action));
  check("it is not underlined", !!nameBox && nameBox.decoration === "none", JSON.stringify(nameBox && nameBox.decoration));
  check("it is one line high", !!nameBox && nameBox.h <= nameBox.lineH + 4, JSON.stringify(nameBox && { h: nameBox.h, lineH: nameBox.lineH }));
  check("a long name ellipses rather than wrapping", !!nameBox && nameBox.whiteSpace === "nowrap" && nameBox.overflow === "ellipsis" && nameBox.truncated, JSON.stringify(nameBox));

  // ---- 2. the role badge: one line, smaller, not underlined --------------
  const badge = await page.evaluate(() => {
    const b = document.querySelector('[data-post-id="p-coach"] .post-author-row .badge-tag');
    const nm = document.querySelector('[data-post-id="p-coach"] .post-author');
    if (!b || !nm) return null;
    const br = b.getBoundingClientRect(), nr = nm.getBoundingClientRect();
    const bs = getComputedStyle(b), ns = getComputedStyle(nm);
    return {
      text: b.textContent.trim(),
      lines: Math.round(br.height / (parseFloat(bs.lineHeight) || parseFloat(bs.fontSize) * 1.4)),
      h: br.height, decoration: bs.textDecorationLine, whiteSpace: bs.whiteSpace,
      size: parseFloat(bs.fontSize), nameSize: parseFloat(ns.fontSize),
      sameLine: Math.abs((br.top + br.height / 2) - (nr.top + nr.height / 2)) < 4,
      insideViewport: br.left >= -0.5 && br.right <= window.innerWidth + 0.5,
    };
  });
  check("the role badge renders on ONE line", !!badge && badge.lines <= 1 && badge.whiteSpace === "nowrap", JSON.stringify(badge));
  check("it is not underlined", !!badge && badge.decoration === "none", JSON.stringify(badge && badge.decoration));
  check("it is smaller than the name beside it, and on the same line",
    !!badge && badge.size < badge.nameSize && badge.sameLine && badge.insideViewport, JSON.stringify(badge));

  // ---- 1. the ⋯ menu: inside the viewport, inside the card, aligned ------
  const btnBox = await page.evaluate(() => {
    const b = document.querySelector('[data-post-id="p-coach"] [data-community-action="toggle-post-menu"]');
    const r = b.getBoundingClientRect();
    return { x: r.x, left: r.left, right: r.right, bottom: r.bottom, expanded: b.getAttribute("aria-expanded"), haspopup: b.getAttribute("aria-haspopup"), controls: b.getAttribute("aria-controls") };
  });
  check("the ⋯ button declares the menu it owns (aria-haspopup=menu + aria-controls)",
    btnBox.haspopup === "menu" && !!btnBox.controls && btnBox.expanded === "false", JSON.stringify(btnBox));

  await page.click('[data-post-id="p-coach"] [data-community-action="toggle-post-menu"]');
  await page.waitForSelector('[data-post-id="p-coach"] .post-menu', { timeout: 5000 });
  const menu = await page.evaluate(() => {
    const card = document.querySelector('[data-post-id="p-coach"]');
    const btn = card.querySelector('[data-community-action="toggle-post-menu"]');
    const m = card.querySelector(".post-menu");
    const cr = card.getBoundingClientRect(), br = btn.getBoundingClientRect(), mr = m.getBoundingClientRect();
    const items = [...m.querySelectorAll(".post-menu-item")].map((el) => {
      const r = el.getBoundingClientRect();
      // "Fully visible" is three separate facts: inside the window, inside
      // the menu's own painted box, and not clipped to zero by an ancestor's
      // overflow. The third is what #app's overflow-x:hidden was doing.
      return {
        label: el.textContent.trim(),
        inViewport: r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.width > 0 && r.height > 0,
        inMenu: r.left >= mr.left - 0.5 && r.right <= mr.right + 0.5,
        role: el.getAttribute("role"),
      };
    });
    return {
      menuLeft: mr.left, menuRight: mr.right, menuW: mr.width,
      cardLeft: cr.left, cardRight: cr.right,
      btnLeft: br.left, btnRight: br.right, btnBottom: br.bottom,
      winW: window.innerWidth,
      inViewport: mr.left >= -0.5 && mr.right <= window.innerWidth + 0.5,
      inCard: mr.left >= cr.left - 0.5 && mr.right <= cr.right + 0.5,
      // RTL: the button is at the card's inline-END (its left edge), so the
      // menu is anchored on the same edge and grows back into the card.
      alignedToButton: Math.abs(mr.left - br.left) <= 1,
      below: mr.top >= br.bottom - 1,
      items,
      expanded: btn.getAttribute("aria-expanded"),
      role: m.getAttribute("role"),
      labelled: !!m.getAttribute("aria-labelledby"),
      focusedFirstItem: document.activeElement === m.querySelector(".post-menu-item"),
    };
  });
  check("the menu opens INSIDE the viewport — nothing past the left edge",
    menu.inViewport, `menu ${menu.menuLeft.toFixed(1)}..${menu.menuRight.toFixed(1)} in 0..${menu.winW}`);
  check("and inside the card it belongs to",
    menu.inCard, `menu ${menu.menuLeft.toFixed(1)}..${menu.menuRight.toFixed(1)} vs card ${menu.cardLeft.toFixed(1)}..${menu.cardRight.toFixed(1)}`);
  check("it is aligned to the ⋯ button and hangs below it",
    menu.alignedToButton && menu.below, JSON.stringify({ menuLeft: menu.menuLeft, btnLeft: menu.btnLeft, below: menu.below }));
  check("every item is fully visible — none clipped",
    menu.items.length > 0 && menu.items.every((i) => i.inViewport && i.inMenu),
    JSON.stringify(menu.items.map((i) => [i.label, i.inViewport, i.inMenu])));
  check("it is a real menu to a screen reader (role=menu, menuitems, labelled by the button, aria-expanded flipped)",
    menu.role === "menu" && menu.labelled && menu.expanded === "true" && menu.items.every((i) => i.role === "menuitem"), JSON.stringify({ role: menu.role, expanded: menu.expanded, labelled: menu.labelled }));
  check("opening it moves focus onto the first item", menu.focusedFirstItem);

  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-post-id="p-coach"] .post-menu-item')];
    return items.indexOf(document.activeElement);
  });
  check("ArrowDown walks the items", second === 1, `focused index ${second}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-post-id="p-coach"] .post-menu', { state: "detached", timeout: 5000 });
  const returned = await page.evaluate(() => {
    const btn = document.querySelector('[data-post-id="p-coach"] [data-community-action="toggle-post-menu"]');
    return { focused: document.activeElement === btn, expanded: btn.getAttribute("aria-expanded") };
  });
  check("Escape closes it and puts focus back on the ⋯ button", returned.focused && returned.expanded === "false", JSON.stringify(returned));

  // ---- 5. stroke icons, no emoji ----------------------------------------
  const icons = await page.evaluate(() => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const commentBtn = document.querySelector('[data-post-id="p-own"] [data-community-action="toggle-comments"]');
    const bell = document.querySelector('[data-community-action="feed-notifications"]');
    const camera = document.querySelector('[data-community-action="open-composer-photo"]');
    const shape = (el) => {
      if (!el) return null;
      const svg = el.querySelector("svg");
      const r = el.getBoundingClientRect();
      return {
        svg: !!svg,
        stroke: svg ? getComputedStyle(svg).stroke : "",
        fill: svg ? svg.getAttribute("fill") : "",
        emoji: EMOJI.test(el.textContent || ""),
        label: el.getAttribute("aria-label"),
        w: r.width, h: r.height,
      };
    };
    return { comment: shape(commentBtn), bell: shape(bell), camera: shape(camera) };
  });
  for (const [name, o] of Object.entries(icons)) {
    check(`the ${name} is a stroke icon, not an emoji`, !!o && o.svg && !o.emoji && o.fill === "none", JSON.stringify(o));
    check(`the ${name} takes the control's own colour (currentColor resolves to a real stroke)`, !!o && !!o.stroke && o.stroke !== "none", JSON.stringify(o && o.stroke));
    check(`the ${name} still carries its accessible name`, !!o && !!o.label, JSON.stringify(o && o.label));
  }
  check("the comment count still reads its number", /2/.test(await page.textContent('[data-post-id="p-own"] [data-community-action="toggle-comments"]')));

  // ---- 4. the comment box: no orange button, a send icon once there is text
  const before = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-post-id]")];
    const send = document.querySelector('[data-post-id="p-own"] .comment-send');
    const input = document.querySelector('[data-post-id="p-own"] [data-comment-input]');
    const ir = input.getBoundingClientRect();
    return {
      // No primary CTA anywhere in the comment boxes, on any card.
      primaries: cards.reduce((n, c) => n + c.querySelectorAll(".comment-form .chip-btn.primary").length, 0),
      sendVisible: !!send && send.offsetParent !== null,
      sendType: send && send.getAttribute("type"),
      // The box itself is one row: the input fills the card width.
      inputH: ir.height, inputW: ir.width,
    };
  });
  check("no orange שליחה button sits under the card while the field is empty",
    before.primaries === 0 && !before.sendVisible, JSON.stringify(before));
  await page.fill('[data-post-id="p-own"] [data-comment-input]', "יפה מאוד");
  const after = await page.evaluate(() => {
    const send = document.querySelector('[data-post-id="p-own"] .comment-send');
    const input = document.querySelector('[data-post-id="p-own"] [data-comment-input]');
    const sr = send.getBoundingClientRect(), ir = input.getBoundingClientRect();
    return {
      visible: send.offsetParent !== null,
      type: send.getAttribute("type"),
      label: send.getAttribute("aria-label"),
      svg: !!send.querySelector("svg"),
      // Inside the field, not beside it and not under it.
      insideField: sr.left >= ir.left - 0.5 && sr.right <= ir.right + 0.5 && sr.top >= ir.top - 0.5 && sr.bottom <= ir.bottom + 0.5,
      // On the field's own inline-end, which in RTL is its left edge.
      onInlineEnd: sr.left - ir.left < ir.right - sr.right,
      w: sr.width, h: sr.height,
      rowH: input.closest(".comment-form").getBoundingClientRect().height,
      inputH: ir.height,
    };
  });
  check("typing reveals a send icon INSIDE the field", after.visible && after.svg && after.insideField, JSON.stringify(after));
  check("it is the form's own submit, on the field's inline-end, and a real target (>=24px)",
    after.type === "submit" && after.onInlineEnd && after.w >= 24 && after.h >= 24 && !!after.label, JSON.stringify(after));
  check("the comment box is still one row — nothing wrapped underneath",
    after.rowH <= after.inputH + 2, JSON.stringify({ rowH: after.rowH, inputH: after.inputH }));
  // Clearing it takes the icon away again, without a render.
  await page.fill('[data-post-id="p-own"] [data-comment-input]', "");
  const cleared = await page.evaluate(() => document.querySelector('[data-post-id="p-own"] .comment-send').offsetParent === null);
  check("emptying the field hides it again", cleared);

  // ---- the popup that is anchored the same way, checked rather than assumed
  // The @-picker is the feed's other absolutely-positioned panel and it
  // carries the SAME `inset-inline-start:0` the post menu was anchored with.
  // It is not moved, because its anchor is the comment form - full card
  // width - rather than a 47px button, so it has room to grow inline-ward.
  // That is a claim about pixels, so it is measured here instead of argued
  // in a comment.
  await page.fill('[data-post-id="p-own"] [data-comment-input]', "@");
  await page.waitForSelector('[data-post-id="p-own"] .mention-picker', { timeout: 5000 });
  const picker = await page.evaluate(() => {
    const r = document.querySelector('[data-post-id="p-own"] .mention-picker').getBoundingClientRect();
    const f = document.querySelector('[data-post-id="p-own"] .comment-form').getBoundingClientRect();
    return { left: r.left, right: r.right, w: r.width, win: window.innerWidth, top: r.top, formBottom: f.bottom };
  });
  check("the @-picker — the same anchoring, a different anchor — is also inside the viewport",
    picker.left >= -0.5 && picker.right <= picker.win + 0.5, JSON.stringify(picker));
  // And it still hangs off the FORM. The form is the picker's positioning
  // context (`position:absolute; top:100%` on the picker); this scenario is
  // the only place that would notice if it stopped being one.
  check("it hangs directly under the comment form it belongs to",
    Math.abs(picker.top - picker.formBottom) <= 6, JSON.stringify({ top: picker.top, formBottom: picker.formBottom }));
  await page.fill('[data-post-id="p-own"] [data-comment-input]', "");

  // ---- no horizontal overflow anywhere on the screen ---------------------
  const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("the feed does not scroll sideways at 390px", overflow.doc <= overflow.win + 0.5, JSON.stringify(overflow));
  check("no console errors on the feed", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// TWO: the member's empty feed — the streak line, and NO coach card.
// ===========================================================================
console.log("\n--- 390x844: a member, empty feed ---");
{
  const tables = baseTables({
    feed_page_rows: [],
    club_features: [{ club_id: "club-1", module_key: "club_wod", enabled: true, config: {} }],
    community_streaks: [
      { user_id: "u2", handle: "yonatan", display_name: LONG_NAME, current_streak: 12, last_activity_on: TODAY },
      { user_id: "u3", handle: "yael", display_name: "יעל", current_streak: 1, last_activity_on: TODAY },
    ],
  });
  const { page, errors } = await openFeed(tables, { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  await page.waitForSelector('[data-feed-active-members="ready"]', { timeout: 10000 });

  // ---- 7. the streak: the number, on the right side of its words ---------
  const streaks = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-feed-active-members="ready"] .log-row')];
    return rows.map((row) => {
      const s = row.querySelector(".streak-count");
      const digits = s && s.querySelector(".mono");
      if (!s || !digits) return null;
      const sr = s.getBoundingClientRect(), dr = digits.getBoundingClientRect();
      const words = [...s.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      return {
        text: s.textContent.replace(/\s+/g, " ").trim(),
        digits: digits.textContent.trim(),
        words,
        oneLine: sr.height <= parseFloat(getComputedStyle(s).fontSize) * 2,
        // RTL: the number is the first thing read, so it is painted to the
        // RIGHT of the words it counts. This is the check that fails if the
        // whole phrase is put back inside .mono (direction:ltr).
        numberLeadsInRtl: dr.right > sr.left + sr.width / 2,
        gap: dr.left - sr.left,
        w: sr.width,
      };
    });
  });
  check("both rows print their streak with the NUMBER", streaks.length === 2 && streaks.every((s) => s && /^\d+$/.test(s.digits)), JSON.stringify(streaks));
  check("12 is plural and 1 is singular — and 1 still shows its digit",
    streaks[0].digits === "12" && streaks[0].words === "ימים רצופים"
    && streaks[1].digits === "1" && streaks[1].words === "יום רצוף", JSON.stringify(streaks.map((s) => s.text)));
  check("the number reads first in RTL and the line does not break",
    streaks.every((s) => s.numberLeadsInRtl && s.oneLine), JSON.stringify(streaks.map((s) => ({ lead: s.numberLeadsInRtl, one: s.oneLine }))));

  // ---- the same underline, one card down --------------------------------
  // The rows of this list put the avatar and the name inside one .link-btn,
  // so the name wore the same underline the post author's did - on the same
  // screen, two centimetres apart. Same fix, same measurement.
  const memberRow = await page.evaluate(() => {
    const row = document.querySelector('[data-feed-active-members="ready"] .log-row');
    const link = row.querySelector(".member-row-link");
    const name = link.querySelector(".member-row-name");
    const streak = row.querySelector(".streak-count");
    const rr = row.getBoundingClientRect(), nr = name.getBoundingClientRect(), sr = streak.getBoundingClientRect();
    const ns = getComputedStyle(name);
    return {
      decoration: getComputedStyle(link).textDecorationLine,
      // This name fits at 390px, so the claim is not "it is truncated" - it
      // is that the row CANNOT wrap or overflow: one line, set to ellipse,
      // with the streak still on it and still inside the card.
      oneLine: nr.height <= parseFloat(ns.fontSize) * 2,
      ellipses: ns.whiteSpace === "nowrap" && ns.textOverflow === "ellipsis",
      sameLine: Math.abs((nr.top + nr.height / 2) - (sr.top + sr.height / 2)) < 6,
      streakInside: sr.left >= rr.left - 0.5 && sr.right <= rr.right + 0.5,
      rowH: rr.height,
    };
  });
  check("the member name on the active list is not underlined either",
    memberRow.decoration === "none", JSON.stringify(memberRow.decoration));
  check("the name is one line set to ellipse, and the streak stays on the row inside the card",
    memberRow.oneLine && memberRow.ellipses && memberRow.sameLine && memberRow.streakInside, JSON.stringify(memberRow));

  // ---- 6. the club-WOD card is NOT a member's ---------------------------
  const memberWod = await page.evaluate(() => ({
    card: !!document.querySelector('[data-empty-state="club-wod-today-none"]'),
    headline: /לא נקבע אימון למועדון היום/.test(document.body.textContent),
    instructions: /אימון מהקטלוג שנקבע ליום מסוים/.test(document.body.textContent),
    form: !!document.getElementById("communityClubWodSession"),
  }));
  check("a member is not shown the empty club-WOD card, its coach instructions or the publish form",
    !memberWod.card && !memberWod.headline && !memberWod.instructions && !memberWod.form, JSON.stringify(memberWod));
  check("no console errors on the empty feed", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ===========================================================================
// THREE: the same club, same day, same width — as a coach.
// ===========================================================================
console.log("\n--- 390x844: a coach, same empty day ---");
{
  const tables = baseTables({
    feed_page_rows: [],
    club_features: [{ club_id: "club-1", module_key: "club_wod", enabled: true, config: {} }],
  });
  // u2 is the head coach seeded above: community.challenge.create, which is
  // what clubWodCanProgram() asks for. The catalogue is handed over through
  // club_wods_list (no built-in in the mock) because the publish form is only
  // drawn once the club HAS a WOD to schedule - with an empty catalogue it is
  // deliberately a line of prose pointing at the log screen instead, which
  // would make "the coach gets the form" pass or fail on the fixture rather
  // than on the gate this is measuring.
  const { page, errors } = await openFeed(tables, { id: "u2", is_anonymous: false, email: "yonatan@members.haimuniya.invalid" }, () => {
    window.__mock.onRpc("club_wods_list", () => ({
      data: [{ id: "customwod-1", name: "Dana's Chipper", category: "Club", scoreType: "time", desc: "21-15-9", emomMovements: [], emomTargetReps: [], emomMinutes: null, timeCapSeconds: 1200, publishedBy: "u2", publishedAt: new Date().toISOString(), retiredAt: null }],
      error: null,
    }));
  });
  await page.waitForSelector('[data-empty-state="club-wod-today-none"]', { timeout: 10000 });
  const coachWod = await page.evaluate(() => {
    const card = document.querySelector('[data-empty-state="club-wod-today-none"]');
    const r = card.getBoundingClientRect();
    return {
      headline: /לא נקבע אימון למועדון היום/.test(card.textContent),
      instructions: /אימון מהקטלוג שנקבע ליום מסוים/.test(document.body.textContent),
      form: !!document.getElementById("communityClubWodSession"),
      inViewport: r.left >= -0.5 && r.right <= window.innerWidth + 0.5,
    };
  });
  check("a coach still gets the full card, the instructions and the publish form",
    coachWod.headline && coachWod.instructions && coachWod.form && coachWod.inViewport, JSON.stringify(coachWod));
  check("no console errors on the coach's feed", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-feed-polish: FAILED" : "\ncommunity-feed-polish: all checks passed");
process.exit(failed ? 1 : 0);
