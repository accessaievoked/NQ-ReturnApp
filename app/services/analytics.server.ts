import { Prisma } from "@prisma/client";
import db from "../db.server";

export type Range = { from: Date; to: Date };

export function rangeFromDays(days: number): Range {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from, to };
}

export async function getOverview(shopId: string, { from, to }: Range) {
  const where = { shopId, requestedAt: { gte: from, lte: to } };

  const [byStatus, itemAgg, daily, reasons] = await Promise.all([
    db.returnRequest.groupBy({ by: ["status"], where, _count: true }),
    db.returnItem.aggregate({
      where: { return: where },
      _sum: { quantity: true },
    }),
    db.$queryRaw<{ day: Date; count: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', "requestedAt") AS day, COUNT(*) AS count
      FROM "ReturnRequest"
      WHERE "shopId" = ${shopId} AND "requestedAt" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 1`),
    db.returnItem.groupBy({
      by: ["reason"],
      where: { return: where },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
    }),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number>;
  const total = byStatus.reduce((n, s) => n + s._count, 0);
  return {
    total,
    counts,
    itemsReturned: itemAgg._sum.quantity ?? 0,
    daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), count: Number(d.count) })),
    reasons: reasons.map((r) => ({ reason: r.reason ?? "No reason given", quantity: r._sum.quantity ?? 0 })),
  };
}

export type ProductRow = {
  id: string;
  title: string;
  imageUrl: string | null;
  status: string | null;
  vendor: string | null;
  variants: number;
  returned: number;
  returns: number;
  topReason: string | null;
};

/** All synced products with their return totals for the period (zero if never returned), most-returned first. */
export async function getProductsWithReturns(
  shopId: string,
  { from, to }: Range,
  opts: { q?: string; page?: number; pageSize?: number } = {},
) {
  const pageSize = opts.pageSize ?? 25;
  const offset = ((opts.page ?? 1) - 1) * pageSize;
  const like = `%${opts.q ?? ""}%`;

  const [rows, total] = await Promise.all([
    db.$queryRaw<(Omit<ProductRow, "variants" | "returned" | "returns"> & { variants: bigint; returned: bigint; returns: bigint })[]>(Prisma.sql`
      WITH items AS (
        SELECT i."productId" AS pid, i."quantity", i."returnId", i."reason"
        FROM "ReturnItem" i
        JOIN "ReturnRequest" r ON r.id = i."returnId"
        WHERE r."shopId" = ${shopId} AND r."requestedAt" BETWEEN ${from} AND ${to}
          AND i."productId" IS NOT NULL
      ),
      agg AS (
        SELECT pid, SUM("quantity") AS returned, COUNT(DISTINCT "returnId") AS returns
        FROM items GROUP BY pid
      ),
      reasons AS (
        SELECT pid, reason,
               ROW_NUMBER() OVER (PARTITION BY pid ORDER BY SUM("quantity") DESC) AS rn
        FROM items WHERE reason IS NOT NULL GROUP BY pid, reason
      )
      SELECT p.id, p.title, p."imageUrl", p.status, p.vendor,
             (SELECT COUNT(*) FROM "Variant" v WHERE v."productId" = p.id) AS variants,
             COALESCE(a.returned, 0) AS returned,
             COALESCE(a.returns, 0) AS returns,
             (SELECT rs.reason FROM reasons rs WHERE rs.pid = p.id AND rs.rn = 1) AS "topReason"
      FROM "Product" p
      LEFT JOIN agg a ON a.pid = p.id
      WHERE p."shopId" = ${shopId} AND p.title ILIKE ${like}
      ORDER BY returned DESC, p.title
      LIMIT ${pageSize} OFFSET ${offset}`),
    db.product.count({ where: { shopId, title: { contains: opts.q ?? "", mode: "insensitive" } } }),
  ]);

  return {
    total,
    pages: Math.ceil(total / pageSize),
    rows: rows.map((r) => ({
      ...r,
      variants: Number(r.variants),
      returned: Number(r.returned),
      returns: Number(r.returns),
    })) as ProductRow[],
  };
}
