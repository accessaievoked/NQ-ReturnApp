import { Prisma, type ReturnStatus } from "@prisma/client";
import db from "../db.server";
import { getAdmin, gql } from "./admin-client.server";
import { ensureShop } from "./shop.server";
import { inBackground, notifyReturn } from "./notify.server";
import { fmtMoney } from "../lib/format";

const RETURN_QUERY = `#graphql
  query ReturnDetail($id: ID!) {
    return(id: $id) {
      id
      name
      status
      createdAt
      closedAt
      totalQuantity
      decline { reason note }
      refunds(first: 10) { nodes { id processedAt totalRefundedSet { shopMoney { amount } } } }
      exchangeLineItems(first: 20) {
        nodes {
          id
          quantity
          processedQuantity
          variantId
          lineItems { title variantTitle sku image { url } originalUnitPriceSet { shopMoney { amount } } }
        }
      }
      reverseFulfillmentOrders(first: 5) {
        nodes {
          id
          status
          reverseDeliveries(first: 5) {
            nodes { id deliverable { __typename ... on ReverseDeliveryShippingDeliverable { tracking { number carrierName url } } } }
          }
        }
      }
      order {
        id
        name
        createdAt
        paymentGatewayNames
        totalPriceSet { shopMoney { amount currencyCode } }
        email
        phone
        shippingAddress { name address1 address2 city province zip country phone }
        customer { displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
      }
      returnLineItems(first: 100) {
        nodes {
          __typename
          ... on ReturnLineItem {
            id
            quantity
            returnReasonDefinition { handle name }
            returnReasonNote
            customerNote
            fulfillmentLineItem {
              lineItem {
                id
                title
                variantTitle
                sku
                image { url }
                originalUnitPriceSet { shopMoney { amount } }
                variant { id product { id } }
              }
            }
          }
        }
      }
    }
  }
`;

type ReturnPayload = {
  return: {
    id: string;
    name: string;
    status: ReturnStatus;
    createdAt: string;
    closedAt: string | null;
    totalQuantity: number;
    refunds: { nodes: { id: string; processedAt: string | null; totalRefundedSet: { shopMoney: { amount: string } } }[] };
    exchangeLineItems: {
      nodes: {
        id: string;
        quantity: number;
        processedQuantity: number;
        variantId: string | null;
        lineItems: { title: string; variantTitle: string | null; sku: string | null; image: { url: string } | null; originalUnitPriceSet: { shopMoney: { amount: string } } }[];
      }[];
    };
    reverseFulfillmentOrders: {
      nodes: {
        id: string;
        status: "OPEN" | "CLOSED" | "CANCELED";
        reverseDeliveries: {
          nodes: { id: string; deliverable: { tracking?: { number: string | null; carrierName: string | null; url: string | null } | null } | null }[];
        };
      }[];
    };
    decline: { reason: string | null; note: string | null } | null;
    order: {
      id: string;
      name: string;
      createdAt: string;
      paymentGatewayNames: string[];
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      email: string | null;
      phone: string | null;
      shippingAddress: Record<string, string | null> | null;
      customer: {
        displayName: string;
        defaultEmailAddress: { emailAddress: string } | null;
        defaultPhoneNumber: { phoneNumber: string } | null;
      } | null;
    };
    returnLineItems: {
      nodes: Array<{
        __typename: string;
        id?: string;
        quantity?: number;
        returnReasonDefinition?: { handle: string; name: string } | null;
        returnReasonNote?: string | null;
        customerNote?: string | null;
        fulfillmentLineItem?: {
          lineItem: {
            id: string;
            title: string;
            variantTitle: string | null;
            sku: string | null;
            image: { url: string } | null;
            originalUnitPriceSet: { shopMoney: { amount: string } };
            variant: { id: string; product: { id: string } } | null;
          };
        } | null;
      }>;
    };
  } | null;
};

/**
 * Pulls the full return from Shopify and upserts it (plus items) into our DB.
 * Idempotent: safe to call for every webhook delivery and for backfills.
 * Returns the local ReturnRequest, and whether the status changed.
 * Brand-new REQUESTED returns are passed to the automation rules unless `automate` is false
 * (the historical backfill turns it off so old requests aren't auto-decided on install).
 */
