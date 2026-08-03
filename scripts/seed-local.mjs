#!/usr/bin/env node
/**
 * Generate demonstration results for a LOCAL database.
 *
 * This exists so the site can be developed and reviewed with realistic content before real
 * contributors exist. It writes directly into the `results` table, bypassing submission,
 * signing and validation — which is exactly why it must never point at production.
 *
 * The numbers are not random. They are derived from each GPU's published memory bandwidth
 * and the model's weight size, because decode throughput on a single stream is
 * bandwidth-bound: tok/s ≈ bandwidth / bytes-per-forward-pass. Prefill is scaled by a
 * compute proxy instead. That way the demo data shows the same relationships the real data
 * will, including DGX Spark's characteristic profile — huge capacity, modest decode.
 *
 *   node scripts/seed-local.mjs            # write SQL to stdout
 *   npm run seed:local                     # apply it to the local D1
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hardware = JSON.parse(readFileSync(join(ROOT, "benchmarks", "hardware.json"), "utf8"));

const PROFILES = ["llm-entry-base", "llm-entry-int4", "llm-enthusiast-base", "llm-enthusiast-int4",
  "llm-frontier-base", "vision-entry-base", "vision-enthusiast-base",
  "diffusion-entry-base", "diffusion-enthusiast-base"];

const profiles = Object.fromEntries(
  PROFILES.map((id) => {
    const raw = JSON.parse(readFileSync(join(ROOT, "benchmarks", "profiles", `${id}.json`), "utf8"));
    delete raw.$schema;
    return [id, raw];
  }),
);

// Deterministic PRNG so re-seeding produces the same database.
let seed = 0x5eed1234;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
const jitter = (spread) => 1 + (rand() - 0.5) * 2 * spread;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

/** Relative single-precision compute, normalised to an RTX 4090 = 1.0. */
const COMPUTE_INDEX = {
  "rtx-3060-12gb": 0.16, "rtx-4060-ti-16gb": 0.25, "rtx-4070": 0.35, "rtx-4080-super": 0.62,
  "rtx-5070": 0.44, "rtx-5070-ti": 0.62, "rtx-5080": 0.72,
  "rtx-3090": 0.42, "rtx-3090-ti": 0.50, "rtx-4090": 1.0, "rtx-5090": 1.45,
  "rtx-a6000": 0.36, "rtx-6000-ada": 0.85, "l40s": 0.68,
  "rtx-pro-6000-blackwell": 1.55, "dgx-spark-gb10": 0.34,
};

const CPUS = [
  ["AMD Ryzen 9 7950X", 16, 32, "x86_64"],
  ["AMD Ryzen 7 7800X3D", 8, 16, "x86_64"],
  ["Intel Core i9-14900K", 24, 32, "x86_64"],
  ["Intel Core i7-13700K", 16, 24, "x86_64"],
  ["AMD Ryzen Threadripper PRO 7975WX", 32, 64, "x86_64"],
  ["NVIDIA GB10 20-core Arm", 20, 20, "aarch64"],
];
const OSES = [
  ["Ubuntu 24.04.1 LTS", "6.8.0-51-generic"],
  ["Ubuntu 22.04.5 LTS", "6.5.0-45-generic"],
  ["Fedora Linux 41", "6.12.7-200.fc41.x86_64"],
  ["Debian GNU/Linux 12", "6.1.0-28-amd64"],
];
const ALIASES = ["voidwalker", "tensorcore", "quietbuild", "npc_lab", "hexbench", "sparkplug",
  "cold_plate", "atlas", "delta_v", "rack9", "silentfan", "molten"];

const GB = 1024 ** 3;

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const sha256 = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(ms) {
  let t = ms, time = "";
  for (let i = 9; i >= 0; i--) { time = ULID_ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  let r = "";
  for (let i = 0; i < 16; i++) r += ULID_ALPHABET[Math.floor(rand() * 32)];
  return time + r;
}

function b64(n) {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < n; i++) s += chars[Math.floor(rand() * 64)];
  return s;
}

