import { randomInt } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { HttpError } from "./auth.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_LENGTH = 16;
const SNIFF_BYTES = 64;

export const KEY_PATTERN = /^[a-z0-9]{16}$/;

export function newKey() {
  let key = "";
  for (let i = 0; i < KEY_LENGTH; i++) key += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return key;
}

// What the first bytes say a file is. The name and the type the browser
// claims don't count. Anything not recognised is kept as a plain download.
export function sniff(head) {
  const ascii = (from, to) => head.subarray(from, to).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return "audio/mp4";
    // HEIC and AVIF photos: most browsers can't show them, so they're files.
    if (/^(heic|heix|hevc|mif1|msf1|avif)/.test(brand)) return null;
    return "video/mp4";
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

// Receives one file, streamed to a hidden temp name and renamed into place
// once it's complete. Form fields sent before the file come back as `fields`.
export function receiveFile(req, { dir, maxBytes, maxMb }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 8192 } });
    } catch {
      reject(new HttpError(400, "Expected multipart/form-data"));
      return;
    }

    const fields = {};
    let job = null;
    let failure = null;

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (_field, stream, info) => {
      const name = (info.filename || "file").replace(/[\x00-\x1f\x7f/\\]/g, "").slice(0, 200) || "file";
      const key = newKey();
      const temp = path.join(dir, `.${key}.part`);
      let head = Buffer.alloc(0);
      let size = 0;
      stream.on("data", (chunk) => {
        if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
        size += chunk.length;
      });
      job = pipeline(stream, createWriteStream(temp))
        .then(async () => {
          if (stream.truncated) throw new HttpError(413, `${name} is larger than ${maxMb} MB`);
          if (size === 0) throw new HttpError(400, `${name} is empty`);
          await rename(temp, path.join(dir, key));
          return { key, name, size, mime: sniff(head) };
        })
        .catch(async (err) => {
          await rm(temp, { force: true });
          throw err;
        });
      // Handled in finish(); this stops Node treating an early failure as unhandled.
      job.catch(() => {});
    });

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      if (!job) return reject(failure ?? new HttpError(400, "No file in the upload"));
      try {
        const file = await job;
        if (failure) {
          await rm(path.join(dir, file.key), { force: true });
          return reject(failure);
        }
        resolve({ ...file, fields });
      } catch (err) {
        reject(failure ?? err);
      }
    };

    bb.on("filesLimit", () => (failure ??= new HttpError(413, "One file per upload")));
    // A dropped connection surfaces as a parser error, not a close.
    bb.on("error", () => {
      failure ??= new HttpError(400, "Upload was interrupted");
      finish();
    });
    bb.on("close", finish);

    req.pipe(bb);
  });
}
