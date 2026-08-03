import { GPUS, type Profile } from "../generated/registry";
import type { Finding } from "../env";

// ---------------------------------------------------------------------------
// Manifest shape. Only the parts the API reads are typed; the schema validator
// has already proven the whole document conforms before any of this runs.
// ---------------------------------------------------------------------------

export interface Workload {
  id: string;
  kind: string;
  status: string;
  requests?: number;
  errors?: number;
  metrics: Record<string, number | null>;
  latency_ms?: Record<string, number>;
  ttft_ms?: Record<string, number>;
  failure_reason?: string;
}

export interface Manifest {
  schema_version: string;
  run_id: string;
  created_at: string;
  duration_s?: number;
  profile: { id: string; version: string; category: string; tier: string; lane: string; hash: string };
  model: { repository: string; revision: string; precision: string; parameters_b: number };
  container: { image: string; digest: string; runner_version: string; platform: string; official?: boolean };
  runtime: { name: string; version: string; flags?: Record<string, unknown> };
  hardware: {
    gpus: Array<{
      name: string;
      vram_bytes: number;
      architecture: string;
      compute_capability?: string;
      memory_bandwidth_gb_s?: number;
      power_limit_w?: number;
      pcie_gen?: number;
      pcie_width?: number;
    }>;
    gpu_count: number;
    parallelism: string;
    interconnect?: string;
    cpu: { model: string; cores: number; threads?: number; arch: string };
    system_ram_bytes: number;
    memory_type: string;
    cooling?: string;
    tuning?: string;
  };
  software: {
    os: string; kernel: string; arch: string; driver: string; cuda: string;
    container_runtime?: string; virtualization?: string;
  };
  workloads: Workload[];
  headline: { metric: string; value: number; unit: string; secondary?: Record<string, number | null> };
  telemetry: {
    power_domain: string;
    coverage_pct: number;
    sample_interval_ms: number;
    samples?: number;
    power_avg_w?: number;
    power_peak_w?: number;
    energy_j?: number;
    vram_peak_bytes?: number;
    system_ram_peak_bytes?: number;
    gpu_util_avg_pct?: number;
    temperature_peak_c?: number;
    throttle_events?: { thermal_count?: number; power_count?: number; reliability_count?: number };
  };
  artifacts: Array<{ name: string; kind: string; hash: string; size_bytes: number; media_type: string; required?: boolean }>;
  submitter: { alias?: string; system_name?: string; system_key: string; notes?: string };
  signature: { algorithm: string; value: string };
}

// ---------------------------------------------------------------------------

/**
 * Resolve a driver-reported GPU name to a registry key.
 *
 * NVML strings vary ("NVIDIA GeForce RTX 4090", "NVIDIA RTX PRO 6000 Blackwell Workstation
 * Edition"), so match on a normalized form and prefer the longest registry name that is a
 * prefix of it — otherwise "RTX 5070" would swallow "RTX 5070 Ti".
 */
export function resolveGpuKey(name: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(name);

  let best: { key: string; len: number } | null = null;
  for (const gpu of GPUS) {
    const candidate = norm(gpu.name);
    if (target === candidate || target.startsWith(candidate + " ")) {
      if (!best || candidate.length > best.len) best = { key: gpu.key, len: candidate.length };
    }
  }
  if (best) return best.key;

  return target.replace(/^nvidia /, "").replace(/\s+/g, "-").slice(0, 60) || "unknown";
}

export function findWorkload(manifest: Manifest, id: string): Workload | undefined {
  return manifest.workloads.find((w) => w.id === id);
}

