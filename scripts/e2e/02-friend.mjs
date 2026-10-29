#!/usr/bin/env node
// Test 2 - the friend (Yoav), from an invite in WhatsApp to leaving and rejoining.
//
// Dana starts a circle and logs a workout. Yoav gets her invite in WhatsApp, opens it
// in the WhatsApp browser first (which cannot hold a sign-up), then in a normal
// browser, signs up and lands in Dana's circle. He reacts three ways, Dana tags him
// as trained together and he confirms, he posts a workout of his own, leaves
// (his posts go with him), Dana invites him again and he rejoins.
import { startWorld } from "./lib/harness.mjs";
import {
  uname, until, bootstrapToken, passWelcome, landOnInvite, clearIncidentals, goHome, goCircle, openMe, section,
  fillCredentials, fillProfile, createCircle, makeInvite, joinByPaste, leaveCircle, shareSetting, logSet,
  seeInFeed, feedCards, one, q, userId, count, sleep,
} from "./lib/flows.mjs";

const world = await startWorld("02-friend", "Test 2: the friend (Yoav)");
const dana = await world.person("dana", { ua: "ios" });
const yoavWA = await world.person("yoav-whatsapp", { ua: "whatsapp" });
const yoav = await world.person("yoav", { ua: "android" });
const D = uname("dana");
const Y = uname("yoav");
const CIRCLE = "הריצה של יום חמישי";
const LIFT = { id: "back-squat", name: "Back Squat", weight: 60, reps: 5 };
const LIFT2 = { id: "deadlift", name: "Deadlift", weight: 70, reps: 5 };
let danaId = null, yoavId = null, clubId = null, invite1 = null;

const workoutCard = (name) => `article.post-card[data-post-type="POST_WORKOUT"]:has-text("${name}")`;

// 1. Dana starts a circle -----------------------------------------------------------------------
await world.step(dana, "dana-circle", "Dana signs up and creates the circle", async (s) => {
  await dana.goto(world.baseUrl + "#invite=" + bootstrapToken());
  await passWelcome(s, dana, "דנה");
  await fillCredentials(s, dana, { username: D });
  await fillProfile(s, dana, { displayName: "דנה", emoji: "🦁" });
  await dana.waitText("עוד אין לך מעגל", 20000);
  await createCircle(s, dana, { type: "friends", name: CIRCLE, emoji: "🏃" });
  await clearIncidentals(s, dana);
  danaId = userId(D);
  clubId = one(`select id from public.clubs where name = ${q(CIRCLE)}`);
  s.check(!!clubId, "the circle exists");
  s.check((await dana.text()).includes(CIRCLE), "and its name is on Dana's screen");
});

// 2. Dana shares her workouts ---------------------------------------------------------------------
await world.step(dana, "dana-share-setting", "Dana turns on sharing workouts", async (s) => {
  await openMe(s, dana);
  const changed = await shareSetting(s, dana, CIRCLE, "share_workouts", true);
  s.check(changed, "the 'share workouts' switch was off by default in a Friends circle and Dana turned it on");
  s.check(one(`select share_defaults->>'share_workouts' from public.circle_members where user_id = ${q(danaId)}`) === "true", "the database holds her choice");
  s.check(!(one(`select share_defaults->>'show_weights' from public.circle_members where user_id = ${q(danaId)}`) === "true"), "weights stay hidden");
}, { primary: ['#circleShareSettings input[data-share-setting="share_workouts"]'], contrast: ["#circleShareSettings .log-row span"] });