/** Which GPU configurations qualify for a profile, including multi-GPU. */
function configurationsFor(profile) {
  const out = [];
  for (const gpu of hardware.gpus) {
    for (const count of profile.requirements.gpu_count ?? [1]) {
      if (gpu.vram_bytes * count < profile.requirements.min_vram_bytes) continue;
      if (!profile.requirements.architectures.includes(gpu.architecture)) continue;
      if (profile.lane === "nvfp4" && !gpu.supports_nvfp4) continue;
      if (count > 1 && gpu.memory_type === "unified") continue; // Spark is one device
      out.push({ gpu, count });
    }
  }
  return out;
}

function measure(profile, gpu, count) {
  const weightsGB = profile.model.weights_bytes / GB;
  const bandwidth = gpu.memory_bandwidth_gb_s;
  const compute = COMPUTE_INDEX[gpu.key] ?? 0.5;

  if (profile.category === "diffusion") {
    // Diffusion is compute-bound, not bandwidth-bound: this is the counterweight to the
    // LLM profiles, and it is why an RTX 5090 beats a DGX Spark by a wide margin here.
    const stepsPerSecond = compute * (profile.model.parameters_b < 5 ? 7.5 : 3.2) * jitter(0.09);
    const secondsPerStep = 1 / stepsPerSecond;
    const steps = profile.workloads[0].config.steps;
    const perImage = secondsPerStep * steps * jitter(0.03);
    return {
      headline_metric: "seconds_per_step_s",
      headline_value: round(secondsPerStep, 4),
      headline_unit: "s/step",
      images_per_minute: round(60 / perImage, 2),
      e2e_p50_ms: round(perImage * 1000, 0),
      decode_tok_s: null, prefill_tok_s: null, peak_tok_s: null,
      ttft_p50_ms: null, ttft_p95_ms: null, itl_p95_ms: null,
      seconds_per_step_s: round(secondsPerStep, 4),
      quality_gate_pct: null, longcontext_pass: null,
      model_load_s: round(weightsGB * (gpu.memory_type === "unified" ? 0.9 : 1.6) * jitter(0.2), 1),
    };
  }

  // Single-stream decode is bandwidth-bound: one full pass over the weights per token.
  // Multi-GPU tensor parallelism adds sync cost, so it scales well below linearly.
  const tpEfficiency = count > 1 ? 0.72 : 1;
  const decode = (bandwidth / weightsGB) * 0.68 * tpEfficiency * jitter(0.06);
  // Prefill is compute-bound and batches thousands of tokens at once.
  const prefill = compute * 9000 * (4 / Math.max(4, profile.model.parameters_b)) ** 0.7 * jitter(0.1);

  const inputTokens = profile.category === "vision" ? 1400 : 1024;
  const ttft = (inputTokens / prefill) * 1000 + 42 * jitter(0.3);
  const itl = 1000 / decode;

  if (profile.category === "vision") {
    const outputTokens = 128;
    const e2e = ttft + outputTokens * itl;
    const perImage = e2e / 1000 / 2; // concurrency 2
    return {
      headline_metric: "throughput_img_min",
      headline_value: round(60 / perImage, 2),
      headline_unit: "img/min",
      images_per_minute: round(60 / perImage, 2),
      decode_tok_s: round(decode, 2), prefill_tok_s: round(prefill, 0), peak_tok_s: null,
      ttft_p50_ms: round(ttft, 1), ttft_p95_ms: round(ttft * 1.28, 1), itl_p95_ms: round(itl * 1.3, 2),
      e2e_p50_ms: round(e2e, 0), seconds_per_step_s: null,
      quality_gate_pct: round(90 + rand() * 9.5, 1),
      longcontext_pass: null,
      model_load_s: round(weightsGB * (gpu.memory_type === "unified" ? 0.9 : 1.6) * jitter(0.2), 1),
    };
  }

  return {
    headline_metric: "decode_throughput_tok_s",
    headline_value: round(decode, 2),
    headline_unit: "tok/s",
    decode_tok_s: round(decode, 2),
    prefill_tok_s: round(prefill, 0),
    peak_tok_s: round(decode * (3.1 + rand() * 1.4) * tpEfficiency, 1),
    ttft_p50_ms: round(ttft, 1),
    ttft_p95_ms: round(ttft * (1.15 + rand() * 0.3), 1),
    itl_p95_ms: round(itl * (1.1 + rand() * 0.25), 2),
    e2e_p50_ms: round(ttft + 256 * itl, 0),
    seconds_per_step_s: null, images_per_minute: null, quality_gate_pct: null,
    longcontext_pass: gpu.vram_bytes * 1 >= profile.requirements.min_vram_bytes * 1.15 ? 1 : 0,
    model_load_s: round(weightsGB * (gpu.memory_type === "unified" ? 0.9 : 1.6) * jitter(0.2), 1),
  };
}

