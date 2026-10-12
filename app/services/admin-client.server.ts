import { unauthenticated } from "../shopify.server";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

/** Admin API client for a shop using its stored offline token (for webhooks / background work). */
export async function getAdmin(shop: string): Promise<AdminClient> {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

export async function gql<T>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data as T;
}
