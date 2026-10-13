import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { getProductsWithReturns } from "../services/analytics.server";
import { parseRange } from "../lib/range";
import { COLORS, Card, Empty, Pager, btn, input, td, th } from "../lib/ui";

const PAGE_SIZE = 25;

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: "#e3f1df", fg: "#1a6b3a" },
  DRAFT: { bg: "#fdf3d0", fg: "#8a6100" },
  ARCHIVED: { bg: "#eceef0", fg: "#52575c" },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams, 90);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const data = await getProductsWithReturns(shop.id, range, { q, page, pageSize: PAGE_SIZE });
  return { ...data, days: range.days, q, page };
};

export default function Products() {
  const { rows, total, pages, page, days, q } = useLoaderData<typeof loader>();
  const link = (o: { days?: number; page?: number }) => {
    const u = new URLSearchParams({ days: String(o.days ?? days) });
    if (q) u.set("q", q);
    if ((o.page ?? 1) > 1) u.set("page", String(o.page));
    return `/app/products?${u}`;
  };
  const pagination = {
    total,
    page,
    pageSize: PAGE_SIZE,
    pages: Math.max(1, pages),
    hasPrev: page > 1,
    hasNext: page < pages,
    from: total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1,
    to: Math.min(page * PAGE_SIZE, total),
  };
  const returnedProducts = rows.filter((p) => p.returned > 0).length;

  return (
    <s-page heading="Products">
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {/* toolbar: title + period presets, then a search that stays a sensible width */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "16px 16px 12px" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{total.toLocaleString("en-IN")} products</div>
            <div style={{ fontSize: 13, color: COLORS.subdued }}>
              Returns in the last {days} days{returnedProducts ? ` · ${returnedProducts} on this page returned` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {[30, 90, 365].map((d) => (
              <Link key={d} to={link({ days: d })} style={btn(d === days ? "primary" : "secondary")}>
                {d === 365 ? "1y" : `${d}d`}
              </Link>
            ))}
          </div>
        </div>

        <Form method="get" style={{ display: "flex", gap: 8, padding: "0 16px 14px" }}>
          <input type="hidden" name="days" value={days} />
          <input name="q" defaultValue={q} placeholder="Search products…" aria-label="Search products" style={{ ...input, width: "100%", maxWidth: 360 }} />
          <button type="submit" style={btn("primary")}>Search</button>
          {q && (
            <Link to={`/app/products?days=${days}`} style={{ ...btn("plain"), color: COLORS.brand }}>
              Clear
            </Link>
          )}
        </Form>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Product</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Variants</th>
                <th style={{ ...th, textAlign: "right" }}>Units returned</th>
                <th style={{ ...th, textAlign: "right" }}>Return requests</th>
                <th style={th}>Top reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const st = STATUS_STYLE[p.status ?? ""] ?? STATUS_STYLE.ARCHIVED;
                return (
                  <tr key={p.id}>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                        {p.imageUrl ? (
                          <img src={p.imageUrl} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} />
                        ) : (
                          <div style={{ width: 44, height: 44, borderRadius: 8, background: COLORS.bg, border: `1px solid ${COLORS.border}`, display: "grid", placeItems: "center", color: COLORS.grey }}>▣</div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{p.title}</div>
                          {p.vendor && <div style={{ fontSize: 12, color: COLORS.subdued }}>{p.vendor}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={td}>
                      {p.status && (
                        <span style={{ background: st.bg, color: st.fg, borderRadius: 10, padding: "2px 10px", fontSize: 12, fontWeight: 600, textTransform: "capitalize" }}>
                          {p.status.toLowerCase()}
                        </span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{p.variants}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {p.returned > 0 ? (
                        <span style={{ background: "#fbeae5", color: "#b4331a", borderRadius: 10, padding: "2px 10px", fontWeight: 700 }}>{p.returned}</span>
                      ) : (
                        <span style={{ color: COLORS.subdued }}>0</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{p.returns}</td>
                    <td style={td}>{p.topReason ?? <span style={{ color: COLORS.subdued }}>—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Empty>No products found. If you just installed, run “Sync products” in Settings.</Empty>}
        <Pager p={pagination} hrefFor={(n) => link({ page: n })} />
      </Card>
    </s-page>
  );
}
