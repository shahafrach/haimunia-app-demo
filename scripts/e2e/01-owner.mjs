#!/usr/bin/env node
// Test 1 - the owner (Dana), from the bootstrap link to a PR in the week view.
//
// Dana is the first person on a brand new database. She opens the link the owner
// mints with bootstrap_owner_invite() (run with psql as postgres, the way
// docs/ops/FIRST_CIRCLE.md says), signs up for real, makes a Friends circle, sets a
// weekly target, logs a set, logs a heavier set of the same lift so a PR fires, and
// looks at what the app shows her: the post-workout moment (PR first, then the
// comparison, then the weekly ring, then share), the PR card, the week view, and
// the four notification switches.
import { startWorld } from "./lib/harness.mjs";
import {
  uname, until, bootstrapToken, passWelcome, clearIncidentals, goHome, goCircle, goLog,
  openMe, section, fillCredentials, fillProfile, createCircle, logSet, acceptBackup, waitSynced, weekCards,
  one, q, userId, count, sleep,
} from "./lib/flows.mjs";

const world = await startWorld("01-owner", "Test 1: the owner (Dana)");
const dana = await world.person("dana", { ua: "ios" });
const USER = uname("dana");
const CIRCLE = "החבר'ה של דנה";
const token = bootstrapToken();
let uid = null;

// 1. The bootstrap link -------------------------------------------------------------------
await world.step(dana, "bootstrap-link", "Open the bootstrap link", async (s) => {
  await dana.goto(world.baseUrl + "#invite=" + token);
  await passWelcome(s, dana, "דנה");
  const door = await dana.waitVisible('[data-community-action="start-signup"]', 20000);
  s.check(door, "the invite screen offers a way in");
  s.check(!dana.page.url().includes("#invite") && !dana.page.url().includes(token), "the token is gone from the address bar", dana.page.url());
  s.check(await dana.waitText("הוזמנת להצטרף למעגל", 3000), "the screen says what Dana was invited to");
}, { primary: ['[data-community-action="start-signup"]'], contrast: ['[data-community-action="start-signup"]', ".chart-card .footer-note, .chart-card > div:nth-child(2)"] });

// 2. Sign up -------------------------------------------------------------------------------
await world.step(dana, "sign-up", "Sign up with a username and password", async (s) => {
  await fillCredentials(s, dana, { username: USER });
  uid = userId(USER);
  s.check(!!uid, "an account exists in auth.users", uid || "none");
  s.check(one(`select is_anonymous from auth.users where id = ${q(uid)}`) === "f", "the account is permanent, no longer anonymous");
  s.check(/\.invalid$/.test(one(`select email from auth.users where id = ${q(uid)}`) || ""), "no real email address is stored (synthetic .invalid address)");
  // The access token the browser holds must say "not anonymous" now (202610290003): the
  // upgrade keeps the token from the anonymous sign-in unless the client refreshes it.
  const readClaim = () => dana.page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x));
    if (!k) return "no session key";
    try { const t = JSON.parse(localStorage.getItem(k)).access_token; return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).is_anonymous; } catch (e) { return "unreadable: " + e.message; }
  });
  // The profile form can appear a moment before the refresh that follows the upgrade has landed.
  const t0 = Date.now();
  const claim = (await until(async () => ((await readClaim()) === false ? "ok" : null), { timeout: 8000, every: 300 })) ? false : await readClaim();
  s.note(`the claim read ${claim === false ? "false " + (Date.now() - t0) + " ms after the profile form appeared" : String(claim) + " after 8 s"}`);
  
  s.check(claim === false, "the session token says the member is permanent (refreshed after the upgrade)", String(claim));
}, { primary: ["#communityProfile button[type='submit']"], contrast: ["#communityProfile .field-label"] });

// 3. Name and emoji -----------------------------------------------------------------------
await world.step(dana, "name-emoji", "Choose a name and an emoji", async (s) => {
  await fillProfile(s, dana, { displayName: "דנה כהן", emoji: "🦁" });
  s.check(await dana.waitText("עוד אין לך מעגל", 20000), "the next screen says there is no circle yet");
  s.check(await dana.has('[data-community-action="c-create-open"]'), "and offers to create one");
  s.check(one(`select display_name from public.profiles where id = ${q(uid)}`) === "דנה כהן", "the profile holds the name");
  s.check(one(`select emoji from public.profiles where id = ${q(uid)}`) === "🦁", "and the emoji");
}, { primary: ['[data-community-action="c-create-open"]'], contrast: ['[data-community-action="c-create-open"]'] });

