// The sharing pipeline: when each share offer appears and what data reaches the
// card. The pure half (src/community/sharing-core.js) runs with no browser; the
// screens run the real index.html, app.js and cloud.js with a stubbed Supabase
// client and a stubbed window.boxlogShareCards (jsdom has no canvas, so the
// drawing itself is covered by scripts/browser-check/share-cards.mjs).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createCirclesMock, bootCircle, bootCommunity, waitFor, tick, click, membership, ME, FRIEND, CIRCLE_A, TOKEN } from "./helpers/circles.mjs";

globalThis.window = globalThis;
new Function(readFileSync(new URL("../src/community/circles-core.js", import.meta.url), "utf8"))();
new Function(readFileSync(new URL("../src/community/sharing-core.js", import.meta.url), "utf8"))();
const S = globalThis.SharingCore;

const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_WHATSAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/24.10.80";
const ANDROID_INSTAGRAM = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0 Mobile Safari/537.36 Instagram 330.0.0.0 Android";
const ANDROID_FACEBOOK = "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1";

const showWeights = membership({}, { share_defaults: { show_weights: true } });
const hideWeights = membership({}, { share_defaults: { show_weights: false } });
const circlesOf = (...ms) => ms.map((m) => Object.assign({}, m.clubs, { role: m.role, share_defaults: m.share_defaults }));

// ---- what reaches the PR card ---------------------------------------------------------

const RECORD = { record_id: "r1", movement: "סקוואט", new_value_numeric: 105, previous_value_numeric: 100, previous_result: "100 ק״ג × 5", new_result: "105 ק״ג × 5", improvement: "+5 ק״ג" };
const ctx = (circles) => ({ profile: { display_name: "דנה", emoji: "🦁" }, circles, today: "2026-10-26" });

test("the PR card gets the lift and the percent, and no weight unless the member chose to show it", () => {
  const data = S.prCardData(RECORD, ctx(circlesOf(hideWeights)));
  assert.deepEqual(data, { memberName: "דנה", memberEmoji: "🦁", lift: "סקוואט", date: "2026-10-26", percent: 5 });
  for (const k of ["weight", "showWeight", "previousWeight"]) assert.ok(!(k in data), `${k} is not handed to the card`);
  assert.ok(!JSON.stringify(data).includes("105") && !JSON.stringify(data).includes("100"), "neither weight appears anywhere in the data");
});

test("with a circle that shows weights, the new weight (and only it) reaches the card", () => {
  const data = S.prCardData(RECORD, ctx(circlesOf(hideWeights, showWeights)));
  assert.equal(data.weight, 105);
  assert.equal(data.showWeight, true);
  assert.ok(!("previousWeight" in data), "the previous weight never travels, the percent is derived here");
});

test("an estimated 1RM is never printed as a lifted weight, even when weights are shown", () => {
  const data = S.prCardData({ ...RECORD, estimated: true }, ctx(circlesOf(showWeights)));
  assert.ok(!("weight" in data) && !("showWeight" in data));
  assert.equal(data.percent, 5, "the improvement still shows");
});

test("no previous figure means no percent, not a made-up one; a worse figure is not an improvement", () => {
  assert.ok(!("percent" in S.prCardData({ ...RECORD, previous_value_numeric: undefined }, ctx(circlesOf(hideWeights)))));
  assert.ok(!("percent" in S.prCardData({ ...RECORD, previous_value_numeric: 120 }, ctx(circlesOf(hideWeights)))));
});

// ---- what reaches the week card --------------------------------------------------------

const ROWS = [
  { user_id: ME, display_name: "אני", emoji: "💪", workouts: 3, target: 3, percent: 100, paused: false, weeks_met: 4 },
  { user_id: FRIEND, display_name: "דנה", emoji: "🦁", workouts: 1, target: null, percent: 50, paused: false, weeks_met: 1 },
  { user_id: "x", display_name: "סודי", emoji: "🕶️", workouts: null, target: null, percent: null, paused: false, weeks_met: null },
  { user_id: "y", display_name: "נועה", emoji: "🧘", workouts: null, target: null, percent: null, paused: true, weeks_met: 3 },
];

