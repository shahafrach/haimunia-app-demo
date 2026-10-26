// The shape of the app (four tabs: Home, Circle, a centre Log button, Progress;
// Me from the avatar on Home) and Me itself: a profile that is a display name
// and an emoji, the personal weekly target and pause, and what the member
// shares in each circle. No bio, no privacy toggles, no dropped column read.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createCirclesMock, bootCommunity, bootCircle, waitFor, tick, click, membership, ME, FRIEND, CIRCLE_A, CIRCLE_B } from "./helpers/circles.mjs";

const text = (w) => w.document.getElementById("content").textContent;
const has = (w, s) => text(w).includes(s);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));

async function bootHome(mock, opts) {
  const window = await bootCommunity(mock, Object.assign({ syncEnabled: false }, opts || {}));
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-open-me"]'), 4000);
  return window;
}
async function bootMe(mock, opts) {
  const window = await bootHome(mock, opts);
  click(window, '[data-community-action="c-open-me"]');
  await waitFor(() => !!window.document.querySelector("#communityProfile"), 4000);
  return window;
}

test("the bottom bar has four items in order: Home, Circle, the centre Log button, Progress", async () => {
  const mock = createCirclesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  const tabs = [...window.document.querySelectorAll("#bottomTabBar .tabbtn")];
  assert.deepEqual(tabs.map((t) => t.id), ["tabHomeBtn", "tabCommunityBtn", "tabAddBtn", "tabHistoryBtn"]);
  assert.deepEqual(tabs.map((t) => t.querySelector("span:last-child").textContent.trim()), ["בית", "מעגל", "רישום", "התקדמות"]);
  assert.ok(tabs[2].classList.contains("tabbtn--log"), "the Log button is the centre one");
  assert.ok(!window.document.querySelector("#bottomTabBar #tabMeBtn"), "Me is not a tab");
});

test("calendar and the workout library are still one step away, in the menu", async () => {
  const mock = createCirclesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  assert.ok(!window.document.querySelector("#bottomTabBar #tabCalendarBtn"));
  assert.ok(window.document.querySelector("#navMenuList #tabCalendarBtn"));
  assert.ok(window.document.querySelector("#navMenuList #tabWodBtn"));
});

test("Home shows my week, my circles and the avatar that opens Me", async () => {
  const mock = createCirclesMock({ circles: [membership(), membership({ id: CIRCLE_B, name: "הזוג", type: "couple", emoji: "💞" })], targets: [{ user_id: ME, weekly_target: 3, paused_until: null }] });
  const window = await bootHome(mock);
  assert.match(text(window), /השבוע שלי/);
  await waitFor(() => has(window, "מתוך 3 אימונים השבוע"), 4000);
  assert.equal(window.document.querySelectorAll('[data-community-action="c-open-circle"]').length, 2);
  assert.match(window.document.querySelector('[data-community-action="c-open-me"]').textContent, /💪/, "the avatar is the member's emoji");
  click(window, `[data-community-action="c-open-circle"][data-id="${CIRCLE_B}"]`);
  await waitFor(() => has(window, "מעגל זוגי"), 4000);
  assert.equal(window.document.getElementById("tabCommunityBtn").classList.contains("active"), true);
});

test("Me is a display name and an emoji, and nothing else about the member", async () => {
  const mock = createCirclesMock();
  const window = await bootMe(mock);
  const form = window.document.getElementById("communityProfile");
  assert.deepEqual([...form.elements].filter((e) => e.name).map((e) => e.name), ["displayName", "emoji"]);
  assert.equal(window.document.querySelector("[data-privacy-field]"), null, "no profile privacy toggles");
  assert.ok(!has(window, "קצת עליי"), "no bio");
  form.elements.displayName.value = "אני החדש";
  form.elements.emoji.value = "🐺";
  submit(window, form);
  await waitFor(() => mock.db.profiles.find((p) => p.id === ME).display_name === "אני החדש", 4000);
  const saved = mock.db.profiles.find((p) => p.id === ME);
  assert.equal(saved.emoji, "🐺");
  assert.ok(!("bio" in saved));
  assert.ok(!mock.rpcCalls.some((c) => JSON.stringify(c.args || {}).includes("bio")));
});

