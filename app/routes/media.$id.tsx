import type { LoaderFunctionArgs } from "react-router";
import { readUpload, verifyMediaSig } from "../services/uploads.server";

// Serves a customer's return photo. Public on purpose (an <img> inside the embedded admin can't carry a Shopify session),
// but only for a valid signed URL: /media/<id>?s=<signature>. Anything else is a plain 404.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const id = params.id ?? "";
  if (!/^[a-z0-9]{20,40}$/i.test(id) || !verifyMediaSig(id, new URL(request.url).searchParams.get("s"))) return new Response("Not found", { status: 404 });
  const row = await readUpload(id);
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.data), {
    headers: {
      "Content-Type": row.mime,
      "Content-Length": String(row.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'", // an image must never run script
    },
  });
};
