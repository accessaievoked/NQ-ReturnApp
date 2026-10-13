// Date-range helpers shared by the dashboard, analytics and returns filters.
// Everything is UTC and day-aligned so a range always covers whole days.

const DAY = 86_400_000;
const MAX_DAYS = 731;

export const PRESETS = [7, 30, 90, 365] as const;

export type DateRange = {
  from: Date;
  to: Date;
  days: number;
  /** YYYY-MM-DD, handy for <input type="date"> and URLs */
  fromStr: string;
  toStr: string;
  /** 7 | 30 | 90 | 365 when a preset is active, null for a custom range */
  preset: number | null;
};

export const iso = (d: Date) => d.toISOString().slice(0, 10);
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isDateStr = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function build(from: Date, toDay: Date, preset: number | null): DateRange {
  const days = Math.round((toDay.getTime() - from.getTime()) / DAY) + 1;
  return {
    from,
    to: new Date(toDay.getTime() + DAY - 1),
    days,
    fromStr: iso(from),
    toStr: iso(toDay),
    preset,
  };
}

/** `?from=&to=` wins; otherwise `?days=` (7/30/90/365); otherwise `defaultDays`. */
export function parseRange(sp: URLSearchParams, defaultDays = 30): DateRange {
  const f = sp.get("from");
  const t = sp.get("to");
  if (isDateStr(f) && isDateStr(t)) {
    let from = new Date(`${f}T00:00:00Z`);
    let to = new Date(`${t}T00:00:00Z`);
    if (to < from) [from, to] = [to, from];
    if ((to.getTime() - from.getTime()) / DAY >= MAX_DAYS) from = new Date(to.getTime() - (MAX_DAYS - 1) * DAY);
    return build(from, to, null);
  }
  const asked = Number(sp.get("days"));
  const days = (PRESETS as readonly number[]).includes(asked) ? asked : defaultDays;
  const today = startOfDay(new Date());
  return build(new Date(today.getTime() - (days - 1) * DAY), today, days);
}

/** The window of equal length immediately before `r` — used for "vs previous period". */
export function previousRange(r: DateRange): DateRange {
  const toDay = new Date(r.from.getTime() - DAY);
  const from = new Date(toDay.getTime() - (r.days - 1) * DAY);
  return build(from, toDay, null);
}

export function eachDay(r: DateRange): string[] {
  return Array.from({ length: r.days }, (_, i) => iso(new Date(r.from.getTime() + i * DAY)));
}

export const rangeLabel = (r: DateRange) => (r.preset ? `Last ${r.preset} days` : `${r.fromStr} → ${r.toStr}`);

/** % change from `prev` to `cur`; null when there is no baseline to compare against. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return ((cur - prev) / prev) * 100;
}
