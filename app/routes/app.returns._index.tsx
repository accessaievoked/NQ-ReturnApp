import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import type { Prisma, ReturnStatus } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop } from "../services/shop.server";
import { STATUS_META, fmtDate } from "../lib/format";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as ReturnStatus | null;
  const q = url.searchParams.get("q")?.trim();
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));

  const where: Prisma.ReturnRequestWhereInput = {
    shopId: shop.id,
    ...(status && status in STATUS_META ? { status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { orderName: { contains: q, mode: "insensitive" } },
            { customerName: { contains: q, mode: "insensitive" } },
            { customerEmail: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.returnRequest.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { items: { select: { title: true, imageUrl: true, reason: true, quantity: true } } },
    }),
    db.returnRequest.count({ where }),
  ]);
  return { rows, total, page, pages: Math.ceil(total / PAGE_SIZE), status, q: q ?? "" };
};

export default function Returns() {
  const { rows, total, page, pages, status, q } = useLoaderData<typeof loader>();
  const link = (p: Record<string, string | number | null>) => {
    const u = new URLSearchParams();
    const merged = { status, q, page, ...p };
    Object.entries(merged).forEach(([k, v]) => v && u.set(k, String(v)));
    return `/app/returns?${u}`;
  };

  return (
    <s-page heading="Returns & exchanges">
      <s-section padding="none">
        <s-stack direction="inline" gap="small-200" padding="base">
          <s-button variant={status ? "tertiary" : "primary"} href={link({ status: null, page: 1 })}>All</s-button>
          {Object.entries(STATUS_META).map(([key, m]) => (
            <s-button key={key} variant={status === key ? "primary" : "tertiary"} href={link({ status: key, page: 1 })}>
              {m.label}
            </s-button>
          ))}
        </s-stack>
        <form method="get" style={{ padding: "0 16px 12px" }}>
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder="Search return, order, customer…" style={{ width: "100%", padding: 8 }} />
        </form>

        <s-table>
          <s-table-header-row>
            <s-table-header>Return</s-table-header>
            <s-table-header>Requested</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>Items</s-table-header>
            <s-table-header>Reason</s-table-header>
            <s-table-header>Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => {
              const meta = STATUS_META[r.status];
              return (
                <s-table-row key={r.id} clickDelegate={`ret-${r.id}`}>
                  <s-table-cell>
                    <s-link id={`ret-${r.id}`} href={`/app/returns/${r.id}`}>{r.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{fmtDate(r.requestedAt)}</s-table-cell>
                  <s-table-cell>{r.orderName}</s-table-cell>
                  <s-table-cell>{r.customerName ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      {r.items[0]?.imageUrl && <s-thumbnail src={r.items[0].imageUrl} alt={r.items[0].title} size="small" />}
                      {r.items.reduce((n, i) => n + i.quantity, 0)}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.items[0]?.reason ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={meta.tone}>{meta.label}</s-badge>
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
        {rows.length === 0 && <s-box padding="large"><s-paragraph>No returns found.</s-paragraph></s-box>}
        <s-stack direction="inline" gap="base" padding="base" justifyContent="space-between">
          <s-text color="subdued">{total} total</s-text>
          <s-stack direction="inline" gap="small-200">
            {page > 1 && <s-button href={link({ page: page - 1 })}>Previous</s-button>}
            {page < pages && <s-button href={link({ page: page + 1 })}>Next</s-button>}
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
