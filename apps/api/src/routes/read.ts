import { Hono } from "hono";
import type { Env } from "../env";
import { GPUS, GPU_BY_KEY, PROFILES, TIERS } from "../generated/registry";
import { cached, fail, intParam } from "../lib/http";
import { isUlid } from "../lib/ulid";

const app = new Hono<{ Bindings: Env }>();

/** Every column a list view needs. Deliberately excludes manifest_json. */
const LIST_COLUMNS = `
  run_id, created_at, accepted_at, verification, ranked,
  profile_id, profile_version, category, tier, lane,
  gpu_key, gpu_name, gpu_count, gpu_architecture, vram_bytes, parallelism, interconnect, memory_type,
  cpu_model, cpu_arch, system_ram_bytes, os, driver, cuda, virtualization,
  runtime, runtime_version, model_repository, model_precision,
  headline_metric, headline_value, headline_unit, headline_direction,
  decode_tok_s, prefill_tok_s, peak_tok_s, ttft_p50_ms, ttft_p95_ms, itl_p95_ms, e2e_p50_ms,
  seconds_per_step_s, images_per_minute, quality_gate_pct, longcontext_pass, model_load_s,
  vram_peak_bytes, power_avg_w, power_peak_w, power_domain, energy_per_unit_j, efficiency,
  telemetry_coverage_pct, throttle_thermal, throttle_power, temperature_peak_c,
  system_name, system_code, cooling, tuning
`;

const SORTABLE: Record<string, string> = {
  headline: "headline_value",
  recent: "accepted_at",
  ttft: "ttft_p50_ms",
  decode: "decode_tok_s",
  prefill: "prefill_tok_s",
  efficiency: "efficiency",
  power: "power_avg_w",
  vram: "vram_peak_bytes",
};

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

app.get("/profiles", async (c) =>
  cached(c, 300, async () => {
    const counts = await c.env.DB.prepare(
      `SELECT profile_id,
              COUNT(*) AS total,
              SUM(ranked) AS ranked,
              COUNT(DISTINCT gpu_key) AS gpus,
              COUNT(DISTINCT system_key) AS systems
         FROM results GROUP BY profile_id`,
    ).all<{ profile_id: string; total: number; ranked: number; gpus: number; systems: number }>();

    const byId = new Map(counts.results.map((r) => [r.profile_id, r]));

    return {
      tiers: TIERS,
      profiles: Object.values(PROFILES).map((p) => {
        const stat = byId.get(p.id);
        return {
          id: p.id,
          display_name: p.display_name,
          summary: p.summary ?? null,
          category: p.category,
          tier: p.tier,
          lane: p.lane,
          version: p.version,
          frozen: p.frozen,
          hash: p.hash,
          model: {
            repository: p.model.repository,
            precision: p.model.precision,
            parameters_b: p.model.parameters_b,
            license: p.model.license ?? null,
          },
          runtime: { name: p.runtime.name, version: p.runtime.version },
          ranking: p.ranking,
          requirements: p.requirements,
          notes: p.notes ?? [],
          result_count: stat?.total ?? 0,
          ranked_count: stat?.ranked ?? 0,
          gpu_count: stat?.gpus ?? 0,
          system_count: stat?.systems ?? 0,
          // A leaderboard stays hidden until two independent systems have verified results;
          // a table with one row is not a comparison.
          published: (stat?.systems ?? 0) >= 2,
        };
      }),
    };
  }),
);