const round = (v, d) => Number(v.toFixed(d));

function buildRow(profile, gpu, count, index, whenMs) {
  const m = measure(profile, gpu, count);
  const runId = ulid(whenMs);
  const [cpuModel, cores, threads, arch] =
    gpu.cpu_arch === "aarch64" ? CPUS[5] : pick(CPUS.slice(0, 5));
  const [os, kernel] = gpu.cpu_arch === "aarch64" ? ["Ubuntu 24.04.1 LTS (DGX OS)", "6.11.0-1004-nvidia"] : pick(OSES);
  const platform = arch === "aarch64" ? "linux/arm64" : "linux/amd64";

  // Board power scales with load; SoC power on a unified system is a different quantity.
  const utilisation = 0.62 + rand() * 0.3;
  const powerAvg = round(gpu.default_power_limit_w * utilisation, 1);
  const powerDomain = gpu.memory_type === "unified" ? "soc_module" : "gpu_board";
  const vramPeak = Math.round(
    Math.min(gpu.vram_bytes * count * 0.94, profile.model.weights_bytes * 1.22 + 1.6 * GB),
  );

  const durationS = round(profile.requirements.expected_runtime_minutes * 60 * jitter(0.15), 0);
  const energyJ = round(powerAvg * durationS, 0);
  const tuning = rand() < 0.16 ? pick(["undervolted", "overclocked", "power-limited"]) : "stock";
  const cooling = gpu.memory_type === "unified" ? "passive" : pick(["air", "air", "aio", "blower", "custom-loop"]);

  const profileHash = sha256(canonical(profile));
  const createdAt = new Date(whenMs).toISOString();

  const manifest = {
    schema_version: "1.0.0",
    run_id: runId,
    created_at: createdAt,
    duration_s: durationS,
    profile: {
      id: profile.id, version: profile.version, category: profile.category,
      tier: profile.tier, lane: profile.lane, hash: profileHash, frozen: profile.frozen,
    },
    model: {
      repository: profile.model.repository,
      revision: createHash("sha1").update(profile.id).digest("hex"),
      precision: profile.model.precision,
      parameters_b: profile.model.parameters_b,
      weights_bytes: profile.model.weights_bytes,
      license: profile.model.license,
    },
    container: {
      image: `ghcr.io/pavel4ai/localmax-${profile.category}`,
      digest: sha256(`image:${profile.category}:${platform}`),
      runner_version: "0.1.0",
      platform,
      official: true,
    },
    runtime: {
      name: profile.runtime.name,
      version: profile.runtime.name === "vllm" ? "0.8.5" : "0.32.1",
      harness: profile.runtime.harness,
      harness_version: "0.4.2",
      flags: { ...profile.runtime.flags, "tensor-parallel-size": count },
    },
    hardware: {
      gpus: Array.from({ length: count }, () => ({
        name: gpu.name,
        vram_bytes: gpu.vram_bytes,
        architecture: gpu.architecture,
        compute_capability: gpu.compute_capability,
        memory_bandwidth_gb_s: gpu.memory_bandwidth_gb_s,
        power_limit_w: gpu.default_power_limit_w,
        power_default_limit_w: gpu.default_power_limit_w,
        pcie_gen: gpu.memory_type === "unified" ? undefined : 4 + (rand() > 0.5 ? 1 : 0),
        pcie_width: gpu.memory_type === "unified" ? undefined : 16,
        supports_fp8: gpu.supports_fp8,
        supports_nvfp4: gpu.supports_nvfp4,
      })),
      gpu_count: count,
      parallelism: count > 1 ? `tp${count}` : "none",
      interconnect: count > 1 ? "pcie" : gpu.memory_type === "unified" ? "unified" : "none",
      cpu: { model: cpuModel, cores, threads, arch },
      system_ram_bytes: gpu.memory_type === "unified" ? 128 * GB : pick([32, 64, 96, 128]) * GB,
      memory_type: gpu.memory_type,
      cooling,
      tuning,
    },
    software: {
      os, kernel, arch,
      driver: pick(["570.124.06", "570.86.15", "565.57.01"]),
      cuda: pick(["12.8", "12.6"]),
      container_runtime: "docker 27.4.1",
      virtualization: "none",
    },
    workloads: buildWorkloads(profile, m),
    headline: {
      metric: m.headline_metric,
      value: m.headline_value,
      unit: m.headline_unit,
    },
    telemetry: {
      power_domain: powerDomain,
      coverage_pct: round(99.1 + rand() * 0.85, 2),
      sample_interval_ms: profile.validation.telemetry_interval_ms,
      samples: Math.round((durationS * 1000) / profile.validation.telemetry_interval_ms),
      power_avg_w: powerAvg,
      power_peak_w: round(Math.min(gpu.default_power_limit_w * 1.02, powerAvg * 1.22), 1),
      energy_j: energyJ,
      vram_peak_bytes: vramPeak,
      system_ram_peak_bytes: Math.round(8 * GB * jitter(0.3)),
      gpu_util_avg_pct: round(utilisation * 100, 1),
      temperature_peak_c: round(cooling === "custom-loop" ? 58 + rand() * 8 : 66 + rand() * 18, 1),
      throttle_events: {
        thermal_count: cooling === "blower" && rand() > 0.5 ? Math.floor(rand() * 40) : 0,
        power_count: tuning === "overclocked" ? Math.floor(rand() * 120) : Math.floor(rand() * 12),
        reliability_count: 0,
      },
    },
    artifacts: [
      artifact("records.ndjson", "raw_records", "application/x-ndjson", 180_000 + Math.floor(rand() * 90_000), runId),
      artifact("telemetry.ndjson", "telemetry", "application/x-ndjson", 240_000 + Math.floor(rand() * 120_000), runId),
      artifact("system.json", "system_report", "application/json", 9_000 + Math.floor(rand() * 3_000), runId),
      artifact("runtime.log.gz", "runtime_log", "application/gzip", 40_000 + Math.floor(rand() * 30_000), runId),
    ],
    submitter: {
      alias: rand() > 0.35 ? pick(ALIASES) : undefined,
      system_key: b64(43) + "=",
    },
    signature: { algorithm: "ed25519", value: b64(86) + "==", canonicalization: "jcs-rfc8785" },
  };

  const higher = profile.ranking.direction === "higher_is_better";
  const work = higher ? m.headline_value : 1 / m.headline_value;
  const efficiency = round(work / powerAvg, 5);

  // A small share of results land as Community or unranked, which is what the real
  // distribution looks like and keeps those states visible in the UI.
  const roll = rand();
  const verification = roll > 0.93 ? "community" : roll > 0.90 ? "flagged" : "verified";
  const ranked = verification === "verified" ? 1 : 0;

  return {
    run_id: runId,
    created_at: createdAt,
    accepted_at: new Date(whenMs + 90_000).toISOString(),
    verification,
    ranked,
    profile_id: profile.id,
    profile_version: profile.version,
    category: profile.category,
    tier: profile.tier,
    lane: profile.lane,
    gpu_key: gpu.key,
    gpu_name: gpu.name,
    gpu_count: count,
    gpu_architecture: gpu.architecture,
    vram_bytes: gpu.vram_bytes,
    parallelism: count > 1 ? `tp${count}` : "none",
    interconnect: manifest.hardware.interconnect,
    memory_type: gpu.memory_type,
    cpu_model: cpuModel,
    cpu_arch: arch,
    system_ram_bytes: manifest.hardware.system_ram_bytes,
    os,
    driver: manifest.software.driver,
    cuda: manifest.software.cuda,
    virtualization: "none",
    runtime: manifest.runtime.name,
    runtime_version: manifest.runtime.version,
    model_repository: profile.model.repository,
    model_revision: manifest.model.revision,
    model_precision: profile.model.precision,
    container_digest: manifest.container.digest,
    container_official: 1,
    runner_version: "0.1.0",
    headline_metric: m.headline_metric,
    headline_value: m.headline_value,
    headline_unit: m.headline_unit,
    headline_direction: profile.ranking.direction,
    decode_tok_s: m.decode_tok_s,
    prefill_tok_s: m.prefill_tok_s,
    peak_tok_s: m.peak_tok_s,
    ttft_p50_ms: m.ttft_p50_ms,
    ttft_p95_ms: m.ttft_p95_ms,
    itl_p95_ms: m.itl_p95_ms,
    e2e_p50_ms: m.e2e_p50_ms,
    seconds_per_step_s: m.seconds_per_step_s,
    images_per_minute: m.images_per_minute,
    quality_gate_pct: m.quality_gate_pct,
    longcontext_pass: m.longcontext_pass,
    model_load_s: m.model_load_s,
    vram_peak_bytes: vramPeak,
    power_avg_w: powerAvg,
    power_peak_w: manifest.telemetry.power_peak_w,
    power_domain: powerDomain,
    energy_per_unit_j: round(energyJ / 100000, 5),
    // Energy across power domains is not comparable, so a unified-memory system carries no
    // efficiency figure at all rather than a misleading one.
    efficiency: powerDomain === "gpu_board" ? efficiency : null,
    telemetry_coverage_pct: manifest.telemetry.coverage_pct,
    throttle_thermal: manifest.telemetry.throttle_events.thermal_count,
    throttle_power: manifest.telemetry.throttle_events.power_count,
    temperature_peak_c: manifest.telemetry.temperature_peak_c,
    alias: manifest.submitter.alias ?? null,
    system_name: null,
    system_key: manifest.submitter.system_key,
    cooling,
    tuning,
    notes: null,
    manifest_json: JSON.stringify(manifest),
    findings_json: JSON.stringify(
      verification === "flagged"
        ? [{ code: "implausible_value", severity: "warning", message: "Peak VRAM is higher than the registry specification for this GPU. Flagged for review; the submitted value is unchanged.", field: "vram_peak_bytes" }]
        : verification === "community"
          ? [{ code: "telemetry_coverage_low", severity: "warning", message: "Telemetry covered 96.4% of the run; 99% is required for Verified." }]
          : [],
    ),
    archived_at: rand() > 0.25 ? new Date(whenMs + 3_600_000).toISOString() : null,
  };
}

