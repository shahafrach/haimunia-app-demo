// The e2e harness: one World per test script, one Person (browser context) per human
// in the story, and a step recorder that measures as it goes.
//
//   * Real Chromium at 390x844, RTL, locale he-IL, Asia/Jerusalem, a phone user agent.
//   * Real sign-ups against the local Supabase stack. No mocked backend.
//   * Every tap and every typed field goes through Person.tap / Person.type, so the
//     counts in the report are the script's own, not a guess.
//   * Every step ends with a screenshot in dark Classic and one in a light palette.
//   * Anything that would leave this machine (production, Cloudflare, a CAPTCHA
//     provider) is aborted and recorded; the run fails if any request tried.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { API_URL, ARTIFACTS_DIR, FAKE_HOST, FORBIDDEN_HOSTS, assertLocalOnly } from "./config.mjs";
import { startServer } from "./server.mjs";
import { contrastOf, layoutFacts } from "./measure.mjs";

export const VIEWPORT = { width: 390, height: 844 };
export const UA = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  whatsapp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/24.10.80",
};
const LIGHT_PALETTES = ["classic", "chalk", "slate", "cedar", "sand", "iris"];
const DEFAULT_TIMEOUT = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRe = (p) => (p instanceof RegExp ? p : new RegExp(escapeRe(String(p))));

