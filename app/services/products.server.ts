import db from "../db.server";
import { getAdmin, gql } from "./admin-client.server";
import { ensureShop } from "./shop.server";

const PRODUCT_FIELDS = `#graphql
  fragment ProductFields on Product {
    id
    title
    handle
    status
    vendor
    productType
    featuredMedia { preview { image { url } } }
    variants(first: 100) {
      nodes { id title sku price }
    }
  }
`;

export type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  variants: { nodes: { id: string; title: string; sku: string | null; price: string }[] };
};

export async function upsertProduct(shopId: string, p: ShopifyProduct) {
  const fields = {
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    productType: p.productType,
    imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
  };
  const saved = await db.product.upsert({
    where: { shopId_shopifyId: { shopId, shopifyId: p.id } },
    create: { shopId, shopifyId: p.id, ...fields },
    update: fields,
  });
  for (const v of p.variants.nodes) {
    const vf = { title: v.title, sku: v.sku, price: v.price };
    await db.variant.upsert({
      where: { productId_shopifyId: { productId: saved.id, shopifyId: v.id } },
      create: { productId: saved.id, shopifyId: v.id, ...vf },
      update: vf,
    });
  }
  return saved;
}

/** Full catalog sync (paginated). Run on install and from the Settings page. */
export async function syncAllProducts(shopDomain: string) {
  const shop = await ensureShop(shopDomain);
  const admin = await getAdmin(shopDomain);
  const query = `#graphql
    ${PRODUCT_FIELDS}
    query Products($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ...ProductFields }
      }
    }`;
  let cursor: string | null = null;
  let count = 0;
  do {
    const page: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProduct[];
      };
    } = await gql(admin, query, { cursor });
    for (const p of page.products.nodes) {
      await upsertProduct(shop.id, p);
      count++;
    }
    cursor = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
  } while (cursor);
  await db.shop.update({ where: { id: shop.id }, data: { productsSyncedAt: new Date() } });
  return count;
}

/** Re-fetch one product by numeric/GID id (webhook payloads don't include variants in our shape). */
export async function syncProduct(shopDomain: string, productGid: string) {
  const shop = await ensureShop(shopDomain);
  const admin = await getAdmin(shopDomain);
  const data = await gql<{ product: ShopifyProduct | null }>(
    admin,
    `#graphql
    ${PRODUCT_FIELDS}
    query One($id: ID!) { product(id: $id) { ...ProductFields } }`,
    { id: productGid },
  );
  if (data.product) await upsertProduct(shop.id, data.product);
}

export async function deleteProduct(shopDomain: string, productGid: string) {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;
  // Return items keep their snapshot (title/image); FK is SetNull.
  await db.product.deleteMany({ where: { shopId: shop.id, shopifyId: productGid } });
}
