import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteProduct, syncProduct } from "../services/products.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const gid: string | undefined = payload?.admin_graphql_api_id;
  if (!gid) return new Response();

  try {
    if (topic === "PRODUCTS_DELETE") await deleteProduct(shop, gid);
    else await syncProduct(shop, gid);
  } catch (err) {
    console.error(`Product webhook ${topic} failed for ${gid}`, err);
    return new Response("failed", { status: 500 });
  }
  return new Response();
};
