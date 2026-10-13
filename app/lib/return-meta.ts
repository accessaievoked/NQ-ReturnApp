// Display metadata for the derived return states (refund / exchange / shipment). Client-safe and shared by the
// list, the detail page, the CSV export and the filters so the labels never drift apart.

import type { Tone } from "./format";

export type RefundStatus = "PENDING" | "PARTIAL" | "REFUNDED" | "NA";

export const REFUND_META: Record<RefundStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Pending", tone: "caution" },
  PARTIAL: { label: "Partial", tone: "warning" },
  REFUNDED: { label: "Refunded", tone: "success" },
  NA: { label: "N/A", tone: "neutral" },
};

/**
 * Declined/canceled returns never refund. A plain return compares what Shopify refunded with the value of the items.
 * An exchange has no refund due unless money was left over, so it reads N/A until a leftover refund exists.
 */
export function refundStatusOf(r: { status: string; returnValue: number; refundedAmount: number; exchangeUnits?: number }): RefundStatus {
  if (r.status === "DECLINED" || r.status === "CANCELED") return "NA";
  if ((r.exchangeUnits ?? 0) > 0) return r.refundedAmount > 0 ? "REFUNDED" : "NA";
  if (r.refundedAmount > 0) return r.refundedAmount + 0.005 >= r.returnValue ? "REFUNDED" : "PARTIAL";
  return "PENDING";
}

export type ExchangeStatus = "PENDING" | "DONE";

export function exchangeStatusOf(r: { exchangeUnits: number; exchangeDone: number }): ExchangeStatus | null {
  if (r.exchangeUnits <= 0) return null;
  return r.exchangeDone >= r.exchangeUnits ? "DONE" : "PENDING";
}

export const SHIPMENT_META: Record<string, { label: string; tone: Tone; step: number }> = {
  AWAITING_SHIPMENT: { label: "Awaiting shipment", tone: "caution", step: 0 },
  IN_TRANSIT: { label: "In transit", tone: "info", step: 1 },
  RECEIVED: { label: "Received", tone: "success", step: 2 },
  CANCELED: { label: "Canceled", tone: "neutral", step: -1 },
};

export const SHIPMENTS = Object.keys(SHIPMENT_META);

/** A public tracking link when we know the carrier; otherwise a plain search so the merchant can still click through. */
export const trackingUrl = (awb: string, custom?: string | null) => custom || `https://www.google.com/search?q=${encodeURIComponent(`track ${awb}`)}`;
