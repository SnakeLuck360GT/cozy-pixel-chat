// API, live updates and attachment server for chat. Caddy serves the pages
// from public/, passes /api, /upload and /ws on the app domain through to
// here, and sends file requests on the content domain to /files/.

import { createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  HttpError, generatePassword, hashPassword, hashToken, loginBlocked, newId, newInviteCode, newToken,
  normalizeInviteCode, parseCookies, recordLoginFailure, validPassword, validUsername, verifyPassword,
} from "./lib/auth.js";
import { createCalls } from "./lib/calls.js";
import { config } from "./lib/config.js";
import { deleteUser, openDb } from "./lib/db.js";
import { createLive } from "./lib/live.js";
import { signedPath, verifySignedPath } from "./lib/signing.js";
import { startSampling, systemStats } from "./lib/system.js";
import { KEY_PATTERN, receiveFile } from "./lib/uploads.js";

await mkdir(config.filesDir, { recursive: true });
const db = openDb(config.dbFile);

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
// Bump this when public/terms.html changes in a way people should re-accept.
const TERMS_VERSION = "2026-11-03";
// Compared against when the username doesn't exist, so a wrong username
// takes as long as a wrong password.
const DUMMY_HASH = await hashPassword(newToken());

// Kept in step with public/js/themes.js.
const THEMES = ["farmhouse", "spring", "summer", "autumn", "winter", "rainy", "forest", "ocean", "campfire", "cafe", "light", "dark"];
const STICKER_ID = /^(?:[a-z0-9-]{1,32}|custom:\d{1,9})$/;
// Groups and servers work the same way; servers add a picture and an invite link.
const GROUP_KINDS = new Set(["group", "server"]);
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// Kept in step with BADGES in public/js/profile.js.
const BADGES = ["gamer", "cat", "dog", "coffee", "foodie", "sweet", "plants", "spooky", "star", "frog", "berry", "heart"];
const MAX_BADGES = 4;
const DEFAULT_PREFS = { theme: "farmhouse", font: "pixel", sounds: true };
const MAX_TEXT = 4000;
const MAX_ATTACHMENTS = 10;
const MAX_GROUP = 16;
const PAGE_SIZE = 50;
const AVATAR_MB = 2;
// Shown in the browser. Everything else, including SVG and PDF, downloads.
const INLINE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "audio/webm",
]);

// Over HTTPS the cookie gets the __Host- prefix, which stops other
// subdomains (like the one serving attachments) from setting or replacing it.
const SECURE = Boolean(config.publicUrl?.startsWith("https://"));
const COOKIE = SECURE ? "__Host-session" : "session";

// Helpers

function siteOrigin(req) {
  return config.publicUrl ? new URL(config.publicUrl).origin : `http://${req.headers.host}`;
}

// Without a file domain (some local setups) files come from /files on the app.
const fileUrl = (key) => `${config.contentUrl ?? "/files"}${signedPath(config.signingSecret, key)}`;

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

const json = (res, status, data, headers) => send(res, status, JSON.stringify(data), "application/json", headers);

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
}

// JSON bodies only: browsers can't send them cross-site without CORS, which
// is one of the layers that stops other sites acting on a logged-in user.
async function readJson(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected JSON");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new HttpError(413, "Request too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sessionCookie(token, maxAgeMs) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${SECURE ? "; Secure" : ""}`;
}

function positiveNumber(value, label, max) {
  const n = Number(value);
  if (!(n > 0) || n > max) throw new HttpError(400, `${label} must be more than 0 and at most ${max}`);
  return n;
}

function cleanText(value, label, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new HttpError(400, `${label} can't be empty`);
  if (text.length > max) throw new HttpError(400, `${label} can be at most ${max} characters`);
  return text;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const id = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0);

function maxMb() {
  const row = db.get("SELECT value FROM settings WHERE key = 'maxMb'");
  return row ? Number(row.value) : config.defaults.maxMb;
}

async function deleteFiles(keys) {
  await Promise.all(keys.map((key) => rm(path.join(config.filesDir, key), { force: true })));
}

// Accounts

const isAdmin = (user) => user.role === "owner" || user.role === "admin";
// Everyone but the owner has to accept the current terms before posting.
const needsTerms = (user) => user.role !== "owner" && user.terms_version !== TERMS_VERSION;

function prefsOf(user) {
  return { ...DEFAULT_PREFS, ...parseJson(user.prefs) };
}

function userView(user) {
  return {
    id: user.id,
    name: user.name,
    displayName: user.display_name || user.name,
    avatar: user.avatar ? fileUrl(user.avatar) : null,
    role: user.role,
    online: live.isOnline(user.id),
    lastSeen: user.last_seen,
    // The profile card.
    bio: user.bio ?? "",
    pronouns: user.pronouns ?? "",
    status: user.status ?? "",
    banner: user.banner ? fileUrl(user.banner) : null,
    color: user.color ?? "",
    badges: parseJson(user.badges) ?? [],
    created: user.created,
  };
}

function meView(user) {
  return {
    ...userView(user),
    prefs: prefsOf(user),
    admin: isAdmin(user),
    owner: user.role === "owner",
    needsTerms: needsTerms(user),
    maxMb: maxMb(),
  };
}

const userById = (userId) => db.get("SELECT * FROM users WHERE id = ?", userId);

function userByName(name) {
  const user = db.get("SELECT * FROM users WHERE name = ?", name);
  if (!user) throw new HttpError(404, `No user called ${name}`);
  return user;
}

// Who is making this request, from the session cookie.
function authenticate(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE];
  if (!token) return null;
  const sessionHash = hashToken(token);
  const user = db.get(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?",
    sessionHash, Date.now(),
  );
  return user ? { user, sessionHash } : null;
}

function requireUser(req) {
  const auth = authenticate(req.headers.cookie);
  if (!auth) throw new HttpError(401, "Log in first");
  // Cookies ride along on requests from other sites; refuse anything that
  // changes state unless it came from this site's own pages.
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && origin !== siteOrigin(req)) throw new HttpError(403, "Cross-site request blocked");
  return auth;
}

// Conversations and messages

const memberIds = (c) => db.all("SELECT user_id FROM members WHERE conversation_id = ?", c).map((r) => r.user_id);

function requireMember(c, userId) {
  const conversation = db.get(
    "SELECT c.* FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.id = ?",
    userId, id(c),
  );
  if (!conversation) throw new HttpError(404, "No such chat");
  return conversation;
}

function attachmentView(a) {
  return { key: a.key, url: fileUrl(a.key), name: a.name, mime: a.mime, size: a.size, kind: a.kind, meta: parseJson(a.meta) };
}

// A short version of a message, for the chat list and reply quotes.
function previewOf(m) {
  const attachment = m.deleted ? null : db.get("SELECT kind FROM attachments WHERE message_id = ? LIMIT 1", m.id);
  return {
    id: m.id,
    user: m.user_id,
    kind: m.kind,
    body: m.deleted ? "" : m.body.slice(0, 200),
    meta: parseJson(m.meta),
    attachment: attachment?.kind ?? null,
    created: m.created,
    deleted: Boolean(m.deleted),
  };
}

