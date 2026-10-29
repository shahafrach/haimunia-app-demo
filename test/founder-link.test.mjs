// The founder link (docs/ops/FOUNDER_LINK.md): a member sends a friend a "start
// your own circle" link from Me (Web Share, copy as the fallback), and the
// friend, opening it, signs up and lands on the create-circle sheet. Real
// index.html, app.js and cloud.js; only the Supabase client is a stub.
import { test } from "node:test";
import assert from "node:assert";
import { createCirclesMock, bootCommunity, waitFor, click, membership, ME, CIRCLE_A, TOKEN } from "./helpers/circles.mjs";

const FOUNDER_URL = "https://box-log.pages.dev/#invite=" + TOKEN;
const text = (w) => w.document.getElementById("content").textContent + (w.document.querySelector("[data-cloud-dialog]") ? w.document.querySelector("[data-cloud-dialog]").textContent : "");
const has = (w, s) => text(w).includes(s);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));

async function openMe(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("founderLinkPanel"), 4000);
  return window;
}

// ---- Me -------------------------------------------------------------------
test("Me offers the action with a one-line explanation that the friend gets their own circle", async () => {
  const mock = createCirclesMock({ circles: [membership()] });
  const window = await openMe(mock);
  const btn = window.document.querySelector('[data-community-action="c-founder-open"]');
  assert.ok(btn);
  assert.equal(btn.textContent.trim(), "קישור לחבר שרוצה מעגל משלו");
  assert.match(window.document.getElementById("founderLinkPanel").textContent, /מעגל משלהם/);
  assert.equal(mock.callsTo("create_founder_invite").length, 0, "opening Me creates nothing");
});

test("the link is made on a tap, shown once, and goes through Web Share when the browser has it", async () => {
  const mock = createCirclesMock({ circles: [membership()], rpc: { create_founder_invite: () => ({ data: FOUNDER_URL, error: null }) } });
  const window = await openMe(mock);
  const shared = [];
  window.navigator.share = async (d) => { shared.push(d); };
  click(window, '[data-community-action="c-founder-open"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-founder-create"]'), 4000);
  assert.equal(mock.callsTo("create_founder_invite").length, 0, "the sheet explains first; nothing is spent yet");
  click(window, '[data-community-action="c-founder-create"]');
  await waitFor(() => !!window.document.getElementById("founderLink"), 4000);
  assert.equal(mock.callsTo("create_founder_invite").length, 1);
  const link = window.document.getElementById("founderLink").value;
  assert.equal(link, FOUNDER_URL);
  assert.equal(new URL(link).hash, "#invite=" + TOKEN, "the token is in the fragment");
  assert.equal(new URL(link).search, "", "and not in the query");
  click(window, '[data-community-action="c-founder-share"]');
  await waitFor(() => shared.length === 1, 4000);
  assert.equal(shared[0].url, link);
  assert.ok(!(shared[0].text || "").includes(TOKEN), "the token is only in the url");
  click(window, '[data-community-action="c-sheet-close"]');
  await waitFor(() => !window.document.getElementById("founderLink"), 4000);
  assert.ok(!window.document.documentElement.outerHTML.includes(TOKEN), "closing the sheet forgets the link");
});

test("without Web Share the link is copied", async () => {
  const mock = createCirclesMock({ circles: [membership()], rpc: { create_founder_invite: () => ({ data: FOUNDER_URL, error: null }) } });
  const window = await openMe(mock);
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  click(window, '[data-community-action="c-founder-open"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-founder-create"]'), 4000);
  click(window, '[data-community-action="c-founder-create"]');
  await waitFor(() => !!window.document.getElementById("founderLink"), 4000);
  assert.ok(!window.document.querySelector('[data-community-action="c-founder-share"]'), "no share button where there is no share");
  click(window, '[data-community-action="c-founder-copy"]');
  await waitFor(() => copied.length === 1, 4000);
  assert.ok(copied[0].includes(FOUNDER_URL));
  await waitFor(() => has(window, "הועתק"), 4000);
});

test("the daily limit reads as Hebrew, not as the raw error", async () => {
  const mock = createCirclesMock({ circles: [membership()], rpc: { create_founder_invite: () => ({ data: null, error: { message: "rate_limited" } }) } });
  const window = await openMe(mock);
  click(window, '[data-community-action="c-founder-open"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-founder-create"]'), 4000);
  click(window, '[data-community-action="c-founder-create"]');
  await waitFor(() => !!window.document.querySelector("[data-founder-error]"), 4000);
  assert.match(text(window), /3 קישורים/);
  assert.ok(!has(window, "rate_limited"));
  assert.ok(window.document.querySelector('[data-community-action="c-founder-create"]'), "and the member can try again");
});

