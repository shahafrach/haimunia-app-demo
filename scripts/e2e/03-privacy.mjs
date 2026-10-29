#!/usr/bin/env node
// Test 3 - privacy and limits (Noa and Avi).
//
// A Couple circle holds two people and refuses a third. Noa is in a second circle
// too, and nothing from one shows in the other. A PR shared without "show weights"
// carries the percent and no absolute weight on the wire. Body weight never leaves
// the phone. A set logged offline is queued and sent on reconnect. Avi deletes his
// account and leaves the circle.
import { startWorld } from "./lib/harness.mjs";
import { sql } from "./lib/db.mjs";
import {
  uname, until, bootstrapToken, passWelcome, landOnInvite, clearIncidentals, goHome, goCircle, goProgress, openMe, section,
  fillCredentials, fillProfile, createCircle, makeInvite, shareSetting, logSet, acceptBackup, waitSynced,
  seeInFeed, feedCards, weekCards, one, q, userId, count, sleep,
} from "./lib/flows.mjs";

const world = await startWorld("03-privacy", "Test 3: privacy and limits (Noa and Avi)");
const noa = await world.person("noa", { ua: "ios" });
const avi = await world.person("avi", { ua: "android" });
const cleo = await world.person("cleo", { ua: "android" });
const N = uname("noa");
const A = uname("avi");
const COUPLE = "הבית של נועה ואבי";
const FRIENDS = "החבר'ה של נועה";
const SQUAT = { id: "back-squat", name: "Back Squat" };
const DEAD = { id: "deadlift", name: "Deadlift" };
let noaId = null, aviId = null, coupleId = null, friendsId = null, invite1 = null, invite2 = null;

// 1. A Couple circle ------------------------------------------------------------------------------
await world.step(noa, "noa-couple", "Noa creates a Couple circle", async (s) => {
  await noa.goto(world.baseUrl + "#invite=" + bootstrapToken());
  await passWelcome(s, noa, "נועה");
  await fillCredentials(s, noa, { username: N });
  await fillProfile(s, noa, { displayName: "נועה", emoji: "🌟" });
  await noa.waitText("עוד אין לך מעגל", 20000);
  await createCircle(s, noa, { type: "couple", name: COUPLE, emoji: "🌟" });
  await clearIncidentals(s, noa);
  noaId = userId(N);
  coupleId = one(`select id from public.clubs where name = ${q(COUPLE)}`);
  const text = await noa.text();
  s.check(text.includes("מעגל זוגי"), "the circle is labelled as a couple's", text.slice(0, 120));
  s.check(one(`select type from public.clubs where id = ${q(coupleId)}`) === "couple", "and stored as one");
  s.check(one(`select share_defaults->>'share_workouts' from public.circle_members where user_id = ${q(noaId)}`) !== "false", "a couple shares workouts by default");
  s.check(/עוד אין כלום כאן/.test(text), "the empty feed explains itself");
}, { primary: ['[data-community-action="c-invite-open"]'] });

// 2. Two invites ---------------------------------------------------------------------------------------
await world.step(noa, "noa-invites", "Noa makes one invite for Avi and keeps a spare", async (s) => {
  const first = await makeInvite(s, noa);
  s.check(!!first.token, "the first invite is made", first.error || "");
  const second = await makeInvite(s, noa);
  s.check(!!second.token, "and a second one while the circle is not yet full", second.error || "");
  invite1 = first.token; invite2 = second.token;
  s.check(count(`select count(*) from public.circle_invites where club_id = ${q(coupleId)} and max_uses = 1`) === 2, "each is good for one person (couple)");
});

