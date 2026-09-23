#!/usr/bin/env node
// The half of the backup that was missing: the photos themselves.
//
// WHY THIS EXISTS. The restore drill on 2026-09-23 established that
// `supabase db dump` captures `storage.objects` ROWS and not the files they
// point at — the archive was three .sql files and nothing else. So a lost
// project lost every member photo and avatar permanently, while the database
// restored perfectly and the metadata rows pointed at bytes that no longer
// existed anywhere. PRIVACY.md promises members their own content; that
// promise had no backup behind it.
//
// WHAT IT DOES. Downloads every object in the photo buckets, writes a
// manifest beside them, and — with `restore` — puts them back. It is meant to
// run next to the database dump so both halves land in the same encrypted
// archive; see docs/ops/MONITORING.md §7.
//
// WHY A MANIFEST AND NOT JUST FILES. A directory of JPEGs cannot tell you
// whether it is complete. The manifest records the object count, every path,
// every size and a sha256 per file, so a restore can say "all 41 files
// present and unchanged" instead of "the command exited zero" — which is the
// distinction the database drill already had and this half did not.
//
// ON `--experimental`. `supabase storage` is behind that flag in CLI 2.116.0.
// That is a real dependency risk for a backup: an experimental command can
// change or disappear. It is used anyway because the alternative is
// hand-rolling a Storage REST client with its own pagination and signed-URL
// handling, which is more code to be wrong. If the flag is ever removed, the
// fallback is `GET /storage/v1/object/list/<bucket>` plus
// `GET /storage/v1/object/<bucket>/<path>` with a service-role key, and the
// manifest format below does not change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

// Both private, both capped by the bucket's own file_size_limit
// (post-photos 5 MB, avatar-photos 2 MB). Listed explicitly rather than
// discovered: a bucket that appears later should be added here deliberately,
// with someone deciding whether it belongs in a backup at all.
const BUCKETS = ["post-photos", "avatar-photos"];
const MANIFEST = "storage-manifest.json";

// --local swaps the target from the linked production project to the local
// stack's Storage service. That is what makes a restore DRILL possible at
// all: `restore` writes objects, and rehearsing it against production would
// be doing the thing rather than practising it. Same code path, same CLI,
// different endpoint.
const TARGET = process.argv.includes("--local") ? "--local" : "--linked";

