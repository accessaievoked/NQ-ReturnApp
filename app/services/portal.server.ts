import { Prisma } from "@prisma/client";
import type { PortalSettings } from "@prisma/client";
import db from "../db.server";
import { getAdmin, gql } from "./admin-client.server";
import { addEvent, ingestReturn } from "./returns.server";
import { inBackground, notifyExchangeRequest } from "./notify.server";
import { MAX_PHOTOS_PER_ITEM, UploadError, checkUploads, claimUploads } from "./uploads.server";
import { ensureShop } from "./shop.server";

// Backend of the storefront return/exchange form (reached through Shopify's app proxy).
//
//   lookupOrder  : customer enters order number + email  -> what can be returned/exchanged, and what they can exchange into
//   submitRequest: plain return   -> Shopify `returnRequest`  (arrives as REQUESTED, merchant approves as usual)
//                  exchange       -> held in ExchangeRequest until the merchant approves it (Shopify can only create
//                                    an exchange as an already-approved return, so we gate it ourselves)
//   approve/declineExchangeRequest : merchant decisions; approval calls Shopify `returnCreate`
//
// Everything the browser sends is re-validated here against a fresh Shopify lookup; the form is only a convenience.

const DAY = 86_400_000;

export async function getPortalSettings(shopId: string): Promise<PortalSettings> {
  return db.portalSettings.upsert({ where: { shopId }, create: { shopId }, update: {} });
}

/** A message that is safe to show to a customer (never leaks internals). */
export class PortalError extends Error {}

export type ExchangeOption = { variantId: string; productTitle: string; variantTitle: string | null; imageUrl: string | null; price: number };

export type PortalItem = {
  key: string; // fulfillment line item id
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  unitPrice: number;
  quantity: number; // how many can still be returned
  eligible: boolean;
  reason: string | null; // why it can't be returned
  exchange: ExchangeOption[];
};

export type LookupResult = {
  order: { id: string; numericId: string; name: string; currency: string; customerEmail: string };
  items: PortalItem[];
  reasons: { id: string; name: string }[];
  settings: { allowReturns: boolean; allowExchanges: boolean; windowDays: number; requireNote: boolean; notice: string | null; photoMode: "OFF" | "OPTIONAL" | "REQUIRED" };
  daysLeft: number | null;
};

type Money = { shopMoney: { amount: string; currencyCode: string } };

const ORDER_QUERY = `#graphql
  query PortalOrder($q: String!) {
    orders(first: 5, query: $q) {
      nodes {
        id
        name
        email
        cancelledAt
        customer { id displayName defaultEmailAddress { emailAddress } }
      }
    }
  }`;

const ORDER_BY_ID_QUERY = `#graphql
  query PortalOrderById($id: ID!) {
    order(id: $id) {
      id
      name
      email
      cancelledAt
      customer { id displayName defaultEmailAddress { emailAddress } }
    }
  }`;

const RETURNABLE_QUERY = `#graphql
  query PortalReturnable($id: ID!) {
    returnableFulfillments(orderId: $id, first: 20) {
      nodes {
        id
        fulfillment { id deliveredAt createdAt }
        returnableFulfillmentLineItems(first: 50) {
          nodes {
            quantity
            fulfillmentLineItem {
              id
              lineItem {
                id
                title
                variantTitle
                image { url }
                product { id tags }
                variant { id }
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                discountedUnitPriceSet { shopMoney { amount currencyCode } }
              }
            }
          }
        }
      }
    }
  }`;

const REASONS_QUERY = `#graphql
  query PortalReasons { returnReasonDefinitions(first: 50) { nodes { id name deleted } } }`;

const STOCK_QUERY = `#graphql
  query PortalStock($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant { id availableForSale } }
  }`;

type OrderNode = {
  id: string;
  name: string;
  email: string | null;
  cancelledAt: string | null;
  customer: { id: string; displayName: string; defaultEmailAddress: { emailAddress: string } | null } | null;
};

type ReturnableNode = {
  id: string;
  fulfillment: { id: string; deliveredAt: string | null; createdAt: string };
  returnableFulfillmentLineItems: {
    nodes: {
      quantity: number;
      fulfillmentLineItem: {
        id: string;
        lineItem: {
          id: string;
          title: string;
          variantTitle: string | null;
          image: { url: string } | null;
          product: { id: string; tags: string[] } | null;
          variant: { id: string } | null;
          originalUnitPriceSet: Money;
          discountedUnitPriceSet: Money;
        };
      };
    }[];
  };
};

