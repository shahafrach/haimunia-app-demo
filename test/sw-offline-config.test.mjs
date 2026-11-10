// Audit H1 (2026-11): offline, sw.js answered a failed cloud-config.js fetch
// with an empty config, so the Circle tab told a signed-in member to "create a
// Supabase project". The worker now keeps the last good copy in its own cache
// and serves it when the network fails. This boots the real sw.js in a vm with
// a fake ServiceWorkerGlobalScope and drives its fetch handler.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const ORIGIN = "https://box-log.pages.dev";

function boot(fetchImpl) {
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async put(key, res) { m.set(String(key), res); },
        async match(key) { return m.get(String(key)) || undefined; },
        async addAll() {}, async keys() { return []; }, async delete() { return true; },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
    async match() { return undefined; },
  };
  const listeners = {};
  const self = {
    location: new URL(ORIGIN + "/sw.js"),
    addEventListener(type, fn) { listeners[type] = fn; },
    registration: {}, clients: { claim: async () => {} }, skipWaiting: async () => {},
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Response, Request, URL, console, setTimeout, Promise });
  vm.runInContext(source, ctx);
  async function get(path) {
    let responded = null;
    const waits = [];
    listeners.fetch({
      request: { url: ORIGIN + path, mode: "no-cors", method: "GET", headers: new Headers() },
      respondWith(p) { responded = Promise.resolve(p); },
      waitUntil(p) { waits.push(p); },
      preloadResponse: Promise.resolve(undefined),
    });
    assert.ok(responded, "the worker must answer cloud-config.js itself");
    const res = await responded;
    await Promise.all(waits);
    return res;
  }
  return { get };
}

const GOOD = 'window.HAIMUNIA_CONFIG={supabaseUrl:"https://x.supabase.co"};';

test("offline after one good load: the last good cloud-config.js is served, not an empty one", async () => {
  let online = true;
  const sw = boot(async () => {
    if (!online) throw new TypeError("Failed to fetch");
    return new Response(GOOD, { status: 200, headers: { "Content-Type": "application/javascript" } });
  });
  assert.equal(await (await sw.get("/cloud-config.js")).text(), GOOD);
  online = false;
  assert.equal(await (await sw.get("/cloud-config.js")).text(), GOOD);
});

test("offline with nothing cached: still an empty config, so the app boots", async () => {
  const sw = boot(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(await (await sw.get("/cloud-config.js")).text(), "window.HAIMUNIA_CONFIG={};");
});

test("online, the network answer wins over the cached copy (never served stale)", async () => {
  let body = GOOD;
  const sw = boot(async () => new Response(body, { status: 200 }));
  await sw.get("/cloud-config.js");
  body = 'window.HAIMUNIA_CONFIG={supabaseUrl:"https://y.supabase.co"};';
  assert.equal(await (await sw.get("/cloud-config.js")).text(), body);
});

test("an error page is not cached as the config", async () => {
  let mode = "error";
  const sw = boot(async () => {
    if (mode === "error") return new Response("oops", { status: 500 });
    throw new TypeError("Failed to fetch");
  });
  await sw.get("/cloud-config.js");
  mode = "offline";
  assert.equal(await (await sw.get("/cloud-config.js")).text(), "window.HAIMUNIA_CONFIG={};");
});

test("the config cache survives app updates: activate only deletes haimunia-demo-v* caches", () => {
  assert.match(source, /const CONFIG_CACHE = "haimunia-demo-config";/);
  assert.match(source, /k\.startsWith\("haimunia-demo-v"\) && k !== CACHE/);
});