app.get("/profiles/:id", async (c) => {
  const profile = PROFILES[c.req.param("id")];
  if (!profile) return fail(c, "not_found", "Unknown profile.");
  return cached(c, 300, async () => profile);
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

app.get("/leaderboard/:id", async (c) => {
  const profile = PROFILES[c.req.param("id")];
  if (!profile) return fail(c, "not_found", "Unknown profile.");

  const gpuKey = c.req.query("gpu");
  const gpuCount = c.req.query("gpu_count");
  const limit = intParam(c.req.query("limit"), 50, 1, 200);
  const offset = intParam(c.req.query("offset"), 0, 0, 10000);
  const dir = profile.ranking.direction === "higher_is_better" ? "DESC" : "ASC";

  return cached(c, 60, async () => {
    const where = ["profile_id = ?1", "ranked = 1"];
    const binds: unknown[] = [profile.id];
    if (gpuKey) {
      where.push(`gpu_key = ?${binds.length + 1}`);
      binds.push(gpuKey);
    }
    if (gpuCount) {
      where.push(`gpu_count = ?${binds.length + 1}`);
      binds.push(Number(gpuCount));
    }
    const clause = where.join(" AND ");

    const [rows, agg, byGpu] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${LIST_COLUMNS} FROM results WHERE ${clause}
          ORDER BY headline_value ${dir} LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
      ).bind(...binds, limit, offset).all(),

      c.env.DB.prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT gpu_key) AS gpus,
                COUNT(DISTINCT system_key) AS systems,
                MIN(headline_value) AS min_value, MAX(headline_value) AS max_value,
                AVG(headline_value) AS mean_value
           FROM results WHERE ${clause}`,
      ).bind(...binds).first(),

      // Distribution per GPU model: the shape that turns a table into a comparison.
      // Ordered by the same aggregate the caller will plot — the best value for the
      // profile's direction — so bar length and row order can never disagree.
      c.env.DB.prepare(
        `SELECT gpu_key, gpu_name, gpu_count, COUNT(*) AS samples,
                MIN(headline_value) AS min_value, MAX(headline_value) AS max_value,
                AVG(headline_value) AS mean_value,
                ${dir === "DESC" ? "MAX" : "MIN"}(headline_value) AS best_value
           FROM results WHERE profile_id = ?1 AND ranked = 1
          GROUP BY gpu_key, gpu_count
          ORDER BY best_value ${dir}`,
      ).bind(profile.id).all(),
    ]);

    return {
      profile: {
        id: profile.id,
        display_name: profile.display_name,
        summary: profile.summary ?? null,
        category: profile.category,
        tier: profile.tier,
        lane: profile.lane,
        version: profile.version,
        ranking: profile.ranking,
        notes: profile.notes ?? [],
      },
      summary: agg,
      results: rows.results,
      by_gpu: byGpu.results,
      limit,
      offset,
    };
  });
});

// ---------------------------------------------------------------------------
// Results list, with URL-backed filters
// ---------------------------------------------------------------------------

app.get("/results", async (c) => {
  const limit = intParam(c.req.query("limit"), 50, 1, 200);
  const offset = intParam(c.req.query("offset"), 0, 0, 20000);
  const sortKey = SORTABLE[c.req.query("sort") ?? "recent"] ?? "accepted_at";
  const order = (c.req.query("order") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const filters: Array<[string, string, unknown]> = [];
  const add = (param: string, column: string, transform?: (v: string) => unknown) => {
    const value = c.req.query(param);
    if (value) filters.push([column, "=", transform ? transform(value) : value]);
  };
  add("profile", "profile_id");
  add("category", "category");
  add("tier", "tier");
  add("lane", "lane");
  add("gpu", "gpu_key");
  add("verification", "verification");
  add("runtime", "runtime");
  add("parallelism", "parallelism");
  add("cooling", "cooling");
  add("tuning", "tuning");
  add("arch", "gpu_architecture");
  add("system", "system_code");
  add("gpu_count", "gpu_count", Number);
  if (c.req.query("ranked") === "1") filters.push(["ranked", "=", 1]);

  return cached(c, 30, async () => {
    const binds: unknown[] = filters.map(([, , value]) => value);
    const where = filters.map(([col, op], i) => `${col} ${op} ?${i + 1}`);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${LIST_COLUMNS} FROM results ${clause}
          ORDER BY ${sortKey} ${order} NULLS LAST LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
      ).bind(...binds, limit, offset).all(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM results ${clause}`).bind(...binds).first<{ n: number }>(),
    ]);

    return { results: rows.results, total: total?.n ?? 0, limit, offset };
  });
});

// ---------------------------------------------------------------------------
// One result
// ---------------------------------------------------------------------------