const digits = (s: string) => s.replace(/\D/g, "");
const norm = (s: string) => s.trim().toLowerCase();
const NOT_FOUND = "We couldn't find that order with that email. Check both and try again.";

/** How the order is named: its Shopify id (from a button on the order page) or the number the customer typed. */
export type OrderRef = { id?: string | null; number?: string | null };
/**
 * How ownership is proven. `customerId` comes from Shopify's *signed* app-proxy request (the logged-in customer), never
 * from the browser's own data; `email` is the fallback for guests and links shared in emails.
 */
export type Proof = { customerId?: string | null; email?: string | null };

const ownedBy = (order: OrderNode, proof: Proof): boolean => {
  const cid = digits(proof.customerId ?? "");
  if (cid && order.customer?.id && digits(order.customer.id) === cid) return true;
  const email = (proof.email ?? "").trim();
  if (!email.includes("@")) return false;
  const emails = [order.email, order.customer?.defaultEmailAddress?.emailAddress].filter((e): e is string => !!e).map(norm);
  return emails.includes(norm(email));
};

/** Finds the order and proves the customer owns it. Same message for "no such order" and "not yours", so it can't be probed. */
async function findOrder(admin: Awaited<ReturnType<typeof getAdmin>>, ref: OrderRef, proof: Proof): Promise<OrderNode> {
  const notFound = new PortalError(proof.customerId && !proof.email ? "We couldn't find that order on your account." : NOT_FOUND);
  let order: OrderNode | null | undefined;
  if (ref.id) {
    const id = digits(ref.id);
    if (!id || id.length > 20) throw notFound;
    order = (await gql<{ order: OrderNode | null }>(admin, ORDER_BY_ID_QUERY, { id: `gid://shopify/Order/${id}` })).order;
  } else {
    const wanted = digits(ref.number ?? "");
    if (!wanted || wanted.length > 12) throw notFound;
    const data = await gql<{ orders: { nodes: OrderNode[] } }>(admin, ORDER_QUERY, { q: `name:${wanted}` });
    order = data.orders.nodes.find((o) => digits(o.name) === wanted);
  }
  if (!order || !ownedBy(order, proof)) throw notFound;
  if (order.cancelledAt) throw new PortalError("This order was canceled, so there is nothing to return.");
  return order;
}

/** Order number + email (the original way in; still used by emailed links and the tests). */
export const lookupOrder = (shopDomain: string, orderNumber: string, email: string) => lookupOrderBy(shopDomain, { number: orderNumber }, { email });

