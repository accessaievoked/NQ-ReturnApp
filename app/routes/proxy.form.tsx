import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { rateLimited } from "../services/rate-limit.server";
import { renderReturnPage } from "../services/return-page.server";

// The return form page — Shopify app proxy:  https://<store>/apps/returns/form?id=<order id>  (or ?order=<number>&email=…)
// The "Return or exchange" button on the customer's order page links here with the order id; because the request is signed
// by Shopify, `logged_in_customer_id` tells us who is logged in, so a customer opening their own order sees the form
// straight away. Anyone else is asked to confirm the order's email first.
//
// The page is the store's own saved template (markup + CSS + style options), edited on the "Form design" page.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop");
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  if (!shop) return new Response("This store isn't set up for returns yet.", { status: 404, headers });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(`form:${shop}:${ip}`, 60, 10 * 60_000)) return new Response("Too many requests. Please wait a few minutes.", { status: 429, headers });

  const { status, html } = await renderReturnPage(shop, {
    ref: { id: url.searchParams.get("id"), number: url.searchParams.get("order") },
    customerId: url.searchParams.get("logged_in_customer_id") || null,
    email: url.searchParams.get("email")?.trim() || null,
  });
  return new Response(html, { status, headers });
};