type ExchangeVariant = {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  product: { title: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null };
};

const EXCHANGE_VARIANTS_QUERY = `#graphql
  query ExchangeVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        price
        product { title featuredMedia { preview { image { url } } } }
      }
    }
  }`;

async function fetchVariants(admin: Awaited<ReturnType<typeof getAdmin>>, ids: string[]) {
  const data = await gql<{ nodes: (ExchangeVariant | null)[] }>(admin, EXCHANGE_VARIANTS_QUERY, { ids });
  return new Map(data.nodes.filter((n): n is ExchangeVariant => !!n?.id).map((n) => [n.id, n]));
}

export type ShipmentStatus = "AWAITING_SHIPMENT" | "IN_TRANSIT" | "RECEIVED" | "CANCELED";

/** Collapse Shopify's reverse fulfillment orders into one status for the list. */
export function shipmentStatusOf(statuses: string[], hasTracking: boolean): ShipmentStatus | null {
  if (!statuses.length) return null;
  if (statuses.every((x) => x === "CANCELED")) return "CANCELED";
  if (statuses.some((x) => x === "CLOSED")) return "RECEIVED";
  return hasTracking ? "IN_TRANSIT" : "AWAITING_SHIPMENT";
}

export async function ingestReturn(
  shopDomain: string,
  returnGid: string,
  source = "Shopify",
  opts: { automate?: boolean; notify?: boolean } = {},
) {
  const shop = await ensureShop(shopDomain);
  const admin = await getAdmin(shopDomain);
  const data = await gql<ReturnPayload>(admin, RETURN_QUERY, { id: returnGid });
  const r = data.return;
  if (!r) return null;

  const existing = await db.returnRequest.findUnique({
    where: { shopId_shopifyId: { shopId: shop.id, shopifyId: r.id } },
    select: { id: true, status: true, shipmentStatus: true },
  });

  // First time we see the store's currency, remember it (every returnValue is stored in it).
  if (!shop.currency) await db.shop.update({ where: { id: shop.id }, data: { currency: r.order.totalPriceSet.shopMoney.currencyCode } });
  const returnValue = r.returnLineItems.nodes.reduce(
    (sum, n) =>
      n.id && n.fulfillmentLineItem
        ? sum + Number(n.fulfillmentLineItem.lineItem.originalUnitPriceSet.shopMoney.amount) * (n.quantity ?? 1)
        : sum,
    0,
  );
  const refundedAmount = r.refunds.nodes.reduce((n, f) => n + Number(f.totalRefundedSet.shopMoney.amount), 0);
  const refundedAt = r.refunds.nodes.map((f) => f.processedAt).filter((d): d is string => !!d).sort().at(-1) ?? null;
  const exchangeUnits = r.exchangeLineItems.nodes.reduce((n, e) => n + e.quantity, 0);
  const exchangeDone = r.exchangeLineItems.nodes.reduce((n, e) => n + e.processedQuantity, 0);
  // The replacement products the customer is taking, flattened for display (one entry per exchange line).
  // Before the exchange is released Shopify has no order line items for it, only the variant being exchanged into.
  const variantIds = r.exchangeLineItems.nodes.filter((e) => !e.lineItems.length && e.variantId).map((e) => e.variantId!);
  const variants = variantIds.length ? await fetchVariants(admin, variantIds) : new Map<string, ExchangeVariant>();
  const exchangeItems = r.exchangeLineItems.nodes.flatMap((e) => {
    const li = e.lineItems[0];
    if (li) {
      return [{
        id: e.id,
        title: li.title,
        variantTitle: li.variantTitle,
        sku: li.sku,
        imageUrl: li.image?.url ?? null,
        quantity: e.quantity,
        processedQuantity: e.processedQuantity,
        unitPrice: Number(li.originalUnitPriceSet.shopMoney.amount),
      }];
    }
    const v = e.variantId ? variants.get(e.variantId) : undefined;
    return [{
      id: e.id,
      title: v?.product.title ?? "Replacement item",
      variantTitle: v && v.title !== "Default Title" ? v.title : null,
      sku: v?.sku ?? null,
      imageUrl: v?.product.featuredMedia?.preview?.image?.url ?? null,
      quantity: e.quantity,
      processedQuantity: e.processedQuantity,
      unitPrice: Number(v?.price ?? 0),
    }];
  });
  const tracking = r.reverseFulfillmentOrders.nodes
    .flatMap((o) => o.reverseDeliveries.nodes)
    .map((d) => d.deliverable?.tracking)
    .find((t) => t?.number);
  const derivedShipment = shipmentStatusOf(r.reverseFulfillmentOrders.nodes.map((o) => o.status), !!tracking);
  // "Received" can be marked inside this app too; don't let a later Shopify sync undo it unless the shipment was canceled.
  const shipmentStatus = existing?.shipmentStatus === "RECEIVED" && derivedShipment !== "CANCELED" ? "RECEIVED" : derivedShipment;
  const customerName = r.order.customer?.displayName ?? r.order.shippingAddress?.name ?? null;
  const fields = {
    name: r.name,
    status: r.status,
    orderShopifyId: r.order.id,
    orderName: r.order.name,
    orderCreatedAt: new Date(r.order.createdAt),
    orderTotal: r.order.totalPriceSet.shopMoney.amount,
    currency: r.order.totalPriceSet.shopMoney.currencyCode,
    paymentMethod: r.order.paymentGatewayNames.join(", ") || null,
    customerName,
    customerEmail: r.order.customer?.defaultEmailAddress?.emailAddress ?? r.order.email,
    customerPhone: r.order.customer?.defaultPhoneNumber?.phoneNumber ?? r.order.phone,
    shippingAddress: (r.order.shippingAddress ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    totalQuantity: r.totalQuantity,
    returnValue,
    refundedAmount,
    refundedAt: refundedAt ? new Date(refundedAt) : null,
    exchangeUnits,
    exchangeDone,
    exchangeItems: exchangeItems.length ? exchangeItems : Prisma.JsonNull,
    shipmentStatus,
    // Only overwrite tracking when Shopify has some, so a number saved in this app isn't wiped by a sync.
    ...(tracking ? { awb: tracking.number, carrier: tracking.carrierName } : {}),
    declineReason: r.decline?.reason ?? null,
    declineNote: r.decline?.note ?? null,
    closedAt: r.closedAt ? new Date(r.closedAt) : null,
  };

  const saved = await db.returnRequest.upsert({
    where: { shopId_shopifyId: { shopId: shop.id, shopifyId: r.id } },
    create: { shopId: shop.id, shopifyId: r.id, requestedAt: new Date(r.createdAt), ...fields },
    update: { ...fields, requestedAt: new Date(r.createdAt) }, // Shopify's real request time, so re-syncs repair old rows
  });

  // Map Shopify product/variant GIDs to our local rows (null when not synced yet).
  const lineItems = r.returnLineItems.nodes.filter((n) => n.id && n.fulfillmentLineItem);
  const productGids = lineItems
    .map((n) => n.fulfillmentLineItem!.lineItem.variant?.product.id)
    .filter((x): x is string => !!x);
  const products = await db.product.findMany({
    where: { shopId: shop.id, shopifyId: { in: productGids } },
    select: { id: true, shopifyId: true, variants: { select: { id: true, shopifyId: true } } },
  });
  const productByGid = new Map(products.map((p) => [p.shopifyId, p]));

  for (const n of lineItems) {
    const li = n.fulfillmentLineItem!.lineItem;
    const product = li.variant ? productByGid.get(li.variant.product.id) : undefined;
    const variant = product?.variants.find((v) => v.shopifyId === li.variant?.id);
    const itemFields = {
      productId: product?.id ?? null,
      variantId: variant?.id ?? null,
      title: li.title,
      variantTitle: li.variantTitle,
      sku: li.sku,
      imageUrl: li.image?.url ?? null,
      quantity: n.quantity ?? 1,
      unitPrice: li.originalUnitPriceSet.shopMoney.amount,
      reason: n.returnReasonDefinition?.name ?? null,
      reasonNote: n.returnReasonNote || null,
      customerNote: n.customerNote || null,
    };
    await db.returnItem.upsert({
      where: { returnId_shopifyId: { returnId: saved.id, shopifyId: n.id! } },
      create: { returnId: saved.id, shopifyId: n.id!, ...itemFields },
      update: itemFields,
    });
  }

  const statusChanged = !existing || existing.status !== saved.status;
  if (statusChanged) {
    await addEvent(shop.id, saved.id, {
      kind: "WEBHOOK",
      title: existing
        ? `Status changed to ${saved.status}`
        : saved.status === "REQUESTED"
          ? "Return requested"
          : `Return created in Shopify (already ${saved.status === "OPEN" ? "approved" : saved.status.toLowerCase()})`,
      actor: source,
    });
  }
  // Tell the customer about the change (once per event: notifyReturn de-duplicates). Skipped for backfills / lazy
  // refreshes (automate: false) and when the caller already sent its own email (notify: false).
  if (opts.automate !== false && opts.notify !== false) {
    const isExchange = saved.exchangeUnits > 0;
    if (!existing && saved.status === "REQUESTED") inBackground(notifyReturn(shopDomain, isExchange ? "exchange_received" : "return_received", saved.id));
    else if (statusChanged && saved.status === "OPEN") inBackground(notifyReturn(shopDomain, isExchange ? "exchange_approved" : "return_approved", saved.id));
    else if (statusChanged && saved.status === "DECLINED") inBackground(notifyReturn(shopDomain, isExchange ? "exchange_declined" : "return_declined", saved.id));
  }
  // Approved from anywhere (this app, an automation rule, or the Shopify admin): book the reverse pickup if the merchant
  // turned that on. Fire-and-forget — Shiprocket can take longer than the few seconds a Shopify webhook is allowed.
  if (statusChanged && saved.status === "OPEN" && opts.automate !== false) {
    const { maybeAutoBookPickup } = await import("./shiprocket.server"); // lazy: shiprocket.server imports this file
    void maybeAutoBookPickup(shopDomain, saved.id).catch((e) => console.error("Auto pickup failed", e));
  }
  if (!existing && saved.status === "REQUESTED" && opts.automate !== false) {
    const { runAutomations } = await import("./automation.server"); // lazy: automation.server imports this file
    await runAutomations(shopDomain, saved.id);
  }
  return { ret: saved, statusChanged };
}

export async function addEvent(
  shopId: string,
  returnId: string,
  e: { kind: "WEBHOOK" | "ACTION" | "NOTE"; title: string; detail?: string; actor?: string },
) {
  return db.returnEvent.create({ data: { shopId, returnId, ...e } });
}

/** Backfill: walk all returns on the shop (newest first) so history shows up after install. */
export async function syncAllReturns(shopDomain: string) {
  const shop = await ensureShop(shopDomain);
  const admin = await getAdmin(shopDomain);
  const query = `#graphql
    query OrdersWithReturns($cursor: String) {
      orders(first: 50, after: $cursor, query: "return_status:RETURN_REQUESTED OR return_status:IN_PROGRESS OR return_status:RETURNED OR return_status:INSPECTION_COMPLETE") {
        pageInfo { hasNextPage endCursor }
        nodes { returns(first: 20) { nodes { id } } }
      }
    }`;
  let cursor: string | null = null;
  let count = 0;
  do {
    const page: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { returns: { nodes: { id: string }[] } }[];
      };
    } = await gql(admin, query, { cursor });
    for (const o of page.orders.nodes) {
      for (const r of o.returns.nodes) {
        await ingestReturn(shopDomain, r.id, "Initial sync", { automate: false });
        count++;
      }
    }
    cursor = page.orders.pageInfo.hasNextPage ? page.orders.pageInfo.endCursor : null;
  } while (cursor);
  await db.shop.update({ where: { id: shop.id }, data: { returnsSyncedAt: new Date() } });
  return count;
}