// 4. Create a Friends circle -----------------------------------------------------------------
await world.step(dana, "create-circle", "Create a Friends circle", async (s) => {
  await createCircle(s, dana, { type: "friends", name: CIRCLE, emoji: "🔥" });
  await clearIncidentals(s, dana);
  const text = await dana.text();
  s.check(text.includes(CIRCLE), "the circle's name is on the screen");
  s.check(text.includes("מעגל חברים"), "it is labelled as a Friends circle");
  s.check(await dana.has('[data-community-action="c-settings-open"]'), "Dana sees the owner's settings button");
  s.check(await dana.has('[data-community-action="c-invite-open"]'), "and the invite button");
  s.check(text.includes("עוד אין כלום בפיד"), "the empty feed explains itself instead of showing a blank screen");
  s.check(one(`select type from public.clubs where name = ${q(CIRCLE)}`) === "friends", "the database holds a friends circle");
  s.check(one(`select role from public.circle_members where user_id = ${q(uid)}`) === "owner", "Dana is its owner");
}, { primary: ['[data-community-action="c-invite-open"]'], contrast: ["#communityHead", ".empty"] });

// 5. Weekly target ------------------------------------------------------------------------------
await world.step(dana, "weekly-target", "Set a weekly target of 3", async (s) => {
  await openMe(s, dana);
  const saved = dana.rpc("set_weekly_target");
  await dana.page.locator("[data-weekly-target]").first().scrollIntoViewIfNeeded();
  await dana.choose("[data-weekly-target]", "3");
  s.check(!!(await saved), "set_weekly_target was called");
  s.check(await dana.waitText("היעד השבועי נשמר", 6000), "the screen confirms the target was saved");
  s.check(Number(one(`select weekly_target from public.member_targets where user_id = ${q(uid)}`)) === 3, "the database holds target 3");
  await goHome(dana);
  s.check(await dana.waitText("0 מתוך 3 אימונים", 6000), "Home shows the ring at 0 of 3");
}, { primary: ["[data-weekly-target]"], contrast: ["#circleTargetPanel .field-label", "#circleTargetPanel .footer-note"] });

// 6. The first set -----------------------------------------------------------------------------------
let firstSave = null;
await world.step(dana, "first-set", "Log the first set ever (Back Squat 60 x 5)", async (s) => {
  firstSave = await logSet(s, dana, { id: "back-squat", name: "Back Squat", weight: 60, reps: 5 });
  s.check(!!firstSave.arrival, "the first-ever set gets the arrival card", firstSave.arrival);
  s.note("After the save: " + JSON.stringify(firstSave));
  const backup = await acceptBackup(s, dana);
  s.check(backup, "the backup question appears after the first entry");
  s.note(backup ? "Answered the backup question: yes (a PR needs the server to hold the history to carry a percent)." : "The backup question never appeared.");
}, { primary: ["#bottomBarBtn"], contrast: ["#bottomBarBtn", ".exercise-select span"] });

// 7. Two more sets of the same lift -----------------------------------------------------------------
await world.step(dana, "baseline-sets", "Log the same lift twice more", async (s) => {
  for (let i = 0; i < 2; i++) {
    const r = await logSet(s, dana, { id: "back-squat", name: "Back Squat", weight: 60, reps: 5 });
    s.note(`set ${i + 2}: ${JSON.stringify(r)}`);
    s.check(!r.moment, `set ${i + 2} is not a PR and gets only the quiet check`);
  }
  await clearIncidentals(s, dana);
  const synced = await waitSynced(USER, 3);
  s.check(!!synced, "all three entries reached the server (needed for the PR percent)");
}, { primary: ["#bottomBarBtn"] });

