import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { syncAllProducts } from "../services/products.server";
import { syncAllReturns } from "../services/returns.server";
import { fmtDate } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const [products, returns] = await Promise.all([
    db.product.count({ where: { shopId: shop.id } }),
    db.returnRequest.count({ where: { shopId: shop.id } }),
  ]);
  return { shop, products, returns };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const intent = String((await request.formData()).get("intent"));
  if (intent === "products") return { what: "products", n: await syncAllProducts(session.shop) };
  if (intent === "returns") return { what: "returns", n: await syncAllReturns(session.shop) };
  return null;
};

export default function Settings() {
  const { shop, products, returns } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Settings & sync">
      {result && <s-banner tone="success">Synced {result.n} {result.what}.</s-banner>}
      <s-section heading="Product catalog">
        <s-paragraph>
          {products} products stored · last synced {shop.productsSyncedAt ? fmtDate(shop.productsSyncedAt) : "never"}
        </s-paragraph>
        <s-button disabled={busy} onClick={() => submit({ intent: "products" }, { method: "post" })}>
          {busy ? "Syncing…" : "Sync products"}
        </s-button>
      </s-section>
      <s-section heading="Returns">
        <s-paragraph>
          {returns} returns stored · last synced {shop.returnsSyncedAt ? fmtDate(shop.returnsSyncedAt) : "never"}. New returns arrive automatically via webhooks.
        </s-paragraph>
        <s-button disabled={busy} onClick={() => submit({ intent: "returns" }, { method: "post" })}>
          {busy ? "Syncing…" : "Re-sync returns"}
        </s-button>
      </s-section>
    </s-page>
  );
}
