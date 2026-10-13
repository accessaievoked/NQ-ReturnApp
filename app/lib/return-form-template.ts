// The customer-facing return/exchange form, as a per-store editable template — same idea as Judge.me's review-form
// template, on a smaller scale. A store keeps its own `html` and `css` (and a few simple style options); this file turns
// that template plus the order's data into the page customers see. It is pure (no Node APIs), so the admin editor's
// live preview renders with exactly the same code the storefront uses.
//
// ── Tokens ({{like}} this; values are HTML-escaped unless noted) ───────────────────────────────────────────────
//   {{orderName}}        e.g. #1089
//   {{daysLeft}}         "26 days left in your 30-day return window" (empty when unknown)
//   {{notice}}           the store's message from the settings page
//   {{requests}}         (raw HTML) the customer's earlier requests for this order and their status
//   {{hiddenFields}}     (raw HTML) hidden inputs the email-confirmation form needs
//   {{verifyError}}      why the email confirmation failed (empty otherwise)
//   inside <!--ITEM-->:  {{itemKey}} {{itemTitle}} {{itemVariant}} {{itemPrice}} {{itemDetail}} {{itemImageUrl}}
//                        {{itemReason}} (why it can't be returned) {{itemStateClass}} {{itemDisabledAttr}} {{itemMax}}
//                        {{qtyOptions}} {{reasonOptions}} {{exchangeOptions}}  (the three are raw <option> lists)
//                        {{photoHint}} ("optional" / "required")
//
// ── Blocks (<!--NAME-->…<!--/NAME-->; shown only when the condition holds) ──────────────────────────────────────
//   NOTICE   the store has a message        VERIFY   the customer must confirm their email first
//   FORM     the order is verified          REQUESTS the order already has requests
//   ITEM     repeated once per order item   EMPTY    nothing on the order can be returned
//   inside ITEM: IMAGE (has a picture) · QTY (more than 1 unit) · PHOTOS (photos allowed) · EXCHANGE (replacements exist)
//   RETURNOPT / EXCHANGEOPT   the "return" / "exchange" choice, only when the store allows it
//
// ── Fixed hooks ────────────────────────────────────────────────────────────────────────────────────────────
// The behaviour (selecting items, photos, submit…) is attached to data-er-* attributes by return-form-script.ts, not to
// tokens, so you can restyle and rearrange anything — just keep those attributes (the editor lists them).

export type FormItem = {
  key: string;
  title: string;
  variantTitle: string | null;
  priceText: string;
  imageUrl: string | null;
  eligible: boolean;
  reason: string | null; // why it can't be returned
  maxQty: number;
  exchange: { variantId: string; label: string; diffText: string }[];
};

export type FormData = {
  orderName: string;
  orderId: string; // numeric Shopify id
  daysLeftText: string;
  notice: string | null;
  verify: { needed: boolean; error?: string; orderParam?: string };
  items: FormItem[];
  reasons: { id: string; name: string }[];
  allowReturns: boolean;
  allowExchanges: boolean;
  photoMode: "OFF" | "OPTIONAL" | "REQUIRED";
  requestsHtml: string;
};

export const escapeHtml = (v: string | null | undefined): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const blockRe = (name: string) => new RegExp(`<!--${name}-->([\\s\\S]*?)<!--\\/${name}-->`, "g");
const block = (html: string, name: string, show: boolean) => html.replace(blockRe(name), (_m, inner: string) => (show ? inner : ""));
const tokens = (html: string, map: Record<string, string>) => Object.entries(map).reduce((out, [k, v]) => out.split(`{{${k}}}`).join(v), html);

const option = (value: string, label: string) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;

