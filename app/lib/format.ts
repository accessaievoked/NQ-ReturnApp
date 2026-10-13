export type Tone = "neutral" | "info" | "success" | "warning" | "critical" | "caution";

export const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  REQUESTED: { label: "Requested", tone: "caution" },
  OPEN: { label: "Approved", tone: "info" },
  DECLINED: { label: "Declined", tone: "critical" },
  CLOSED: { label: "Closed", tone: "success" },
  CANCELED: { label: "Canceled", tone: "neutral" },
};

export const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const numericId = (gid: string) => gid.split("/").pop()!;

/** URL to open the return's order in Shopify admin. */
export const adminOrderUrl = (shopDomain: string, orderGid: string) =>
  `https://${shopDomain}/admin/orders/${numericId(orderGid)}`;

export const fmtDay = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });

export const fmtDateLong = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Indian grouping (1,00,000) for INR, international grouping for everything else. */
const localeFor = (currency?: string | null) => (!currency || currency === "INR" ? "en-IN" : "en-US");

export function fmtMoney(amount: string | number | null | undefined, currency?: string | null) {
  if (amount == null) return "—";
  const n = Number(amount);
  try {
    return new Intl.NumberFormat(localeFor(currency), { style: "currency", currency: currency || "INR" }).format(n);
  } catch {
    return `${currency ?? ""} ${n.toFixed(2)}`.trim();
  }
}

/** "₹", "$", "€" … for labels like "Min (₹)". Falls back to the code. */
export function currencySymbol(currency?: string | null) {
  try {
    return new Intl.NumberFormat(localeFor(currency), { style: "currency", currency: currency || "INR" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency ?? "";
  } catch {
    return currency ?? "";
  }
}

/** Fill every day in the range (UTC) so charts show gaps as zero instead of skipping days. */
export function fillDays(daily: { day: string; count: number }[], days: number) {
  const map = new Map(daily.map((d) => [d.day, d.count]));
  const out: { day: string; count: number }[] = [];
  const end = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) ?? 0 });
  }
  return out;
}

/** ₹1.2L / $3.4K style for tight KPI tiles. Lakh/crore for INR, K/M/B for everything else. */
export function fmtMoneyCompact(amount: number | null | undefined, currency?: string | null) {
  if (amount == null) return "—";
  if (Math.abs(amount) < 100_000) return fmtMoney(amount, currency); // exact, two decimals
  try {
    return new Intl.NumberFormat(localeFor(currency), { style: "currency", currency: currency || "INR", notation: "compact", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return fmtMoney(amount, currency);
  }
}

export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-IN").format(n));

/** 90 → "1.5 h", 0.4 → "24 min", 50 → "2.1 d" */
export function fmtDuration(hours: number | null | undefined) {
  if (hours == null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

export const fmtPct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;