export async function lookupOrderBy(shopDomain: string, ref: OrderRef, proof: Proof): Promise<LookupResult> {
  const shop = await ensureShop(shopDomain);
  const settings = await getPortalSettings(shop.id);
  if (!settings.enabled || (!settings.allowReturns && !settings.allowExchanges)) throw new PortalError("Returns are not available right now. Please contact the store.");

  const admin = await getAdmin(shopDomain);
  const order = await findOrder(admin, ref, proof);

  const [returnable, reasonData] = await Promise.all([
    gql<{ returnableFulfillments: { nodes: ReturnableNode[] } }>(admin, RETURNABLE_QUERY, { id: order.id }),
    gql<{ returnReasonDefinitions: { nodes: { id: string; name: string; deleted: boolean }[] } }>(admin, REASONS_QUERY),
  ]);

  // Quantities already promised to a pending exchange request must not be offered again.
  const pending = await db.exchangeRequest.findMany({ where: { shopId: shop.id, orderGid: order.id, status: "PENDING" }, select: { items: true } });
  const reserved = new Map<string, number>();
  for (const p of pending) for (const i of p.items as { fulfillmentLineItemId: string; quantity: number }[]) reserved.set(i.fulfillmentLineItemId, (reserved.get(i.fulfillmentLineItemId) ?? 0) + i.quantity);

  const now = Date.now();
  const tag = norm(settings.nonReturnableTag);
  let currency = "USD";
  let daysLeft: number | null = null;
  const items: PortalItem[] = [];
  const meta = new Map<string, { product?: string; variant?: string }>(); // item key -> Shopify product/variant (kept off the customer payload)

  for (const f of returnable.returnableFulfillments.nodes) {
    const start = new Date(f.fulfillment.deliveredAt ?? f.fulfillment.createdAt).getTime();
    const left = Math.ceil((start + settings.windowDays * DAY - now) / DAY);
    daysLeft = daysLeft === null ? left : Math.max(daysLeft, left);
    for (const n of f.returnableFulfillmentLineItems.nodes) {
      const li = n.fulfillmentLineItem.lineItem;
      const price = li.discountedUnitPriceSet.shopMoney;
      currency = price.currencyCode;
      const qty = n.quantity - (reserved.get(n.fulfillmentLineItem.id) ?? 0);
      let reason: string | null = null;
      if (tag && (li.product?.tags ?? []).some((t) => norm(t) === tag)) reason = "Final sale · not returnable";
      else if (left < 0) reason = `Return window of ${settings.windowDays} days has ended`;
      else if (qty <= 0) reason = "Already requested";
      items.push({
        key: n.fulfillmentLineItem.id,
        title: li.title,
        variantTitle: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : null,
        imageUrl: li.image?.url ?? null,
        unitPrice: Number(price.amount),
        quantity: Math.max(qty, 0),
        eligible: reason === null,
        reason,
        exchange: [],
      });
      meta.set(n.fulfillmentLineItem.id, { product: li.product?.id, variant: li.variant?.id });
    }
  }

  if (settings.allowExchanges) await attachExchangeOptions(admin, shop.id, settings, items, meta);

  return {
    order: { id: order.id, numericId: digits(order.id), name: order.name, currency, customerEmail: order.email ?? order.customer?.defaultEmailAddress?.emailAddress ?? "" },
    items,
    reasons: reasonData.returnReasonDefinitions.nodes.filter((r) => !r.deleted).map((r) => ({ id: r.id, name: r.name })),
    settings: { allowReturns: settings.allowReturns, allowExchanges: settings.allowExchanges, windowDays: settings.windowDays, requireNote: settings.requireNote, notice: settings.notice, photoMode: (["OFF", "REQUIRED"].includes(settings.photoMode) ? settings.photoMode : "OPTIONAL") as "OFF" | "OPTIONAL" | "REQUIRED" },
    daysLeft,
  };
}

/** Fills each eligible item's `exchange` list from the synced catalog, keeping only variants that are in stock right now. */
async function attachExchangeOptions(
  admin: Awaited<ReturnType<typeof getAdmin>>,
  shopId: string,
  settings: PortalSettings,
  items: PortalItem[],
  meta: Map<string, { product?: string; variant?: string }>,
) {
  const eligible = items.filter((i) => i.eligible);
  if (!eligible.length) return;

  const productGids = [...new Set(eligible.map((i) => meta.get(i.key)?.product).filter((p): p is string => !!p))];
  const variants = await db.variant.findMany({
    where: {
      product: { shopId, status: "ACTIVE", ...(settings.exchangeMode === "VARIANT" ? { shopifyId: { in: productGids } } : {}) },
    },
    include: { product: { select: { shopifyId: true, title: true, imageUrl: true } } },
    orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
    take: 250,
  });
  if (!variants.length) return;

  // Live stock check: the synced catalog doesn't track inventory.
  const stock = await gql<{ nodes: ({ id: string; availableForSale: boolean } | null)[] }>(admin, STOCK_QUERY, { ids: variants.map((v) => v.shopifyId) });
  const inStock = new Set(stock.nodes.filter((n): n is { id: string; availableForSale: boolean } => !!n?.availableForSale).map((n) => n.id));

  for (const item of eligible) {
    const own = meta.get(item.key);
    item.exchange = variants
      .filter((v) => inStock.has(v.shopifyId) && v.shopifyId !== own?.variant && (settings.exchangeMode === "ANY" || v.product.shopifyId === own?.product))
      .slice(0, settings.exchangeMode === "ANY" ? 60 : 30)
      .map((v) => ({
        variantId: v.shopifyId,
        productTitle: v.product.title,
        variantTitle: v.title && v.title !== "Default Title" ? v.title : null,
        imageUrl: v.product.imageUrl,
        price: Number(v.price ?? 0),
      }));
  }
}

export type SubmitPayload = {
  orderNumber?: string;
  orderId?: string; // Shopify numeric id, as given by the form's data attribute
  email?: string;
  type: "RETURN" | "EXCHANGE";
  items: { key: string; quantity: number; reasonId?: string | null; note?: string | null; photos?: string[] }[];
  replacements?: { forKey: string; variantId: string }[];
};

