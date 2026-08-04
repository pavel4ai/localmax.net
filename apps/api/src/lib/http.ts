import type { Context } from "hono";
import type { Env } from "../env";
import { REGISTRY_VERSION } from "../generated/registry";

export type ApiErrorCode =
  | "bad_request"
  | "schema_invalid"
  | "signature_invalid"
  | "challenge_required"
  | "token_expired"
  | "nonce_reused"
  | "profile_unknown"
  | "profile_mismatch"
  | "artifact_mismatch"
  | "too_large"
  | "rate_limited"
  | "not_found"
  | "conflict"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  schema_invalid: 422,
  signature_invalid: 401,
  challenge_required: 401,
  token_expired: 401,
  nonce_reused: 409,
  profile_unknown: 404,
  profile_mismatch: 422,
  artifact_mismatch: 422,
  too_large: 413,
  rate_limited: 429,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

export function fail(
  c: Context<{ Bindings: Env }>,
  error: ApiErrorCode,
  message: string,
  details?: string[],
  retryAfterS?: number,
) {
  const body: Record<string, unknown> = { error, message };
  if (details?.length) body.details = details.slice(0, 20);
  if (retryAfterS !== undefined) body.retry_after_s = retryAfterS;
  const headers: Record<string, string> = {};
  if (retryAfterS !== undefined) headers["Retry-After"] = String(retryAfterS);
  return c.json(body, STATUS[error] as 400, headers);
}

/**
 * Edge cache wrapper for read endpoints.
 *
 * Read traffic is the part of the system that actually sees thousands of concurrent users,
 * and nearly all of it is the same handful of leaderboard queries. Serving those from the
 * colo cache keeps D1 out of the hot path; stale-while-revalidate means a cache expiry
 * never turns into a thundering herd against the database.
 */
export async function cached(
  c: Context<{ Bindings: Env }>,
  ttlSeconds: number,
  produce: () => Promise<unknown>,
  staleSeconds = ttlSeconds * 10,
): Promise<Response> {
  const cache = caches.default;

  // The cache key carries a registry version. Without it a deploy that renames a tier or a
  // lane keeps serving the old response shape until the TTL expires — a cached body with a
  // retired enum value, which reads as missing data rather than as stale data.
  const url = new URL(c.req.url);
  url.searchParams.set("__v", REGISTRY_VERSION);
  const key = new Request(url.toString(), { method: "GET" });

  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("X-Cache", "HIT");
    return res;
  }

  const data = await produce();
  const res = c.json(data as Record<string, unknown>);
  res.headers.set(
    "Cache-Control",
    `public, max-age=${ttlSeconds}, stale-while-revalidate=${staleSeconds}`,
  );
  res.headers.set("X-Cache", "MISS");
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export function clientIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "0.0.0.0"
  );
}

/** Clamp a user-supplied integer query parameter. */
export function intParam(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
