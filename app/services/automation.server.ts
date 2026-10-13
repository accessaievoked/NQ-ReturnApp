import type { AutomationRule, Prisma } from "@prisma/client";
import db from "../db.server";
import {
  PRIOR_RETURNS_WINDOW_DAYS,
  evaluateRule,
  isCOD,
  type RuleConditions,
  type RuleContext,
} from "../lib/automation";
import { convert, currencyContext } from "./currency.server";
import { performReturnAction } from "./returns.server";

type ReturnWithItems = Prisma.ReturnRequestGetPayload<{
  include: { items: { include: { product: { select: { productType: true } } } } };
}>;

const DAY = 86_400_000;

export const ruleConditions = (rule: Pick<AutomationRule, "conditions">) => (rule.conditions ?? {}) as RuleConditions;

type Money = { base: string; rates: Record<string, number> };

/** Rule thresholds are in the store currency, so a return in another currency is converted first. */
export function contextFor(ret: ReturnWithItems, priorReturns: number, money: Money, now = new Date()): RuleContext {
  return {
    returnValue: convert(Number(ret.returnValue), ret.currency ?? money.base, money.base, money.rates),
    quantity: ret.items.reduce((n, i) => n + i.quantity, 0),
    reasons: ret.items.map((i) => i.reason).filter((r): r is string => !!r),
    productTypes: ret.items.map((i) => i.product?.productType).filter((t): t is string => !!t),
    isCOD: isCOD(ret.paymentMethod),
    daysSinceOrder: ret.orderCreatedAt ? Math.floor((now.getTime() - ret.orderCreatedAt.getTime()) / DAY) : null,
    priorReturns,
  };
}

async function priorReturnCount(shopId: string, ret: { id: string; customerEmail: string | null; requestedAt: Date }) {
  if (!ret.customerEmail) return 0;
  return db.returnRequest.count({
    where: {
      shopId,
      customerEmail: ret.customerEmail,
      id: { not: ret.id },
      requestedAt: { gte: new Date(ret.requestedAt.getTime() - PRIOR_RETURNS_WINDOW_DAYS * DAY), lte: ret.requestedAt },
    },
  });
}

const WITH_ITEMS = { items: { include: { product: { select: { productType: true } } } } } as const;

/**
 * Runs the shop's enabled rules (lowest priority number first) against one REQUESTED return.
 * The first matching rule approves or declines it on Shopify. Never throws: failures are logged
 * to AutomationRun so a bad rule can't make the webhook fail and retry forever.
 */
export async function runAutomations(shopDomain: string, localReturnId: string) {
  try {
    const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return null;
    const rules = await db.automationRule.findMany({
      where: { shopId: shop.id, enabled: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    if (!rules.length) return null;

    const ret = await db.returnRequest.findFirst({ where: { id: localReturnId, shopId: shop.id }, include: WITH_ITEMS });
    if (!ret || ret.status !== "REQUESTED") return null;
    // Exchanges always wait for the merchant: they involve a replacement product and a price difference.
    if (ret.exchangeUnits > 0) return null;

    const ctx = contextFor(ret, await priorReturnCount(shop.id, ret), await currencyContext(shop));
    const rule = rules.find((r) => evaluateRule(ruleConditions(r), ctx));
    if (!rule) return null;

    const action = rule.action === "APPROVE" ? "approve" : "decline";
    const result = await performReturnAction(
      shopDomain,
      ret.id,
      action,
      `Automation: ${rule.name}`,
      rule.action === "DECLINE" ? rule.declineNote ?? undefined : undefined,
    );
    await db.automationRun.create({
      data: {
        shopId: shop.id,
        ruleId: rule.id,
        returnId: ret.id,
        action: rule.action,
        ok: result.ok,
        error: result.ok ? null : result.error,
      },
    });
    if (result.ok) await db.returnRequest.update({ where: { id: ret.id }, data: { autoHandled: true } });
    return { rule, ok: result.ok };
  } catch (err) {
    console.error(`Automation failed for return ${localReturnId}`, err);
    return null;
  }
}

/** Apply the rules to every return still waiting for a decision (merchant-triggered). */
export async function runAutomationsOnPending(shopDomain: string) {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return { checked: 0, handled: 0 };
  const pending = await db.returnRequest.findMany({
    where: { shopId: shop.id, status: "REQUESTED" },
    select: { id: true },
    orderBy: { requestedAt: "asc" },
    take: 200,
  });
  let handled = 0;
  for (const p of pending) {
    const r = await runAutomations(shopDomain, p.id);
    if (r?.ok) handled++;
  }
  return { checked: pending.length, handled };
}

/** For each rule, how many of the shop's latest returns it would have matched (no side effects). */
export async function previewRules(shop: { id: string; domain: string; currency: string | null }, rules: AutomationRule[], sample = 100) {
  const shopId = shop.id;
  if (!rules.length) return {} as Record<string, { matched: number; sample: number }>;
  const recent = await db.returnRequest.findMany({
    where: { shopId },
    orderBy: { requestedAt: "desc" },
    take: sample,
    include: WITH_ITEMS,
  });
  const money = await currencyContext(shop);
  const out: Record<string, { matched: number; sample: number }> = {};
  for (const rule of rules) out[rule.id] = { matched: 0, sample: recent.length };
  for (const ret of recent) {
    // Approximate "other returns in 90d" from the sample itself — cheap and good enough for a preview.
    const prior = recent.filter(
      (o) =>
        o.id !== ret.id &&
        o.customerEmail &&
        o.customerEmail === ret.customerEmail &&
        o.requestedAt <= ret.requestedAt &&
        ret.requestedAt.getTime() - o.requestedAt.getTime() <= PRIOR_RETURNS_WINDOW_DAYS * DAY,
    ).length;
    const ctx = contextFor(ret, prior, money, ret.requestedAt);
    for (const rule of rules) if (evaluateRule(ruleConditions(rule), ctx)) out[rule.id].matched++;
  }
  return out;
}
