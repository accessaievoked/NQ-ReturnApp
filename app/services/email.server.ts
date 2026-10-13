import nodemailer from "nodemailer";
import { Prisma } from "@prisma/client";
import type { EmailSettings } from "@prisma/client";
import db from "../db.server";
import { EMAIL_EVENTS, sampleVars, type EmailEvent } from "../lib/email-defaults";
import { htmlToText, renderTemplate, wrapEmail, type Vars } from "../lib/email-template";
import { getAdmin, gql } from "./admin-client.server";

// Customer emails over SMTP (nodemailer). Configure with SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (and optionally
// SMTP_FROM_NAME) in .env. Without SMTP_USER + SMTP_PASS nothing is sent: each email is printed to the console and logged
// as LOGGED, so the whole flow can be developed safely. Gmail: use an App Password, and note it caps ~500 emails a day.

type Mail = { from: string; to: string; replyTo?: string; subject: string; html: string; text: string };
export type MailTransport = { sendMail(mail: Mail): Promise<unknown> };

let override: MailTransport | null = null;
let cached: MailTransport | null | undefined;

/** Tests inject a fake transport; pass null to go back to the real one. */
export function setTransportForTests(t: MailTransport | null) {
  override = t;
}

export const smtpUser = () => process.env.SMTP_USER || "";
export const smtpConfigured = () => !!override || !!(process.env.SMTP_USER && process.env.SMTP_PASS);

