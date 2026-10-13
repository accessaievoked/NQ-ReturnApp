import type { ActionFunctionArgs } from "react-router";
import { handleCourierWebhook, type CourierWebhookBody } from "../services/courier-webhook.server";

// Public endpoint for Shiprocket's tracking webhook. It is not behind Shopify login (Shiprocket can't log in); it is
// protected by the connection's secret instead, which Shiprocket sends back as the `x-api-key` header.
// NOTE: Shiprocket refuses webhook URLs containing "shiprocket", "kartrocket", "sr" or "kr" — keep this path clean.

// Shiprocket (or a human) may probe the URL with GET; answer 200 without revealing anything.
export const loader = async () => new Response("ok", { status: 200 });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: CourierWebhookBody;
  try {
    body = (await request.json()) as CourierWebhookBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  try {
    const result = await handleCourierWebhook(params.publicId!, request.headers.get("x-api-key"), body);
    return new Response(result.message, { status: result.status });
  } catch (err) {
    // A 5xx makes Shiprocket retry, which is what we want for a transient failure.
    console.error("Courier webhook failed", err);
    return new Response("error", { status: 500 });
  }
};
