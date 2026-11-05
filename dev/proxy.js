// A stand-in for Caddy when running locally: the app on :8080 (pages from
// public/, with /api, /upload and /ws passed to the server) and the file
// domain on :8081 (/<key> passed to the server's /files/<key>).
//
//   PUBLIC_URL=http://localhost:8080 CONTENT_URL=http://localhost:8081 npm start
//   node dev/proxy.js
//
// Other ports: API_PORT (the server's PORT), APP_PORT and FILES_PORT.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const API = Number(process.env.API_PORT || 3002);
const APP_PORT = Number(process.env.APP_PORT || 8080);
const FILES_PORT = Number(process.env.FILES_PORT || 8081);
const ROOT = path.resolve(import.meta.dirname, "../public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain" };

function proxy(req, res, pathname) {
  const upstream = http.request({ host: "127.0.0.1", port: API, method: req.method, path: pathname, headers: { ...req.headers, "x-forwarded-for": "127.0.0.1" } }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end("API down"); });
  req.pipe(upstream);
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/upload" || url.pathname.startsWith("/api/")) return proxy(req, res, req.url);
  for (const candidate of [url.pathname, `${url.pathname}.html`, path.join(url.pathname, "index.html")]) {
    const file = path.join(ROOT, path.normalize(candidate));
    if (!file.startsWith(ROOT)) break;
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      return createReadStream(file).pipe(res);
    }
  }
  res.writeHead(404);
  res.end("Not found");
});

// WebSockets: hand the raw connection to the API server.
app.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(API, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

const files = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (/^\/[a-z0-9]{16}$/.test(url.pathname)) return proxy(req, res, `/files${req.url}`);
  res.writeHead(404);
  res.end("Not found");
});

app.listen(APP_PORT, () => console.log(`App on http://localhost:${APP_PORT}`));
files.listen(FILES_PORT, () => console.log(`Files on http://localhost:${FILES_PORT}`));
