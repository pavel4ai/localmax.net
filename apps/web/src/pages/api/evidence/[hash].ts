import type { APIRoute } from "astro";
import { apiFetcher } from "../../../lib/api";

/**
 * Serve evidence from the site origin.
 *
 * The R2 bucket is private and the API Worker is the only reader. Proxying through here
 * keeps evidence links on localmax.net (so they survive an API hostname change) and lets the
 * response inherit the site's own security headers. The upstream already sets an immutable
 * cache policy, because the object is addressed by its own hash.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const hash = (params.hash ?? "").replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return new Response("Malformed evidence hash", { status: 400 });
  }

  const upstream = await apiFetcher()(`/v1/evidence/${hash}`);
  if (!upstream.ok) {
    return new Response("Evidence not found", { status: upstream.status });
  }

  const headers = new Headers(upstream.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
  return new Response(upstream.body, { status: 200, headers });
};
