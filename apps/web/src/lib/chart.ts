/**
 * Chart primitives.
 *
 * Every chart on this site is server-rendered inline SVG built from these helpers. There is
 * no chart library and no client-side rendering: a leaderboard is text and vector marks, so
 * it should arrive as text and vector marks. Hover detail rides on native SVG <title>,
 * which costs no JavaScript at all.
 */

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  ticks(count?: number): number[];
}

export function linearScale(
  domain: [number, number],
  range: [number, number],
): Scale {
  let [d0, d1] = domain;
  if (d0 === d1) {
    // A single distinct value would divide by zero; give it a nominal band.
    const pad = Math.abs(d0) * 0.1 || 1;
    d0 -= pad;
    d1 += pad;
  }
  const [r0, r1] = range;
  const fn = ((value: number) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0)) as Scale;
  fn.domain = [d0, d1];
  fn.range = range;
  fn.ticks = (count = 5) => niceTicks(d0, d1, count);
  return fn;
}

/** Ticks on 1/2/5×10ⁿ boundaries, which is what makes an axis readable. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    out.push(Math.abs(t) < step * 1e-9 ? 0 : Number(t.toFixed(10)));
  }
  return out;
}

/**
 * A horizontal bar with a rounded free end and a square baseline end.
 *
 * The baseline end must stay square: rounding it lifts the mark off its own zero line and
 * makes short bars read as longer than they are.
 */
export function barPath(x0: number, y: number, x1: number, height: number, radius = 4): string {
  const w = Math.max(0, x1 - x0);
  const r = Math.min(radius, w, height / 2);
  if (w <= 0) return "";
  if (r <= 0.5) return `M${x0},${y}h${w}v${height}h${-w}Z`;
  return (
    `M${x0},${y}` +
    `h${w - r}` +
    `a${r},${r} 0 0 1 ${r},${r}` +
    `v${height - 2 * r}` +
    `a${r},${r} 0 0 1 ${-r},${r}` +
    `h${-(w - r)}` +
    `Z`
  );
}

export function extent(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return [0, 1];
  return [min, max];
}

export function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/** Categorical slots, assigned in fixed order and never cycled. */
export const SERIES = [
  "var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)",
  "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)",
] as const;

/**
 * Tier is the site's primary categorical dimension and has exactly three values, which is
 * also the cap for all-pairs forms such as the scatter. Colour follows the tier, never the
 * rank, so filtering never repaints the survivors.
 */
export const TIER_COLOR: Record<string, string> = {
  entry: SERIES[0],
  enthusiast: SERIES[1],
  prospector: SERIES[2],
};

export function axisFormat(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  if (abs === 0) return "0";
  return value.toFixed(abs >= 0.1 ? 2 : 3);
}
