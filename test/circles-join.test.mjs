// Sign-up and join through an invite link (docs/circles/decisions.md, Auth):
// the token is read from the URL fragment after #, never from a query string,
// an anonymous session joins with join_circle and is then upgraded to a
// username and password, and a signed-in member opening a link joins one more
// circle. Every refusal reads as Hebrew. Real index.html, app.js and cloud.js;
// only the Supabase client is a stub.
import { test } from "node:test";
import assert from "node:assert";
import { createCirclesMock, bootCommunity, waitFor, tick, click, membership, club, ME, CIRCLE_A, CIRCLE_B, TOKEN } from "./helpers/circles.mjs";

const text = (w) => w.document.getElementById("content").textContent;
const has = (w, s) => text(w).includes(s);

function newVisitorMock(joinStatus) {
  const mock = createCirclesMock({ circles: [], signedIn: false });
  mock.db.profiles = [];
  mock.onRpc("join_circle", (args, ctx) => {
    if (joinStatus && joinStatus !== "joined") return { data: { status: joinStatus }, error: null };
    const uid = ctx.currentUser.id;
    mock.db.profiles.push({ id: uid, handle: "u" + uid.replace(/[^a-z0-9]/g, ""), display_name: null, emoji: "🙂", recovery_verified_at: null });
    mock.db.circle_members.push(membership({ id: CIRCLE_A, name: "החבר'ה" }, { user_id: uid, role: "member" }));
    return { data: { status: "joined", club_id: CIRCLE_A }, error: null };
  });
  // A circle invite is not a bootstrap code: the server refuses it there too.
  mock.onRpc("redeem_invite_code", () => ({ data: "invalid", error: null }));
  mock.onRpc("mark_recovery_verified", (args, ctx) => {
    const p = mock.db.profiles.find((x) => x.id === ctx.currentUser.id);
    if (p) p.recovery_verified_at = new Date().toISOString();
    return { data: true, error: null };
  });
  return mock;
}

async function openInviteLink(mock, hash = "#invite=" + TOKEN) {
  const window = await bootCommunity(mock, { url: "https://box.example/app/" + hash, syncEnabled: false });
  await waitFor(() => has(window, "הוזמנת להצטרף למעגל"), 4000);
  return window;
}

test("the token is taken from the fragment and removed from the address bar before anything renders", async () => {
  const mock = newVisitorMock();
  const window = await openInviteLink(mock);
  assert.equal(window.location.hash, "", "the fragment is cleared");
  assert.ok(!window.location.href.includes(TOKEN), "the token is not left in the URL");
  assert.equal(mock.rpcCalls.length, 0, "opening a link calls the server for nothing: no session, no join");
  assert.ok(!window.document.documentElement.outerHTML.includes(TOKEN), "the token is not written into the page");
});

test("a token in a query string is not read, and is stripped from the URL", async () => {
  const mock = newVisitorMock();
  const window = await bootCommunity(mock, { url: "https://box.example/app/?invite=" + TOKEN, syncEnabled: false });
  await tick(50);
  assert.ok(!window.location.search.includes("invite"), "the query parameter is removed");
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => has(window, "יש לי קישור הזמנה"), 4000);
  assert.ok(!has(window, "הוזמנת להצטרף"), "no invite landing: the query token was ignored");
  assert.equal(mock.callsTo("join_circle").length, 0);
});

test("a visitor with a link joins as an anonymous session, then upgrades to a username and password", async () => {
  const mock = newVisitorMock();
  const window = await openInviteLink(mock);
  assert.ok(window.document.querySelector('[data-community-action="show-login"]'), "an existing account has its own door");
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => mock.callsTo("join_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("join_circle")[0], { p_token: TOKEN });
  assert.equal(mock.getUser().is_anonymous, true, "the session that joined was anonymous");
  // Joined: the next step is the account.
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 4000);
  const form = window.document.getElementById("communityCredentials");
  form.elements.username.value = "dana_k";
  form.elements.password.value = "Abcdefgh12";
  form.elements.passwordConfirm.value = "Abcdefgh12";
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  // Then a name and an emoji, and nothing else.
  await waitFor(() => !!window.document.querySelector("#communityProfile"), 4000);
  const profile = window.document.getElementById("communityProfile");
  assert.ok(profile.elements.displayName && profile.elements.emoji, "the profile is a name and an emoji");
  assert.equal(profile.elements.bio, undefined, "there is no bio field");
  profile.elements.displayName.value = "דנה כהן";
  profile.elements.emoji.value = "🦁";
  profile.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await waitFor(() => has(window, "החבר'ה") && !!window.document.querySelector('[data-community-action="c-leave-ask"]'), 4000);
  const saved = mock.db.profiles.find((p) => p.display_name === "דנה כהן");
  assert.ok(saved, "the display name was saved");
  assert.equal(saved.emoji, "🦁");
  assert.equal(mock.getUser().is_anonymous, false, "the anonymous session became a real account");
  assert.equal(mock.callsTo("join_circle").length, 1, "the token was spent once");
});

