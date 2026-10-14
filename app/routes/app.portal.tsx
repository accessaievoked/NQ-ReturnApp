import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { getPortalSettings } from "../services/portal.server";
import { COLORS, Card, btn, grid, input } from "../lib/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const s = await getPortalSettings(shop.id);
  return { s, store: session.shop };
};

const int = (f: FormData, k: string, fallback: number, min: number, max: number) => {
  const n = Math.floor(Number(f.get(k)));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const f = await request.formData();
  await getPortalSettings(shop.id);
  await db.portalSettings.update({
    where: { shopId: shop.id },
    data: {
      enabled: f.get("enabled") === "on",
      allowReturns: f.get("allowReturns") === "on",
      allowExchanges: f.get("allowExchanges") === "on",
      exchangeMode: f.get("exchangeMode") === "ANY" ? "ANY" : "VARIANT",
      windowDays: int(f, "windowDays", 30, 1, 365),
      nonReturnableTag: String(f.get("nonReturnableTag") ?? "").trim().slice(0, 60),
      requireNote: f.get("requireNote") === "on",
      photoMode: ["OFF", "REQUIRED"].includes(String(f.get("photoMode"))) ? String(f.get("photoMode")) : "OPTIONAL",
      notice: String(f.get("notice") ?? "").trim().slice(0, 300) || null,
    },
  });
  return { ok: true as const };
};

function Check({ id, name, label, hint, checked }: { id: string; name: string; label: string; hint?: string; checked: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <input id={id} type="checkbox" name={name} defaultChecked={checked} style={{ marginTop: 3 }} />
      <div>
        <label htmlFor={id} style={{ fontSize: 14, fontWeight: 600 }}>{label}</label>
        {hint && <div style={{ fontSize: 13, color: COLORS.subdued }}>{hint}</div>}
      </div>
    </div>
  );
}

export default function Portal() {
  const { s, store } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const num = { ...input, width: "100%" } as const;

  return (
    <s-page heading="Return & exchange form">
      <div style={{ display: "grid", gap: 16 }}>
        {result?.ok && <s-banner tone="success" dismissible>Form settings saved.</s-banner>}

        <Card title="1 · A returns page anyone can open">
          <p style={{ margin: "0 0 8px", fontSize: 14 }}>
            Customers type their order number and email, then see the form. Add this link to your store menu, footer or order emails:
          </p>
          <code style={{ display: "block", padding: "10px 12px", background: "#f6f6f7", borderRadius: 8, fontSize: 13, wordBreak: "break-all" }}>
            https://{store}/apps/returns/form
          </code>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: COLORS.subdued }}>
            Use your storefront domain if it differs from the one shown. A link ending in <code>?order=1089</code> fills the order number in for them.
          </p>
        </Card>

        <Card title="2 · A button on each order that opens the form already filled in">
          <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8, fontSize: 14 }}>
            <li>
              Open the customer accounts editor: Shopify admin → <strong>Settings → Customer accounts → Customize</strong> (or open it from{" "}
              <a href={`https://${store}/admin/settings/customer_accounts`} target="_top">here</a>).
            </li>
            <li>Choose the <strong>Order</strong> page, click <strong>Add block</strong> and pick <strong>Return button</strong> (it appears under your app). Place it where you like and save.</li>
            <li>
              Customers now see the button on each order. Clicking it opens your form for that order — they&apos;re already logged in, so there is nothing to search for or type.
              Design the form on the <Link to="/app/form-editor">Form design</Link> page.
            </li>
          </ol>
          <p style={{ margin: "12px 0 0", fontSize: 13, color: COLORS.subdued }}>
            Not using the new customer accounts? Use the returns page link above instead.
          </p>
        </Card>

        <Form method="post" style={{ display: "grid", gap: 16 }}>
          <Card title="What customers can do">
            <div style={{ display: "grid", gap: 12 }}>
              <Check id="enabled" name="enabled" label="Form is open" hint="Turn off to stop accepting new requests." checked={s.enabled} />
              <Check id="allowReturns" name="allowReturns" label="Allow returns" hint="Arrive in Shopify as pending requests for you to approve." checked={s.allowReturns} />
              <Check id="allowExchanges" name="allowExchanges" label="Allow exchanges" hint="Wait on the Exchange requests page until you approve them." checked={s.allowExchanges} />
              <Check id="requireNote" name="requireNote" label="Require a note for each item" hint="Customers must describe the problem." checked={s.requireNote} />
            </div>
          </Card>

          <Card title="Rules">
            <div style={grid(220, 12)}>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Return window (days after delivery)</span>
                <input name="windowDays" type="number" min={1} max={365} defaultValue={s.windowDays} style={num} />
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Exchange into</span>
                <select name="exchangeMode" defaultValue={s.exchangeMode} style={num}>
                  <option value="VARIANT">Other sizes / colours of the same product</option>
                  <option value="ANY">Any product in my store</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Customer photos</span>
                <select name="photoMode" defaultValue={s.photoMode} style={num}>
                  <option value="OPTIONAL">Optional (up to 3 per item)</option>
                  <option value="REQUIRED">Required for every item</option>
                  <option value="OFF">Don&apos;t ask for photos</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>Non-returnable product tag</span>
                <input name="nonReturnableTag" defaultValue={s.nonReturnableTag} placeholder="final-sale" style={num} />
                <span style={{ color: COLORS.subdued, fontSize: 12 }}>Products with this tag are shown as not returnable.</span>
              </label>
            </div>
            <label style={{ display: "grid", gap: 4, fontSize: 13, marginTop: 12 }}>
              <span style={{ fontWeight: 600 }}>Message at the top of the form (optional)</span>
              <input name="notice" defaultValue={s.notice ?? ""} maxLength={300} placeholder="e.g. Sale items can be exchanged but not refunded." style={num} />
            </label>
          </Card>

          <div><button style={btn("primary", busy)} disabled={busy}>Save form settings</button></div>
        </Form>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