function cors(origin, requested) {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-headers": requested || "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-expose-headers": "*",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export class Person {
  constructor(world, name, ctx, page, ua) {
    this.world = world; this.name = name; this.ctx = ctx; this.page = page; this.ua = ua;
    this.reqs = [];          // every request to the (routed) backend: method, path, body
    this.bodies = [];        // response bodies of the calls the privacy checks read
    this.errors = [];        // console errors and page errors
    this.failures = [];      // backend answers with status >= 400: method, path, status, body
    this.forbidden = [];     // requests that tried to leave the machine
    this.s = null;           // the step in progress (set by World.step)
    this.recover = null;     // set by flows: clears what covers a control
    this.downloads = [];     // files the page saved
    this.offline = false;
    this.cnt = this.freshCounts();
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
  }
  freshCounts() { return { taps: 0, typed: 0, scrolls: 0, small: [], below: [], waits: [], covered: [] }; }

  // ---- doing things, counted ------------------------------------------------
  loc(target) { return typeof target === "string" ? this.page.locator(target).first() : target; }
  async tap(target, opts = {}) {
    const loc = this.loc(target);
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    await loc.waitFor({ state: "visible", timeout });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    let facts = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      facts = await loc.evaluate((el) => {
        const own = el.closest("label") && el.matches("input") ? el.closest("label") : el;
        const r = own.getBoundingClientRect();
        const nav = document.getElementById("bottomNavWrap") || document.getElementById("bottomTabBar");
        const navTop = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : innerHeight;
        const fixedUi = !!el.closest("#bottomNavWrap, #bottomTabBar, #bottomBar, [data-share-bar], .modal-overlay");
        const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        const hit = document.elementFromPoint(cx, cy);
        const covered = !!hit && !el.contains(hit) && !hit.contains(el);
        const describe = (n) => { const o = n.closest("[data-cloud-dialog], .modal-overlay, [data-share-bar], #bottomNavWrap") || n; return (o.getAttribute("data-cloud-dialog") || o.id || o.getAttribute("data-share-bar") && "share-bar" || o.className || o.tagName) + ""; };
        return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, navTop, fixedUi, covered, by: covered ? describe(hit) : "", label: ((el.getAttribute("aria-label") || el.textContent || el.id || el.tagName) + "").trim().replace(/\s+/g, " ").slice(0, 40) };
      }).catch(() => null);
      if (!facts || !facts.covered) break;
      this.cnt.covered.push(`${facts.label} covered by ${facts.by}`);
      if (!this.recover || attempt === 2) break;
      await this.recover(facts.by);
    }
    if (facts) {
      if (facts.w > 0 && facts.h > 0 && Math.min(facts.w, facts.h) < 44) this.cnt.small.push(`${facts.label} ${Math.round(facts.w)}x${Math.round(facts.h)}`);
      if (!facts.fixedUi && (facts.bottom > facts.navTop || facts.top < 0)) { this.cnt.scrolls++; this.cnt.below.push(facts.label); }
    }
    await loc.click({ timeout });
    this.cnt.taps++;
  }
  async type(target, value) {
    const loc = this.loc(target);
    await loc.waitFor({ state: "visible" });
    await loc.fill(String(value));
    await loc.dispatchEvent("change");
    this.cnt.typed++;
  }
  async choose(target, value) {
    const loc = this.loc(target);
    await loc.waitFor({ state: "visible" });
    await loc.selectOption(String(value));
    this.cnt.taps++;
  }
  async goto(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.page.waitForSelector("#app", { state: "visible", timeout: 20000 });
  }
  async reload() {
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await this.page.waitForSelector("#app", { state: "visible", timeout: 20000 });
  }

  // ---- reading the screen ---------------------------------------------------
  async text() { return this.page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim()); }
  async has(selector) { return this.page.locator(selector).first().isVisible().catch(() => false); }
  async count(selector) { return this.page.locator(selector).count(); }
  async attr(selector, name) { return this.page.locator(selector).first().getAttribute(name); }
  async inner(selector) { return (await this.page.locator(selector).first().innerText()).replace(/\s+/g, " ").trim(); }
  /** Wait until the visible text matches. Resolves true, or false after the timeout. */
  async waitText(pattern, timeout = DEFAULT_TIMEOUT) {
    const re = toRe(pattern);
    const t0 = Date.now();
    try {
      await this.page.waitForFunction(([src, flags]) => new RegExp(src, flags).test(document.body.innerText || ""), [re.source, re.flags], { timeout });
      this.cnt.waits.push(Date.now() - t0);
      return true;
    } catch (e) { return false; }
  }
  async waitGone(pattern, timeout = DEFAULT_TIMEOUT) {
    const re = toRe(pattern);
    try {
      await this.page.waitForFunction(([src, flags]) => !new RegExp(src, flags).test(document.body.innerText || ""), [re.source, re.flags], { timeout });
      return true;
    } catch (e) { return false; }
  }
  async waitVisible(selector, timeout = DEFAULT_TIMEOUT) {
    try { await this.page.locator(selector).first().waitFor({ state: "visible", timeout }); return true; } catch (e) { return false; }
  }
  async waitHidden(selector, timeout = DEFAULT_TIMEOUT) {
    try { await this.page.locator(selector).first().waitFor({ state: "hidden", timeout }); return true; } catch (e) { return false; }
  }
  /** Wait for the app to call an RPC and answer. */
  rpc(name, timeout = DEFAULT_TIMEOUT) {
    return this.page.waitForResponse((r) => r.url().includes("/rest/v1/rpc/" + name), { timeout }).catch(() => null);
  }
  /** Request bodies sent to an RPC, parsed. */
  sent(name) {
    return this.reqs.filter((r) => r.path.includes("/rest/v1/rpc/" + name)).map((r) => { try { return JSON.parse(r.post || "{}"); } catch (e) { return { _raw: r.post }; } });
  }
  async openOverlays() {
    return this.page.evaluate(() => [...document.querySelectorAll(".modal-overlay.open, [data-cloud-dialog]")].map((e) => e.id || e.getAttribute("data-cloud-dialog") || e.className));
  }

  // ---- network control -------------------------------------------------------
  async setOffline(flag) {
    this.offline = !!flag;
    await this.ctx.setOffline(!!flag);
  }

  // ---- screenshots ------------------------------------------------------------
  async shotPair(file, n) {
    const dir = this.world.outDir;
    const out = [];
    const base = path.join(dir, file);
    const apply = (palette, theme) => this.page.evaluate(([p, t]) => { if (window.BoxLogTheme) window.BoxLogTheme.apply(document, { palette: p, theme: t, transparency: "off" }); }, [palette, theme]);
    try {
      await this.page.screenshot({ path: `${base}-dark-classic.png`, animations: "disabled", caret: "hide" });
      out.push(`${file}-dark-classic.png`);
      const palette = LIGHT_PALETTES[n % LIGHT_PALETTES.length];
      await apply(palette, "light");
      await sleep(200);
      await this.page.screenshot({ path: `${base}-light-${palette}.png`, animations: "disabled", caret: "hide" });
      out.push(`${file}-light-${palette}.png`);
    } catch (e) { /* a page that is gone has nothing to photograph */ }
    try { await apply("classic", "dark"); } catch (e) { /* ignore */ }
    return out;
  }
  /** Contrast of the listed text elements in dark Classic and in the light palette this step uses. */
  async contrast(selectors, n) {
    const rows = [];
    const palette = LIGHT_PALETTES[n % LIGHT_PALETTES.length];
    const apply = (p, t) => this.page.evaluate(([a, b]) => { if (window.BoxLogTheme) window.BoxLogTheme.apply(document, { palette: a, theme: b, transparency: "off" }); }, [p, t]);
    for (const sel of selectors) { const r = await contrastOf(this.page, sel).catch(() => ({ selector: sel, missing: true })); rows.push({ mode: "dark-classic", ...r }); }
    try {
      await apply(palette, "light");
      await sleep(200);
      for (const sel of selectors) { const r = await contrastOf(this.page, sel).catch(() => ({ selector: sel, missing: true })); rows.push({ mode: "light-" + palette, ...r }); }
    } catch (e) { /* ignore */ }
    try { await apply("classic", "dark"); } catch (e) { /* ignore */ }
    return rows;
  }
}