export function renderReturnForm(template: string, d: FormData): string {
  const anyExchange = d.allowExchanges && d.items.some((i) => i.eligible && i.exchange.length > 0);
  const formVisible = !d.verify.needed;

  let out = template;
  out = block(out, "NOTICE", !!d.notice);
  out = block(out, "VERIFY", d.verify.needed);
  out = block(out, "FORM", formVisible);
  out = block(out, "REQUESTS", !!d.requestsHtml);
  out = block(out, "EMPTY", formVisible && d.items.length === 0);
  out = block(out, "RETURNOPT", d.allowReturns);
  out = block(out, "EXCHANGEOPT", anyExchange);

  // repeat the ITEM block once per order item
  out = out.replace(blockRe("ITEM"), (_m, inner: string) =>
    d.items
      .map((i) => {
        let h = inner;
        h = block(h, "IMAGE", !!i.imageUrl);
        h = block(h, "QTY", i.eligible && i.maxQty > 1);
        h = block(h, "PHOTOS", i.eligible && d.photoMode !== "OFF");
        h = block(h, "EXCHANGE", i.eligible && d.allowExchanges && i.exchange.length > 0);
        const detail = [i.variantTitle, i.priceText].filter(Boolean).join(" · ");
        return tokens(h, {
          itemKey: escapeHtml(i.key),
          itemTitle: escapeHtml(i.title),
          itemVariant: escapeHtml(i.variantTitle ?? ""),
          itemPrice: escapeHtml(i.priceText),
          itemDetail: escapeHtml(detail),
          itemImageUrl: escapeHtml(i.imageUrl ?? ""),
          itemReason: escapeHtml(i.reason ?? ""),
          itemStateClass: i.eligible ? "" : "is-disabled",
          itemDisabledAttr: i.eligible ? "" : "disabled",
          itemMax: String(i.maxQty),
          qtyOptions: Array.from({ length: i.maxQty }, (_, n) => option(String(n + 1), String(n + 1))).join(""),
          reasonOptions: [option("", "Choose a reason"), ...d.reasons.map((r) => option(r.id, r.name))].join(""),
          exchangeOptions: [option("", "Choose a replacement"), ...i.exchange.map((e) => option(e.variantId, `${e.label} (${e.diffText})`))].join(""),
          photoHint: d.photoMode === "REQUIRED" ? "required" : "optional",
        });
      })
      .join(""),
  );

  return tokens(out, {
    orderName: escapeHtml(d.orderName),
    daysLeft: escapeHtml(d.daysLeftText),
    notice: escapeHtml(d.notice ?? ""),
    requests: d.requestsHtml, // already escaped when it was built
    hiddenFields: `<input type="hidden" name="${d.verify.orderParam ?? "id"}" value="${escapeHtml(d.orderId)}">`,
    verifyError: escapeHtml(d.verify.error ?? ""),
  });
}

/** The pieces a template must keep, or the form can't work. Checked when a merchant saves their HTML. */
export const REQUIRED_HOOKS = ["data-er-form", "data-er-submit", "data-er-pick", "<!--ITEM-->"];
export const findMissingHooks = (html: string) => REQUIRED_HOOKS.filter((h) => !html.includes(h));

// ──────────────────────────────────────────────────────────────── style options (the "selected ones")

export type FormStyle = {
  accent: string;
  accentText: string;
  page: string;
  card: string;
  text: string;
  radius: number;
  fontSize: number;
  button: "pill" | "rounded" | "square";
  width: number;
  align: "left" | "center";
};

export const DEFAULT_STYLE: FormStyle = {
  accent: "#3b3fe0",
  accentText: "#ffffff",
  page: "#f8f9fc",
  card: "#ffffff",
  text: "#111827",
  radius: 14,
  fontSize: 15,
  button: "pill",
  width: 640,
  align: "center",
};

const color = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Anything stored or submitted is clamped to safe values, so a style can never inject CSS. */
export function normalizeStyle(raw: unknown): FormStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STYLE;
  return {
    accent: color(r.accent, d.accent),
    accentText: color(r.accentText, d.accentText),
    page: color(r.page, d.page),
    card: color(r.card, d.card),
    text: color(r.text, d.text),
    radius: num(r.radius, d.radius, 0, 28),
    fontSize: num(r.fontSize, d.fontSize, 13, 20),
    button: r.button === "rounded" || r.button === "square" ? r.button : "pill",
    width: num(r.width, d.width, 420, 960),
    align: r.align === "left" ? "left" : "center",
  };
}

/** CSS custom properties that the default stylesheet (and any custom one that uses them) reads. Appended after the stylesheet. */
export function compileStyle(s: FormStyle): string {
  const btn = s.button === "pill" ? "999px" : s.button === "rounded" ? `${s.radius}px` : "4px";
  return `.er-root{--er-accent:${s.accent};--er-accent-text:${s.accentText};--er-page:${s.page};--er-card:${s.card};--er-text:${s.text};--er-radius:${s.radius}px;--er-font:${s.fontSize}px;--er-btn-radius:${btn};--er-width:${s.width}px;}
.er-root{margin-left:${s.align === "center" ? "auto" : "0"};margin-right:auto;}`;
}

// ──────────────────────────────────────────────────────────────── defaults

