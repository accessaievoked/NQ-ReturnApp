// URL <-> filter state for the Returns list. Shared by the loader (to query) and the UI (to build links),
// so the URL is the single source of truth: shareable, bookmarkable, back-button friendly.

export const SORTS = {
  newest: "Newest first",
  oldest: "Oldest first",
  value_desc: "Highest value",
  value_asc: "Lowest value",
} as const;
export type SortKey = keyof typeof SORTS;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export const STATUSES = ["REQUESTED", "OPEN", "DECLINED", "CLOSED", "CANCELED"] as const;
export type StatusKey = (typeof STATUSES)[number];

export const REFUND_FILTERS = ["PENDING", "PARTIAL", "REFUNDED", "NA"] as const;
export const SHIPMENT_FILTERS = ["AWAITING_SHIPMENT", "IN_TRANSIT", "RECEIVED", "CANCELED"] as const;

export type ReturnFilters = {
  q: string;
  status: StatusKey | null;
  reason: string | null;
  payment: "COD" | "PREPAID" | null;
  /** only returns decided by an automation rule (true) / only manual (false) / all (null) */
  auto: boolean | null;
  from: string | null; // YYYY-MM-DD
  to: string | null;
  minValue: number | null;
  maxValue: number | null;
  type: "RETURN" | "EXCHANGE" | null;
  refund: (typeof REFUND_FILTERS)[number] | null;
  shipment: (typeof SHIPMENT_FILTERS)[number] | null;
  /** display currency (min/max value are typed in it); null = store default */
  cur: string | null;
  sort: SortKey;
  page: number;
  pageSize: number;
};

const dateOrNull = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);
const numOrNull = (s: string | null) => {
  if (s == null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseReturnFilters(sp: URLSearchParams): ReturnFilters {
  const status = sp.get("status") as StatusKey | null;
  const payment = sp.get("payment");
  const auto = sp.get("auto");
  const sort = sp.get("sort") as SortKey | null;
  const size = Number(sp.get("pageSize"));
  return {
    q: sp.get("q")?.trim() ?? "",
    status: status && (STATUSES as readonly string[]).includes(status) ? status : null,
    reason: sp.get("reason")?.trim() || null,
    payment: payment === "COD" || payment === "PREPAID" ? payment : null,
    auto: auto === "1" ? true : auto === "0" ? false : null,
    from: dateOrNull(sp.get("from")),
    to: dateOrNull(sp.get("to")),
    minValue: numOrNull(sp.get("minValue")),
    maxValue: numOrNull(sp.get("maxValue")),
    type: sp.get("type") === "RETURN" || sp.get("type") === "EXCHANGE" ? (sp.get("type") as "RETURN" | "EXCHANGE") : null,
    refund: (REFUND_FILTERS as readonly string[]).includes(sp.get("refund") ?? "") ? (sp.get("refund") as (typeof REFUND_FILTERS)[number]) : null,
    shipment: (SHIPMENT_FILTERS as readonly string[]).includes(sp.get("shipment") ?? "") ? (sp.get("shipment") as (typeof SHIPMENT_FILTERS)[number]) : null,
    cur: /^[A-Za-z]{3}$/.test(sp.get("cur") ?? "") ? sp.get("cur")!.toUpperCase() : null,
    sort: sort && sort in SORTS ? sort : "newest",
    page: Math.max(1, Math.floor(Number(sp.get("page"))) || 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : 25,
  };
}

/** Back to a query string, dropping defaults so URLs stay short. */
export function filtersToParams(f: ReturnFilters, override: Partial<ReturnFilters> = {}): URLSearchParams {
  const m = { ...f, ...override };
  const sp = new URLSearchParams();
  if (m.q) sp.set("q", m.q);
  if (m.status) sp.set("status", m.status);
  if (m.reason) sp.set("reason", m.reason);
  if (m.payment) sp.set("payment", m.payment);
  if (m.auto !== null) sp.set("auto", m.auto ? "1" : "0");
  if (m.from) sp.set("from", m.from);
  if (m.to) sp.set("to", m.to);
  if (m.minValue !== null) sp.set("minValue", String(m.minValue));
  if (m.maxValue !== null) sp.set("maxValue", String(m.maxValue));
  if (m.type) sp.set("type", m.type);
  if (m.refund) sp.set("refund", m.refund);
  if (m.shipment) sp.set("shipment", m.shipment);
  if (m.cur) sp.set("cur", m.cur);
  if (m.sort !== "newest") sp.set("sort", m.sort);
  if (m.page > 1) sp.set("page", String(m.page));
  if (m.pageSize !== 25) sp.set("pageSize", String(m.pageSize));
  return sp;
}

/** Number of active filters (not counting sort/pagination) — shown on the "Clear all" button. */
export const activeFilterCount = (f: ReturnFilters) =>
  [f.q, f.status, f.reason, f.payment, f.type, f.refund, f.shipment, f.auto !== null, f.from, f.to, f.minValue !== null, f.maxValue !== null].filter(Boolean).length;