// ---- The friend's side ---------------------------------------------------------
function founderVisitorMock(redeem) {
  const mock = createCirclesMock({ circles: [], signedIn: false });
  mock.db.profiles = [];
  mock.db.invite_redemptions = [];
  // join_circle does not know a founder token: the same answer an unknown circle invite gets.
  mock.onRpc("join_circle", () => ({ data: { status: "invalid" }, error: null }));
  mock.onRpc("redeem_invite_code", redeem || ((args, ctx) => {
    mock.db.invite_redemptions.push({ user_id: ctx.currentUser.id, invite_id: "inv-founder", role: "member", redeemed_at: new Date().toISOString() });
    return { data: "member", error: null };
  }));
  mock.onRpc("mark_recovery_verified", (args, ctx) => {
    const p = mock.db.profiles.find((x) => x.id === ctx.currentUser.id);
    if (p) p.recovery_verified_at = new Date().toISOString();
    return { data: true, error: null };
  });
  mock.onRpc("create_circle", (args, ctx) => {
    mock.db.circle_members.push(membership({ id: CIRCLE_A, name: args.p_name, type: args.p_type, emoji: args.p_emoji }, { user_id: ctx.currentUser.id, role: "owner" }));
    return { data: CIRCLE_A, error: null };
  });
  return mock;
}

test("a friend opens the link, signs up, and lands on the create-circle sheet", async () => {
  const mock = founderVisitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false });
  await waitFor(() => has(window, "הוזמנת להצטרף למעגל"), 4000);
  assert.equal(window.location.hash, "", "the token leaves the address bar");
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 4000);
  assert.equal(mock.callsTo("redeem_invite_code").length, 1);
  assert.equal(mock.callsTo("redeem_invite_code")[0].p_code, TOKEN);
  assert.equal(mock.getUser().is_anonymous, true, "still anonymous until the credentials step");
  assert.equal(mock.db.circle_members.length, 0, "redeeming put the friend in no circle");

  const form = window.document.getElementById("communityCredentials");
  form.elements.username.value = "noa_levi";
  form.elements.password.value = "Abcdefgh12";
  form.elements.passwordConfirm.value = "Abcdefgh12";
  submit(window, form);
  await waitFor(() => !!window.document.querySelector("#communityProfile"), 4000);
  const profile = window.document.getElementById("communityProfile");
  profile.elements.displayName.value = "נועה לוי";
  profile.elements.emoji.value = "🦊";
  submit(window, profile);

  // The create-circle sheet, with no further tap.
  await waitFor(() => !!window.document.getElementById("circleCreate"), 4000);
  assert.equal(mock.getUser().is_anonymous, false, "upgraded to a username and password");
  assert.equal(mock.callsTo("create_circle").length, 0, "nothing is created until the friend says so");
  assert.equal(mock.callsTo("join_circle").length, 1);

  const create = window.document.getElementById("circleCreate");
  create.elements.name.value = "המעגל של נועה";
  submit(window, create);
  await waitFor(() => mock.callsTo("create_circle").length === 1, 4000);
  assert.equal(mock.callsTo("create_circle")[0].p_name, "המעגל של נועה");
  await waitFor(() => !window.document.getElementById("circleCreate") && has(window, "המעגל של נועה"), 4000);
});

test("closing the sheet leaves the button; it does not open again by itself", async () => {
  const mock = founderVisitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false });
  await waitFor(() => has(window, "הוזמנת להצטרף למעגל"), 4000);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 4000);
  let form = window.document.getElementById("communityCredentials");
  form.elements.username.value = "noa_levi";
  form.elements.password.value = "Abcdefgh12";
  form.elements.passwordConfirm.value = "Abcdefgh12";
  submit(window, form);
  await waitFor(() => !!window.document.querySelector("#communityProfile"), 4000);
  form = window.document.getElementById("communityProfile");
  form.elements.displayName.value = "נועה לוי";
  form.elements.emoji.value = "🦊";
  submit(window, form);
  await waitFor(() => !!window.document.getElementById("circleCreate"), 4000);
  click(window, '[data-community-action="c-sheet-close"]');
  await waitFor(() => !window.document.getElementById("circleCreate"), 4000);
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-create-open"]'), 4000);
  assert.ok(has(window, "עוד אין לך מעגל"));
});

test("a link that is expired or already used reads as Hebrew, and nothing is joined", async () => {
  const mock = founderVisitorMock(() => ({ data: "invalid", error: null }));
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false });
  await waitFor(() => has(window, "הוזמנת להצטרף למעגל"), 4000);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => has(window, "ההזמנה לא תקפה"), 4000);
  assert.match(text(window), /פגה, נוצלה/);
  assert.ok(!has(window, "invalid"));
  assert.equal(mock.db.circle_members.length, 0);
});

test("a rate-limited redemption reads as 'too many tries', not as an invalid link", async () => {
  const mock = founderVisitorMock(() => ({ data: "rate_limited", error: null }));
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false });
  await waitFor(() => has(window, "הוזמנת להצטרף למעגל"), 4000);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => has(window, "יותר מדי פעמים"), 4000);
  assert.ok(!has(window, "ההזמנה לא תקפה"));
  assert.ok(!has(window, "rate_limited"));
});