// The working part of the form (notice, email check, item picker, submit, receipt, past requests) is shared by every
// template; templates differ in their header, their CSS and their style options.
const formBody = `
  <!--NOTICE--><div class="er-notice">{{notice}}</div><!--/NOTICE-->

  <!--VERIFY-->
  <h1 class="er-h1" tabindex="-1">Confirm it's you</h1>
  <p class="er-sub">Enter the email address you used for order {{orderName}}.</p>
  <form method="get" class="er-verify">
    {{hiddenFields}}
    <label class="er-field"><span>Email</span><input class="er-input" type="email" name="email" required autocomplete="email"></label>
    <p class="er-error" role="alert">{{verifyError}}</p>
    <button type="submit" class="er-btn">Continue</button>
  </form>
  <!--/VERIFY-->

  <!--FORM-->
  <form data-er-form novalidate>
    <h1 class="er-h1" tabindex="-1">What would you like to send back?</h1>
    <p class="er-sub">{{daysLeft}}</p>
    <p class="er-error" data-er-error hidden role="alert"></p>

    <div class="er-items">
      <!--ITEM-->
      <div class="er-item {{itemStateClass}}" data-er-item data-key="{{itemKey}}" data-max="{{itemMax}}">
        <label class="er-pick">
          <input type="checkbox" data-er-pick {{itemDisabledAttr}}>
          <span class="er-thumb"><!--IMAGE--><img src="{{itemImageUrl}}" alt=""><!--/IMAGE--></span>
          <span class="er-meta">
            <span class="er-name">{{itemTitle}}</span>
            <span class="er-detail">{{itemDetail}}</span>
            <span class="er-why">{{itemReason}}</span>
          </span>
          <span class="er-check" aria-hidden="true">✓</span>
        </label>

        <div class="er-more" data-er-more hidden>
          <!--QTY--><label class="er-field"><span>Quantity</span><select class="er-select" data-er-qty>{{qtyOptions}}</select></label><!--/QTY-->
          <label class="er-field"><span>Why are you returning it?</span><select class="er-select" data-er-reason>{{reasonOptions}}</select></label>
          <label class="er-field"><span>Tell us more</span><textarea class="er-textarea" data-er-note maxlength="500"></textarea></label>
          <!--PHOTOS-->
          <div class="er-field">
            <span>Photos ({{photoHint}})</span>
            <div class="er-photos" data-er-thumbs></div>
            <label class="er-add"><input type="file" accept="image/*" multiple hidden data-er-photo-input>+ Add photo</label>
          </div>
          <!--/PHOTOS-->
          <!--EXCHANGE-->
          <label class="er-field" data-er-exchange hidden><span>Exchange it for</span><select class="er-select" data-er-replacement>{{exchangeOptions}}</select></label>
          <!--/EXCHANGE-->
        </div>
      </div>
      <!--/ITEM-->
    </div>
    <!--EMPTY--><p class="er-sub">Nothing on this order can be returned right now.</p><!--/EMPTY-->

    <fieldset class="er-choice">
      <legend class="er-label">How would you like this sorted?</legend>
      <!--RETURNOPT--><label class="er-radio"><input type="radio" name="er-type" value="RETURN" data-er-type checked><span>Return for a refund</span></label><!--/RETURNOPT-->
      <!--EXCHANGEOPT--><label class="er-radio"><input type="radio" name="er-type" value="EXCHANGE" data-er-type><span>Exchange for something else</span></label><!--/EXCHANGEOPT-->
    </fieldset>

    <button type="submit" class="er-btn" data-er-submit>Submit request</button>
  </form>
  <!--/FORM-->

  <div class="er-done" data-er-done hidden>
    <div class="er-done-icon" aria-hidden="true">✓</div>
    <h1 class="er-h1" tabindex="-1">Request received</h1>
    <p class="er-sub">We'll review it and email you. Your reference: <strong data-er-ref></strong></p>
  </div>

  <!--REQUESTS-->
  <div class="er-requests"><h2 class="er-h2">Your requests for this order</h2>{{requests}}</div>
  <!--/REQUESTS-->
`;

const classicTop = `<div class="er-top">
    <div class="er-brand">Returns &amp; exchanges</div>
    <div class="er-order">Order {{orderName}}</div>
  </div>
`;

export const DEFAULT_FORM_HTML = `<div class="er-card">
  ${classicTop}${formBody}</div>`;

