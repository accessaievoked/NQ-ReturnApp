import "@shopify/ui-extensions/preact";
import { render } from "preact";

// Shown above the customer's ORDERS LIST (no single order yet). It opens the store's returns page, where the customer
// types the order number and email. Same editable texts as the order-page block.

export default async () => {
  render(<ReturnLink />, document.body);
};

function ReturnLink() {
  const settings = shopify.settings.value ?? {};
  const base = (shopify.shop.storefrontUrl || `https://${shopify.shop.myshopifyDomain}`).replace(/\/$/, "");
  const href = `${base}/apps/returns/form`;

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>{settings.heading || "Need to return or exchange something?"}</s-heading>
        {settings.description ? <s-text>{settings.description}</s-text> : null}
        <s-button href={href} target="_blank" variant="primary">
          {settings.button_label || "Return or exchange items"}
        </s-button>
      </s-stack>
    </s-section>
  );
}
