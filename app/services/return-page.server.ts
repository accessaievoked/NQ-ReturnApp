import db from "../db.server";
import { fmtMoney } from "../lib/format";
import {
  DEFAULT_FORM_CSS,
  DEFAULT_FORM_HTML,
  buildFormDocument,
  escapeHtml,
  normalizeStyle,
  renderReturnForm,
  type FormData,
} from "../lib/return-form-template";
import { RETURN_FORM_SCRIPT } from "../lib/return-form-script";
import { PortalError, getPortalSettings, lookupOrderBy, requestsForOrder, type LookupResult, type OrderRef } from "./portal.server";
import { ensureShop } from "./shop.server";

// Builds the HTML page for the customer's return form: the store's stored template + the order's live data.

/** Lookup result -> what the template renders (prices formatted, exchange price differences worked out). */
export function toFormData(r: LookupResult, extra: { requestsHtml: string; photoMode: FormData["photoMode"] }): FormData {
  const money = (n: number) => fmtMoney(n, r.order.currency);
  return {
    orderName: r.order.name,
    orderId: r.order.numericId,
    daysLeftText: r.daysLeft != null && r.daysLeft >= 0 ? `${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"} left in your ${r.settings.windowDays}-day return window` : "",
    notice: r.settings.notice,
    verify: { needed: false },
    items: r.items.map((i) => ({
      key: i.key,
      title: i.title,
      variantTitle: i.variantTitle,
      priceText: money(i.unitPrice),
      imageUrl: i.imageUrl,
      eligible: i.eligible,
      reason: i.reason,
      maxQty: i.quantity,
      exchange: i.exchange.map((o) => {
        const diff = o.price - i.unitPrice;
        return {
          variantId: o.variantId,
          label: [o.productTitle, o.variantTitle].filter(Boolean).join(" — "),
          diffText: Math.abs(diff) < 0.005 ? "same price" : diff > 0 ? `${money(diff)} more` : `${money(-diff)} less`,
        };
      }),
    })),
    reasons: r.reasons,
    allowReturns: r.settings.allowReturns,
    allowExchanges: r.settings.allowExchanges,
    photoMode: extra.photoMode,
    requestsHtml: extra.requestsHtml,
  };
}

const requestsMarkup = (rows: { label: string; status: string }[]) =>
  rows.map((r) => `<div class="er-req"><span>${escapeHtml(r.label)}</span><span>${escapeHtml(r.status)}</span></div>`).join("");

export type PageInput = { ref: OrderRef; customerId: string | null; email: string | null };

/** The page's HTML for one visit. Never throws: a problem becomes the email-confirmation screen with a message. */
export async function renderReturnPage(shopDomain: string, input: PageInput): Promise<{ status: number; html: string }> {
  const shop = await ensureShop(shopDomain);
  const theme = await db.returnFormTheme.findUnique({ where: { shopId: shop.id } });
  const template = theme?.html ?? DEFAULT_FORM_HTML;
  const css = theme?.css ?? DEFAULT_FORM_CSS;
  const style = normalizeStyle(theme?.style);
  const settings = await getPortalSettings(shop.id);
  const photoMode = (["OFF", "REQUIRED"].includes(settings.photoMode) ? settings.photoMode : "OPTIONAL") as FormData["photoMode"];

  const orderParam = input.ref.id ? "id" : "order";
  const rawRef = input.ref.id ?? input.ref.number ?? "";
  const unverified = (error: string): FormData => ({
    orderName: !input.ref.id && input.ref.number ? `#${input.ref.number.replace(/\D/g, "")}` : "your order",
    orderId: rawRef,
    daysLeftText: "",
    notice: settings.notice,
    verify: { needed: true, error, orderParam },
    items: [],
    reasons: [],
    allowReturns: true,
    allowExchanges: false,
    photoMode,
    requestsHtml: "",
  });
  // The "find your order" screen: opened from a link (no order yet), or the typed order number/email didn't match.
  const lookupScreen = (error: string): FormData => ({
    ...unverified(""),
    orderName: "",
    orderId: "",
    verify: { needed: false },
    lookup: { needed: true, error, order: input.ref.number ?? "", email: input.email ?? "" },
  });

  let data: FormData;
  const status = 200;
  const triedProof = !!(input.customerId || input.email);
  if (!rawRef) {
    data = lookupScreen("");
  } else if (!triedProof) {
    data = unverified(""); // an order button / link without a login: ask for the email; nothing about the order is revealed yet
  } else {
    try {
      const found = await lookupOrderBy(shopDomain, input.ref, { customerId: input.customerId, email: input.email });
      const requests = await requestsForOrder(shop.id, found.order.id);
      data = toFormData(found, { requestsHtml: requestsMarkup(requests), photoMode });
    } catch (e) {
      if (!(e instanceof PortalError)) throw e;
      data = input.ref.id ? unverified(e.message) : lookupScreen(e.message); // typed in by hand -> let them correct it
    }
  }

  const html = buildFormDocument({
    body: renderReturnForm(template, data),
    css,
    style,
    orderName: data.orderName,
    orderId: data.orderId,
    email: input.customerId ? "" : input.email ?? "",
    photoMode: data.photoMode,
    requireNote: settings.requireNote,
    script: RETURN_FORM_SCRIPT,
  });
  return { status, html };
}
