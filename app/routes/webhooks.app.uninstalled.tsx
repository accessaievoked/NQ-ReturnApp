import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markShopUninstalled } from "../services/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Keep the shop's data (merchant may reinstall); only drop sessions.
  await db.session.deleteMany({ where: { shop } });
  await markShopUninstalled(shop);

  return new Response();
};
