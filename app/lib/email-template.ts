// Tiny template engine + branded layout for customer emails. Pure (no Node APIs), so the admin editor can render a live
// preview in the browser with exactly the code the server uses to send.
//
//   {{name}}              value, HTML-escaped (safe for customer-supplied text)
//   {{{name}}}            raw HTML (only for fragments we build ourselves, like the item list)
//   {{#if name}}…{{/if}}  shown only when `name` is non-empty
//
// Merchants write the HTML around these; unknown variables render as empty rather than breaking the email.

export type Vars = Record<string, string | undefined | null>;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** `escape: false` is for the subject line (plain text, not HTML). */
export function renderTemplate(template: string, vars: Vars, opts: { escape?: boolean } = {}): string {
  const escape = opts.escape !== false;
  const get = (k: string) => (vars[k] ?? "").toString();
  return template
    .replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, k: string, inner: string) => (get(k).trim() ? inner : ""))
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_m, k: string) => get(k))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => (escape ? escapeHtml(get(k)) : get(k)));
}

export type Branding = { brandColor: string; logoUrl?: string | null; footer?: string | null; shopName: string };

const safeColor = (c: string) => (/^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "#3b3fe0");

/** The branded frame around a template body: logo/name on top, content card, footer. Table-based so mail clients render it. */
export function wrapEmail(inner: string, b: Branding, preheader = ""): string {
  const color = safeColor(b.brandColor);
  const head = b.logoUrl
    ? `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(b.shopName)}" style="max-height:44px;max-width:220px;display:block">`
    : `<span style="font-size:18px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#111827">${escapeHtml(b.shopName)}</span>`;
  const footer = b.footer ? `<p style="margin:0 0 6px">${escapeHtml(b.footer).replace(/\n/g, "<br>")}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px">${head}</td></tr>
<tr><td style="background:#ffffff;border-radius:14px;border-top:4px solid ${color};padding:28px 26px;font-size:15px;line-height:1.55">${inner}</td></tr>
<tr><td style="padding:16px 8px;font-size:12px;line-height:1.5;color:#6b7280;text-align:center">${footer}<p style="margin:0">Sent by ${escapeHtml(b.shopName)}</p></td></tr>
</table></td></tr></table></body></html>`;
}

/** A plain-text version for mail clients that don't render HTML (and to improve deliverability). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A button-styled link for use in template bodies, e.g. {{{button tracking_url "Track"}}} is not supported — paste this HTML instead. */
export const BUTTON_HTML = (color: string) =>
  `<a href="{{tracking_url}}" style="display:inline-block;padding:12px 22px;background:${safeColor(color)};color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600">Track your parcel</a>`;