export class World {
  constructor({ testId, title, browser, server }) {
    this.testId = testId; this.title = title; this.browser = browser; this.server = server;
    this.outDir = path.join(ARTIFACTS_DIR, testId);
    fs.rmSync(this.outDir, { recursive: true, force: true });
    fs.mkdirSync(this.outDir, { recursive: true });
    this.people = []; this.results = []; this.t0 = Date.now();
  }
  get baseUrl() { return this.server.url; }

  async person(name, { ua = "android", permissions = [] } = {}) {
    const userAgent = UA[ua] || ua;
    const ctx = await this.browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      locale: "he-IL", timezoneId: "Asia/Jerusalem", userAgent,
      serviceWorkers: "block", permissions, acceptDownloads: true,
    });
    const page = await ctx.newPage();
    const p = new Person(this, name, ctx, page, ua);
    await this.wire(p);
    this.people.push(p);
    return p;
  }

  async wire(p) {
    const origin = this.server.origin;
    await p.ctx.route(/.*/, async (route) => {
      const req = route.request();
      let u;
      try { u = new URL(req.url()); } catch (e) { return route.abort(); }
      if (u.origin === origin) return route.continue();
      if (u.host === FAKE_HOST) {
        const requested = req.headers()["access-control-request-headers"];
        const pageOrigin = req.headers()["origin"] || origin;
        if (p.offline) return route.abort("internetdisconnected");
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(pageOrigin, requested) });
        try {
          const resp = await route.fetch({ url: API_URL.replace(/\/$/, "") + u.pathname + u.search, headers: { ...req.headers(), host: new URL(API_URL).host }, timeout: 40000 });
          const headers = {};
          for (const [k, v] of Object.entries(resp.headers())) if (!/^(content-encoding|content-length|transfer-encoding|access-control-)/i.test(k)) headers[k] = v;
          return route.fulfill({ status: resp.status(), headers: { ...headers, ...cors(pageOrigin, requested) }, body: await resp.body() });
        } catch (e) {
          return route.abort("connectionfailed");
        }
      }
      // Everything else is off this machine. It is stopped, and the run fails.
      if (FORBIDDEN_HOSTS.some((re) => re.test(u.hostname))) p.forbidden.push(req.method() + " " + u.origin + u.pathname);
      else p.forbidden.push("external " + req.method() + " " + u.origin + u.pathname);
      return route.abort("blockedbyclient");
    });
    p.ctx.on("request", (req) => {
      try {
        const u = new URL(req.url());
        if (u.host === FAKE_HOST) p.reqs.push({ t: Date.now(), method: req.method(), path: u.pathname + u.search, post: req.postData() || null });
      } catch (e) { /* ignore */ }
    });
    p.ctx.on("response", async (resp) => {
      try {
        const u = new URL(resp.url());
        if (u.host !== FAKE_HOST) return;
        if (resp.status() >= 400) {
          let body = "";
          try { body = (await resp.text()).slice(0, 240); } catch (e) { /* ignore */ }
          p.failures.push({ t: Date.now(), method: resp.request().method(), path: u.pathname + (u.search ? "?" + u.search.slice(1, 60) : ""), status: resp.status(), body });
        }
        if (/circle_feed|circle_week|pr_share|rest\/v1\/circle_members|workout_posts/.test(u.pathname)) {
          p.bodies.push({ t: Date.now(), path: u.pathname + u.search, status: resp.status(), req: resp.request().postData() || null, body: (await resp.text()).slice(0, 60000) });
          if (p.bodies.length > 200) p.bodies.shift();
        }
      } catch (e) { /* the page closed first */ }
    });
    p.page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (t.includes("frame-ancestors")) return;
      p.errors.push(t.slice(0, 300));
    });
    p.page.on("pageerror", (e) => p.errors.push("pageerror: " + String(e.message).slice(0, 300)));
    p.page.on("download", async (dl) => {
      try {
        const file = path.join(this.outDir, `${p.name}-${Date.now()}-${dl.suggestedFilename() || "download"}`);
        await dl.saveAs(file);
        p.downloads.push({ file, name: dl.suggestedFilename(), size: fs.statSync(file).size });
      } catch (e) { /* ignore */ }
    });
  }

  /**
   * Run one step. `fn` gets a context `s` with soft checks (a failed check marks
   * the step failed but lets it finish, so the screenshot shows the state) and
   * notes. opts: primary (selectors that should be above the fold),
   * contrast (text selectors to measure), shots:false to skip screenshots.
   */
  async step(person, id, title, fn, opts = {}) {
    const n = this.results.length + 1;
    const rec = { n, id, title, person: person.name, status: "PASS", checks: [], notes: [], flags: [], shots: [], error: null };
    const s = {
      p: person, world: this, rec,
      check: (ok, message, detail = "") => { rec.checks.push({ ok: !!ok, message, detail: String(detail).slice(0, 300) }); return !!ok; },
      note: (message) => rec.notes.push(String(message).slice(0, 400)),
      flag: (kind, message) => rec.flags.push({ kind, message: String(message).slice(0, 400) }),
    };
    person.cnt = person.freshCounts();
    person.s = s;
    const errorsBefore = person.errors.length;
    const failuresBefore = person.failures.length;
    const t0 = Date.now();
    try { await fn(s); } catch (e) {
      rec.status = "FAIL";
      const lines = String((e && e.message) || e).split("\n");
      const why = lines.find((l) => /intercepts pointer events|not visible|not enabled|waiting for locator/.test(l));
      rec.error = (lines[0] + (why ? " | " + why.trim() : "")).slice(0, 420);
    }
    rec.seconds = Math.round((Date.now() - t0)) / 1000;
    if (rec.checks.some((c) => !c.ok)) rec.status = "FAIL";
    rec.taps = person.cnt.taps; rec.typed = person.cnt.typed; rec.scrolls = person.cnt.scrolls;
    rec.smallTapTargets = person.cnt.small.slice(0, 6);
    rec.belowFoldTaps = person.cnt.below.slice(0, 6);
    rec.waitsMs = person.cnt.waits.slice(0, 6);
    rec.consoleErrors = person.errors.slice(errorsBefore).slice(0, 4);
    rec.httpFailures = person.failures.slice(failuresBefore).slice(0, 5).map((f) => `${f.status} ${f.method} ${f.path} ${f.body}`.slice(0, 260));
    for (const f of rec.httpFailures) s.flag("http", f);
    rec.covered = person.cnt.covered.slice(0, 4);
    for (const c of rec.covered) s.flag("covered", c);
    if (rec.consoleErrors.length) s.flag("console", rec.consoleErrors.length + " console error(s): " + rec.consoleErrors[0]);
    if (person.cnt.small.length) s.flag("small-target", "tapped under 44px: " + person.cnt.small.slice(0, 3).join("; "));
    if (person.cnt.below.length) s.flag("below-fold", "needed scrolling to tap: " + person.cnt.below.slice(0, 3).join("; "));
    try {
      const facts = await layoutFacts(person.page, opts.primary || []);
      rec.rtl = facts.dir === "rtl";
      rec.sideways = facts.sideways;
      rec.smallInView = facts.smallCount;
      rec.smallSample = facts.smallTargets.slice(0, 4);
      rec.primary = facts.primary;
      rec.text = facts.text.slice(0, 500);
      if (!rec.rtl) s.flag("layout", "page is not right-to-left");
      if (rec.sideways) s.flag("layout", `sideways scroll ${facts.scrollWidth}>${facts.clientWidth}`);
      for (const pr of facts.primary) if (pr.found && !pr.aboveFold) s.flag("below-fold", `${pr.selector} is not fully above the fold (top ${pr.top}, bottom ${pr.bottom}, tab bar at ${facts.navTop})`);
      if (opts.contrast && opts.contrast.length) {
        rec.contrast = await person.contrast(opts.contrast, n);
        for (const c of rec.contrast) if (!c.missing && c.aa === false) s.flag("contrast", `${c.mode}: "${c.text}" ${c.worst}:1 over ${c.over} (needs ${c.need}:1)`);
      }
    } catch (e) { rec.measureError = String(e.message).slice(0, 200); }
    if (opts.shots !== false) rec.shots = await person.shotPair(`${String(n).padStart(2, "0")}-${id}-${person.name}`, n);
    this.results.push(rec);
    const failed = rec.checks.filter((c) => !c.ok).map((c) => c.message);
    console.log(`${rec.status === "PASS" ? "PASS" : "FAIL"}  ${String(n).padStart(2, "0")} ${id} (${person.name}) ${rec.seconds}s ${rec.taps} taps ${rec.typed} typed${rec.error ? " ERROR: " + rec.error : ""}${failed.length ? " CHECKS FAILED: " + failed.join(" | ") : ""}`);
    console.log("E2E_STEP " + JSON.stringify({ test: this.testId, ...rec, checks: undefined, failedChecks: rec.checks.filter((c) => !c.ok), okChecks: rec.checks.filter((c) => c.ok).length }));
    return rec;
  }

  /** A step that cannot run, with the reason. It does not fail the run. */
  skip(id, title, reason) {
    const n = this.results.length + 1;
    this.results.push({ n, id, title, person: "-", status: "SKIP", checks: [], notes: [reason], flags: [], shots: [], error: null });
    console.log(`SKIP  ${String(n).padStart(2, "0")} ${id}: ${reason}`);
    console.log("E2E_STEP " + JSON.stringify({ test: this.testId, n, id, title, status: "SKIP", notes: [reason] }));
  }

  /** Final isolation check, summary files, exit code. */
  async finish() {
    const leaks = this.people.flatMap((p) => p.forbidden.map((f) => `${p.name}: ${f}`));
    const sawBackend = this.people.reduce((n, p) => n + p.reqs.length, 0);
    const wrap = { n: this.results.length + 1, id: "isolation", title: "Nothing left the machine", person: "all", status: leaks.length || !sawBackend ? "FAIL" : "PASS", checks: [], notes: [`${sawBackend} requests went to the local stack`], flags: [], shots: [] };
    if (leaks.length) wrap.error = "blocked: " + [...new Set(leaks)].slice(0, 5).join(", ");
    if (!sawBackend) wrap.error = "no request reached the local stack";
    this.results.push(wrap);
    console.log(`${wrap.status}  ${String(wrap.n).padStart(2, "0")} isolation ${wrap.error || ""}`);
    const failed = this.results.filter((r) => r.status === "FAIL");
    const summary = { test: this.testId, title: this.title, seconds: Math.round((Date.now() - this.t0) / 1000), steps: this.results, requests: Object.fromEntries(this.people.map((p) => [p.name, p.reqs.length])), downloads: Object.fromEntries(this.people.map((p) => [p.name, p.downloads])) };
    fs.writeFileSync(path.join(this.outDir, "results.json"), JSON.stringify(summary, null, 2));
    const md = [`# ${this.title}`, "", "| # | step | person | result | s | taps | typed |", "|---|---|---|---|---|---|---|"]
      .concat(this.results.map((r) => `| ${r.n} | ${r.id}: ${r.title} | ${r.person} | ${r.status} | ${r.seconds ?? ""} | ${r.taps ?? ""} | ${r.typed ?? ""} |`)).join("\n");
    fs.writeFileSync(path.join(this.outDir, "summary.md"), md + "\n");
    const skipped = this.results.filter((r) => r.status === "SKIP").length;
    console.log(`\n${this.title}: ${this.results.length - failed.length - skipped} passed, ${failed.length} failed, ${skipped} not covered, of ${this.results.length} steps`);
    for (const f of failed) console.log(`  FAILED ${f.n} ${f.id}: ${f.error || (f.checks || []).filter((c) => !c.ok).map((c) => c.message).join(" | ")}`);
    await this.browser.close();
    await this.server.close();
    return failed.length ? 1 : 0;
  }
}

export async function startWorld(testId, title) {
  assertLocalOnly();
  const server = await startServer();
  const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
  console.log(`${title}\nPage: ${server.url} (repository root, config override, CAPTCHA off)\nBackend: ${API_URL} (local stack, answered through ${FAKE_HOST})`);
  return new World({ testId, title, browser, server });
}