const REQUEST_RETURN = `#graphql
  mutation PortalRequestReturn($input: ReturnRequestInput!) {
    returnRequest(input: $input) { return { id name status } userErrors { field message code } }
  }`;

const CREATE_RETURN = `#graphql
  mutation PortalCreateReturn($input: ReturnInput!) {
    returnCreate(returnInput: $input) { return { id name status } userErrors { field message } }
  }`;

const newCode = () => `EX-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

export type SubmitResult = { kind: "RETURN"; name: string } | { kind: "EXCHANGE"; code: string };

export async function submitRequest(shopDomain: string, p: SubmitPayload, proof: { customerId?: string | null } = {}): Promise<SubmitResult> {
  const shop = await ensureShop(shopDomain);
  const settings = await getPortalSettings(shop.id);
  if (p.type === "RETURN" && !settings.allowReturns) throw new PortalError("Returns are not available for this store.");
  if (p.type === "EXCHANGE" && !settings.allowExchanges) throw new PortalError("Exchanges are not available for this store.");
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 20) throw new PortalError("Select at least one item.");

  const found = await lookupOrderBy(shopDomain, { id: p.orderId, number: p.orderNumber }, { customerId: proof.customerId, email: p.email }); // re-validates ownership, eligibility and stock
  const byKey = new Map(found.items.map((i) => [i.key, i]));
  const reasonIds = new Set(found.reasons.map((r) => r.id));
  const reasonName = new Map(found.reasons.map((r) => [r.id, r.name]));

  const chosen = p.items.map((sel) => {
    const item = byKey.get(sel.key);
    const qty = Math.floor(Number(sel.quantity));
    if (!item || !item.eligible) throw new PortalError("One of the selected items can no longer be returned. Please start again.");
    if (!(qty >= 1 && qty <= item.quantity)) throw new PortalError(`You can return at most ${item.quantity} of “${item.title}”.`);
    const note = (sel.note ?? "").toString().trim().slice(0, 500);
    if (settings.requireNote && !note) throw new PortalError("Please tell us a little more about why you're returning each item.");
    const reasonId = sel.reasonId && reasonIds.has(sel.reasonId) ? sel.reasonId : null;
    if (found.reasons.length && !reasonId) throw new PortalError("Choose a reason for each item.");
    // photos: ids returned by the upload endpoint; ignored when the store turned photos off
    const photos = settings.photoMode === "OFF" ? [] : (Array.isArray(sel.photos) ? sel.photos : []).filter((x): x is string => typeof x === "string").slice(0, MAX_PHOTOS_PER_ITEM);
    if (settings.photoMode === "REQUIRED" && photos.length === 0) throw new PortalError(`Please add a photo of “${item.title}”.`);
    return { item, qty, note, reasonId, photos };
  });
  try {
    await checkUploads(shop.id, chosen.flatMap((c) => c.photos));
  } catch (e) {
    if (e instanceof UploadError) throw new PortalError(e.message);
    throw e;
  }
  if (new Set(chosen.map((c) => c.item.key)).size !== chosen.length) throw new PortalError("An item was selected twice.");

  if (p.type === "RETURN") {
    const admin = await getAdmin(shopDomain);
    const res = await gql<{ returnRequest: { return: { id: string; name: string } | null; userErrors: { message: string }[] } }>(admin, REQUEST_RETURN, {
      input: {
        orderId: found.order.id,
        returnLineItems: chosen.map((c) => ({
          fulfillmentLineItemId: c.item.key,
          quantity: c.qty,
          ...(c.reasonId ? { returnReasonDefinitionId: c.reasonId } : {}),
          ...(c.note ? { customerNote: c.note } : {}),
        })),
      },
    });
    const r = res.returnRequest;
    if (!r.return) throw new PortalError(r.userErrors.map((e) => e.message).join(" ") || "Shopify could not create the return.");
    const ingested = await ingestReturn(shopDomain, r.return.id, "Return form");
    if (ingested) {
      // keep each photo with the item it belongs to (matching by product title/variant)
      const withPaths = await Promise.all(chosen.map(async (c) => ({ title: c.item.title, variantTitle: c.item.variantTitle, photos: await claimUploads(shop.id, c.photos) })));
      await attachPhotos(ingested.ret.id, withPaths);
    }
    return { kind: "RETURN", name: r.return.name };
  }

  // ---- exchange: every returned item needs a replacement from the options we offered
  const reps = p.replacements ?? [];
  const replacements = chosen.map((c) => {
    const pick = reps.find((r) => r.forKey === c.item.key);
    const opt = c.item.exchange.find((o) => o.variantId === pick?.variantId);
    if (!opt) throw new PortalError(`Choose what you'd like instead of “${c.item.title}”.`);
    return { forKey: c.item.key, variantId: opt.variantId, title: opt.productTitle, variantTitle: opt.variantTitle, imageUrl: opt.imageUrl, quantity: c.qty, unitPrice: opt.price };
  });

  const claimedPhotos = await Promise.all(chosen.map((c) => claimUploads(shop.id, c.photos)));
  const items = chosen.map((c, idx) => ({
    photos: claimedPhotos[idx],
    fulfillmentLineItemId: c.item.key,
    title: c.item.title,
    variantTitle: c.item.variantTitle,
    imageUrl: c.item.imageUrl,
    quantity: c.qty,
    unitPrice: c.item.unitPrice,
    reasonId: c.reasonId,
    reasonName: c.reasonId ? reasonName.get(c.reasonId) ?? null : null,
    note: c.note || null,
  }));
  const returnValue = items.reduce((n, i) => n + i.unitPrice * i.quantity, 0);
  const replacementValue = replacements.reduce((n, r) => n + r.unitPrice * r.quantity, 0);

  // notifications go to the order's own email (works when the customer was verified by login rather than by typing it)
  const email = norm(found.order.customerEmail || p.email || "");
  const prior = await db.returnRequest.count({ where: { shopId: shop.id, customerEmail: { equals: email, mode: "insensitive" }, requestedAt: { gte: new Date(Date.now() - 90 * DAY) } } });
  const flags = [prior >= 2 ? `${prior} other returns in the last 90 days` : null, replacementValue - returnValue > 0.005 ? "Replacement costs more than the returned items" : null].filter(Boolean);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await db.exchangeRequest.create({
        data: {
          shopId: shop.id,
          code: newCode(),
          orderGid: found.order.id,
          orderName: found.order.name,
          customerEmail: email,
          items: items as unknown as Prisma.InputJsonValue,
          replacements: replacements as unknown as Prisma.InputJsonValue,
          returnValue,
          replacementValue,
          currency: found.order.currency,
          flags: flags as unknown as Prisma.InputJsonValue,
        },
      });
      inBackground(notifyExchangeRequest(shopDomain, "exchange_received", row.id));
      return { kind: "EXCHANGE", code: row.code };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; // only retry a code collision
    }
  }
  throw new PortalError("Could not save your request. Please try again.");
}

