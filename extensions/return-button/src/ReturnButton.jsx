import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// A button on the customer's order page that opens the store's return/exchange form for THIS order.
// Nothing sensitive happens here: it only links to  <storefront>/apps/returns/form?id=<order id>  . Shopify's app proxy
// signs that request and tells our app which customer is logged in, so the form can confirm the customer owns the order
// without asking for an email or an order number. The form's design is the store's own, saved in the app.

export default async () => {
  render(<ReturnButton />, document.body);
};

/**
 * Re-render when a Shopify signal changes (the order can arrive a moment after the block mounts).
 * @template T
 * @param {{ value: T, subscribe: (callback: (value: T) => void) => () => void }} signal
 * @returns {T}
 */
function useSignal(signal) {
  const [value, setValue] = useState(signal.value);
  useEffect(() => signal.subscribe((next) => setValue(next)), [signal]);
  return value;
}

function ReturnButton() {
  const order = useSignal(shopify.order);
  const settings = useSignal(shopify.settings) ?? {};
  if (!order?.id) return null;

  // base address of the store; the app proxy lives at /apps/returns on it
  const base = (shopify.shop.storefrontUrl || `https://${shopify.shop.myshopifyDomain}`).replace(/\/$/, "");
  const orderId = order.id.split("/").pop() ?? "";
  const href = `${base}/apps/returns/form?id=${encodeURIComponent(orderId)}`;

  const heading = settings.heading || "Need to return or exchange something?";
  const description = settings.description || "Start a return or exchange for the items in this order.";
  const label = settings.button_label || "Return or exchange items";

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{heading}</s-heading>
        <s-text>{description}</s-text>
        <s-button href={href} target="_blank" variant="primary">
          {label}
        </s-button>
      </s-stack>
    </s-section>
  );
}
