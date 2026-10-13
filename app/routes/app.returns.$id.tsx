import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { addEvent, completeExchange, ingestReturn, issueRefund, markReceived, performReturnAction, saveTracking, type ReturnAction } from "../services/returns.server";
import { convert, currencyContext, publicCurrency } from "../services/currency.server";
import { saveCurrency } from "../lib/currency-pref";
import { REFUND_META, SHIPMENT_META, exchangeStatusOf, refundStatusOf, trackingUrl } from "../lib/return-meta";
import { COLORS, Card, CurrencyNote, btn, cardStyle, input } from "../lib/ui";
import { STATUS_META, adminOrderUrl, fmtDate, fmtDateLong, fmtMoney } from "../lib/format";

type ExchangeItem = { id: string; title: string; variantTitle: string | null; sku: string | null; imageUrl: string | null; quantity: number; processedQuantity: number; unitPrice: number };

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const load = () =>
    db.returnRequest.findFirst({
      where: { id: params.id, shopId: shop.id },
      include: { items: true, events: { orderBy: { createdAt: "desc" } } },
    });
  let ret = await load();
  if (!ret) throw new Response("Not found", { status: 404 });
  // An exchange saved before we stored replacement details (or created in Shopify admin): fetch them now instead of
  // making the merchant hunt for a Sync button. Best effort — the page still renders if Shopify is unreachable.
  if (ret.exchangeUnits > 0 && !(Array.isArray(ret.exchangeItems) && ret.exchangeItems.length)) {
    try {
      await ingestReturn(session.shop, ret.shopifyId, "Shopify", { automate: false });
      ret = (await load()) ?? ret;
    } catch (err) {
      console.error("Exchange refresh failed", err);
    }
  }
  // Prisma Decimals can't cross to the browser (they arrived as objects -> "NaN"), so turn every money field into a
  // plain number here, converted to the display currency. Only the view changes; the stored values stay as they are.
  const cx = await currencyContext(shop, new URL(request.url).searchParams.get("cur"));
  const from = ret.currency ?? cx.base;
  const money = (v: unknown) => (v == null ? null : convert(Number(v), from, cx.display, cx.rates));
  const refundStatus = refundStatusOf({ status: ret.status, returnValue: Number(ret.returnValue), refundedAmount: Number(ret.refundedAmount), exchangeUnits: ret.exchangeUnits });
  const exchangeItems = ((ret.exchangeItems as ExchangeItem[] | null) ?? []).map((e) => ({ ...e, unitPrice: money(e.unitPrice) ?? 0 }));
  return {
    ret: {
      ...ret,
      orderTotal: money(ret.orderTotal),
      returnValue: money(ret.returnValue),
      refundedAmount: money(ret.refundedAmount) ?? 0,
      items: ret.items.map((i) => ({ ...i, unitPrice: money(i.unitPrice) })),
      exchangeItems,
    },
    refundStatus,
    exchangeStatus: exchangeStatusOf(ret),
    shopDomain: session.shop,
    currency: publicCurrency(cx),
  };
};

const SUCCESS: Record<string, string> = {
  approve: "Return approved.",
  decline: "Return rejected.",
  close: "Return closed.",
  reopen: "Return reopened.",
  refund: "Refund issued through Shopify. The customer has been notified.",
  exchange: "Exchange completed.",
  tracking: "Tracking saved.",
  received: "Marked as received.",
  note: "Note added.",
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const actor = session.shop;
  const id = params.id!;

  try {
    if (intent === "note") {
      const note = String(form.get("note") ?? "").trim();
      if (note) await addEvent(shop.id, id, { kind: "NOTE", title: "Note", detail: note, actor });
      return { ok: true as const, intent };
    }
    if (intent === "exchange") return { intent, ...(await completeExchange(session.shop, id, actor)) };
    if (intent === "refund") return { intent, ...(await issueRefund(session.shop, id, actor)) };
    if (intent === "received") return { intent, ...(await markReceived(session.shop, id, actor)) };
    if (intent === "tracking") {
      const res = await saveTracking(
        session.shop,
        id,
        { number: String(form.get("number") ?? ""), carrier: String(form.get("carrier") ?? ""), url: String(form.get("url") ?? "") },
        actor,
      );
      return { intent, ...res };
    }
    if (["approve", "decline", "close", "reopen"].includes(intent)) {
      return { intent, ...(await performReturnAction(session.shop, id, intent as ReturnAction, actor, String(form.get("note") ?? "") || undefined)) };
    }
  } catch (err) {
    return { intent, ok: false as const, error: err instanceof Error ? err.message : "Something went wrong." };
  }
  return { intent, ok: false as const, error: "Unknown action" };
};

