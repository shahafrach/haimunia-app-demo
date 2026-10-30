// Serves the repository root, exactly as Cloudflare Pages would, with TWO
// differences that exist only in what this server sends, never on disk:
//
//   /cloud-config.js  -> the override file this module writes to .run/. It is the
//                        shipped config with the Supabase URL, key and CAPTCHA
//                        fields replaced. The tracked cloud-config.js is not touched.
//   /index.html       -> the Content-Security-Policy names FAKE_HOST where the
//                        shipped file names the production project, so the page may
//                        talk to the stand-in host the tests route to the local stack.
//
// CAPTCHA IS OFF in the override (captchaSiteKey ""), because the local stack has
// no Turnstile secret and the real widget needs challenges.cloudflare.com. That is
// the one deliberate difference from production's sign-up; docs/qa says so.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO_ROOT, RUN_DIR, FAKE_HOST, FAKE_ORIGIN, ANON_KEY, SHIPPED_HOST_RE } from "./config.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};

export function writeConfigOverride() {
  const source = fs.readFileSync(path.join(REPO_ROOT, "cloud-config.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "cloud-config.js" });
  const shipped = sandbox.window.HAIMUNIA_CONFIG;
  if (!shipped) throw new Error("cloud-config.js did not set window.HAIMUNIA_CONFIG");
  const cfg = JSON.parse(JSON.stringify(shipped));
  cfg.supabaseUrl = FAKE_ORIGIN;
  cfg.supabasePublishableKey = ANON_KEY;
  cfg.captchaProvider = "";
  cfg.captchaSiteKey = "";
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const file = path.join(RUN_DIR, "cloud-config.override.js");
  fs.writeFileSync(file, "// Written by scripts/e2e. Local stack only. CAPTCHA off.\nwindow.HAIMUNIA_CONFIG = Object.freeze(" + JSON.stringify(cfg, null, 2) + ");\n");
  return file;
}

export function startServer() {
  const overrideFile = writeConfigOverride();
  const root = path.resolve(REPO_ROOT);
  const server = http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      const send = (status, type, body) => { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
      if (urlPath === "/cloud-config.js") return send(200, MIME[".js"], fs.readFileSync(overrideFile));
      const file = path.join(root, urlPath);
      if (!file.startsWith(root + path.sep)) return send(403, "text/plain", "forbidden");
      // Paths functions/_middleware.js keeps off the public site stay off here too.
      if (/^\/(supabase|test|scripts|docs|node_modules|\.git|\.github|functions|workers)(\/|$)/.test(urlPath)) return send(404, "text/plain", "not found");
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, "text/plain", "not found");
      let body = fs.readFileSync(file);
      if (urlPath === "/index.html") body = Buffer.from(body.toString("utf8").replace(SHIPPED_HOST_RE, FAKE_HOST));
      send(200, MIME[path.extname(file)] || "application/octet-stream", body);
    } catch (e) {
      res.writeHead(500); res.end("server error");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/`, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