test("the week card carries names, emoji, percent of own target and paused; no id, no target, no hidden member", () => {
  const data = S.weekCardData({ name: "החבר'ה", emoji: "🔥", type: "friends" }, [{ weekStart: "2026-10-25", rows: ROWS }]);
  assert.equal(data.circleName, "החבר'ה");
  assert.equal(data.weeks.length, 1);
  assert.equal(data.weeks[0].label, "25.10 - 31.10");
  assert.deepEqual(data.weeks[0].members.map((m) => m.name), ["אני", "דנה", "נועה"], "server order kept, the member who shares nothing is left off");
  assert.deepEqual(data.weeks[0].members[0], { name: "אני", emoji: "💪", percent: 100, paused: false, weeksMet: 4 });
  const flat = JSON.stringify(data);
  assert.ok(!flat.includes("user_id") && !flat.includes(ME) && !flat.includes("target"), "no identifiers and no target");
});

test("a couple card draws up to two weeks, a friends card one", () => {
  const weeks = [{ weekStart: "2026-10-25", rows: ROWS }, { weekStart: "2026-10-18", rows: ROWS }, { weekStart: "2026-10-11", rows: ROWS }];
  assert.equal(S.weekCardData({ name: "אנחנו", type: "couple" }, weeks).weeks.length, 2);
  assert.equal(S.weekCardData({ name: "החבר'ה", type: "friends" }, weeks).weeks.length, 1);
});

test("a snapshot keeps the last two weeks and drops every identifier", () => {
  let store = {};
  for (const ws of ["2026-10-11", "2026-10-18", "2026-10-25"]) store = S.recordSnapshot(store, "c1", ws, ROWS);
  assert.deepEqual(Object.keys(store.c1), ["2026-10-18", "2026-10-25"]);
  assert.ok(!JSON.stringify(store).includes(ME) && !JSON.stringify(store).includes("user_id"));
});

// ---- when each offer appears ------------------------------------------------------------

test("last week's card is offered on a Sunday only, once per week", () => {
  assert.deepEqual(S.lastWeekOffer({ today: "2026-11-01", lastOffered: null }), { thisWeek: "2026-11-01", offerWeek: "2026-10-25" });
  assert.equal(S.lastWeekOffer({ today: "2026-11-01", lastOffered: "2026-11-01" }), null, "already offered this Sunday");
  assert.ok(S.lastWeekOffer({ today: "2026-11-01", lastOffered: "2026-10-25" }), "a new Sunday offers again");
  for (const day of ["2026-10-26", "2026-10-28", "2026-10-30", "2026-10-31"]) assert.equal(S.lastWeekOffer({ today: day, lastOffered: null }), null, day + " is not a Sunday");
});

test("in-app browsers are recognised from the user agent, real browsers are not", () => {
  assert.equal(S.detectInAppBrowser(IOS_WHATSAPP).id, "whatsapp");
  assert.equal(S.detectInAppBrowser(ANDROID_INSTAGRAM).id, "instagram");
  assert.equal(S.detectInAppBrowser(ANDROID_FACEBOOK).id, "facebook");
  assert.equal(S.detectInAppBrowser(IOS_SAFARI), null);
  assert.equal(S.detectInAppBrowser(ANDROID_CHROME), null);
});

test("the install help: native on Android with a held prompt, steps on iOS Safari, nothing else, never after a no", () => {
  const base = { standalone: false, dismissed: false };
  assert.equal(S.installOffer({ ...base, ua: ANDROID_CHROME, hasNativePrompt: true }), "native");
  assert.equal(S.installOffer({ ...base, ua: ANDROID_CHROME, hasNativePrompt: false }), null, "no prompt to show, nothing to offer");
  assert.equal(S.installOffer({ ...base, ua: IOS_SAFARI }), "ios");
  assert.equal(S.installOffer({ ...base, ua: IOS_CHROME }), null, "the Safari steps are wrong in another browser");
  assert.equal(S.installOffer({ ...base, ua: IOS_WHATSAPP }), null, "an in-app browser cannot install");
  assert.equal(S.installOffer({ ...base, ua: IOS_SAFARI, standalone: true }), null, "already installed");
  assert.equal(S.installOffer({ ...base, ua: IOS_SAFARI, dismissed: true }), null, "dismissed means dismissed");
});