function messageViews(rows) {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const attachments = db.all("SELECT * FROM attachments WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created", ids);
  const reactions = db.all("SELECT * FROM reactions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created", ids);
  const replyIds = JSON.stringify([...new Set(rows.map((r) => r.reply_to).filter(Boolean))]);
  const replies = new Map(db.all("SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))", replyIds).map((r) => [r.id, r]));
  const customIds = JSON.stringify(rows.map((r) => parseJson(r.meta)?.sticker).filter((x) => String(x).startsWith("custom:")).map((x) => Number(x.slice(7))));
  const customs = new Map(db.all("SELECT * FROM stickers WHERE id IN (SELECT value FROM json_each(?))", customIds).map((x) => [`custom:${x.id}`, fileUrl(x.key)]));
  return rows.map((r) => {
    const reply = r.reply_to && replies.get(r.reply_to);
    let meta = parseJson(r.meta);
    // Uploaded stickers carry their picture's link; a removed one shows as gone.
    if (r.kind === "sticker" && meta?.sticker?.startsWith("custom:")) meta = { ...meta, url: customs.get(meta.sticker) ?? null };
    return {
      id: r.id,
      c: r.conversation_id,
      user: r.user_id,
      kind: r.kind,
      body: r.deleted ? "" : r.body,
      meta,
      replyTo: reply ? previewOf(reply) : r.reply_to ? { id: r.reply_to, deleted: true } : null,
      created: r.created,
      edited: r.edited,
      deleted: Boolean(r.deleted),
      pinned: Boolean(r.pinned),
      attachments: attachments.filter((a) => a.message_id === r.id).map(attachmentView),
      reactions: reactions.filter((x) => x.message_id === r.id).map((x) => ({ user: x.user_id, emoji: x.emoji })),
    };
  });
}

const messageView = (messageId) => messageViews([db.get("SELECT * FROM messages WHERE id = ?", messageId)])[0];

// The same chat looks a little different to each member (their unread
// count, whether they were mentioned).
function conversationView(conversation, me) {
  const members = db.all("SELECT user_id, last_read FROM members WHERE conversation_id = ? ORDER BY joined, user_id", conversation.id);
  const lastRead = members.find((m) => m.user_id === me.id)?.last_read ?? 0;
  const last = db.get("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", conversation.id);
  const unseen = "conversation_id = ? AND id > ? AND deleted IS NULL AND kind != 'system' AND (user_id IS NULL OR user_id != ?)";
  const { unread } = db.get(`SELECT COUNT(*) AS unread FROM messages WHERE ${unseen}`, conversation.id, lastRead, me.id);
  const { mentions } = db.get(
    `SELECT COUNT(*) AS mentions FROM messages WHERE ${unseen} AND instr(lower(body), ?) > 0`,
    conversation.id, lastRead, me.id, `@${me.name}`,
  );
  return {
    id: conversation.id,
    kind: conversation.kind,
    name: conversation.name,
    icon: conversation.icon ? fileUrl(conversation.icon) : null,
    invite: conversation.invite ?? null,
    theme: conversation.theme,
    created: conversation.created,
    createdBy: conversation.created_by,
    updated: conversation.updated,
    members: members.map((m) => ({ id: m.user_id, lastRead: m.last_read })),
    last: last ? previewOf(last) : null,
    unread,
    mentioned: mentions > 0,
    call: calls.view(conversation.id),
    watch: watchView(conversation.id),
  };
}

// Tells every member (and anyone just removed) about a change to a chat.
function pushConversation(c, also = []) {
  const conversation = db.get("SELECT * FROM conversations WHERE id = ?", c);
  for (const userId of new Set([...memberIds(c), ...also])) {
    const user = userById(userId);
    if (!user) continue;
    const member = db.get("SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?", c, userId);
    live.sendTo([userId], member && conversation
      ? { t: "conversation", conversation: conversationView(conversation, user) }
      : { t: "conversation-removed", id: c });
  }
}

// nonce is the sender's own id for the message, so the tab that sent it can
// swap its "sending" copy for the real one.
function postMessage(c, userId, { kind = "text", body = "", replyTo = null, meta = null, attachments = [], nonce }) {
  const now = Date.now();
  const messageId = db.transaction(() => {
    const { id: newMessage } = db.run(
      "INSERT INTO messages (conversation_id, user_id, kind, body, reply_to, meta, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
      c, userId, kind, body, replyTo, meta ? JSON.stringify(meta) : null, now,
    );
    for (const key of attachments) db.run("UPDATE attachments SET message_id = ? WHERE key = ?", newMessage, key);
    db.run("UPDATE conversations SET updated = ? WHERE id = ?", now, c);
    // Whoever wrote it has obviously seen it.
    if (userId) db.run("UPDATE members SET last_read = ? WHERE conversation_id = ? AND user_id = ?", newMessage, c, userId);
    return newMessage;
  });
  const message = messageView(messageId);
  live.sendTo(memberIds(c), { t: "message", message, nonce });
  return message;
}

// Things like "changed the theme" show up in the chat as small notes.
const systemMessage = (c, userId, meta) => postMessage(c, userId, { kind: "system", meta });

function editableMessage(messageId, me) {
  const message = db.get("SELECT * FROM messages WHERE id = ?", id(messageId));
  if (!message) throw new HttpError(404, "No such message");
  requireMember(message.conversation_id, me.id);
  return message;
}

function validEmoji(value) {
  const emoji = String(value ?? "");
  if (!emoji || emoji.length > 16 || !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]+$/u.test(emoji)) {
    throw new HttpError(400, "Reactions are a single emoji");
  }
  return emoji;
}

function otherNames(body, me) {
  const names = [...new Set((Array.isArray(body.users) ? body.users : []).map((n) => validUsername(n)))].filter((n) => n !== me.name);
  return names.map((n) => userByName(n));
}

const inviteCode = () => newToken().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 10);

// Removes whole chats with their messages and files.
async function deleteConversations(ids) {
  const list = JSON.stringify(ids);
  const keys = db.all(
    "SELECT key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)))",
    list,
  ).map((r) => r.key);
  db.run("DELETE FROM conversations WHERE id IN (SELECT value FROM json_each(?))", list);
  await deleteFiles(keys);
}

// Calls

