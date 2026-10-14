import "@shopify/ui-extensions/preact";
import { render } from "preact";

// A button in each order's action row (next to "Pay now" / "Buy again") — on the orders list and on the order page.
// It opens the store's return form for THAT order, already filled in (same link as the order-page block).

export default async () => {
  render(<ReturnAction />, document.body);
};

function ReturnAction() {
  const order = shopify.order.value;
  if (!order?.id) return null;
  const base = (shopify.shop.storefrontUrl || `https://${shopify.shop.myshopifyDomain}`).replace(/\/$/, "");
  const orderId = order.id.split("/").pop() ?? "";
  const href = `${base}/apps/returns/form?id=${encodeURIComponent(orderId)}`;
  const label = (shopify.settings.value ?? {}).button_label || "Return or exchange";

  return (
    <s-button href={href} target="_blank">
      {label}
    </s-button>
  );
}
