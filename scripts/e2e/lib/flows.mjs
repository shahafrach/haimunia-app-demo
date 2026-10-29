// The things a person does in BOX-LOG, written once and used by all three tests.
// Every function takes the step context `s` (soft checks, notes, flags) and the
// Person it acts for. Everything goes through Person.tap / Person.type so the
// tap counts in the report are real.
import { count, one, q, userId, bootstrapToken } from "./db.mjs";

export const PASSWORD = "Abcdefgh12x";
export const uname = (base) => `${base}_${Math.random().toString(36).slice(2, 6)}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy. Returns the truthy value, or null at the timeout. */
export async function until(fn, { timeout = 15000, every = 400 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(every);
  }
}

export const tokenOf = (link) => (/#invite=([a-f0-9]{64})/.exec(link || "") || [])[1] || "";

// ---- first run and incidental sheets ------------------------------------------------

/** The app's own first-run sheet (a name for the private log). Returns true if it opened. */
export async function passWelcome(s, p, name) {
  const open = await p.page.waitForFunction(() => !!document.getElementById("welcomeOverlay")?.classList.contains("open"), null, { timeout: 4000 }).then(() => true, () => false);
  if (!open) return false;
  s.note("The first-run sheet asked for a name before the invite screen could be used.");
  await p.type("#welcomeNameInput", name);
  await p.tap("[data-action='save-user-name']");
  await p.page.waitForFunction(() => !document.getElementById("welcomeOverlay")?.classList.contains("open"), null, { timeout: 10000 });
  if (await p.page.evaluate(() => !!document.getElementById("onboardingOverlay")?.classList.contains("open"))) {
    await p.tap("[data-action='close-onboarding']");
  }
  return true;
}

/**
 * Add to Home Screen steps, the first-log card, a medal prompt: close what is in
 * the way, and say so in the step's notes (each one is something a person has to
 * get past). On an iPhone the install steps open a moment after the first circle,
 * so the first call waits for them once.
 */
export async function clearIncidentals(s, p) {
  const seen = [];
  if (!p.recover) {
    // A tap that finds something on top of its target asks for this: close what a person
    // would close (the share bar's X, a medal prompt, the install steps) and try again.
    p.recover = async (by) => {
      if (/share-bar/.test(by) && (await p.page.locator('[data-community-action="c-share-bar-close"]').first().isVisible().catch(() => false))) {
        await p.page.locator('[data-community-action="c-share-bar-close"]').first().click().catch(() => {});
        p.cnt.taps++;
        (p.s || quiet).note("Closed the share bar, which was covering the control.");
        return;
      }
      await clearIncidentals(p.s || quiet, p);
    };
  }
  if (p.ua === "ios" && !p.installWaited) {
    p.installWaited = true;
    await p.waitVisible("[data-install-steps]", 2500);
  }
  for (let i = 0; i < 4; i++) {
    if (await p.has('[data-install-steps] [data-community-action="sh-close"]')) {
      seen.push("install-steps");
      await p.tap('[data-install-steps] [data-community-action="sh-close"]');
      await p.waitHidden("[data-install-steps]", 4000);
      continue;
    }
    if (await p.has('[data-cloud-dialog="achUnlock"] [data-community-action="ach-not-now"]')) {
      seen.push("medal-prompt");
      await p.tap('[data-cloud-dialog="achUnlock"] [data-community-action="ach-not-now"]');
      await sleep(300);
      continue;
    }
    if (await p.page.evaluate(() => !!document.getElementById("celebrationOverlay")?.classList.contains("open"))) {
      seen.push("celebration");
      await p.tap("#celebrationOverlay button[data-action='close-celebration']");
      await sleep(300);
      continue;
    }
    break;
  }
  if (seen.length) s.note("Closed on the way: " + seen.join(", "));
  return seen;
}

// ---- navigation ---------------------------------------------------------------------
const quiet = { note() {}, flag() {}, check() {} };
const nav = (id) => async (p) => { await clearIncidentals(p.s || quiet, p); await p.tap(id); };
export const goHome = nav("#tabHomeBtn");
export const goCircle = nav("#tabCommunityBtn");
export const goLog = nav("#tabAddBtn");
export const goProgress = nav("#tabHistoryBtn");

export async function openMe(s, p) {
  await clearIncidentals(s, p);
  await goHome(p);
  await p.tap('[data-community-action="c-open-me"]');
  const ok = await p.waitVisible("#communityProfile", 8000);
  s.check(ok, "Me opens from the avatar on Home");
  return ok;
}

export async function section(s, p, name) {
  await p.tap(`[data-community-action="c-section"][data-section="${name}"]`);
}

// ---- sign up ----------------------------------------------------------------------------
export async function openInvite(s, p, token, { welcomeName = "בדיקה" } = {}) {
  await p.goto(p.world.baseUrl + "#invite=" + token);
  await passWelcome(s, p, welcomeName);
}

/**
 * After an invite link and the first-run sheet, a person should be looking at the
 * invite. If the app left them on another tab (the Log tab, in practice), that is a
 * finding, and they tap the Circle tab to find the invite again, as a person would.
 */
export async function landOnInvite(s, p, selector) {
  if (await p.waitVisible(selector, 4000)) return true;
  const where = (await p.text()).slice(0, 90);
  s.flag("invite-dropped", `After the invite link and the first-run name sheet the app showed another screen, not the invite: "${where}". The person has to find the Circle tab themselves.`);
  await p.tap("#tabCommunityBtn");
  return p.waitVisible(selector, 10000);
}

export async function fillCredentials(s, p, { username, password = PASSWORD }) {
  await landOnInvite(s, p, '[data-community-action="start-signup"]');
  await p.tap('[data-community-action="start-signup"]');
  const ok = await p.waitVisible("#communityCredentials", 25000);
  s.check(ok, "the account form opens after the join button");
  if (!ok) throw new Error("account form never opened; screen says: " + (await p.text()).slice(0, 200));
  await p.type('#communityCredentials input[name="username"]', username);
  await p.type('#communityCredentials input[name="password"]', password);
  await p.type('#communityCredentials input[name="passwordConfirm"]', password);
  await p.tap('#communityCredentials button[type="submit"]');
  const profile = await p.waitVisible("#communityProfile", 25000);
  s.check(profile, "the name-and-emoji form follows the account form", profile ? "" : (await p.text()).slice(0, 200));
  return profile;
}

export async function fillProfile(s, p, { displayName, emoji }) {
  await p.type('#communityProfile input[name="displayName"]', displayName);
  await p.tap(`#communityProfile [data-community-action="c-emoji-pick"][data-emoji="${emoji}"]`);
  await p.tap('#communityProfile button[type="submit"]');
}