/** Earlier requests for this order, shown on the form so a customer can see where they stand (already HTML-escaped). */
export async function requestsForOrder(shopId: string, orderGid: string): Promise<{ label: string; status: string }[]> {
  const [returns, exchanges] = await Promise.all([
    db.returnRequest.findMany({ where: { shopId, orderShopifyId: orderGid }, orderBy: { requestedAt: "desc" }, select: { name: true, status: true, exchangeUnits: true, declineNote: true } }),
    // an approved exchange already appears as a return, so only list the ones still waiting or declined
    db.exchangeRequest.findMany({ where: { shopId, orderGid, OR: [{ status: "PENDING" }, { status: "DECLINED" }] }, orderBy: { createdAt: "desc" }, select: { code: true, status: true, declineNote: true } }),
  ]);
  const word: Record<string, string> = { REQUESTED: "Waiting for review", OPEN: "Approved", DECLINED: "Declined", CLOSED: "Completed", CANCELED: "Canceled", PENDING: "Waiting for review" };
  return [
    ...exchanges.map((e) => ({ label: `Exchange ${e.code}`, status: `${word[e.status]}${e.status === "DECLINED" && e.declineNote ? ` — ${e.declineNote}` : ""}` })),
    ...returns.map((r) => ({ label: `${r.exchangeUnits > 0 ? "Exchange" : "Return"} ${r.name}`, status: `${word[r.status] ?? r.status}${r.status === "DECLINED" && r.declineNote ? ` — ${r.declineNote}` : ""}` })),
  ];
}

// ---------------------------------------------------------------- merchant decisions

