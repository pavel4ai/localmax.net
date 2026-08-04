import type { Env, Finding, ValidationMessage } from "./env";
import { PROFILES } from "./generated/registry";
import { buildRow, RESULT_COLUMNS, type Manifest, type ResultRow } from "./lib/summary";
import { deriveSystemLabel } from "./lib/system-name";
import { findDuplicate, validateSubmission } from "./lib/validation";

/**
 * Validation queue consumer.
 *
 * Everything expensive lives here rather than on the request path: reading artifacts back
 * out of R2, recomputing metrics from raw records, scanning for secrets. The submission
 * endpoint returns 202 in milliseconds and this absorbs the load, so a burst of submissions
 * queues instead of timing out. Retries and the dead-letter queue are handled by the
 * platform; a message is only acked once the result row is committed.
 */
export async function handleValidationBatch(
  batch: MessageBatch<ValidationMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(env, message.body.run_id);
      message.ack();
    } catch (error) {
      console.error("validation failed", message.body.run_id, error);
      // Exponential backoff. After max_retries the platform moves it to the DLQ, where a
      // maintainer can inspect it; the submission row stays so the CLI can still report it.
      message.retry({ delaySeconds: Math.min(900, 30 * 2 ** message.attempts) });
    }
  }
}

async function processOne(env: Env, runId: string): Promise<void> {
  const submission = await env.DB.prepare(
    `SELECT manifest_json, state FROM submissions WHERE run_id = ?1`,
  ).bind(runId).first<{ manifest_json: string; state: string }>();

  if (!submission) return; // already processed and cleaned up
  if (submission.state === "accepted" || submission.state === "rejected") return;

  await env.DB.prepare(
    `UPDATE submissions SET state = 'validating', updated_at = ?2 WHERE run_id = ?1`,
  ).bind(runId, new Date().toISOString()).run();

  const manifest = JSON.parse(submission.manifest_json) as Manifest;
  const profile = PROFILES[manifest.profile.id];
  const now = new Date().toISOString();

  if (!profile) {
    await reject(env, runId, [
      { code: "profile_unknown", severity: "error", message: "Profile is no longer published." },
    ]);
    return;
  }

  const outcome = await validateSubmission(env, manifest);
  const findings: Finding[] = [...outcome.findings];

  if (outcome.verification === "rejected") {
    await reject(env, runId, findings);
    return;
  }

  const duplicate = await findDuplicate(
    env,
    manifest.submitter.system_key,
    manifest.profile.id,
    manifest.headline.value,
    runId,
  );
  if (duplicate) {
    findings.push({
      code: "duplicate_run",
      severity: "warning",
      message: `This system already published an identical measurement for this profile (${duplicate}). Published for the record but not ranked.`,
    });
  }

  const label = await deriveSystemLabel(manifest.submitter.system_key);

  const row = buildRow(
    manifest,
    profile,
    outcome.verification,
    outcome.ranked && !duplicate,
    findings,
    now,
    label,
  );

  const columns = RESULT_COLUMNS.join(", ");
  const placeholders = RESULT_COLUMNS.map((_, i) => `?${i + 1}`).join(", ");
  const values = RESULT_COLUMNS.map((k) => (row as unknown as Record<string, unknown>)[k] ?? null);

  const statements = [
    env.DB.prepare(
      `INSERT INTO results (${columns}) VALUES (${placeholders})
       ON CONFLICT(run_id) DO NOTHING`,
    ).bind(...values),
    ...manifest.artifacts.map((a) =>
      env.DB.prepare(
        `INSERT INTO result_artifacts (run_id, hash, name, kind) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(run_id, hash) DO NOTHING`,
      ).bind(runId, a.hash, a.name, a.kind),
    ),
    ...manifest.artifacts.map((a) =>
      env.DB.prepare(`UPDATE artifacts SET refcount = refcount + 1 WHERE hash = ?1`).bind(a.hash),
    ),
    env.DB.prepare(
      `INSERT INTO audit (run_id, at, actor, action, detail)
       VALUES (?1, ?2, 'validator', ?3, ?4)`,
    ).bind(
      runId,
      now,
      `accepted:${outcome.verification}${row.ranked ? ":ranked" : ""}`,
      JSON.stringify(findings.map((f) => f.code)),
    ),
    // The submission row has served its purpose; the result row is now authoritative.
    env.DB.prepare(`DELETE FROM submissions WHERE run_id = ?1`).bind(runId),
  ];

  await env.DB.batch(statements);
  await refreshStats(env, row);
}

async function reject(env: Env, runId: string, findings: Finding[]): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions SET state = 'rejected', findings_json = ?2, updated_at = ?3 WHERE run_id = ?1`,
    ).bind(runId, JSON.stringify(findings), now),
    env.DB.prepare(
      `INSERT INTO audit (run_id, at, actor, action, detail) VALUES (?1, ?2, 'validator', 'rejected', ?3)`,
    ).bind(runId, now, JSON.stringify(findings.map((f) => f.code))),
  ]);
}

/**
 * Recompute the cached distribution for the profile and GPU this result belongs to.
 *
 * Only the two affected rows are touched, so this stays O(1) per submission no matter how
 * large the table grows.
 */
async function refreshStats(env: Env, row: ResultRow): Promise<void> {
  if (!row.ranked) return;
  const now = new Date().toISOString();

  const upsert = (gpuKey: string, gpuCount: number) =>
    env.DB.prepare(
      `INSERT INTO profile_stats
         (profile_id, gpu_key, gpu_count, sample_count, best_value, p25_value, mean_value, p75_value, worst_value, updated_at)
       SELECT ?1, ?2, ?3,
              COUNT(*),
              ${row.headline_direction === "higher_is_better" ? "MAX" : "MIN"}(headline_value),
              NULL, AVG(headline_value), NULL,
              ${row.headline_direction === "higher_is_better" ? "MIN" : "MAX"}(headline_value),
              ?4
         FROM results
        WHERE profile_id = ?1 AND ranked = 1
          AND (?2 = '*' OR gpu_key = ?2)
          AND (?2 = '*' OR gpu_count = ?3)
       ON CONFLICT(profile_id, gpu_key, gpu_count) DO UPDATE SET
         sample_count = excluded.sample_count,
         best_value   = excluded.best_value,
         mean_value   = excluded.mean_value,
         worst_value  = excluded.worst_value,
         updated_at   = excluded.updated_at`,
    ).bind(row.profile_id, gpuKey, gpuCount, now);

  await env.DB.batch([upsert("*", 1), upsert(row.gpu_key, row.gpu_count)]);
}
