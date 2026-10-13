import type { Prisma, ShiprocketConnection } from "@prisma/client";
import db from "../db.server";
import { decrypt, encrypt, randomToken } from "./crypto.server";
import { convert, getRates } from "./currency.server";
import { addEvent, saveTracking } from "./returns.server";
import { ensureShop } from "./shop.server";
import { inBackground, notifyReturn } from "./notify.server";

// Shiprocket integration, built from https://apidocs.shiprocket.in :
//   POST /auth/login                                   -> JWT (valid 10 days)
//   POST /shipments/create/return-shipment             -> "Wrapper API / Return": creates the return order, assigns an AWB
//                                                          and schedules the reverse pickup in ONE call
//   POST /orders/cancel/shipment/awbs                  -> cancel a booked pickup
//   GET  /account/details/wallet-balance               -> used to prove the credentials work
// Tracking comes back by webhook (see courier-webhook.server.ts), not by polling.

const BASE = "https://apiv2.shiprocket.in/v1/external";
const TOKEN_REFRESH_MARGIN_MS = 24 * 3_600_000; // refresh when less than a day is left
const TOKEN_LIFETIME_MS = 9 * 24 * 3_600_000; // docs say 10 days; assume 9 to stay safe

export class ShiprocketError extends Error {}

type Json = Record<string, unknown>;

/** Turns Shiprocket's error bodies ({ message, errors: { field: [..] } }) into one readable sentence. */
function describeError(body: Json | null, status: number): string {
  const message = typeof body?.message === "string" ? body.message : `Shiprocket returned HTTP ${status}`;
  const errors = body?.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, unknown>).flat().map(String) : [];
  return errors.length ? `${message} (${errors.join("; ")})` : message;
}

async function rawCall(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json().catch(() => null)) as Json | null;
  return { res, body };
}

/** Public id + webhook secret are created once per shop and never change unless the merchant regenerates them. */
export async function ensureConnection(shopId: string) {
  const existing = await db.shiprocketConnection.findUnique({ where: { shopId } });
  if (existing) return existing;
  return db.shiprocketConnection.create({ data: { shopId, publicId: randomToken(8), webhookSecret: randomToken(24) } });
}

async function login(email: string, password: string): Promise<string> {
  const { res, body } = await rawCall("/auth/login", { method: "POST", body: { email, password } });
  const token = typeof body?.token === "string" ? body.token : null;
  if (!res.ok || !token) throw new ShiprocketError(describeError(body, res.status) || "Shiprocket rejected the login");
  return token;
}

async function getToken(conn: ShiprocketConnection, force = false): Promise<string> {
  const fresh = conn.tokenEnc && conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS;
  if (fresh && !force) return decrypt(conn.tokenEnc!);
  if (!conn.email || !conn.passwordEnc) throw new ShiprocketError("Shiprocket is not connected.");
  const token = await login(conn.email, decrypt(conn.passwordEnc));
  await db.shiprocketConnection.update({ where: { id: conn.id }, data: { tokenEnc: encrypt(token), tokenExpiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS) } });
  return token;
}

/** Authenticated call; one automatic re-login if the cached token was rejected. */
async function call(conn: ShiprocketConnection, path: string, init: { method?: string; body?: unknown } = {}) {
  let token = await getToken(conn);
  let { res, body } = await rawCall(path, { ...init, token });
  if (res.status === 401) {
    token = await getToken(conn, true);
    ({ res, body } = await rawCall(path, { ...init, token }));
  }
  return { res, body };
}

/** Check the credentials and (if allowed) read the wallet balance — freight is charged to this wallet. */
export async function connectShiprocket(shopId: string, email: string, password: string) {
  const conn = await ensureConnection(shopId);
  const token = await login(email.trim(), password); // throws ShiprocketError on bad credentials
  const saved = await db.shiprocketConnection.update({
    where: { id: conn.id },
    data: { email: email.trim(), passwordEnc: encrypt(password), tokenEnc: encrypt(token), tokenExpiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS), connected: true, lastError: null },
  });
  return { conn: saved, wallet: await walletBalance(saved) };
}

