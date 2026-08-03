import type { Env } from "../env";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Cloudflare Turnstile token.
 *
 * Turnstile is the only friction between an anonymous contributor and a submission: no
 * account, no email, no GitHub token. It is a bot cost, not an identity check.
 *
 * In a development environment with no secret configured, verification is skipped so the
 * local end-to-end path works offline. That branch can never run in production because
 * `wrangler deploy` fails without the secret.
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

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  body.append("remoteip", ip);

  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (data.success) return { ok: true };
    return { ok: false, reason: data["error-codes"]?.join(",") ?? "rejected" };
  } catch {
    return { ok: false, reason: "verify_unreachable" };
  }
}