type StoredItem = { fulfillmentLineItemId: string; quantity: number; reasonId: string | null; note: string | null; title: string; variantTitle?: string | null; photos?: string[] };
type StoredReplacement = { variantId: string; quantity: number; title: string };

/** Put customer photos on the matching ReturnItem rows (by product title, then variant when several share a title). */
export async function attachPhotos(returnId: string, entries: { title: string; variantTitle: string | null; photos: string[] }[]) {
  const withPhotos = entries.filter((e) => e.photos.length);
  if (!withPhotos.length) return;
  const rows = await db.returnItem.findMany({ where: { returnId }, select: { id: true, title: true, variantTitle: true } });
  for (const e of withPhotos) {
    const same = rows.filter((r) => r.title === e.title);
    const row = same.find((r) => (r.variantTitle ?? null) === (e.variantTitle ?? null)) ?? same[0];
    if (row) await db.returnItem.update({ where: { id: row.id }, data: { customerImages: { push: e.photos } } });
  }
}

export async function approveExchangeRequest(shopDomain: string, requestId: string, actor: string) {
  const shop = await ensureShop(shopDomain);
  const req = await db.exchangeRequest.findFirst({ where: { id: requestId, shopId: shop.id } });
  if (!req) return { ok: false as const, error: "Request not found." };
  if (req.status !== "PENDING") return { ok: false as const, error: "This request was already handled." };

  // Claim it first so a double click can't create two returns.
  const claimed = await db.exchangeRequest.updateMany({ where: { id: req.id, status: "PENDING" }, data: { status: "APPROVED", decidedAt: new Date() } });
  if (!claimed.count) return { ok: false as const, error: "This request was already handled." };
  const undo = () => db.exchangeRequest.update({ where: { id: req.id }, data: { status: "PENDING", decidedAt: null } });

  try {
    const admin = await getAdmin(shopDomain);
    const items = req.items as unknown as StoredItem[];
    const reps = req.replacements as unknown as StoredReplacement[];
    const res = await gql<{ returnCreate: { return: { id: string } | null; userErrors: { message: string }[] } }>(admin, CREATE_RETURN, {
      input: {
        orderId: req.orderGid,
        returnLineItems: items.map((i) => ({
          fulfillmentLineItemId: i.fulfillmentLineItemId,
          quantity: i.quantity,
          ...(i.reasonId ? { returnReasonDefinitionId: i.reasonId } : {}),
          ...(i.note ? { returnReasonNote: i.note } : {}),
        })),
        exchangeLineItems: reps.map((r) => ({ variantId: r.variantId, quantity: r.quantity })),
      },
    });
    if (!res.returnCreate.return) {
      await undo();
      return { ok: false as const, error: res.returnCreate.userErrors.map((e) => e.message).join(", ") || "Shopify could not create the exchange." };
    }

    // automate: true so an approved exchange can get its reverse pickup booked like any other approved return.
    const ingested = await ingestReturn(shopDomain, res.returnCreate.return.id, actor, { notify: false }); // we send our own exchange_approved below
    await db.exchangeRequest.update({ where: { id: req.id }, data: { returnId: ingested?.ret.id ?? null } });
    if (ingested) await attachPhotos(ingested.ret.id, items.map((i) => ({ title: i.title, variantTitle: i.variantTitle ?? null, photos: i.photos ?? [] })));
    if (ingested) await addEvent(shop.id, ingested.ret.id, { kind: "ACTION", title: "Exchange approved", detail: `Customer request ${req.code} (${req.orderName})`, actor });
    inBackground(notifyExchangeRequest(shopDomain, "exchange_approved", req.id, ingested ? { tracking_url: "" } : {}));
    return { ok: true as const, returnId: ingested?.ret.id ?? null };
  } catch (err) {
    await undo();
    return { ok: false as const, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export async function declineExchangeRequest(shopDomain: string, requestId: string, note: string | null) {
  const shop = await ensureShop(shopDomain);
  const res = await db.exchangeRequest.updateMany({
    where: { id: requestId, shopId: shop.id, status: "PENDING" },
    data: { status: "DECLINED", decidedAt: new Date(), declineNote: note?.trim() || null },
  });
  if (res.count) inBackground(notifyExchangeRequest(shopDomain, "exchange_declined", requestId));
  return res.count ? { ok: true as const } : { ok: false as const, error: "This request was already handled." };
}
