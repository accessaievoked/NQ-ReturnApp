import { useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { getPortalSettings } from "../services/portal.server";
import {
  DEFAULT_FORM_CSS,
  DEFAULT_FORM_HTML,
  DEFAULT_STYLE,
  FORM_PRESETS,
  compileStyle,
  findMissingHooks,
  normalizeStyle,
  renderReturnForm,
  type FormData,
  type FormStyle,
} from "../lib/return-form-template";
import { RETURN_FORM_SCRIPT } from "../lib/return-form-script";
import { COLORS, Card, btn, grid, input } from "../lib/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const [theme, settings] = await Promise.all([db.returnFormTheme.findUnique({ where: { shopId: shop.id } }), getPortalSettings(shop.id)]);
  return {
    html: theme?.html ?? DEFAULT_FORM_HTML,
    css: theme?.css ?? DEFAULT_FORM_CSS,
    style: normalizeStyle(theme?.style),
    isCustom: !!theme,
    photoMode: (["OFF", "REQUIRED"].includes(settings.photoMode) ? settings.photoMode : "OPTIONAL") as FormData["photoMode"],
    notice: settings.notice,
    allowReturns: settings.allowReturns,
    allowExchanges: settings.allowExchanges,
    store: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const f = await request.formData();

  if (f.get("intent") === "reset") {
    await db.returnFormTheme.deleteMany({ where: { shopId: shop.id } });
    return { ok: "Form design reset to the default." };
  }

  const html = String(f.get("html") ?? "");
  const css = String(f.get("css") ?? "");
  if (html.length > 40_000 || css.length > 40_000) return { error: "That's too long — keep the HTML and CSS under 40,000 characters each." };
  const missing = findMissingHooks(html);
  if (missing.length) return { error: `Your HTML is missing ${missing.map((m) => `“${m}”`).join(", ")}. The form needs these to work.` };

  const style = normalizeStyle({
    accent: f.get("accent"),
    accentText: f.get("accentText"),
    page: f.get("page"),
    card: f.get("card"),
    text: f.get("text"),
    radius: f.get("radius"),
    fontSize: f.get("fontSize"),
    button: f.get("button"),
    width: f.get("width"),
    align: f.get("align"),
  });
  await db.returnFormTheme.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, html, css, style },
    update: { html, css, style },
  });
  return { ok: "Form design saved. It's live for customers now." };
};

// What the preview shows: a made-up order with a returnable item, one with a replacement, and one that can't be returned.
const sample = (o: { photoMode: FormData["photoMode"]; notice: string | null; allowReturns: boolean; allowExchanges: boolean }, step: "form" | "verify"): FormData => ({
  orderName: "#1089",
  orderId: "1089",
  daysLeftText: "26 days left in your 30-day return window",
  notice: o.notice,
  verify: { needed: step === "verify", orderParam: "id" },
  items: [
    { key: "a", title: "Court Sneaker", variantTitle: "Size 38", priceText: "$100.00", imageUrl: null, eligible: true, reason: null, maxQty: 2, exchange: [{ variantId: "v1", label: "Court Sneaker — Size 39", diffText: "same price" }, { variantId: "v2", label: "Court Sneaker — Size 41", diffText: "$10.00 more" }] },
    { key: "b", title: "Canvas Tote", variantTitle: null, priceText: "$40.00", imageUrl: null, eligible: true, reason: null, maxQty: 1, exchange: [] },
    { key: "c", title: "Everyday Crew Sock", variantTitle: "3 pack", priceText: "$12.00", imageUrl: null, eligible: false, reason: "Final sale · not returnable", maxQty: 0, exchange: [] },
  ],
  reasons: [{ id: "r1", name: "Size too small" }, { id: "r2", name: "Defective" }, { id: "r3", name: "Changed my mind" }],
  allowReturns: o.allowReturns,
  allowExchanges: o.allowExchanges,
  photoMode: o.photoMode,
  requestsHtml: '<div class="er-req"><span>Return #1089-R1</span><span>Waiting for review</span></div>',
});

const TOKENS: [string, string][] = [
  ["{{orderName}}", "the order, e.g. #1089"],
  ["{{daysLeft}}", "“26 days left in your 30-day window”"],
  ["{{notice}}", "your message from the settings page"],
  ["{{requests}}", "earlier requests for this order"],
  ["{{itemTitle}} {{itemVariant}} {{itemPrice}} {{itemDetail}} {{itemImageUrl}}", "inside <!--ITEM-->"],
  ["{{itemReason}}", "why an item can't be returned"],
  ["{{qtyOptions}} {{reasonOptions}} {{exchangeOptions}}", "the <option> lists"],
];
const BLOCKS = "NOTICE · VERIFY · FORM · REQUESTS · EMPTY · ITEM (repeats) · inside ITEM: IMAGE · QTY · PHOTOS · EXCHANGE · RETURNOPT / EXCHANGEOPT";
const HOOKS = "data-er-form · data-er-item · data-er-pick · data-er-more · data-er-qty · data-er-reason · data-er-note · data-er-photo-input · data-er-thumbs · data-er-exchange · data-er-replacement · data-er-type · data-er-submit · data-er-error · data-er-done · data-er-ref";