// ---- circles ------------------------------------------------------------------------------
export async function createCircle(s, p, { type = "friends", name, emoji = "🔥" }) {
  // After a founder or bootstrap link the app opens this sheet by itself, once.
  if (await p.waitVisible("#circleCreate", 1500)) s.note("The create-circle sheet had already opened by itself.");
  else await p.tap('[data-community-action="c-create-open"]');
  const open = await p.waitVisible("#circleCreate", 8000);
  s.check(open, "the create-circle sheet opens");
  if (type === "couple") await p.tap('#circleCreate label:has(input[value="couple"])');
  await p.type('#circleCreate input[name="name"]', name);
  await p.tap(`#circleCreate [data-community-action="c-emoji-pick"][data-emoji="${emoji}"]`);
  await p.tap('#circleCreate button[type="submit"]');
  const closed = await p.waitHidden("#circleCreate", 15000);
  s.check(closed, "the sheet closes once the circle exists");
  await p.waitVisible('[data-community-action="c-leave-ask"]', 15000);
}

/** Opens the invite sheet, creates a link, reads it, closes the sheet. Returns { token } or { error }. */
export async function makeInvite(s, p, { maxUses } = {}) {
  await p.tap('[data-community-action="c-invite-open"]');
  await p.waitVisible("#circleInvite", 8000);
  if (maxUses) await p.type('#circleInvite input[name="max_uses"]', maxUses);
  await p.tap('#circleInvite button[type="submit"]');
  const link = await until(async () => {
    if (await p.has("#circleInviteLink")) return p.page.inputValue("#circleInviteLink");
    return null;
  }, { timeout: 15000 });
  if (!link) {
    const error = await p.page.locator('[data-cloud-dialog="circleSheet"] .field-error').first().innerText().catch(() => "");
    await p.tap('[data-community-action="c-sheet-close"]').catch(() => {});
    return { error: error.trim() };
  }
  await p.tap('[data-community-action="c-sheet-close"]');
  return { token: tokenOf(link), link };
}