export const DEFAULT_FORM_CSS = `/* Variables are set by the style options on the Form design page; use them to stay in sync, or hard-code your own values. */
.er-root{--er-accent:#3b3fe0;--er-accent-text:#fff;--er-page:#f8f9fc;--er-card:#fff;--er-text:#111827;--er-radius:14px;--er-font:15px;--er-btn-radius:999px;--er-width:640px;
  --er-muted:color-mix(in srgb,var(--er-text) 55%,transparent);--er-line:color-mix(in srgb,var(--er-text) 13%,transparent);--er-soft:color-mix(in srgb,var(--er-accent) 9%,var(--er-card));
  box-sizing:border-box;max-width:var(--er-width);padding:20px 16px 48px;color:var(--er-text);font:var(--er-font)/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.er-root *,.er-root *::before,.er-root *::after{box-sizing:border-box}
.er-card{background:var(--er-page);border:1px solid var(--er-line);border-radius:calc(var(--er-radius) + 6px);padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
@media (max-width:520px){.er-card{padding:20px 16px}}
.er-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-bottom:12px;margin-bottom:20px;border-bottom:1px solid var(--er-line)}
.er-brand{font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:.95em}
.er-order{color:var(--er-muted);font-size:.9em}
.er-h1{margin:0 0 4px;font-size:1.45em;line-height:1.25;outline:none}
.er-h2{margin:22px 0 8px;font-size:1.05em}
.er-sub{margin:0 0 16px;color:var(--er-muted)}
.er-notice{padding:10px 14px;margin-bottom:16px;background:var(--er-soft);border-radius:var(--er-radius);font-size:.92em}
.er-error{margin:12px 0 0;padding:10px 14px;color:#9b1c1c;background:#fdecec;border-radius:var(--er-radius);font-size:.92em}
.er-error:empty{display:none}
.er-items{display:grid;gap:12px}
.er-item{background:var(--er-card);border:1.5px solid var(--er-line);border-radius:var(--er-radius);transition:border-color .15s,background .15s}
.er-item.is-selected{border-color:var(--er-accent);background:var(--er-soft)}
.er-item.is-disabled{opacity:.55}
.er-pick{display:flex;align-items:center;gap:14px;padding:14px;cursor:pointer}
.er-item.is-disabled .er-pick{cursor:not-allowed}
.er-pick input{position:absolute;opacity:0;pointer-events:none}
.er-pick:focus-within{outline:2px solid var(--er-accent);outline-offset:2px;border-radius:var(--er-radius)}
.er-thumb{flex:0 0 56px;width:56px;height:56px;display:grid;place-items:center;overflow:hidden;background:var(--er-soft);border-radius:calc(var(--er-radius) - 4px)}
.er-thumb img{width:100%;height:100%;object-fit:cover}
.er-meta{flex:1;min-width:0;display:grid}
.er-name{font-weight:600}
.er-detail,.er-why{color:var(--er-muted);font-size:.88em}
.er-why:empty{display:none}
.er-check{flex:0 0 22px;width:22px;height:22px;display:grid;place-items:center;border:1.5px solid var(--er-line);border-radius:50%;font-size:13px;color:transparent}
.er-item.is-selected .er-check{color:var(--er-accent-text);background:var(--er-accent);border-color:var(--er-accent)}
.er-more{padding:0 14px 14px;display:grid;gap:12px}
.er-more[hidden]{display:none}
.er-field{display:grid;gap:6px;font-size:.92em}
.er-field>span{font-weight:600}
.er-input,.er-select,.er-textarea{width:100%;padding:12px 14px;color:var(--er-text);background:var(--er-card);border:1px solid var(--er-line);border-radius:var(--er-radius);font:inherit}
.er-input:focus,.er-select:focus,.er-textarea:focus{outline:2px solid var(--er-accent);outline-offset:1px}
.er-textarea{min-height:72px;resize:vertical}
.er-photos{display:flex;flex-wrap:wrap;gap:10px}
.er-photo{position:relative;width:72px;height:72px;display:grid;place-items:center;overflow:hidden;background:var(--er-soft);border:1px solid var(--er-line);border-radius:calc(var(--er-radius) - 4px)}
.er-photo img{width:100%;height:100%;object-fit:cover}
.er-photo.is-error{border-color:#d72c0d}
.er-photo button{position:absolute;top:3px;right:3px;width:22px;height:22px;line-height:1;color:#fff;background:rgba(0,0,0,.6);border:0;border-radius:50%;cursor:pointer}
.er-photo .er-spin{position:absolute;width:26px;height:26px;border:3px solid var(--er-accent);border-right-color:transparent;border-radius:50%;animation:er-spin .7s linear infinite}
@keyframes er-spin{to{transform:rotate(360deg)}}
.er-add{width:72px;height:72px;display:grid;place-items:center;padding:4px;text-align:center;color:var(--er-accent);font-size:.8em;font-weight:600;border:1.5px dashed var(--er-accent);border-radius:calc(var(--er-radius) - 4px);cursor:pointer}
.er-add:hover{background:var(--er-soft)}
.er-label{font-size:.78em;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--er-muted);padding:0}
.er-choice{margin:22px 0 0;padding:0;border:0;display:grid;gap:10px}
.er-radio{display:flex;align-items:center;gap:10px;padding:14px;background:var(--er-card);border:1.5px solid var(--er-line);border-radius:var(--er-radius);cursor:pointer}
.er-radio:has(input:checked){border-color:var(--er-accent);background:var(--er-soft)}
.er-radio input{accent-color:var(--er-accent)}
.er-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px 20px;margin-top:20px;color:var(--er-accent-text);background:var(--er-accent);border:0;border-radius:var(--er-btn-radius);font:inherit;font-weight:600;cursor:pointer}
.er-btn:disabled{opacity:.5;cursor:not-allowed}
.er-done{text-align:center;padding:12px 0}
.er-done-icon{width:56px;height:56px;margin:0 auto 12px;display:grid;place-items:center;color:var(--er-accent-text);background:var(--er-accent);border-radius:50%;font-size:28px}
.er-requests{margin-top:8px}
.er-req{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--er-line);font-size:.92em}
.er-req span:last-child{color:var(--er-muted)}`;