// 8. The PR ----------------------------------------------------------------------------------------------
let momentOrder = null;
await world.step(dana, "pr-moment", "Log a heavier set so a PR fires", async (s) => {
  const r = await logSet(s, dana, { id: "back-squat", name: "Back Squat", weight: 65, reps: 5 });
  s.note("After the save: " + JSON.stringify(r));
  s.check(r.moment, "the post-workout moment opens");
  if (!r.moment) return;
  const shareT0 = Date.now();
  const shareReady = await dana.waitVisible('#momentActions [data-action="moment-share"]', 15000);
  s.note(shareReady ? `the share button was ready ${Date.now() - shareT0} ms after the moment opened (it says "preparing" until the card is drawn)` : "the share button never became ready");
  await sleep(400);
  const m = await dana.page.evaluate(() => {
    const body = document.getElementById("momentBody");
    const top = (sel) => { const e = body.querySelector(sel); return e ? e.getBoundingClientRect().top : null; };
    const actions = document.getElementById("momentActions");
    return {
      headline: (document.getElementById("momentTitle")?.innerText || "").trim(),
      pr: top(".moment-pr"), compare: top(".moment-compare"), ring: top(".moment-week"),
      actions: actions ? actions.getBoundingClientRect().top : null,
      text: (body.innerText || "").replace(/\s+/g, " ").trim(),
      actionText: (actions?.innerText || "").replace(/\s+/g, " ").trim(),
      scrolls: body.scrollHeight > body.clientHeight + 1,
      // What is actually on top at the middle of the screen: the moment, or the share prompt.
      topmost: (() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); const o = e && e.closest(".modal-overlay"); return o ? (o.id || o.getAttribute("data-cloud-dialog")) : ""; })(),
      prPromptAlsoOpen: !!document.querySelector('[data-cloud-dialog="prPrompt"]'),
    };
  });
  momentOrder = m;
  s.check(/שיא חדש/.test(m.headline), "the headline announces the PR", m.headline);
  s.check(m.pr != null && m.compare != null && m.ring != null, "the PR, the comparison and the weekly ring are all on the screen", JSON.stringify({ pr: m.pr, compare: m.compare, ring: m.ring }));
  s.check(m.pr < m.compare && m.compare < m.ring && m.ring < m.actions, "in the order PR, comparison, ring, share", JSON.stringify(m));
  s.check(/\+\d+(\.\d+)?%/.test(m.text), "the PR shows its improvement as a percent");
  s.check(/60/.test(m.text) && /65/.test(m.text), "the comparison names both sets (60 and 65)");
  s.check(/שיתוף כתמונה/.test(m.actionText), "a share button is offered", m.actionText);
  if (m.prPromptAlsoOpen) s.flag("stacked-dialogs", `The circle share prompt opened at the same time as the moment; on top at the centre of the screen: ${m.topmost}.`);
  s.note("Moment: " + m.text.slice(0, 260));
}, { primary: ["#momentActions button"], contrast: [".moment-headline", ".moment-pr-value", ".moment-pr-delta", ".moment-pr-prev", ".moment-week-sub", ".moment-compare-row"], shots: true });

// 9. The PR card ------------------------------------------------------------------------------------------
await world.step(dana, "pr-card", "Render and share the PR card", async (s) => {
  const shareSel = momentOrder && momentOrder.topmost === "prPrompt" ? '[data-pr-card="ready"]' : '#momentActions [data-action="moment-share"]';
  s.note("Share button used: " + shareSel);
  const ready = await dana.waitVisible(shareSel, 15000);
  s.check(ready, "the share button turns from 'preparing' to ready");
  if (!ready) return;
  const before = dana.downloads.length;
  await dana.tap(shareSel);
  const got = await until(() => dana.downloads.length > before, { timeout: 10000 });
  s.check(!!got, "the card is handed over (saved as a file; this Chromium has no share sheet)");
  const d = dana.downloads[dana.downloads.length - 1];
  if (d) {
    s.check(/\.png$/i.test(d.name || ""), "it is a PNG", d.name);
    s.check(d.size > 5000, "and not empty", String(d.size));
    s.note(`PR card file: ${d.name}, ${d.size} bytes, saved in the artifacts.`);
  }
  s.check(await dana.waitText(/התמונה נשמרה|התמונה נשלחה/, 6000), "a message says what happened to the image");
  // Show the card itself in the artifacts: open the PNG in the page and photograph it.
  if (d) {
    const view = await world.browser.newPage({ viewport: { width: 600, height: 800 } });
    await view.goto("file://" + d.file);
    await view.screenshot({ path: d.file.replace(/\.png$/i, "") + "-view.png" });
    await view.close();
  }
}, { shots: true });

