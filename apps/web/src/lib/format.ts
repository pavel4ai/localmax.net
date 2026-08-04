/** Presentation helpers. Nothing here changes a value; it only chooses how to show it. */

export function num(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const d =
    digits !== undefined ? digits
    : abs >= 1000 ? 0
    : abs >= 100 ? 1
    : abs >= 1 ? 2
    : abs >= 0.01 ? 3
    : 4;
  return value.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** For counts. Integers stay integers; large values get a k/M suffix. */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1000) return Number.isInteger(value) ? String(value) : num(value);
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

export function bytes(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  const gb = value / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(value / 1024 ** 2)} MB`;
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 10000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${num(value, value >= 100 ? 0 : 1)} ms`;
}

export function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 3600) return `${Math.floor(value / 3600)}h ${Math.round((value % 3600) / 60)}m`;
  if (value >= 60) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return `${num(value)} s`;
}

export function watts(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value)} W`;
}

export function pct(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(digits)}%`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)} h ago`;
  if (secs < 2592000) return `${Math.round(secs / 86400)} d ago`;
  return new Date(then).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function isoDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—";
}

/** Human label for a metric key, so a table header never shows a raw column name. */
const METRIC_LABELS: Record<string, string> = {
  decode_throughput_tok_s: "Decode",
  prefill_throughput_tok_s: "Prefill",
  peak_output_throughput_tok_s: "Peak throughput",
  ttft_p50_ms: "TTFT p50",
  ttft_p95_ms: "TTFT p95",
  itl_p50_ms: "Inter-token p50",
  itl_p95_ms: "Inter-token p95",
  e2e_latency_p50_ms: "End to end p50",
  seconds_per_step_s: "Seconds / step",
  throughput_img_min: "Images / min",
  generation_p50_s: "Per image p50",
  generation_p95_s: "Per image p95",
  energy_per_output_token_j: "Energy / token",
  energy_per_image_j: "Energy / image",
  quality_gate_pct: "Answer accuracy",
  model_load_s: "Model load",
  image_prefill_p50_ms: "Image encode p50",
  error_ratio: "Error rate",
  offload_ratio: "CPU offload",
};

export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function unitFor(metric: string): string {
  if (metric.endsWith("_tok_s")) return "tok/s";
  if (metric.endsWith("_img_min")) return "img/min";
  if (metric.endsWith("_ms")) return "ms";
  if (metric.endsWith("_s")) return "s";
  if (metric.endsWith("_w")) return "W";
  if (metric.endsWith("_j")) return "J";
  if (metric.endsWith("_pct")) return "%";
  return "";
}

export const CATEGORY_LABEL: Record<string, string> = {
  llm: "LLM",
  vision: "Vision",
  diffusion: "Diffusion",
};

export const TIER_LABEL: Record<string, string> = {
  entry: "Entry",
  enthusiast: "Enthusiast",
  prospector: "Prospector",
};

export const LANE_LABEL: Record<string, string> = {
  fp8: "FP8",
  int4: "INT4",
  nvfp4: "NVFP4",
};

/** Which hardware each lane can run. Shown wherever a lane is offered. */
export const LANE_HARDWARE: Record<string, string> = {
  fp8: "Ada and newer",
  int4: "Ampere and newer",
  nvfp4: "Blackwell only",
};

export const TIER_VRAM: Record<string, string> = {
  entry: "12 GB+",
  enthusiast: "24 GB+",
  prospector: "64 GB+",
};

/**
 * The public label for a contributed system.
 *
 * Generated from the machine's public key, never chosen by a person. The same machine
 * always gets the same label, so results accumulate under one name, and the label says
 * nothing about who ran it.
 */
export function systemLabel(r: {
  system_name: string | null;
  system_code?: string | null;
  gpu_name: string;
  gpu_count: number;
  run_id?: string;
}): string {
  if (r.system_name) return r.system_name;
  if (r.run_id) return `System ${r.run_id.slice(-6)}`;
  return r.gpu_count > 1 ? `${r.gpu_count}× ${short(r.gpu_name)}` : short(r.gpu_name);
}

/** Strip the vendor prefix so tables stay narrow. */
export function short(gpuName: string): string {
  return gpuName.replace(/^NVIDIA\s+/, "").replace(/\s+Generation$/, "");
}

/** Format a headline value with its unit, respecting sensible precision per unit. */
export function headline(value: number, unit: string): string {
  if (unit === "s/step") return num(value, value < 1 ? 3 : 2);
  if (unit === "ms") return num(value, 0);
  return num(value);
}