// ---- Merchant actions: update Shopify first, then mirror locally via ingestReturn ----

const MUTATIONS = {
  approve: `#graphql
    mutation Approve($id: ID!) {
      returnApproveRequest(input: { id: $id }) { return { id status } userErrors { field message } }
    }`,
  decline: `#graphql
    mutation Decline($id: ID!, $note: String) {
      returnDeclineRequest(input: { id: $id, declineReason: OTHER, declineNote: $note }) {
        return { id status } userErrors { field message }
      }
    }`,
  close: `#graphql
    mutation Close($id: ID!) {
      returnClose(id: $id) { return { id status } userErrors { field message } }
    }`,
  reopen: `#graphql
    mutation Reopen($id: ID!) {
      returnReopen(id: $id) { return { id status } userErrors { field message } }
    }`,
} as const;

export type ReturnAction = keyof typeof MUTATIONS;

export async function performReturnAction(
  shopDomain: string,
  localReturnId: string,
  action: ReturnAction,
  actor: string,
  note?: string,
) {
  const shop = await ensureShop(shopDomain);
  const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id } });
  if (!ret) throw new Error("Return not found");

  const admin = await getAdmin(shopDomain);
  const result = await gql<Record<string, { userErrors: { message: string }[] }>>(
    admin,
    MUTATIONS[action],
    { id: ret.shopifyId, ...(action === "decline" ? { note: note || null } : {}) },
  );
  const payload = Object.values(result)[0];
  if (payload.userErrors.length) {
    return { ok: false as const, error: payload.userErrors.map((e) => e.message).join(", ") };
  }

  await ingestReturn(shopDomain, ret.shopifyId, actor);
  await addEvent(shop.id, ret.id, {
    kind: "ACTION",
    title: `${actor.startsWith("Automation") ? "Automation" : "Merchant"} ${action === "close" ? "closed" : action + (action.endsWith("e") ? "d" : "ed")} the return`,
    detail: note || undefined,
    actor,
  });
  return { ok: true as const };
}