test("the invite message names the circle and the inviter and says seven days; the token is not in it", () => {
  const text = S.inviteShareText({ circleName: "החבר'ה", inviterName: "דנה", appName: "BOX-LOG" });
  assert.match(text, /דנה/);
  assert.match(text, /החבר'ה/);
  assert.match(text, /7 ימים/);
  assert.match(text, /BOX-LOG/);
  assert.ok(!text.includes("#") && !text.includes(TOKEN));
  assert.match(S.inviteShareText({ circleName: "החבר'ה" }), /7 ימים/, "still complete with no inviter name");
});

// ---- the screens ---------------------------------------------------------------------------

/** A stand-in for window.boxlogShareCards that records what it was asked to draw and share. */
function stubCards(window) {
  const calls = { pr: [], week: [], files: [], shared: [], order: [] };
  window.boxlogShareCards = {
    ensureFonts: async () => {},
    renderPrCard: (d) => { calls.pr.push(d); return { kind: "pr" }; },
    renderWeekCard: (d) => { calls.week.push(d); return { kind: "week" }; },
    canvasToFile: async () => { const f = new window.File(["x"], "box-log.png", { type: "image/png" }); calls.files.push(f); return f; },
    shareCard: async (f) => { calls.shared.push(f); calls.order.push("share"); return "shared"; },
  };
  return calls;
}
const prRecord = (over = {}) => ({ ...RECORD, record_id: "rec-" + Math.random().toString(36).slice(2), movement: "סקוואט-" + Math.random().toString(36).slice(2), ...over });

test("the PR prompt offers a share button once the card is built, and the tap shares that very file", async () => {
  const mock = createCirclesMock({ circles: [hideWeights] });
  const window = await bootCircle(mock);
  const calls = stubCards(window);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: prRecord() });
  await waitFor(() => !!window.document.querySelector('[data-pr-card="ready"]'), 4000);
  assert.equal(calls.pr.length, 1, "drawn once, before any tap");
  assert.equal(calls.files.length, 1, "and already turned into a File");
  assert.equal(calls.shared.length, 0, "nothing is shared by opening the prompt");
  assert.deepEqual(calls.pr[0], { memberName: "אני", memberEmoji: "💪", lift: calls.pr[0].lift, date: calls.pr[0].date, percent: 5 });
  click(window, '[data-community-action="sh-pr-card"]');
  assert.equal(calls.shared.length, 1, "shareCard ran synchronously inside the tap, so iOS keeps the user gesture");
  assert.equal(calls.shared[0], calls.files[0], "it shared the file built before the tap, not a new one");
  assert.equal(calls.files.length, 1);
  assert.equal(window.document.querySelector('[data-community-action="outward-pr"]'), null, "the old painter's button is gone");
});

test("the PR card gets the absolute weight only when a circle shows weights", async () => {
  const mock = createCirclesMock({ circles: [showWeights] });
  const window = await bootCircle(mock);
  const calls = stubCards(window);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: prRecord() });
  await waitFor(() => calls.pr.length === 1, 4000);
  assert.equal(calls.pr[0].weight, 105);
  assert.equal(calls.pr[0].showWeight, true);
});

test("a trivial PR (the first sets) offers nothing, so there is no card to share", async () => {
  const mock = createCirclesMock({ circles: [hideWeights] });
  const window = await bootCircle(mock);
  const calls = stubCards(window);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: prRecord({ trivial: true }) });
  await tick(100);
  assert.equal(window.document.querySelector('[data-cloud-dialog="prPrompt"]'), null);
  assert.equal(calls.pr.length, 0);
});

