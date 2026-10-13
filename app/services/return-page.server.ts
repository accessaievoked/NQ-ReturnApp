import db from "../db.server";
import { fmtMoney } from "../lib/format";
import {
  DEFAULT_FORM_CSS,
  DEFAULT_FORM_HTML,
  compileStyle,
  escapeHtml,
  normalizeStyle,
  renderReturnForm,
  type FormData,
  type FormStyle,
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

  let data: FormData;
  let status = 200;
  const triedProof = !!(input.customerId || input.email);
  if (!rawRef) {
    data = unverified("");
    data.orderName = "your order";
    status = 400;
  } else if (!triedProof) {
    data = unverified(""); // ask for the email; nothing about the order is revealed yet
  } else {
    try {
      const found = await lookupOrderBy(shopDomain, input.ref, { customerId: input.customerId, email: input.email });
      const requests = await requestsForOrder(shop.id, found.order.id);
      data = toFormData(found, { requestsHtml: requestsMarkup(requests), photoMode });
    } catch (e) {
      if (!(e instanceof PortalError)) throw e;
      data = unverified(e.message);
    }
  }

  return { status, html: pageHtml({ body: renderReturnForm(template, data), css, style, data, email: input.customerId ? "" : input.email ?? "", requireNote: settings.requireNote }) };
}

function pageHtml(p: { body: string; css: string; style: FormStyle; data: FormData; email: string; requireNote: boolean }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Return or exchange${p.data.orderName ? ` · ${escapeHtml(p.data.orderName)}` : ""}</title>
<style>body{margin:0;background:#fff}${"\n"}${p.css}${"\n"}${compileStyle(p.style)}</style>
</head>
<body>
<div class="er-root" data-order-id="${escapeHtml(p.data.orderId)}" data-email="${escapeHtml(p.email)}" data-photo-mode="${p.data.photoMode}" data-require-note="${p.requireNote}">
${p.body}
</div>
<script>${RETURN_FORM_SCRIPT}</script>
</body>
</html>`;
}