function artifact(name, kind, mediaType, size, salt) {
  return { name, kind, hash: sha256(`${salt}:${name}`), size_bytes: size, media_type: mediaType, required: true };
}

function buildWorkloads(profile, m) {
  return profile.workloads.map((w) => {
    const metrics = {};
    if (w.kind === "diffusion_t2i") {
      metrics.seconds_per_step_s = m.seconds_per_step_s;
      metrics.throughput_img_min = m.images_per_minute;
      metrics.generation_p50_s = round(m.e2e_p50_ms / 1000, 3);
      metrics.generation_p95_s = round((m.e2e_p50_ms / 1000) * 1.09, 3);
      metrics.energy_per_image_j = round(rand() * 400 + 300, 1);
      metrics.model_load_s = m.model_load_s;
      metrics.error_ratio = 0;
      metrics.offload_ratio = 0;
    } else if (w.kind === "vision_task") {
      metrics.throughput_img_min = m.images_per_minute;
      metrics.ttft_p50_ms = m.ttft_p50_ms;
      metrics.ttft_p95_ms = m.ttft_p95_ms;
      metrics.e2e_latency_p50_ms = m.e2e_p50_ms;
      metrics.decode_throughput_tok_s = m.decode_tok_s;
      metrics.image_prefill_p50_ms = round(m.ttft_p50_ms * 0.55, 1);
      metrics.energy_per_image_j = round(rand() * 30 + 12, 2);
      metrics.quality_gate_pct = m.quality_gate_pct;
      metrics.error_ratio = 0;
    } else {
      metrics.decode_throughput_tok_s = m.decode_tok_s;
      metrics.prefill_throughput_tok_s = m.prefill_tok_s;
      metrics.ttft_p50_ms = m.ttft_p50_ms;
      metrics.ttft_p95_ms = m.ttft_p95_ms;
      metrics.itl_p50_ms = round(1000 / m.decode_tok_s, 3);
      metrics.itl_p95_ms = m.itl_p95_ms;
      metrics.e2e_latency_p50_ms = m.e2e_p50_ms;
      metrics.energy_per_output_token_j = round(rand() * 1.2 + 0.3, 4);
      metrics.model_load_s = m.model_load_s;
      metrics.error_ratio = 0;
      if (w.kind === "llm_concurrency") metrics.peak_output_throughput_tok_s = m.peak_tok_s;
    }
    const failed = w.kind === "llm_longcontext" && m.longcontext_pass === 0;
    return {
      id: w.id,
      kind: w.kind,
      status: failed ? "oom" : "passed",
      config: w.config,
      requests: w.measured_requests,
      errors: 0,
      metrics,
      ...(failed ? { failure_reason: "CUDA out of memory allocating the KV cache at 8192 input tokens." } : {}),
    };
  });
}