test("if the card cannot be drawn the prompt simply has no image button", async () => {
  const mock = createCirclesMock({ circles: [hideWeights] });
  const window = await bootCircle(mock);
  stubCards(window).pr;
  window.boxlogShareCards.renderPrCard = () => { throw new Error("no_canvas"); };
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: prRecord() });
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="prPrompt"]'), 4000);
  await tick(50);
  assert.equal(window.document.querySelector("[data-pr-card]"), null);
  assert.ok(window.document.querySelector('[data-community-action="pr-share"]'), "sharing to the circles is untouched");
});

test("the week view has a share button that shares the card built from circle_week", async () => {
  const mock = createCirclesMock({ circles: [hideWeights], week: ROWS });
  const window = await bootCircle(mock);
  const calls = stubCards(window);
  click(window, '[data-community-action="c-section"][data-section="week"]');
  await waitFor(() => !!window.document.querySelector('[data-week-card="ready"]'), 4000);
  assert.equal(calls.week.length, 1);
  assert.equal(calls.week[0].circleName, "החבר'ה");
  assert.deepEqual(calls.week[0].weeks[0].members.map((m) => m.name), ["אני", "דנה", "נועה"]);
  assert.ok(!JSON.stringify(calls.week[0]).includes(ME));
  assert.equal(calls.shared.length, 0);
  click(window, '[data-community-action="sh-week-card"]');
  assert.equal(calls.shared.length, 1);
  assert.equal(calls.shared[0], calls.files[0]);
});

test("a week nobody shares anything in has no card button", async () => {
  const mock = createCirclesMock({ circles: [hideWeights], week: [ROWS[2]] });
  const window = await bootCircle(mock);
  stubCards(window);
  click(window, '[data-community-action="c-section"][data-section="week"]');
  await waitFor(() => !!window.document.querySelector("[data-week-member]"), 4000);
  await tick(50);
  assert.equal(window.document.querySelector("[data-week-card]"), null);
});

function sundayDate(window, iso) {
  const Real = window.Date;
  const fixed = new Real(iso).getTime();
  window.Date = class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
}

test("the first open on a Sunday offers last week's card from the saved snapshot, once", async () => {
  const snaps = JSON.stringify({ [CIRCLE_A]: { "2026-10-25": S.snapshotRows(ROWS) } });
  const mock = createCirclesMock({ circles: [hideWeights] });
  const window = await bootCircle(mock, { localStorage: { "haimunia-demo:weekSnapshots": snaps } });
  const calls = stubCards(window);
  sundayDate(window, "2026-11-01T05:00:00Z"); // Sunday morning, Asia/Jerusalem
  await window.boxlogSharing.maybeOfferLastWeek();
  await waitFor(() => !!window.document.querySelector('[data-week-offer="ready"]'), 4000);
  assert.equal(calls.week.length, 1);
  assert.equal(calls.week[0].weeks[0].label, "25.10 - 31.10", "last week, not this one");
  click(window, '[data-community-action="sh-week-offer-share"]');
  assert.equal(calls.shared.length, 1);
  assert.equal(window.document.querySelector("[data-week-offer]"), null, "the sheet closes");
  await window.boxlogSharing.maybeOfferLastWeek();
  await tick(50);
  assert.equal(window.document.querySelector("[data-week-offer]"), null, "not offered again the same Sunday");
  assert.equal(window.localStorage.getItem("haimunia-demo:weekCardOffered"), "2026-11-01");
});

test("no offer on a weekday, and none when this device saw nothing of last week", async () => {
  const snaps = JSON.stringify({ [CIRCLE_A]: { "2026-10-25": S.snapshotRows(ROWS) } });
  const mock = createCirclesMock({ circles: [hideWeights] });
  const window = await bootCircle(mock, { localStorage: { "haimunia-demo:weekSnapshots": snaps } });
  stubCards(window);
  sundayDate(window, "2026-11-03T05:00:00Z"); // Tuesday
  await window.boxlogSharing.maybeOfferLastWeek();
  await tick(50);
  assert.equal(window.document.querySelector("[data-week-offer]"), null);
  const mock2 = createCirclesMock({ circles: [hideWeights] });
  const w2 = await bootCircle(mock2);
  stubCards(w2);
  sundayDate(w2, "2026-11-01T05:00:00Z");
  await w2.boxlogSharing.maybeOfferLastWeek();
  await tick(50);
  assert.equal(w2.document.querySelector("[data-week-offer]"), null, "no snapshot, no card");
  assert.equal(w2.localStorage.getItem("haimunia-demo:weekCardOffered"), "2026-11-01", "the Sunday's offer is still consumed");
});

