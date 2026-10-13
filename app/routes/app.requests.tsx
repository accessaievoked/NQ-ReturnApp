import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { approveExchangeRequest, declineExchangeRequest } from "../services/portal.server";
import { fmtDate, fmtMoney } from "../lib/format";
import { COLORS, Card, Empty, btn } from "../lib/ui";

type Line = { title: string; variantTitle: string | null; imageUrl: string | null; quantity: number; unitPrice: number; reasonName?: string | null; note?: string | null; photos?: string[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const [pending, recent] = await Promise.all([
    db.exchangeRequest.findMany({ where: { shopId: shop.id, status: "PENDING" }, orderBy: { createdAt: "asc" } }),
    db.exchangeRequest.findMany({ where: { shopId: shop.id, status: { not: "PENDING" } }, orderBy: { decidedAt: "desc" }, take: 10 }),
  ]);
  const shape = (r: (typeof pending)[number]) => ({
    id: r.id,
    code: r.code,
    orderName: r.orderName,
    customerEmail: r.customerEmail,
    status: r.status,
    returning: r.items as unknown as Line[],
    taking: r.replacements as unknown as Line[],
    returnValue: Number(r.returnValue),
    replacementValue: Number(r.replacementValue),
    currency: r.currency,
    flags: (r.flags as unknown as string[] | null) ?? [],
    declineNote: r.declineNote,
    returnId: r.returnId,
    createdAt: r.createdAt.toISOString(),
  });
  return { pending: pending.map(shape), recent: recent.map(shape), shopDomain: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const intent = String(form.get("intent"));
  if (intent === "approve") return { intent, ...(await approveExchangeRequest(session.shop, id, session.shop)) };
  if (intent === "decline") return { intent, ...(await declineExchangeRequest(session.shop, id, String(form.get("note") ?? "") || null)) };
  return { intent, ok: false as const, error: "Unknown action" };
};

function Lines({ rows, currency, label }: { rows: Line[]; currency: string | null; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.subdued, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      {rows.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0" }}>
          {l.imageUrl ? <img src={l.imageUrl} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} /> : <div style={{ width: 48, height: 48, borderRadius: 8, background: COLORS.bg }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{l.title}</div>
            <div style={{ fontSize: 12, color: COLORS.subdued }}>{[l.variantTitle, `Qty ${l.quantity}`, fmtMoney(l.unitPrice, currency)].filter(Boolean).join(" · ")}</div>
            {l.reasonName && <div style={{ fontSize: 12 }}>Reason: {l.reasonName}</div>}
            {l.note && <div style={{ fontSize: 12, fontStyle: "italic", color: COLORS.subdued }}>“{l.note}”</div>}
            {l.photos && l.photos.length > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                {l.photos.map((src) => (
                  <a key={src} href={src} target="_blank" rel="noreferrer"><img src={src} alt="Customer upload" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: `1px solid ${COLORS.border}` }} /></a>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Requests() {
  const { pending, recent, shopDomain } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";
  const orderUrl = (name: string) => `https://${shopDomain}/admin/orders?query=${encodeURIComponent(name)}`;

  return (
    <s-page heading="Exchange requests">
      <div style={{ display: "grid", gap: 16 }}>
        <p style={{ margin: 0, fontSize: 14, color: COLORS.subdued }}>
          Exchanges asked for on your return form wait here until you approve them. Approving creates the exchange in Shopify, and your reverse pickup is booked automatically if you turned that on.
          Plain returns go straight to <Link to="/app/returns?status=REQUESTED">Returns</Link>.
        </p>
        {result && !result.ok && "error" in result && <s-banner tone="critical">{result.error}</s-banner>}
        {result && result.ok && result.intent === "approve" && <s-banner tone="success" dismissible>Exchange approved and created in Shopify.</s-banner>}
        {result && result.ok && result.intent === "decline" && <s-banner tone="success" dismissible>Request declined.</s-banner>}

        {pending.length === 0 ? (
          <Card><Empty>No exchange requests are waiting for you.</Empty></Card>
        ) : (
          pending.map((r) => {
            const diff = r.returnValue - r.replacementValue;
            return (
              <Card
                key={r.id}
                title={
                  <span>
                    {r.code} · <a href={orderUrl(r.orderName)} target="_blank" rel="noreferrer">{r.orderName}</a>
                  </span>
                }
                right={<span style={{ fontSize: 12, color: COLORS.subdued }}>{fmtDate(r.createdAt)}</span>}
              >
                <div style={{ fontSize: 13, color: COLORS.subdued, marginBottom: 8 }}>
                  {r.customerEmail} · <Link to={`/app/returns?q=${encodeURIComponent(r.customerEmail)}`}>their other returns</Link>
                </div>
                {r.flags.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                    {r.flags.map((f) => (
                      <span key={f} style={{ background: "#fdf3d0", color: "#8a6100", borderRadius: 10, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>⚠ {f}</span>
                    ))}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                  <Lines rows={r.returning} currency={r.currency} label="Returning" />
                  <Lines rows={r.taking} currency={r.currency} label="Wants instead" />
                </div>
                <div style={{ background: COLORS.bg, borderRadius: 8, padding: "8px 12px", fontSize: 13, margin: "12px 0" }}>
                  Returning {fmtMoney(r.returnValue, r.currency)} · replacement {fmtMoney(r.replacementValue, r.currency)} ·{" "}
                  <strong>{Math.abs(diff) < 0.005 ? "even exchange" : diff > 0 ? `${fmtMoney(diff, r.currency)} left over (refunded on completion)` : `customer pays ${fmtMoney(-diff, r.currency)} more`}</strong>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    style={btn("primary", busy)}
                    disabled={busy}
                    onClick={() => window.confirm(`Approve exchange ${r.code}? This creates the exchange in Shopify.`) && submit({ intent: "approve", id: r.id }, { method: "post" })}
                  >
                    Approve exchange
                  </button>
                  <button
                    style={btn("danger", busy)}
                    disabled={busy}
                    onClick={() => {
                      const note = window.prompt("Reason for declining (the customer can see this when they check their request):");
                      if (note !== null) submit({ intent: "decline", id: r.id, note }, { method: "post" });
                    }}
                  >
                    Decline
                  </button>
                </div>
              </Card>
            );
          })
        )}

        {recent.length > 0 && (
          <Card title="Recently decided">
            {recent.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 0", borderTop: `1px solid ${COLORS.border}`, fontSize: 13 }}>
                <span>
                  {r.code} · {r.orderName} · {r.customerEmail} —{" "}
                  <strong style={{ color: r.status === "APPROVED" ? COLORS.green : "#d72c0d" }}>{r.status === "APPROVED" ? "approved" : "declined"}</strong>
                  {r.returnId && <> · <Link to={`/app/returns/${r.returnId}`}>open return</Link></>}
                </span>
              </div>
            ))}
          </Card>
        )}
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
