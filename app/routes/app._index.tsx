import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { getOverview, rangeFromDays } from "../services/analytics.server";
import { STATUS_META, fillDays, fmtDay } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
  const overview = await getOverview(shop.id, rangeFromDays(days));
  return { days, overview, synced: !!shop.productsSyncedAt };
};

export default function Dashboard() {
  const { days, overview, synced } = useLoaderData<typeof loader>();
  const series = fillDays(overview.daily, days);
  const maxDaily = Math.max(1, ...series.map((d) => d.count));
  const labelEvery = Math.ceil(series.length / 8);
  const maxReason = Math.max(1, ...overview.reasons.map((r) => r.quantity));

  return (
    <s-page heading="Returns dashboard">
      {[7, 30, 90].map((d) => (
        <s-button key={d} slot="secondary-actions" href={`/app?days=${d}`} variant={d === days ? "primary" : "secondary"}>
          {d}d
        </s-button>
      ))}

      {!synced && (
        <s-banner tone="info" heading="Setting things up">
          We're syncing your products and existing returns. Check Settings for status.
        </s-banner>
      )}

      <s-section heading={`Last ${days} days`}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Stat label="Total returns" value={overview.total} />
          <Stat label="Items returned" value={overview.itemsReturned} />
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <Stat key={key} label={meta.label} value={overview.counts[key] ?? 0} />
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Return requests per day">
        {overview.total === 0 ? (
          <s-paragraph>No returns in this period.</s-paragraph>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 140, borderBottom: "1px solid #d0d0d0" }}>
              {series.map((d) => (
                <div
                  key={d.day}
                  title={`${fmtDay(d.day)}: ${d.count} return${d.count === 1 ? "" : "s"}`}
                  style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%" }}
                >
                  {d.count > 0 && <span style={{ fontSize: 11, fontWeight: 600 }}>{d.count}</span>}
                  <div style={{ width: "100%", maxWidth: 28, height: d.count ? `${(d.count / maxDaily) * 100}px` : 2, background: d.count ? "#5c6ac4" : "#e3e3e3", borderRadius: "3px 3px 0 0" }} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
              {series.map((d, i) => (
                <div key={d.day} style={{ flex: 1, fontSize: 10, textAlign: "center", color: "#6d7175", whiteSpace: "nowrap", overflow: "visible" }}>
                  {i % labelEvery === 0 ? fmtDay(d.day) : ""}
                </div>
              ))}
            </div>
          </div>
        )}
      </s-section>

      <s-section heading="Why are customers returning?">
        {overview.reasons.length === 0 ? (
          <s-paragraph>No data yet.</s-paragraph>
        ) : (
          <s-stack gap="small-200">
            {overview.reasons.map((r) => (
              <div key={r.reason} style={{ display: "grid", gridTemplateColumns: "220px 1fr 40px", gap: 8, alignItems: "center" }}>
                <span>{r.reason}</span>
                <div style={{ background: "#e3e3e3", borderRadius: 4 }}>
                  <div style={{ width: `${(r.quantity / maxReason) * 100}%`, height: 10, background: "#5c6ac4", borderRadius: 4 }} />
                </div>
                <strong>{r.quantity}</strong>
              </div>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
    </s-box>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
