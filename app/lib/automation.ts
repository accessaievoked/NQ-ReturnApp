// Rule model + evaluator. Pure (no DB, no Node APIs) so the same code powers
// the server-side engine, the "would match" preview and the rule descriptions in the UI.

export type RuleAction = "APPROVE" | "DECLINE";

export type RuleConditions = {
  minReturnValue?: number;
  maxReturnValue?: number;
  maxQuantity?: number;
  /** matches when ANY returned item has one of these reasons (case-insensitive) */
  reasons?: string[];
  /** matches when ANY returned item belongs to one of these product types */
  productTypes?: string[];
  paymentMode?: "COD" | "PREPAID";
  /** order must be at most / at least this many days old when the return is requested */
  maxDaysSinceOrder?: number;
  minDaysSinceOrder?: number;
  /** customer's other returns in the last 90 days */
  minPriorReturns?: number;
  maxPriorReturns?: number;
};

export type RuleContext = {
  /** in the STORE currency — rule thresholds are written in it */
  returnValue: number;
  quantity: number;
  reasons: string[];
  productTypes: string[];
  isCOD: boolean;
  daysSinceOrder: number | null;
  priorReturns: number;
};

export const AUTOMATION_MINUTES_SAVED = 3; // per automated decision, used for the "hours saved" KPI
export const PRIOR_RETURNS_WINDOW_DAYS = 90;

export const isCOD = (paymentMethod?: string | null) => /cod|cash/i.test(paymentMethod ?? "");

const lc = (s: string) => s.trim().toLowerCase();

export function evaluateRule(c: RuleConditions, ctx: RuleContext): boolean {
  if (c.minReturnValue != null && ctx.returnValue < c.minReturnValue) return false;
  if (c.maxReturnValue != null && ctx.returnValue > c.maxReturnValue) return false;
  if (c.maxQuantity != null && ctx.quantity > c.maxQuantity) return false;
  if (c.reasons?.length) {
    const wanted = new Set(c.reasons.map(lc));
    if (!ctx.reasons.some((r) => wanted.has(lc(r)))) return false;
  }
  if (c.productTypes?.length) {
    const wanted = new Set(c.productTypes.map(lc));
    if (!ctx.productTypes.some((t) => wanted.has(lc(t)))) return false;
  }
  if (c.paymentMode === "COD" && !ctx.isCOD) return false;
  if (c.paymentMode === "PREPAID" && ctx.isCOD) return false;
  if (c.maxDaysSinceOrder != null && (ctx.daysSinceOrder == null || ctx.daysSinceOrder > c.maxDaysSinceOrder)) return false;
  if (c.minDaysSinceOrder != null && (ctx.daysSinceOrder == null || ctx.daysSinceOrder < c.minDaysSinceOrder)) return false;
  if (c.minPriorReturns != null && ctx.priorReturns < c.minPriorReturns) return false;
  if (c.maxPriorReturns != null && ctx.priorReturns > c.maxPriorReturns) return false;
  return true;
}

export const hasAnyCondition = (c: RuleConditions) =>
  Object.values(c).some((v) => (Array.isArray(v) ? v.length > 0 : v != null));

/** Human-readable bullets, e.g. ["Return value ≤ INR 1000", "Reason is Size too small"]. */
export function describeConditions(c: RuleConditions, currency = ""): string[] {
  const out: string[] = [];
  const money = (n: number) => `${currency ? `${currency} ` : ""}${n}`;
  if (c.minReturnValue != null) out.push(`Return value ≥ ${money(c.minReturnValue)}`);
  if (c.maxReturnValue != null) out.push(`Return value ≤ ${money(c.maxReturnValue)}`);
  if (c.maxQuantity != null) out.push(`At most ${c.maxQuantity} unit${c.maxQuantity === 1 ? "" : "s"}`);
  if (c.reasons?.length) out.push(`Reason is ${c.reasons.join(" or ")}`);
  if (c.productTypes?.length) out.push(`Product type is ${c.productTypes.join(" or ")}`);
  if (c.paymentMode) out.push(c.paymentMode === "COD" ? "Cash on delivery order" : "Prepaid order");
  if (c.maxDaysSinceOrder != null) out.push(`Requested within ${c.maxDaysSinceOrder} days of the order`);
  if (c.minDaysSinceOrder != null) out.push(`Requested ${c.minDaysSinceOrder}+ days after the order`);
  if (c.minPriorReturns != null) out.push(`Customer has ≥ ${c.minPriorReturns} other returns in ${PRIOR_RETURNS_WINDOW_DAYS}d`);
  if (c.maxPriorReturns != null) out.push(`Customer has ≤ ${c.maxPriorReturns} other returns in ${PRIOR_RETURNS_WINDOW_DAYS}d`);
  return out;
}

const num = (v: FormDataEntryValue | null) => {
  if (v == null || String(v).trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads the rule form. Empty inputs are simply left out of the conditions. */
export function conditionsFromForm(form: FormData): RuleConditions {
  const c: RuleConditions = {};
  const nums = [
    "minReturnValue",
    "maxReturnValue",
    "maxQuantity",
    "maxDaysSinceOrder",
    "minDaysSinceOrder",
    "minPriorReturns",
    "maxPriorReturns",
  ] as const;
  for (const k of nums) {
    const v = num(form.get(k));
    if (v !== undefined) c[k] = v;
  }
  const reasons = [...form.getAll("reasons").map(String), ...list(form.get("reasonsExtra"))];
  if (reasons.length) c.reasons = [...new Set(reasons)];
  const types = list(form.get("productTypes"));
  if (types.length) c.productTypes = types;
  const pm = String(form.get("paymentMode") ?? "");
  if (pm === "COD" || pm === "PREPAID") c.paymentMode = pm;
  return c;
}

export type RuleTemplate = {
  key: string;
  name: string;
  description: string;
  action: RuleAction;
  declineNote?: string;
  conditions: RuleConditions;
};

/** One-click starting points. Created *disabled* so nothing fires until the merchant reviews them. */
export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    key: "low-value",
    name: "Auto-approve low-value returns",
    description: "Not worth a manual review: approve anything worth 1,000 or less (in your store currency).",
    action: "APPROVE",
    conditions: { maxReturnValue: 1000 },
  },
  {
    key: "size-issues",
    name: "Auto-approve size issues",
    description: "Sizing returns are rarely disputed. Approve them within 10 days of the order.",
    action: "APPROVE",
    conditions: { reasons: ["Size too small", "Size too large"], maxDaysSinceOrder: 10 },
  },
  {
    key: "window",
    name: "Auto-decline outside return window",
    description: "Decline requests raised more than 15 days after the order.",
    action: "DECLINE",
    declineNote: "This order is outside our 15-day return window.",
    conditions: { minDaysSinceOrder: 16 },
  },
  {
    key: "serial",
    name: "Auto-decline repeat returners",
    description: "Decline when the customer already has 3+ other returns in the last 90 days.",
    action: "DECLINE",
    declineNote: "We're unable to accept further returns on this account. Please contact support.",
    conditions: { minPriorReturns: 3 },
  },
];
