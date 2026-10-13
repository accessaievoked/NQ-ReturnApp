import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Shiprocket logins are stored encrypted (AES-256-GCM), never in plain text. The key comes from APP_ENCRYPTION_KEY;
// until you set a dedicated one it falls back to a key derived from SHOPIFY_API_SECRET so it works out of the box.
// Changing the key makes stored credentials unreadable — the merchant simply reconnects.
const key = () =>
  createHash("sha256")
    .update(`eco-return:${process.env.APP_ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET || ""}`)
    .digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString("hex");

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