function ColorField({ label, name, value, onChange }: { label: string; name: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input name={name} type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...input, width: 56, height: 36, padding: 2 }} />
        <code style={{ fontSize: 12 }}>{value}</code>
      </span>
    </label>
  );
}

export default function FormEditor() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [tab, setTab] = useState<"templates" | "style" | "code">("templates");
  const [html, setHtml] = useState(d.html);
  const [css, setCss] = useState(d.css);
  const [style, setStyle] = useState<FormStyle>(d.style);
  const [step, setStep] = useState<"form" | "verify">("form");
  const set = <K extends keyof FormStyle>(k: K, v: FormStyle[K]) => setStyle((s) => ({ ...s, [k]: v }));

  // Same renderer + script the storefront uses, so what you see is what customers get. Nothing is ever submitted from here.
  const preview = useMemo(() => {
    let body = "";
    let error = "";
    try {
      body = renderReturnForm(html, sample(d, step));
    } catch (e) {
      error = String((e as Error).message);
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#fff}\n${css}\n${compileStyle(style)}</style></head><body>` +
      `<div class="er-root" data-order-id="1089" data-email="" data-photo-mode="${d.photoMode}" data-require-note="false">${error ? `<p style="color:#b00">${error}</p>` : body}</div>` +
      `<script>window.__erPreview=true;</script><script>${RETURN_FORM_SCRIPT}</script></body></html>`;
  }, [html, css, style, step, d]);

  const applyPreset = (id: string) => {
    const p = FORM_PRESETS.find((x) => x.id === id);
    if (!p) return;
    const edited = html !== d.html || css !== d.css;
    if (edited && !window.confirm(`Switching to “${p.name}” replaces the HTML, CSS and style options you're editing. Continue?`)) return;
    setHtml(p.html);
    setCss(p.css);
    setStyle(p.style);
  };

  const num = { ...input, width: "100%" } as const;
  const tabBtn = (t: "templates" | "style" | "code", label: string) => (
    <button type="button" onClick={() => setTab(t)} style={{ ...btn(tab === t ? "primary" : "secondary") }}>{label}</button>
  );

  return (
    <s-page heading="Form design">
      <div style={{ display: "grid", gap: 16 }}>
        {result && "error" in result && result.error && <s-banner tone="critical">{result.error}</s-banner>}
        {result && "ok" in result && result.ok && <s-banner tone="success" dismissible>{result.ok}</s-banner>}

        <p style={{ margin: 0, fontSize: 14, color: COLORS.subdued }}>
          This is the form customers see after clicking <strong>Return or exchange items</strong> on their order. Your design is saved for your store: change a few
          options, or edit the HTML and CSS directly. The preview on the right is exactly what customers get.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, alignItems: "start" }}>
          <Form method="post" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>{tabBtn("templates", "Templates")}{tabBtn("style", "Style options")}{tabBtn("code", "HTML & CSS")}</div>

            <div style={{ display: tab === "templates" ? "block" : "none" }}>
              <Card title="Choose a template" hint="Pick a starting layout, then fine-tune it under Style options or HTML & CSS. Nothing goes live until you save.">
                <div style={{ display: "grid", gap: 10 }}>
                  {FORM_PRESETS.map((p) => {
                    const current = html === p.html && css === p.css;
                    return (
                      <div key={p.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, border: `1.5px solid ${current ? p.style.accent : COLORS.border}`, borderRadius: 10 }}>
                        <span aria-hidden style={{ flex: "0 0 44px", height: 44, borderRadius: p.style.radius > 8 ? 10 : 2, background: p.style.accent, boxShadow: `inset 0 -14px 0 ${p.style.card}` }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <strong style={{ display: "block", fontSize: 14 }}>{p.name}{current ? " · in use" : ""}</strong>
                          <span style={{ fontSize: 12, color: COLORS.subdued }}>{p.description}</span>
                        </span>
                        <button type="button" style={btn(current ? "secondary" : "primary")} disabled={current} onClick={() => applyPreset(p.id)}>{current ? "Selected" : "Use"}</button>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            {/* style fields stay mounted (hidden) on the code tab so saving always sends everything */}
            <div style={{ display: tab === "style" ? "block" : "none" }}>
              <Card title="Look and feel">
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={grid(150, 12)}>
                    <ColorField label="Accent (buttons, selection)" name="accent" value={style.accent} onChange={(v) => set("accent", v)} />
                    <ColorField label="Text on accent" name="accentText" value={style.accentText} onChange={(v) => set("accentText", v)} />
                    <ColorField label="Form background" name="page" value={style.page} onChange={(v) => set("page", v)} />
                    <ColorField label="Card background" name="card" value={style.card} onChange={(v) => set("card", v)} />
                    <ColorField label="Text" name="text" value={style.text} onChange={(v) => set("text", v)} />
                  </div>
                  <div style={grid(180, 12)}>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>Corner radius: {style.radius}px</span>
                      <input name="radius" type="range" min={0} max={28} step={2} value={style.radius} onChange={(e) => set("radius", Number(e.target.value))} /></label>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>Text size: {style.fontSize}px</span>
                      <input name="fontSize" type="range" min={13} max={20} step={1} value={style.fontSize} onChange={(e) => set("fontSize", Number(e.target.value))} /></label>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>Width: {style.width}px</span>
                      <input name="width" type="range" min={420} max={960} step={20} value={style.width} onChange={(e) => set("width", Number(e.target.value))} /></label>
                  </div>
                  <div style={grid(180, 12)}>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>Button shape</span>
                      <select name="button" value={style.button} onChange={(e) => set("button", e.target.value as FormStyle["button"])} style={num}>
                        <option value="pill">Pill</option><option value="rounded">Rounded</option><option value="square">Square</option>
                      </select></label>
                    <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>Position</span>
                      <select name="align" value={style.align} onChange={(e) => set("align", e.target.value as FormStyle["align"])} style={num}>
                        <option value="center">Centre</option><option value="left">Left</option>
                      </select></label>
                  </div>
                  <div><button type="button" style={btn("secondary")} onClick={() => setStyle(DEFAULT_STYLE)}>Reset style options</button></div>
                </div>
              </Card>
            </div>

            <div style={{ display: tab === "code" ? "block" : "none" }}>
              <Card title="HTML & CSS" hint="Full control. The form's behaviour is attached to the data-er-* attributes, so rearrange and restyle freely, but keep those.">
                <div style={{ display: "grid", gap: 12 }}>
                  <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>HTML</span>
                    <textarea name="html" value={html} onChange={(e) => setHtml(e.target.value)} rows={18} spellCheck={false} style={{ ...num, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }} /></label>
                  <label style={{ display: "grid", gap: 4, fontSize: 13 }}><span style={{ fontWeight: 600 }}>CSS</span>
                    <textarea name="css" value={css} onChange={(e) => setCss(e.target.value)} rows={12} spellCheck={false} style={{ ...num, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }} /></label>
                  <details>
                    <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Tokens, blocks and required attributes</summary>
                    <div style={{ fontSize: 12, display: "grid", gap: 6, paddingTop: 8 }}>
                      {TOKENS.map(([t, h]) => <div key={t}><code>{t}</code> — {h}</div>)}
                      <div><strong>Blocks</strong> (<code>{"<!--NAME-->…<!--/NAME-->"}</code>, shown only when relevant): {BLOCKS}</div>
                      <div><strong>Keep these attributes:</strong> <code>{HOOKS}</code></div>
                    </div>
                  </details>
                </div>
              </Card>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button name="intent" value="save" style={btn("primary", busy)} disabled={busy}>Save design</button>
              {d.isCustom && (
                <button name="intent" value="reset" style={btn("danger", busy)} disabled={busy} onClick={(e) => !window.confirm("Discard your design and go back to the default form?") && e.preventDefault()}>
                  Reset to default
                </button>
              )}
            </div>
          </Form>

          <Card
            title="Preview"
            right={
              <select value={step} onChange={(e) => setStep(e.target.value as "form" | "verify")} style={{ ...input, padding: "4px 8px" }} aria-label="Preview screen">
                <option value="form">Order form</option>
                <option value="verify">Email confirmation</option>
              </select>
            }
          >
            <iframe title="Form preview" srcDoc={preview} sandbox="allow-scripts" style={{ width: "100%", height: 720, border: `1px solid ${COLORS.border}`, borderRadius: 10, background: "#fff" }} />
            <p style={{ margin: "8px 0 0", fontSize: 12, color: COLORS.subdued }}>Sample order. You can click around, but nothing is submitted from the preview.</p>
          </Card>
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
