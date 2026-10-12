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

export function fmtMoney(amount: string | number | null | undefined, currency?: string | null) {
  if (amount == null) return "—";
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR" }).format(n);
  } catch {
    return `${currency ?? ""} ${n.toFixed(2)}`.trim();
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
