import db from "../db.server";
import type { EmailEvent } from "../lib/email-defaults";
import { escapeHtml, type Vars } from "../lib/email-template";
import { trackingLink } from "../lib/courier-status";
import { fmtMoney } from "../lib/format";
import { sendEmail } from "./email.server";

// Turns "something happened to a return / exchange request" into a customer email. Every function is fire-and-forget
// safe (never throws) and de-duplicated per event + return, so webhook re-deliveries don't spam customers.

type Line = { title: string; variantTitle?: string | null; quantity: number };

const lines = (rows: Line[]) =>
  rows.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 14px">${rows
        .map(
          (r) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid #eee"><strong>${escapeHtml(r.title)}</strong>${r.variantTitle && r.variantTitle !== "Default Title" ? ` — ${escapeHtml(r.variantTitle)}` : ""} × ${r.quantity}</td></tr>`,
        )
        .join("")}</table>`
    : "";

const first = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "there";

/** Email about a return that exists in Shopify (and so in our ReturnRequest table). */
export async function notifyReturn(shopDomain: string, event: EmailEvent, returnId: string, extras: Vars = {}) {
  try {
    const ret = await db.returnRequest.findUnique({ where: { id: returnId }, include: { items: true, shop: true } });
    if (!ret) return;
    const replacement = (Array.isArray(ret.exchangeItems) ? ret.exchangeItems : []) as unknown as Line[];
    const vars: Vars = {
      customer_name: ret.customerName ?? "",
      customer_first_name: first(ret.customerName),
      order_name: ret.orderName ?? "",
      reference: ret.name,
      items: lines(ret.items),
      replacement: lines(replacement),
      reason: ret.items[0]?.reason ?? "",
      note: ret.declineNote ?? ret.declineReason ?? "",
      tracking_number: ret.awb ?? "",
      tracking_url: ret.awb ? trackingLink(ret.awb) : "",
      carrier: ret.carrier ?? "",
      pickup_date: ret.pickupScheduledAt ? ret.pickupScheduledAt.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" }) : "",
      refund_amount: ret.refundedAmount && Number(ret.refundedAmount) > 0 ? fmtMoney(Number(ret.refundedAmount), ret.currency) : "",
      ...extras,
    };
    await sendEmail({ shop: { id: ret.shopId, domain: shopDomain }, event, to: ret.customerEmail, vars, dedupeKey: `${event}:${ret.id}` });
  } catch (err) {
    console.error(`notifyReturn(${event}) failed`, err);
  }
}

/** Email about an exchange request that is still waiting on the merchant (no Shopify return yet). */
export async function notifyExchangeRequest(shopDomain: string, event: EmailEvent, requestId: string, extras: Vars = {}) {
  try {
    const req = await db.exchangeRequest.findUnique({ where: { id: requestId } });
    if (!req) return;
    const items = req.items as unknown as (Line & { reasonName?: string | null })[];
    const vars: Vars = {
      customer_name: req.customerName ?? "",
      customer_first_name: first(req.customerName ?? req.customerEmail.split("@")[0]),
      order_name: req.orderName,
      reference: req.code,
      items: lines(items),
      replacement: lines(req.replacements as unknown as Line[]),
      reason: items[0]?.reasonName ?? "",
      note: req.declineNote ?? "",
      ...extras,
    };
    await sendEmail({ shop: { id: req.shopId, domain: shopDomain }, event, to: req.customerEmail, vars, dedupeKey: `${event}:${req.id}` });
  } catch (err) {
    console.error(`notifyExchangeRequest(${event}) failed`, err);
  }
}

/** Run a notification in the background so it never slows (or fails) the request that triggered it. */
export const inBackground = (p: Promise<unknown>) => void p.catch((e) => console.error("Background notification failed", e));
