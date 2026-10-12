import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { getProductsWithReturns, rangeFromDays } from "../services/analytics.server";

const STATUS_TONE: Record<string, "success" | "neutral" | "caution"> = {
  ACTIVE: "success",
  DRAFT: "caution",
  ARCHIVED: "neutral",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") ?? 90);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const data = await getProductsWithReturns(shop.id, rangeFromDays(days), { q, page });
  return { ...data, days, q, page };
};

export default function Products() {
  const { rows, total, pages, page, days, q } = useLoaderData<typeof loader>();
  const link = (o: Record<string, string | number>) => {
    const u = new URLSearchParams({ days: String(days), ...(q ? { q } : {}), page: String(page), ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) });
    return `/app/products?${u}`;
  };

  return (
    <s-page heading="Products">
      {[30, 90, 365].map((d) => (
        <s-button key={d} slot="secondary-actions" href={link({ days: d, page: 1 })} variant={d === days ? "primary" : "secondary"}>
          {d}d
        </s-button>
      ))}
      <s-section padding="none" heading={`${total} products · returns in the last ${days} days`}>
        <form method="get" style={{ padding: "0 16px 12px" }}>
          <input type="hidden" name="days" value={days} />
          <input name="q" defaultValue={q} placeholder="Search products…" style={{ width: "100%", padding: 8 }} />
        </form>
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Variants</s-table-header>
            <s-table-header>Units returned</s-table-header>
            <s-table-header>Return requests</s-table-header>
            <s-table-header>Top reason</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    {p.imageUrl ? <s-thumbnail src={p.imageUrl} alt={p.title} size="small" /> : <s-thumbnail alt="" size="small" />}
                    <s-stack gap="small-500">
                      <strong>{p.title}</strong>
                      {p.vendor && <s-text color="subdued">{p.vendor}</s-text>}
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {p.status && <s-badge tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status.toLowerCase()}</s-badge>}
                </s-table-cell>
                <s-table-cell>{p.variants}</s-table-cell>
                <s-table-cell>{p.returned > 0 ? <strong>{p.returned}</strong> : "0"}</s-table-cell>
                <s-table-cell>{p.returns}</s-table-cell>
                <s-table-cell>{p.topReason ?? "—"}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <s-box padding="large">
            <s-paragraph>No products found. If you just installed, run "Sync products" in Settings.</s-paragraph>
          </s-box>
        )}
        <s-stack direction="inline" gap="small-200" padding="base" justifyContent="end">
          {page > 1 && <s-button href={link({ page: page - 1 })}>Previous</s-button>}
          {page < pages && <s-button href={link({ page: page + 1 })}>Next</s-button>}
        </s-stack>
      </s-section>
    </s-page>
  );
}
