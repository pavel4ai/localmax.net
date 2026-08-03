import type { Env } from "../env";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The action the verification page stamps on its widget. */
const EXPECTED_ACTION = "submit";

/** A Turnstile token is a bounded opaque string; anything longer is not worth forwarding. */
const MAX_TOKEN_LENGTH = 2048;

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

/**
 * Verify a Cloudflare Turnstile token.
 *
 * Turnstile is the only friction between an anonymous contributor and a submission: no
 * account, no email, no GitHub token. It is a bot cost, not an identity check.
 *
 * Three things are checked, not one. `success` alone would accept a token minted for a
 * different action on a different site under the same account, so the action and the
 * frontend hostname are compared too. Every failure path fails closed.
 */
export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!env.TURNSTILE_SECRET_KEY) {
    if (env.ENVIRONMENT === "production") {
      return { ok: false, reason: "turnstile_not_configured" };
    }
    return { ok: true };
  }

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed_token" };
  }

  // Hostnames the widget may legitimately have been solved on. Derived from the site
  // origin so a staging deployment cannot accept a production token and vice versa.
  const siteHost = new URL(env.SITE_ORIGIN).hostname;
  const allowedHosts = new Set([siteHost, `www.${siteHost}`.replace(/^www\.www\./, "www.")]);

  let data: SiteverifyResponse;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
      }),
    });
    if (!res.ok) return { ok: false, reason: `siteverify_${res.status}` };
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    return { ok: false, reason: "verify_unreachable" };
  }

  if (!data.success) {
    return { ok: false, reason: data["error-codes"]?.join(",") || "rejected" };
  }
  if (data.action !== EXPECTED_ACTION) {
    return { ok: false, reason: `action_mismatch:${data.action ?? "none"}` };
  }
  if (!data.hostname || !allowedHosts.has(data.hostname)) {
    return { ok: false, reason: `hostname_mismatch:${data.hostname ?? "none"}` };
  }

  return { ok: true };
}
