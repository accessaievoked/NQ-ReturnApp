import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { getDashboard } from "../services/analytics.server";
import { currencyContext } from "../services/currency.server";
import { fmtDay, fmtDate, fmtMoney, fmtMoneyCompact, fmtNum } from "../lib/format";
import { parseRange, pctChange, rangeLabel } from "../lib/range";
import { COLORS, Card, CurrencyNote, Delta, Empty, Kpi, LineChart, RangePicker, grid, td, th } from "../lib/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const sp = new URL(request.url).searchParams;
  const range = parseRange(sp, 30);
  const cx = await currencyContext(shop, sp.get("cur"));
  const d = await getDashboard(shop.id, range, cx);
  return {
    ...d,
    synced: { products: !!shop.productsSyncedAt, returns: !!shop.returnsSyncedAt },
  };
};

export default function Dashboard() {
  const { currency, range, current: cur, previous: prev, series, prevSeries, products, stale, pending, activeRules, events, synced } = useLoaderData<typeof loader>();

  const shortcuts = [
    { icon: "⏳", tone: "#eef0ff", n: pending, label: "Pending requests to approve", to: "/app/returns?status=REQUESTED" },
    { icon: "⚠️", tone: "#fff1e3", n: stale, label: "Approved returns not closed for more than 10 days", to: "/app/returns?status=OPEN&to=" + new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10) },
    { icon: "📦", tone: "#e3f1df", n: cur.open, label: "Approved and awaiting close (this period)", to: `/app/returns?status=OPEN&from=${range.fromStr}&to=${range.toStr}&cur=${currency.display}` },
    { icon: "⚡", tone: "#fdf3d0", n: cur.auto, label: "Handled automatically (this period)", to: `/app/returns?auto=1&from=${range.fromStr}&to=${range.toStr}&cur=${currency.display}` },
  ];

  const checklist = [
    { done: synced.products, label: "Sync your product catalog", to: "/app/settings" },
    { done: synced.returns, label: "Sync existing returns", to: "/app/settings" },
    { done: cur.total + prev.total > 0, label: "Receive your first return request", to: "/app/returns" },
    { done: activeRules > 0, label: "Turn on an automation rule", to: "/app/automation" },
    { done: cur.open + cur.closed + cur.declined > 0, label: "Process a return", to: "/app/returns?status=REQUESTED" },
  ];
  const doneCount = checklist.filter((c) => c.done).length;
  const pct = Math.round((doneCount / checklist.length) * 100);

  const labels = series.map((d) => fmtDay(d.day));

  return (
    <s-page heading="Dashboard">
      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span style={{ color: COLORS.subdued, fontSize: 13 }}>{rangeLabel(range)} · compared with the {range.days} days before</span>
          <RangePicker range={range} base="/app" currency={currency} />
        </div>

        <CurrencyNote currency={currency} />

        {(!synced.products || !synced.returns) && (
          <s-banner tone="info" heading="Setting things up">
            We&apos;re syncing your products and existing returns. Check Settings for status.
          </s-banner>
        )}

        <div style={grid(260)}>
          <Kpi
            label="Return value"
            icon="🛒"
            value={fmtMoneyCompact(cur.value, currency.display)}
            delta={<Delta pct={pctChange(cur.value, prev.value)} goodWhen="down" />}
            prev={`Previous: ${fmtMoneyCompact(prev.value, currency.display)}`}
            href={`/app/returns?from=${range.fromStr}&to=${range.toStr}&cur=${currency.display}`}
          />
          <Kpi
            label="Revenue saved"
            icon="💲"
            tint="#e3f1df"
            value={fmtMoneyCompact(cur.saved, currency.display)}
            delta={<Delta pct={pctChange(cur.saved, prev.saved)} goodWhen="up" />}
            prev={`Previous: ${fmtMoneyCompact(prev.saved, currency.display)}`}
            sub="declined + canceled"
          />
          <Kpi
            label="Automations"
            icon="🤖"
            tint="#fff1e3"
            value={`${cur.hoursSaved.toFixed(1)}H`}
            delta={<Delta pct={pctChange(cur.automations, prev.automations)} goodWhen="up" />}
            prev={`${fmtNum(cur.automations)} decisions · prev ${prev.hoursSaved.toFixed(1)}H`}
            href="/app/automation"
          />
        </div>

        <div style={{ ...grid(420), alignItems: "start" }}>
          <div style={{ display: "grid", gap: 16 }}>
            <Card title="Manage your returns" right={<Link to="/app/returns" style={{ fontSize: 13 }}>View all returns</Link>}>
              {shortcuts.map((s, i) => (
                <Link
                  key={s.label}
                  to={s.to}
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 4px", borderTop: i ? `1px solid ${COLORS.border}` : "none", color: "inherit", textDecoration: "none" }}
                >
                  <span style={{ width: 40, height: 40, borderRadius: "50%", background: s.tone, display: "grid", placeItems: "center", fontSize: 18 }}>{s.icon}</span>
                  <strong style={{ width: 40, textAlign: "center", fontSize: 18 }}>{fmtNum(s.n)}</strong>
                  <span style={{ flex: 1, fontSize: 14 }}>{s.label}</span>
                  <span style={{ color: COLORS.green, fontSize: 18 }}>➜</span>
                </Link>
              ))}
            </Card>

            <Card title="Return value over time" hint="Solid line is this period, dashed line is the previous period of the same length, day by day.">
              <LineChart
                labels={labels}
                height={220}
                format={(n) => fmtMoneyCompact(n, currency.display)}
                series={[
                  { name: "This period", color: COLORS.brand, values: series.map((d) => d.value) },
                  { name: "Previous period", color: COLORS.grey, dashed: true, values: prevSeries.map((d) => d.value) },
                ]}
              />
            </Card>

            <Card title="Most refunded products" right={<Link to="/app/analytics" style={{ fontSize: 13 }}>Full analytics</Link>}>
              {products.length === 0 ? (
                <Empty>No returned products in this period.</Empty>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={th}>Product</th>
                      <th style={th}>Qty</th>
                      <th style={th}>Refund value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={`${p.title}${p.variantTitle}${p.sku}`}>
                        <td style={td}>
                          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            {p.imageUrl && <img src={p.imageUrl} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} />}
                            <div>
                              <div>{p.title}</div>
                              <div style={{ color: COLORS.subdued, fontSize: 12 }}>{[p.variantTitle, p.sku].filter(Boolean).join(" · ")}</div>
                            </div>
                          </div>
                        </td>
                        <td style={td}>{p.units}</td>
                        <td style={td}>{fmtMoney(p.value, currency.display)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <div style={{ display: "grid", gap: 16 }}>
            <Card
              title="Account setup"
              right={
                <div style={{ width: 54, height: 54, borderRadius: "50%", display: "grid", placeItems: "center", background: `conic-gradient(${COLORS.brand} ${pct}%, ${COLORS.border} 0)` }}>
                  <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700 }}>{pct}%</div>
                </div>
              }
            >
              {checklist.map((c) => (
                <Link key={c.label} to={c.to} style={{ display: "flex", gap: 10, padding: "6px 0", fontSize: 14, color: "inherit", textDecoration: c.done ? "none" : "underline" }}>
                  <span style={{ color: c.done ? COLORS.green : COLORS.grey }}>{c.done ? "✔" : "○"}</span>
                  {c.label}
                </Link>
              ))}
            </Card>

            <Card title="Period at a glance">
              <Row k="Returns this period" v={`${fmtNum(cur.total)} (prev ${fmtNum(prev.total)})`} />
              <Row k="Avg return value" v={fmtMoney(cur.total ? cur.value / cur.total : 0, currency.display)} />
              <Row k="Units returned" v={fmtNum(cur.units)} />
              <Row k="Active automation rules" v={String(activeRules)} />
            </Card>

            <Card title="Recent activity" right={<span style={{ fontSize: 12, color: COLORS.subdued }}>latest 6</span>}>
              {events.length === 0 ? (
                <Empty>No recent activity.</Empty>
              ) : (
                events.map((e) => (
                  <div key={e.id} style={{ padding: "8px 0", borderTop: `1px solid ${COLORS.border}`, fontSize: 13 }}>
                    <Link to={`/app/returns/${e.return.id}`}>{e.return.name}</Link> — {e.title}
                    <div style={{ color: COLORS.subdued, fontSize: 12 }}>
                      {fmtDate(e.createdAt)}
                      {e.actor ? ` · ${e.actor}` : ""}
                    </div>
                  </div>
                ))
              )}
            </Card>
          </div>
        </div>
      </div>
    </s-page>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: `1px solid ${COLORS.border}`, fontSize: 14 }}>
      <span style={{ color: COLORS.subdued }}>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