// ---- Refund, tracking and receiving ----

const REFUND_BASIS_QUERY = `#graphql
  query RefundBasis($id: ID!) {
    return(id: $id) {
      returnLineItems(first: 100) { nodes { ... on ReturnLineItem { id processableQuantity } } }
    }
  }`;

const REFUND_SUGGEST_QUERY = `#graphql
  query RefundSuggestion($id: ID!, $items: [SuggestedOutcomeReturnLineItemInput!]!) {
    return(id: $id) {
      suggestedFinancialOutcome(returnLineItems: $items, exchangeLineItems: []) {
        financialTransfer {
          __typename
          ... on RefundReturnOutcome {
            amount { shopMoney { amount currencyCode } }
            suggestedTransactions {
              ... on SuggestedOrderTransaction { amountSet { shopMoney { amount currencyCode } } parentTransaction { id } }
            }
          }
        }
      }
    }
  }`;

const PROCESS_RETURN = `#graphql
  mutation ProcessReturn($input: ReturnProcessInput!) {
    returnProcess(input: $input) { return { id status } userErrors { field message } }
  }`;

/**
 * Refunds the customer through Shopify: asks Shopify what it would refund for the unprocessed items, then processes the
 * return with exactly that suggestion (same amount, same original payment transaction). Real money moves, so callers
 * confirm first and this refuses anything that is not an approved/open return.
 */
