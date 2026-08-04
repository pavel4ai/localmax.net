/**
 * Read side of the API.
 *
 * In production this goes over a service binding: same colo, no DNS, no TLS handshake, no
 * CORS, and the API Worker never has to be reachable from the public internet for the site
 * to render. `astro dev` has no binding, so it falls back to plain fetch against
 * API_ORIGIN.
 */

import { env } from "cloudflare:workers";

const DEFAULT_ORIGIN = "http://127.0.0.1:8787";

export interface Fetcher {
  (path: string, init?: RequestInit): Promise<Response>;
}

interface Bindings {
  API?: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  API_ORIGIN?: string;
}

/**
 * Worker bindings.
 *
 * Astro v6 removed `Astro.locals.runtime.env`; bindings now come from the
 * `cloudflare:workers` module. Reading it defensively matters because a failure here is
 * indistinguishable, from a page's point of view, from an empty database.
 */
function bindings(): Bindings {
  return (env ?? {}) as Bindings;
}

export function apiFetcher(): Fetcher {
  const b = bindings();
  const origin = (b.API_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "");

  // `astro dev` materialises the service binding declared in wrangler.toml with no worker
  // behind it, so in dev we always go over HTTP to a locally running `wrangler dev` API.
  const binding = import.meta.env.DEV ? undefined : b.API;

  return async (path: string, init?: RequestInit) => {
    const url = `${origin}${path}`;
    if (!binding) return fetch(url, init);
    try {
      return await binding.fetch(url, init);
    } catch (error) {
      console.warn(`API service binding failed, falling back to ${origin}`, error);
      return fetch(url, init);
    }
  };
}

/**
 * GET a JSON endpoint. Returns null rather than throwing so a page can degrade to an empty
 * state: a leaderboard with no database is still a readable page, and one failing panel
 * must not take down the route.
 */
export async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetcher()(path);
    if (!res.ok) {
      console.warn(`API ${path} responded ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.warn(`API ${path} failed`, error);
    return null;
  }
}

export function apiOrigin(): string {
  return (bindings().API_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "");
}

// --- shapes the site reads -------------------------------------------------

export interface ResultRow {
  run_id: string;
  created_at: string;
  accepted_at: string;
  verification: "verified" | "community" | "flagged" | "rejected";
  ranked: number;
  profile_id: string;
  profile_version: string;
  category: "llm" | "vision" | "diffusion";
  tier: "entry" | "enthusiast" | "prospector";
  lane: "fp8" | "int4" | "nvfp4" | "bf16";
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
  model_precision: string | null;
  headline_metric: string;
  headline_value: number;
  headline_unit: string;
  headline_direction: "higher_is_better" | "lower_is_better";
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
  power_domain: "gpu_board" | "soc_module" | "unavailable";
  energy_per_unit_j: number | null;
  efficiency: number | null;
  telemetry_coverage_pct: number | null;
  throttle_thermal: number | null;
  throttle_power: number | null;
  temperature_peak_c: number | null;
  system_name: string | null;
  system_code: string | null;
  cooling: string | null;
  tuning: string | null;
}

export interface Ranking {
  metric: string;
  unit: string;
  direction: "higher_is_better" | "lower_is_better";
  source_workload: string;
  secondary?: Array<{ metric: string; label: string; unit: string; direction?: string; source_workload?: string }>;
  gates?: Array<{ metric: string; comparator: string; value: number; reason?: string }>;
}

export interface ProfileSummary {
  id: string;
  display_name: string;
  summary: string | null;
  category: "llm" | "vision" | "diffusion";
  tier: "entry" | "enthusiast" | "prospector";
  lane: "fp8" | "int4" | "nvfp4" | "bf16";
  version: string;
  frozen: boolean;
  hash: string;
  model: { repository: string; precision: string; parameters_b: number; license: string | null };
  runtime: { name: string; version: string };
  ranking: Ranking;
  requirements: Record<string, unknown> & { min_vram_bytes: number; expected_runtime_minutes?: number };
  notes: string[];
  result_count: number;
  ranked_count: number;
  gpu_count: number;
  system_count: number;
  published: boolean;
}

export interface GpuSummary {
  key: string;
  name: string;
  architecture: string;
  vram_bytes: number;
  memory_bandwidth_gb_s: number;
  default_power_limit_w: number;
  supports_fp8: boolean;
  supports_nvfp4: boolean;
  memory_type: "discrete" | "unified";
  class: string;
  notes?: string[];
  result_count: number;
  ranked_count: number;
  system_count: number;
  eligible_tiers: string[];
}

export interface Finding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  field?: string;
}