const sub: CSSProperties = { fontSize: 12, color: COLORS.subdued };

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "11px 0", borderTop: `1px solid ${COLORS.border}`, fontSize: 14 }}>
      <span style={{ color: COLORS.subdued, flexShrink: 0 }}>{k}</span>
      <span style={{ textAlign: "right", fontWeight: 500, wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

export default function ReturnDetail() {
  const { ret, refundStatus, exchangeStatus, shopDomain, currency } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";
  const [editingTracking, setEditingTracking] = useState(false);
  const meta = STATUS_META[ret.status];
  const ship = ret.shipmentStatus ? SHIPMENT_META[ret.shipmentStatus] : null;
  const refund = REFUND_META[refundStatus];
  const money = (n: number | null | undefined) => fmtMoney(n, currency.display);
  const send = (intent: string, extra: Record<string, string> = {}) => submit({ intent, ...extra }, { method: "post" });

  // close the tracking form once the save went through
  useEffect(() => {
    if (result && result.intent === "tracking" && result.ok) setEditingTracking(false);
  }, [result]);

  const address = ret.shippingAddress as Record<string, string | null> | null;
  const itemsCost = ret.items.reduce((n, i) => n + Number(i.unitPrice ?? 0) * i.quantity, 0);
  const first = ret.items[0];
  const isExchange = ret.exchangeUnits > 0;
  const replacements = ret.exchangeItems;
  const replacementValue = replacements.reduce((n, e) => n + e.unitPrice * e.quantity, 0);
  const difference = itemsCost - replacementValue; // > 0: leftover to refund, < 0: customer owes
  const canRefund = ret.status === "OPEN" && !isExchange && refundStatus !== "REFUNDED";
  const canCompleteExchange = ret.status === "OPEN" && isExchange && exchangeStatus !== "DONE";

  // Progress: request → decision → shipment → refund → closed, each stage with its date when we know it.
  const when = (needle: string) => [...ret.events].reverse().find((e) => e.title.toUpperCase().includes(needle))?.createdAt;
  const declined = ret.status === "DECLINED" || ret.status === "CANCELED";
  const steps: { label: string; date?: string | Date | null; state: "done" | "current" | "todo" | "bad" }[] = [
    { label: "Requested", date: ret.requestedAt, state: "done" },
    declined
      ? { label: ret.status === "DECLINED" ? "Declined" : "Canceled", date: when(ret.status), state: "bad" }
      : ret.status === "REQUESTED"
        ? { label: "Awaiting review", state: "current" }
        : { label: "Approved", date: when("OPEN"), state: "done" },
    ...(declined
      ? []
      : [
          { label: "In transit", state: ret.shipmentStatus === "IN_TRANSIT" ? ("current" as const) : ret.shipmentStatus === "RECEIVED" ? ("done" as const) : ("todo" as const) },
          { label: "Received", state: ret.shipmentStatus === "RECEIVED" ? ("done" as const) : ("todo" as const) },
          isExchange
            ? { label: "Exchange complete", date: ret.refundedAt, state: exchangeStatus === "DONE" ? ("done" as const) : ("todo" as const) }
            : { label: "Refunded", date: ret.refundedAt, state: refundStatus === "REFUNDED" ? ("done" as const) : refundStatus === "PARTIAL" ? ("current" as const) : ("todo" as const) },
          { label: "Closed", date: ret.closedAt, state: ret.status === "CLOSED" ? ("done" as const) : ("todo" as const) },
        ]),
  ];
  const stepColor = { done: COLORS.green, current: COLORS.brand, todo: COLORS.grey, bad: "#d72c0d" };

  const banner =
    result && !result.ok && "error" in result ? (
      <s-banner tone="critical" heading="That didn't go through">{result.error}</s-banner>
    ) : result && result.ok && "warning" in result && result.warning ? (
      <s-banner tone="warning">{result.warning}</s-banner>
    ) : result && result.ok ? (
      <s-banner tone="success" dismissible>{("message" in result && result.message) || SUCCESS[result.intent] || "Done."}</s-banner>
    ) : null;

  return (
    <s-page heading={`Return ${ret.name}`}>
      <s-link slot="breadcrumb-actions" href="/app/returns">Returns</s-link>
      <s-badge slot="title-metadata" tone={meta.tone}>{meta.label}</s-badge>

      <div style={{ display: "grid", gap: 16 }}>
        {/* action bar: only the actions that make sense for the current state */}
        <div style={{ ...cardStyle, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {ret.status === "REQUESTED" && (
              <>
                <button style={btn("primary", busy)} disabled={busy} onClick={() => send("approve")}>Approve return</button>
                <button
                  style={btn("danger", busy)}
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt("Reason for rejecting (shown to the customer):");
                    if (note !== null) send("decline", { note });
                  }}
                >
                  Reject request
                </button>
              </>
            )}
            {ret.status === "OPEN" && (
              <>
                {canCompleteExchange && (
                  <button
                    style={btn("primary", busy)}
                    disabled={busy}
                    onClick={() =>
                      window.confirm(
                        `Complete this exchange?\n\nThe customer gets: ${replacements.map((e) => `${e.title}${e.variantTitle ? ` (${e.variantTitle})` : ""} ×${e.quantity}`).join(", ") || "the replacement items"}.\n` +
                          (difference > 0.005
                            ? `Returned items are worth ${money(itemsCost)} and the replacement ${money(replacementValue)}, so about ${money(difference)} will be refunded to the original payment.`
                            : difference < -0.005
                              ? `The replacement costs ${money(-difference)} more. Nothing is charged here; collect it from the order in Shopify.`
                              : "Same value, so no money moves.") +
                          "\n\nShopify will email the customer.",
                      ) && send("exchange")
                    }
                  >
                    Complete exchange
                  </button>
                )}
                {canRefund && (
                  <button
                    style={btn("primary", busy)}
                    disabled={busy}
                    onClick={() => window.confirm(`Refund the returned items (about ${money(itemsCost)}) to the customer's original payment method?\n\nShopify will process the refund and email the customer. This can't be undone.`) && send("refund")}
                  >
                    Issue refund
                  </button>
                )}
                <button style={btn("secondary", busy)} disabled={busy} onClick={() => setEditingTracking((v) => !v)}>
                  {ret.awb ? "Edit tracking" : "Add tracking"}
                </button>
                {ret.shipmentStatus !== "RECEIVED" && (
                  <button style={btn("secondary", busy)} disabled={busy} onClick={() => window.confirm("Mark the return parcel as received?") && send("received")}>
                    Mark as received
                  </button>
                )}
                <button style={btn("secondary", busy)} disabled={busy} onClick={() => send("close")}>Close return</button>
              </>
            )}
            {ret.status === "CLOSED" && <button style={btn("secondary", busy)} disabled={busy} onClick={() => send("reopen")}>Reopen</button>}
            {(ret.status === "DECLINED" || ret.status === "CANCELED") && <span style={sub}>This request is {meta.label.toLowerCase()} — no further actions.</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a href={adminOrderUrl(shopDomain, ret.orderShopifyId)} target="_blank" rel="noreferrer" style={{ ...btn("plain"), color: COLORS.brand }}>View order in Shopify ↗</a>
            <Form method="get">
              <select
                name="cur"
                value={currency.display}
                onChange={(e) => {
                  saveCurrency(e.currentTarget.value);
                  e.currentTarget.form?.requestSubmit();
                }}
                style={input}
                aria-label="Display currency"
              >
                {currency.options.map((c) => (
                  <option key={c} value={c}>{c}{c === currency.base ? " (store)" : ""}</option>
                ))}
              </select>
            </Form>
          </div>
        </div>
        <CurrencyNote currency={currency} />
        {banner}

        {/* progress */}
        <div style={{ ...cardStyle, display: "flex", alignItems: "flex-start", overflowX: "auto" }}>
          {steps.map((s, i) => (
            <div key={s.label} style={{ flex: 1, minWidth: 96, display: "flex", flexDirection: "column", alignItems: "center", position: "relative", textAlign: "center" }}>
              {i > 0 && <div style={{ position: "absolute", top: 13, right: "50%", width: "100%", height: 3, background: steps[i - 1].state === "done" && s.state !== "todo" ? COLORS.green : COLORS.border }} />}
              <div style={{ zIndex: 1, width: 28, height: 28, borderRadius: "50%", background: stepColor[s.state], color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700 }}>
                {s.state === "done" ? "✓" : s.state === "bad" ? "✕" : i + 1}
              </div>
              <strong style={{ marginTop: 6, fontSize: 13 }}>{s.label}</strong>
              <span style={sub}>{s.date ? fmtDate(s.date) : "—"}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
          {/* details */}
          <Card title="Details">
            <Row k="Order"><a href={adminOrderUrl(shopDomain, ret.orderShopifyId)} target="_blank" rel="noreferrer">{ret.orderName}</a></Row>
            <Row k="Request type">
              <s-badge tone={ret.exchangeUnits > 0 ? "info" : "neutral"}>{ret.exchangeUnits > 0 ? "Exchange" : "Return"}</s-badge>
              {exchangeStatus && <div style={sub}>{exchangeStatus === "DONE" ? "Exchange complete" : "Exchange pending"}</div>}
            </Row>
            <Row k="Status"><s-badge tone={meta.tone}>{meta.label}</s-badge></Row>
            <Row k="Reason">{first?.reason ?? "—"}</Row>
            <Row k="Customer note">{first?.customerNote || first?.reasonNote || "—"}</Row>
            <Row k="Item cost">{money(itemsCost)}</Row>
            <Row k="Order total paid">{money(ret.orderTotal)}</Row>
            {isExchange && (
              <Row k="Exchange">
                <s-badge tone={exchangeStatus === "DONE" ? "success" : "caution"}>{exchangeStatus === "DONE" ? "Complete" : "Pending"}</s-badge>
              </Row>
            )}
            <Row k={isExchange ? "Leftover refund" : "Refund"}>
              {isExchange && ret.refundedAmount === 0 ? (
                <span style={{ color: COLORS.subdued }}>None</span>
              ) : (
                <s-badge tone={refund.tone}>{refund.label}</s-badge>
              )}
              {ret.refundedAmount > 0 && <div style={sub}>{money(ret.refundedAmount)}{ret.refundedAt ? ` · ${fmtDateLong(ret.refundedAt)}` : ""}</div>}
            </Row>
            <Row k="Payment method">{ret.paymentMethod ?? "—"}</Row>
            <Row k="Handled by">{ret.autoHandled ? "⚡ Automation rule" : ret.status === "REQUESTED" ? "Awaiting review" : "Merchant"}</Row>
            <Row k="Order placed">{ret.orderCreatedAt ? fmtDateLong(ret.orderCreatedAt) : "—"}</Row>
            <Row k="Submitted on">{fmtDate(ret.requestedAt)}</Row>
            {ret.declineReason && <Row k="Decline note">{ret.declineNote ?? ret.declineReason}</Row>}
          </Card>

          <div style={{ display: "grid", gap: 16 }}>
            {/* return shipment & tracking */}
            <Card
              title="Return shipment"
              right={ship ? <s-badge tone={ship.tone}>{ship.label}</s-badge> : <span style={sub}>Not shipped yet</span>}
            >
              <Row k="Carrier">{ret.carrier ?? "—"}</Row>
              <Row k="AWB / tracking number">
                {ret.awb ? (
                  <a href={trackingUrl(ret.awb)} target="_blank" rel="noreferrer">{ret.awb} ↗</a>
                ) : (
                  <span style={{ color: COLORS.subdued }}>Not added</span>
                )}
              </Row>
              {ret.status === "OPEN" && !editingTracking && (
                <div style={{ paddingTop: 10 }}>
                  <button style={btn("secondary", busy)} disabled={busy} onClick={() => setEditingTracking(true)}>{ret.awb ? "Edit tracking" : "Add tracking"}</button>
                </div>
              )}
              {ret.status === "REQUESTED" && <div style={{ ...sub, paddingTop: 8 }}>Approve the return to start the shipment.</div>}
              {editingTracking && (
                <Form method="post" style={{ display: "grid", gap: 8, paddingTop: 10, borderTop: `1px solid ${COLORS.border}` }}>
                  <input type="hidden" name="intent" value="tracking" />
                  <input name="number" defaultValue={ret.awb ?? ""} placeholder="AWB / tracking number" required style={{ ...input, width: "100%" }} />
                  <input name="carrier" defaultValue={ret.carrier ?? ""} placeholder="Carrier (e.g. Delhivery, Blue Dart)" style={{ ...input, width: "100%" }} />
                  <input name="url" type="url" placeholder="Tracking link (optional)" style={{ ...input, width: "100%" }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={btn("primary", busy)} disabled={busy}>Save tracking</button>
                    <button type="button" style={btn("secondary")} onClick={() => setEditingTracking(false)}>Cancel</button>
                  </div>
                  <span style={sub}>Saved here and sent to Shopify&apos;s reverse shipment when the return is approved.</span>
                </Form>
              )}
            </Card>

            {/* exchange: what the customer is taking instead */}
            {isExchange && (
              <Card
                title="Exchange: customer is taking"
                right={<s-badge tone={exchangeStatus === "DONE" ? "success" : "caution"}>{exchangeStatus === "DONE" ? "Complete" : "Pending"}</s-badge>}
              >
                {replacements.length === 0 ? (
                  <div style={sub}>Replacement details will appear after the next sync from Shopify.</div>
                ) : (
                  replacements.map((e) => (
                    <div key={e.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 0" }}>
                      {e.imageUrl ? (
                        <img src={e.imageUrl} alt={e.title} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${COLORS.border}` }} />
                      ) : (
                        <div style={{ width: 64, height: 64, borderRadius: 8, background: COLORS.bg }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{e.title}</div>
                        <div style={sub}>{[e.variantTitle, e.sku && `SKU ${e.sku}`, `Qty ${e.quantity}`].filter(Boolean).join(" · ")}</div>
                      </div>
                      <strong>{money(e.unitPrice * e.quantity)}</strong>
                    </div>
                  ))
                )}
                <div style={{ marginTop: 6, background: COLORS.bg, borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>Returning (items below)</span><strong>{money(itemsCost)}</strong></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>Replacement</span><strong>{money(replacementValue)}</strong></div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.border}`, marginTop: 6, paddingTop: 6 }}>
                    <span>{difference > 0.005 ? "Left over, refunded on completion" : difference < -0.005 ? "Customer pays the difference" : "Even exchange"}</span>
                    <strong>{Math.abs(difference) > 0.005 ? money(Math.abs(difference)) : "—"}</strong>
                  </div>
                </div>
                <div style={{ ...sub, marginTop: 8 }}>
                  Why: {first?.reason ?? "no reason given"}
                  {first?.customerNote || first?.reasonNote ? ` — “${first?.customerNote || first?.reasonNote}”` : ""}
                </div>
              </Card>
            )}

            {/* items being returned */}
            {ret.items.map((i) => (
              <Card
                key={i.id}
                title={isExchange ? `Returning: ${i.title}` : i.title}
                right={<s-badge>{i.reason ?? "No reason"}</s-badge>}
              >
                <div style={{ ...sub, marginBottom: 10 }}>
                  {[i.variantTitle, i.sku && `SKU ${i.sku}`, `Qty ${i.quantity}`, money(i.unitPrice)].filter(Boolean).join(" · ")}
                </div>
                {i.customerNote && (
                  <div style={{ background: COLORS.bg, borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontStyle: "italic" }}>“{i.customerNote}”</div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <ImagePanel title="Uploaded by customer">
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
                  <ImagePanel title="Original product">
                    {i.imageUrl ? <img src={i.imageUrl} alt={i.title} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} /> : <Empty text="No product image" />}
                  </ImagePanel>
                </div>
              </Card>
            ))}
          </div>
        </div>

        {/* customer + activity */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
          <Card title="Customer">
            <Row k="Name">{ret.customerName ?? "—"}</Row>
            <Row k="Email">{ret.customerEmail ? <a href={`mailto:${ret.customerEmail}`}>{ret.customerEmail}</a> : "—"}</Row>
            <Row k="Phone">{ret.customerPhone ?? "—"}</Row>
            <Row k="Shipping address">
              {address ? [address.address1, address.address2, address.city, address.province, address.zip, address.country].filter(Boolean).join(", ") : "—"}
            </Row>
            {ret.customerEmail && (
              <div style={{ paddingTop: 10 }}>
                <Link to={`/app/returns?q=${encodeURIComponent(ret.customerEmail)}`} style={{ fontSize: 13 }}>See all returns from this customer →</Link>
              </div>
            )}
          </Card>

          <Card title="Activity">
            <form
              method="post"
              onSubmit={(e) => {
                e.preventDefault();
                send("note", { note: new FormData(e.currentTarget).get("note") as string });
                e.currentTarget.reset();
              }}
            >
              <input name="note" placeholder="Add a note and press enter…" style={{ ...input, width: "100%", marginBottom: 12 }} />
            </form>
            <div style={{ display: "grid", gap: 8 }}>
              {ret.events.map((e) => (
                <div key={e.id} style={{ borderLeft: `3px solid ${e.kind === "NOTE" ? "#e0a800" : e.kind === "ACTION" ? COLORS.brand : COLORS.grey}`, padding: "2px 10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{e.title}</strong>
                    <span style={sub}>{fmtDate(e.createdAt)}</span>
                  </div>
                  {e.detail && <div style={{ fontSize: 13 }}>{e.detail}</div>}
                  {e.actor && <div style={sub}>{e.actor}</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </s-page>
  );
}

function ImagePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ height: 96, display: "grid", placeItems: "center", background: COLORS.bg, borderRadius: 8, color: COLORS.subdued, fontSize: 13 }}>{text}</div>;
}