function sh(args, opts = {}) {
  return execFileSync("supabase", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

async function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function backup(outDir) {
  const root = path.join(outDir, "storage");
  mkdirSync(root, { recursive: true });
  const started = Date.now();
  const entry = [];

  for (const bucket of BUCKETS) {
    // DOWNLOAD INTO THE ROOT, NOT INTO root/<bucket>. `supabase storage cp -r
    // ss:///post-photos <dest>` creates <dest>/post-photos/... itself - it
    // appends the bucket name. Passing root/<bucket> as the destination
    // produced root/post-photos/post-photos/<uid>/<file>, and a manifest
    // whose every path began with the bucket name twice. Caught by reading
    // the manifest the first time this ran, not by the exit code, which was 0.
    const dest = path.join(root, bucket);
    try {
      // -r so nested <uid>/<file> prefixes come with it. An empty bucket is
      // not an error: avatar-photos was empty when this was written.
      sh(["storage", "cp", TARGET, "--experimental", "-r", `ss:///${bucket}`, root], { stdio: "pipe" });
    } catch (e) {
      const msg = (e.stderr || e.stdout || e.message || "").toString().slice(0, 300);
      // Loud, and non-zero. A backup that quietly skips half of itself is the
      // failure this whole script exists because of.
      console.error(`FAILED to download ${bucket}: ${msg}`);
      process.exit(1);
    }
    for (const f of await walk(dest)) {
      entry.push({
        bucket,
        // Path RELATIVE to the bucket dir, which is what a restore uploads to.
        path: path.relative(dest, f).split(path.sep).join("/"),
        bytes: statSync(f).size,
        sha256: sha256(f),
      });
    }
  }

  const manifest = {
    taken_at: new Date().toISOString(),
    buckets: BUCKETS,
    object_count: entry.length,
    total_bytes: entry.reduce((n, e) => n + e.bytes, 0),
    elapsed_ms: Date.now() - started,
    objects: entry.sort((a, b) => (a.bucket + a.path).localeCompare(b.bucket + b.path)),
  };
  writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");

  const mb = (manifest.total_bytes / 1048576).toFixed(2);
  console.log(`storage backup: ${manifest.object_count} object(s), ${mb} MB, ${(manifest.elapsed_ms / 1000).toFixed(1)}s`);
  for (const b of BUCKETS) {
    const n = entry.filter((e) => e.bucket === b).length;
    console.log(`  ${b}: ${n} object(s)`);
  }
  // Photos do not compress — measured at a ratio of 1.000 on real JPEGs — so
  // this number is what the archive grows by, near enough exactly.
  console.log(`  archive will grow by about ${mb} MB (JPEG does not compress)`);
  return manifest;
}

// Verify a restored or extracted directory against its own manifest. This is
// the thing that makes a storage backup checkable rather than hopeful.
async function verify(dir) {
  const root = path.join(dir, "storage");
  const manifestPath = path.join(root, MANIFEST);
  if (!existsSync(manifestPath)) {
    console.error(`no ${MANIFEST} in ${root} — this archive has no storage half, or it is from before 202609230008`);
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  let missing = 0, changed = 0;
  for (const o of m.objects) {
    const f = path.join(root, o.bucket, o.path);
    if (!existsSync(f)) { console.error(`  MISSING ${o.bucket}/${o.path}`); missing++; continue; }
    if (statSync(f).size !== o.bytes || sha256(f) !== o.sha256) {
      console.error(`  CHANGED ${o.bucket}/${o.path}`); changed++;
    }
  }
  const ok = missing === 0 && changed === 0;
  console.log(`storage verify: ${m.object_count} expected, ${missing} missing, ${changed} changed — ${ok ? "OK" : "FAILED"}`);
  if (!ok) process.exit(1);
  return m;
}

// Put them back. Used in a real recovery, and by the drill.
async function restore(dir) {
  const m = await verify(dir);
  const root = path.join(dir, "storage");
  let uploaded = 0;
  for (const bucket of m.buckets) {
    const src = path.join(root, bucket);
    if (!existsSync(src) || (await walk(src)).length === 0) {
      console.log(`  ${bucket}: nothing to upload`);
      continue;
    }
    try {
      // UPLOAD THE DIRECTORY INTO THE ROOT, not into ss:///<bucket>. `cp -r`
      // appends the SOURCE directory's name to the destination, exactly as it
      // appends the bucket name on the way down - so `cp -r .../post-photos
      // ss:///post-photos` writes post-photos/post-photos/<uid>/<file>.
      //
      // That bug shipped in the first version of this script and the drill is
      // the only reason it is not still there: the upload exited 0 and said
      // "2 object(s) uploaded", and every photo had been restored to a path no
      // row in the database references. A real recovery would have reported
      // success and left every photo broken. The round-trip sha256 check in
      // MONITORING.md §7 is what caught it, which is why that check is part of
      // the drill and not an optional extra.
      sh(["storage", "cp", TARGET, "--experimental", "-r", src, "ss:///"], { stdio: "pipe" });
      uploaded += m.objects.filter((o) => o.bucket === bucket).length;
    } catch (e) {
      console.error(`FAILED to upload ${bucket}: ${(e.stderr || e.message || "").toString().slice(0, 300)}`);
      process.exit(1);
    }
  }
  console.log(`storage restore: ${uploaded} object(s) uploaded to ${TARGET === "--local" ? "the LOCAL stack" : "the LINKED project"}`);
  console.log("  NOT verified against the live bucket — re-run `ls` or the drill in MONITORING.md §7 to confirm.");
}

const [cmd, dir] = process.argv.slice(2).filter((a) => a !== "--local");
if (!cmd || !dir || !["backup", "verify", "restore"].includes(cmd)) {
  console.error("usage: backup-storage.mjs <backup|verify|restore> <dir>");
  console.error("  backup  <dir>  download every photo bucket into <dir>/storage/ with a manifest");
  console.error("  verify  <dir>  check <dir>/storage/ against its manifest (count, size, sha256)");
  console.error("  restore <dir>  upload <dir>/storage/ back into the project");
  console.error("  --local        target the local stack instead of the linked project (for drills)");
  process.exit(2);
}
const fn = cmd === "backup" ? backup : cmd === "verify" ? verify : restore;
fn(dir).catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
