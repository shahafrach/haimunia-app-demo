// The caller's address for the per-IP limits (Q-41, 2026-11-18). Only cf-connecting-ip, which the platform's
// edge sets and a client cannot: x-forwarded-for is whatever the caller sends, so trusting it let one caller
// spread its attempts over invented addresses. No header means one shared "unknown" bucket, which only ever
// makes a limit stricter.
export function clientIp(headers) {
  const v = headers && typeof headers.get === "function" ? headers.get("cf-connecting-ip") : "";
  const ip = String(v || "").trim();
  return ip || "unknown";
}