/** A signed-in member with no circle (or any member) pastes an invite into the join sheet. */
export async function joinByPaste(s, p, token) {
  // With no circle the form is already on the screen; otherwise it is a sheet behind a button.
  if (!(await p.waitVisible("#circleJoin", 1500))) await p.tap('[data-community-action="c-join-open"]');
  await p.waitVisible("#circleJoin", 8000);
  await p.type('#circleJoin input[name="link"]', p.world.baseUrl + "#invite=" + token);
  await p.tap('#circleJoin button[type="submit"]');
}

export async function leaveCircle(s, p) {
  await p.tap('[data-community-action="c-leave-ask"]');
  const ask = await p.waitVisible('[data-cloud-dialog="confirmSheet"]', 6000);
  s.check(ask, "leaving asks for a confirmation first");
  s.rec.leaveConfirmText = ask ? await p.inner('[data-cloud-dialog="confirmSheet"]') : "";
  await p.tap('[data-community-action="confirm-yes"]');
}

// ---- Me ---------------------------------------------------------------------------------------
/** Tick or untick one share setting for one circle (by its name), in Me. */
export async function shareSetting(s, p, circleName, key, on) {
  const input = p.page.locator(`#circleShareSettings .chart-card:has-text("${circleName}") input[data-share-setting="${key}"]`).first();
  await input.waitFor({ state: "visible" });
  const now = await input.isChecked();
  if (now === on) return false;
  const done = p.rpc("set_share_defaults");
  await p.tap(input);
  await done;
  return true;
}

// ---- logging -----------------------------------------------------------------------------------
async function selectedLiftName(p) {
  return p.page.evaluate(() => (document.querySelector(".exercise-select span")?.textContent || "").trim());
}

/** Pick a lift the way a member would: the recent-lift chip if there is one, else the picker. */
export async function pickLift(s, p, { id, name }) {
  if ((await selectedLiftName(p)).includes(name)) return "already";
  const chip = p.page.locator(`[data-action="pick-recent-lift"][data-id="${id}"]`).first();
  if (await chip.isVisible().catch(() => false)) { await p.tap(chip); return "chip"; }
  await p.tap("[data-action='open-picker']");
  await p.type("#pickerSearch", name);
  await p.tap(`.modal-list .movement-btn[data-id="${id}"]`);
  await p.page.waitForFunction(() => !document.getElementById("pickerOverlay").classList.contains("open"), null, { timeout: 8000 });
  return "picker";
}

async function setField(p, field, value) {
  await p.type(`input.stepper-val[data-field='${field}']`, value);
}

/**
 * Log one set. Returns what the save led to: the checks happen in the caller.
 * { how, sanity, arrival, moment, prompt, flash }
 */
export async function logSet(s, p, { id, name, weight, reps, date }) {
  await clearIncidentals(s, p);
  await goLog(p);
  await p.waitVisible("[data-action='open-picker']", 8000);
  const how = await pickLift(s, p, { id, name });
  if (date) await p.type("#logDateInput", date);
  await setField(p, "weight", weight);
  await setField(p, "reps", reps);
  await p.tap("#bottomBarBtn");
  const out = await afterSave(s, p);
  return { how, ...out };
}

