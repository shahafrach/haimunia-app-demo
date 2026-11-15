// F-008 (2026-11-15): box-log.pages.dev sent only `frame-ancestors 'none'` as its header CSP. The
// full policy now arrives as a real header, with no inline script allowance, until the site shuts
// down on 2026-12-15.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

const headers = readFileSync(new URL("../_headers", import.meta.url), "utf8");
const csp = (headers.match(/^\s+Content-Security-Policy:\s*(.+)$/m) || [])[1] || "";
const dir = (name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) || "");

test("the header CSP is the full policy", () => {
  assert.equal(dir("default-src"), "default-src 'self'");
  assert.equal(dir("script-src"), "script-src 'self' https://challenges.cloudflare.com");
  assert.equal(dir("connect-src"), "connect-src 'self' https://hvwakffluwvegedefoth.supabase.co https://challenges.cloudflare.com");
  assert.equal(dir("frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(dir("object-src"), "object-src 'none'");
  assert.equal(dir("base-uri"), "base-uri 'self'");
  assert.doesNotMatch(dir("script-src"), /unsafe-inline|unsafe-eval/);
});

test("the header CSP names the same hosts as the <meta> CSP in index.html, directive by directive", () => {
  const meta = (readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
  const hosts = (policy, name) => {
    const d = policy.replace(/\s+/g, " ").split(";").map((x) => x.trim()).find((x) => x.startsWith(name + " ")) || "";
    return d.split(" ").slice(1).filter((t) => /^https?:\/\//.test(t)).sort();
  };
  for (const name of ["default-src", "script-src", "connect-src", "frame-src", "img-src", "style-src", "font-src"]) {
    assert.deepEqual(hosts(csp, name), hosts(meta, name), name + ": header and meta CSP name different hosts");
  }
  assert.ok(hosts(csp, "connect-src").includes("https://challenges.cloudflare.com"), "Turnstile in connect-src, as in the meta CSP");
});

test("HSTS, nosniff and Referrer-Policy are sent", () => {
  assert.match(headers, /Strict-Transport-Security: max-age=\d+/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});

test("no inline event handler or inline script anywhere the app loads", () => {
  const files = ["index.html", "privacy.html", "terms.html", "404.html", "app.js", "cloud.js",
    ...readdirSync(new URL("../src", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => "src/" + f),
    ...readdirSync(new URL("../src/community", import.meta.url)).map((f) => "src/community/" + f)];
  for (const f of files) {
    const text = readFileSync(new URL("../" + f, import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(text, /\son(click|focus|blur|load|error|input|change|submit|keydown|keyup)="/, f + " has an inline handler");
    if (f.endsWith(".html")) assert.doesNotMatch(text, /<script>(?!<\/script>)/, f + " has an inline <script>");
  }
});
