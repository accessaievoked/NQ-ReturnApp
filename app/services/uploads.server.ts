import { createHmac, timingSafeEqual } from "node:crypto";
import db from "../db.server";

// Photos customers attach on the return form.
//  - The browser resizes each photo to a few hundred KB first; the server re-checks type, magic bytes and size.
//  - They are stored in Postgres (PortalUpload) and served from /media/<id>?s=<signature>. The id is random and the
//    signature is an HMAC of it with the app secret, so a URL can't be guessed or edited — but it can be shared, which is
//    what lets an <img> tag work inside the embedded admin (image requests carry no Shopify session).
//  - An upload that is never attached to a request is deleted after a day.

export const MAX_BYTES = 700 * 1024;
export const MAX_PHOTOS_PER_ITEM = 3;
const MAX_UNCLAIMED_PER_SHOP = 400;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export class UploadError extends Error {}

const secret = () => process.env.SHOPIFY_API_SECRET || "";
const sign = (id: string) => createHmac("sha256", secret()).update(`media:${id}`).digest("hex").slice(0, 32);

export const mediaPath = (id: string) => `/media/${id}?s=${sign(id)}`;

export function verifyMediaSig(id: string, s: string | null): boolean {
  if (!s || s.length !== 32) return false;
  const a = Buffer.from(sign(id));
  const b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Trust the file's own bytes, not the type the browser claims. */
function sniff(buf: Buffer): string | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function saveUpload(shopId: string, base64: string, claimedMime: string) {
  if (!ALLOWED.has(claimedMime)) throw new UploadError("Only JPEG, PNG or WebP photos are accepted.");
  if (base64.length > MAX_BYTES * 1.4) throw new UploadError("That photo is too large. Try a smaller one.");
  const buf = Buffer.from(base64, "base64");
  if (!buf.length || buf.length > MAX_BYTES) throw new UploadError("That photo is too large. Try a smaller one.");
  const mime = sniff(buf);
  if (!mime) throw new UploadError("That file doesn't look like a photo.");

  // housekeeping: forget photos nobody attached to a request, and stop one shop's form being used as free storage
  if (Math.random() < 0.15) await db.portalUpload.deleteMany({ where: { claimed: false, createdAt: { lt: new Date(Date.now() - 24 * 3_600_000) } } });
  if ((await db.portalUpload.count({ where: { shopId, claimed: false } })) >= MAX_UNCLAIMED_PER_SHOP) throw new UploadError("Too many uploads right now. Please try again later.");

  const row = await db.portalUpload.create({ data: { shopId, mime, size: buf.length, data: buf } });
  return { id: row.id, path: mediaPath(row.id) };
}

/** Check (without consuming) that these upload ids exist, belong to the shop and are unused. */
export async function checkUploads(shopId: string, ids: string[]) {
  if (!ids.length) return;
  const unique = [...new Set(ids)];
  const found = await db.portalUpload.count({ where: { shopId, claimed: false, id: { in: unique } } });
  if (found !== unique.length) throw new UploadError("One of your photos expired. Please add it again.");
}

/** Mark the uploads as used and return their signed URLs, in the order given. */
export async function claimUploads(shopId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  await db.portalUpload.updateMany({ where: { shopId, id: { in: unique } }, data: { claimed: true } });
  return ids.map(mediaPath);
}

export async function readUpload(id: string) {
  return db.portalUpload.findUnique({ where: { id }, select: { mime: true, data: true, size: true } });
}
