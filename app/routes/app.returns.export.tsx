import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { exportReturns } from "../services/returns-query.server";
import { parseReturnFilters } from "../lib/return-filters";
import { exchangeStatusOf, refundStatusOf, REFUND_META, SHIPMENT_META } from "../lib/return-meta";
import { convert, currencyContext } from "../services/currency.server";
import { STATUS_META } from "../lib/format";

// Resource route (no UI). The Returns page fetches it and turns the JSON into a CSV download in the browser —
// going through fetch keeps the embedded-app session token attached, which a plain <a download> link would not.
//   ?ids=a,b,c   -> exactly those returns (the ticked rows)
//   ?scope=all   -> every return, ignoring filters
//   otherwise    -> everything matching the current filters (not just the visible page)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const sp = new URL(request.url).searchParams;
  const ids = sp.get("ids")?.split(",").filter(Boolean).slice(0, 500);
  const filters = sp.get("scope") === "all" ? { ...parseReturnFilters(new URLSearchParams()), cur: parseReturnFilters(sp).cur } : parseReturnFilters(sp);
  const cx = await currencyContext(shop, filters.cur);
  const rows = await exportReturns(shop.id, filters, cx, { ids });
  const money = (n: number, from: string | null) => Math.round(convert(n, from ?? cx.base, cx.display, cx.rates) * 100) / 100;

  return {
    rows: rows.map((r) => {
      const value = Number(r.returnValue);
      const refunded = Number(r.refundedAmount);
      const refund = refundStatusOf({ status: r.status, returnValue: value, refundedAmount: refunded, exchangeUnits: r.exchangeUnits });
      const exchange = exchangeStatusOf(r);
      return {
        return: r.name,
        order: r.orderName ?? "",
        type: r.exchangeUnits > 0 ? "Exchange" : "Return",
        status: STATUS_META[r.status]?.label ?? r.status,
        requestedAt: r.requestedAt.toISOString(),
        customer: r.customerName ?? "",
        email: r.customerEmail ?? "",
        phone: r.customerPhone ?? "",
        payment: r.paymentMethod ?? "",
        units: r.items.reduce((n, i) => n + i.quantity, 0),
        reasons: [...new Set(r.items.map((i) => i.reason).filter(Boolean))].join("; "),
        replacement: ((r.exchangeItems as { title: string; variantTitle: string | null; quantity: number }[] | null) ?? []).map((e) => `${e.title}${e.variantTitle ? ` (${e.variantTitle})` : ""} x${e.quantity}`).join("; "),
        products: r.items.map((i) => `${i.title}${i.variantTitle ? ` (${i.variantTitle})` : ""} x${i.quantity}`).join("; "),
        // both the order's own money and the converted figure, so the sheet is auditable
        currency: r.currency ?? cx.base,
        returnValue: value,
        [`returnValue_${cx.display}`]: money(value, r.currency),
        refundStatus: REFUND_META[refund].label,
        refunded: refunded,
        [`refunded_${cx.display}`]: money(refunded, r.currency),
        exchangeStatus: exchange ? (exchange === "DONE" ? "Complete" : "Pending") : "",
        shipmentStatus: r.shipmentStatus ? SHIPMENT_META[r.shipmentStatus]?.label ?? r.shipmentStatus : "",
        carrier: r.carrier ?? "",
        awb: r.awb ?? "",
        handledBy: r.autoHandled ? "Automation" : "Merchant",
      };
    }),
  };
};
