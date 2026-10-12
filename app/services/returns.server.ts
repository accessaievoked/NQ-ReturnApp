import { Prisma, type ReturnStatus } from "@prisma/client";
import db from "../db.server";
import { getAdmin, gql } from "./admin-client.server";
import { ensureShop } from "./shop.server";

const RETURN_QUERY = `#graphql
  query ReturnDetail($id: ID!) {
    return(id: $id) {
      id
      name
      status
      closedAt
      totalQuantity
      decline { reason note }
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
    closedAt: string | null;
    totalQuantity: number;
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
 */
export async function ingestReturn(shopDomain: string, returnGid: string, source = "Shopify") {
  const shop = await ensureShop(shopDomain);
  const admin = await getAdmin(shopDomain);
  const data = await gql<ReturnPayload>(admin, RETURN_QUERY, { id: returnGid });
  const r = data.return;
  if (!r) return null;

  const existing = await db.returnRequest.findUnique({
    where: { shopId_shopifyId: { shopId: shop.id, shopifyId: r.id } },
    select: { id: true, status: true },
  });

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
    declineReason: r.decline?.reason ?? null,
    declineNote: r.decline?.note ?? null,
    closedAt: r.closedAt ? new Date(r.closedAt) : null,
  };

  const saved = await db.returnRequest.upsert({
    where: { shopId_shopifyId: { shopId: shop.id, shopifyId: r.id } },
    create: { shopId: shop.id, shopifyId: r.id, requestedAt: new Date(), ...fields },
    update: fields,
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
      title: existing ? `Status changed to ${saved.status}` : "Return requested",
      actor: source,
    });
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
        await ingestReturn(shopDomain, r.id, "Initial sync");
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
    title: `Merchant ${action === "close" ? "closed" : action + (action.endsWith("e") ? "d" : "ed")} the return`,
    detail: note || undefined,
    actor,
  });
  return { ok: true as const };
}

