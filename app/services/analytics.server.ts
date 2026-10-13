import { Prisma } from "@prisma/client";
import db from "../db.server";
import { AUTOMATION_MINUTES_SAVED } from "../lib/automation";
import { fx, publicCurrency, type CurrencyContext } from "./currency.server";
import { eachDay, previousRange, type DateRange } from "../lib/range";

export type Range = { from: Date; to: Date };

const sum = (shopId: string, { from, to }: Range) =>
  Prisma.sql`"shopId" = ${shopId} AND "requestedAt" BETWEEN ${from} AND ${to}`;

export type Summary = {
  total: number;
  value: number;
  units: number;
  saved: number;
  requested: number;
  open: number;
  declined: number;
  closed: number;
  canceled: number;
  auto: number;
  closeTatHours: number | null;
  responseHours: number | null;
  automations: number;
  hoursSaved: number;
};

/** Headline numbers for one window. Called twice (current + previous) to get "vs previous period". */
export async function summarize(shopId: string, range: Range, cx: CurrencyContext): Promise<Summary> {
  const [[row], [resp], automations] = await Promise.all([
    db.$queryRaw<Omit<Summary, "responseHours" | "automations" | "hoursSaved">[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total,
             COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}), 0)::float8 AS value,
             COALESCE(SUM("totalQuantity"), 0)::int AS units,
             COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}) FILTER (WHERE status IN ('DECLINED', 'CANCELED')), 0)::float8 AS saved,
             (COUNT(*) FILTER (WHERE status = 'REQUESTED'))::int AS requested,
             (COUNT(*) FILTER (WHERE status = 'OPEN'))::int AS open,
             (COUNT(*) FILTER (WHERE status = 'DECLINED'))::int AS declined,
             (COUNT(*) FILTER (WHERE status = 'CLOSED'))::int AS closed,
             (COUNT(*) FILTER (WHERE status = 'CANCELED'))::int AS canceled,
             (COUNT(*) FILTER (WHERE "autoHandled"))::int AS auto,
             (AVG(EXTRACT(EPOCH FROM ("closedAt" - "requestedAt")) / 3600) FILTER (WHERE "closedAt" IS NOT NULL))::float8 AS "closeTatHours"
      FROM "ReturnRequest" WHERE ${sum(shopId, range)}`),
    // time from request to the first approve/decline we saw
    db.$queryRaw<{ h: number | null }[]>(Prisma.sql`
      SELECT AVG(EXTRACT(EPOCH FROM (e.at - r."requestedAt")) / 3600)::float8 AS h
      FROM "ReturnRequest" r
      JOIN LATERAL (
        SELECT MIN("createdAt") AS at FROM "ReturnEvent"
        WHERE "returnId" = r.id AND kind = 'WEBHOOK' AND title IN ('Status changed to OPEN', 'Status changed to DECLINED')
      ) e ON e.at IS NOT NULL
      WHERE r."shopId" = ${shopId} AND r."requestedAt" BETWEEN ${range.from} AND ${range.to}`),
    db.automationRun.count({ where: { shopId, ok: true, createdAt: { gte: range.from, lte: range.to } } }),
  ]);
  return {
    ...row,
    responseHours: resp?.h ?? null,
    automations,
    hoursSaved: (automations * AUTOMATION_MINUTES_SAVED) / 60,
  };
}

export type DayPoint = { day: string; count: number; approved: number; declined: number; value: number; saved: number };

async function daily(shopId: string, range: DateRange, cx: CurrencyContext): Promise<DayPoint[]> {
  const rows = await db.$queryRaw<DayPoint[]>(Prisma.sql`
    SELECT to_char(date_trunc('day', "requestedAt"), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS count,
           (COUNT(*) FILTER (WHERE status IN ('OPEN', 'CLOSED')))::int AS approved,
           (COUNT(*) FILTER (WHERE status = 'DECLINED'))::int AS declined,
           COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}), 0)::float8 AS value,
           COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}) FILTER (WHERE status IN ('DECLINED', 'CANCELED')), 0)::float8 AS saved
    FROM "ReturnRequest" WHERE ${sum(shopId, range)}
    GROUP BY 1`);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  // Fill every day so charts show quiet days as zero instead of skipping them.
  return eachDay(range).map((day) => byDay.get(day) ?? { day, count: 0, approved: 0, declined: 0, value: 0, saved: 0 });
}

const itemJoin = (shopId: string, { from, to }: Range) => Prisma.sql`
  FROM "ReturnItem" i JOIN "ReturnRequest" r ON r.id = i."returnId"
  WHERE r."shopId" = ${shopId} AND r."requestedAt" BETWEEN ${from} AND ${to}`;

export type ReasonRow = { reason: string; returns: number; units: number; value: number };
export type TopProduct = { title: string; variantTitle: string | null; sku: string | null; imageUrl: string | null; returns: number; units: number; value: number; topReason: string | null };

export async function topProducts(shopId: string, range: Range, cx: CurrencyContext, limit = 10) {
  return db.$queryRaw<TopProduct[]>(Prisma.sql`
    SELECT i.title, i."variantTitle", i.sku, MAX(i."imageUrl") AS "imageUrl",
           COUNT(DISTINCT i."returnId")::int AS returns,
           SUM(i.quantity)::int AS units,
           SUM(i.quantity * COALESCE(i."unitPrice", 0) * ${fx(cx, 'r."currency"')})::float8 AS value,
           (mode() WITHIN GROUP (ORDER BY i.reason)) AS "topReason"
    ${itemJoin(shopId, range)}
    GROUP BY i.title, i."variantTitle", i.sku
    ORDER BY value DESC, units DESC
    LIMIT ${limit}`);
}

export type Slice = { label: string; count: number; value: number };

export async function getAnalytics(shopId: string, range: DateRange, cx: CurrencyContext, geo: "province" | "city" = "province") {
  const prevRange = previousRange(range);
  const geoKey = Prisma.raw(geo === "city" ? "'city'" : "'province'"); // whitelisted literal, never user text
  const [current, previous, series, prevSeries, reasons, products, customers, categories, regions, payments] = await Promise.all([
    summarize(shopId, range, cx),
    summarize(shopId, prevRange, cx),
    daily(shopId, range, cx),
    daily(shopId, prevRange, cx),
    db.$queryRaw<ReasonRow[]>(Prisma.sql`
      SELECT COALESCE(i.reason, 'No reason given') AS reason,
             COUNT(DISTINCT i."returnId")::int AS returns,
             SUM(i.quantity)::int AS units,
             SUM(i.quantity * COALESCE(i."unitPrice", 0) * ${fx(cx, 'r."currency"')})::float8 AS value
      ${itemJoin(shopId, range)}
      GROUP BY 1 ORDER BY units DESC`),
    topProducts(shopId, range, cx, 10),
    db.$queryRaw<{ name: string | null; email: string | null; returns: number; value: number }[]>(Prisma.sql`
      SELECT MAX("customerName") AS name, MAX("customerEmail") AS email,
             COUNT(*)::int AS returns, COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}), 0)::float8 AS value
      FROM "ReturnRequest" WHERE ${sum(shopId, range)}
      GROUP BY COALESCE("customerEmail", "customerName", id)
      ORDER BY returns DESC, value DESC LIMIT 8`),
    db.$queryRaw<Slice[]>(Prisma.sql`
      SELECT COALESCE(NULLIF(p."productType", ''), 'Uncategorized') AS label,
             SUM(i.quantity)::int AS count,
             SUM(i.quantity * COALESCE(i."unitPrice", 0) * ${fx(cx, 'r."currency"')})::float8 AS value
      FROM "ReturnItem" i
      JOIN "ReturnRequest" r ON r.id = i."returnId"
      LEFT JOIN "Product" p ON p.id = i."productId"
      WHERE r."shopId" = ${shopId} AND r."requestedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY 1 ORDER BY count DESC`),
    db.$queryRaw<Slice[]>(
      Prisma.sql`
      SELECT COALESCE(NULLIF("shippingAddress"->>${geoKey}, ''), 'Unknown') AS label,
             COUNT(*)::int AS count, COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}), 0)::float8 AS value
      FROM "ReturnRequest" WHERE ${sum(shopId, range)}
      GROUP BY 1 ORDER BY count DESC, value DESC LIMIT 12`,
    ),
    db.$queryRaw<Slice[]>(Prisma.sql`
      SELECT CASE WHEN LOWER(COALESCE("paymentMethod", '')) ~ 'cod|cash' THEN 'Cash on delivery' ELSE 'Prepaid' END AS label,
             COUNT(*)::int AS count, COALESCE(SUM("returnValue" * ${fx(cx, '"currency"')}), 0)::float8 AS value
      FROM "ReturnRequest" WHERE ${sum(shopId, range)}
      GROUP BY 1 ORDER BY count DESC`),
  ]);

  return { currency: publicCurrency(cx), range, prevRange, current, previous, series, prevSeries, reasons, products, customers, categories, regions, payments };
}

/** Everything the home dashboard shows. */
export async function getDashboard(shopId: string, range: DateRange, cx: CurrencyContext) {
  const prevRange = previousRange(range);
  const staleCutoff = new Date(Date.now() - 10 * 86_400_000);
  const [current, previous, series, prevSeries, products, stale, pending, rules, events] = await Promise.all([
    summarize(shopId, range, cx),
    summarize(shopId, prevRange, cx),
    daily(shopId, range, cx),
    daily(shopId, prevRange, cx),
    topProducts(shopId, range, cx, 5),
    // all-time (not range-bound): approved returns that have sat open for over 10 days
    db.returnRequest.count({ where: { shopId, status: "OPEN", requestedAt: { lt: staleCutoff } } }),
    db.returnRequest.count({ where: { shopId, status: "REQUESTED" } }),
    db.automationRule.count({ where: { shopId, enabled: true } }),
    db.returnEvent.findMany({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { return: { select: { id: true, name: true } } },
    }),
  ]);
  return { currency: publicCurrency(cx), range, prevRange, current, previous, series, prevSeries, products, stale, pending, activeRules: rules, events };
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
