/**
 * Encryption at rest for Gemini OAuth tokens (AES-256-GCM).
 *
 * A sealed value is "v1.<iv>.<tag>.<ciphertext>", each part base64url, with
 * a fresh 12-byte IV every time. open() returns null for anything that was
 * not sealed with this key, including a value whose any part was changed;
 * it never throws.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(sealed: unknown, key: Buffer): string | null {
  if (typeof sealed !== "string") return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ct = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
