import { useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { getEmailSettings, getTemplate, sendTestEmail, smtpConfigured, smtpUser, storeName } from "../services/email.server";
import { EMAIL_EVENTS, EVENT_KEYS, VARIABLES, sampleVars, type EmailEvent } from "../lib/email-defaults";
import { renderTemplate, wrapEmail } from "../lib/email-template";
import { fmtDate } from "../lib/format";
import { COLORS, Card, btn, grid, input, td, th } from "../lib/ui";

const isEvent = (e: string): e is EmailEvent => (EVENT_KEYS as string[]).includes(e);
const httpUrl = (s: string) => (/^https?:\/\//i.test(s) ? s : "");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const wanted = new URL(request.url).searchParams.get("event") ?? "";
  const event: EmailEvent = isEvent(wanted) ? wanted : "return_received";

  const settings = await getEmailSettings(shop.id);
  const [templates, logs, name] = await Promise.all([
    Promise.all(EVENT_KEYS.map(async (k) => [k, await getTemplate(shop.id, k)] as const)),
    db.emailLog.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 15 }),
    storeName(session.shop, settings),
  ]);
  return {
    event,
    templates: Object.fromEntries(templates),
    settings: { fromName: settings.fromName ?? "", replyTo: settings.replyTo ?? "", brandColor: settings.brandColor, logoUrl: settings.logoUrl ?? "", footer: settings.footer ?? "", portalUrl: settings.portalUrl ?? "" },
    shopName: name,
    smtp: { configured: smtpConfigured(), user: smtpUser() },
    logs: logs.map((l) => ({ id: l.id, event: l.event, to: l.toEmail, status: l.status, error: l.error, at: l.createdAt.toISOString() })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  const event = String(f.get("event") ?? "");

  if (intent === "save-settings") {
    const color = String(f.get("brandColor") ?? "").trim();
    const replyTo = String(f.get("replyTo") ?? "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { error: "Pick a valid brand colour." };
    if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return { error: "The reply-to address isn't a valid email." };
    const data = {
      fromName: String(f.get("fromName") ?? "").trim().slice(0, 80) || null,
      replyTo: replyTo || null,
      brandColor: color,
      logoUrl: httpUrl(String(f.get("logoUrl") ?? "").trim()) || null,
      footer: String(f.get("footer") ?? "").trim().slice(0, 500) || null,
      portalUrl: httpUrl(String(f.get("portalUrl") ?? "").trim()) || null,
    };
    await db.emailSettings.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, ...data }, update: data });
    return { ok: "Email settings saved." };
  }

  if (!isEvent(event)) return { error: "Unknown email." };
  const subject = String(f.get("subject") ?? "").trim();
  const body = String(f.get("body") ?? "");
  const wrap = f.get("wrap") === "on";

  if (intent === "save-template") {
    if (!subject) return { error: "The subject can't be empty." };
    if (!body.trim()) return { error: "The email body can't be empty." };
    if (body.length > 60_000) return { error: "That email is too long." };
    const data = { enabled: f.get("enabled") === "on", subject: subject.slice(0, 200), body, wrap };
    await db.emailTemplate.upsert({ where: { shopId_event: { shopId: shop.id, event } }, create: { shopId: shop.id, event, ...data }, update: data });
    return { ok: `“${EMAIL_EVENTS[event].label}” saved.` };
  }
  if (intent === "reset") {
    await db.emailTemplate.deleteMany({ where: { shopId: shop.id, event } });
    return { ok: `“${EMAIL_EVENTS[event].label}” is back to the default.` };
  }
  if (intent === "test") {
    const r = await sendTestEmail({ id: shop.id, domain: session.shop }, event, String(f.get("to") ?? ""), { subject: subject || EMAIL_EVENTS[event].subject, body: body || EMAIL_EVENTS[event].body, wrap });
    return r.status === "SENT" ? { ok: `Test email sent to ${String(f.get("to"))}.` } : { error: r.error ?? "The test email could not be sent." };
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

export default function Emails() {
  const { event, templates, settings, shopName, smtp, logs } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const tpl = templates[event];
  const def = EMAIL_EVENTS[event];

  // live draft — re-initialised when the merchant switches email (key on the editor below)
  return (
    <s-page heading="Customer emails">
      <div style={{ display: "grid", gap: 16 }}>
        {result && "error" in result && result.error && <s-banner tone="critical">{result.error}</s-banner>}
        {result && "ok" in result && result.ok && <s-banner tone="success" dismissible>{result.ok}</s-banner>}
        {smtp.configured ? (
          <s-banner tone="info">Emails are sent from <strong>{smtp.user}</strong> over SMTP. The “From” name shown to customers is set below.</s-banner>
        ) : (
          <s-banner tone="warning" heading="SMTP isn't configured">
            Emails are only logged, not sent. Add SMTP_USER and SMTP_PASS (a Gmail App Password) to your .env and restart the app.
          </s-banner>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 16, alignItems: "start" }}>
          <Card title="Emails" style={{ padding: 12 }}>
            <div style={{ display: "grid" }}>
              {EVENT_KEYS.map((k) => (
                <Link
                  key={k}
                  to={`/app/emails?event=${k}`}
                  style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", padding: "9px 10px", borderRadius: 8, textDecoration: "none", color: "inherit", background: k === event ? "#f1f2ff" : undefined, fontWeight: k === event ? 700 : 500, fontSize: 14 }}
                >
                  <span>{EMAIL_EVENTS[k].label}</span>
                  <span title={templates[k].enabled ? "On" : "Off"} style={{ width: 9, height: 9, borderRadius: "50%", background: templates[k].enabled ? COLORS.green : COLORS.grey, flexShrink: 0 }} />
                </Link>
              ))}
            </div>
          </Card>

          <Editor key={event} event={event} tpl={tpl} def={def} settings={settings} shopName={shopName} busy={busy} />
        </div>

        <Card title="Sender & branding" hint="Applies to every email.">
          <Form method="post" style={{ display: "grid", gap: 12 }}>
            <input type="hidden" name="intent" value="save-settings" />
            <div style={grid(220, 12)}>
              <Field label="From name" hint="Shown to customers. Leave empty to use your store name."><input name="fromName" defaultValue={settings.fromName} placeholder={shopName} style={{ ...input, width: "100%" }} /></Field>
              <Field label="Reply-to address" hint="Where customer replies go."><input name="replyTo" type="email" defaultValue={settings.replyTo} placeholder="support@yourstore.com" style={{ ...input, width: "100%" }} /></Field>
              <Field label="Brand colour"><input name="brandColor" type="color" defaultValue={settings.brandColor} style={{ ...input, width: 80, padding: 2, height: 36 }} /></Field>
              <Field label="Logo URL" hint="Optional. Shown at the top instead of your store name."><input name="logoUrl" defaultValue={settings.logoUrl} placeholder="https://…/logo.png" style={{ ...input, width: "100%" }} /></Field>
              <Field label="Return form page" hint="Offered in emails as {{form_url}}."><input name="portalUrl" defaultValue={settings.portalUrl} placeholder="https://yourstore.com/pages/returns" style={{ ...input, width: "100%" }} /></Field>
            </div>
            <Field label="Footer text" hint="Shown under every email (address, policy link…)."><textarea name="footer" defaultValue={settings.footer} rows={2} style={{ ...input, width: "100%" }} /></Field>
            <div><button style={btn("primary", busy)} disabled={busy}>Save sender &amp; branding</button></div>
          </Form>
        </Card>

        <Card title="Recent emails">
          {logs.length === 0 ? (
            <div style={{ color: COLORS.subdued, fontSize: 14 }}>Nothing sent yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>When</th><th style={th}>Email</th><th style={th}>To</th><th style={th}>Status</th></tr></thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td style={td}>{fmtDate(l.at)}</td>
                      <td style={td}>{isEvent(l.event) ? EMAIL_EVENTS[l.event].label : l.event}</td>
                      <td style={td}>{l.to}</td>
                      <td style={td}>
                        <s-badge tone={l.status === "SENT" ? "success" : l.status === "FAILED" ? "critical" : "neutral"}>{l.status === "LOGGED" ? "Logged only" : l.status.toLowerCase()}</s-badge>
                        {l.error && <div style={{ fontSize: 12, color: "#b4331a" }}>{l.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </s-page>
  );
}

function Editor({ event, tpl, def, settings, shopName, busy }: { event: EmailEvent; tpl: { enabled: boolean; subject: string; body: string; wrap: boolean; customized: boolean }; def: (typeof EMAIL_EVENTS)[EmailEvent]; settings: { brandColor: string; logoUrl: string; footer: string }; shopName: string; busy: boolean }) {
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body);
  const [wrap, setWrap] = useState(tpl.wrap);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Same renderer the server uses to send, so the preview is what the customer gets.
  const preview = useMemo(() => {
    const vars = sampleVars(shopName, settings.brandColor);
    const inner = renderTemplate(body, vars);
    const subj = renderTemplate(subject, vars, { escape: false });
    return { subject: subj, html: wrap ? wrapEmail(inner, { brandColor: settings.brandColor, logoUrl: settings.logoUrl, footer: settings.footer, shopName }, subj) : inner };
  }, [body, subject, wrap, shopName, settings.brandColor, settings.logoUrl, settings.footer]);

  const insert = (name: string) => {
    const token = name.startsWith("{{{") ? name : `{{${name}}}`;
    const el = ref.current;
    if (!el) return setBody((b) => b + token);
    const [s, e] = [el.selectionStart, el.selectionEnd];
    const next = body.slice(0, s) + token + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
  };

  return (
    <Card title={def.label} right={tpl.customized ? <s-badge tone="info">Customised</s-badge> : <s-badge tone="neutral">Default</s-badge>}>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: COLORS.subdued }}>Sent when: {def.when}</p>
      <Form method="post" style={{ display: "grid", gap: 12 }}>
        <input type="hidden" name="event" value={event} />
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" name="enabled" defaultChecked={tpl.enabled} /> Send this email</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" name="wrap" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Use the branded layout</label>
        </div>
        <Field label="Subject"><input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...input, width: "100%" }} /></Field>
        <Field label="Body (HTML)" hint="Use the variables below. {{#if name}}…{{/if}} shows a block only when that value exists.">
          <textarea ref={ref} name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={12} spellCheck={false} style={{ ...input, width: "100%", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }} />
        </Field>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {VARIABLES.map((v) => (
            <button key={v.name} type="button" title={v.hint} onClick={() => insert(v.name)} style={{ ...btn("secondary"), padding: "3px 10px", fontSize: 12, fontFamily: "ui-monospace, Consolas, monospace" }}>
              {v.name.startsWith("{{{") ? v.name : `{{${v.name}}}`}
            </button>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Preview <span style={{ fontWeight: 400, color: COLORS.subdued }}>— subject: {preview.subject}</span></div>
          <iframe title="Email preview" srcDoc={preview.html} sandbox="" style={{ width: "100%", height: 420, border: `1px solid ${COLORS.border}`, borderRadius: 10, background: "#fff" }} />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button name="intent" value="save-template" style={btn("primary", busy)} disabled={busy}>Save</button>
          {tpl.customized && (
            <button name="intent" value="reset" style={btn("secondary", busy)} disabled={busy} onClick={(e) => !window.confirm("Discard your edits and go back to the default email?") && e.preventDefault()}>
              Reset to default
            </button>
          )}
          <span style={{ flex: 1 }} />
          <input name="to" type="email" placeholder="you@example.com" style={{ ...input, width: 220 }} aria-label="Send a test to" />
          <button name="intent" value="test" style={btn("secondary", busy)} disabled={busy}>Send test</button>
        </div>
      </Form>
    </Card>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