export async function issueRefund(shopDomain: string, localReturnId: string, actor: string) {
  const shop = await ensureShop(shopDomain);
  const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id } });
  if (!ret) throw new Error("Return not found");
  if (ret.status !== "OPEN") return { ok: false as const, error: "Only approved (open) returns can be refunded." };
  if (ret.exchangeUnits > 0) return { ok: false as const, error: "This return is an exchange. Use Complete exchange so the replacement and any leftover refund are handled together." };

  const admin = await getAdmin(shopDomain);
  const basis = await gql<{ return: { returnLineItems: { nodes: { id?: string; processableQuantity?: number }[] } } | null }>(admin, REFUND_BASIS_QUERY, { id: ret.shopifyId });
  const items = (basis.return?.returnLineItems.nodes ?? [])
    .filter((n) => n.id && (n.processableQuantity ?? 0) > 0)
    .map((n) => ({ id: n.id!, quantity: n.processableQuantity! }));
  if (!items.length) return { ok: false as const, error: "Nothing left to refund on this return." };

  const suggestion = await gql<{
    return: {
      suggestedFinancialOutcome: {
        financialTransfer: {
          __typename: string;
          suggestedTransactions?: { amountSet?: { shopMoney: { amount: string; currencyCode: string } }; parentTransaction?: { id: string } | null }[];
        } | null;
      } | null;
    } | null;
  }>(admin, REFUND_SUGGEST_QUERY, { id: ret.shopifyId, items });

  const transfer = suggestion.return?.suggestedFinancialOutcome?.financialTransfer;
  const txs = (transfer?.suggestedTransactions ?? []).filter((t) => t.parentTransaction?.id && t.amountSet);
  if (transfer?.__typename !== "RefundReturnOutcome" || !txs.length) {
    return { ok: false as const, error: "Shopify has no refundable payment for this order (for example cash on delivery). Refund it manually in Shopify." };
  }

  const result = await gql<{ returnProcess: { userErrors: { message: string }[] } }>(admin, PROCESS_RETURN, {
    input: {
      returnId: ret.shopifyId,
      returnLineItems: items,
      notifyCustomer: true,
      financialTransfer: {
        issueRefund: {
          orderTransactions: txs.map((t) => ({ parentId: t.parentTransaction!.id, transactionAmount: t.amountSet!.shopMoney })),
        },
      },
    },
  });
  if (result.returnProcess.userErrors.length) {
    return { ok: false as const, error: result.returnProcess.userErrors.map((e) => e.message).join(", ") };
  }

  await ingestReturn(shopDomain, ret.shopifyId, actor, { automate: false });
  const total = txs.reduce((n, t) => n + Number(t.amountSet!.shopMoney.amount), 0);
  inBackground(notifyReturn(shopDomain, "refund_issued", ret.id, { refund_amount: fmtMoney(total, txs[0].amountSet!.shopMoney.currencyCode) }));
  await addEvent(shop.id, ret.id, {
    kind: "ACTION",
    title: "Refund issued",
    detail: `${txs[0].amountSet!.shopMoney.currencyCode} ${total.toFixed(2)} refunded to the original payment method`,
    actor,
  });
  return { ok: true as const };
}

