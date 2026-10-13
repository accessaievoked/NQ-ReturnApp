// Built-in customer emails. A merchant can edit any of them (subject, HTML body, on/off, branded layout on/off) on the
// Emails page; their edit is stored as an EmailTemplate row and wins over these defaults. "Reset" deletes the row.

import type { Vars } from "./email-template";

export type EmailEvent =
  | "return_received"
  | "return_approved"
  | "return_declined"
  | "exchange_received"
  | "exchange_approved"
  | "exchange_declined"
  | "pickup_booked"
  | "return_delivered"
  | "exchange_completed"
  | "refund_issued";

export type EmailDef = {
  label: string;
  when: string; // shown in the editor
  enabled: boolean; // default on/off
  subject: string;
  body: string;
};

const hi = "<p>Hi {{customer_first_name}},</p>";

export const EMAIL_EVENTS: Record<EmailEvent, EmailDef> = {
  return_received: {
    label: "Return request received",
    when: "A customer submits a return on the form.",
    enabled: true,
    subject: "We got your return request {{reference}}",
    body: `${hi}<p>Thanks — we've received your return request for order <strong>{{order_name}}</strong>.</p>{{{items}}}<p>We'll review it and email you as soon as there's an update.</p><p>Your reference: <strong>{{reference}}</strong></p>`,
  },
  return_approved: {
    label: "Return approved",
    when: "A return is approved (by you, an automation rule or in Shopify).",
    enabled: true,
    subject: "Your return {{reference}} is approved",
    body: `${hi}<p>Good news — your return <strong>{{reference}}</strong> for order {{order_name}} has been approved.</p>{{#if tracking_url}}<p>A courier will collect the parcel. Track it here:</p><p><a href="{{tracking_url}}" style="display:inline-block;padding:12px 22px;background:{{brand_color}};color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600">Track your return</a></p>{{/if}}{{#if tracking_number}}<p>Tracking number: <strong>{{tracking_number}}</strong></p>{{/if}}<p>We'll email you again when we've received it.</p>`,
  },
  return_declined: {
    label: "Return declined",
    when: "A return is declined.",
    enabled: true,
    subject: "Update on your return {{reference}}",
    body: `${hi}<p>Unfortunately we can't accept your return <strong>{{reference}}</strong> for order {{order_name}}.</p>{{#if note}}<p><em>{{note}}</em></p>{{/if}}<p>If you think this is a mistake, just reply to this email.</p>`,
  },
  exchange_received: {
    label: "Exchange request received",
    when: "A customer submits an exchange on the form.",
    enabled: true,
    subject: "We got your exchange request {{reference}}",
    body: `${hi}<p>Thanks — we've received your exchange request for order <strong>{{order_name}}</strong>.</p><p><strong>Sending back</strong></p>{{{items}}}<p><strong>You'd like instead</strong></p>{{{replacement}}}<p>We'll review it and email you once it's decided. Your reference: <strong>{{reference}}</strong></p>`,
  },
  exchange_approved: {
    label: "Exchange approved",
    when: "You approve an exchange request.",
    enabled: true,
    subject: "Your exchange {{reference}} is approved",
    body: `${hi}<p>Your exchange <strong>{{reference}}</strong> for order {{order_name}} is approved.</p><p><strong>You'll receive</strong></p>{{{replacement}}}<p>Please send back the items from your order. We'll ship your replacement as soon as they reach us.</p>{{#if tracking_url}}<p><a href="{{tracking_url}}">Track your return parcel</a></p>{{/if}}`,
  },
  exchange_declined: {
    label: "Exchange declined",
    when: "You decline an exchange request.",
    enabled: true,
    subject: "Update on your exchange {{reference}}",
    body: `${hi}<p>We're sorry — we can't go ahead with your exchange <strong>{{reference}}</strong> for order {{order_name}}.</p>{{#if note}}<p><em>{{note}}</em></p>{{/if}}<p>Reply to this email if you'd like to talk about other options.</p>`,
  },
  pickup_booked: {
    label: "Pickup booked",
    when: "A courier pickup is booked for the return.",
    enabled: true,
    subject: "Pickup booked for your return {{reference}}",
    body: `${hi}<p>We've booked a courier to collect your return <strong>{{reference}}</strong>.</p>{{#if carrier}}<p>Courier: <strong>{{carrier}}</strong></p>{{/if}}{{#if pickup_date}}<p>Pickup: <strong>{{pickup_date}}</strong></p>{{/if}}{{#if tracking_number}}<p>Tracking number: <strong>{{tracking_number}}</strong></p>{{/if}}<p>Please pack the items securely and keep them ready.</p>{{#if tracking_url}}<p><a href="{{tracking_url}}" style="display:inline-block;padding:12px 22px;background:{{brand_color}};color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600">Track your pickup</a></p>{{/if}}`,
  },
  return_delivered: {
    label: "Return received at warehouse",
    when: "The returned parcel reaches you.",
    enabled: true,
    subject: "We received your return {{reference}}",
    body: `${hi}<p>Your parcel for return <strong>{{reference}}</strong> has arrived. We're checking the items now and will update you shortly.</p>`,
  },
  exchange_completed: {
    label: "Exchange completed",
    when: "You complete an exchange.",
    enabled: true,
    subject: "Your exchange {{reference}} is complete",
    body: `${hi}<p>Your exchange <strong>{{reference}}</strong> is complete — your replacement is on its way.</p>{{{replacement}}}{{#if refund_amount}}<p>We've also refunded <strong>{{refund_amount}}</strong> to your original payment method.</p>{{/if}}`,
  },
  refund_issued: {
    label: "Refund issued",
    when: "A refund is issued. Off by default: Shopify already emails customers about refunds.",
    enabled: false,
    subject: "Your refund for {{reference}}",
    body: `${hi}<p>We've refunded <strong>{{refund_amount}}</strong> for return <strong>{{reference}}</strong> to your original payment method. It can take 5–7 business days to appear.</p>`,
  },
};

