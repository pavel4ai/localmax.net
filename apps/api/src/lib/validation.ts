import type { Env, Finding } from "../env";
import { GPU_BY_KEY, PROFILES, type Profile } from "../generated/registry";
import { percentile, withinTolerance } from "./stats";
import { evaluateGates, findWorkload, resolveGpuKey, type Manifest } from "./summary";

export { percentile } from "./stats";

/** Digests of container images the project has released and signed. Populated by CI. */
import { OFFICIAL_IMAGE_DIGESTS } from "../generated/images";

export interface ValidationOutcome {
  verification: "verified" | "community" | "flagged" | "rejected";
  ranked: boolean;
  findings: Finding[];
}

function err(code: string, message: string, field?: string): Finding {
  return { code, severity: "error", message, ...(field ? { field } : {}) };
}
function warn(code: string, message: string, field?: string): Finding {
  return { code, severity: "warning", message, ...(field ? { field } : {}) };
}


// ---------------------------------------------------------------------------
// Raw record formats emitted by the runner. One JSON object per line.
// ---------------------------------------------------------------------------

interface LlmRecord {
  workload: string;
  ok: boolean;
  ttft_ms?: number;
  e2e_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface DiffusionRecord {
  workload: string;
  ok: boolean;
  duration_s?: number;
  steps?: number;
}

interface VisionRecord extends LlmRecord {
  task?: string;
  correct?: boolean;
}

type RawRecord = LlmRecord | DiffusionRecord | VisionRecord;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bhf_[A-Za-z0-9]{30,}\b/, "Hugging Face token"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\bcfat_[A-Za-z0-9]{20,}\b/, "Cloudflare API token"],
  [/\/home\/[a-z0-9_-]+\//i, "local home directory path"],
  [/\/Users\/[A-Za-z0-9_-]+\//, "local home directory path"],
];

/**
 * Full validation of a submission that has finished uploading.
 *
 * Runs in the queue consumer, never inline on the request path: it reads every artifact
 * back out of R2 and recomputes the declared metrics from the raw records, which is far too
 * slow to do while a client waits.
 */
export async function validateSubmission(
  env: Env,
  manifest: Manifest,
): Promise<ValidationOutcome> {
  const findings: Finding[] = [];
  const profile: Profile | undefined = PROFILES[manifest.profile.id];

  if (!profile) {
    return {
      verification: "rejected",
      ranked: false,
      findings: [err("profile_unknown", `Profile ${manifest.profile.id} is not published.`)],
    };
  }

  // --- profile integrity ---------------------------------------------------
  if (manifest.profile.hash !== profile.hash) {
    findings.push(
      err(
        "profile_hash_mismatch",
        "The manifest reports a profile hash that does not match the published profile. " +
          "The run used different rules from the ones on record.",
        "profile.hash",
      ),
    );
  }
  if (manifest.profile.version !== profile.version) {
    findings.push(
      warn(
        "profile_version_mismatch",
        `Run used profile version ${manifest.profile.version}; current is ${profile.version}. ` +
          "It is ranked only against its own version.",
        "profile.version",
      ),
    );
  }

  // --- container provenance ------------------------------------------------
  const official = OFFICIAL_IMAGE_DIGESTS.includes(manifest.container.digest);
  if (!official) {
    findings.push(
      warn(
        "unofficial_image",
        "The container digest is not a project-signed release, so the result is Community and unranked.",
        "container.digest",
      ),
    );
  }

  // --- runtime flags must match the pinned set -----------------------------
  const allowed = new Set(profile.runtime.flag_overrides_allowed as string[] | undefined ?? []);
  for (const [flag, expected] of Object.entries(profile.runtime.flags)) {
    const actual = manifest.runtime.flags?.[flag];
    if (allowed.has(flag)) continue;
    if (actual === undefined) {
      findings.push(warn("flag_missing", `Runtime flag ${flag} was not reported.`, `runtime.flags.${flag}`));
    } else if (String(actual) !== String(expected)) {
      findings.push(
        warn(
          "flag_mismatch",
          `Runtime flag ${flag} was ${String(actual)} but the profile pins ${String(expected)}.`,
          `runtime.flags.${flag}`,
        ),
      );
    }
  }

  // --- hardware eligibility ------------------------------------------------
  const gpu = manifest.hardware.gpus[0]!;
  const totalVram = manifest.hardware.gpus.reduce((sum, g) => sum + (g.vram_bytes ?? 0), 0);
  if (totalVram < profile.requirements.min_vram_bytes) {
    findings.push(
      err(
        "vram_below_tier",
        `Total VRAM ${totalVram} is below the ${profile.tier} tier minimum of ${profile.requirements.min_vram_bytes}.`,
        "hardware.gpus",
      ),
    );
  }
  if (!profile.requirements.architectures.includes(gpu.architecture)) {
    findings.push(
      err(
        "architecture_ineligible",
        `${gpu.architecture} cannot run the ${profile.lane} lane.`,
        "hardware.gpus.0.architecture",
      ),
    );
  }
  const allowedCounts = profile.requirements.gpu_count ?? [1];
  if (!allowedCounts.includes(manifest.hardware.gpu_count)) {
    findings.push(
      err(
        "gpu_count_ineligible",
        `This profile accepts ${allowedCounts.join(" or ")} GPU(s); the run used ${manifest.hardware.gpu_count}.`,
        "hardware.gpu_count",
      ),
    );
  }
  if (!profile.requirements.platforms.includes(manifest.container.platform)) {
    findings.push(
      err("platform_ineligible", `Platform ${manifest.container.platform} is not supported by this profile.`),
    );
  }

  // Cross-check the declared GPU against the registry, when we know the part.
  const known = GPU_BY_KEY[resolveGpuKey(gpu.name)];
  if (known) {
    const drift = Math.abs(known.vram_bytes - (gpu.vram_bytes ?? 0)) / known.vram_bytes;
    if (drift > 0.15) {
      findings.push(
        warn(
          "vram_unexpected",
          `Reported VRAM for ${known.name} differs from the registry specification by more than 15%.`,
          "hardware.gpus.0.vram_bytes",
        ),
      );
    }
    if (profile.lane === "nvfp4" && !known.supports_nvfp4) {
      findings.push(err("lane_unsupported", `${known.name} has no NVFP4 hardware.`, "profile.lane"));
    }
  }

  // --- telemetry -----------------------------------------------------------
  if (manifest.telemetry.coverage_pct < profile.validation.min_telemetry_coverage_pct) {
    findings.push(
      warn(
        "telemetry_coverage_low",
        `Telemetry covered ${manifest.telemetry.coverage_pct.toFixed(1)}% of the run; ` +
          `${profile.validation.min_telemetry_coverage_pct}% is required for Verified.`,
        "telemetry.coverage_pct",
      ),
    );
  }
  if (manifest.telemetry.power_domain === "unavailable") {
    findings.push(
      warn(
        "power_unavailable",
        "No power telemetry was available, so this result carries no energy figures.",
        "telemetry.power_domain",
      ),
    );
  }
  if (manifest.telemetry.power_domain === "soc_module") {
    findings.push({
      code: "power_domain_soc",
      severity: "info",
      message:
        "Power is measured at the SoC module, not a discrete GPU board. Energy figures are " +
        "shown but are never ranked against discrete-GPU results.",
      field: "telemetry.power_domain",
    });
  }

  // --- artifacts -----------------------------------------------------------
  const byKind = new Map<string, (typeof manifest.artifacts)[number]>();
  for (const a of manifest.artifacts) byKind.set(a.kind, a);

  for (const requiredKind of profile.validation.required_artifacts) {
    if (!byKind.has(requiredKind)) {
      findings.push(err("artifact_missing", `Required evidence "${requiredKind}" was not submitted.`));
    }
  }

  for (const artifact of manifest.artifacts) {
    const object = await env.EVIDENCE.head(objectKey(artifact.hash));
    if (!object) {
      findings.push(err("artifact_not_stored", `Evidence ${artifact.name} was never uploaded.`, artifact.name));
      continue;
    }
    if (object.size !== artifact.size_bytes) {
      findings.push(
        err(
          "artifact_size_mismatch",
          `Evidence ${artifact.name} is ${object.size} bytes but the manifest declares ${artifact.size_bytes}.`,
          artifact.name,
        ),
      );
    }
  }

  // --- secret scan on text evidence ---------------------------------------
  for (const artifact of manifest.artifacts) {
    if (artifact.media_type !== "text/plain" && artifact.media_type !== "application/json") continue;
    if (artifact.size_bytes > 4 * 1024 * 1024) continue;
    const object = await env.EVIDENCE.get(objectKey(artifact.hash));
    if (!object) continue;
    const text = await object.text();
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        findings.push(
          err(
            "secret_detected",
            `Evidence ${artifact.name} appears to contain a ${label}. The submission is rejected and the object is purged.`,
            artifact.name,
          ),
        );
        break;
      }
    }
  }

  // --- metric recomputation from raw records -------------------------------
  const rawArtifact = byKind.get("raw_records");
  if (rawArtifact) {
    const object = await env.EVIDENCE.get(objectKey(rawArtifact.hash));
    if (object && rawArtifact.media_type === "application/x-ndjson") {
      const records = parseNdjson(await object.text());
      findings.push(...recomputeMetrics(manifest, profile, records));
    }
  }

  // --- plausibility --------------------------------------------------------
  for (const [name, bounds] of Object.entries(profile.validation.plausibility ?? {})) {
    const value =
      name === "vram_peak_bytes" ? manifest.telemetry.vram_peak_bytes
      : name === "power_avg_w" ? manifest.telemetry.power_avg_w
      : findWorkload(manifest, profile.ranking.source_workload)?.metrics?.[name];
    if (typeof value !== "number") continue;
    if (value < bounds.min || value > bounds.max) {
      findings.push(
        warn(
          "implausible_value",
          `${name} = ${value} is outside the expected range ${bounds.min}–${bounds.max}. ` +
            "Flagged for review; the submitted value is unchanged.",
          name,
        ),
      );
    }
  }

  // --- gates ---------------------------------------------------------------
  const gates = evaluateGates(manifest, profile);
  findings.push(...gates.findings);

  // --- verdict -------------------------------------------------------------
  const hasError = findings.some((f) => f.severity === "error");
  const purge = findings.some((f) => f.code === "secret_detected");

  if (purge) {
    for (const artifact of manifest.artifacts) {
      await env.EVIDENCE.delete(objectKey(artifact.hash)).catch(() => {});
    }
    return { verification: "rejected", ranked: false, findings };
  }
  if (hasError) {
    return { verification: "rejected", ranked: false, findings };
  }

  const coverageOk =
    manifest.telemetry.coverage_pct >= profile.validation.min_telemetry_coverage_pct;
  const evidenceComplete = profile.validation.required_artifacts.every((k) => byKind.has(k));
  const recomputeOk = !findings.some((f) => f.code === "metric_mismatch");
  const flagged = findings.some((f) => f.code === "implausible_value");

  const verified =
    official &&
    coverageOk &&
    evidenceComplete &&
    recomputeOk &&
    manifest.profile.hash === profile.hash;

  return {
    verification: flagged ? "flagged" : verified ? "verified" : "community",
    ranked: verified && gates.passed && !flagged,
    findings,
  };
}

