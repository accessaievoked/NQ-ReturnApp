// Maps Shiprocket's tracking statuses onto the shipment states this app shows. Pure and client-safe.
//
// Shiprocket's webhook sends a status *label* ("IN TRANSIT", "PICKED UP", "DELIVERED" …) alongside numeric ids. The ids
// aren't published as a table, so we match on the labels, which are what its docs and samples show. Anything we don't
// recognise returns null: it is logged on the return's timeline but never changes the shipment state.

export type CourierState = "AWAITING_SHIPMENT" | "IN_TRANSIT" | "RECEIVED" | "CANCELED";

const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** Problems that need a human (shown as a warning event) but don't move the shipment forward or back. */
export const isCourierException = (label: string | null | undefined) => /EXCEPTION|UNDELIVERED|NDR|LOST|DAMAGED|FAILED|REJECTED|RTO/.test(norm(label));

export function courierStateOf(label: string | null | undefined): CourierState | null {
  const s = norm(label);
  if (!s) return null;
  // RTO on a *reverse* shipment means the parcel bounced back to the customer, so it is never "received".
  if (isCourierException(s)) return null;
  if (/CANCEL/.test(s)) return "CANCELED";
  // "DELIVERED" means the parcel reached its destination — for a reverse shipment that is the merchant's warehouse.
  if (/(^|\s)DELIVERED$/.test(s)) return "RECEIVED";
  if (/PICKED UP|SHIPPED|IN TRANSIT|OUT FOR DELIVERY|REACHED|HUB|DISPATCH|FACILITY/.test(s)) return "IN_TRANSIT";
  if (/RETURN PENDING|PICKUP (SCHEDULED|GENERATED|RESCHEDULED|QUEUED|BOOKED)|OUT FOR PICKUP|MANIFEST|AWB ASSIGNED|READY TO SHIP|PICKUP/.test(s) || s === "NEW") return "AWAITING_SHIPMENT";
  return null;
}

/** Pick the most informative label from a webhook body: the shipment status, falling back to the latest scan. */
export function labelFromWebhook(b: { current_status?: string; shipment_status?: string; scans?: { "sr-status-label"?: string; activity?: string }[] }): string {
  const direct = b.current_status || b.shipment_status;
  if (direct) return direct;
  const last = [...(b.scans ?? [])].reverse().find((s) => s["sr-status-label"] && s["sr-status-label"] !== "NA");
  return last?.["sr-status-label"] ?? last?.activity ?? "";
}

/** Public Shiprocket tracking page for an AWB — what customers get in emails. */
export const trackingLink = (awb: string) => `https://shiprocket.co/tracking/${awb}`;