const REVERSE_ORDERS_QUERY = `#graphql
  query ReverseOrders($id: ID!) {
    return(id: $id) {
      reverseFulfillmentOrders(first: 5) {
        nodes {
          id
          status
          lineItems(first: 50) { nodes { id totalQuantity } }
          reverseDeliveries(first: 5) { nodes { id } }
        }
      }
    }
  }`;

const CREATE_DELIVERY = `#graphql
  mutation CreateDelivery($id: ID!, $items: [ReverseDeliveryLineItemInput!]!, $tracking: ReverseDeliveryTrackingInput) {
    reverseDeliveryCreateWithShipping(reverseFulfillmentOrderId: $id, reverseDeliveryLineItems: $items, trackingInput: $tracking, notifyCustomer: false) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }`;

const UPDATE_DELIVERY = `#graphql
  mutation UpdateDelivery($id: ID!, $tracking: ReverseDeliveryTrackingInput) {
    reverseDeliveryShippingUpdate(reverseDeliveryId: $id, trackingInput: $tracking, notifyCustomer: false) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }`;

type DeliveryResult = { userErrors: { message: string }[] };

/**
 * Saves the return shipment's tracking number. It is always stored here; it is also pushed to Shopify's reverse delivery
 * when the return has an open reverse fulfillment order (approved returns do). A Shopify failure is reported as a
 * warning and never loses what the merchant typed.
 */