app.get("/results/:runId", async (c) => {
  const runId = c.req.param("runId");
  if (!isUlid(runId)) return fail(c, "bad_request", "Malformed run id.");

  return cached(c, 120, async () => {
    const row = await c.env.DB.prepare(`SELECT * FROM results WHERE run_id = ?1`)
      .bind(runId)
      .first<Record<string, unknown>>();
    if (!row) return null;

    const profile = PROFILES[row.profile_id as string];
    const dir = (row.headline_direction as string) === "higher_is_better";
    const value = row.headline_value as number;

    // Where this result sits among ranked results for the same profile, both across all
    // hardware and within its own GPU model. The second number is the interesting one.
    const [overall, sameGpu] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN headline_value ${dir ? "<" : ">"} ?2 THEN 1 ELSE 0 END) AS below
           FROM results WHERE profile_id = ?1 AND ranked = 1`,
      ).bind(row.profile_id, value).first<{ total: number; below: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN headline_value ${dir ? "<" : ">"} ?3 THEN 1 ELSE 0 END) AS below,
                AVG(headline_value) AS mean_value,
                MIN(headline_value) AS min_value,
                MAX(headline_value) AS max_value
           FROM results
          WHERE profile_id = ?1 AND gpu_key = ?2 AND ranked = 1`,
      ).bind(row.profile_id, row.gpu_key, value).first<{
        total: number; below: number; mean_value: number; min_value: number; max_value: number;
      }>(),
    ]);

    const pct = (s: { total: number; below: number } | null) =>
      s && s.total > 1 ? Math.round((s.below / (s.total - 1)) * 100) : null;

    return {
      result: row,
      manifest: JSON.parse((row.manifest_json as string) || "{}"),
      findings: JSON.parse((row.findings_json as string) || "[]"),
      profile: profile ?? null,
      gpu_spec: GPU_BY_KEY[row.gpu_key as string] ?? null,
      context: {
        percentile_overall: pct(overall),
        percentile_same_gpu: pct(sameGpu),
        same_gpu_samples: sameGpu?.total ?? 0,
        same_gpu_mean: sameGpu?.mean_value ?? null,
        same_gpu_min: sameGpu?.min_value ?? null,
        same_gpu_max: sameGpu?.max_value ?? null,
        profile_samples: overall?.total ?? 0,
      },
    };
  });
});

/** Every ranked value for one profile+GPU, for the distribution strip on a result page. */
app.get("/distribution/:profileId", async (c) => {
  const profile = PROFILES[c.req.param("profileId")];
  if (!profile) return fail(c, "not_found", "Unknown profile.");
  const gpuKey = c.req.query("gpu");

  return cached(c, 120, async () => {
    const binds: unknown[] = [profile.id];
    let clause = "profile_id = ?1 AND ranked = 1";
    if (gpuKey) {
      clause += " AND gpu_key = ?2";
      binds.push(gpuKey);
    }
    const rows = await c.env.DB.prepare(
      `SELECT run_id, gpu_key, gpu_name, gpu_count, headline_value
         FROM results WHERE ${clause} ORDER BY headline_value ASC LIMIT 2000`,
    ).bind(...binds).all<{ run_id: string; gpu_key: string; headline_value: number }>();
    return { profile_id: profile.id, gpu: gpuKey ?? null, values: rows.results };
  });
});

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

app.get("/hardware", async (c) =>
  cached(c, 300, async () => {
    const counts = await c.env.DB.prepare(
      `SELECT gpu_key, gpu_name, COUNT(*) AS total, SUM(ranked) AS ranked,
              COUNT(DISTINCT system_key) AS systems, COUNT(DISTINCT profile_id) AS profiles,
              MAX(accepted_at) AS latest
         FROM results GROUP BY gpu_key ORDER BY total DESC`,
    ).all<Record<string, unknown>>();

    const seen = new Map(counts.results.map((r) => [r.gpu_key as string, r]));

    return {
      tiers: TIERS,
      gpus: GPUS.map((g) => ({
        ...g,
        result_count: (seen.get(g.key)?.total as number) ?? 0,
        ranked_count: (seen.get(g.key)?.ranked as number) ?? 0,
        system_count: (seen.get(g.key)?.systems as number) ?? 0,
        eligible_tiers: Object.entries(TIERS)
          .filter(([, t]) => g.vram_bytes >= t.min_vram_bytes)
          .map(([key]) => key),
      })),
      // GPUs that appear in results but are not yet in the registry.
      unregistered: counts.results
        .filter((r) => !GPU_BY_KEY[r.gpu_key as string])
        .map((r) => ({ key: r.gpu_key, name: r.gpu_name, result_count: r.total })),
    };
  }),
);