export async function walletBalance(conn: ShiprocketConnection): Promise<number | null> {
  try {
    const { res, body } = await call(conn, "/account/details/wallet-balance");
    const data = (body?.data ?? {}) as Json;
    const n = Number(data.balance_amount ?? data.balance ?? NaN);
    return res.ok && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function disconnectShiprocket(shopId: string) {
  await db.shiprocketConnection.updateMany({ where: { shopId }, data: { connected: false, passwordEnc: null, tokenEnc: null, tokenExpiresAt: null } });
}

export { trackingLink } from "../lib/courier-status";
import { trackingLink } from "../lib/courier-status";

type Address = Record<string, string | null> | null;

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

type ReturnForPayload = Prisma.ReturnRequestGetPayload<{ include: { items: true } }>;

/**
 * Builds the body for the Wrapper "Return" API. Returns an error string instead when Shiprocket couldn't take the
 * shipment (not an Indian address, missing phone, warehouse not configured…) so the merchant sees *why*.
 * Amounts are sent in rupees, converted from the order currency.
 */
export function buildReturnPayload(
  ret: ReturnForPayload,
  conn: ShiprocketConnection,
  toInr: (amount: number) => number,
): { payload: Json } | { error: string } {
  const a = ret.shippingAddress as Address;
  if (!a) return { error: "This return has no customer address." };
  if ((a.country ?? "").trim().toLowerCase() !== "india") {
    return { error: `Shiprocket handles pickups inside India only; this customer is in ${a.country || "an unknown country"}.` };
  }
  const missing = (["whName", "whAddress", "whCity", "whState", "whPincode", "whPhone"] as const).filter((k) => !conn[k]);
  if (missing.length) return { error: "Finish your return warehouse details in Shipping settings first." };

  const phone = digits(a.phone ?? ret.customerPhone).slice(-10);
  if (phone.length !== 10) return { error: "The customer's phone number is missing or invalid (Shiprocket needs 10 digits)." };
  const pincode = digits(a.zip);
  if (pincode.length !== 6) return { error: "The customer's pincode is missing or invalid." };
  if (!ret.customerEmail) return { error: "The customer's email is missing." };
  if (!a.address1 || !a.city || !a.province) return { error: "The customer's address is incomplete (street, city and state are required)." };

  const [first, ...rest] = (a.name ?? ret.customerName ?? "Customer").trim().split(/\s+/);
  const items = ret.items.map((i, n) => ({
    name: [i.title, i.variantTitle && i.variantTitle !== "Default Title" ? i.variantTitle : null].filter(Boolean).join(" - ").slice(0, 120),
    sku: i.sku || `ITEM-${n + 1}-${i.id.slice(-5)}`,
    units: i.quantity,
    selling_price: Math.round(toInr(Number(i.unitPrice ?? 0)) * 100) / 100,
    discount: 0,
  }));
  const subTotal = items.reduce((n, i) => n + i.selling_price * i.units, 0);

  return {
    payload: {
      order_id: `ecoreturn_${ret.id}`, // echoed back in Shiprocket's webhook as `order_id`, which is how we find the return again
      order_date: ret.requestedAt.toISOString().slice(0, 10),
      pickup_customer_name: first || "Customer",
      pickup_last_name: rest.join(" "),
      pickup_address: a.address1,
      pickup_address_2: a.address2 ?? "",
      pickup_city: a.city,
      pickup_state: a.province,
      pickup_country: "India",
      pickup_pincode: Number(pincode),
      pickup_email: ret.customerEmail,
      pickup_phone: phone,
      pickup_isd_code: "91",
      shipping_customer_name: conn.whName,
      shipping_last_name: "",
      shipping_address: conn.whAddress,
      shipping_address_2: conn.whAddress2 ?? "",
      shipping_city: conn.whCity,
      shipping_country: conn.whCountry || "India",
      shipping_pincode: Number(digits(conn.whPincode)),
      shipping_state: conn.whState,
      shipping_email: conn.whEmail ?? "",
      shipping_isd_code: "91",
      shipping_phone: Number(digits(conn.whPhone).slice(-10)),
      order_items: items,
      payment_method: "Prepaid", // the customer pays nothing for a return pickup, whatever the original order used
      total_discount: "0",
      sub_total: Math.round(subTotal * 100) / 100,
      length: conn.parcelLength,
      breadth: conn.parcelBreadth,
      height: conn.parcelHeight,
      weight: conn.parcelWeight,
      request_pickup: true,
    },
  };
}

type WrapperResponse = { status?: number; payload?: Record<string, unknown> };

/**
 * Books the reverse pickup on Shiprocket for an approved return: order + AWB + pickup in one call, then writes the AWB
 * back to the return and to Shopify's reverse delivery. Safe to call twice — a second call while one is running (or after
 * success) does nothing.
 */
export async function bookReturnPickup(shopDomain: string, localReturnId: string, actor: string) {
  const shop = await ensureShop(shopDomain);
  const conn = await db.shiprocketConnection.findUnique({ where: { shopId: shop.id } });
  if (!conn?.connected) return { ok: false as const, error: "Connect Shiprocket in Shipping settings first." };

  // Mutex: only one booking at a time per return, and never a second booking once one exists.
  const stale = new Date(Date.now() - 2 * 60_000);
  const locked = await db.returnRequest.updateMany({
    where: {
      id: localReturnId,
      shopId: shop.id,
      srOrderId: null,
      OR: [{ pickupError: null }, { pickupError: { not: "BOOKING" } }, { pickupError: "BOOKING", updatedAt: { lt: stale } }],
    },
    data: { pickupError: "BOOKING" },
  });
  if (!locked.count) return { ok: false as const, error: "A pickup is already booked (or being booked) for this return." };

  const fail = async (error: string, extra: Prisma.ReturnRequestUpdateInput = {}) => {
    await db.returnRequest.update({ where: { id: localReturnId }, data: { pickupError: error, ...extra } });
    await db.shiprocketConnection.update({ where: { id: conn.id }, data: { lastError: error } });
    await addEvent(shop.id, localReturnId, { kind: "ACTION", title: "Pickup booking failed", detail: error, actor });
    return { ok: false as const, error };
  };

  try {
    const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id }, include: { items: true } });
    if (!ret) return fail("Return not found");
    if (ret.status !== "OPEN") return fail("Only approved returns can be picked up.");

    const { rates } = await getRates();
    const from = ret.currency ?? "INR";
    const built = buildReturnPayload(ret, conn, (n) => convert(n, from, "INR", rates));
    if ("error" in built) return fail(built.error);

    const { res, body } = await call(conn, "/shipments/create/return-shipment", { method: "POST", body: built.payload });
    const out = (body ?? {}) as WrapperResponse & Json;
    const p = out.payload ?? {};
    if (!res.ok || (out.status !== undefined && out.status !== 1 && !p.order_id)) return fail(describeError(body, res.status));

    const awb = typeof p.awb_code === "string" || typeof p.awb_code === "number" ? String(p.awb_code) : null;
    const base = { srOrderId: p.order_id != null ? String(p.order_id) : null, srShipmentId: p.shipment_id != null ? String(p.shipment_id) : null };
    if (!awb) {
      // Order exists on Shiprocket but no courier was assigned (usually wallet balance or an unserviceable pincode).
      return fail("Shiprocket created the return order but could not assign a courier. Check your Shiprocket wallet balance and that the pickup pincode is serviceable.", base);
    }

    const carrier = typeof p.courier_name === "string" ? p.courier_name : null;
    await db.returnRequest.update({
      where: { id: ret.id },
      data: {
        ...base,
        awb,
        carrier,
        carrierStatus: "PICKUP SCHEDULED",
        pickupScheduledAt: typeof p.pickup_scheduled_date === "string" ? new Date(p.pickup_scheduled_date.replace(" ", "T") + "+05:30") : new Date(),
        shipmentStatus: "AWAITING_SHIPMENT",
        pickupError: null,
      },
    });
    await db.shiprocketConnection.update({ where: { id: conn.id }, data: { lastError: null } });
    await addEvent(shop.id, ret.id, { kind: "ACTION", title: "Reverse pickup booked", detail: [carrier, awb].filter(Boolean).join(" · "), actor });
    inBackground(notifyReturn(shopDomain, "pickup_booked", ret.id));

    // Put the tracking number on Shopify's reverse delivery too (best effort: it reports its own warning).
    const synced = await saveTracking(shopDomain, ret.id, { number: awb, carrier: carrier ?? undefined, url: trackingLink(awb) }, actor);
    // saveTracking marks the shipment "in transit"; a freshly booked pickup hasn't moved yet.
    await db.returnRequest.update({ where: { id: ret.id }, data: { shipmentStatus: "AWAITING_SHIPMENT" } });
    return { ok: true as const, awb, carrier, warning: synced.ok ? synced.warning : undefined };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Could not reach Shiprocket.");
  }
}

