import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useFetcher, useLoaderData, useNavigation, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { listReturns } from "../services/returns-query.server";
import { performReturnAction, syncAllReturns } from "../services/returns.server";
import { currencyContext, publicCurrency } from "../services/currency.server";
import { downloadCsv } from "../lib/csv";
import { saveCurrency } from "../lib/currency-pref";
import { STATUS_META, fmtDate, fmtMoney, currencySymbol } from "../lib/format";
import { PAGE_SIZES, REFUND_FILTERS, SHIPMENT_FILTERS, SORTS, STATUSES, activeFilterCount, filtersToParams, parseReturnFilters } from "../lib/return-filters";
import { REFUND_META, SHIPMENT_META } from "../lib/return-meta";
import { COLORS, CurrencyNote, Empty, Pager, btn, cardStyle, input, td, th } from "../lib/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const filters = parseReturnFilters(new URL(request.url).searchParams);
  const cx = await currencyContext(shop, filters.cur);
  const data = await listReturns(shop.id, filters, cx);
  return { ...data, filters, currency: publicCurrency(cx), now: Date.now() };
};

const NEEDS: Record<string, "REQUESTED" | "OPEN"> = { approve: "REQUESTED", decline: "REQUESTED", close: "OPEN" };

// Bulk approve / decline / close for the ticked rows. Sequential on purpose: Shopify rate-limits the Admin API.
// Rows that are in the wrong state for the action are skipped (and counted) instead of failing the batch.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "sync") {
    const n = await syncAllReturns(session.shop);
    return { done: n, failed: 0, skipped: 0, errors: [] as string[], synced: true };
  }

  const ids = String(form.get("ids") ?? "").split(",").filter(Boolean).slice(0, 50);
  if (!(intent in NEEDS) || !ids.length) return { done: 0, failed: 0, skipped: 0, errors: [] as string[] };

  const eligible = await db.returnRequest.findMany({ where: { shopId: shop.id, id: { in: ids }, status: NEEDS[intent] }, select: { id: true } });
  const note = String(form.get("note") ?? "") || undefined;
  let done = 0;
  const errors: string[] = [];
  for (const { id } of eligible) {
    try {
      const r = await performReturnAction(session.shop, id, intent as "approve" | "decline" | "close", session.shop, note);
      if (r.ok) done++;
      else errors.push(r.error);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Unknown error");
    }
  }
  return { done, failed: eligible.length - done, skipped: ids.length - eligible.length, errors: [...new Set(errors)].slice(0, 3) };
};

const menuItem: CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "8px 14px", border: "none", background: "transparent", font: "inherit", fontSize: 13, cursor: "pointer", color: COLORS.text };
const sub: CSSProperties = { fontSize: 12, color: COLORS.subdued };

type ExchangeItem = { title: string; variantTitle: string | null; quantity: number };
const exchangeFor = (r: { exchangeItems: unknown }) => (Array.isArray(r.exchangeItems) ? (r.exchangeItems as ExchangeItem[]) : []);

