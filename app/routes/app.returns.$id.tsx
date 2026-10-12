import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { addEvent, performReturnAction, type ReturnAction } from "../services/returns.server";
import { STATUS_META, adminOrderUrl, fmtDate, fmtDateLong, fmtMoney } from "../lib/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const ret = await db.returnRequest.findFirst({
    where: { id: params.id, shopId: shop.id },
    include: { items: true, events: { orderBy: { createdAt: "desc" } } },
  });
  if (!ret) throw new Response("Not found", { status: 404 });
  return { ret, shopDomain: session.shop };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const actor = session.shop;

  if (intent === "note") {
    const note = String(form.get("note") ?? "").trim();
    if (note) await addEvent(shop.id, params.id!, { kind: "NOTE", title: "Note", detail: note, actor });
    return { ok: true as const };
  }
  if (["approve", "decline", "close", "reopen"].includes(intent)) {
    return performReturnAction(
      session.shop,
      params.id!,
      intent as ReturnAction,
      actor,
      String(form.get("note") ?? "") || undefined,
    );
  }
  return { ok: false as const, error: "Unknown action" };
};

const card: React.CSSProperties = { border: "1px solid #e1e3e5", borderRadius: 10, padding: 16, background: "#fff" };

export default function ReturnDetail() {
  const { ret, shopDomain } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";
  const meta = STATUS_META[ret.status];
  const send = (intent: string, extra: Record<string, string> = {}) => submit({ intent, ...extra }, { method: "post" });

  const address = ret.shippingAddress as Record<string, string | null> | null;
  const itemsCost = ret.items.reduce((n, i) => n + Number(i.unitPrice ?? 0) * i.quantity, 0);
  const first = ret.items[0];

  // Progress stepper built from status + the first status-change event for each stage.
  const when = (needle: string) =>
    [...ret.events].reverse().find((e) => e.title.toUpperCase().includes(needle))?.createdAt;
  const steps: { label: string; date?: string | Date | null; state: "done" | "current" | "todo" | "bad" }[] = [
    { label: "Request submitted", date: ret.requestedAt, state: "done" },
    ret.status === "REQUESTED"
      ? { label: "Awaiting your review", state: "current" }
      : ret.status === "DECLINED"
        ? { label: "Declined", date: when("DECLINED"), state: "bad" }
        : ret.status === "CANCELED"
          ? { label: "Canceled", state: "bad" }
          : { label: "Approved", date: when("OPEN"), state: "done" },
    ret.status === "CLOSED"
      ? { label: "Closed", date: ret.closedAt, state: "done" }
      : { label: "Closed", state: ret.status === "OPEN" ? "current" : "todo" },
  ];
  const stepColor = { done: "#2c9c5a", current: "#5c6ac4", todo: "#c9cccf", bad: "#d72c0d" };

  const rows: [string, React.ReactNode][] = [
    ["Order", <a key="o" href={adminOrderUrl(shopDomain, ret.orderShopifyId)} target="_blank" rel="noreferrer">{ret.orderName}</a>],
    ["Request type", "Return"],
    ["Status", <s-badge key="s" tone={meta.tone}>{meta.label}</s-badge>],
    ["Reason", first?.reason ?? "—"],
    ["Customer note", first?.customerNote || first?.reasonNote || "—"],
    ["Item cost", fmtMoney(itemsCost, ret.currency)],
    ["Order total paid", fmtMoney(ret.orderTotal?.toString(), ret.currency)],
    ["Payment method", ret.paymentMethod ?? "—"],
    ["Order placed", ret.orderCreatedAt ? fmtDateLong(ret.orderCreatedAt) : "—"],
    ["Submitted on", fmtDate(ret.requestedAt)],
    ...(ret.declineReason ? ([["Decline note", ret.declineNote ?? ret.declineReason]] as [string, string][]) : []),
  ];

  return (
    <s-page heading={`Return ${ret.name}`}>
      <s-link slot="breadcrumb-actions" href="/app/returns">Returns</s-link>
      <s-badge slot="title-metadata" tone={meta.tone}>{meta.label}</s-badge>
      {ret.status === "REQUESTED" && (
        <>
          <s-button slot="primary-action" variant="primary" disabled={busy} onClick={() => send("approve")}>Approve return</s-button>
          <s-button
            slot="secondary-actions"
            tone="critical"
            disabled={busy}
            onClick={() => {
              const note = window.prompt("Reason for declining (shown to customer):");
              if (note !== null) send("decline", { note });
            }}
          >
            Decline
          </s-button>
        </>
      )}
      {ret.status === "OPEN" && <s-button slot="primary-action" disabled={busy} onClick={() => send("close")}>Close return</s-button>}
      {ret.status === "CLOSED" && <s-button slot="primary-action" disabled={busy} onClick={() => send("reopen")}>Reopen</s-button>}

      {result && !result.ok && "error" in result && (
        <s-banner tone="critical" heading="Shopify rejected that action">{result.error}</s-banner>
      )}

      {/* Progress */}
      <div style={{ ...card, display: "flex", alignItems: "flex-start" }}>
        {steps.map((s, i) => (
          <div key={s.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", position: "relative", textAlign: "center" }}>
            {i > 0 && <div style={{ position: "absolute", top: 13, right: "50%", width: "100%", height: 3, background: steps[i - 1].state === "done" ? "#2c9c5a" : "#e1e3e5" }} />}
            <div style={{ zIndex: 1, width: 28, height: 28, borderRadius: "50%", background: stepColor[s.state], color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700 }}>
              {s.state === "done" ? "✓" : s.state === "bad" ? "✕" : i + 1}
            </div>
            <strong style={{ marginTop: 6, fontSize: 13 }}>{s.label}</strong>
            <span style={{ fontSize: 12, color: "#6d7175" }}>{s.date ? fmtDate(s.date) : "—"}</span>
          </div>
        ))}
      </div>

      {/* Details + items */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
        <div style={card}>
          <h3 style={{ margin: "0 0 8px" }}>Details</h3>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderTop: "1px solid #f0f1f2", fontSize: 14 }}>
              <span style={{ color: "#6d7175" }}>{k}</span>
              <span style={{ textAlign: "right", fontWeight: 500 }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          {ret.items.map((i) => (
            <div key={i.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                <div>
                  <strong>{i.title}</strong>
                  <div style={{ fontSize: 13, color: "#6d7175" }}>
                    {[i.variantTitle, i.sku && `SKU ${i.sku}`, `Qty ${i.quantity}`, fmtMoney(i.unitPrice?.toString(), ret.currency)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <s-badge>{i.reason ?? "No reason"}</s-badge>
              </div>
              {i.customerNote && (
                <div style={{ background: "#f6f6f7", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontStyle: "italic" }}>“{i.customerNote}”</div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <ImagePanel title="Customer's photos">
                  {(i.customerImages ?? []).length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {(i.customerImages ?? []).map((src) => (
                        <a key={src} href={src} target="_blank" rel="noreferrer">
                          <img src={src} alt="Customer upload" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} />
                        </a>
                      ))}
                    </div>
                  ) : (
                    <Empty text="No images uploaded" />
                  )}
                </ImagePanel>
                <ImagePanel title="Product image">
                  {i.imageUrl ? (
                    <img src={i.imageUrl} alt={i.title} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} />
                  ) : (
                    <Empty text="No product image" />
                  )}
                </ImagePanel>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Customer + activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
        <div style={card}>
          <h3 style={{ margin: "0 0 8px" }}>Customer</h3>
          <Line k="Name" v={ret.customerName} />
          <Line k="Email" v={ret.customerEmail} />
          <Line k="Phone" v={ret.customerPhone} />
          <Line
            k="Shipping address"
            v={address ? [address.address1, address.address2, address.city, address.province, address.zip, address.country].filter(Boolean).join(", ") : null}
          />
        </div>

        <div style={card}>
          <h3 style={{ margin: "0 0 8px" }}>Activity</h3>
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              send("note", { note: new FormData(e.currentTarget).get("note") as string });
              e.currentTarget.reset();
            }}
          >
            <input name="note" placeholder="Add a note and press enter…" style={{ width: "100%", padding: 8, marginBottom: 12, boxSizing: "border-box" }} />
          </form>
          <div style={{ display: "grid", gap: 8 }}>
            {ret.events.map((e) => (
              <div key={e.id} style={{ borderLeft: `3px solid ${e.kind === "NOTE" ? "#e0a800" : e.kind === "ACTION" ? "#5c6ac4" : "#c9cccf"}`, padding: "2px 10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{e.title}</strong>
                  <span style={{ fontSize: 12, color: "#6d7175" }}>{fmtDate(e.createdAt)}</span>
                </div>
                {e.detail && <div style={{ fontSize: 13 }}>{e.detail}</div>}
                {e.actor && <div style={{ fontSize: 12, color: "#6d7175" }}>{e.actor}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </s-page>
  );
}

function ImagePanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ height: 96, display: "grid", placeItems: "center", background: "#f6f6f7", borderRadius: 8, color: "#6d7175", fontSize: 13 }}>
      {text}
    </div>
  );
}

function Line({ k, v }: { k: string; v?: string | null }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid #f0f1f2", fontSize: 14 }}>
      <span style={{ color: "#6d7175" }}>{k}</span>
      <span style={{ textAlign: "right" }}>{v || "—"}</span>
    </div>
  );
}