/** After the save button: answer the sanity dialog, note the first-log card, wait for the moment or the quiet check. */
export async function afterSave(s, p, { timeout = 6000 } = {}) {
  const out = { sanity: false, arrival: "", moment: false, prompt: false, flash: false };
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await p.page.evaluate(() => ({
      confirm: !!document.getElementById("appConfirmOverlay"),
      celebration: !!document.getElementById("celebrationOverlay")?.classList.contains("open"),
      celebrationText: (document.getElementById("celebrationOverlay")?.innerText || "").replace(/\s+/g, " ").trim(),
      moment: !!document.getElementById("momentOverlay")?.classList.contains("open"),
      prompt: !!document.querySelector('[data-cloud-dialog="prPrompt"]'),
      saved: !!document.getElementById("bottomBarBtn")?.classList.contains("is-saved"),
    }));
    if (st.confirm) {
      out.sanity = true;
      await p.tap("#appConfirmOverlay [data-action='app-confirm-yes']");
      continue;
    }
    if (st.celebration) {
      out.arrival = st.celebrationText;
      await p.tap("#celebrationOverlay button[data-action='close-celebration']");
      await p.page.waitForFunction(() => !document.getElementById("celebrationOverlay")?.classList.contains("open"), null, { timeout: 5000 }).catch(() => {});
      return out;
    }
    if (st.moment) { out.moment = true; out.prompt = st.prompt; return out; }
    if (st.prompt) { out.prompt = true; return out; }
    if (st.saved) {
      // The quiet check can show a beat before the post-workout moment opens: give the moment a moment.
      await sleep(900);
      out.moment = await p.page.evaluate(() => !!document.getElementById("momentOverlay")?.classList.contains("open"));
      out.prompt = await p.has('[data-cloud-dialog="prPrompt"]');
      out.flash = !out.moment;
      return out;
    }
    await sleep(150);
  }
  return out;
}

/** The backup question under the first entry. Answering yes is what lets a PR carry its percent. */
export async function acceptBackup(s, p) {
  const card = '[data-action="backup-consent-yes"]';
  if (!(await p.waitVisible(card, 3000))) return false;
  await p.tap(card);
  return true;
}

/** Wait until the server holds n of this person's strength entries. */
export async function waitSynced(username, n, timeout = 25000) {
  const id = userId(username);
  return until(() => count(`select count(*) from public.private_records where user_id = ${q(id)} and record_type = 'strength_entry' and deleted_at is null`) >= n, { timeout });
}

// ---- reading a circle -----------------------------------------------------------------------------
export async function feedCards(p) {
  return p.page.$$eval("article.post-card", (els) => els.map((e) => ({ id: e.dataset.postId || "", type: e.dataset.postType || "", text: (e.innerText || "").replace(/\s+/g, " ").trim() })));
}

/**
 * Open the Circle tab and wait for a card matching `pattern`. A member has no
 * refresh button, so if the card is missing the person tries the tabs, then a
 * reload. Returns { found, how, cards }.
 */
export async function seeInFeed(s, p, pattern, { timeout = 8000, absent = false } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let cards = [];
  const has = () => cards.some((c) => re.test(c.text));
  const look = async (wait) => {
    await goCircle(p);
    await p.waitVisible("#circlePanel", 12000);
    await p.tap('[data-community-action="c-section"][data-section="feed"]').catch(() => {});
    if (absent) { await sleep(2500); cards = await feedCards(p); return cards; }
    await until(async () => { cards = await feedCards(p); return has(); }, { timeout: wait, every: 500 });
    return cards;
  };
  await look(4000);
  if (absent) return { found: has(), how: "tab", cards };
  if (has()) return { found: true, how: "tab", cards };
  // Not there: leave and come back, then reload, as a person would.
  await goHome(p);
  await look(3000);
  if (has()) return { found: true, how: "retab", cards };
  await p.reload();
  await look(timeout);
  const reloaded = has();
  if (reloaded) s.flag("no-refresh", "A new post only showed after a full page reload; the Circle screen has no refresh control and does not refetch on tab change.");
  return { found: reloaded, how: reloaded ? "reload" : "none", cards };
}

export async function weekCards(p) {
  return p.page.$$eval("[data-week-member]", (els) => els.map((e) => ({ id: e.dataset.weekMember, me: e.hasAttribute("data-week-me"), text: (e.innerText || "").replace(/\s+/g, " ").trim() })));
}

export { count, one, q, userId, bootstrapToken };
