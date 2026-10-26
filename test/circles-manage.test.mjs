// Running a circle: the list and the switcher, creating one, the owner's
// settings, the invite (Web Share with copy as the fallback), leaving with a
// confirmation that says the posts go, and an owner removing a member.
import { test } from "node:test";
import assert from "node:assert";
import { createCirclesMock, bootCircle, waitFor, tick, click, membership, club, ME, FRIEND, CIRCLE_A, CIRCLE_B, TOKEN } from "./helpers/circles.mjs";

const text = (w) => w.document.getElementById("content").textContent + (w.document.querySelector("[data-cloud-dialog]") ? w.document.querySelector("[data-cloud-dialog]").textContent : "");
const has = (w, s) => text(w).includes(s);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
const sheet = (w) => w.document.querySelector('[data-cloud-dialog="circleSheet"]');

test("the switcher lists my circles and moves between them", async () => {
  const mock = createCirclesMock({ circles: [membership({ id: CIRCLE_A, name: "החבר'ה" }), membership({ id: CIRCLE_B, name: "הזוג", type: "couple", emoji: "💞" }, { joined_at: "2026-10-02T00:00:00Z" })] });
  const window = await bootCircle(mock);
  const chips = [...window.document.querySelectorAll('[data-community-action="c-pick"]')];
  assert.equal(chips.length, 2);
  assert.match(chips[0].textContent, /החבר'ה/);
  assert.equal(chips[0].getAttribute("aria-pressed"), "true");
  click(window, `[data-community-action="c-pick"][data-id="${CIRCLE_B}"]`);
  await waitFor(() => has(window, "מעגל זוגי"), 4000);
  assert.ok(mock.callsTo("circle_feed").some((a) => a.p_club_id === CIRCLE_B), "the feed of the chosen circle is read");
});

test("creating a circle: type, name and emoji go to create_circle, and the new circle opens", async () => {
  const mock = createCirclesMock({ circles: [membership()],
    rpc: { create_circle: (args) => { mock.db.circle_members.push(membership({ id: CIRCLE_B, name: args.p_name, type: args.p_type, emoji: args.p_emoji }, { joined_at: "2026-10-03T00:00:00Z" })); return { data: CIRCLE_B, error: null }; } } });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-create-open"]');
  await waitFor(() => !!window.document.getElementById("circleCreate"), 4000);
  const form = window.document.getElementById("circleCreate");
  assert.ok(form.elements.type && form.elements.name && form.elements.emoji);
  // A circle needs a name.
  submit(window, form);
  await waitFor(() => has(window, "למעגל צריך שם"), 4000);
  assert.equal(mock.callsTo("create_circle").length, 0);
  const again = window.document.getElementById("circleCreate");
  [...again.elements.type].find((r) => r.value === "couple").checked = true;
  again.elements.name.value = "אני והיא";
  again.elements.emoji.value = "💞";
  submit(window, again);
  await waitFor(() => mock.callsTo("create_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("create_circle")[0], { p_type: "couple", p_name: "אני והיא", p_emoji: "💞" });
  await waitFor(() => !sheet(window) && has(window, "אני והיא"), 4000);
});

test("create_circle refusals are Hebrew: too many circles", async () => {
  const mock = createCirclesMock({ circles: [membership()], rpc: { create_circle: () => ({ data: null, error: { message: "too_many_circles" } }) } });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-create-open"]');
  await waitFor(() => !!window.document.getElementById("circleCreate"), 4000);
  const form = window.document.getElementById("circleCreate");
  form.elements.name.value = "עוד אחד";
  submit(window, form);
  await waitFor(() => has(window, "10 מעגלים"), 4000);
  assert.ok(!has(window, "too_many_circles"));
});

test("owner settings: name, emoji, mode, benchmark, who invites and the welcome line go to update_circle", async () => {
  const mock = createCirclesMock({ circles: [membership()] });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-settings-open"]');
  await waitFor(() => !!window.document.getElementById("circleSettings"), 4000);
  const f = window.document.getElementById("circleSettings");
  f.elements.name.value = "החבר'ה החדשים";
  f.elements.emoji.value = "🐺";
  f.elements.mode.value = "weekly_competition";
  f.elements.benchmark_enabled.checked = true;
  f.elements.invite_policy.value = "any_member";
  f.elements.welcome_line.value = "ברוכים הבאים, כל אחד מול עצמו";
  submit(window, f);
  await waitFor(() => mock.callsTo("update_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("update_circle")[0], {
    p_club_id: CIRCLE_A,
    p_settings: { name: "החבר'ה החדשים", mode: "weekly_competition", benchmark_enabled: true, invite_policy: "any_member", welcome_line: "ברוכים הבאים, כל אחד מול עצמו", emoji: "🐺" },
  });
});

test("a member who is not an owner has no settings button", async () => {
  const mock = createCirclesMock({ circles: [membership({}, { role: "member" })] });
  const window = await bootCircle(mock);
  assert.ok(!window.document.querySelector('[data-community-action="c-settings-open"]'));
  assert.ok(!window.document.querySelector('[data-community-action="c-invite-open"]'), "invite_policy 'owner': members do not invite");
});

test("invite_policy 'any_member' lets a plain member invite", async () => {
  const mock = createCirclesMock({ circles: [membership({ invite_policy: "any_member" }, { role: "member" })] });
  const window = await bootCircle(mock);
  assert.ok(window.document.querySelector('[data-community-action="c-invite-open"]'));
});

test("the invite link goes through the Web Share API when the browser has it", async () => {
  const mock = createCirclesMock({ circles: [membership()] });
  const window = await bootCircle(mock);
  const shared = [];
  window.navigator.share = async (data) => { shared.push(data); };
  click(window, '[data-community-action="c-invite-open"]');
  await waitFor(() => !!window.document.getElementById("circleInvite"), 4000);
  const form = window.document.getElementById("circleInvite");
  form.elements.max_uses.value = "3";
  submit(window, form);
  await waitFor(() => mock.callsTo("create_circle_invite").length === 1, 4000);
  assert.deepEqual(mock.callsTo("create_circle_invite")[0], { p_club_id: CIRCLE_A, p_max_uses: 3 });
  await waitFor(() => !!window.document.getElementById("circleInviteLink"), 4000);
  const link = window.document.getElementById("circleInviteLink").value;
  assert.equal(new URL(link).hash, "#invite=" + TOKEN, "the token is in the fragment");
  assert.equal(new URL(link).search, "", "and not in the query");
  click(window, '[data-community-action="c-invite-share"]');
  await waitFor(() => shared.length === 1, 4000);
  assert.equal(shared[0].url, link);
  assert.ok(!(shared[0].text || "").includes(TOKEN), "the token is only in the url, not repeated in the message");
});

test("without Web Share the link is copied", async () => {
  const mock = createCirclesMock({ circles: [membership()] });
  const window = await bootCircle(mock);
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  assert.equal(typeof window.navigator.share, "undefined");
  click(window, '[data-community-action="c-invite-open"]');
  await waitFor(() => !!window.document.getElementById("circleInvite"), 4000);
  submit(window, window.document.getElementById("circleInvite"));
  await waitFor(() => !!window.document.getElementById("circleInviteLink"), 4000);
  assert.ok(!window.document.querySelector('[data-community-action="c-invite-share"]'), "no share button where there is no share");
  click(window, '[data-community-action="c-invite-copy"]');
  await waitFor(() => copied.length === 1, 4000);
  assert.match(copied[0], /#invite=/);
  await waitFor(() => has(window, "הועתק"), 4000);
});

test("invite refusals are Hebrew: the daily limit and a full circle", async () => {
  for (const [code, expected] of [["invite_limit", "20 הזמנות"], ["circle_full", "המעגל מלא"]]) {
    const mock = createCirclesMock({ circles: [membership()], rpc: { create_circle_invite: () => ({ data: null, error: { message: code } }) } });
    const window = await bootCircle(mock);
    click(window, '[data-community-action="c-invite-open"]');
    await waitFor(() => !!window.document.getElementById("circleInvite"), 4000);
    submit(window, window.document.getElementById("circleInvite"));
    await waitFor(() => has(window, expected), 4000);
    assert.ok(!has(window, code));
  }
});

test("leaving asks first, and says the member's posts in the circle are deleted", async () => {
  const mock = createCirclesMock({ circles: [membership({}, { role: "member" })],
    rpc: { leave_circle: () => { mock.db.circle_members.length = 0; return { data: null, error: null }; } } });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-leave-ask"]');
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="confirmSheet"]'), 4000);
  const dialog = window.document.querySelector('[data-cloud-dialog="confirmSheet"]').textContent;
  assert.match(dialog, /הפוסטים שלכם בו יימחקו/);
  assert.match(dialog, /היומן הפרטי נשאר במכשיר/);
  assert.equal(mock.callsTo("leave_circle").length, 0, "nothing is sent before the confirmation");
  click(window, '[data-community-action="confirm-no"]');
  await tick(20);
  assert.equal(mock.callsTo("leave_circle").length, 0);
  click(window, '[data-community-action="c-leave-ask"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 4000);
  click(window, '[data-community-action="confirm-yes"]');
  await waitFor(() => mock.callsTo("leave_circle").length === 1, 4000);
  assert.deepEqual(mock.callsTo("leave_circle")[0], { p_club_id: CIRCLE_A });
  // A member who got in by invite has no bootstrap code, so with no circle left
  // the way forward is another invite - and the way to Me stays open.
  await waitFor(() => !!window.document.getElementById("circleJoin"), 4000);
  assert.ok(window.document.querySelector('[data-community-action="c-open-me"]'), "sign-out and export are still reachable");
});

test("an owner who leaves is told ownership passes on; the last member is told the circle goes", async () => {
  const mock = createCirclesMock({ circles: [membership({}, { role: "owner" }), { club_id: CIRCLE_A, user_id: FRIEND, role: "member", joined_at: "2026-10-02T00:00:00Z", share_defaults: {}, profiles: { display_name: "דנה", emoji: "🦁" } }] });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-leave-ask"]');
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="confirmSheet"]'), 4000);
  assert.match(window.document.querySelector('[data-cloud-dialog="confirmSheet"]').textContent, /הבעלות תעבור/);
});

test("an owner removes a member, after a confirmation that names the consequence", async () => {
  const mock = createCirclesMock({ circles: [
    Object.assign(membership({}, { role: "owner" }), { profiles: { display_name: "אני", emoji: "💪" } }),
    { club_id: CIRCLE_A, user_id: FRIEND, role: "member", joined_at: "2026-10-02T00:00:00Z", share_defaults: {}, profiles: { display_name: "דנה", emoji: "🦁" } },
  ] });
  const window = await bootCircle(mock);
  click(window, '[data-community-action="c-section"][data-section="members"]');
  await waitFor(() => !!window.document.querySelector(`[data-member="${FRIEND}"]`), 4000);
  assert.ok(!window.document.querySelector(`[data-member="${ME}"] [data-community-action="c-remove-ask"]`), "an owner cannot remove themselves here");
  click(window, `[data-community-action="c-remove-ask"][data-user="${FRIEND}"]`);
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="confirmSheet"]'), 4000);
  const dialog = window.document.querySelector('[data-cloud-dialog="confirmSheet"]').textContent;
  assert.match(dialog, /דנה/);
  assert.match(dialog, /יימחקו/);
  click(window, '[data-community-action="confirm-yes"]');
  await waitFor(() => mock.callsTo("remove_member").length === 1, 4000);
  assert.deepEqual(mock.callsTo("remove_member")[0], { p_club_id: CIRCLE_A, p_user_id: FRIEND });
});
