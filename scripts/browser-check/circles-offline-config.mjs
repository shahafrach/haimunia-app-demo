// Audit H1 (2026-11), fix plan F1. Offline, sw.js used to answer cloud-config.js
// with an empty config, so the Circle tab told a member to "create a Supabase
// project (COMMUNITY_SETUP.md)". The worker now keeps the last good copy. This
// installs the real service worker, loads once online, goes offline, reloads,
// and reads the Circle tab.
import { chromium } from "playwright";
import { startStaticServer } from "./lib/server.mjs";
import { projectRoot } from "./lib/target.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";
import { dismissWelcomeModal } from "./lib/actions.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const { url, close } = await startStaticServer(projectRoot);
console.log(`Target: ${url} (local static server, mocked backend, real service worker)`);
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await installMockCloud(page);
  await page.goto(url, { waitUntil: "load" });
  await dismissWelcomeModal(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === "activated", { timeout: 20000 });
  // One load under the active worker, so it is the worker that fetched (and kept) the config.
  await page.reload({ waitUntil: "load" });
  const cached = await page.evaluate(async () => {
    const c = await caches.open("haimunia-demo-config");
    const r = await c.match("./cloud-config.js");
    return r ? (await r.text()).includes("supabaseUrl") : false;
  });
  check("online: the worker keeps the last good cloud-config.js", cached);

  await ctx.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await dismissWelcomeModal(page);
  const configured = await page.evaluate(() => !!(window.HAIMUNIA_CONFIG && window.HAIMUNIA_CONFIG.supabaseUrl));
  check("offline: the app boots with the cached config, not an empty one", configured);
  await page.click("#tabCommunityBtn");
  await page.waitForTimeout(500);
  const text = await page.evaluate(() => document.getElementById("content").textContent || "");
  check("offline: the Circle tab shows no developer setup text", !/COMMUNITY_SETUP|cloud-config|Supabase/.test(text), text.slice(0, 120).replace(/\s+/g, " "));
  await ctx.close();
} catch (e) {
  check("scenario ran", false, e && e.message);
} finally {
  await browser.close();
  await close();
}
process.exit(failed ? 1 : 0);
