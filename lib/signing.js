// Files live on a separate domain with no cookies, so "members only" is
// enforced with signed links: the app hands out file URLs that carry an
// expiry and an HMAC, and the file server checks them before serving
// anything.

import { createHmac, timingSafeEqual } from "node:crypto";

const LINK_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

function signature(secret, key, expires) {
  return createHmac("sha256", secret).update(`${key}:${expires}`).digest("base64url").slice(0, 32);
}

// Expiry is rounded up to the hour so the same link is handed out for a
// while, which lets browsers cache the file.
export function signedPath(secret, key) {
  const expires = Math.ceil((Date.now() + LINK_HOURS * HOUR_MS) / HOUR_MS) * HOUR_MS;
  return `/${key}?e=${expires}&s=${signature(secret, key, expires)}`;
}

export function verifySignedPath(secret, uri, keyPattern) {
  const url = new URL(uri, "http://x");
  const key = url.pathname.slice(1);
  const expires = Number(url.searchParams.get("e"));
  const given = Buffer.from(url.searchParams.get("s") ?? "");
  if (!keyPattern.test(key) || !(expires > Date.now())) return false;
  const expected = Buffer.from(signature(secret, key, expires));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
