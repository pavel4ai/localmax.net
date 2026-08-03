import { signingPayload } from "./canonical";

const enc = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return bytesToHex(await crypto.subtle.digest("SHA-256", buf));
}

/**
 * Verify the runner's Ed25519 signature over the canonical manifest.
 *
 * This proves the bundle was produced by one runner installation and has not been altered
 * since. It proves nothing about whether the reported hardware is real.
 */
export async function verifyManifestSignature(
  manifest: Record<string, unknown>,
): Promise<boolean> {
  const signature = manifest.signature as { algorithm?: string; value?: string } | undefined;
  const submitter = manifest.submitter as { system_key?: string } | undefined;
  if (!signature?.value || !submitter?.system_key) return false;
  if (signature.algorithm !== "ed25519") return false;

  let key: CryptoKey;
  let sigBytes: Uint8Array;
  try {
    const rawKey = b64ToBytes(submitter.system_key);
    if (rawKey.length !== 32) return false;
    sigBytes = b64ToBytes(signature.value);
    if (sigBytes.length !== 64) return false;
    key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sigBytes,
      enc.encode(signingPayload(manifest)),
    );
  } catch {
    return false;
  }
}

/** Random lowercase hex, used for nonces, challenge ids and single-use upload tokens. */
export function randomHex(bytes = 16): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Salted hash of a client IP. Stored only on in-flight submissions for abuse detection and
 * deleted with the submission row; never written to an accepted result.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 32);
}

/** Constant-time string comparison for tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