// ---- invites inside an in-app browser ------------------------------------------------------

function visitorMock() {
  const mock = createCirclesMock({ circles: [], signedIn: false });
  mock.db.profiles = [];
  return mock;
}

test("an invite opened in the WhatsApp browser shows Hebrew steps and leaves the token in the URL", async () => {
  const mock = visitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_WHATSAPP });
  await waitFor(() => !!window.document.querySelector('[data-inapp-browser="whatsapp"]'), 4000);
  const text = window.document.getElementById("content").textContent;
  assert.match(text, /Safari/);
  assert.match(text, /WhatsApp/);
  assert.equal(window.location.hash, "#invite=" + TOKEN, "the fragment survives, so it survives the switch to Safari");
  assert.equal(mock.rpcCalls.length, 0, "nothing is called, no session is started in a browser that forgets it");
  assert.ok(!window.document.documentElement.outerHTML.includes(TOKEN), "and the token is not written into the page");
});

test("the Android Instagram browser is told to open Chrome", async () => {
  const mock = visitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: ANDROID_INSTAGRAM });
  await waitFor(() => !!window.document.querySelector('[data-inapp-browser="instagram"]'), 4000);
  assert.match(window.document.getElementById("content").textContent, /Chrome/);
});

test("copy puts the full link, fragment included, on the clipboard", async () => {
  const mock = visitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_WHATSAPP });
  await waitFor(() => !!window.document.querySelector('[data-inapp-browser]'), 4000);
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  click(window, '[data-community-action="sh-inapp-copy"]');
  await waitFor(() => copied.length === 1, 4000);
  assert.equal(copied[0], "https://box.example/app/#invite=" + TOKEN);
});

test("'continue here anyway' drops the screen and goes on to the normal invite gate", async () => {
  const mock = visitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_WHATSAPP });
  await waitFor(() => !!window.document.querySelector('[data-inapp-browser]'), 4000);
  click(window, '[data-community-action="sh-inapp-continue"]');
  await waitFor(() => window.document.getElementById("content").textContent.includes("הוזמנת להצטרף למעגל"), 4000);
  assert.equal(window.document.querySelector("[data-inapp-browser]"), null);
  assert.equal(window.location.hash, "", "now the token is read and cleared from the bar like anywhere else");
});

test("the same link in a real browser skips the screen", async () => {
  const mock = visitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_SAFARI });
  await waitFor(() => window.document.getElementById("content").textContent.includes("הוזמנת להצטרף למעגל"), 4000);
  assert.equal(window.document.querySelector("[data-inapp-browser]"), null);
});

// ---- Add to Home Screen --------------------------------------------------------------------

function firstCircleMock() {
  const mock = createCirclesMock({ circles: [] });
  mock.onRpc("join_circle", () => {
    mock.db.circle_members.push(membership({}, { role: "member" }));
    return { data: { status: "joined", club_id: CIRCLE_A }, error: null };
  });
  return mock;
}

test("joining the first circle on iOS Safari shows the illustrated steps, and closing them is final", async () => {
  const mock = firstCircleMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_SAFARI });
  await waitFor(() => !!window.document.querySelector('[data-install-steps="ios"]'), 4000);
  const steps = window.document.querySelectorAll('[data-install-steps="ios"] li');
  assert.equal(steps.length, 3);
  assert.ok([...steps].every((li) => li.querySelector("svg")), "each step is illustrated");
  assert.equal(window.localStorage.getItem("haimunia-demo:circleInstallDone"), null, "showing is not dismissing");
  click(window, '[data-community-action="sh-close"]');
  assert.equal(window.document.querySelector("[data-install-steps]"), null);
  assert.equal(window.localStorage.getItem("haimunia-demo:circleInstallDone"), "1");
  window.boxlogSharing.afterCircleJoined(true);
  await tick(30);
  assert.equal(window.document.querySelector("[data-install-steps]"), null, "dismissed means dismissed");
});

