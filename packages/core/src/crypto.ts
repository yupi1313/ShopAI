import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Encrypt secrets (AH tokens) at rest with AES-256-GCM. The key is derived
// from SESSION_SECRET so a stolen database file is useless on its own.
// Format: v1.<salt>.<iv>.<tag>.<ciphertext>, all base64url.

const VERSION = "v1";

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encryptSecret(plaintext: string, secret: string): string {
  if (!secret) throw new Error("SESSION_SECRET is required to encrypt secrets");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, salt.toString("base64url"), iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, secret: string): string {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error("unrecognised secret format");
  const [, saltB, ivB, tagB, dataB] = parts;
  const key = deriveKey(secret, Buffer.from(saltB!, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB!, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB!, "base64url")), decipher.final()]).toString("utf8");
}
