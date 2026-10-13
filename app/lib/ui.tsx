// Small presentational kit shared by Dashboard, Analytics, Returns and Automation.
// Plain React + inline SVG on purpose: no chart library to install, and it renders on the server.
import type { CSSProperties, ReactNode } from "react";
import { Form, Link } from "react-router";
import { saveCurrency } from "./currency-pref";
import { PRESETS, type DateRange } from "./range";

export const COLORS = {
  brand: "#5c6ac4",
  pink: "#ff6384",
  blue: "#36a2eb",
  yellow: "#ffcd56",
  crimson: "#e5194f",
  green: "#2c9c5a",
  purple: "#9966ff",
  orange: "#ff9f40",
  grey: "#c9cccf",
  text: "#202223",
  subdued: "#6d7175",
  border: "#e1e3e5",
  bg: "#f6f6f7",
};
export const PALETTE = [COLORS.pink, COLORS.blue, COLORS.yellow, COLORS.crimson, COLORS.green, COLORS.purple, COLORS.orange, "#4bc0c0"];

export const cardStyle: CSSProperties = { border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, background: "#fff" };

export function Card({ title, hint, right, children, style }: { title?: ReactNode; hint?: string; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ ...cardStyle, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }} title={hint}>
            {title}
            {hint && <span style={{ color: COLORS.subdued, fontWeight: 400, marginLeft: 6, cursor: "help" }}>ⓘ</span>}
          </h3>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export const grid = (min: number, gap = 16): CSSProperties => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap });

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ padding: "28px 8px", textAlign: "center", color: COLORS.subdued, fontSize: 14 }}>{children}</div>;
}

