/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * The runner signs the canonical form of the manifest with the `signature.value` field
 * removed, so both sides must agree byte for byte on the serialization. Key insertion
 * order, whitespace and number formatting must not be able to change the bytes.
 */

/** ES6 number-to-string, which RFC 8785 mandates for numeric serialization. */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError("Cannot canonicalize a non-finite number");
  }
  if (Object.is(n, -0)) return "0";
  return String(n);
}

function serializeString(s: string): string {
  // JSON.stringify already emits the escaping RFC 8785 requires (\b \t \n \f \r \" \\ and
  // \u00xx for the remaining control characters), and leaves all other code points literal.
  return JSON.stringify(s);
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  // RFC 8785 sorts by UTF-16 code unit, which is what Array#sort does by default.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  const parts = keys.map((k) => `${serializeString(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** The exact bytes the runner signed: the manifest without `signature.value`. */
export function signingPayload(manifest: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...manifest };
  const sig = copy.signature as Record<string, unknown> | undefined;
  if (sig) {
    const { value: _omit, ...rest } = sig;
    copy.signature = rest;
  }
  return canonicalize(copy);
}