test("Escape counts as a no, exactly like the button", async () => {
  const mock = firstCircleMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_SAFARI });
  await waitFor(() => !!window.document.querySelector('[data-install-steps="ios"]'), 4000);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.querySelector("[data-install-steps]"), 4000);
  assert.equal(window.localStorage.getItem("haimunia-demo:circleInstallDone"), "1");
});

test("a member who joins a second circle is not shown the install steps again", async () => {
  const mock = createCirclesMock({ circles: [hideWeights] });
  mock.onRpc("join_circle", () => ({ data: { status: "joined", club_id: CIRCLE_A }, error: null }));
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false, userAgent: IOS_SAFARI });
  await waitFor(() => mock.callsTo("join_circle").length === 1, 4000);
  await tick(100);
  assert.equal(window.document.querySelector("[data-install-steps]"), null);
});

test("on Android with a held install prompt the native prompt is offered, and used from the tap", async () => {
  const mock = createCirclesMock({ circles: [hideWeights] });
  const window = await bootCircle(mock);
  const held = new window.Event("beforeinstallprompt", { cancelable: true });
  held.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; };
  held.userChoice = Promise.resolve({ outcome: "accepted" });
  window.dispatchEvent(held);
  Object.defineProperty(window.navigator, "userAgent", { value: ANDROID_CHROME, configurable: true });
  window.boxlogSharing.afterCircleJoined(true);
  await waitFor(() => !!window.document.querySelector('[data-install-steps="native"]'), 4000);
  click(window, '[data-community-action="sh-install-native"]');
  assert.equal(window.__prompted, 1, "prompt() ran inside the tap");
  assert.equal(window.localStorage.getItem("haimunia-demo:circleInstallDone"), "1");
  assert.equal(window.document.querySelector("[data-install-steps]"), null);
});

// ---- the invite message on the wire -----------------------------------------------------------

test("sharing an invite sends a message naming the circle and the inviter, seven days, and the token only after #", async () => {
  const mock = createCirclesMock({ circles: [membership({ name: "הריצה של שישי" })] });
  const window = await bootCircle(mock);
  const shared = [];
  window.navigator.share = async (data) => { shared.push(data); };
  click(window, '[data-community-action="c-invite-open"]');
  await waitFor(() => !!window.document.getElementById("circleInvite"), 4000);
  window.document.getElementById("circleInvite").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await waitFor(() => !!window.document.getElementById("circleInviteLink"), 4000);
  click(window, '[data-community-action="c-invite-share"]');
  await waitFor(() => shared.length === 1, 4000);
  assert.match(shared[0].text, /הריצה של שישי/);
  assert.match(shared[0].text, /אני/, "the inviter's display name");
  assert.match(shared[0].text, /7 ימים/);
  assert.ok(!shared[0].text.includes(TOKEN));
  assert.equal(new URL(shared[0].url).hash, "#invite=" + TOKEN);
  assert.equal(new URL(shared[0].url).search, "");
});

// ---- the old painter is gone --------------------------------------------------------------------

test("nothing loads or calls the old gym-era painter", () => {
  const files = ["index.html", "sw.js", "cloud.js", "app.js", "src/community/posts.js", "src/community/achievements.js", "src/community/circles.js", "src/community/circles-ui.js", "src/community/circles-sheets.js"];
  for (const f of files) {
    const src = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    assert.ok(!/community\/outward\.js|communityOutwardShare|renderOutwardShareSheet|outwardShareNow|state\.posts\.outwardShare/.test(src), `${f} must not reference the old painter`);
  }
});