/** Called when a return becomes approved: books the pickup only if the merchant enabled "auto pickup". */
export async function maybeAutoBookPickup(shopDomain: string, localReturnId: string) {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  const conn = shop ? await db.shiprocketConnection.findUnique({ where: { shopId: shop.id } }) : null;
  if (!conn?.connected || !conn.autoPickup) return null;
  return bookReturnPickup(shopDomain, localReturnId, "Automation: auto pickup");
}

/** Cancel a booked pickup (only possible before the courier collects it). */
export async function cancelReturnPickup(shopDomain: string, localReturnId: string, actor: string) {
  const shop = await ensureShop(shopDomain);
  const conn = await db.shiprocketConnection.findUnique({ where: { shopId: shop.id } });
  const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id } });
  if (!conn?.connected || !ret?.awb || !ret.srOrderId) return { ok: false as const, error: "There is no Shiprocket pickup to cancel." };
  try {
    const { res, body } = await call(conn, "/orders/cancel/shipment/awbs", { method: "POST", body: { awbs: [ret.awb] } });
    if (!res.ok) return { ok: false as const, error: describeError(body, res.status) };
    await db.returnRequest.update({ where: { id: ret.id }, data: { shipmentStatus: "CANCELED", carrierStatus: "CANCELED", awb: null, carrier: null, srOrderId: null, srShipmentId: null, pickupError: null } });
    await addEvent(shop.id, ret.id, { kind: "ACTION", title: "Pickup canceled", detail: `AWB ${ret.awb}`, actor });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not reach Shiprocket." };
  }
}
