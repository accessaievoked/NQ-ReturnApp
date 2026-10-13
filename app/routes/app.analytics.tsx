import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { getAnalytics } from "../services/analytics.server";
import { currencyContext } from "../services/currency.server";
import { downloadCsv } from "../lib/csv";
import { fmtDay, fmtDuration, fmtMoney, fmtMoneyCompact, fmtNum } from "../lib/format";
import { parseRange, pctChange, rangeLabel } from "../lib/range";
import { BarList, COLORS, Card, CurrencyNote, Delta, Donut, Empty, Kpi, LineChart, RangePicker, btn, grid, td, th } from "../lib/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const sp = new URL(request.url).searchParams;
  const geo = sp.get("geo") === "city" ? "city" : "province";
  const cx = await currencyContext(shop, sp.get("cur"));
  const data = await getAnalytics(shop.id, parseRange(sp, 30), cx, geo);
  return { ...data, geo };
};

const STATUS_SLICES = [
  ["open", "Approved"],
  ["closed", "Closed"],
  ["requested", "Awaiting review"],
  ["declined", "Declined"],
  ["canceled", "Canceled"],
] as const;

export default function Analytics() {
  const { currency, range, current: c, previous: p, series, prevSeries, reasons, products, customers, categories, regions, payments, geo } = useLoaderData<typeof loader>();
  const labels = series.map((d) => fmtDay(d.day));
  const decided = c.open + c.closed + c.declined;
  const prevDecided = p.open + p.closed + p.declined;
  const approvalRate = decided ? ((c.open + c.closed) / decided) * 100 : 0;
  const prevApprovalRate = prevDecided ? ((p.open + p.closed) / prevDecided) * 100 : 0;
  const perOrder = c.total ? c.value / c.total : 0;
  const prevPerOrder = p.total ? p.value / p.total : 0;
  const totalReasonUnits = reasons.reduce((n, r) => n + r.units, 0);
  const keep = { ...(range.preset ? { days: String(range.preset) } : { from: range.fromStr, to: range.toStr }), cur: currency.display };
  const geoLink = (g: string) => `/app/analytics?${new URLSearchParams({ ...keep, geo: g })}`;

  return (
    <s-page heading="Analytics">
      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span style={{ color: COLORS.subdued, fontSize: 13 }}>
            Insights to reduce your returns and improve profits · {rangeLabel(range)} vs the {range.days} days before
          </span>
          <RangePicker range={range} base="/app/analytics" keep={geo === "city" ? { geo } : {}} currency={currency} />
        </div>

        <CurrencyNote currency={currency} />

        <div style={grid(230, 14)}>
          <Kpi label="Total returns" icon="🚚" value={fmtNum(c.total)} delta={<Delta pct={pctChange(c.total, p.total)} goodWhen="down" />} prev={`Previous: ${fmtNum(p.total)}`} />
          <Kpi label="Return value" icon="🛒" tint="#fff1e3" value={fmtMoneyCompact(c.value, currency.display)} delta={<Delta pct={pctChange(c.value, p.value)} goodWhen="down" />} prev={`Previous: ${fmtMoneyCompact(p.value, currency.display)}`} />
          <Kpi label="Return value per order" icon="📉" tint="#fde8ec" value={fmtMoney(Math.round(perOrder * 100) / 100, currency.display)} delta={<Delta pct={pctChange(perOrder, prevPerOrder)} goodWhen="down" />} prev={`Previous: ${fmtMoney(Math.round(prevPerOrder * 100) / 100, currency.display)}`} />
          <Kpi label="Revenue saved" icon="💲" tint="#e3f1df" value={fmtMoneyCompact(c.saved, currency.display)} delta={<Delta pct={pctChange(c.saved, p.saved)} goodWhen="up" />} prev={`Previous: ${fmtMoneyCompact(p.saved, currency.display)}`} />
          <Kpi label="Approval rate" icon="✅" tint="#e3f1df" value={`${approvalRate.toFixed(1)}%`} delta={<Delta pct={pctChange(approvalRate, prevApprovalRate)} goodWhen="down" />} sub={`${decided} decided`} />
          <Kpi label="Avg response time" icon="⏱️" tint="#eef0ff" value={fmtDuration(c.responseHours)} sub="request → approve/decline" prev={`Previous: ${fmtDuration(p.responseHours)}`} />
          <Kpi label="Avg time to close" icon="📦" tint="#fdf3d0" value={fmtDuration(c.closeTatHours)} prev={`Previous: ${fmtDuration(p.closeTatHours)}`} />
          <Kpi label="Automations" icon="🤖" tint="#fff1e3" value={`${c.hoursSaved.toFixed(1)}H saved`} sub={`${fmtNum(c.automations)} decisions`} delta={<Delta pct={pctChange(c.automations, p.automations)} goodWhen="up" />} />
        </div>

        <Card title="Requests over time" hint="Return requests per day, split by what happened to them.">
          <LineChart
            labels={labels}
            minMax={4}
            series={[
              { name: "Requests", color: COLORS.blue, values: series.map((d) => d.count) },
              { name: "Approved / closed", color: COLORS.green, values: series.map((d) => d.approved) },
              { name: "Declined", color: COLORS.pink, values: series.map((d) => d.declined) },
            ]}
          />
        </Card>

        <div style={{ ...grid(420), alignItems: "start" }}>
          <Card title="Return value" hint="Money tied up in return requests. Dashed = the previous period, day by day.">
            <LineChart
              labels={labels}
              height={230}
              minMax={1000}
              format={(n) => fmtMoneyCompact(n, currency.display)}
              series={[
                { name: "This period", color: COLORS.brand, values: series.map((d) => d.value) },
                { name: "Previous period", color: COLORS.grey, dashed: true, values: prevSeries.map((d) => d.value) },
              ]}
            />
          </Card>
          <Card title="Revenue saved" hint="Value of returns you declined or that customers canceled — refunds you did not pay out.">
            <LineChart
              labels={labels}
              height={230}
              minMax={1000}
              format={(n) => fmtMoneyCompact(n, currency.display)}
              series={[
                { name: "This period", color: COLORS.green, values: series.map((d) => d.saved) },
                { name: "Previous period", color: COLORS.grey, dashed: true, values: prevSeries.map((d) => d.saved) },
              ]}
            />
          </Card>
        </div>

        <div style={{ ...grid(420), alignItems: "start" }}>
          <Card title="Top return reasons" hint="Share of returned units by the reason the customer gave.">
            <Donut slices={reasons.map((r) => ({ label: r.reason, value: r.units }))} centerLabel="units" />
          </Card>
          <Card title="Returns by resolution" hint="Where this period's requests stand right now.">
            <Donut slices={STATUS_SLICES.map(([k, label]) => ({ label, value: c[k] }))} centerLabel="requests" />
          </Card>
        </div>

        <Card
          title="Most returned products"
          hint="Ranked by value returned. Share = this product's share of all returned units."
          right={
            <button
              type="button"
              style={btn("secondary")}
              onClick={() =>
                downloadCsv(
                  `most-returned-products-${range.fromStr}-${range.toStr}.csv`,
                  products.map((x) => ({ product: x.title, variant: x.variantTitle ?? "", sku: x.sku ?? "", returns: x.returns, units: x.units, [`value_${currency.display}`]: Math.round(x.value * 100) / 100, topReason: x.topReason ?? "" })),
                )
              }
            >
              Download report ⤓
            </button>
          }
        >
          {products.length === 0 ? (
            <Empty>No returned products in this period.</Empty>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Product", "SKU", "Returns", "Units", "Share", "Return value", "Top reason"].map((h) => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {products.map((x) => (
                    <tr key={`${x.title}${x.variantTitle}${x.sku}`}>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          {x.imageUrl && <img src={x.imageUrl} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} />}
                          <div>
                            <div>{x.title}</div>
                            {x.variantTitle && <div style={{ color: COLORS.subdued, fontSize: 12 }}>{x.variantTitle}</div>}
                          </div>
                        </div>
                      </td>
                      <td style={td}>{x.sku ?? "—"}</td>
                      <td style={td}>{x.returns}</td>
                      <td style={td}>{x.units}</td>
                      <td style={td}>{totalReasonUnits ? `${((x.units / totalReasonUnits) * 100).toFixed(1)}%` : "—"}</td>
                      <td style={td}>{fmtMoney(x.value, currency.display)}</td>
                      <td style={td}>{x.topReason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div style={{ ...grid(420), alignItems: "start" }}>
          <Card title="Customers that return the most" hint="Grouped by email. Useful for spotting serial returners — you can auto-decline them in Automation.">
            {customers.length === 0 ? (
              <Empty>No data in this period.</Empty>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Customer</th>
                    <th style={th}>Returns</th>
                    <th style={th}>Return value</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((x) => (
                    <tr key={x.email ?? x.name}>
                      <td style={td}>
                        <div>{x.name ?? "—"}</div>
                        <div style={{ color: COLORS.subdued, fontSize: 12 }}>{x.email}</div>
                      </td>
                      <td style={td}>
                        {x.email ? <Link to={`/app/returns?q=${encodeURIComponent(x.email)}`}>{x.returns}</Link> : x.returns}
                      </td>
                      <td style={td}>{fmtMoney(x.value, currency.display)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Top returned categories" hint="By product type, in returned units.">
            <Donut slices={categories.map((x) => ({ label: x.label, value: x.count }))} centerLabel="units" />
          </Card>
        </div>

        <div style={{ ...grid(420), alignItems: "start" }}>
          <Card
            title="Return rate by region"
            hint="Where returns ship from, using the order's shipping address."
            right={
              <div style={{ display: "flex", gap: 6 }}>
                <Link to={geoLink("province")} style={btn(geo === "province" ? "primary" : "secondary")}>State</Link>
                <Link to={geoLink("city")} style={btn(geo === "city" ? "primary" : "secondary")}>City</Link>
              </div>
            }
          >
            <BarList
              rows={regions.map((r) => ({ label: r.label, value: r.count, display: `${r.count} return${r.count === 1 ? "" : "s"}`, sub: fmtMoneyCompact(r.value, currency.display) }))}
              color={COLORS.blue}
            />
          </Card>
          <Card title="Payment mode" hint="Cash-on-delivery orders often return at a higher rate than prepaid ones.">
            <Donut slices={payments.map((x) => ({ label: x.label, value: x.count }))} centerLabel="requests" />
          </Card>
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
