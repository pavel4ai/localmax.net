import { CODE_ALPHABET, SYSTEM_NAMES } from "../generated/system-names";

/**
 * Derive a system's public label from its public key.
 *
 * Contributors are anonymous, so no result carries a name a person chose. The label is a
 * pure function of the key: the same machine always gets the same one, two machines almost
 * never collide, and nothing about the label points back to an operator.
 *
 * The five-character code is the part that matters to a contributor — it is how they find
 * their own results later, and the only handle they need to share them.
 *
 * The Python runner computes the identical value from the same source list, so the terminal
 * shows exactly what the site will.
 */
export async function deriveSystemLabel(
  systemKey: string,
): Promise<{ name: string; code: string; label: string }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(systemKey));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const name = SYSTEM_NAMES[Number.parseInt(hex.slice(0, 8), 16) % SYSTEM_NAMES.length]!;

  let code = "";
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[Number.parseInt(hex.slice(8 + i * 2, 10 + i * 2), 16) % 32];
  }

  return { name, code, label: `${name}-${code}` };
}
