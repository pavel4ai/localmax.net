import type { APIRoute } from "astro";
import { apiFetcher } from "../../../../lib/api";

/**
 * Proxy the Turnstile solve from the site origin to the API Worker.
 *
 * Keeping it same-origin means the verification page needs no CORS preflight and the API
 * Worker's write endpoints stay restricted to the site origin.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = params.id ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return Response.json({ error: "bad_request", message: "Malformed challenge id." }, { status: 400 });
  }

  const body = await request.text();
  if (body.length > 4096) {
    return Response.json({ error: "too_large", message: "Payload too large." }, { status: 413 });
  }

  const upstream = await apiFetcher()(`/v1/submissions/challenge/${id}/solve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Preserve the real client address so Turnstile validates against the right IP.
      "CF-Connecting-IP": request.headers.get("CF-Connecting-IP") ?? "",
    },
    body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
};

export const prerender = false;