function transport(): MailTransport | null {
  if (override) return override;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (cached === undefined) {
    const port = Number(process.env.SMTP_PORT || 465);
    cached = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return cached;
}

export async function getEmailSettings(shopId: string): Promise<EmailSettings> {
  return db.emailSettings.upsert({ where: { shopId }, create: { shopId }, update: {} });
}

const nameCache = new Map<string, { name: string; at: number }>();

/** The store name shown in emails: the merchant's "From name" if set, else the live Shopify store name, else the domain. */
export async function storeName(domain: string, settings: EmailSettings): Promise<string> {
  if (settings.fromName?.trim()) return settings.fromName.trim();
  const hit = nameCache.get(domain);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.name;
  try {
    const data = await gql<{ shop: { name: string } }>(await getAdmin(domain), `#graphql query StoreName { shop { name } }`);
    nameCache.set(domain, { name: data.shop.name, at: Date.now() });
    return data.shop.name;
  } catch {
    return hit?.name ?? domain.replace(/\.myshopify\.com$/, "");
  }
}

/** The effective template for an event: the merchant's edit if there is one, otherwise the built-in default. */
export async function getTemplate(shopId: string, event: EmailEvent) {
  const def = EMAIL_EVENTS[event];
  const row = await db.emailTemplate.findUnique({ where: { shopId_event: { shopId, event } } });
  return {
    enabled: row ? row.enabled : def.enabled,
    subject: row?.subject ?? def.subject,
    body: row?.body ?? def.body,
    wrap: row?.wrap ?? true,
    customized: !!row,
  };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export type SendResult = { status: "SENT" | "LOGGED" | "FAILED" | "DISABLED" | "SKIPPED"; error?: string };

/** Render the effective template with `vars` into subject/html/text (also used by the admin preview and test send). */
export async function renderEmail(shop: { id: string; domain: string }, event: EmailEvent, vars: Vars, tplOverride?: { subject: string; body: string; wrap: boolean }) {
  const settings = await getEmailSettings(shop.id);
  const name = await storeName(shop.domain, settings);
  const tpl = tplOverride ?? (await getTemplate(shop.id, event));
  const all: Vars = { shop_name: name, brand_color: settings.brandColor, form_url: settings.portalUrl ?? "", ...vars };
  const inner = renderTemplate(tpl.body, all);
  const subject = oneLine(renderTemplate(tpl.subject, all, { escape: false })).slice(0, 200) || EMAIL_EVENTS[event].label;
  const html = tpl.wrap ? wrapEmail(inner, { brandColor: settings.brandColor, logoUrl: settings.logoUrl, footer: settings.footer, shopName: name }, subject) : inner;
  return { subject, html, text: htmlToText(html), settings, name };
}

/**
 * Send one customer email. `dedupeKey` (e.g. "return_approved:<returnId>") guarantees the same event never emails the same
 * return twice, even if Shopify re-delivers a webhook. Never throws: a mail problem must not break a return.
 */
export async function sendEmail(input: { shop: { id: string; domain: string }; event: EmailEvent; to: string | null | undefined; vars: Vars; dedupeKey?: string }): Promise<SendResult> {
  const { shop, event } = input;
  const to = (input.to ?? "").trim();
  try {
    if (!validEmail(to)) return { status: "SKIPPED", error: "No valid customer email" };
    const tpl = await getTemplate(shop.id, event);
    if (!tpl.enabled) return { status: "DISABLED" };

    const { subject, html, text, settings, name } = await renderEmail(shop, event, input.vars);

    // Cheap pre-check (the common case: a webhook re-delivery), then claim the key atomically for the rare true race.
    if (input.dedupeKey && (await db.emailLog.findFirst({ where: { shopId: shop.id, dedupeKey: input.dedupeKey }, select: { id: true } }))) return { status: "SKIPPED", error: "Already sent" };
    let logId: string;
    try {
      const row = await db.emailLog.create({ data: { shopId: shop.id, event, toEmail: to, subject, status: "SENDING", dedupeKey: input.dedupeKey ?? null } });
      logId = row.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { status: "SKIPPED", error: "Already sent" };
      throw e;
    }

    const t = transport();
    if (!t) {
      console.log(`[email:LOGGED] (SMTP not configured) to=${to} event=${event} subject="${subject}"`);
      await db.emailLog.update({ where: { id: logId }, data: { status: "LOGGED" } });
      return { status: "LOGGED" };
    }
    try {
      const display = oneLine(settings.fromName || process.env.SMTP_FROM_NAME || name).replace(/["<>]/g, "");
      await t.sendMail({ from: `"${display}" <${process.env.SMTP_USER}>`, to, replyTo: settings.replyTo || undefined, subject, html, text });
      await db.emailLog.update({ where: { id: logId }, data: { status: "SENT" } });
      return { status: "SENT" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown mail error";
      // Free the dedupe key so a later trigger can retry.
      await db.emailLog.update({ where: { id: logId }, data: { status: "FAILED", error: msg.slice(0, 300), dedupeKey: null } });
      return { status: "FAILED", error: msg };
    }
  } catch (err) {
    console.error("Email failed", err);
    return { status: "FAILED", error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Admin "send me a test": renders the (possibly unsaved) template with sample data and sends it right away. */
export async function sendTestEmail(shop: { id: string; domain: string }, event: EmailEvent, to: string, tpl?: { subject: string; body: string; wrap: boolean }): Promise<SendResult> {
  if (!validEmail(to.trim())) return { status: "FAILED", error: "Enter a valid email address." };
  const settings = await getEmailSettings(shop.id);
  const name = await storeName(shop.domain, settings);
  const { subject, html, text } = await renderEmail(shop, event, sampleVars(name, settings.brandColor), tpl);
  const t = transport();
  if (!t) return { status: "FAILED", error: "SMTP isn't configured (set SMTP_USER and SMTP_PASS in .env and restart)." };
  try {
    const display = oneLine(settings.fromName || process.env.SMTP_FROM_NAME || name).replace(/["<>]/g, "");
    await t.sendMail({ from: `"${display}" <${process.env.SMTP_USER}>`, to: to.trim(), replyTo: settings.replyTo || undefined, subject: `[Test] ${subject}`, html, text });
    return { status: "SENT" };
  } catch (err) {
    return { status: "FAILED", error: err instanceof Error ? err.message : "Unknown mail error" };
  }
}