// --- build the dataset -----------------------------------------------------

const rows = [];
const now = Date.now();

for (const profile of Object.values(profiles)) {
  const configs = configurationsFor(profile);
  for (const { gpu, count } of configs) {
    // Between one and four independent systems per configuration, so distributions and
    // percentiles have something to say.
    const systems = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < systems; i++) {
      const when = now - Math.floor(rand() * 42 * 86_400_000);
      rows.push(buildRow(profile, gpu, count, i, when));
    }
  }
}

rows.sort((a, b) => a.accepted_at.localeCompare(b.accepted_at));

const COLUMNS = Object.keys(rows[0]);
const sqlEscape = (v) =>
  v === null || v === undefined ? "NULL"
  : typeof v === "number" ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

const statements = [
  "DELETE FROM results;",
  "DELETE FROM result_artifacts;",
  "DELETE FROM profile_stats;",
];

for (const row of rows) {
  statements.push(
    `INSERT INTO results (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => sqlEscape(row[c])).join(", ")});`,
  );
  for (const a of JSON.parse(row.manifest_json).artifacts) {
    statements.push(
      `INSERT INTO result_artifacts (run_id, hash, name, kind) VALUES ('${row.run_id}', '${a.hash}', '${a.name}', '${a.kind}');`,
    );
  }
}

process.stdout.write(statements.join("\n") + "\n");
process.stderr.write(
  `seeded ${rows.length} results across ${Object.keys(profiles).length} profiles ` +
    `and ${new Set(rows.map((r) => r.gpu_key)).size} GPUs\n`,
);