app.get("/hardware/:key", async (c) => {
  const key = c.req.param("key");
  return cached(c, 120, async () => {
    const [byProfile, recent] = await Promise.all([
      c.env.DB.prepare(
        `SELECT profile_id, category, tier, lane, headline_metric, headline_unit, headline_direction,
                COUNT(*) AS samples, SUM(ranked) AS ranked,
                MIN(headline_value) AS min_value, MAX(headline_value) AS max_value,
                AVG(headline_value) AS mean_value,
                AVG(power_avg_w) AS mean_power, AVG(vram_peak_bytes) AS mean_vram
           FROM results WHERE gpu_key = ?1 GROUP BY profile_id, gpu_count`,
      ).bind(key).all(),
      c.env.DB.prepare(
        `SELECT ${LIST_COLUMNS} FROM results WHERE gpu_key = ?1
          ORDER BY accepted_at DESC LIMIT 100`,
      ).bind(key).all(),
    ]);

    if (byProfile.results.length === 0 && !GPU_BY_KEY[key]) return null;

    return {
      gpu: GPU_BY_KEY[key] ?? { key, name: (recent.results[0] as { gpu_name?: string } | undefined)?.gpu_name ?? key },
      by_profile: byProfile.results,
      results: recent.results,
      eligible_tiers: GPU_BY_KEY[key]
        ? Object.entries(TIERS)
            .filter(([, t]) => GPU_BY_KEY[key]!.vram_bytes >= t.min_vram_bytes)
            .map(([k]) => k)
        : [],
    };
  });
});

// ---------------------------------------------------------------------------
// One system's own results
// ---------------------------------------------------------------------------

/**
 * Every result from one system, by its public code.
 *
 * This is how a contributor finds their own work again. The code is printed by the runner
 * and derived from a key held only on their machine, so it is theirs to keep or share; it
 * identifies a machine, never a person.
 */
app.get("/systems/:code", async (c) => {
  const code = c.req.param("code").toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{5}$/.test(code)) {
    return fail(c, "bad_request", "A system code is five characters.");
  }

  return cached(c, 60, async () => {
    const [rows, summary] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${LIST_COLUMNS} FROM results WHERE system_code = ?1
          ORDER BY accepted_at DESC LIMIT 200`,
      ).bind(code).all(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total, SUM(ranked) AS ranked,
                COUNT(DISTINCT profile_id) AS profiles,
                COUNT(DISTINCT gpu_key) AS gpus,
                MIN(created_at) AS first_seen, MAX(accepted_at) AS latest,
                MAX(system_name) AS name
           FROM results WHERE system_code = ?1`,
      ).bind(code).first<{ total: number; name: string | null }>(),
    ]);

    if (!summary || summary.total === 0) return null;
    return { code, name: summary.name, summary, results: rows.results };
  });
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

app.get("/compare", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length < 2 || ids.length > 4) {
    return fail(c, "bad_request", "Provide between two and four run ids.");
  }
  if (!ids.every(isUlid)) return fail(c, "bad_request", "One or more run ids are malformed.");

  return cached(c, 120, async () => {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const rows = await c.env.DB.prepare(
      `SELECT ${LIST_COLUMNS}, manifest_json FROM results WHERE run_id IN (${placeholders})`,
    ).bind(...ids).all<Record<string, unknown>>();

    const profiles = new Set(rows.results.map((r) => `${r.profile_id}@${r.profile_version}`));
    return {
      results: rows.results.map((r) => ({ ...r, manifest: JSON.parse((r.manifest_json as string) || "{}"), manifest_json: undefined })),
      comparable: profiles.size === 1,
      // Comparing across profiles is allowed, but the caller is told plainly that the
      // numbers were produced by different workloads.
      warning:
        profiles.size === 1
          ? null
          : "These results come from different profiles. The workloads, models and precisions differ, so the headline numbers are not comparable.",
    };
  });
});

// ---------------------------------------------------------------------------
// Site statistics
// ---------------------------------------------------------------------------

app.get("/stats", async (c) =>
  cached(c, 120, async () => {
    const [totals, categories, recent] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS results, SUM(ranked) AS ranked,
                COUNT(DISTINCT gpu_key) AS gpus, COUNT(DISTINCT system_key) AS systems,
                COUNT(DISTINCT profile_id) AS profiles
           FROM results`,
      ).first(),
      c.env.DB.prepare(
        `SELECT category, COUNT(*) AS n FROM results GROUP BY category`,
      ).all(),
      c.env.DB.prepare(
        `SELECT ${LIST_COLUMNS} FROM results ORDER BY accepted_at DESC LIMIT 12`,
      ).all(),
    ]);
    return { totals, by_category: categories.results, recent: recent.results };
  }),
);

export default app;
