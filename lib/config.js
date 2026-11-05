import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
const list = (value) => String(value ?? "").split(/[\s,]+/).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3002),
  // Localhost when Caddy is on the same machine. Docker needs 0.0.0.0 so
  // the Caddy container can reach it.
  host: process.env.HOST || "127.0.0.1",
  dataDir,
  // Attachments, voice notes and avatars, named by a random key.
  filesDir: path.join(dataDir, "files"),
  dbFile: path.join(dataDir, "chat.db"),
  // The app, e.g. https://chat.example.com
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, ""),
  // Where attachments are served, e.g. https://chat-files.example.com. A
  // separate subdomain means an uploaded file can't act as the app.
  contentUrl: (process.env.CONTENT_URL || process.env.PUBLIC_URL)?.replace(/\/$/, ""),
  // Signs attachment links so only people in the chat can open them.
  signingSecret: process.env.SIGNING_SECRET || "dev-only-secret",
  // Calls: STUN finds each side's public address; TURN relays the call when
  // the two sides can't reach each other directly (common on mobile data).
  stunUrls: list(process.env.STUN_URLS ?? "stun:stun.l.google.com:19302"),
  turnUrls: list(process.env.TURN_URLS),
  turnSecret: process.env.TURN_SECRET || "",
  sessionMs: 30 * 24 * 60 * 60 * 1000,
  // Starting limit; the admin page can change it.
  defaults: {
    maxMb: Number(process.env.MAX_SIZE_MB || 100),
  },
};