export async function saveTracking(
  shopDomain: string,
  localReturnId: string,
  t: { number: string; carrier?: string; url?: string },
  actor: string,
) {
  const shop = await ensureShop(shopDomain);
  const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id } });
  if (!ret) throw new Error("Return not found");
  const number = t.number.trim();
  if (!number) return { ok: false as const, error: "Enter a tracking number." };

  const hadTracking = !!ret.awb;
  await db.returnRequest.update({
    where: { id: ret.id },
    data: { awb: number, carrier: t.carrier?.trim() || null, shipmentStatus: ret.shipmentStatus === "RECEIVED" ? "RECEIVED" : "IN_TRANSIT" },
  });
  await addEvent(shop.id, ret.id, {
    kind: "ACTION",
    title: hadTracking ? "Tracking updated" : "Tracking added",
    detail: [t.carrier?.trim(), number].filter(Boolean).join(" · "),
    actor,
  });

  let warning: string | undefined;
  try {
    const admin = await getAdmin(shopDomain);
    const data = await gql<{
      return: {
        reverseFulfillmentOrders: {
          nodes: { id: string; status: string; lineItems: { nodes: { id: string; totalQuantity: number }[] }; reverseDeliveries: { nodes: { id: string }[] } }[];
        };
      } | null;
    }>(admin, REVERSE_ORDERS_QUERY, { id: ret.shopifyId });
    const order = data.return?.reverseFulfillmentOrders.nodes.find((o) => o.status === "OPEN");
    if (!order) {
      warning = "Saved here. Shopify has no open reverse shipment for this return yet (approve it first), so nothing was sent to Shopify.";
    } else {
      const tracking = { number, url: t.url?.trim() || undefined };
      const existing = order.reverseDeliveries.nodes[0];
      const res: DeliveryResult = existing
        ? (await gql<{ reverseDeliveryShippingUpdate: DeliveryResult }>(admin, UPDATE_DELIVERY, { id: existing.id, tracking })).reverseDeliveryShippingUpdate
        : (
            await gql<{ reverseDeliveryCreateWithShipping: DeliveryResult }>(admin, CREATE_DELIVERY, {
              id: order.id,
              items: order.lineItems.nodes.map((l) => ({ reverseFulfillmentOrderLineItemId: l.id, quantity: l.totalQuantity })),
              tracking,
            })
          ).reverseDeliveryCreateWithShipping;
      if (res.userErrors.length) warning = `Saved here, but Shopify said: ${res.userErrors.map((e) => e.message).join(", ")}`;
    }
  } catch (err) {
    warning = `Saved here, but could not reach Shopify: ${err instanceof Error ? err.message : "unknown error"}`;
  }
  return { ok: true as const, warning };
}

/** The merchant confirms the parcel arrived. Tracked in this app (Shopify's own receiving flow needs a stock location). */
export async function markReceived(shopDomain: string, localReturnId: string, actor: string) {
  const shop = await ensureShop(shopDomain);
  const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id } });
  if (!ret) throw new Error("Return not found");
  await db.returnRequest.update({ where: { id: ret.id }, data: { shipmentStatus: "RECEIVED" } });
  inBackground(notifyReturn(shopDomain, "return_delivered", ret.id));
  await addEvent(shop.id, ret.id, { kind: "ACTION", title: "Marked as received", detail: "Return shipment received", actor });
  return { ok: true as const };
}

// ---- Exchanges ----

const EXCHANGE_BASIS_QUERY = `#graphql
  query ExchangeBasis($id: ID!) {
    return(id: $id) {
      returnLineItems(first: 100) { nodes { ... on ReturnLineItem { id processableQuantity } } }
      exchangeLineItems(first: 20) { nodes { id processableQuantity } }
    }
  }`;

const EXCHANGE_SUGGEST_QUERY = `#graphql
  query ExchangeSuggestion($id: ID!, $items: [SuggestedOutcomeReturnLineItemInput!]!, $exchange: [SuggestedOutcomeExchangeLineItemInput!]!) {
    return(id: $id) {
      suggestedFinancialOutcome(returnLineItems: $items, exchangeLineItems: $exchange) {
        financialTransfer {
          __typename
          ... on RefundReturnOutcome {
            amount { shopMoney { amount currencyCode } }
            suggestedTransactions {
              ... on SuggestedOrderTransaction { amountSet { shopMoney { amount currencyCode } } parentTransaction { id } }
            }
          }
          ... on InvoiceReturnOutcome { amount { shopMoney { amount currencyCode } } }
        }
      }
    }
  }`;

type Money = { amount: string; currencyCode: string };

/**
 * Completes an exchange in one step: hands over the replacement items and, if the returned items are worth more than
 * the replacements, refunds the leftover to the original payment. If the replacements cost more, nothing is charged
 * here — the result says how much the customer owes so the merchant can collect it in Shopify.
 * Never runs on its own: automation skips exchanges, and this only runs when the merchant clicks Complete exchange.
 */
