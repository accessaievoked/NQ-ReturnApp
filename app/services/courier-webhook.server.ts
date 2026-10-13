import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { courierStateOf, isCourierException, labelFromWebhook, type CourierState } from "../lib/courier-status";
import { safeEqual } from "./crypto.server";
import { addEvent, completeExchange, issueRefund } from "./returns.server";
import { inBackground, notifyReturn } from "./notify.server";
import { isCOD } from "../lib/automation";

// Receives Shiprocket's tracking webhook (docs: POST + JSON, optional security token sent as the `x-api-key` header, and
// the endpoint must answer HTTP 200). Every tracking event for *any* shipment on the merchant's Shiprocket account lands
// here, so most calls are forward orders we don't care about: those are acknowledged with 200 and ignored.

type Scan = { date?: string; status?: string; activity?: string; location?: string; "sr-status-label"?: string };

export type CourierWebhookBody = {
  awb?: string | number;
  courier_name?: string;
  current_status?: string;
  shipment_status?: string;
  order_id?: string;
  sr_order_id?: string | number;
  is_return?: number | string;
  scans?: Scan[];
};

const RANK: Record<CourierState, number> = { AWAITING_SHIPMENT: 0, IN_TRANSIT: 1, RECEIVED: 2, CANCELED: -1 };
const OUR_PREFIX = "ecoreturn_";

export type WebhookResult = { status: number; message: string };

export async function handleCourierWebhook(publicId: string, token: string | null, body: CourierWebhookBody): Promise<WebhookResult> {
  const conn = await db.shiprocketConnection.findUnique({ where: { publicId }, include: { shop: { select: { domain: true } } } });
  // Same answer for "no such connection" and "wrong token" so the URL can't be probed.
  if (!conn || !conn.connected || !safeEqual(token ?? "", conn.webhookSecret)) return { status: 401, message: "unauthorized" };

  await db.shiprocketConnection.update({ where: { id: conn.id }, data: { lastWebhookAt: new Date() } });

  const awb = body.awb != null ? String(body.awb) : null;
  const ours = typeof body.order_id === "string" && body.order_id.startsWith(OUR_PREFIX) ? body.order_id.slice(OUR_PREFIX.length) : null;
  const srOrder = body.sr_order_id != null ? String(body.sr_order_id) : null;

  const ret = await db.returnRequest.findFirst({
    where: {
      shopId: conn.shopId,
      OR: [...(ours ? [{ id: ours }] : []), ...(awb ? [{ awb }] : []), ...(srOrder ? [{ srOrderId: srOrder }] : [])],
    },
  });
  if (!ret) return { status: 200, message: "ignored: not one of our return shipments" };

  const label = labelFromWebhook(body);
  const state = courierStateOf(label);
  const exception = isCourierException(label);
  const scans = (body.scans ?? [])
    .slice(-40)
    .map((s) => ({ date: s.date ?? null, status: s["sr-status-label"] && s["sr-status-label"] !== "NA" ? s["sr-status-label"] : null, activity: s.activity ?? null, location: s.location ?? null }));

  const current = (ret.shipmentStatus ?? null) as CourierState | null;
  const labelChanged = !!label && label !== ret.carrierStatus;
  const scansChanged = JSON.stringify(scans) !== JSON.stringify(ret.trackingScans ?? null);
  if (!labelChanged && !scansChanged) return { status: 200, message: "no change" };

  // Never move the shipment backwards (a late duplicate of an older event), and never undo a cancel/receipt.
  const moves = state !== null && current !== "CANCELED" && (current === null || state === "CANCELED" || RANK[state] > RANK[current]);
  const delivered = state === "RECEIVED" && moves;
  // If the merchant wants to confirm receipt themselves, "delivered" is recorded but the shipment stays in transit.
  const nextShipment: CourierState | null = moves ? (delivered && !conn.autoReceive ? "IN_TRANSIT" : state) : null;

  const latest = scans.at(-1);
  const data: Prisma.ReturnRequestUpdateInput = {
    carrierStatus: label || ret.carrierStatus,
    trackingScans: scans as unknown as Prisma.InputJsonValue,
    ...(awb && awb !== ret.awb ? { awb } : {}),
    ...(body.courier_name ? { carrier: body.courier_name } : {}),
    ...(nextShipment ? { shipmentStatus: nextShipment } : {}),
  };
  await db.returnRequest.update({ where: { id: ret.id }, data });

  if (labelChanged) {
    await addEvent(ret.shopId, ret.id, {
      kind: "WEBHOOK",
      title: exception ? `Courier issue: ${label}` : `Courier: ${label}`,
      detail: [latest?.activity, latest?.location].filter(Boolean).join(" · ") || undefined,
      actor: "Shiprocket",
    });
  }

  if (delivered) {
    if (!conn.autoReceive) {
      await addEvent(ret.shopId, ret.id, { kind: "ACTION", title: "Delivered to your warehouse", detail: "Waiting for you to mark it as received.", actor: "Shiprocket" });
    } else {
      await addEvent(ret.shopId, ret.id, { kind: "ACTION", title: "Marked as received", detail: "The courier delivered the return to your warehouse.", actor: "Shiprocket" });
      inBackground(notifyReturn(conn.shop.domain, "return_delivered", ret.id));
      // Fire-and-forget: the refund talks to Shopify and must not hold up our 200 reply to Shiprocket.
      if (conn.autoRefund) void runAutoRefund(conn.shop.domain, ret.id).catch((e) => console.error("Auto refund failed", e));
    }
  }
  return { status: 200, message: "ok" };
}

/** Pays out a received return with no click: refund for prepaid returns, completion for exchanges. COD is left to the merchant. */
export async function runAutoRefund(shopDomain: string, returnId: string) {
  const ret = await db.returnRequest.findUnique({ where: { id: returnId } });
  if (!ret || ret.status !== "OPEN") return;
  const actor = "Automation: refund on receipt";
  try {
    if (ret.exchangeUnits > 0) {
      const r = await completeExchange(shopDomain, ret.id, actor);
      if (!r.ok) await addEvent(ret.shopId, ret.id, { kind: "ACTION", title: "Automatic exchange completion failed", detail: r.error, actor });
      return;
    }
    if (isCOD(ret.paymentMethod)) {
      await addEvent(ret.shopId, ret.id, { kind: "ACTION", title: "Automatic refund skipped", detail: "Cash-on-delivery order: there is no payment to refund automatically. Refund it manually.", actor });
      return;
    }
    const r = await issueRefund(shopDomain, ret.id, actor);
    if (!r.ok) await addEvent(ret.shopId, ret.id, { kind: "ACTION", title: "Automatic refund failed", detail: r.error, actor });
  } catch (err) {
    await addEvent(ret.shopId, ret.id, { kind: "ACTION", title: "Automatic refund failed", detail: err instanceof Error ? err.message : "Unknown error", actor });
  }
}