// ──────────────────────────────────────────────────────────────── templates a store can start from

export type FormPreset = { id: string; name: string; description: string; html: string; css: string; style: FormStyle };

const MINIMAL_CSS = `
/* Minimal: no card, flat rows, underlined fields */
.er-card{background:transparent;border:0;box-shadow:none;padding:8px 0}
.er-top{border-bottom:2px solid var(--er-text)}
.er-brand{letter-spacing:0;text-transform:none;font-size:1.05em}
.er-items{gap:0}
.er-item{background:transparent;border:0;border-bottom:1px solid var(--er-line);border-radius:0}
.er-item.is-selected{background:transparent;border-bottom-color:var(--er-accent)}
.er-thumb{border-radius:0}
.er-input,.er-select,.er-textarea{border:0;border-bottom:1.5px solid var(--er-text);border-radius:0;background:transparent;padding-left:0}
.er-radio{padding-left:0;background:transparent;border:0;border-bottom:1px solid var(--er-line);border-radius:0}
.er-radio:has(input:checked){background:transparent}
.er-btn{text-transform:uppercase;letter-spacing:.08em}`;

const BOLD_CSS = `
/* Bold: coloured header band, item cards in a grid */
.er-card{padding:0 0 28px;overflow:hidden;background:var(--er-page)}
.er-hero{margin-bottom:20px;padding:32px 28px;color:var(--er-accent-text);background:var(--er-accent)}
.er-hero-order{font-size:.85em;letter-spacing:.2em;text-transform:uppercase;opacity:.8}
.er-hero-title{margin-top:6px;font-size:2em;font-weight:800;line-height:1.1}
.er-card>:not(.er-hero){margin-left:28px;margin-right:28px}
.er-h1{font-weight:800}
.er-items{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.er-thumb{flex-basis:72px;width:72px;height:72px}
.er-item{box-shadow:0 2px 8px rgba(0,0,0,.05)}
@media (max-width:520px){.er-card>:not(.er-hero){margin-left:16px;margin-right:16px}.er-hero{padding:24px 16px}}`;

export const FORM_PRESETS: FormPreset[] = [
  {
    id: "classic",
    name: "Classic",
    description: "A soft card with rounded items and a pill button.",
    html: DEFAULT_FORM_HTML,
    css: DEFAULT_FORM_CSS,
    style: DEFAULT_STYLE,
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "No card. Flat rows, thin lines, underlined fields, black and white.",
    html: `<div class="er-card">
  <div class="er-top">
    <div class="er-brand">Return or exchange</div>
    <div class="er-order">{{orderName}}</div>
  </div>
${formBody}</div>`,
    css: DEFAULT_FORM_CSS + MINIMAL_CSS,
    style: { ...DEFAULT_STYLE, accent: "#111111", page: "#ffffff", card: "#ffffff", text: "#111111", radius: 0, fontSize: 15, button: "square", width: 600, align: "center" },
  },
  {
    id: "bold",
    name: "Bold",
    description: "A big coloured header and item cards laid out in a grid.",
    html: `<div class="er-card">
  <div class="er-hero">
    <div class="er-hero-order">Order {{orderName}}</div>
    <div class="er-hero-title">Return or exchange</div>
  </div>
${formBody}</div>`,
    css: DEFAULT_FORM_CSS + BOLD_CSS,
    style: { ...DEFAULT_STYLE, accent: "#e11d48", accentText: "#ffffff", page: "#ffffff", card: "#fff5f6", text: "#1f1f1f", radius: 8, fontSize: 16, button: "rounded", width: 760, align: "center" },
  },
];