export function metric(manifest: Manifest, workloadId: string, name: string): number | null {
  const w = findWorkload(manifest, workloadId);
  const v = w?.metrics?.[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** First non-null value of `name` across every workload, in declaration order. */
function anyMetric(manifest: Manifest, name: string): number | null {
  for (const w of manifest.workloads) {
    const v = w.metrics?.[name];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export interface GateResult {
  passed: boolean;
  findings: Finding[];
}

/**
 * Evaluate the profile's ranking gates.
 *
 * A failed gate never rejects a result and never alters a value. It publishes the result
 * with every raw number intact and withholds only the rank, with the reason shown.
 */
export function evaluateGates(manifest: Manifest, profile: Profile): GateResult {
  const findings: Finding[] = [];
  let passed = true;

  for (const gate of profile.ranking.gates ?? []) {
    const value = metric(manifest, gate.source_workload, gate.metric);
    if (value === null) {
      passed = false;
      findings.push({
        code: "gate_metric_missing",
        severity: "warning",
        message: `Gate metric ${gate.metric} is missing from workload ${gate.source_workload}; the result is published but not ranked.`,
        field: gate.metric,
      });
      continue;
    }
    const ok =
      gate.comparator === "lte" ? value <= gate.value
      : gate.comparator === "gte" ? value >= gate.value
      : value === gate.value;
    if (!ok) {
      passed = false;
      findings.push({
        code: "gate_failed",
        severity: "warning",
        message:
          `${gate.metric} was ${value} but the profile requires ${gate.comparator} ${gate.value}. ` +
          (gate.reason ?? "The result is published but not ranked."),
        field: gate.metric,
      });
    }
  }

  for (const w of manifest.workloads) {
    const wl = profile.workloads.find((p) => p.id === w.id);
    if (wl?.required_for_rank !== false && w.status !== "passed") {
      passed = false;
      findings.push({
        code: "workload_not_passed",
        severity: "warning",
        message: `Workload ${w.id} reported status "${w.status}"${w.failure_reason ? `: ${w.failure_reason}` : ""}.`,
        field: w.id,
      });
    }
  }

  return { passed, findings };
}

/** Columns of the `results` table, in the order the insert statement binds them. */
export interface ResultRow {
  run_id: string;
  created_at: string;
  accepted_at: string;
  verification: string;
  ranked: number;
  profile_id: string;
  profile_version: string;
  category: string;
  tier: string;
  lane: string;
  gpu_key: string;
  gpu_name: string;
  gpu_count: number;
  gpu_architecture: string | null;
  vram_bytes: number | null;
  parallelism: string;
  interconnect: string | null;
  memory_type: string | null;
  cpu_model: string | null;
  cpu_arch: string | null;
  system_ram_bytes: number | null;
  os: string | null;
  driver: string | null;
  cuda: string | null;
  virtualization: string | null;
  runtime: string | null;
  runtime_version: string | null;
  model_repository: string | null;
  model_revision: string | null;
  model_precision: string | null;
  container_digest: string | null;
  container_official: number;
  runner_version: string | null;
  headline_metric: string;
  headline_value: number;
  headline_unit: string;
  headline_direction: string;
  decode_tok_s: number | null;
  prefill_tok_s: number | null;
  peak_tok_s: number | null;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  itl_p95_ms: number | null;
  e2e_p50_ms: number | null;
  seconds_per_step_s: number | null;
  images_per_minute: number | null;
  quality_gate_pct: number | null;
  longcontext_pass: number | null;
  model_load_s: number | null;
  vram_peak_bytes: number | null;
  power_avg_w: number | null;
  power_peak_w: number | null;
  power_domain: string;
  energy_per_unit_j: number | null;
  efficiency: number | null;
  telemetry_coverage_pct: number | null;
  throttle_thermal: number;
  throttle_power: number;
  temperature_peak_c: number | null;
  alias: string | null;
  system_name: string | null;
  system_key: string | null;
  cooling: string | null;
  tuning: string | null;
  notes: string | null;
  manifest_json: string;
  findings_json: string;
}

export function buildRow(
  manifest: Manifest,
  profile: Profile,
  verification: string,
  ranked: boolean,
  findings: Finding[],
  acceptedAt: string,
): ResultRow {
  const gpu = manifest.hardware.gpus[0]!;
  const t = manifest.telemetry;
  const src = profile.ranking.source_workload;
  const direction = profile.ranking.direction;
  const powerAvg = t.power_avg_w ?? null;

  // "Useful work per watt". For a lower-is-better headline such as seconds per diffusion
  // step, invert first so the number always reads as more-is-better.
  const work = direction === "higher_is_better"
    ? manifest.headline.value
    : manifest.headline.value > 0 ? 1 / manifest.headline.value : null;
  const efficiency =
    powerAvg && powerAvg > 0 && work !== null && t.power_domain !== "unavailable"
      ? work / powerAvg
      : null;

  const longctx = findWorkload(manifest, "longcontext");

  return {
    run_id: manifest.run_id,
    created_at: manifest.created_at,
    accepted_at: acceptedAt,
    verification,
    ranked: ranked ? 1 : 0,
    profile_id: manifest.profile.id,
    profile_version: manifest.profile.version,
    category: manifest.profile.category,
    tier: manifest.profile.tier,
    lane: manifest.profile.lane,
    gpu_key: resolveGpuKey(gpu.name),
    gpu_name: gpu.name,
    gpu_count: manifest.hardware.gpu_count,
    gpu_architecture: gpu.architecture ?? null,
    vram_bytes: gpu.vram_bytes ?? null,
    parallelism: manifest.hardware.parallelism,
    interconnect: manifest.hardware.interconnect ?? null,
    memory_type: manifest.hardware.memory_type ?? null,
    cpu_model: manifest.hardware.cpu.model,
    cpu_arch: manifest.hardware.cpu.arch,
    system_ram_bytes: manifest.hardware.system_ram_bytes,
    os: manifest.software.os,
    driver: manifest.software.driver,
    cuda: manifest.software.cuda,
    virtualization: manifest.software.virtualization ?? null,
    runtime: manifest.runtime.name,
    runtime_version: manifest.runtime.version,
    model_repository: manifest.model.repository,
    model_revision: manifest.model.revision,
    model_precision: manifest.model.precision,
    container_digest: manifest.container.digest,
    container_official: manifest.container.official ? 1 : 0,
    runner_version: manifest.container.runner_version,

    headline_metric: manifest.headline.metric,
    headline_value: manifest.headline.value,
    headline_unit: manifest.headline.unit,
    headline_direction: direction,

    decode_tok_s: metric(manifest, src, "decode_throughput_tok_s") ?? anyMetric(manifest, "decode_throughput_tok_s"),
    prefill_tok_s: metric(manifest, src, "prefill_throughput_tok_s") ?? anyMetric(manifest, "prefill_throughput_tok_s"),
    peak_tok_s: anyMetric(manifest, "peak_output_throughput_tok_s"),
    ttft_p50_ms: metric(manifest, src, "ttft_p50_ms") ?? anyMetric(manifest, "ttft_p50_ms"),
    ttft_p95_ms: metric(manifest, src, "ttft_p95_ms") ?? anyMetric(manifest, "ttft_p95_ms"),
    itl_p95_ms: metric(manifest, src, "itl_p95_ms") ?? anyMetric(manifest, "itl_p95_ms"),
    e2e_p50_ms: metric(manifest, src, "e2e_latency_p50_ms") ?? anyMetric(manifest, "e2e_latency_p50_ms"),
    seconds_per_step_s: metric(manifest, src, "seconds_per_step_s"),
    images_per_minute: metric(manifest, src, "throughput_img_min"),
    quality_gate_pct: anyMetric(manifest, "quality_gate_pct"),
    longcontext_pass: longctx ? (longctx.status === "passed" ? 1 : 0) : null,
    model_load_s: anyMetric(manifest, "model_load_s"),

    vram_peak_bytes: t.vram_peak_bytes ?? null,
    power_avg_w: powerAvg,
    power_peak_w: t.power_peak_w ?? null,
    power_domain: t.power_domain,
    energy_per_unit_j:
      anyMetric(manifest, "energy_per_output_token_j") ?? anyMetric(manifest, "energy_per_image_j"),
    efficiency,
    telemetry_coverage_pct: t.coverage_pct ?? null,
    throttle_thermal: t.throttle_events?.thermal_count ?? 0,
    throttle_power: t.throttle_events?.power_count ?? 0,
    temperature_peak_c: t.temperature_peak_c ?? null,

    alias: manifest.submitter.alias ?? null,
    system_name: manifest.submitter.system_name ?? null,
    system_key: manifest.submitter.system_key,
    cooling: manifest.hardware.cooling ?? null,
    tuning: manifest.hardware.tuning ?? null,
    notes: manifest.submitter.notes ?? null,

    manifest_json: JSON.stringify(manifest),
    findings_json: JSON.stringify(findings),
  };
}

export const RESULT_COLUMNS = [
  "run_id", "created_at", "accepted_at", "verification", "ranked",
  "profile_id", "profile_version", "category", "tier", "lane",
  "gpu_key", "gpu_name", "gpu_count", "gpu_architecture", "vram_bytes",
  "parallelism", "interconnect", "memory_type",
  "cpu_model", "cpu_arch", "system_ram_bytes",
  "os", "driver", "cuda", "virtualization",
  "runtime", "runtime_version",
  "model_repository", "model_revision", "model_precision",
  "container_digest", "container_official", "runner_version",
  "headline_metric", "headline_value", "headline_unit", "headline_direction",
  "decode_tok_s", "prefill_tok_s", "peak_tok_s",
  "ttft_p50_ms", "ttft_p95_ms", "itl_p95_ms", "e2e_p50_ms",
  "seconds_per_step_s", "images_per_minute", "quality_gate_pct",
  "longcontext_pass", "model_load_s",
  "vram_peak_bytes", "power_avg_w", "power_peak_w", "power_domain",
  "energy_per_unit_j", "efficiency", "telemetry_coverage_pct",
  "throttle_thermal", "throttle_power", "temperature_peak_c",
  "alias", "system_name", "system_key", "cooling", "tuning", "notes",
  "manifest_json", "findings_json",
] as const satisfies readonly (keyof ResultRow)[];