export async function completeExchange(shopDomain: string, localReturnId: string, actor: string) {
  const shop = await ensureShop(shopDomain);
  const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id } });
  if (!ret) throw new Error("Return not found");
  if (ret.exchangeUnits <= 0) return { ok: false as const, error: "This return has no exchange items." };
  if (ret.status !== "OPEN") return { ok: false as const, error: "Approve the return first — only approved (open) exchanges can be completed." };

  const admin = await getAdmin(shopDomain);
  const basis = await gql<{
    return: { returnLineItems: { nodes: { id?: string; processableQuantity?: number }[] }; exchangeLineItems: { nodes: { id: string; processableQuantity: number }[] } } | null;
  }>(admin, EXCHANGE_BASIS_QUERY, { id: ret.shopifyId });
  const items = (basis.return?.returnLineItems.nodes ?? [])
    .filter((n) => n.id && (n.processableQuantity ?? 0) > 0)
    .map((n) => ({ id: n.id!, quantity: n.processableQuantity! }));
  const exchange = (basis.return?.exchangeLineItems.nodes ?? []).filter((n) => n.processableQuantity > 0).map((n) => ({ id: n.id, quantity: n.processableQuantity }));
  if (!exchange.length) return { ok: false as const, error: "This exchange is already complete." };

  const suggestion = await gql<{
    return: {
      suggestedFinancialOutcome: {
        financialTransfer: {
          __typename: string;
          amount?: { shopMoney: Money };
          suggestedTransactions?: { amountSet?: { shopMoney: Money }; parentTransaction?: { id: string } | null }[];
        } | null;
      } | null;
    } | null;
  }>(admin, EXCHANGE_SUGGEST_QUERY, { id: ret.shopifyId, items, exchange });

  const transfer = suggestion.return?.suggestedFinancialOutcome?.financialTransfer;
  const txs = (transfer?.suggestedTransactions ?? []).filter((t) => t.parentTransaction?.id && t.amountSet);
  const amount = Number(transfer?.amount?.shopMoney.amount ?? 0);
  const currencyCode = transfer?.amount?.shopMoney.currencyCode ?? ret.currency ?? "";
  const refundDue = transfer?.__typename === "RefundReturnOutcome" && amount > 0.005;
  const owed = transfer?.__typename === "InvoiceReturnOutcome" && amount > 0.005 ? amount : 0;

  if (refundDue && !txs.length) {
    return { ok: false as const, error: `${currencyCode} ${amount.toFixed(2)} is owed back to the customer, but Shopify has no refundable payment on this order (for example cash on delivery). Settle that in Shopify, then complete the exchange.` };
  }

  const result = await gql<{ returnProcess: { userErrors: { message: string }[] } }>(admin, PROCESS_RETURN, {
    input: {
      returnId: ret.shopifyId,
      ...(items.length ? { returnLineItems: items } : {}),
      exchangeLineItems: exchange,
      notifyCustomer: true,
      ...(refundDue
        ? { financialTransfer: { issueRefund: { orderTransactions: txs.map((t) => ({ parentId: t.parentTransaction!.id, transactionAmount: t.amountSet!.shopMoney })) } } }
        : {}),
    },
  });
  if (result.returnProcess.userErrors.length) {
    return { ok: false as const, error: result.returnProcess.userErrors.map((e) => e.message).join(", ") };
  }

  await ingestReturn(shopDomain, ret.shopifyId, actor, { automate: false });
  const names = ((await db.returnRequest.findUnique({ where: { id: ret.id }, select: { exchangeItems: true } }))?.exchangeItems as { title: string; quantity: number }[] | null) ?? [];
  const detail = [
    names.length ? `Replacement: ${names.map((n) => `${n.title} x${n.quantity}`).join(", ")}` : null,
    refundDue ? `Leftover ${currencyCode} ${amount.toFixed(2)} refunded to the original payment method` : null,
    owed ? `Customer owes ${currencyCode} ${owed.toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");
  inBackground(notifyReturn(shopDomain, "exchange_completed", ret.id, { refund_amount: refundDue ? fmtMoney(amount, currencyCode) : "" }));
  await addEvent(shop.id, ret.id, { kind: "ACTION", title: "Exchange completed", detail: detail || undefined, actor });

  const message = [
    "Exchange completed.",
    refundDue ? `${currencyCode} ${amount.toFixed(2)} left over was refunded to the original payment method.` : null,
    owed ? `The customer owes ${currencyCode} ${owed.toFixed(2)} for the price difference — collect it from the order in Shopify.` : null,
  ].filter(Boolean).join(" ");
  return { ok: true as const, message };
}