function ExportAction({ query, label }: { query: string; label: string }) {
  // One component per option so each has its own fetcher state ("Preparing…" shows only on the one clicked).
  const fetcher = useFetcher<{ rows: Record<string, unknown>[] }>();
  useEffect(() => {
    const rows = fetcher.data?.rows;
    if (rows) downloadCsv(`returns-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }, [fetcher.data]);
  return (
    <button type="button" style={menuItem} disabled={fetcher.state !== "idle"} onClick={() => fetcher.load(`/app/returns/export${query}`)}>
      {fetcher.state !== "idle" ? "Preparing…" : label}
    </button>
  );
}

function Menu({ label, children, disabled }: { label: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <details style={{ position: "relative" }} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && e.currentTarget.removeAttribute("open")}>
      <summary style={{ ...btn("secondary", disabled), listStyle: "none", pointerEvents: disabled ? "none" : "auto" }}>{label} ▾</summary>
      <div
        role="menu"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}
        onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}
        style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20, minWidth: 250, background: "#fff", border: `1px solid ${COLORS.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.12)", padding: "6px 0" }}
      >
        {children}
      </div>
    </details>
  );
}

export default function Returns() {
  const { rows, pagination, statusCounts, allCount, reasons, filters: f, currency, now } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const bulk = useFetcher<typeof action>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const loading = nav.state === "loading" && nav.location?.pathname === "/app/returns";

  // A new result set (page change / filter) invalidates the ticks, and so does finishing a bulk action.
  useEffect(() => setSelected(new Set()), [rows, bulk.data]);

  const href = (override: Parameters<typeof filtersToParams>[1] = {}) => {
    const qs = filtersToParams(f, override).toString();
    return `/app/returns${qs ? `?${qs}` : ""}`;
  };
  const cur = currency.display !== currency.base ? `&cur=${currency.display}` : "";
  const filterQuery = (() => {
    const qs = filtersToParams(f, { page: 1 }).toString();
    return qs ? `?${qs}` : "";
  })();
  const nFilters = activeFilterCount(f);
  const chosenRows = rows.filter((r) => selected.has(r.id));
  const count = (st: string) => chosenRows.filter((r) => r.status === st).length;
  const busy = bulk.state !== "idle";
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => e.currentTarget.form && submit(e.currentTarget.form);
  const allOnPage = rows.length > 0 && chosenRows.length === rows.length;

  const runBulk = (intent: "approve" | "decline" | "close") => {
    const n = count(NEEDS[intent]);
    let note = "";
    if (intent === "decline") {
      const v = window.prompt(`Reason for declining ${n} return(s) (shown to customers):`);
      if (v === null) return;
      note = v;
    } else if (!window.confirm(`${intent === "approve" ? "Approve" : "Close"} ${n} return(s) on Shopify?`)) return;
    bulk.submit({ intent, ids: chosenRows.map((r) => r.id).join(","), note }, { method: "post" });
  };

  const tabs: { key: string | null; label: string; n: number }[] = [
    { key: null, label: "All requests", n: allCount },
    ...STATUSES.map((s) => ({ key: s, label: STATUS_META[s].label, n: statusCounts[s] ?? 0 })),
  ];
  const unresolved = statusCounts.REQUESTED ?? 0;

  return (
    <s-page heading="Returns & exchanges">
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <CurrencyNote currency={currency} />
          <bulk.Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <button style={btn("secondary", busy)} disabled={busy} title="Pull the latest refund, exchange and shipment status from Shopify">
              {busy ? "Working…" : "Sync from Shopify"}
            </button>
          </bulk.Form>
        </div>

        {bulk.data && (
          <s-banner tone={bulk.data.failed ? "warning" : "success"} dismissible>
            {"synced" in bulk.data ? `Synced ${bulk.data.done} returns from Shopify` : `${bulk.data.done} updated`}
            {bulk.data.skipped ? `, ${bulk.data.skipped} skipped (not in the right state)` : ""}
            {bulk.data.failed ? `, ${bulk.data.failed} failed${bulk.data.errors.length ? `: ${bulk.data.errors.join(" · ")}` : ""}` : ""}.
          </s-banner>
        )}

        <div style={{ ...cardStyle, padding: 0, overflow: "visible", opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
          {/* status tabs with counts under the current filters; "Requested" turns into a red badge while anything awaits review */}
          <div style={{ display: "flex", gap: 4, padding: "8px 12px 0", borderBottom: `1px solid ${COLORS.border}`, overflowX: "auto" }}>
            {tabs.map((t) => {
              const active = f.status === t.key;
              const alert = t.key === "REQUESTED" && t.n > 0;
              return (
                <Link
                  key={t.label}
                  to={href({ status: t.key as typeof f.status, page: 1 })}
                  style={{ padding: "8px 14px", fontSize: 14, whiteSpace: "nowrap", color: active ? COLORS.brand : COLORS.text, fontWeight: active ? 700 : 500, borderBottom: `3px solid ${active ? COLORS.brand : "transparent"}`, textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}
                >
                  {t.label}
                  {alert ? (
                    <span style={{ background: "#d72c0d", color: "#fff", borderRadius: 10, padding: "0 7px", fontSize: 12, fontWeight: 700 }}>{t.n}</span>
                  ) : (
                    <span style={{ color: COLORS.subdued, fontWeight: 400 }}>({t.n.toLocaleString("en-IN")})</span>
                  )}
                </Link>
              );
            })}
          </div>

          {/* filters: a plain GET form, so every filter lives in the URL */}
          <Form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: 12 }}>
            {f.status && <input type="hidden" name="status" value={f.status} />}
            <input name="q" defaultValue={f.q} placeholder="Search return, order, customer, product, SKU, AWB…" style={{ ...input, flex: "1 1 260px", minWidth: 200 }} />
            <label style={sub}>From <input type="date" name="from" defaultValue={f.from ?? ""} onChange={autoSubmit} style={input} /></label>
            <label style={sub}>To <input type="date" name="to" defaultValue={f.to ?? ""} onChange={autoSubmit} style={input} /></label>
            <select name="reason" defaultValue={f.reason ?? ""} onChange={autoSubmit} style={input} aria-label="Reason">
              <option value="">All reasons</option>
              {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select name="type" defaultValue={f.type ?? ""} onChange={autoSubmit} style={input} aria-label="Request type">
              <option value="">Returns + exchanges</option>
              <option value="RETURN">Returns only</option>
              <option value="EXCHANGE">Exchanges only</option>
            </select>
            <select name="refund" defaultValue={f.refund ?? ""} onChange={autoSubmit} style={input} aria-label="Refund status">
              <option value="">Any refund status</option>
              {REFUND_FILTERS.map((k) => <option key={k} value={k}>Refund: {REFUND_META[k].label}</option>)}
            </select>
            <select name="shipment" defaultValue={f.shipment ?? ""} onChange={autoSubmit} style={input} aria-label="Shipment status">
              <option value="">Any shipment status</option>
              {SHIPMENT_FILTERS.map((k) => <option key={k} value={k}>{SHIPMENT_META[k].label}</option>)}
            </select>
            <select name="payment" defaultValue={f.payment ?? ""} onChange={autoSubmit} style={input} aria-label="Payment mode">
              <option value="">Any payment</option>
              <option value="PREPAID">Prepaid</option>
              <option value="COD">Cash on delivery</option>
            </select>
            <select name="auto" defaultValue={f.auto === null ? "" : f.auto ? "1" : "0"} onChange={autoSubmit} style={input} aria-label="Handled by">
              <option value="">Manual + automated</option>
              <option value="1">Automated only</option>
              <option value="0">Manual only</option>
            </select>
            <input name="minValue" type="number" min={0} step="0.01" defaultValue={f.minValue ?? ""} placeholder={`Min ${currencySymbol(currency.display)}`} style={{ ...input, width: 90 }} aria-label="Minimum value" />
            <input name="maxValue" type="number" min={0} step="0.01" defaultValue={f.maxValue ?? ""} placeholder={`Max ${currencySymbol(currency.display)}`} style={{ ...input, width: 90 }} aria-label="Maximum value" />
            <select name="cur" defaultValue={currency.display} onChange={(e) => { saveCurrency(e.currentTarget.value); autoSubmit(e); }} style={input} aria-label="Display currency">
              {currency.options.map((c) => <option key={c} value={c}>{c}{c === currency.base ? " (store)" : ""}</option>)}
            </select>
            <select name="sort" defaultValue={f.sort} onChange={autoSubmit} style={input} aria-label="Sort">
              {Object.entries(SORTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <select name="pageSize" defaultValue={f.pageSize} onChange={autoSubmit} style={input} aria-label="Rows per page">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <button type="submit" style={btn("primary")}>Apply</button>
            {nFilters > 0 && <Link to="/app/returns" style={{ ...btn("plain"), color: COLORS.brand }}>Clear all ({nFilters})</Link>}
            <span style={{ flex: 1 }} />
            <Menu label={chosenRows.length ? `Actions (${chosenRows.length})` : "Actions"} disabled={!chosenRows.length}>
              <button type="button" style={menuItem} disabled={busy || !count("REQUESTED")} onClick={() => runBulk("approve")}>✓ Approve ({count("REQUESTED")} awaiting review)</button>
              <button type="button" style={{ ...menuItem, color: "#d72c0d" }} disabled={busy || !count("REQUESTED")} onClick={() => runBulk("decline")}>✕ Decline ({count("REQUESTED")} awaiting review)</button>
              <button type="button" style={menuItem} disabled={busy || !count("OPEN")} onClick={() => runBulk("close")}>▣ Close ({count("OPEN")} approved)</button>
            </Menu>
            <Menu label="Export">
              {chosenRows.length > 0 && <ExportAction label={`Selected (${chosenRows.length})`} query={`?ids=${chosenRows.map((r) => r.id).join(",")}${cur}`} />}
              <ExportAction label={`This page (${rows.length})`} query={`?ids=${rows.map((r) => r.id).join(",")}${cur}`} />
              <ExportAction label={`All matching filters (${pagination.total.toLocaleString("en-IN")})`} query={filterQuery} />
              <ExportAction label="Everything (ignore filters)" query={`?scope=all${cur}`} />
            </Menu>
          </Form>

          {/* after ticking the whole page, offer to export every match, not just the visible rows */}
          {allOnPage && pagination.total > rows.length && (
            <div style={{ padding: "8px 14px", background: "#f1f2ff", borderTop: `1px solid ${COLORS.border}`, fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span>All {rows.length} returns on this page are selected.</span>
              <ExportAction label={`Export all ${pagination.total.toLocaleString("en-IN")} matching filters`} query={filterQuery} />
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      disabled={!rows.length}
                      checked={allOnPage}
                      onChange={(e) => setSelected(new Set(e.target.checked ? rows.map((r) => r.id) : []))}
                    />
                  </th>
                  {["Requested on", "Return", "Order", "Customer", "Product", "Type", "Reason", "Value", "Payment", "Status", "Refund", "Shipment / AWB"].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const meta = STATUS_META[r.status];
                  const first = r.items[0];
                  const units = r.items.reduce((n, i) => n + i.quantity, 0);
                  const isNew = r.status === "REQUESTED" && now - new Date(r.requestedAt).getTime() < 86_400_000;
                  const ship = r.shipmentStatus ? SHIPMENT_META[r.shipmentStatus] : null;
                  const refund = REFUND_META[r.refundStatus];
                  return (
                    <tr key={r.id} style={{ background: selected.has(r.id) ? "#f1f2ff" : r.status === "REQUESTED" ? "#fffdf5" : undefined }}>
                      <td style={td}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          checked={selected.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        {fmtDate(r.requestedAt)}
                        {isNew && <span style={{ marginLeft: 6, background: "#d72c0d", color: "#fff", borderRadius: 6, padding: "0 6px", fontSize: 10, fontWeight: 700 }}>NEW</span>}
                      </td>
                      <td style={td}><Link to={`/app/returns/${r.id}`}>{r.name}</Link></td>
                      <td style={td}>{r.orderName ?? "—"}</td>
                      <td style={td}>{r.customerName ?? "—"}</td>
                      <td style={td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {first?.imageUrl && <img src={first.imageUrl} alt={first.title} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6 }} />}
                          <span style={{ color: COLORS.subdued }}>
                            {units} unit{units === 1 ? "" : "s"}
                            {r.items.length > 1 ? ` · ${r.items.length} items` : ""}
                          </span>
                        </div>
                        {exchangeFor(r).length > 0 && (
                          <div style={{ ...sub, marginTop: 4 }}>
                            ⇄ Taking: {exchangeFor(r).map((e) => `${e.title}${e.variantTitle ? ` (${e.variantTitle})` : ""} ×${e.quantity}`).join(", ")}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        <s-badge tone={r.exchangeUnits > 0 ? "info" : "neutral"}>{r.exchangeUnits > 0 ? "Exchange" : "Return"}</s-badge>
                        {r.exchangeStatus && <div style={sub}>{r.exchangeStatus === "DONE" ? "Exchange complete" : "Exchange pending"}</div>}
                      </td>
                      <td style={td}>{first?.reason ?? "—"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtMoney(r.displayValue, currency.display)}</td>
                      <td style={td}>{r.paymentMethod ?? "—"}</td>
                      <td style={td}>
                        <s-badge tone={meta.tone}>{meta.label}</s-badge>
                        {r.autoHandled && <span title="Decided by an automation rule" style={{ marginLeft: 6 }}>⚡</span>}
                      </td>
                      <td style={td}>
                        {r.exchangeUnits > 0 && r.status !== "DECLINED" && r.status !== "CANCELED" ? (
                          <>
                            <s-badge tone={r.exchangeStatus === "DONE" ? "success" : "caution"}>{r.exchangeStatus === "DONE" ? "Exchange complete" : "Exchange pending"}</s-badge>
                            {r.refundedAmount > 0 && <div style={sub}>+ {fmtMoney(r.displayRefunded, currency.display)} refunded</div>}
                          </>
                        ) : (
                          <>
                            <s-badge tone={refund.tone}>{refund.label}</s-badge>
                            {r.refundedAmount > 0 && <div style={sub}>{fmtMoney(r.displayRefunded, currency.display)}</div>}
                          </>
                        )}
                      </td>
                      <td style={td}>
                        {ship ? <s-badge tone={ship.tone}>{ship.label}</s-badge> : "—"}
                        {r.awb && <div style={sub}>{r.carrier ? `${r.carrier} · ` : ""}{r.awb}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <Empty>No returns match these filters.</Empty>}
          <Pager p={pagination} hrefFor={(page) => href({ page })} />
        </div>
        {unresolved > 0 && f.status !== "REQUESTED" && (
          <Link to="/app/returns?status=REQUESTED" style={{ fontSize: 13, color: "#b4331a" }}>
            ● {unresolved} return{unresolved === 1 ? "" : "s"} awaiting your review
          </Link>
        )}
      </div>
    </s-page>
  );
}