// 3. Dana logs a workout ----------------------------------------------------------------------------
await world.step(dana, "dana-logs", "Dana logs a set and it goes to the circle", async (s) => {
  const r = await logSet(s, dana, LIFT);
  s.note("After the save: " + JSON.stringify(r));
  const bar = await dana.waitVisible("[data-share-bar]", 10000);
  s.check(bar, "a bar says where the workout went");
  if (bar) s.check(/האימון שותף/.test(await dana.inner("[data-share-bar]")), "it says the workout was shared", await dana.inner("[data-share-bar]"));
  const title = await until(() => one(`select title from public.workout_posts where author_id = ${q(danaId)} and club_id = ${q(clubId)} and title is not null`), { timeout: 8000 });
  s.check(title === "Back Squat", "the post in the circle names the lift", String(title));
  const result = one(`select coalesce(result_text,'') from public.workout_posts where author_id = ${q(danaId)} and club_id = ${q(clubId)} and title is not null`) || "";
  s.check(!/ק["״]?ג/.test(result), "and carries no kilograms", result);
}, { primary: ["#bottomBarBtn"], contrast: ["[data-share-bar]"] });

// 4. Dana invites Yoav ----------------------------------------------------------------------------------
await world.step(dana, "dana-invite", "Dana creates an invite link", async (s) => {
  await goCircle(dana);
  await dana.waitVisible("#circlePanel", 12000);
  const made = await makeInvite(s, dana);
  s.check(!!made.token, "an invite link is made", made.error || "");
  invite1 = made.token;
  s.check(/^[a-f0-9]{64}$/.test(invite1 || ""), "it carries a 64-hex token after the #", String(invite1).length);
  s.check(count(`select count(*) from public.circle_invites where club_id = ${q(clubId)}`) === 1, "one invite is stored, as a hash");
}, { primary: ['[data-community-action="c-invite-open"]'] });

// 5. Yoav opens it in WhatsApp -------------------------------------------------------------------------------
await world.step(yoavWA, "yoav-whatsapp", "Yoav opens the link inside WhatsApp", async (s) => {
  const usersBefore = count("select count(*) from auth.users");
  await yoavWA.goto(world.baseUrl + "#invite=" + invite1);
  await passWelcome(s, yoavWA, "יואב");
  const gate = await landOnInvite(s, yoavWA, "[data-inapp-browser]");
  s.check(gate, "the open-in-browser screen appears");
  if (!gate) return;
  const text = await yoavWA.inner("[data-inapp-browser]");
  s.check(/Safari/.test(text) && /WhatsApp/.test(text), "it names Safari and WhatsApp", text.slice(0, 160));
  s.check((await yoavWA.count("[data-inapp-browser] li")) === 3, "with three numbered steps");
  s.check(yoavWA.page.url().endsWith("#invite=" + invite1), "the invite stays in the address so it survives the switch");
  s.check(await yoavWA.has('[data-community-action="sh-inapp-copy"]'), "there is a copy-link button");
  s.check(await yoavWA.has('[data-community-action="sh-inapp-continue"]'), "and a way to continue anyway");
  s.check(count("select count(*) from auth.users") === usersBefore, "no account was created in the WhatsApp browser");
  s.note("Steps shown: " + text.slice(0, 420));
}, { primary: ['[data-community-action="sh-inapp-copy"]'], contrast: ["[data-inapp-browser] li span:last-child", '[data-community-action="sh-inapp-continue"]'] });

// 6. Yoav signs up in a normal browser ---------------------------------------------------------------------------
await world.step(yoav, "yoav-signup", "Yoav opens the link in his browser and signs up", async (s) => {
  await yoav.goto(world.baseUrl + "#invite=" + invite1);
  await passWelcome(s, yoav, "יואב");
  await fillCredentials(s, yoav, { username: Y });
  await fillProfile(s, yoav, { displayName: "יואב", emoji: "🌿" });
  const inside = await yoav.waitVisible('[data-community-action="c-leave-ask"]', 25000);
  s.check(inside, "Yoav lands inside Dana's circle");
  await clearIncidentals(s, yoav);
  yoavId = userId(Y);
  s.check((await yoav.text()).includes(CIRCLE), "the circle's name is on his screen");
  s.check(one(`select role from public.circle_members where user_id = ${q(yoavId)} and club_id = ${q(clubId)}`) === "member", "he is a member, not an owner");
  s.check(!(await yoav.has('[data-community-action="c-settings-open"]')), "he does not see the owner's settings");
}, { primary: ['[data-community-action="c-leave-ask"]'] });

// 7. Yoav sees Dana's post ------------------------------------------------------------------------------------------
await world.step(yoav, "yoav-feed", "Yoav sees Dana's post", async (s) => {
  const r = await seeInFeed(s, yoav, /Back Squat/);
  s.check(r.found, "Dana's workout is in his feed", r.cards.map((c) => c.text.slice(0, 60)).join(" | "));
  const card = r.cards.find((c) => /Back Squat/.test(c.text));
  s.check(!!card && /דנה/.test(card.text), "it names its author", card ? card.text : "");
  s.check(!!card && !/60/.test(card.text), "and does not show her weight", card ? card.text : "");
  s.note("Card: " + (card ? card.text : "none"));
}, { primary: ['article.post-card [data-community-action="react"]'], contrast: ["article.post-card .post-title", "article.post-card .post-result", "article.post-card .post-head-text"] });

// 8. Yoav reacts three ways ------------------------------------------------------------------------------------------
await world.step(yoav, "yoav-react", "Yoav reacts with all three reactions", async (s) => {
  const kinds = await yoav.page.$$eval(`${workoutCard("Back Squat")} [data-community-action="react"]`, (els) => els.map((e) => e.dataset.kind));
  s.check(JSON.stringify(kinds) === JSON.stringify(["fist_bump", "fire", "clap"]), "exactly three reactions are offered", kinds.join(","));
  for (const kind of ["fist_bump", "fire", "clap"]) {
    const sel = `${workoutCard("Back Squat")} [data-community-action="react"][data-kind="${kind}"]`;
    const done = yoav.rpc("toggle_reaction");
    await yoav.tap(sel);
    await done;
    const pressed = await yoav.page.waitForFunction((k) => document.querySelector(`article.post-card [data-community-action="react"][data-kind="${k}"]`)?.getAttribute("aria-pressed") === "true", kind, { timeout: 8000 }).then(() => true, () => false);
    s.check(pressed, `${kind} shows as pressed`);
  }
  const mine = count(`select count(*) from public.reactions where user_id = ${q(yoavId)}`);
  s.check(mine === 3, "three reactions are stored for him", String(mine));
  const kindsStored = (await import("./lib/db.mjs")).sql(`select kind from public.reactions where user_id = ${q(yoavId)} order by kind`).map((r) => r[0]).join(",");
  s.check(kindsStored === "clap,fire,fist_bump", "one of each kind", kindsStored);
}, { primary: ['article.post-card [data-community-action="react"]'], contrast: ["article.post-card .reaction-pill.is-mine"] });

// 9. Dana sees the reactions -----------------------------------------------------------------------------------------------
await world.step(dana, "dana-sees-reactions", "Dana sees Yoav's reactions", async (s) => {
  await dana.reload();
  const r = await seeInFeed(s, dana, /Back Squat/);
  s.check(r.found, "her post is there");
  const labels = await dana.page.$$eval(`${workoutCard("Back Squat")} [data-community-action="react"]`, (els) => els.map((e) => e.getAttribute("aria-label")));
  s.check(labels.length === 3 && labels.every((l) => /, 1$/.test(l)), "each reaction shows a count of 1", labels.join(" | "));
  s.check(await dana.has(`${workoutCard("Back Squat")} [data-community-action="reactors"]`), "and a link to see who reacted");
});

// 10. Dana tags Yoav -------------------------------------------------------------------------------------------------------------
await world.step(dana, "dana-tags", "Dana tags Yoav as trained together", async (s) => {
  const card = workoutCard("Back Squat");
  await dana.tap(`${card} [data-community-action="toggle-post-menu"]`);
  const item = await dana.waitVisible('[data-community-action="post-tag-partners"]', 6000);
  s.check(item, "her own post's menu offers the tagging");
  if (!item) return;
  await dana.tap('[data-community-action="post-tag-partners"]');
  const panel = await dana.waitVisible("[data-partners-panel] input[data-partner-pick]", 12000);
  s.check(panel, "the panel lists the circle's other member");
  if (!panel) return;
  s.check((await dana.count("[data-partners-panel] input[data-partner-pick]")) === 1, "and only him");
  s.check(/יואב/.test(await dana.inner("[data-partners-panel]")), "by name");
  await dana.tap("[data-partners-panel] input[data-partner-pick]");
  const saved = dana.rpc("post_tag_training_partners");
  await dana.tap('[data-community-action="partners-save"]');
  s.check(!!(await saved), "the tag was sent");
  s.check(await dana.waitText("התיוגים נשמרו", 8000), "the screen confirms the tag was saved");
  s.check(count(`select count(*) from public.post_training_partners where tagged_user_id = ${q(yoavId)} and confirmed_at is null`) === 1, "it is stored as pending until Yoav confirms");
  s.note("Card after tagging: " + ((await feedCards(dana)).find((c) => /Back Squat/.test(c.text)) || {}).text);
}, { primary: ["[data-partners-panel] .chip-btn.primary"], contrast: ["[data-partners-panel] .field-label", "[data-partners-panel] div"] });

// 11. Yoav confirms --------------------------------------------------------------------------------------------------------------
await world.step(yoav, "yoav-confirms", "Yoav confirms training together", async (s) => {
  await goHome(yoav);
  let card = await yoav.waitVisible("[data-pending-tags]", 5000);
  if (!card) { await yoav.reload(); await goHome(yoav); card = await yoav.waitVisible("[data-pending-tags]", 10000); if (card) s.flag("no-refresh", "The pending tag only appeared on Home after a full page reload."); }
  s.check(card, "a 'trained together?' card waits on Home");
  if (!card) return;
  s.check(/דנה/.test(await yoav.inner("[data-pending-tags]")), "it names Dana");
  s.check(/רק אחרי האישור/.test(await yoav.inner("[data-pending-tags]")), "and says it counts only after he confirms");
  const done = yoav.rpc("confirm_trained_together");
  await yoav.tap('[data-community-action="c-tag-confirm"]');
  s.check(!!(await done), "confirm_trained_together was called");
  s.check(await yoav.waitHidden("[data-pending-tags]", 8000), "the card goes away");
  s.check(count(`select count(*) from public.post_training_partners where tagged_user_id = ${q(yoavId)} and confirmed_at is not null`) === 1, "the tag is confirmed in the database");
}, { primary: ['[data-community-action="c-tag-confirm"]'], contrast: ["[data-pending-tags] .log-row", '[data-community-action="c-tag-confirm"]'] });

// 12. Yoav posts a workout of his own ---------------------------------------------------------------------------------------------
await world.step(yoav, "yoav-posts", "Yoav shares a workout of his own", async (s) => {
  await openMe(s, yoav);
  await shareSetting(s, yoav, CIRCLE, "share_workouts", true);
  const r = await logSet(s, yoav, LIFT2);
  s.note("After the save: " + JSON.stringify(r));
  const bar = await yoav.waitVisible("[data-share-bar]", 10000);
  s.check(bar, "he is told the workout went to the circle");
  s.check(!!(await until(() => one(`select title from public.workout_posts where author_id = ${q(yoavId)} and club_id = ${q(clubId)} and title = 'Deadlift'`), { timeout: 8000 })), "the post exists in the circle");
}, { primary: ["#bottomBarBtn"] });

await world.step(dana, "dana-sees-yoav", "Dana sees Yoav's post", async (s) => {
  const r = await seeInFeed(s, dana, /Deadlift/);
  s.check(r.found, "Yoav's Deadlift is in Dana's feed", r.cards.map((c) => c.text.slice(0, 50)).join(" | "));
  const card = r.cards.find((c) => /Deadlift/.test(c.text));
  s.check(!!card && /יואב/.test(card.text), "and it names him", card ? card.text : "");
});

// 13. Yoav leaves ---------------------------------------------------------------------------------------------------------------------
await world.step(yoav, "yoav-leaves", "Yoav leaves the circle", async (s) => {
  await goCircle(yoav);
  await yoav.waitVisible('[data-community-action="c-leave-ask"]', 12000);
  await leaveCircle(s, yoav);
  const confirmText = s.rec.leaveConfirmText || "";
  s.check(/הפוסטים שלכם בו יימחקו/.test(confirmText), "the confirmation says his posts will be deleted", confirmText.slice(0, 200));
  s.check(/היומן הפרטי נשאר במכשיר/.test(confirmText), "and that his private log stays on the phone");
  s.check(await yoav.waitText(/עוד אין לך מעגל|הדביקו את קישור ההזמנה/, 15000), "he lands on a screen for people with no circle (an invite-link form)");
  s.check(count(`select count(*) from public.circle_members where user_id = ${q(yoavId)}`) === 0, "his membership is gone");
  s.check(count(`select count(*) from public.workout_posts where author_id = ${q(yoavId)} and club_id = ${q(clubId)} and deleted_at is null`) === 0, "his posts in the circle are gone");
  s.check(count(`select count(*) from public.reactions where user_id = ${q(yoavId)}`) === 0, "and so are his reactions");
  s.check(count(`select count(*) from public.post_training_partners where tagged_user_id = ${q(yoavId)}`) === 0, "and his tag");
}, { primary: ['[data-community-action="c-leave-ask"]'], contrast: ['[data-cloud-dialog="confirmSheet"] h2'] });

await world.step(dana, "dana-sees-gone", "Dana no longer sees his posts", async (s) => {
  await dana.reload();
  const r = await seeInFeed(s, dana, /Deadlift/, { absent: true });
  s.check(!r.found, "Yoav's Deadlift is gone from her feed", r.cards.map((c) => c.text.slice(0, 50)).join(" | "));
  s.check(r.cards.some((c) => /Back Squat/.test(c.text)), "her own post is still there");
  await section(s, dana, "members");
  await dana.waitVisible("[data-member]", 8000);
  s.check((await dana.count("[data-member]")) === 1, "the member list shows only Dana");
  const labels = await dana.page.$$eval(`${workoutCard("Back Squat")} [data-community-action="react"]`, (els) => els.map((e) => e.getAttribute("aria-label")));
  s.check(labels.every((l) => !/, \d/.test(l)), "and his reactions on her post are gone", labels.join(" | "));
});

// 14. Dana invites him again; he rejoins ---------------------------------------------------------------------------------------------------
let invite2 = null;
await world.step(dana, "dana-reinvites", "Dana invites Yoav again", async (s) => {
  await section(s, dana, "feed");
  const made = await makeInvite(s, dana);
  s.check(!!made.token, "a new link is made", made.error || "");
  invite2 = made.token;
  s.check(invite2 && invite2 !== invite1, "and it is a different link");
});

await world.step(yoav, "yoav-rejoins", "Yoav rejoins with the new link", async (s) => {
  await joinByPaste(s, yoav, invite2);
  const inside = await yoav.waitVisible('[data-community-action="c-leave-ask"]', 20000);
  s.check(inside, "he is back inside the circle");
  s.check(count(`select count(*) from public.circle_members where user_id = ${q(yoavId)} and club_id = ${q(clubId)}`) === 1, "membership is back in the database");
  const r = await seeInFeed(s, yoav, /Back Squat/);
  s.check(r.found, "Dana's post is visible to him again");
  s.check(!r.cards.some((c) => /Deadlift/.test(c.text)), "and his old post did not come back", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
  s.check(count(`select count(*) from public.workout_posts where author_id = ${q(yoavId)} and club_id = ${q(clubId)} and deleted_at is null and title is not null`) === 0, "he has no posts there");
}, { primary: ['[data-community-action="c-leave-ask"]'] });

process.exit(await world.finish());
