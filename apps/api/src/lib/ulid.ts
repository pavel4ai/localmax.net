/**
 * ULID: 48-bit timestamp + 80 bits of randomness, Crockford base32.
 *
 * Chosen over a UUID because run ids sort lexicographically by creation time, which lets the
 * archive job page through newly accepted results with a plain `WHERE run_id > ?` and keeps
 * D1's primary-key index append-mostly under load.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LEN));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}