// 10. Share the PR to the circle -------------------------------------------------------------------------
await world.step(dana, "pr-share", "Share the PR with the circle", async (s) => {
  const syncT0 = Date.now();
  s.check(!!(await waitSynced(USER, 4, 30000)), "the server holds all four entries (the PR percent is computed there)");
  s.note(`the fourth entry was on the server ${Date.now() - syncT0} ms after this step began`);
  const momentOpen = await dana.page.evaluate(() => !!document.getElementById("momentOverlay")?.classList.contains("open"));
  // Close the moment first only if it is the one on top; otherwise answer the prompt that covers it.
  if (momentOpen && !(momentOrder && momentOrder.topmost === "prPrompt")) await dana.tap('#momentOverlay [data-action="close-moment"]');
  const prompt = await dana.waitVisible('[data-cloud-dialog="prPrompt"]', 8000);
  s.check(prompt, "after the moment the share prompt is there to answer");
  if (!prompt) return;
  s.note("Prompt: " + (await dana.inner('[data-cloud-dialog="prPrompt"]')).slice(0, 300));
  const done = dana.rpc("pr_share");
  await dana.tap('[data-community-action="pr-share"]');
  const resp = await done;
  s.check(!!resp && resp.ok(), "pr_share succeeded", resp ? String(resp.status()) : "no call");
  const sent = dana.sent("pr_share").pop() || {};
  s.check(!("p_weight" in sent), "no absolute weight was sent (the circle does not show weights)", JSON.stringify(sent));
  s.check(await dana.waitText("השיא שותף למעגלים", 8000), "the screen confirms the PR was shared");
  if (await dana.page.evaluate(() => !!document.getElementById("momentOverlay")?.classList.contains("open"))) await dana.tap('#momentOverlay [data-action="close-moment"]');
  const row = one(`select result_text from public.workout_posts where author_id = ${q(uid)} and post_type = 'POST_PR'`);
  s.check(/^\+\d/.test(row || ""), "the post in the database carries the percent", row || "none");
  await clearIncidentals(s, dana);
}, { contrast: ['[data-cloud-dialog="prPrompt"] h2', '[data-cloud-dialog="prPrompt"] .footer-note'] });

// 11. The week view -------------------------------------------------------------------------------------------
await world.step(dana, "week-view", "Open the week view", async (s) => {
  await goCircle(dana);
  await dana.waitVisible("#circlePanel", 12000);
  await section(s, dana, "week");
  const seen = await dana.waitVisible("[data-week-member]", 15000);
  s.check(seen, "the week view shows Dana's card");
  const cards = await weekCards(dana);
  s.check(cards.length === 1 && cards[0].me, "one card, and it is hers", JSON.stringify(cards));
  s.check(/\d+%/.test(cards[0]?.text || ""), "it shows a percent of her target", cards[0]?.text);
  s.check(/אין דירוג/.test(await dana.text()), "and says there is no ranking");
  s.note("Week card: " + (cards[0]?.text || ""));
  const ready = await dana.waitVisible('[data-week-card="ready"]', 15000);
  s.check(ready, "the week card can be shared");
}, { primary: ["[data-week-member]", '[data-week-card="ready"]'], contrast: ["[data-week-member]", ".week-list + .footer-note, .footer-note"] });

// 12. Notification switches ---------------------------------------------------------------------------------------
await world.step(dana, "notifications", "Turn on all four notification switches", async (s) => {
  await openMe(s, dana);
  const toggles = dana.page.locator("input[data-notif-pref-toggle]");
  await toggles.first().waitFor({ state: "attached", timeout: 10000 });
  s.check((await toggles.count()) === 4, "there are four switches", String(await toggles.count()));
  await toggles.first().scrollIntoViewIfNeeded();
  const labels = await dana.page.$$eval("[data-notif-pref-row]", (rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
  s.note("Switches: " + labels.join(" | "));
  for (let i = 0; i < 4; i++) {
    const t = toggles.nth(i);
    if (await t.isChecked()) continue;
    const saved = dana.page.waitForResponse((r) => r.url().includes("notification_preferences") && r.request().method() !== "GET", { timeout: 10000 }).catch(() => null);
    await dana.tap(t);
    await saved;
    await until(async () => !(await t.isDisabled()), { timeout: 6000 });
  }
  const on = await dana.page.$$eval("input[data-notif-pref-toggle]", (els) => els.map((e) => e.checked));
  s.check(on.length === 4 && on.every(Boolean), "all four switches show on", JSON.stringify(on));
  s.check(count(`select count(*) from public.notification_preferences where user_id = ${q(uid)} and channel <> 'off'`) === 4, "four preference rows are stored");
  s.note("Message shown: " + ((await dana.text()).match(/כדי לקבל התראות[^.]*\./) || ["none"])[0]);
}, { primary: ["input[data-notif-pref-toggle]"], contrast: ["#notifPrefs [data-notif-pref-row] span", "#notifPrefs > div"] });

process.exit(await world.finish());
