import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import { Link, Outlet, useLoaderData, useLocation, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { savedCurrency, supportsCurrency } from "../lib/currency-pref";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Returns still waiting for a decision — drives the alert pill shown on every page.
  const shop = await ensureShop(session.shop);
  const unresolved = await db.returnRequest.count({ where: { shopId: shop.id, status: "REQUESTED" } });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", unresolved };
};

/** Re-applies the browser-remembered display currency (`?cur=`) when navigating between pages that support it. */
function CurrencySync() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const saved = savedCurrency();
    const params = new URLSearchParams(search);
    if (!saved || params.has("cur") || !supportsCurrency(pathname)) return;
    params.set("cur", saved);
    navigate(`${pathname}?${params}`, { replace: true });
  }, [pathname, search, navigate]);
  return null;
}

export default function App() {
  const { apiKey, unresolved } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/returns">Returns</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/automation">Automation</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <CurrencySync />
      {unresolved > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px 0" }}>
          <Link
            to="/app/returns?status=REQUESTED"
            title="Open the returns that are waiting for your decision"
            style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#fbeae5", color: "#b4331a", border: "1px solid #f5c6bb", borderRadius: 20, padding: "5px 14px 5px 10px", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
          >
            <span style={{ position: "relative", fontSize: 16, lineHeight: 1 }}>
              🔔
              <span style={{ position: "absolute", top: -6, right: -9, background: "#d72c0d", color: "#fff", borderRadius: 10, minWidth: 16, height: 16, padding: "0 4px", fontSize: 10, display: "grid", placeItems: "center", boxSizing: "border-box" }}>
                {unresolved > 99 ? "99+" : unresolved}
              </span>
            </span>
            <span style={{ marginLeft: 6 }}>{unresolved} return{unresolved === 1 ? "" : "s"} need{unresolved === 1 ? "s" : ""} review</span>
          </Link>
        </div>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
