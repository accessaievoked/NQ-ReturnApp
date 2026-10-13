import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { randomToken } from "../services/crypto.server";
import { connectShiprocket, disconnectShiprocket, ensureConnection, ShiprocketError, walletBalance } from "../services/shiprocket.server";
import { fmtDate } from "../lib/format";
import { COLORS, Card, btn, grid, input } from "../lib/ui";

// Shiprocket refuses webhook URLs containing these words (their docs), so warn before the merchant pastes one.
const BAD_URL = /shiprocket|kartrocket|(^|[^a-z])(sr|kr)([^a-z]|$)/i;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const conn = await ensureConnection(shop.id);
  const appUrl = (process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
  const webhookUrl = `${appUrl}/hooks/logistics/${conn.publicId}`;
  return {
    connected: conn.connected,
    email: conn.email,
    webhookUrl,
    webhookToken: conn.webhookSecret,
    badUrl: BAD_URL.test(webhookUrl),
    lastWebhookAt: conn.lastWebhookAt?.toISOString() ?? null,
    lastError: conn.lastError,
    s: {
      whName: conn.whName ?? "",
      whAddress: conn.whAddress ?? "",
      whAddress2: conn.whAddress2 ?? "",
      whCity: conn.whCity ?? "",
      whState: conn.whState ?? "",
      whPincode: conn.whPincode ?? "",
      whPhone: conn.whPhone ?? "",
      whEmail: conn.whEmail ?? "",
      parcelLength: conn.parcelLength,
      parcelBreadth: conn.parcelBreadth,
      parcelHeight: conn.parcelHeight,
      parcelWeight: conn.parcelWeight,
      autoPickup: conn.autoPickup,
      autoReceive: conn.autoReceive,
      autoRefund: conn.autoRefund,
    },
  };
};

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const positive = (f: FormData, k: string, fallback: number) => {
  const n = Number(f.get(k));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const f = await request.formData();
  const intent = str(f, "intent");

  try {
    if (intent === "connect") {
      const email = str(f, "email");
      const password = String(f.get("password") ?? "");
      if (!email || !password) return { error: "Enter the Shiprocket API user's email and password." };
      const { wallet } = await connectShiprocket(shop.id, email, password);
      return { ok: `Connected to Shiprocket${wallet != null ? ` — wallet balance ₹${wallet.toFixed(2)}` : ""}.` };
    }
    if (intent === "disconnect") {
      await disconnectShiprocket(shop.id);
      return { ok: "Shiprocket disconnected. Your settings are kept." };
    }
    if (intent === "test") {
      const conn = await ensureConnection(shop.id);
      const wallet = await walletBalance(conn);
      return wallet != null ? { ok: `Connection works. Wallet balance ₹${wallet.toFixed(2)}.` } : { error: "Could not read the wallet — check the API user's permissions or reconnect." };
    }
    if (intent === "rotate") {
      const conn = await ensureConnection(shop.id);
      await db.shiprocketConnection.update({ where: { id: conn.id }, data: { webhookSecret: randomToken(24) } });
      return { ok: "New webhook token created. Paste it into Shiprocket (Settings → API → Webhooks)." };
    }
    if (intent === "save") {
      const pin = str(f, "whPincode").replace(/\D/g, "");
      const phone = str(f, "whPhone").replace(/\D/g, "").slice(-10);
      if (pin && pin.length !== 6) return { error: "The warehouse pincode must be 6 digits." };
      if (str(f, "whPhone") && phone.length !== 10) return { error: "The warehouse phone must be a 10-digit number." };
      const conn = await ensureConnection(shop.id);
      await db.shiprocketConnection.update({
        where: { id: conn.id },
        data: {
          whName: str(f, "whName") || null,
          whAddress: str(f, "whAddress") || null,
          whAddress2: str(f, "whAddress2") || null,
          whCity: str(f, "whCity") || null,
          whState: str(f, "whState") || null,
          whPincode: pin || null,
          whPhone: phone || null,
          whEmail: str(f, "whEmail") || null,
          parcelLength: positive(f, "parcelLength", 10),
          parcelBreadth: positive(f, "parcelBreadth", 10),
          parcelHeight: positive(f, "parcelHeight", 10),
          parcelWeight: positive(f, "parcelWeight", 0.5),
          autoPickup: f.get("autoPickup") === "on",
          autoReceive: f.get("autoReceive") === "on",
          autoRefund: f.get("autoRefund") === "on",
        },
      });
      return { ok: "Shipping settings saved." };
    }
  } catch (err) {
    return { error: err instanceof ShiprocketError ? `Shiprocket said: ${err.message}` : err instanceof Error ? err.message : "Something went wrong." };
  }
  return { error: "Unknown action." };
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ color: COLORS.subdued, fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

function Copy({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <div style={{ display: "flex", gap: 8 }}>
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, fontFamily: "monospace", fontSize: 12 }} aria-label={label} />
        <button
          type="button"
          style={btn("secondary")}
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            });
          }}
        >
          {done ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function Shipping() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const num = { ...input, width: "100%" } as const;

  return (
    <s-page heading="Shipping & logistics">
      <div style={{ display: "grid", gap: 16 }}>
        {result && "error" in result && result.error && <s-banner tone="critical">{result.error}</s-banner>}
        {result && "ok" in result && result.ok && <s-banner tone="success" dismissible>{result.ok}</s-banner>}

        <Card
          title="Shiprocket"
          right={d.connected ? <s-badge tone="success">Connected</s-badge> : <s-badge tone="neutral">Not connected</s-badge>}
        >
          <p style={{ margin: "0 0 12px", fontSize: 14, color: COLORS.subdued }}>
            Connect a Shiprocket <strong>API user</strong> (Shiprocket → Settings → API → Add New API User; it must use a different email from your main login).
            Once connected, approved returns can have their reverse pickup booked automatically, and Shiprocket&apos;s tracking updates flow back into your returns.
            Your password is stored encrypted and only used to log in to Shiprocket.
          </p>
          {d.connected ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 14 }}>Signed in as <strong>{d.email}</strong></span>
              <Form method="post"><input type="hidden" name="intent" value="test" /><button style={btn("secondary", busy)} disabled={busy}>Check connection</button></Form>
              <Form method="post" onSubmit={(e) => !window.confirm("Disconnect Shiprocket? Automatic pickups and tracking updates will stop.") && e.preventDefault()}>
                <input type="hidden" name="intent" value="disconnect" />
                <button style={btn("danger", busy)} disabled={busy}>Disconnect</button>
              </Form>
            </div>
          ) : (
            <Form method="post" style={{ display: "grid", gap: 10, maxWidth: 420 }}>
              <input type="hidden" name="intent" value="connect" />
              <Field label="API user email"><input name="email" type="email" required autoComplete="off" style={num} /></Field>
              <Field label="API user password"><input name="password" type="password" required autoComplete="new-password" style={num} /></Field>
              <div><button style={btn("primary", busy)} disabled={busy}>{busy ? "Connecting…" : "Connect Shiprocket"}</button></div>
            </Form>
          )}
          {d.lastError && <div style={{ marginTop: 10, fontSize: 13, color: "#b4331a" }}>Last problem: {d.lastError}</div>}
        </Card>

        <Card title="Tracking webhook" hint="Shiprocket calls this address every time a shipment's status changes.">
          <div style={{ display: "grid", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 14, color: COLORS.subdued }}>
              In Shiprocket go to <strong>Settings → API → Webhooks</strong>, paste the URL and token below, and switch the toggle on. Pickups, transit scans and delivery then update your returns automatically.
            </p>
            <Copy label="Webhook URL" value={d.webhookUrl} />
            <Copy label="Security token (sent as x-api-key)" value={d.webhookToken} />
            {d.badUrl && (
              <s-banner tone="warning">
                This URL contains a word Shiprocket rejects in webhook URLs (“shiprocket”, “sr”, “kr” or “kartrocket”). Your app address is probably a temporary development tunnel; a production domain without those words will work.
              </s-banner>
            )}
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: COLORS.subdued }}>
              <span>Last update received: {d.lastWebhookAt ? fmtDate(d.lastWebhookAt) : "never"}</span>
              <Form method="post" onSubmit={(e) => !window.confirm("Create a new token? You must paste it into Shiprocket or updates will be rejected.") && e.preventDefault()}>
                <input type="hidden" name="intent" value="rotate" />
                <button style={btn("secondary", busy)} disabled={busy}>Generate new token</button>
              </Form>
            </div>
          </div>
        </Card>

        <Form method="post" style={{ display: "grid", gap: 16 }}>
          <input type="hidden" name="intent" value="save" />

          <Card title="What runs automatically" hint="Approval stays with you (or your automation rules). Everything after it can run on its own.">
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input id="autoPickup" type="checkbox" name="autoPickup" defaultChecked={d.s.autoPickup} style={{ marginTop: 3 }} />
                <div>
                  <label htmlFor="autoPickup" style={{ fontSize: 14, fontWeight: 600 }}>Book the reverse pickup when a return is approved</label>
                  <div style={{ color: COLORS.subdued, fontSize: 13 }}>Creates the Shiprocket return order, picks a courier, schedules the pickup and saves the tracking number to the return and to Shopify. Freight is charged to your Shiprocket wallet.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input id="autoReceive" type="checkbox" name="autoReceive" defaultChecked={d.s.autoReceive} style={{ marginTop: 3 }} />
                <div>
                  <label htmlFor="autoReceive" style={{ fontSize: 14, fontWeight: 600 }}>Mark as received when the courier delivers it</label>
                  <div style={{ color: COLORS.subdued, fontSize: 13 }}>Turn off if you want to inspect each parcel before it counts as received.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input id="autoRefund" type="checkbox" name="autoRefund" defaultChecked={d.s.autoRefund} style={{ marginTop: 3 }} />
                <div>
                  <label htmlFor="autoRefund" style={{ fontSize: 14, fontWeight: 600 }}>Refund automatically once received</label>
                  <div style={{ color: COLORS.subdued, fontSize: 13 }}>Prepaid returns are refunded to the original payment; exchanges are completed and any leftover money refunded. Cash-on-delivery returns are never refunded automatically. This moves real money &mdash; leave it off until you&apos;ve watched a few returns go through.</div>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Return warehouse" hint="Where returned parcels are delivered.">
            <div style={grid(220, 12)}>
              <Field label="Contact / company name"><input name="whName" defaultValue={d.s.whName} style={num} /></Field>
              <Field label="Phone (10 digits)"><input name="whPhone" defaultValue={d.s.whPhone} inputMode="numeric" style={num} /></Field>
              <Field label="Email"><input name="whEmail" type="email" defaultValue={d.s.whEmail} style={num} /></Field>
              <Field label="Address line 1"><input name="whAddress" defaultValue={d.s.whAddress} style={num} /></Field>
              <Field label="Address line 2"><input name="whAddress2" defaultValue={d.s.whAddress2} style={num} /></Field>
              <Field label="City"><input name="whCity" defaultValue={d.s.whCity} style={num} /></Field>
              <Field label="State"><input name="whState" defaultValue={d.s.whState} style={num} /></Field>
              <Field label="Pincode"><input name="whPincode" defaultValue={d.s.whPincode} inputMode="numeric" style={num} /></Field>
            </div>
          </Card>

          <Card title="Default parcel" hint="Used for every reverse pickup. Shiprocket re-weighs and adjusts the freight.">
            <div style={grid(160, 12)}>
              <Field label="Length (cm)"><input name="parcelLength" type="number" min={0.1} step="0.1" defaultValue={d.s.parcelLength} style={num} /></Field>
              <Field label="Breadth (cm)"><input name="parcelBreadth" type="number" min={0.1} step="0.1" defaultValue={d.s.parcelBreadth} style={num} /></Field>
              <Field label="Height (cm)"><input name="parcelHeight" type="number" min={0.1} step="0.1" defaultValue={d.s.parcelHeight} style={num} /></Field>
              <Field label="Weight (kg)"><input name="parcelWeight" type="number" min={0.01} step="0.01" defaultValue={d.s.parcelWeight} style={num} /></Field>
            </div>
          </Card>

          <div><button style={btn("primary", busy)} disabled={busy}>Save shipping settings</button></div>
        </Form>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
