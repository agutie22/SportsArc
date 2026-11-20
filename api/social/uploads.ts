/**
 * Image uploads for posts, avatars and profile covers.
 *
 * Files land on local disk under data/uploads/ (gitignored) and are served
 * back at /uploads/<uuid>.<ext>. That is a single-instance setup: move to
 * object storage (S3/R2) before running more than one server.
 *
 * The type is decided by the file's magic bytes, never the client's
 * Content-Type, and the stored name is always a server-generated uuid, so
 * nothing the client sends ends up in a path.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { fail, type Failure } from "../failure.js";

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_DIR = join(fileURLToPath(import.meta.url), "..", "..", "..", "data", "uploads");

const NAME_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const URL_RE = /^\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/;

export const UPLOAD_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function sniff(buf: Buffer): "jpg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

/** Read a raw request body, giving up as soon as it passes the size cap. */
function readCapped(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

export async function saveUpload(req: IncomingMessage): Promise<{ ok: true; url: string } | Failure> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > UPLOAD_MAX_BYTES) return fail("TOO_LARGE", "Images are limited to 5 MB.");

  const buf = await readCapped(req, UPLOAD_MAX_BYTES);
  if (!buf) return fail("TOO_LARGE", "Images are limited to 5 MB.");
  if (buf.length === 0) return fail("VALIDATION_ERROR", "No file received.");

  const ext = sniff(buf);
  if (!ext) return fail("UNSUPPORTED_TYPE", "Only JPEG, PNG and WebP images are supported.");

  const name = `${randomUUID()}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, name), buf);
  return { ok: true, url: `/uploads/${name}` };
}

export async function readUpload(name: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!NAME_RE.test(name)) return null;
  try {
    const data = await readFile(join(UPLOAD_DIR, name));
    return { data, mime: UPLOAD_MIME[name.split(".").pop() ?? ""] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** True when the value is a /uploads/... URL this server actually stored. */
export async function isStoredUpload(url: unknown): Promise<boolean> {
  if (typeof url !== "string") return false;
  const m = URL_RE.exec(url);
  if (!m) return false;
  try {
    return (await stat(join(UPLOAD_DIR, m[1]))).isFile();
  } catch {
    return false;
  }
}