// 3. Avi joins --------------------------------------------------------------------------------------------
await world.step(avi, "avi-joins", "Avi joins with the first invite", async (s) => {
  await avi.goto(world.baseUrl + "#invite=" + invite1);
  await passWelcome(s, avi, "אבי");
  await fillCredentials(s, avi, { username: A });
  await fillProfile(s, avi, { displayName: "אבי", emoji: "🌿" });
  s.check(await avi.waitVisible('[data-community-action="c-leave-ask"]', 25000), "Avi lands in the couple's circle");
  await clearIncidentals(s, avi);
  aviId = userId(A);
  s.check(count(`select count(*) from public.circle_members where club_id = ${q(coupleId)}`) === 2, "the circle now has two members");
  s.check(one(`select role from public.circle_members where user_id = ${q(aviId)}`) === "owner", "both are owners");
  s.check(await avi.has('[data-community-action="c-settings-open"]'), "so Avi sees the owner's settings too");
}, { primary: ['[data-community-action="c-leave-ask"]'] });

// 4. A third person is refused ------------------------------------------------------------------------------
await world.step(cleo, "cleo-refused", "A third person opens the spare invite and is refused", async (s) => {
  const before = count(`select count(*) from public.circle_members where club_id = ${q(coupleId)}`);
  await cleo.goto(world.baseUrl + "#invite=" + invite2);
  await passWelcome(s, cleo, "קליאו");
  await landOnInvite(s, cleo, '[data-community-action="start-signup"]');
  await cleo.tap('[data-community-action="start-signup"]');
  const refused = await cleo.waitText("המעגל הזה מלא", 25000);
  s.check(refused, "she is told the circle is full");
  s.check(count(`select count(*) from public.circle_members where club_id = ${q(coupleId)}`) === before, "and was not added");
  s.check(!(await cleo.has("#communityCredentials")) , "she is not walked on to an account form for a circle she cannot enter");
  s.note("Screen: " + (await cleo.text()).slice(0, 300));
}, { primary: ["[data-join-error]"], contrast: ["[data-join-error]"] });

await world.step(noa, "noa-third-invite", "Noa tries to make a third invite", async (s) => {
  await goCircle(noa);
  await noa.waitVisible("#circlePanel", 12000);
  const made = await makeInvite(s, noa);
  s.check(!made.token, "no third invite is made");
  s.check(/המעגל מלא/.test(made.error || ""), "she is told why", made.error || "");
});

// 5. A second circle for Noa ---------------------------------------------------------------------------------
await world.step(noa, "noa-second-circle", "Noa creates a second circle", async (s) => {
  await createCircle(s, noa, { type: "friends", name: FRIENDS, emoji: "🔥" });
  friendsId = one(`select id from public.clubs where name = ${q(FRIENDS)}`);
  const chips = await noa.page.$$eval('[data-community-action="c-pick"]', (els) => els.map((e) => e.textContent.trim()));
  s.check(chips.length === 2, "the circle switcher lists both", chips.join(" | "));
  s.check(count(`select count(*) from public.circle_members where user_id = ${q(noaId)}`) === 2, "she is in two circles");
  const members = one(`select count(*) from public.circle_members where club_id = ${q(friendsId)}`);
  s.check(members === "1", "and Avi is not in the second one", members);
}, { primary: ['.subtabbar [data-community-action="c-pick"]'] });

// 6. What each circle takes --------------------------------------------------------------------------------------
await world.step(noa, "noa-settings", "Noa sets what each circle gets", async (s) => {
  await openMe(s, noa);
  s.check((await noa.count("#circleShareSettings .chart-card")) === 2, "Me lists the settings of both circles");
  // The couple would otherwise show whole workouts: lift names would ride on the day summary.
  await shareSetting(s, noa, COUPLE, "share_workouts", false);
  s.check(one(`select share_defaults->>'show_weights' from public.circle_members where user_id = ${q(noaId)} and club_id = ${q(coupleId)}`) !== "true", "weights are hidden in the couple");
  s.check(one(`select share_defaults->>'show_weights' from public.circle_members where user_id = ${q(noaId)} and club_id = ${q(friendsId)}`) !== "true", "and in the friends circle");
  s.note("Settings text: " + (await noa.inner("#circleShareSettings")).slice(0, 300));
}, { primary: ['#circleShareSettings input[data-share-setting="show_weights"]'], contrast: ["#circleShareSettings .log-row span"] });

