import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { PortalError, submitRequest, type SubmitPayload } from "../services/portal.server";
import { rateLimited } from "../services/rate-limit.server";
import { UploadError, saveUpload } from "../services/uploads.server";
import { ensureShop } from "../services/shop.server";

// JSON endpoints behind the return form, reached through Shopify's app proxy:  /apps/returns/<action>  ->  /proxy/<action>
//   submit  — create the return / exchange request
//   upload  — attach a customer photo
// (The form page itself is /apps/returns/form, see proxy.form.tsx.)
// Shopify signs every proxied request; `authenticate.public.appProxy` verifies that signature, so only requests that
// really came through the merchant's storefront get in. `logged_in_customer_id` is part of that signed query, so it can be
// trusted as proof of who is logged in; without it the customer proves ownership with the order's email instead.

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const clientIp = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

async function handle(request: Request, action: string) {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop");
  if (!shop) return json({ error: "This store isn't set up for returns yet." }, 404);
  const ip = clientIp(request);
  const customerId = url.searchParams.get("logged_in_customer_id") || null;

  try {
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    if (action === "submit") {
      const email = String(body.email ?? "").toLowerCase();
      if (rateLimited(`submit:${shop}:${ip}:${customerId ?? email}`, 6, 60 * 60_000)) return json({ error: "Too many requests. Please try again later." }, 429);
      const result = await submitRequest(
        shop,
        {
          orderId: body.orderId ? String(body.orderId) : undefined,
          orderNumber: body.orderNumber ? String(body.orderNumber) : undefined,
          email,
          type: body.type === "EXCHANGE" ? "EXCHANGE" : "RETURN",
          items: Array.isArray(body.items) ? (body.items as SubmitPayload["items"]) : [],
          replacements: Array.isArray(body.replacements) ? (body.replacements as SubmitPayload["replacements"]) : [],
        },
        { customerId },
      );
      return json({ ok: true, data: result });
    }
    if (action === "upload") {
      if (rateLimited(`upload:${shop}:${ip}`, 30, 10 * 60_000)) return json({ error: "Too many uploads. Please wait a few minutes." }, 429);
      const record = await ensureShop(shop);
      const data = await saveUpload(record.id, String(body.data ?? ""), String(body.mime ?? ""));
      return json({ ok: true, data });
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof PortalError || err instanceof UploadError) return json({ error: err.message }, 400);
    console.error(`Return form ${action} failed`, err);
    return json({ error: "Something went wrong on our side. Please try again in a moment." }, 500);
  }
}

export const action = ({ request, params }: ActionFunctionArgs) => handle(request, params.action!);
export const loader = ({ request, params }: LoaderFunctionArgs) => handle(request, params.action!);
