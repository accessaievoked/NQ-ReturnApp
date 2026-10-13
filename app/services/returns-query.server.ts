import { Prisma } from "@prisma/client";
import db from "../db.server";
import type { ReturnFilters } from "../lib/return-filters";
import { convert, type CurrencyContext } from "./currency.server";
import { exchangeStatusOf, refundStatusOf } from "../lib/return-meta";

const DAY = 86_400_000;

/** Translate filter state into a Prisma `where`. `skipStatus` lets us count each status tab under the other filters. */
export function buildReturnsWhere(shopId: string, f: ReturnFilters, cx: CurrencyContext, opts: { skipStatus?: boolean } = {}): Prisma.ReturnRequestWhereInput {
  const and: Prisma.ReturnRequestWhereInput[] = [];

  if (f.q) {
    and.push({
      OR: [
        { name: { contains: f.q, mode: "insensitive" } },
        { orderName: { contains: f.q, mode: "insensitive" } },
        { customerName: { contains: f.q, mode: "insensitive" } },
        { customerEmail: { contains: f.q, mode: "insensitive" } },
        { customerPhone: { contains: f.q, mode: "insensitive" } },
        { awb: { contains: f.q, mode: "insensitive" } },
        { items: { some: { OR: [{ title: { contains: f.q, mode: "insensitive" } }, { sku: { contains: f.q, mode: "insensitive" } }] } } },
      ],
    });
  }
  if (f.reason) and.push({ items: { some: { reason: f.reason } } });
  // Same rule as lib/automation.ts#isCOD: gateway names like "cash_on_delivery" / "cod" / "Cash on Delivery (COD)".
  const isCod: Prisma.ReturnRequestWhereInput = {
    OR: [{ paymentMethod: { contains: "cod", mode: "insensitive" } }, { paymentMethod: { contains: "cash", mode: "insensitive" } }],
  };
  if (f.payment === "COD") and.push(isCod);
  if (f.payment === "PREPAID") and.push({ OR: [{ paymentMethod: null }, { NOT: isCod }] });
  if (f.auto !== null) and.push({ autoHandled: f.auto });
  if (f.type === "EXCHANGE") and.push({ exchangeUnits: { gt: 0 } });
  if (f.type === "RETURN") and.push({ exchangeUnits: 0 });
  if (f.shipment) and.push({ shipmentStatus: f.shipment });
  // Refund status is derived (see lib/return-meta.ts#refundStatusOf); these clauses are its SQL twin.
  const refundable: Prisma.ReturnRequestWhereInput = { status: { notIn: ["DECLINED", "CANCELED"] } };
  const value = db.returnRequest.fields.returnValue;
  const plain = { ...refundable, exchangeUnits: 0 };
  if (f.refund === "NA") and.push({ OR: [{ status: { in: ["DECLINED", "CANCELED"] } }, { ...refundable, exchangeUnits: { gt: 0 }, refundedAmount: 0 }] });
  if (f.refund === "PENDING") and.push({ ...plain, refundedAmount: 0 });
  if (f.refund === "PARTIAL") and.push({ ...plain, refundedAmount: { gt: 0, lt: value } });
  if (f.refund === "REFUNDED") and.push({ OR: [{ ...plain, refundedAmount: { gt: 0, gte: value } }, { ...refundable, exchangeUnits: { gt: 0 }, refundedAmount: { gt: 0 } }] });

  const requestedAt: Prisma.DateTimeFilter = {};
  if (f.from) requestedAt.gte = new Date(`${f.from}T00:00:00Z`);
  if (f.to) requestedAt.lt = new Date(new Date(`${f.to}T00:00:00Z`).getTime() + DAY); // `to` is inclusive
  const returnValue: Prisma.DecimalFilter = {};
  // Min/max are typed in the *display* currency; returns are stored in the store currency, so convert the thresholds back.
  const toBase = (v: number) => Math.round(convert(v, cx.display, cx.base, cx.rates) * 100) / 100;
  if (f.minValue !== null) returnValue.gte = toBase(f.minValue);
  if (f.maxValue !== null) returnValue.lte = toBase(f.maxValue);

  return {
    shopId,
    ...(!opts.skipStatus && f.status ? { status: f.status } : {}),
    ...(Object.keys(requestedAt).length ? { requestedAt } : {}),
    ...(Object.keys(returnValue).length ? { returnValue } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

const ORDER: Record<ReturnFilters["sort"], Prisma.ReturnRequestOrderByWithRelationInput[]> = {
  newest: [{ requestedAt: "desc" }],
  oldest: [{ requestedAt: "asc" }],
  value_desc: [{ returnValue: "desc" }, { requestedAt: "desc" }],
  value_asc: [{ returnValue: "asc" }, { requestedAt: "desc" }],
};

const LIST_INCLUDE = {
  items: { select: { title: true, variantTitle: true, imageUrl: true, reason: true, quantity: true } },
} satisfies Prisma.ReturnRequestInclude;

/**
 * One page of returns plus everything the list UI needs: the total under the active filters,
 * page math, a per-status count for the tabs, and the distinct reasons for the reason dropdown.
 */
export async function listReturns(shopId: string, f: ReturnFilters, cx: CurrencyContext) {
  const where = buildReturnsWhere(shopId, f, cx);
  const [total, statusCounts, reasonRows] = await Promise.all([
    db.returnRequest.count({ where }),
    db.returnRequest.groupBy({ by: ["status"], where: buildReturnsWhere(shopId, f, cx, { skipStatus: true }), _count: true }),
    db.returnItem.groupBy({ by: ["reason"], where: { return: { shopId }, reason: { not: null } }, _count: true, orderBy: { _count: { reason: "desc" } } }),
  ]);

  const pages = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(f.page, pages); // out-of-range ?page= lands on the last page instead of an empty one
  const rows = await db.returnRequest.findMany({
    where,
    orderBy: ORDER[f.sort],
    skip: (page - 1) * f.pageSize,
    take: f.pageSize,
    include: LIST_INCLUDE,
  });

  const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count])) as Record<string, number>;
  return {
    // Decimal -> number: Prisma's Decimal class can't be serialized to the client by the loader.
    // `returnValue` stays in the order's own currency; `displayValue` is converted for the currency the page shows.
    rows: rows.map((r) => ({
      ...r,
      returnValue: Number(r.returnValue),
      orderTotal: r.orderTotal == null ? null : Number(r.orderTotal),
      displayValue: convert(Number(r.returnValue), r.currency ?? cx.base, cx.display, cx.rates),
      displayRefunded: convert(Number(r.refundedAmount), r.currency ?? cx.base, cx.display, cx.rates),
      refundStatus: refundStatusOf({ status: r.status, returnValue: Number(r.returnValue), refundedAmount: Number(r.refundedAmount), exchangeUnits: r.exchangeUnits }),
      exchangeStatus: exchangeStatusOf(r),
      refundedAmount: Number(r.refundedAmount),
    })),
    pagination: {
      total,
      page,
      pageSize: f.pageSize,
      pages,
      hasPrev: page > 1,
      hasNext: page < pages,
      from: total === 0 ? 0 : (page - 1) * f.pageSize + 1,
      to: Math.min(page * f.pageSize, total),
    },
    statusCounts: counts,
    allCount: Object.values(counts).reduce((a, b) => a + b, 0),
    reasons: reasonRows.map((r) => r.reason!).filter(Boolean),
  };
}

/** Same filters, no paging (capped) — feeds the CSV export. */
export async function exportReturns(shopId: string, f: ReturnFilters, cx: CurrencyContext, opts: { ids?: string[]; cap?: number } = {}) {
  return db.returnRequest.findMany({
    // an explicit selection wins over the filters
    where: opts.ids?.length ? { shopId, id: { in: opts.ids } } : buildReturnsWhere(shopId, f, cx),
    orderBy: ORDER[f.sort],
    take: opts.cap ?? 5000,
    include: LIST_INCLUDE,
  });
}
