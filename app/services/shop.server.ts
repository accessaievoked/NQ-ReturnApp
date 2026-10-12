import db from "../db.server";

/** Returns the Shop row for a domain, creating it on first sight (install / first request). */
export async function ensureShop(domain: string) {
  return db.shop.upsert({
    where: { domain },
    create: { domain },
    update: { uninstalledAt: null },
  });
}

export async function markShopUninstalled(domain: string) {
  await db.shop.updateMany({
    where: { domain },
    data: { uninstalledAt: new Date() },
  });
}