test("an emoji is required, and a letter is not an emoji", async () => {
  const mock = createCirclesMock();
  const window = await bootMe(mock);
  const form = window.document.getElementById("communityProfile");
  form.elements.emoji.value = "x";
  submit(window, form);
  await waitFor(() => has(window, "בחרו אימוג'י"), 4000);
  assert.equal(mock.db.profiles.find((p) => p.id === ME).emoji, "💪");
});

test("the weekly target and the pause live in Me and go to set_weekly_target and set_pause", async () => {
  const mock = createCirclesMock({ targets: [] });
  const window = await bootMe(mock);
  const select = window.document.querySelector("[data-weekly-target]");
  select.value = "4";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.callsTo("set_weekly_target").length === 1, 4000);
  assert.deepEqual(mock.callsTo("set_weekly_target")[0], { p_target: 4 });
  click(window, '[data-community-action="c-pause"][data-days="14"]');
  await waitFor(() => mock.callsTo("set_pause").length === 1, 4000);
  const until = mock.callsTo("set_pause")[0].p_until;
  assert.match(until, /^\d{4}-\d{2}-\d{2}$/);
  const days = (new Date(until + "T00:00:00Z") - new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) / 86400000;
  assert.ok(days >= 13 && days <= 15, "two weeks from today");
});

test("resuming from a pause sends a null date", async () => {
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const mock = createCirclesMock({ targets: [{ user_id: ME, weekly_target: 3, paused_until: future }] });
  const window = await bootMe(mock);
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-pause"][data-days="0"]'), 4000);
  click(window, '[data-community-action="c-pause"][data-days="0"]');
  await waitFor(() => mock.callsTo("set_pause").length === 1, 4000);
  assert.deepEqual(mock.callsTo("set_pause")[0], { p_until: null });
});

test("what I share is set per circle with set_share_defaults, merged one key at a time", async () => {
  const mock = createCirclesMock({ circles: [membership({ id: CIRCLE_A }), membership({ id: CIRCLE_B, name: "הזוג", type: "couple" })] });
  const window = await bootMe(mock);
  const box = window.document.querySelector(`[data-share-setting="show_weights"][data-circle="${CIRCLE_B}"]`);
  assert.equal(box.checked, false, "weights are hidden by default");
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => mock.callsTo("set_share_defaults").length === 1, 4000);
  assert.deepEqual(mock.callsTo("set_share_defaults")[0], { p_club_id: CIRCLE_B, p_defaults: { show_weights: true } });
  const friendsBox = window.document.querySelector(`[data-share-setting="share_workouts"][data-circle="${CIRCLE_A}"]`);
  assert.equal(friendsBox.checked, false, "a friends circle shares a count, not the workouts, by default");
});

test("nothing in the client reads a dropped profile column", () => {
  const files = ["cloud.js", "app.js", "src/community/auth.js", "src/community/privacy.js", "src/community/posts.js", "src/community/outward.js", "src/community/share-prompt.js", "src/community/circles.js", "src/community/circles-ui.js", "src/community/circles-sheets.js"];
  const dropped = ["show_workout_results", "visible_to_club", "show_prs", "show_achievements", "show_attendance", "show_upcoming_booking", "show_in_attendee_lists", "in_leaderboards", "allow_follows", "allow_mentions", "allow_messages"];
  for (const f of files) {
    const src = readFileSync(new URL("../" + f, import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const col of dropped) assert.ok(!src.includes(col), `${f} must not read ${col}`);
    assert.ok(!/\bbio\b/.test(src), `${f} must not read the bio`);
  }
});

test("a member in no circle can still reach Me: sign-out and account deletion do not need a circle", async () => {
  const mock = createCirclesMock({ circles: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-open-me"]'), 4000);
  click(window, '[data-community-action="c-open-me"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="sign-out"]'), 4000);
  assert.ok(window.document.querySelector('[data-community-action="delete-account"]'));
});