export function objectKey(hash: string): string {
  // sha256:abcd... -> ev/ab/cd/abcd...  Two levels of fan-out keeps any single R2 prefix
  // from becoming a hotspot under concurrent writes.
  const hex = hash.replace(/^sha256:/, "");
  return `ev/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

function parseNdjson(text: string): RawRecord[] {
  const out: RawRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawRecord);
    } catch {
      // A malformed line is reported by the caller through the count mismatch below.
    }
  }
  return out;
}

/**
 * Recompute every declared metric that can be derived from the raw per-request records.
 *
 * This is the check that makes a number mean something: a submitter can write any value
 * into `metrics`, but they would also have to fabricate a self-consistent set of raw
 * records for it to survive.
 */
function recomputeMetrics(
  manifest: Manifest,
  profile: Profile,
  records: RawRecord[],
): Finding[] {
  const findings: Finding[] = [];
  const tolerance = profile.validation.metric_recompute_tolerance_pct ?? 1.0;

  for (const workload of manifest.workloads) {
    const mine = records.filter((r) => r.workload === workload.id);
    if (mine.length === 0) {
      findings.push(
        warn("raw_records_missing", `No raw records for workload ${workload.id}.`, workload.id),
      );
      continue;
    }

    const ok = mine.filter((r) => r.ok);
    if (workload.requests !== undefined && workload.requests !== mine.length) {
      findings.push(
        {
          code: "metric_mismatch",
          severity: "warning",
          message: `Workload ${workload.id} declares ${workload.requests} requests but ${mine.length} raw records are present.`,
          field: `${workload.id}.requests`,
        },
      );
    }

    const check = (name: string, recomputed: number | null) => {
      const declared = workload.metrics?.[name];
      if (typeof declared !== "number" || recomputed === null) return;
      if (!withinTolerance(declared, recomputed, tolerance)) {
        findings.push({
          code: "metric_mismatch",
          severity: "warning",
          message:
            `Workload ${workload.id} declares ${name} = ${declared} but the raw records give ` +
            `${recomputed.toFixed(4)} (tolerance ${tolerance}%).`,
          field: `${workload.id}.${name}`,
        });
      }
    };

    if (workload.kind === "diffusion_t2i") {
      const durations = ok
        .map((r) => (r as DiffusionRecord).duration_s)
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);
      const steps = (ok[0] as DiffusionRecord | undefined)?.steps ?? 0;
      const total = durations.reduce((a, b) => a + b, 0);
      const meanDuration = durations.length ? total / durations.length : null;

      check("generation_p50_s", percentile(durations, 50));
      check("generation_p95_s", percentile(durations, 95));
      if (meanDuration !== null && steps > 0) check("seconds_per_step_s", meanDuration / steps);
      if (meanDuration !== null && meanDuration > 0) check("throughput_img_min", 60 / meanDuration);
    } else {
      const ttfts = ok
        .map((r) => (r as LlmRecord).ttft_ms)
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);
      const e2es = ok
        .map((r) => (r as LlmRecord).e2e_ms)
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);

      check("ttft_p50_ms", percentile(ttfts, 50));
      check("ttft_p95_ms", percentile(ttfts, 95));
      check("e2e_latency_p50_ms", percentile(e2es, 50));

      // Decode throughput excludes prefill: output tokens over the generation window only.
      let outTokens = 0;
      let decodeMs = 0;
      let inTokens = 0;
      let prefillMs = 0;
      for (const r of ok as LlmRecord[]) {
        if (typeof r.output_tokens === "number" && typeof r.e2e_ms === "number" && typeof r.ttft_ms === "number") {
          outTokens += r.output_tokens;
          decodeMs += Math.max(0, r.e2e_ms - r.ttft_ms);
        }
        if (typeof r.input_tokens === "number" && typeof r.ttft_ms === "number") {
          inTokens += r.input_tokens;
          prefillMs += r.ttft_ms;
        }
      }
      if (decodeMs > 0) check("decode_throughput_tok_s", (outTokens / decodeMs) * 1000);
      if (prefillMs > 0) check("prefill_throughput_tok_s", (inTokens / prefillMs) * 1000);
      if (outTokens > 0 && decodeMs > 0) {
        const itlMean = decodeMs / outTokens;
        const declaredItl = workload.metrics?.["itl_p50_ms"];
        if (typeof declaredItl === "number" && !withinTolerance(declaredItl, itlMean, tolerance * 4)) {
          findings.push(
            warn(
              "itl_inconsistent",
              `Workload ${workload.id} inter-token latency p50 (${declaredItl}) is far from the mean implied by the raw records (${itlMean.toFixed(3)} ms).`,
              `${workload.id}.itl_p50_ms`,
            ),
          );
        }
      }

      const graded = (ok as VisionRecord[]).filter((r) => typeof r.correct === "boolean");
      if (graded.length > 0) {
        const correct = graded.filter((r) => r.correct).length;
        check("quality_gate_pct", (correct / graded.length) * 100);
      }
    }

    const errors = mine.length - ok.length;
    check("error_ratio", mine.length > 0 ? errors / mine.length : 0);
  }

  return findings;
}

/**
 * Detect a resubmission of an identical run.
 *
 * Keyed on the system key, profile and headline value rather than the run id, because a
 * replayed bundle gets a fresh run id but cannot change what it measured.
 */
export async function findDuplicate(
  env: Env,
  systemKey: string,
  profileId: string,
  headlineValue: number,
  excludeRunId: string,
): Promise<string | null> {
  const epsilon = Math.abs(headlineValue) * 1e-6;
  const row = await env.DB.prepare(
    `SELECT run_id FROM results
      WHERE system_key = ?1 AND profile_id = ?2
        AND headline_value BETWEEN ?3 AND ?4
        AND run_id != ?5
      LIMIT 1`,
  )
    .bind(systemKey, profileId, headlineValue - epsilon, headlineValue + epsilon, excludeRunId)
    .first<{ run_id: string }>();
  return row?.run_id ?? null;
}