// 7-10. Two lifts, each with a PR shared to ONE circle ----------------------------------------------------------------
async function fourSets(s, lift, base, pr, id) {
  let prSeen = null;
  for (let i = 0; i < 3; i++) {
    const r = await logSet(s, noa, { ...lift, weight: base, reps: 5 });
    if (i === 0 && lift === SQUAT) {
      const backup = await acceptBackup(s, noa);
      s.check(backup, "the backup question appears after the first entry");
    }
    s.check(!r.moment, `set ${i + 1} of ${lift.name} is not a PR`);
  }
  prSeen = await logSet(s, noa, { ...lift, weight: pr, reps: 5 });
  s.check(prSeen.moment, `a heavier ${lift.name} set opens the post-workout moment`);
  return prSeen;
}

async function sharePr(s, lift, onlyTo, expectedEntries, username) {
  const t0 = Date.now();
  const synced = await waitSynced(username, expectedEntries, 30000);
  s.check(!!synced, "the server holds the history the percent is computed from");
  s.note(`sync: the ${expectedEntries} entries reached the server ${Date.now() - t0} ms after the PR save`);
  const momentOpen = await noa.page.evaluate(() => !!document.getElementById("momentOverlay")?.classList.contains("open"));
  const topIsPrompt = await noa.page.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); const o = e && e.closest(".modal-overlay"); return !!(o && o.getAttribute("data-cloud-dialog") === "prPrompt"); });
  if (momentOpen && !topIsPrompt) await noa.tap('#momentOverlay [data-action="close-moment"]');
  const prompt = await noa.waitVisible('[data-cloud-dialog="prPrompt"]', 8000);
  s.check(prompt, "the share prompt is shown");
  if (!prompt) return null;
  const promptText = await noa.inner('[data-cloud-dialog="prPrompt"]');
  s.check(/בלי משקל מוחלט/.test(promptText), "it tells her no absolute weight will be shown", promptText.slice(0, 260));
  s.note("Prompt: " + promptText.slice(0, 300));
  const other = onlyTo === coupleId ? FRIENDS : COUPLE;
  const box = noa.page.locator(`[data-cloud-dialog="prPrompt"] input[aria-label="${other}"]`).first();
  await box.waitFor({ state: "visible", timeout: 6000 });
  if (await box.isChecked()) await noa.tap(box);
  const before = noa.sent("pr_share").length;
  const done = noa.rpc("pr_share");
  await noa.tap('[data-community-action="pr-share"]');
  const resp = await done;
  s.check(!!resp && resp.ok(), "pr_share succeeded", resp ? String(resp.status()) : "no call");
  const calls = noa.sent("pr_share").slice(before);
  s.check(calls.length === 1 && calls[0].p_club_id === onlyTo, "exactly one circle was sent to", JSON.stringify(calls));
  s.check(calls.every((c) => !("p_weight" in c)), "NO absolute weight is in the request", JSON.stringify(calls));
  const raw = noa.reqs.filter((r) => r.path.includes("/rpc/pr_share")).map((r) => r.post).join(" ");
  s.check(!/"p_weight"/.test(raw) && !/\b(66|75)(\.0)?\b/.test(raw.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "")), "and neither of the lift's numbers appears in the payload text", raw.slice(0, 240));
  const row = sql(`select result_text, metadata::text from public.workout_posts where author_id = ${q(noaId)} and club_id = ${q(onlyTo)} and post_type = 'POST_PR'`)[0] || [];
  s.check(/^\+\d+(\.\d+)?%$/.test(row[0] || ""), "the stored post carries only the percent", row[0] || "none");
  s.check(!/ק["״]?ג|kg/i.test((row[0] || "") + (row[1] || "")), "and no kilograms anywhere in the post", row[1] || "");
  await noa.waitText("השיא שותף למעגלים", 8000);
  if (await noa.page.evaluate(() => !!document.getElementById("momentOverlay")?.classList.contains("open"))) await noa.tap('#momentOverlay [data-action="close-moment"]');
  await clearIncidentals(s, noa);
  return row;
}

await world.step(noa, "noa-squat-sets", "Noa logs four Back Squat sets, the last a PR", async (s) => {
  await fourSets(s, SQUAT, 60, 66);
}, { primary: ["#bottomBarBtn"], contrast: [".moment-headline", ".moment-pr-delta"] });

await world.step(noa, "noa-squat-pr", "She shares that PR with the couple only", async (s) => {
  await sharePr(s, SQUAT, coupleId, 4, N);
}, { contrast: ['[data-cloud-dialog="prPrompt"] h2'] });

await world.step(noa, "noa-deadlift-sets", "Noa logs four Deadlift sets, the last a PR", async (s) => {
  await fourSets(s, DEAD, 70, 75);
}, { primary: ["#bottomBarBtn"] });

let friendsRow = null;
await world.step(noa, "noa-deadlift-pr", "She shares that PR with the friends circle only", async (s) => {
  friendsRow = await sharePr(s, DEAD, friendsId, 8, N);
}, { contrast: ['[data-cloud-dialog="prPrompt"] h2'] });

// 11. What the circles show ------------------------------------------------------------------------------------------------
await world.step(noa, "noa-friends-feed", "Noa looks at the friends circle's feed", async (s) => {
  await goCircle(noa);
  await noa.waitVisible("#circlePanel", 12000);
  await noa.tap(`[data-community-action="c-pick"]:has-text("${FRIENDS}")`);
  await sleep(600);
  const r = await seeInFeed(s, noa, /Deadlift/);
  const card = r.cards.find((c) => /Deadlift/.test(c.text));
  s.check(r.found, "the Deadlift PR is in the friends circle's feed", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
  s.check(!r.cards.some((c) => /Back Squat/.test(c.text)), "and the Back Squat PR is not", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
  s.check(!!card && !/ק["״]?ג|kg/i.test(card.text), "the card shows no kilograms", card ? card.text : "");
  s.check(!!card && /\d+(\.\d+)?%/.test(card.text), "the card shows the percent the PR improved by", card ? card.text : "no card");
  s.note("Friends PR card text: " + (card ? card.text : "none"));
  await section(s, noa, "members");
  await noa.waitVisible("[data-member]", 8000);
  s.check((await noa.count("[data-member]")) === 1, "the friends circle's member list is just Noa");
}, { primary: ["article.post-card"], contrast: ["article.post-card .post-title", "article.post-card .post-head-text", "article.post-card .mono"] });

await world.step(noa, "noa-couple-feed", "Noa looks at the couple's feed", async (s) => {
  await noa.tap(`[data-community-action="c-pick"]:has-text("${COUPLE}")`);
  await sleep(400);
  await section(s, noa, "feed");
  const r = await seeInFeed(s, noa, /Back Squat/);
  s.check(r.found, "the Back Squat PR is in the couple's feed", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
  s.check(!r.cards.some((c) => /Deadlift/.test(c.text)), "and the Deadlift PR is not", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
  await section(s, noa, "week");
  await noa.waitVisible("[data-week-member]", 12000);
  const week = await weekCards(noa);
  s.check(week.length === 2, "the couple's week lists Noa and Avi side by side", week.map((w) => w.text.slice(0, 30)).join(" | "));
  s.check(await noa.has('[data-week-layout="pair"]'), "in the pair layout");
  s.check(!week.some((w) => /Deadlift|Back Squat|ק["״]?ג/.test(w.text)), "with no lifts or weights on the week cards");
});

await world.step(avi, "avi-sees-couple-only", "Avi sees the couple's circle and nothing else", async (s) => {
  const r = await seeInFeed(s, avi, /Back Squat/);
  s.check(r.found, "Avi sees Noa's Back Squat PR", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
  s.check(!r.cards.some((c) => /Deadlift/.test(c.text)), "and not her Deadlift PR from the other circle");
  const card = r.cards.find((c) => /Back Squat/.test(c.text));
  s.check(!!card && !/ק["״]?ג|kg/i.test(card.text), "the PR card has no kilograms", card ? card.text : "");
  s.check((await avi.count('[data-community-action="c-pick"]')) === 1, "Avi has only one circle in the switcher");
  // The wire: every circle_feed answer Avi received.
  const feeds = avi.bodies.filter((b) => b.path.includes("/rpc/circle_feed"));
  s.check(feeds.length > 0, "Avi's feed came from circle_feed");
  s.check(feeds.every((b) => !/Deadlift/.test(b.body) && !/deadlift/.test(b.body)), "none of his feed answers mention the other circle's lift");
  const noaFeeds = noa.bodies.filter((b) => b.path.includes("/rpc/circle_feed"));
  const asked = new Set(noaFeeds.map((b) => (JSON.parse(b.req || "{}")).p_club_id));
  s.check(asked.has(coupleId) && asked.has(friendsId), "Noa's phone asked for each circle's feed separately", [...asked].join(","));
  for (const b of noaFeeds) {
    const club = (JSON.parse(b.req || "{}")).p_club_id;
    if (club === coupleId) s.check(!/deadlift/i.test(b.body), "the couple's feed answer holds no Deadlift");
    if (club === friendsId) s.check(!/back-squat|back squat/i.test(b.body), "the friends feed answer holds no Back Squat");
  }
}, { primary: ["article.post-card"] });

// 12. Body weight never leaves the phone ----------------------------------------------------------------------------------------
await world.step(noa, "noa-bodyweight", "Noa logs her body weight", async (s) => {
  await goProgress(noa);
  await noa.waitVisible("[data-action='toggle-bodyweight']", 10000);
  await noa.tap("[data-action='toggle-bodyweight']");
  await noa.type("input.stepper-val[data-field='bwWeight']", "82.5");
  await noa.tap("[data-action='save-bw']");
  s.check(await noa.waitText(/82\.5/, 6000), "the weight shows on her screen");
  const start = noa.reqs.length;
  await sleep(6000);
  await noa.reload();
  await goProgress(noa);
  await noa.waitVisible("[data-action='toggle-bodyweight']", 10000);
  s.check(/82\.5/.test(await noa.text()), "and is still there after a reload (kept on the device)");
  const all = noa.reqs.map((r) => (r.path + " " + (r.post || "")));
  s.check(!all.some((x) => /bodyweight/i.test(x)), "no request to the server mentions body weight");
  s.check(!all.some((x) => /82\.5/.test(x)), "and the number 82.5 never appears in any request");
  s.check(count(`select count(*) from public.private_records where user_id = ${q(noaId)} and record_type = 'bodyweight'`) === 0, "the server holds no body-weight record");
  s.check(count(`select count(*) from public.private_records where user_id = ${q(noaId)} and record_type = 'strength_entry'`) >= 8, "while her lifts were backed up (so the silence is meaningful)");
  s.note(`${noa.reqs.length} requests inspected over the session, ${noa.reqs.length - start} after the weight was saved.`);
}, { primary: ["[data-action='save-bw']"], contrast: ["[data-action='toggle-bodyweight'] span"] });

// 13. Offline -------------------------------------------------------------------------------------------------------------------
await world.step(avi, "avi-offline", "Avi logs a set with no connection", async (s) => {
  await goHome(avi);
  await avi.setOffline(true);
  const r = await logSet(s, avi, { id: "strict-press", name: "Strict Press", weight: 40, reps: 5 });
  s.note("After the save: " + JSON.stringify(r));
  const bar = await avi.waitVisible("[data-share-bar]", 10000);
  s.check(bar, "a bar appears after the save");
  const text = bar ? await avi.inner("[data-share-bar]") : "";
  s.check(/יישלח.*כשהחיבור יחזור/.test(text), "it says the workout will be sent when the connection returns", text);
  await sleep(1500);
  s.check(count(`select count(*) from public.workout_posts where author_id = ${q(aviId)} and club_id = ${q(coupleId)} and title is not null`) === 0, "nothing reached the server yet");
  const t0 = Date.now();
  await avi.setOffline(false);
  const landed = await until(() => count(`select count(*) from public.workout_posts where author_id = ${q(aviId)} and club_id = ${q(coupleId)} and title is not null`) >= 1, { timeout: 30000 });
  s.check(!!landed, "after reconnecting the post arrives");
  s.note(`the queued post reached the server ${Date.now() - t0} ms after the connection came back`);
}, { primary: ["[data-share-bar] button"], contrast: ["[data-share-bar]"] });

await world.step(noa, "noa-sees-offline-post", "Noa sees the post that was queued", async (s) => {
  const r = await seeInFeed(s, noa, /Strict Press/);
  s.check(r.found, "Avi's Strict Press shows in the couple's feed", r.cards.map((c) => c.text.slice(0, 40)).join(" | "));
});

// 14. Founder link -----------------------------------------------------------------------------------------------------------------------
let founderToken = null;
await world.step(noa, "founder-send", "Noa sends a friend a founder link", async (s) => {
  await openMe(s, noa);
  await noa.page.locator('[data-community-action="c-founder-open"]').scrollIntoViewIfNeeded();
  await noa.tap('[data-community-action="c-founder-open"]');
  s.check(await noa.waitVisible('[data-community-action="c-founder-create"]', 6000), "the sheet offers to create the link");
  s.check(/לא מצטרפים למעגלים שלך/.test(await noa.text()), "and says the friend does not join her circles");
  const done = noa.rpc("create_founder_invite");
  await noa.tap('[data-community-action="c-founder-create"]');
  s.check(!!(await done), "create_founder_invite was called");
  const link = await until(async () => ((await noa.has("#founderLink")) ? noa.page.inputValue("#founderLink") : null), { timeout: 10000 });
  s.check(!!link, "a link is shown");
  founderToken = (/#invite=([a-f0-9]{64})/.exec(link || "") || [])[1] || null;
  s.check(!!founderToken, "with a 64-hex token after the #", String(link).slice(0, 60));
  s.check(/7 ימים/.test(await noa.text()), "and says it lasts 7 days and works once");
  s.check(count(`select count(*) from public.invite_codes where active and max_uses = 1 and expires_at > now() + interval '6 days'`) >= 1, "one 7-day, one-use code is stored");
  await noa.tap('[data-community-action="c-sheet-close"]');
}, { primary: ['[data-community-action="c-founder-open"]'], contrast: ['[data-community-action="c-founder-open"]', "#founderLinkPanel .footer-note"] });

const dev = await world.person("dev", { ua: "android" });
const DV = uname("dev");
await world.step(dev, "founder-friend", "The friend signs up and creates their own circle", async (s) => {
  const noaClubs = count(`select count(*) from public.circle_members where user_id = ${q(noaId)}`);
  const members = (id) => count(`select count(*) from public.circle_members where club_id = ${q(id)}`);
  const before = { couple: members(coupleId), friends: members(friendsId) };
  await dev.goto(world.baseUrl + "#invite=" + founderToken);
  await passWelcome(s, dev, "דב");
  await fillCredentials(s, dev, { username: DV });
  await fillProfile(s, dev, { displayName: "דב", emoji: "🐺" });
  const sheet = await dev.waitVisible("#circleCreate", 20000);
  s.check(sheet, "the create-circle sheet opens by itself after the profile");
  if (!sheet) { await dev.waitText("עוד אין לך מעגל", 5000); await dev.tap('[data-community-action="c-create-open"]'); await dev.waitVisible("#circleCreate", 8000); }
  await dev.type('#circleCreate input[name="name"]', "המעגל של דב");
  await dev.tap('#circleCreate button[type="submit"]');
  s.check(await dev.waitHidden("#circleCreate", 15000), "the circle is created");
  await dev.waitVisible('[data-community-action="c-leave-ask"]', 15000);
  await clearIncidentals(s, dev);
  const devId = userId(DV);
  const mine = sql(`select c.name, m.role from public.circle_members m join public.clubs c on c.id = m.club_id where m.user_id = ${q(devId)}`);
  s.check(mine.length === 1 && mine[0][0] === "המעגל של דב" && mine[0][1] === "owner", "he is the owner of exactly one circle, his own", JSON.stringify(mine));
  s.check(members(coupleId) === before.couple && members(friendsId) === before.friends, "he joined none of Noa's circles");
  s.check(count(`select count(*) from public.circle_members where user_id = ${q(noaId)}`) === noaClubs, "and Noa gained no circle");
  const text = await dev.text();
  s.check(!/Back Squat|Deadlift|נועה/.test(text), "nothing of Noa's shows on his screen", text.slice(0, 160));
}, { primary: ['[data-community-action="c-invite-open"]'] });

// 15. Avi deletes his account ---------------------------------------------------------------------------------------------------------------
await world.step(avi, "avi-deletes", "Avi deletes his account", async (s) => {
  await openMe(s, avi);
  await avi.page.locator('[data-community-action="delete-account"]').scrollIntoViewIfNeeded();
  await avi.tap('[data-community-action="delete-account"]');
  const ask = await avi.waitVisible('[data-cloud-dialog="confirmSheet"]', 6000);
  s.check(ask, "deleting asks for a confirmation first");
  const text = ask ? await avi.inner('[data-cloud-dialog="confirmSheet"]') : "";
  s.check(/30 יום/.test(text), "the confirmation says when the deletion is final", text.slice(0, 220));
  const done = avi.rpc("request_account_deletion");
  await avi.tap('[data-community-action="confirm-yes"]');
  s.check(!!(await done), "request_account_deletion was called");
  s.check(await avi.waitText(/בקשת המחיקה התקבלה|התחברות|יש לי קישור הזמנה/, 15000), "he is told the request was received / signed out");
  s.check(count(`select count(*) from public.account_deletion_requests where user_id = ${q(aviId)}`) === 1, "the request is recorded");
  s.check(one(`select deleted_at is not null from public.profiles where id = ${q(aviId)}`) === "t", "his profile is marked deleted");
  s.note("After deletion: " + (await avi.text()).slice(0, 260));
}, { primary: ['[data-community-action="delete-account"]', '[data-community-action="confirm-yes"]'], contrast: ['[data-community-action="delete-account"]', '[data-cloud-dialog="confirmSheet"] h2'] });

await world.step(noa, "noa-sees-avi-gone", "Avi disappears from the circle", async (s) => {
  await noa.reload();
  await goCircle(noa);
  await noa.waitVisible("#circlePanel", 12000);
  const circle = await noa.page.$$eval('[data-community-action="c-pick"]', (els) => els.map((e) => e.textContent.trim()));
  if (!circle.some((c) => c.includes(COUPLE))) throw new Error("the couple's circle is missing from Noa's switcher");
  await noa.tap(`[data-community-action="c-pick"]:has-text("${COUPLE}")`);
  await section(s, noa, "members");
  await noa.waitVisible("[data-member]", 8000);
  const members = await noa.page.$$eval("[data-member]", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  s.check(!members.some((m) => /אבי/.test(m)), "Avi is not in the member list", members.join(" | "));
  await section(s, noa, "feed");
  await sleep(800);
  const cards = await feedCards(noa);
  s.check(!cards.some((c) => /Strict Press/.test(c.text)), "his post is gone from the feed", cards.map((c) => c.text.slice(0, 40)).join(" | "));
  await section(s, noa, "week");
  await noa.waitVisible("[data-week-member]", 12000);
  const week = await weekCards(noa);
  s.check(!week.some((w) => /אבי/.test(w.text)), "and from the week view", week.map((w) => w.text.slice(0, 30)).join(" | "));
  s.check(count(`select count(*) from public.circle_members where user_id = ${q(aviId)}`) === 0, "his membership row is gone from the database", String(count(`select count(*) from public.circle_members where user_id = ${q(aviId)}`)));
  s.check(count(`select count(*) from public.reactions where user_id = ${q(aviId)}`) === 0, "and his reactions");
  s.check(count(`select count(*) from public.workout_posts where author_id = ${q(aviId)} and deleted_at is null`) === 0, "and his posts");
  s.note("The circle's view after the deletion: " + (await noa.text()).slice(0, 260));
}, { primary: ["[data-week-member]"] });

process.exit(await world.finish());
