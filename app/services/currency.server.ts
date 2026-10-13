import { Prisma } from "@prisma/client";
import db from "../db.server";
import { getAdmin, gql } from "./admin-client.server";

// Display-only currency conversion. Nothing here is written to the database:
//  - the real store currency is read from Shopify (cached in memory),
//  - exchange rates come from open.er-api.com (free, no key; cached in memory),
//  - the merchant's chosen display currency lives in the browser (see lib/currency-pref.ts) and arrives as ?cur=.
// Stored values are never changed — conversion happens only while reading.

const RATES_URL = "https://open.er-api.com/v6/latest/USD";
const RATES_TTL = 12 * 3_600_000;
const STORE_TTL = 6 * 3_600_000;

/** Currencies offered in the picker (only those the rate source knows are shown). */
export const CURRENCY_CHOICES = [
  "INR", "USD", "EUR", "GBP", "AED", "AUD", "CAD", "SGD", "JPY", "CNY", "HKD", "NZD", "CHF", "SEK", "NOK", "DKK",
  "ZAR", "SAR", "QAR", "KWD", "BHD", "OMR", "MYR", "THB", "IDR", "PHP", "KRW", "BRL", "MXN", "TRY", "BDT", "LKR", "NPR", "PKR",
];

type Rates = Record<string, number>; // units of each currency per 1 USD

let ratesCache: { rates: Rates; at: number } | null = null;
const storeCache = new Map<string, { code: string; at: number }>();

export async function getRates(): Promise<{ rates: Rates; fetchedAt: number | null }> {
  if (ratesCache && Date.now() - ratesCache.at < RATES_TTL) return { rates: ratesCache.rates, fetchedAt: ratesCache.at };
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(6000) });
    const json = (await res.json()) as { result?: string; rates?: Rates };
    if (res.ok && json.result === "success" && json.rates?.USD) {
      ratesCache = { rates: json.rates, at: Date.now() };
    }
  } catch {
    /* fall through to the stale copy */
  }
  return ratesCache ? { rates: ratesCache.rates, fetchedAt: ratesCache.at } : { rates: {}, fetchedAt: null };
}

/** The store's real currency, straight from Shopify (e.g. "USD" for a US dev store). */
async function storeCurrency(domain: string): Promise<string | null> {
  const hit = storeCache.get(domain);
  if (hit && Date.now() - hit.at < STORE_TTL) return hit.code;
  try {
    const data = await gql<{ shop: { currencyCode: string } }>(await getAdmin(domain), `#graphql query StoreCurrency { shop { currencyCode } }`);
    storeCache.set(domain, { code: data.shop.currencyCode, at: Date.now() });
    return data.shop.currencyCode;
  } catch {
    return hit?.code ?? null;
  }
}

/** Amount in `from` → `to`, rounded to 2 decimals. Same currency is returned untouched; unknown rates leave it unconverted. */
export function convert(amount: number, from: string, to: string, rates: Rates): number {
  if (from === to) return amount;
  const rf = rates[from];
  const rt = rates[to];
  return rf && rt ? Math.round(((amount * rt) / rf) * 100) / 100 : amount;
}

export type CurrencyContext = {
  /** the store's own currency — what returns are recorded in */
  base: string;
  /** what this page shows */
  display: string;
  /** every currency present in the shop's returns (usually just `base`) */
  sources: string[];
  rates: Rates;
  fetchedAt: string | null;
  options: string[];
  mixed: boolean;
  /** true when the requested currency couldn't be used because rates aren't available */
  ratesMissing: boolean;
};

/**
 * `requested` is the `?cur=` from the URL (the browser remembers the merchant's choice). If it's missing or unusable the
 * page simply shows the store currency, i.e. the original values.
 */
export async function currencyContext(
  shop: { id: string; domain: string; currency: string | null },
  requested?: string | null,
): Promise<CurrencyContext> {
  const [{ rates, fetchedAt }, live, used] = await Promise.all([
    getRates(),
    storeCurrency(shop.domain),
    db.returnRequest.groupBy({ by: ["currency"], where: { shopId: shop.id, currency: { not: null } }, _count: true, orderBy: { _count: { currency: "desc" } } }),
  ]);
  const sources = used.map((u) => u.currency!).filter(Boolean);
  // Live Shopify value wins; stored values are only a fallback when Shopify can't be reached.
  const base = live ?? shop.currency ?? sources[0] ?? "USD";
  const wanted = (requested ?? base).toUpperCase();
  const usable = wanted === base || (!!rates[wanted] && !!rates[base]);
  const display = usable ? wanted : base;
  const allSources = [...new Set([base, ...sources])];
  return {
    base,
    display,
    sources: allSources,
    rates,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    options: [...new Set([base, display, ...CURRENCY_CHOICES.filter((c) => rates[c])])],
    mixed: allSources.length > 1,
    ratesMissing: !usable,
  };
}

/**
 * SQL expression that converts a money column to the display currency, row by row:
 * `fx(cx, '"currency"')` → `CASE COALESCE("currency", 'USD') WHEN 'INR' THEN 0.012 … ELSE 1 END`.
 * Built from the handful of currencies actually present. `col` is a trusted literal, never user text.
 */
export function fx(cx: CurrencyContext, col: string): Prisma.Sql {
  const branches = cx.sources
    .filter((s) => s !== cx.display)
    .map((s) => Prisma.sql`WHEN ${s} THEN ${cx.rates[cx.display] && cx.rates[s] ? cx.rates[cx.display] / cx.rates[s] : 1}::float8`);
  if (!branches.length) return Prisma.sql`1::float8`;
  return Prisma.sql`(CASE COALESCE(${Prisma.raw(col)}, ${cx.base}) ${Prisma.join(branches, " ")} ELSE 1::float8 END)`;
}

/** What the browser needs (no 160-entry rate table, no internal source list). */
export const publicCurrency = (cx: CurrencyContext) => ({
  base: cx.base,
  display: cx.display,
  options: cx.options,
  mixed: cx.mixed,
  fetchedAt: cx.fetchedAt,
  ratesMissing: cx.ratesMissing,
});
export type PublicCurrency = ReturnType<typeof publicCurrency>;