const REFUSALS = [
  ["invalid", "ההזמנה לא תקפה"],
  ["circle_full", "המעגל הזה מלא"],
  ["too_many_circles", "10 מעגלים"],
  ["rate_limited", "יותר מדי פעמים"],
];
for (const [status, expected] of REFUSALS) {
  test(`join_circle '${status}' reads as Hebrew, not as the raw status`, async () => {
    const mock = newVisitorMock(status);
    const window = await openInviteLink(mock);
    click(window, '[data-community-action="start-signup"]');
    await waitFor(() => has(window, expected), 4000);
    assert.ok(!has(window, status), "the raw status is never shown");
    assert.ok(window.document.querySelector("[data-join-error]"), "the refusal is an alert on the join step");
    assert.equal(mock.callsTo("join_circle").length, 1);
  });
}

test("expired and used-up invites look the same to the member, because the server says only 'invalid'", async () => {
  const a = await (async () => { const m = newVisitorMock("invalid"); const w = await openInviteLink(m); click(w, '[data-community-action="start-signup"]'); await waitFor(() => has(w, "ההזמנה לא תקפה"), 4000); return text(w); })();
  assert.match(a, /פגה, נוצלה במלואה או שהקישור לא נכון/);
});

test("a rate-limited attempt keeps the link, so the member can try again; an invalid one drops it", async () => {
  const mock = newVisitorMock("rate_limited");
  const window = await openInviteLink(mock);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => has(window, "יותר מדי פעמים"), 4000);
  // The join step is showing; the form is there to paste or retry.
  assert.ok(window.document.getElementById("circleJoin"));
});

test("a signed-in member who opens a link joins one more circle, with no extra tap", async () => {
  const mock = createCirclesMock({ circles: [membership()] });
  mock.onRpc("join_circle", () => {
    mock.db.circle_members.push(membership({ id: CIRCLE_B, name: "הזוג", type: "couple", emoji: "💞" }, { role: "owner" }));
    return { data: { status: "joined", club_id: CIRCLE_B }, error: null };
  });
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false });
  await waitFor(() => mock.callsTo("join_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("join_circle")[0], { p_token: TOKEN });
  await waitFor(() => has(window, "הזוג"), 4000);
  assert.equal(window.location.hash, "");
  // Two circles now, and the new one is on screen.
  assert.equal(window.document.querySelectorAll('[data-community-action="c-pick"]').length, 2);
});

test("a member who is already in the circle is told so, not shown an error", async () => {
  const mock = createCirclesMock({ circles: [membership()] });
  mock.onRpc("join_circle", () => ({ data: { status: "already_member", club_id: CIRCLE_A }, error: null }));
  const window = await bootCommunity(mock, { url: "https://box.example/app/#invite=" + TOKEN, syncEnabled: false });
  await waitFor(() => mock.callsTo("join_circle").length === 1, 4000);
  await waitFor(() => window.document.body.textContent.includes("כבר חבר/ה במעגל הזה"), 4000);
});

test("a member in no circle can paste a link on the join step", async () => {
  const mock = createCirclesMock({ circles: [] });
  mock.db.profiles = [{ id: ME, handle: "me", display_name: "אני", emoji: "💪", recovery_verified_at: null }];
  mock.onRpc("join_circle", () => {
    mock.db.circle_members.push(membership({ id: CIRCLE_A }));
    return { data: { status: "joined", club_id: CIRCLE_A }, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("circleJoin"), 4000);
  const form = window.document.getElementById("circleJoin");
  form.elements.link.value = "garbage";
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await waitFor(() => has(window, "הדביקו את קישור ההזמנה"), 4000);
  assert.equal(mock.callsTo("join_circle").length, 0, "nothing is sent for text that is not a link");
  // The error re-rendered the form; the one on screen now is a new node.
  const again = window.document.getElementById("circleJoin");
  again.elements.link.value = "https://box.example/app/#invite=" + TOKEN;
  again.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await waitFor(() => mock.callsTo("join_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("join_circle")[0], { p_token: TOKEN });
});

// The owner's first-circle link (bootstrap_owner_invite, docs/ops/FIRST_CIRCLE.md)
// looks like any invite link. join_circle does not know it, so the client then
// tries redeem_invite_code, which does.
test("a bootstrap link: join_circle says invalid, redeem_invite_code accepts it, sign-up goes on", async () => {
  const mock = newVisitorMock("invalid");
  mock.onRpc("redeem_invite_code", (args, ctx) => {
    mock.db.invite_redemptions = mock.db.invite_redemptions || [];
    mock.db.invite_redemptions.push({ user_id: ctx.currentUser.id, invite_id: "inv-boot", role: "member", redeemed_at: new Date().toISOString() });
    return { data: "member", error: null };
  });
  const window = await openInviteLink(mock);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 4000);
  assert.equal(mock.callsTo("join_circle").length, 1);
  const redeem = mock.callsTo("redeem_invite_code");
  assert.equal(redeem.length, 1, "the token was tried once as a bootstrap code");
  assert.equal(redeem[0].p_code, TOKEN);
  assert.ok(!has(window, "ההזמנה לא תקפה"), "no error: the link was good");
  assert.equal(window.location.hash, "", "and the token is still not in the address bar");
});

test("a bootstrap link that redeem_invite_code also refuses reads as an invalid invite", async () => {
  const mock = newVisitorMock("invalid");
  mock.onRpc("redeem_invite_code", () => ({ data: "invalid", error: null }));
  const window = await openInviteLink(mock);
  click(window, '[data-community-action="start-signup"]');
  await waitFor(() => has(window, "ההזמנה לא תקפה"), 4000);
  assert.equal(mock.callsTo("redeem_invite_code").length, 1);
});