export const EVENT_KEYS = Object.keys(EMAIL_EVENTS) as EmailEvent[];

/** Variables available in every template (shown in the editor, and what `sampleVars` demonstrates). */
export const VARIABLES: { name: string; hint: string }[] = [
  { name: "customer_name", hint: "Full name" },
  { name: "customer_first_name", hint: "First name" },
  { name: "order_name", hint: "e.g. #1089" },
  { name: "reference", hint: "Return name or EX- code" },
  { name: "shop_name", hint: "Your store name" },
  { name: "{{{items}}}", hint: "List of returned items (HTML)" },
  { name: "{{{replacement}}}", hint: "List of replacement items (HTML)" },
  { name: "reason", hint: "Customer's reason" },
  { name: "note", hint: "Your decline note" },
  { name: "tracking_number", hint: "AWB" },
  { name: "tracking_url", hint: "Courier tracking link" },
  { name: "carrier", hint: "Courier name" },
  { name: "pickup_date", hint: "Scheduled pickup" },
  { name: "refund_amount", hint: "e.g. $25.00" },
  { name: "form_url", hint: "Link to your return form" },
  { name: "brand_color", hint: "Your email accent colour" },
];

const list = (rows: string[]) =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 14px">${rows
    .map((r) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${r}</td></tr>`)
    .join("")}</table>`;

export const sampleVars = (shopName: string, brandColor: string): Vars => ({
  customer_name: "Asha Rao",
  customer_first_name: "Asha",
  order_name: "#1089",
  reference: "#1089-R1",
  shop_name: shopName,
  items: list(["<strong>Court Sneaker</strong> — Size 38 × 1"]),
  replacement: list(["<strong>Court Sneaker</strong> — Size 39 × 1"]),
  reason: "Size too small",
  note: "This item is outside our return window.",
  tracking_number: "AWB123456789",
  tracking_url: "https://example.com/track/AWB123456789",
  carrier: "Delhivery",
  pickup_date: "Thursday, 16 Oct",
  refund_amount: "$25.00",
  form_url: "https://example.com/pages/returns",
  brand_color: brandColor,
});