/** ▲ 12.4% / ▼ 3% chip. `goodWhen` says which direction is good (more refunds is bad; more revenue saved is good). */
export function Delta({ pct, goodWhen = "up" }: { pct: number | null; goodWhen?: "up" | "down" }) {
  if (pct === null) return <span style={{ fontSize: 12, color: COLORS.subdued }}>new</span>;
  const up = pct > 0.05;
  const down = pct < -0.05;
  const good = (up && goodWhen === "up") || (down && goodWhen === "down");
  const bad = (up && goodWhen === "down") || (down && goodWhen === "up");
  const color = good ? COLORS.green : bad ? "#d72c0d" : COLORS.subdued;
  return (
    <span style={{ fontSize: 12, fontWeight: 600, color, background: good ? "#e3f1df" : bad ? "#fbeae5" : COLORS.bg, borderRadius: 10, padding: "1px 8px", whiteSpace: "nowrap" }}>
      {up ? "▲" : down ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function Kpi({
  label,
  value,
  icon,
  tint = "#eef0ff",
  sub,
  delta,
  prev,
  href,
}: {
  label: string;
  value: ReactNode;
  icon?: string;
  tint?: string;
  sub?: ReactNode;
  delta?: ReactNode;
  /** e.g. "Previous: ₹1.2L" */
  prev?: ReactNode;
  href?: string;
}) {
  const body = (
    <div style={{ ...cardStyle, display: "flex", gap: 14, alignItems: "center", height: "100%", boxSizing: "border-box" }}>
      {icon && (
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: tint, display: "grid", placeItems: "center", fontSize: 24, flexShrink: 0 }}>{icon}</div>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: COLORS.subdued }}>{label}</div>
        <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
          {delta}
          {prev && <span style={{ fontSize: 12, color: COLORS.subdued }}>{prev}</span>}
          {sub && <span style={{ fontSize: 12, color: COLORS.subdued }}>{sub}</span>}
        </div>
      </div>
    </div>
  );
  return href ? (
    <Link to={href} style={{ color: "inherit", textDecoration: "none" }}>
      {body}
    </Link>
  ) : (
    body
  );
}

// ---------------------------------------------------------------- charts

function niceMax(v: number) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export type LineSeries = { name: string; color: string; values: number[]; dashed?: boolean };

/** Smooth multi-series line chart with gridlines, day labels and a hover tooltip per day. */
export function LineChart({
  labels,
  series,
  height = 260,
  format = (n) => String(Math.round(n * 100) / 100),
  minMax = 1,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  format?: (n: number) => string;
  /** floor for the y-axis maximum so tiny counts don't produce fractional ticks */
  minMax?: number;
}) {
  const W = 760;
  const pad = { l: 52, r: 14, t: 12, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const n = labels.length;
  const max = niceMax(Math.max(minMax, ...series.flatMap((s) => s.values)));
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const every = Math.ceil(n / 8);
  const colW = n <= 1 ? iw : iw / (n - 1);

  const path = (vals: number[]) =>
    vals
      .map((v, i) => {
        if (i === 0) return `M${x(0)},${y(v)}`;
        const mx = (x(i - 1) + x(i)) / 2; // horizontal-midpoint control points: smooth, never overshoots below 0
        return `C${mx},${y(vals[i - 1])} ${mx},${y(v)} ${x(i)},${y(v)}`;
      })
      .join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} style={{ width: "100%", height: "auto", display: "block" }} role="img">
        {[0, 1, 2, 3, 4].map((t) => {
          const v = (max / 4) * t;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#eceef0" />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={COLORS.subdued}>
                {format(v)}
              </text>
            </g>
          );
        })}
        {labels.map((l, i) =>
          i % every === 0 ? (
            <text key={l} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill={COLORS.subdued}>
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <g key={s.name}>
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2.2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinecap="round" />
            {n <= 31 && !s.dashed && s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color} />)}
          </g>
        ))}
        {labels.map((l, i) => (
          <rect key={l} x={x(i) - colW / 2} y={pad.t} width={colW} height={ih} fill="transparent">
            <title>{`${l}\n${series.map((s) => `${s.name}: ${format(s.values[i] ?? 0)}`).join("\n")}`}</title>
          </rect>
        ))}
      </svg>
      <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", fontSize: 12, color: COLORS.subdued, marginTop: 6 }}>
      {items.map((i) => (
        <span key={i.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export type Slice = { label: string; value: number };

/** Donut with a percentage legend. Slices beyond the 8th are folded into "Other". */
export function Donut({ slices, centerLabel }: { slices: Slice[]; centerLabel?: ReactNode }) {
  const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((n, s) => n + s.value, 0);
  if (rest) shown.push({ label: "Other", value: rest });
  const total = shown.reduce((n, s) => n + s.value, 0);
  if (!total) return <Empty>No data in this period.</Empty>;

  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
      <div style={{ position: "relative", width: 180, height: 180 }}>
        <svg viewBox="0 0 180 180" width={180} height={180} style={{ transform: "rotate(-90deg)" }}>
          {shown.map((s, i) => {
            const len = (s.value / total) * C;
            const el = (
              <circle key={s.label} cx={90} cy={90} r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={30} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}>
                <title>{`${s.label}: ${s.value} (${((s.value / total) * 100).toFixed(1)}%)`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", pointerEvents: "none" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{total}</div>
            <div style={{ fontSize: 11, color: COLORS.subdued }}>{centerLabel ?? "total"}</div>
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 6, fontSize: 13, minWidth: 160, flex: 1 }}>
        {shown.map((s, i) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.label}>
              {s.label}
            </span>
            <strong>{((s.value / total) * 100).toFixed(1)}%</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ranked horizontal bars — used for regions, reasons and anything "top N". */
export function BarList({ rows, color = COLORS.brand }: { rows: { label: string; value: number; display?: ReactNode; sub?: ReactNode }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <Empty>No data in this period.</Empty>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3, gap: 8 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
            <span>
              <strong>{r.display ?? r.value}</strong>
              {r.sub && <span style={{ color: COLORS.subdued, marginLeft: 6 }}>{r.sub}</span>}
            </span>
          </div>
          <div style={{ background: "#eceef0", borderRadius: 4, height: 8 }}>
            <div style={{ width: `${(r.value / max) * 100}%`, height: 8, background: color, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tables / controls

export const th: CSSProperties = { textAlign: "left", padding: "10px 12px", fontSize: 13, background: "#f6f6fb", whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "10px 12px", fontSize: 13, borderTop: `1px solid ${COLORS.border}`, verticalAlign: "middle" };

export const btn = (variant: "primary" | "secondary" | "danger" | "plain" = "secondary", disabled = false): CSSProperties => ({
  display: "inline-block",
  padding: "7px 14px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  textDecoration: "none",
  opacity: disabled ? 0.5 : 1,
  border: variant === "primary" ? "1px solid #303030" : variant === "danger" ? "1px solid #d72c0d" : `1px solid ${COLORS.border}`,
  background: variant === "primary" ? "#303030" : variant === "danger" ? "#fff" : variant === "plain" ? "transparent" : "#fff",
  color: variant === "primary" ? "#fff" : variant === "danger" ? "#d72c0d" : COLORS.text,
});

export const input: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid #babfc3",
  borderRadius: 8,
  fontSize: 13,
  boxSizing: "border-box",
  background: "#fff",
  color: COLORS.text,
  font: "inherit",
};

export type Pagination = { total: number; page: number; pageSize: number; pages: number; hasPrev: boolean; hasNext: boolean; from: number; to: number };

/** "Showing 26–50 of 6,712" + first / prev / numbered / next / last. Links are built by the caller so filters survive. */
export function Pager({ p, hrefFor }: { p: Pagination; hrefFor: (page: number) => string }) {
  const window = 2;
  const nums: (number | "…")[] = [];
  for (let i = 1; i <= p.pages; i++) {
    if (i === 1 || i === p.pages || Math.abs(i - p.page) <= window) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const cell = (active: boolean, disabled = false): CSSProperties => ({ ...btn(active ? "primary" : "secondary", disabled), padding: "5px 11px", pointerEvents: disabled ? "none" : "auto" });
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "12px 16px", borderTop: `1px solid ${COLORS.border}` }}>
      <span style={{ fontSize: 13, color: COLORS.subdued }}>
        {p.total === 0 ? "No results" : `Showing ${p.from.toLocaleString("en-IN")}–${p.to.toLocaleString("en-IN")} of ${p.total.toLocaleString("en-IN")}`}
      </span>
      {p.pages > 1 && (
        <nav style={{ display: "flex", gap: 4, alignItems: "center" }} aria-label="Pagination">
          <Link to={hrefFor(1)} style={cell(false, !p.hasPrev)} aria-label="First page">«</Link>
          <Link to={hrefFor(p.page - 1)} style={cell(false, !p.hasPrev)}>Previous</Link>
          {nums.map((n, i) =>
            n === "…" ? (
              <span key={`gap${i}`} style={{ padding: "0 4px", color: COLORS.subdued }}>…</span>
            ) : (
              <Link key={n} to={hrefFor(n)} style={cell(n === p.page)} aria-current={n === p.page ? "page" : undefined}>
                {n}
              </Link>
            ),
          )}
          <Link to={hrefFor(p.page + 1)} style={cell(false, !p.hasNext)}>Next</Link>
          <Link to={hrefFor(p.pages)} style={cell(false, !p.hasNext)} aria-label="Last page">»</Link>
        </nav>
      )}
    </div>
  );
}

export type CurrencyInfo = { base: string; display: string; options: string[]; mixed: boolean; fetchedAt: string | null; ratesMissing: boolean };

/** "Values shown in USD · converted from INR at today's rate (updated 13 Oct)" — so nobody mistakes converted money for the real thing. */
export function CurrencyNote({ currency }: { currency: CurrencyInfo }) {
  if (currency.ratesMissing)
    return <span style={{ fontSize: 12, color: "#b98900" }}>Exchange rates unavailable right now — showing {currency.display}.</span>;
  if (currency.display === currency.base && !currency.mixed) return null;
  const when = currency.fetchedAt ? new Date(currency.fetchedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—";
  return (
    <span style={{ fontSize: 12, color: COLORS.subdued }}>
      Shown in {currency.display}, converted from {currency.base} at current rates (updated {when}).
    </span>
  );
}

/** 7d / 30d / 90d / 1y presets, a custom from–to picker and (optionally) a currency picker. Everything is a GET, so it works with any loader that calls parseRange. */
export function RangePicker({ range, base, keep = {}, currency }: { range: DateRange; base: string; keep?: Record<string, string>; currency?: CurrencyInfo }) {
  const extra: Record<string, string> = currency ? { cur: currency.display } : {};
  const qs = (more: Record<string, string>) => `${base}?${new URLSearchParams({ ...keep, ...extra, ...more })}`;
  const rangeParams: Record<string, string> = range.preset ? { days: String(range.preset) } : { from: range.fromStr, to: range.toStr };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {PRESETS.map((d) => (
        <Link key={d} to={qs({ days: String(d) })} style={btn(range.preset === d ? "primary" : "secondary")}>
          {d === 365 ? "1y" : `${d}d`}
        </Link>
      ))}
      <Form method="get" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {Object.entries({ ...keep, ...extra }).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="date" name="from" defaultValue={range.fromStr} max={range.toStr} style={input} aria-label="From date" />
        <span style={{ color: COLORS.subdued }}>→</span>
        <input type="date" name="to" defaultValue={range.toStr} style={input} aria-label="To date" />
        <button type="submit" style={btn(range.preset ? "secondary" : "primary")}>Apply</button>
      </Form>
      {currency && (
        <Form method="get" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {Object.entries({ ...keep, ...rangeParams }).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <select name="cur" value={currency.display} onChange={(e) => {
              saveCurrency(e.currentTarget.value);
              e.currentTarget.form?.requestSubmit();
            }}
            style={input}
            aria-label="Display currency">
            {currency.options.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === currency.base ? " (store)" : ""}
              </option>
            ))}
          </select>
        </Form>
      )}
    </div>
  );
}
