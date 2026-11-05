import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split(":");
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  return timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

// Session cookies and upload tokens are random; only their hashes are stored.
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");
export const generatePassword = () => randomBytes(12).toString("base64url");
export const newId = () => randomBytes(6).toString("hex");

// Invite codes are typed or pasted by people, so: capitals and digits only,
// no look-alikes (0/O, 1/I/L), in groups of four like ABCD-EFGH-JKMN.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newInviteCode() {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
  return chars.match(/.{4}/g).join("-");
}
export const normalizeInviteCode = (code) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function validUsername(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(name)) {
    throw new HttpError(400, "Usernames are 2 to 32 letters, numbers, - or _");
  }
  return name;
}

export function validPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8) throw new HttpError(400, "Passwords need at least 8 characters");
  if (password.length > 200) throw new HttpError(400, "That password is too long");
  return password;
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

// Slows down password guessing: 10 failed logins per address per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

export function loginBlocked(ip) {
  const entry = failures.get(ip);
  if (entry && entry.until < Date.now()) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= MAX_FAILURES;
}

export function recordLoginFailure(ip) {
  const entry = failures.get(ip) ?? { count: 0, until: Date.now() + WINDOW_MS };
  entry.count++;
  failures.set(ip, entry);
}