function iceServers(user) {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  // Time-limited TURN logins that coturn can check with the shared secret
  // (its use-auth-secret mode), so no passwords are stored for it.
  if (config.turnUrls.length && config.turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 60 * 60}:${user.id}`;
    const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
    servers.push({ urls: config.turnUrls, username, credential });
  }
  return servers;
}

// Uploads: attachments and voice notes are uploaded first and sent with a
// message afterwards; avatars replace the old one straight away.

function classify(purpose, file) {
  const meta = parseJson(file.fields.meta) ?? {};
  if (["avatar", "banner", "icon", "sticker"].includes(purpose)) {
    if (!IMAGE_TYPES.includes(file.mime)) throw new HttpError(415, "That needs to be a JPEG, PNG, WebP or GIF image");
    return { kind: purpose, mime: file.mime, meta: null };
  }
  if (purpose === "voice") {
    const mime = { "video/mp4": "audio/mp4", "video/webm": "audio/webm" }[file.mime] ?? file.mime;
    if (!mime?.startsWith("audio/")) throw new HttpError(415, "That doesn't look like a recording");
    const peaks = Array.isArray(meta.peaks) ? meta.peaks.slice(0, 64).map((p) => clamp(p, 0, 1)) : [];
    return { kind: "voice", mime, meta: { duration: clamp(meta.duration, 0, 3600), peaks } };
  }
  const kind = file.mime?.split("/")[0];
  if (kind === "image" || kind === "video") {
    const size = meta.w > 0 && meta.h > 0 ? { w: Math.round(clamp(meta.w, 1, 20000)), h: Math.round(clamp(meta.h, 1, 20000)) } : null;
    return { kind, mime: file.mime, meta: size };
  }
  if (kind === "audio") return { kind, mime: file.mime, meta: null };
  return { kind: "file", mime: "application/octet-stream", meta: null };
}

async function handleUpload(req, res, url) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST with multipart/form-data");
    const { user } = requireUser(req);
    if (needsTerms(user)) throw new HttpError(403, "Accept the terms first, at /terms");
    const purpose = url.searchParams.get("purpose") ?? "attachment";
    if (!["attachment", "voice", "avatar", "banner", "icon", "sticker"].includes(purpose)) throw new HttpError(400, "Unknown upload");
    // A server picture belongs to a chat you're in.
    const target = purpose === "icon" ? requireMember(url.searchParams.get("c"), user.id) : null;
    if (target && !GROUP_KINDS.has(target.kind)) throw new HttpError(400, "Only groups and servers have pictures");
    const limit = purpose === "banner" ? 4 : ["avatar", "icon", "sticker"].includes(purpose) ? AVATAR_MB : maxMb();

    const file = await receiveFile(req, { dir: config.filesDir, maxBytes: limit * 1000 * 1000, maxMb: limit });
    let kind;
    try {
      kind = classify(purpose, file);
    } catch (err) {
      await deleteFiles([file.key]);
      throw err;
    }
    const name = purpose === "voice" ? `voice-message.${kind.mime.split("/")[1].replace("mpeg", "mp3")}` : file.name;
    db.run(
      "INSERT INTO attachments (key, user_id, name, mime, size, kind, meta, ip, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      // The IP is kept so abuse can be traced to whoever uploaded it.
      file.key, user.id, name, kind.mime, file.size, kind.kind, kind.meta ? JSON.stringify(kind.meta) : null, clientIp(req), Date.now(),
    );

    // A new profile picture or banner replaces the old one.
    if (purpose === "avatar" || purpose === "banner") {
      if (user[purpose]) {
        db.run("DELETE FROM attachments WHERE key = ?", user[purpose]);
        await deleteFiles([user[purpose]]);
      }
      db.run(`UPDATE users SET ${purpose} = ? WHERE id = ?`, file.key, user.id);
      const fresh = userById(user.id);
      live.sendAll({ t: "user", user: userView(fresh) });
      return json(res, 200, meView(fresh));
    }
    if (purpose === "icon") {
      if (target.icon) {
        db.run("DELETE FROM attachments WHERE key = ?", target.icon);
        await deleteFiles([target.icon]);
      }
      db.run("UPDATE conversations SET icon = ? WHERE id = ?", file.key, target.id);
      systemMessage(target.id, user.id, { action: "icon" });
      pushConversation(target.id);
      return json(res, 200, { ok: true });
    }
    if (purpose === "sticker") {
      const { id: sticker } = db.run("INSERT INTO stickers (key, user_id, created) VALUES (?, ?, ?)", file.key, user.id, Date.now());
      return json(res, 201, { id: `custom:${sticker}`, url: fileUrl(file.key), user: user.id });
    }
    json(res, 201, attachmentView(db.get("SELECT * FROM attachments WHERE key = ?", file.key)));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    // Drain whatever is left so the client sees the response instead of a reset.
    req.resume();
    const status = err instanceof HttpError ? err.status : 500;
    json(res, status, { error: err instanceof HttpError ? err.message : "Something went wrong. Try again." });
  }
}

// Attachments, on the content domain. Only for links the app signed, with
// the type decided at upload; anything that isn't a plain picture, video or
// recording downloads instead of opening.

async function serveFile(req, res, url) {
  const key = url.pathname.slice("/files/".length);
  if (!verifySignedPath(config.signingSecret, `/${key}${url.search}`, KEY_PATTERN)) {
    return send(res, 403, "This link has expired. Open it from the chat again.\n", "text/plain; charset=utf-8");
  }
  const file = db.get("SELECT name, mime FROM attachments WHERE key = ?", key);
  const info = file && (await stat(path.join(config.filesDir, key)).catch(() => null));
  if (!info) return send(res, 404, "Not found\n", "text/plain");

  const inline = INLINE_TYPES.has(file.mime);
  const headers = {
    "content-type": inline ? file.mime : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=86400",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "same-site",
    "x-content-type-options": "nosniff",
  };

  // Browsers fetch audio and video in pieces, and Safari won't play them otherwise.
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, info.size - Number(range[2]));
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["content-length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(path.join(config.filesDir, key), { start, end }).pipe(res);
}

// Accounts

function startSession(userId) {
  const token = newToken();
  db.run("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)", hashToken(token), userId, Date.now() + config.sessionMs);
  return sessionCookie(token, config.sessionMs);
}

async function login(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  const { username, password } = await readJson(req);
  const user = db.get("SELECT * FROM users WHERE name = ?", String(username ?? "").trim().toLowerCase());
  const ok = await verifyPassword(String(password ?? ""), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordLoginFailure(ip);
    throw new HttpError(401, "Wrong username or password");
  }
  json(res, 200, meView(user), { "set-cookie": startSession(user.id) });
}

// Invite codes share the login rate limit, so they can't be guessed either.
async function signup(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  const body = await readJson(req);
  if (body.acceptTerms !== true) throw new HttpError(400, "You need to accept the terms to sign up");
  const name = validUsername(body.username);
  const passwordHash = await hashPassword(validPassword(body.password));
  const codeHash = hashToken(normalizeInviteCode(body.code));

  const userId = db.transaction(() => {
    const invite = db.get("SELECT * FROM invites WHERE hash = ?", codeHash);
    if (!invite || invite.uses_left <= 0 || (invite.expires && invite.expires < Date.now())) {
      recordLoginFailure(ip);
      throw new HttpError(400, "That invite code isn't valid, or has been used up or expired");
    }
    if (db.get("SELECT 1 FROM users WHERE name = ?", name)) throw new HttpError(409, "That username is taken");
    const now = Date.now();
    const { id: created } = db.run(
      `INSERT INTO users (name, password_hash, role, created, invited_by, signup_ip, terms_version, terms_at, terms_ip)
       VALUES (?, ?, 'member', ?, ?, ?, ?, ?, ?)`,
      name, passwordHash, now, invite.created_by, ip, TERMS_VERSION, now, ip,
    );
    db.run(
      "UPDATE invites SET uses_left = uses_left - 1, used_by = json_insert(used_by, '$[#]', ?) WHERE id = ?",
      name, invite.id,
    );
    return created;
  });
  const user = userById(userId);
  live.sendAll({ t: "user", user: userView(user) });
  json(res, 201, meView(user), { "set-cookie": startSession(user.id) });
}

function inviteView(invite) {
  return {
    id: invite.id,
    hint: invite.hint,
    created: invite.created,
    createdBy: invite.created_by,
    expires: invite.expires,
    usesLeft: invite.uses_left,
    usedBy: parseJson(invite.used_by) ?? [],
  };
}

// API

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  let match;

  if (route === "POST /api/login") return login(req, res);
  if (route === "POST /api/signup") return signup(req, res);

  const auth = requireUser(req);
  const me = auth.user;

  // Your account

  if (route === "GET /api/me") return json(res, 200, meView(me));

  if (route === "POST /api/logout") {
    db.run("DELETE FROM sessions WHERE token_hash = ?", auth.sessionHash);
    live.close((ws) => ws.sessionHash === auth.sessionHash);
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
  }

  if (route === "PATCH /api/me") {
    const body = await readJson(req);
    const prefs = prefsOf(me);
    const line = (value, label, max) => {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      if (text.length > max) throw new HttpError(400, `${label} can be at most ${max} characters`);
      return text;
    };
    if (body.displayName !== undefined) db.run("UPDATE users SET display_name = ? WHERE id = ?", line(body.displayName, "Names", 40), me.id);
    if (body.pronouns !== undefined) db.run("UPDATE users SET pronouns = ? WHERE id = ?", line(body.pronouns, "Pronouns", 40), me.id);
    if (body.status !== undefined) db.run("UPDATE users SET status = ? WHERE id = ?", line(body.status, "Your status", 60), me.id);
    if (body.bio !== undefined) {
      // Line breaks are kept, but not runs of empty lines.
      const bio = String(body.bio ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (bio.length > 190) throw new HttpError(400, "Bios can be at most 190 characters");
      db.run("UPDATE users SET bio = ? WHERE id = ?", bio, me.id);
    }
    if (body.color !== undefined) {
      const color = String(body.color ?? "");
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, "That isn't a colour");
      db.run("UPDATE users SET color = ? WHERE id = ?", color.toLowerCase(), me.id);
    }
    if (body.badges !== undefined) {
      const badges = [...new Set(Array.isArray(body.badges) ? body.badges.map(String) : [])];
      if (badges.some((b) => !BADGES.includes(b))) throw new HttpError(400, "Unknown badge");
      if (badges.length > MAX_BADGES) throw new HttpError(400, `Pick up to ${MAX_BADGES} badges`);
      db.run("UPDATE users SET badges = ? WHERE id = ?", JSON.stringify(badges), me.id);
    }
    const profileChanged = ["displayName", "pronouns", "status", "bio", "color", "badges"].some((k) => body[k] !== undefined);
    if (body.prefs?.theme !== undefined) {
      if (!THEMES.includes(body.prefs.theme)) throw new HttpError(400, "Unknown theme");
      prefs.theme = body.prefs.theme;
    }
    if (body.prefs?.font !== undefined) prefs.font = body.prefs.font === "smooth" ? "smooth" : "pixel";
    if (body.prefs?.sounds !== undefined) prefs.sounds = Boolean(body.prefs.sounds);
    db.run("UPDATE users SET prefs = ? WHERE id = ?", JSON.stringify(prefs), me.id);
    const fresh = userById(me.id);
    if (profileChanged) live.sendAll({ t: "user", user: userView(fresh) });
    return json(res, 200, meView(fresh));
  }

  if (route === "DELETE /api/me/banner") {
    if (me.banner) {
      db.run("UPDATE users SET banner = NULL WHERE id = ?", me.id);
      db.run("DELETE FROM attachments WHERE key = ?", me.banner);
      await deleteFiles([me.banner]);
    }
    const fresh = userById(me.id);
    live.sendAll({ t: "user", user: userView(fresh) });
    return json(res, 200, meView(fresh));
  }

  if (route === "DELETE /api/me/avatar") {
    if (me.avatar) {
      db.run("UPDATE users SET avatar = NULL WHERE id = ?", me.id);
      db.run("DELETE FROM attachments WHERE key = ?", me.avatar);
      await deleteFiles([me.avatar]);
    }
    const fresh = userById(me.id);
    live.sendAll({ t: "user", user: userView(fresh) });
    return json(res, 200, meView(fresh));
  }

  if (route === "POST /api/me/password") {
    const { current, next } = await readJson(req);
    if (!(await verifyPassword(String(current ?? ""), me.password_hash))) throw new HttpError(400, "Your current password is wrong");
    const passwordHash = await hashPassword(validPassword(next));
    // Logs out every other device, keeps this one.
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, me.id);
    db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", me.id, auth.sessionHash);
    live.close((ws) => ws.userId === me.id && ws.sessionHash !== auth.sessionHash);
    return json(res, 200, { ok: true });
  }

  if (route === "POST /api/me/terms") {
    const { accept } = await readJson(req);
    if (accept !== true) throw new HttpError(400, "Tick the box to accept the terms");
    db.run("UPDATE users SET terms_version = ?, terms_at = ?, terms_ip = ? WHERE id = ?", TERMS_VERSION, Date.now(), clientIp(req), me.id);
    return json(res, 200, { ok: true, version: TERMS_VERSION });
  }

  if (route === "GET /api/ice") return json(res, 200, { iceServers: iceServers(me) });

  // Everyone with an account can see who else has one, to start a chat.
  if (route === "GET /api/users") {
    return json(res, 200, db.all("SELECT * FROM users ORDER BY name").map(userView));
  }

  // Chats

  if (route === "GET /api/conversations") {
    const rows = db.all(
      "SELECT c.* FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.user_id = ? ORDER BY c.updated DESC",
      me.id,
    );
    return json(res, 200, rows.map((c) => conversationView(c, me)));
  }

  // One other person: their one-to-one chat (made if it doesn't exist yet).
  // More, or a name: a new group.
  if (route === "POST /api/conversations") {
    if (needsTerms(me)) throw new HttpError(403, "Accept the terms first, at /terms");
    const body = await readJson(req);
    const others = otherNames(body, me);
    const kind = body.kind === "server" ? "server" : "group";
    if (!others.length && kind !== "server") throw new HttpError(400, "Pick who to chat with");
    if (others.length >= MAX_GROUP) throw new HttpError(400, `Groups can have at most ${MAX_GROUP} people`);
    const theme = prefsOf(me).theme;
    const now = Date.now();
    const groupName = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

    if (kind === "server" && !groupName) throw new HttpError(400, "Give the server a name");
    if (kind !== "server" && others.length === 1 && !groupName) {
      const dmKey = [me.id, others[0].id].sort((a, b) => a - b).join(":");
      const existing = db.get("SELECT * FROM conversations WHERE dm_key = ?", dmKey);
      if (existing) return json(res, 200, conversationView(existing, me));
      const c = db.transaction(() => {
        const { id: created } = db.run(
          "INSERT INTO conversations (kind, theme, dm_key, created, created_by, updated) VALUES ('dm', ?, ?, ?, ?, ?)",
          theme, dmKey, now, me.id, now,
        );
        for (const user of [me, others[0]]) db.run("INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)", created, user.id, now);
        return created;
      });
      pushConversation(c);
      return json(res, 201, conversationView(db.get("SELECT * FROM conversations WHERE id = ?", c), me));
    }

    const c = db.transaction(() => {
      const { id: created } = db.run(
        "INSERT INTO conversations (kind, name, theme, created, created_by, updated, invite) VALUES (?, ?, ?, ?, ?, ?, ?)",
        kind, groupName, theme, now, me.id, now, kind === "server" ? inviteCode() : null,
      );
      for (const user of [me, ...others]) db.run("INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)", created, user.id, now);
      return created;
    });
    systemMessage(c, me.id, { action: "create" });
    pushConversation(c);
    return json(res, 201, conversationView(db.get("SELECT * FROM conversations WHERE id = ?", c), me));
  }

  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)$/)) && req.method === "PATCH") {
    const conversation = requireMember(match[1], me.id);
    const body = await readJson(req);
    if (body.theme !== undefined && body.theme !== conversation.theme) {
      if (!THEMES.includes(body.theme)) throw new HttpError(400, "Unknown theme");
      db.run("UPDATE conversations SET theme = ? WHERE id = ?", body.theme, conversation.id);
      systemMessage(conversation.id, me.id, { action: "theme", theme: body.theme });
    }
    if (body.name !== undefined) {
      if (!GROUP_KINDS.has(conversation.kind)) throw new HttpError(400, "Only groups and servers have names");
      const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (name !== conversation.name) {
        db.run("UPDATE conversations SET name = ? WHERE id = ?", name, conversation.id);
        systemMessage(conversation.id, me.id, { action: "rename", name });
      }
    }
    pushConversation(conversation.id);
    return json(res, 200, { ok: true });
  }

  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)\/members$/)) && req.method === "POST") {
    const conversation = requireMember(match[1], me.id);
    if (!GROUP_KINDS.has(conversation.kind)) throw new HttpError(400, "Start a group to chat with more people");
    const current = new Set(memberIds(conversation.id));
    const adding = otherNames(await readJson(req), me).filter((u) => !current.has(u.id));
    if (!adding.length) throw new HttpError(400, "They're already in this group");
    if (current.size + adding.length > MAX_GROUP) throw new HttpError(400, `Groups can have at most ${MAX_GROUP} people`);
    const now = Date.now();
    for (const user of adding) db.run("INSERT INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)", conversation.id, user.id, now);
    systemMessage(conversation.id, me.id, { action: "add", users: adding.map((u) => u.id) });
    pushConversation(conversation.id);
    return json(res, 200, { ok: true });
  }

  // Leave a group, or (whoever made it) remove someone from it.
  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)\/members\/(\d+)$/)) && req.method === "DELETE") {
    const conversation = requireMember(match[1], me.id);
    const target = Number(match[2]);
    if (!GROUP_KINDS.has(conversation.kind)) throw new HttpError(400, "You can't leave a one-to-one chat");
    if (target !== me.id && conversation.created_by !== me.id) throw new HttpError(403, "Only whoever made the group can remove people");
    if (!db.run("DELETE FROM members WHERE conversation_id = ? AND user_id = ?", conversation.id, target).changes) {
      throw new HttpError(404, "They're not in this group");
    }
    if (!memberIds(conversation.id).length) {
      const keys = db.all(
        "SELECT key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)",
        conversation.id,
      ).map((r) => r.key);
      db.run("DELETE FROM conversations WHERE id = ?", conversation.id);
      await deleteFiles(keys);
    } else {
      systemMessage(conversation.id, me.id, target === me.id ? { action: "leave" } : { action: "remove", users: [target] });
    }
    calls.removed(conversation.id, target);
    pushConversation(conversation.id, [target]);
    return json(res, 200, { ok: true });
  }

  // Newest first in pages of 50 (?before=id), or everything since a message
  // (?after=id) to catch up after a dropped connection.
  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages$/)) && req.method === "GET") {
    const conversation = requireMember(match[1], me.id);
    const before = id(url.searchParams.get("before"));
    const after = id(url.searchParams.get("after"));
    let rows;
    if (after) {
      rows = db.all("SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 500", conversation.id, after);
    } else {
      rows = db.all(
        "SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
        conversation.id, before || Number.MAX_SAFE_INTEGER, PAGE_SIZE + 1,
      ).reverse();
    }
    const hasMore = !after && rows.length > PAGE_SIZE;
    if (hasMore) rows.shift();
    return json(res, 200, { messages: messageViews(rows), hasMore });
  }

  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages$/)) && req.method === "POST") {
    if (needsTerms(me)) throw new HttpError(403, "Accept the terms first, at /terms");
    const conversation = requireMember(match[1], me.id);
    const body = await readJson(req);
    const nonce = typeof body.nonce === "string" ? body.nonce.slice(0, 40) : undefined;
    // A sticker is a message of its own, with no text or files.
    if (body.sticker !== undefined) {
      const sticker = String(body.sticker);
      if (!STICKER_ID.test(sticker)) throw new HttpError(400, "Unknown sticker");
      if (sticker.startsWith("custom:") && !db.get("SELECT 1 FROM stickers WHERE id = ?", Number(sticker.slice(7)))) {
        throw new HttpError(404, "That sticker was removed");
      }
      return json(res, 201, postMessage(conversation.id, me.id, { kind: "sticker", meta: { sticker }, nonce }));
    }
    const text = String(body.text ?? "").replace(/\r\n?/g, "\n").trim();
    if (text.length > MAX_TEXT) throw new HttpError(400, `Messages can be at most ${MAX_TEXT} characters`);
    const keys = [...new Set(Array.isArray(body.attachments) ? body.attachments.map(String) : [])];
    if (keys.length > MAX_ATTACHMENTS) throw new HttpError(400, `At most ${MAX_ATTACHMENTS} attachments per message`);
    if (!text && !keys.length) throw new HttpError(400, "The message is empty");
    for (const key of keys) {
      const attachment = db.get("SELECT * FROM attachments WHERE key = ?", key);
      if (!attachment || attachment.user_id !== me.id || attachment.message_id || attachment.kind === "avatar") {
        throw new HttpError(400, "One of the attachments has expired. Add it again.");
      }
    }
    let replyTo = null;
    if (body.replyTo) {
      const original = db.get("SELECT id FROM messages WHERE id = ? AND conversation_id = ?", id(body.replyTo), conversation.id);
      replyTo = original?.id ?? null;
    }
    const message = postMessage(conversation.id, me.id, { body: text, replyTo, attachments: keys, nonce });
    return json(res, 201, message);
  }

  if ((match = url.pathname.match(/^\/api\/messages\/(\d+)$/))) {
    const message = editableMessage(match[1], me);
    if (message.user_id !== me.id || !["text", "sticker"].includes(message.kind) || message.deleted) {
      throw new HttpError(403, "You can only change your own messages");
    }

    if (req.method === "PATCH") {
      if (message.kind !== "text") throw new HttpError(400, "Only text can be edited");
      const text = String((await readJson(req)).text ?? "").replace(/\r\n?/g, "\n").trim();
      if (text.length > MAX_TEXT) throw new HttpError(400, `Messages can be at most ${MAX_TEXT} characters`);
      const hasFiles = db.get("SELECT 1 FROM attachments WHERE message_id = ?", message.id);
      if (!text && !hasFiles) throw new HttpError(400, "The message is empty. Unsend it instead.");
      if (text !== message.body) db.run("UPDATE messages SET body = ?, edited = ? WHERE id = ?", text, Date.now(), message.id);
      const view = messageView(message.id);
      live.sendTo(memberIds(message.conversation_id), { t: "message-update", message: view });
      return json(res, 200, view);
    }

    // Unsending removes the text, files and reactions for everyone; a small
    // note stays in its place.
    if (req.method === "DELETE") {
      const keys = db.all("SELECT key FROM attachments WHERE message_id = ?", message.id).map((r) => r.key);
      db.transaction(() => {
        db.run("UPDATE messages SET body = '', deleted = ?, pinned = NULL, pinned_by = NULL WHERE id = ?", Date.now(), message.id);
        db.run("DELETE FROM attachments WHERE message_id = ?", message.id);
        db.run("DELETE FROM reactions WHERE message_id = ?", message.id);
      });
      await deleteFiles(keys);
      const view = messageView(message.id);
      live.sendTo(memberIds(message.conversation_id), { t: "message-update", message: view });
      return json(res, 200, view);
    }
  }

  // Invite links: anyone in a server can see and share its link; whoever
  // made it can make a new one, which stops the old one working.
  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)\/invite$/)) && req.method === "POST") {
    const conversation = requireMember(match[1], me.id);
    if (!GROUP_KINDS.has(conversation.kind)) throw new HttpError(400, "Only groups and servers have invite links");
    if (conversation.invite && conversation.created_by !== me.id) throw new HttpError(403, "Only whoever made it can reset the link");
    db.run("UPDATE conversations SET invite = ? WHERE id = ?", inviteCode(), conversation.id);
    pushConversation(conversation.id);
    return json(res, 200, { invite: db.get("SELECT invite FROM conversations WHERE id = ?", conversation.id).invite });
  }

  if ((match = url.pathname.match(/^\/api\/join\/([a-z0-9]{6,16})$/))) {
    const conversation = db.get("SELECT * FROM conversations WHERE invite = ?", match[1]);
    if (!conversation) throw new HttpError(404, "That invite link doesn't work any more");
    const members = memberIds(conversation.id);
    if (req.method === "GET") {
      return json(res, 200, {
        id: conversation.id,
        name: conversation.name,
        kind: conversation.kind,
        icon: conversation.icon ? fileUrl(conversation.icon) : null,
        members: members.length,
        joined: members.includes(me.id),
      });
    }
    if (req.method === "POST") {
      if (needsTerms(me)) throw new HttpError(403, "Accept the terms first, at /terms");
      if (!members.includes(me.id)) {
        if (members.length >= MAX_GROUP) throw new HttpError(400, `It already has ${MAX_GROUP} people, the most there can be`);
        // New arrivals start with everything already read.
        db.run(
          "INSERT INTO members (conversation_id, user_id, joined, last_read) VALUES (?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?))",
          conversation.id, me.id, Date.now(), conversation.id,
        );
        systemMessage(conversation.id, me.id, { action: "join" });
        pushConversation(conversation.id);
      }
      return json(res, 200, conversationView(db.get("SELECT * FROM conversations WHERE id = ?", conversation.id), me));
    }
  }

  // Whoever made a group or server can delete it, for everyone.
  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)$/)) && req.method === "DELETE") {
    const conversation = requireMember(match[1], me.id);
    if (!GROUP_KINDS.has(conversation.kind) || conversation.created_by !== me.id) throw new HttpError(403, "Only whoever made it can delete it");
    const people = memberIds(conversation.id);
    await deleteConversations([conversation.id]);
    live.sendTo(people, { t: "conversation-removed", id: conversation.id });
    return json(res, 200, { ok: true });
  }

  // Uploaded stickers, shared by everyone. Whoever added one (or an admin) can remove it.
  if (route === "GET /api/stickers") {
    return json(res, 200, db.all("SELECT * FROM stickers ORDER BY id DESC").map((x) => ({ id: `custom:${x.id}`, url: fileUrl(x.key), user: x.user_id })));
  }

  if ((match = url.pathname.match(/^\/api\/stickers\/custom:(\d+)$/)) && req.method === "DELETE") {
    const sticker = db.get("SELECT * FROM stickers WHERE id = ?", Number(match[1]));
    if (!sticker) throw new HttpError(404, "No such sticker");
    if (sticker.user_id !== me.id && !isAdmin(me)) throw new HttpError(403, "Only whoever added it can remove it");
    db.run("DELETE FROM stickers WHERE id = ?", sticker.id);
    db.run("DELETE FROM attachments WHERE key = ?", sticker.key);
    await deleteFiles([sticker.key]);
    return json(res, 200, { ok: true });
  }

  // Anyone in a chat can pin or unpin its messages.
  if ((match = url.pathname.match(/^\/api\/messages\/(\d+)\/pin$/)) && req.method === "PUT") {
    const message = editableMessage(match[1], me);
    if (message.deleted || message.kind === "system") throw new HttpError(400, "That can't be pinned");
    const pinned = Boolean((await readJson(req)).pinned);
    if (pinned === Boolean(message.pinned)) return json(res, 200, messageView(message.id));
    db.run("UPDATE messages SET pinned = ?, pinned_by = ? WHERE id = ?", pinned ? Date.now() : null, pinned ? me.id : null, message.id);
    const view = messageView(message.id);
    live.sendTo(memberIds(message.conversation_id), { t: "message-update", message: view });
    if (pinned) systemMessage(message.conversation_id, me.id, { action: "pin", message: message.id });
    return json(res, 200, view);
  }

  if ((match = url.pathname.match(/^\/api\/conversations\/(\d+)\/pins$/)) && req.method === "GET") {
    const conversation = requireMember(match[1], me.id);
    const rows = db.all("SELECT * FROM messages WHERE conversation_id = ? AND pinned IS NOT NULL AND deleted IS NULL ORDER BY pinned DESC", conversation.id);
    return json(res, 200, messageViews(rows));
  }

  // Search text and file names, in one chat (?c=) or every chat you're in.
  if (route === "GET /api/search") {
    const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return json(res, 200, []);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const c = id(url.searchParams.get("c"));
    const rows = db.all(
      `SELECT m.* FROM messages m
         JOIN members mm ON mm.conversation_id = m.conversation_id AND mm.user_id = ?
       WHERE m.deleted IS NULL AND m.kind = 'text' AND (? = 0 OR m.conversation_id = ?)
         AND (m.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.name LIKE ? ESCAPE '\\'))
       ORDER BY m.id DESC LIMIT 60`,
      me.id, c, c, like, like,
    );
    return json(res, 200, messageViews(rows));
  }

  // Picking your current reaction again takes it off; a different one replaces it.
  if ((match = url.pathname.match(/^\/api\/messages\/(\d+)\/reaction$/)) && req.method === "PUT") {
    const message = editableMessage(match[1], me);
    if (message.deleted || message.kind === "system") throw new HttpError(400, "You can't react to that");
    const emoji = validEmoji((await readJson(req)).emoji);
    const current = db.get("SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?", message.id, me.id);
    if (current?.emoji === emoji) db.run("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", message.id, me.id);
    else db.run("INSERT OR REPLACE INTO reactions (message_id, user_id, emoji, created) VALUES (?, ?, ?, ?)", message.id, me.id, emoji, Date.now());
    const view = messageView(message.id);
    live.sendTo(memberIds(message.conversation_id), { t: "message-update", message: view });
    return json(res, 200, view);
  }

  // Admins: overview, settings, adding accounts and invites.
  if (!isAdmin(me)) throw new HttpError(403, "Admins only");

  if (route === "GET /api/admin/overview") {
    const disk = await statfs(config.filesDir);
    const files = db.get("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM attachments");
    return json(res, 200, {
      users: db.get("SELECT COUNT(*) AS n FROM users").n,
      conversations: db.get("SELECT COUNT(*) AS n FROM conversations").n,
      messages: db.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'text' AND deleted IS NULL").n,
      files: files.n,
      bytes: files.bytes,
      online: live.onlineIds().length,
      diskFree: disk.bavail * disk.bsize,
      diskTotal: disk.blocks * disk.bsize,
      maxMb: maxMb(),
    });
  }

  if (route === "GET /api/admin/system") return json(res, 200, await systemStats(config.filesDir));

  if (route === "PUT /api/settings") {
    const body = await readJson(req);
    const value = positiveNumber(body.maxMb, "Max file size", 2000);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('maxMb', ?)", String(value));
    return json(res, 200, { maxMb: value });
  }

  if (route === "POST /api/users") {
    const body = await readJson(req);
    const name = validUsername(body.name);
    if (body.admin && me.role !== "owner") throw new HttpError(403, "Only the owner can create admins");
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    if (db.get("SELECT 1 FROM users WHERE name = ?", name)) throw new HttpError(409, "That username is taken");
    db.run(
      "INSERT INTO users (name, password_hash, role, created, invited_by) VALUES (?, ?, ?, ?, ?)",
      name, passwordHash, body.admin ? "admin" : "member", Date.now(), me.name,
    );
    live.sendAll({ t: "user", user: userView(userByName(name)) });
    return json(res, 201, { name, password });
  }

  if (route === "GET /api/invites") {
    return json(res, 200, db.all("SELECT * FROM invites ORDER BY created DESC").map(inviteView));
  }

  if (route === "POST /api/invites") {
    const body = await readJson(req);
    const uses = positiveNumber(body.uses ?? 1, "Uses", 1000);
    const days = body.days === "" || body.days == null ? null : positiveNumber(body.days, "Days", 3650);
    const code = newInviteCode();
    const invite = {
      id: newId(),
      hash: hashToken(normalizeInviteCode(code)),
      hint: code.slice(0, 4),
      created: Date.now(),
      created_by: me.name,
      expires: days === null ? null : Date.now() + days * DAY_MS,
      uses_left: Math.floor(uses),
      used_by: "[]",
    };
    db.run(
      "INSERT INTO invites (id, hash, hint, created, created_by, expires, uses_left, used_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      invite.id, invite.hash, invite.hint, invite.created, invite.created_by, invite.expires, invite.uses_left, invite.used_by,
    );
    return json(res, 201, { ...inviteView(invite), code });
  }

  if (req.method === "DELETE" && (match = url.pathname.match(/^\/api\/invites\/([a-f0-9]+)$/))) {
    if (!db.run("DELETE FROM invites WHERE id = ?", match[1]).changes) throw new HttpError(404, "No such invite");
    return json(res, 200, { ok: true });
  }

  if (route === "GET /api/admin/users") {
    const counts = new Map(db.all("SELECT user_id, COUNT(*) AS n FROM messages WHERE kind = 'text' GROUP BY user_id").map((r) => [r.user_id, r.n]));
    const bytes = new Map(db.all("SELECT user_id, SUM(size) AS n FROM attachments GROUP BY user_id").map((r) => [r.user_id, r.n]));
    return json(res, 200, db.all("SELECT * FROM users ORDER BY created").map((u) => ({
      ...userView(u),
      created: u.created,
      invitedBy: u.invited_by,
      messages: counts.get(u.id) ?? 0,
      bytes: bytes.get(u.id) ?? 0,
    })));
  }

  // Owner only: anything touching other people's accounts.
  if (me.role !== "owner") throw new HttpError(403, "Only the owner can do that");

  // Recent uploads with the address they came from, for tracing abuse.
  if (route === "GET /api/admin/uploads") {
    const rows = db.all(
      "SELECT a.*, u.name AS user_name FROM attachments a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created DESC LIMIT 100",
    );
    return json(res, 200, rows.map((a) => ({ ...attachmentView(a), user: a.user_name, ip: a.ip, created: a.created, sent: Boolean(a.message_id) })));
  }

  if ((match = url.pathname.match(/^\/api\/users\/([^/]+)(?:\/([a-z-]+))?$/))) {
    const [, name, action] = match;
    const user = userByName(name);
    const self = user.id === me.id;

    if (req.method === "POST" && action === "reset") {
      const password = generatePassword();
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), user.id);
      db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
      live.close((ws) => ws.userId === user.id);
      return json(res, 200, { name: user.name, password });
    }

    if (req.method === "POST" && action === "admin") {
      const { admin } = await readJson(req);
      if (self) throw new HttpError(400, "You can't change your own role");
      db.run("UPDATE users SET role = ? WHERE id = ?", admin ? "admin" : "member", user.id);
      return json(res, 200, { ok: true });
    }

    if (req.method === "DELETE" && !action) {
      if (self) throw new HttpError(400, "You can't delete your own account");
      const groups = db.all(
        "SELECT c.id FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE c.kind = 'group' AND m.user_id = ?",
        user.id,
      ).map((r) => r.id);
      const removed = deleteUser(db, user.id);
      await deleteFiles(removed.keys);
      live.close((ws) => ws.userId === user.id);
      live.sendAll({ t: "user-removed", id: user.id });
      for (const c of removed.conversations) live.sendAll({ t: "conversation-removed", id: c });
      for (const c of groups) if (!removed.conversations.includes(c)) pushConversation(c);
      return json(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, "Not found");
}

// Watching YouTube together: one video per chat, with whether it's playing
// and where it was at a given moment. Each browser works out where it should
// be from that and keeps its player in step. Kept in memory only.

const watching = new Map();
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const watchView = (c) => (watching.has(c) ? { ...watching.get(c), now: Date.now() } : null);
const pushWatch = (c) => live.sendTo(memberIds(c), { t: "watch", c, watch: watchView(c), now: Date.now() });

// The title comes from YouTube's public oEmbed endpoint, so people see what's on.
async function videoTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return "";
    return String((await res.json()).title ?? "").slice(0, 200);
  } catch {
    return "";
  }
}

function onWatchEvent(ws, event) {
  const conversation = requireMember(event.c, ws.userId);
  const c = conversation.id;
  if (event.t === "watch-start") {
    const videoId = String(event.videoId ?? "");
    if (!YOUTUBE_ID.test(videoId)) throw new HttpError(400, "That isn't a YouTube link");
    watching.set(c, { videoId, title: "", playing: true, position: 0, at: Date.now(), by: ws.userId });
    pushWatch(c);
    systemMessage(c, ws.userId, { action: "watch", videoId });
    videoTitle(videoId).then((title) => {
      const current = watching.get(c);
      if (title && current?.videoId === videoId) {
        current.title = title;
        pushWatch(c);
      }
    });
  } else if (event.t === "watch-state") {
    const current = watching.get(c);
    if (!current || current.videoId !== event.videoId) return;
    Object.assign(current, { playing: Boolean(event.playing), position: clamp(event.position, 0, 24 * 3600), at: Date.now(), by: ws.userId });
    pushWatch(c);
  } else if (event.t === "watch-stop") {
    if (watching.delete(c)) pushWatch(c);
  }
}

// Live events from the browser: typing, read markers, calls and watching together.

function onEvent(ws, event) {
  // For the ping shown in calls: the browser times the round trip.
  if (event.t === "ping") return live.send(ws, { t: "pong", id: Number(event.id) || 0 });
  if (event.t === "typing") {
    const conversation = requireMember(event.c, ws.userId);
    live.sendTo(memberIds(conversation.id).filter((u) => u !== ws.userId), { t: "typing", c: conversation.id, user: ws.userId });
  } else if (event.t === "read") {
    const conversation = requireMember(event.c, ws.userId);
    const newest = db.get("SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?", conversation.id).id ?? 0;
    const upTo = Math.min(id(event.id), newest);
    const { changes } = db.run(
      "UPDATE members SET last_read = ? WHERE conversation_id = ? AND user_id = ? AND last_read < ?",
      upTo, conversation.id, ws.userId, upTo,
    );
    if (changes) live.sendTo(memberIds(conversation.id), { t: "read", c: conversation.id, user: ws.userId, id: upTo });
  } else if (event.t.startsWith("call-")) {
    if (event.t === "call-join" && needsTerms(userById(ws.userId))) throw new HttpError(403, "Accept the terms first, at /terms");
    calls.handle(ws, event);
  } else if (event.t.startsWith("watch-")) {
    onWatchEvent(ws, event);
  }
}

function setPresence(userId, online) {
  const now = Date.now();
  db.run("UPDATE users SET last_seen = ? WHERE id = ?", now, userId);
  live.sendAll({ t: "presence", user: userId, online, lastSeen: now });
}

const live = createLive({
  authenticate,
  originAllowed: (req) => req.headers.origin === siteOrigin(req),
  onConnect(ws, first) {
    live.send(ws, { t: "hello", online: live.onlineIds() });
    if (first) setPresence(ws.userId, true);
  },
  onEvent,
  onDisconnect(ws, last) {
    calls.disconnected(ws);
    if (last && userById(ws.userId)) setPresence(ws.userId, false);
  },
});

const calls = createCalls({
  live,
  membersOf: (c) => memberIds(id(c)),
  logCall(c, userId, meta) {
    if (db.get("SELECT 1 FROM conversations WHERE id = ?", c)) postMessage(c, userId, { kind: "call", meta });
  },
});

// Housekeeping: expired sessions and invites, attachments that were uploaded
// but never sent, and stray files (like interrupted uploads) after a day.

async function sweep() {
  const now = Date.now();
  db.run("DELETE FROM sessions WHERE expires <= ?", now);
  db.run("DELETE FROM invites WHERE expires IS NOT NULL AND expires < ?", now - 7 * DAY_MS);
  const unsent = db.all(
    "SELECT key FROM attachments WHERE message_id IS NULL AND kind NOT IN ('avatar', 'banner', 'icon', 'sticker') AND created < ?",
    now - DAY_MS,
  ).map((r) => r.key);
  db.run("DELETE FROM attachments WHERE key IN (SELECT value FROM json_each(?))", JSON.stringify(unsent));
  await deleteFiles(unsent);
  const known = new Set(db.all("SELECT key FROM attachments").map((r) => r.key));
  for (const name of await readdir(config.filesDir)) {
    if (known.has(name)) continue;
    const file = path.join(config.filesDir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.mtimeMs < now - DAY_MS) await rm(file, { force: true });
  }
}

// Server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/files/") && (req.method === "GET" || req.method === "HEAD")) {
    return serveFile(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, "Something went wrong\n", "text/plain");
      else res.destroy();
    });
  }
  if (url.pathname === "/upload") return handleUpload(req, res, url);
  if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found\n", "text/plain");
  try {
    await api(req, res, url);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    const status = err instanceof HttpError ? err.status : 500;
    json(res, status, { error: err instanceof HttpError ? err.message : "Something went wrong. Try again." });
  }
});

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://localhost").pathname === "/ws") live.upgrade(req, socket, head);
  else socket.destroy();
});

await sweep();
setInterval(() => sweep().catch(console.error), SWEEP_EVERY_MS);
startSampling();

if (!db.get("SELECT 1 FROM users LIMIT 1")) {
  console.warn("No accounts yet. Create the owner with: node manage.js add-user <name> --owner");
}

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Listening on 127.0.0.1:${config.port}, storing data in ${config.dataDir}`);
});
