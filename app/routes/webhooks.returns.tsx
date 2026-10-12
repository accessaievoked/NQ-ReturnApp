import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestReturn } from "../services/returns.server";

// All returns/* topics land here. Payloads are thin, so we re-fetch the full return and upsert it.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const gid: string | undefined = payload?.admin_graphql_api_id;
  console.log(`Received ${topic} for ${shop} (${gid})`);

  if (gid) {
    try {
      await ingestReturn(shop, gid);
    } catch (err) {
      // 5xx makes Shopify retry the delivery.
      console.error(`Failed to ingest ${gid}`, err);
      return new Response("ingest failed", { status: 500 });
    }
  }
  return new Response();
};
