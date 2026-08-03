/**
 * Statistics shared between the validator and the read API.
 *
 * Deliberately dependency-free so the cross-language contract tests can import it directly
 * and pin the Python runner against it. The two implementations must agree exactly: a
 * divergence here would make an honest submitter's metrics look fabricated.
 */

/** Linear-interpolation percentile over a pre-sorted array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export function withinTolerance(declared: number, recomputed: number, tolerancePct: number): boolean {
  if (recomputed === 0) return Math.abs(declared) < 1e-9;
  return (Math.abs(declared - recomputed) / Math.abs(recomputed)) * 100 <= tolerancePct;
}
