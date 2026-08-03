import { Hono } from "hono";
import type { Env, Finding } from "../env";
import { PROFILES } from "../generated/registry";
import {
  validateChallengeRequest,
  validateCompleteSubmission,
  validateCreateSubmission,
} from "../generated/validators.mjs";
import { hashIp, randomHex, verifyManifestSignature } from "../lib/crypto";
import { clientIp, fail } from "../lib/http";
import { objectKey } from "../lib/validation";
import type { Manifest } from "../lib/summary";
import { isUlid, ulid } from "../lib/ulid";
import { verifyTurnstile } from "../lib/turnstile";

const app = new Hono<{ Bindings: Env }>();

const CHALLENGE_TTL_S = 900;
const SUBMISSION_TOKEN_TTL_S = 1800;
const UPLOAD_TTL_S = 3600;

interface UploadSlot {
  run_id: string;
  hash: string;
  size_bytes: number;
  media_type: string;
  expires_at: number;
}

function errorDetails(errors: unknown): string[] {
  const list = (errors ?? []) as Array<{ instancePath?: string; message?: string }>;
  return list.slice(0, 20).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

// ---------------------------------------------------------------------------
// 1. Challenge. The CLI opens `verify_url` in a browser, the human solves Turnstile,
//    and the CLI polls until a single-use submission token is available.
// ---------------------------------------------------------------------------

app.post("/challenge", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!validateChallengeRequest(body)) {
    return fail(c, "bad_request", "Invalid challenge request.", errorDetails(validateChallengeRequest.errors));
  }
  const { profile_id } = body as { profile_id: string };
  if (!PROFILES[profile_id]) {
    return fail(c, "profile_unknown", `Unknown profile "${profile_id}".`);
  }

  const ip = clientIp(c);
  const { success } = await c.env.SUBMIT_LIMITER.limit({ key: `challenge:${ip}` });
  if (!success) return fail(c, "rate_limited", "Too many challenge requests.", undefined, 60);

  const challengeId = randomHex(16);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_S * 1000).toISOString();

  await c.env.SESSIONS.put(
    `challenge:${challengeId}`,
    JSON.stringify({ state: "pending", profile_id, created_at: Date.now() }),
    { expirationTtl: CHALLENGE_TTL_S },
  );

  return c.json({
    challenge_id: challengeId,
    verify_url: `${c.env.SITE_ORIGIN}/verify?c=${challengeId}`,
    expires_at: expiresAt,
    poll_after_ms: 2000,
  });
});

/** Polled by the CLI. Returns the submission token once the browser step is complete. */
app.get("/challenge/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{32}$/.test(id)) return fail(c, "bad_request", "Malformed challenge id.");

  const raw = await c.env.SESSIONS.get(`challenge:${id}`);
  if (!raw) return c.json({ state: "expired" });

  const state = JSON.parse(raw) as { state: string; token?: string };
  if (state.state !== "solved") return c.json({ state: "pending" });

  // Single use: hand the token over exactly once.
  await c.env.SESSIONS.delete(`challenge:${id}`);
  return c.json({ state: "solved", submission_token: state.token });
});

/** Called by the browser page after Turnstile succeeds. */
app.post("/challenge/:id/solve", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{32}$/.test(id)) return fail(c, "bad_request", "Malformed challenge id.");

  const body = (await c.req.json().catch(() => ({}))) as { turnstile_token?: string };
  if (!body.turnstile_token) return fail(c, "bad_request", "Missing Turnstile token.");

  const raw = await c.env.SESSIONS.get(`challenge:${id}`);
  if (!raw) return fail(c, "token_expired", "This verification link has expired. Run `localmax submit` again.");

  const verdict = await verifyTurnstile(c.env, body.turnstile_token, clientIp(c));
  if (!verdict.ok) return fail(c, "challenge_required", `Verification failed (${verdict.reason}).`);

  const state = JSON.parse(raw) as { profile_id: string };
  const token = randomHex(32);

  await c.env.SESSIONS.put(
    `token:${token}`,
    JSON.stringify({ profile_id: state.profile_id, created_at: Date.now() }),
    { expirationTtl: SUBMISSION_TOKEN_TTL_S },
  );
  await c.env.SESSIONS.put(
    `challenge:${id}`,
    JSON.stringify({ state: "solved", token }),
    { expirationTtl: CHALLENGE_TTL_S },
  );

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 2. Create submission. Cheap synchronous checks only: schema, signature, profile,
//    declared sizes. Everything expensive happens on the queue.
// ---------------------------------------------------------------------------

app.post("/", async (c) => {
  const ip = clientIp(c);
  const { success } = await c.env.SUBMIT_LIMITER.limit({ key: `submit:${ip}` });
  if (!success) return fail(c, "rate_limited", "Too many submissions from this address.", undefined, 60);

  const body = await c.req.json().catch(() => null);
  if (!validateCreateSubmission(body)) {
    return fail(c, "schema_invalid", "The manifest does not match the result schema.", errorDetails(validateCreateSubmission.errors));
  }

  const { submission_token, nonce, manifest } = body as {
    submission_token: string;
    nonce: string;
    manifest: Manifest;
  };

  // Idempotency: replaying a nonce returns the original response rather than duplicating.
  const replay = await c.env.SESSIONS.get(`nonce:${nonce}`);
  if (replay) {
    return c.json(JSON.parse(replay) as Record<string, unknown>);
  }

  const tokenRaw = await c.env.SESSIONS.get(`token:${submission_token}`);
  if (!tokenRaw) {
    return fail(c, "token_expired", "The submission token is expired or already used. Run `localmax submit` again.");
  }

  const profile = PROFILES[manifest.profile.id];
  if (!profile) return fail(c, "profile_unknown", `Unknown profile "${manifest.profile.id}".`);
  if (manifest.profile.hash !== profile.hash) {
    return fail(
      c,
      "profile_mismatch",
      "The manifest was produced against a different version of this profile. Pull the current container and run again.",
    );
  }

  if (!(await verifyManifestSignature(manifest as unknown as Record<string, unknown>))) {
    return fail(c, "signature_invalid", "The manifest signature does not verify against the submitted system key.");
  }

  const maxArtifact = Number(c.env.MAX_ARTIFACT_BYTES);
  const maxTotal = Number(c.env.MAX_SUBMISSION_BYTES);
  const declaredBytes = manifest.artifacts.reduce((sum, a) => sum + a.size_bytes, 0);
  if (declaredBytes > maxTotal) {
    return fail(c, "too_large", `Evidence totals ${declaredBytes} bytes; the limit is ${maxTotal}.`);
  }
  const oversize = manifest.artifacts.find((a) => a.size_bytes > maxArtifact);
  if (oversize) {
    return fail(c, "too_large", `Artifact ${oversize.name} exceeds the ${maxArtifact} byte limit.`);
  }

  const runId = isUlid(manifest.run_id) ? manifest.run_id : ulid();
  const now = new Date().toISOString();

  // Deduplicate evidence: an artifact already in the store is not uploaded again.
  const uploads: Array<{ name: string; hash: string; url: string; expires_at: string }> = [];
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_S * 1000);

  for (const artifact of manifest.artifacts) {
    const existing = await c.env.EVIDENCE.head(objectKey(artifact.hash));
    if (existing && existing.size === artifact.size_bytes) continue;

    const uploadToken = randomHex(24);
    const slot: UploadSlot = {
      run_id: runId,
      hash: artifact.hash,
      size_bytes: artifact.size_bytes,
      media_type: artifact.media_type,
      expires_at: expiresAt.getTime(),
    };
    await c.env.SESSIONS.put(`upload:${uploadToken}`, JSON.stringify(slot), {
      expirationTtl: UPLOAD_TTL_S,
    });
    uploads.push({
      name: artifact.name,
      hash: artifact.hash,
      url: `${c.env.API_ORIGIN}/v1/uploads/${uploadToken}`,
      expires_at: expiresAt.toISOString(),
    });
  }

  const ipHash = c.env.IP_HASH_SALT ? await hashIp(ip, c.env.IP_HASH_SALT) : null;

  try {
    await c.env.DB.prepare(
      `INSERT INTO submissions
         (run_id, nonce, state, profile_id, manifest_json, declared_bytes,
          pending_artifacts, submitter_ip_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    )
      .bind(
        runId,
        nonce,
        uploads.length > 0 ? "awaiting_upload" : "queued",
        manifest.profile.id,
        JSON.stringify({ ...manifest, run_id: runId }),
        declaredBytes,
        uploads.length,
        ipHash,
        now,
      )
      .run();
  } catch (e) {
    // The unique index on nonce is the authoritative idempotency guard; the KV read above
    // is only a fast path, and two concurrent retries can both miss it.
    const existing = await c.env.DB.prepare(
      `SELECT run_id FROM submissions WHERE nonce = ?1`,
    ).bind(nonce).first<{ run_id: string }>();
    if (existing) {
      return c.json({
        run_id: existing.run_id,
        state: "duplicate",
        status_url: `${c.env.API_ORIGIN}/v1/submissions/${existing.run_id}`,
        uploads: [],
      });
    }
    throw e;
  }

  await c.env.SESSIONS.delete(`token:${submission_token}`);

  const response = {
    run_id: runId,
    state: uploads.length > 0 ? "awaiting_upload" : "queued",
    status_url: `${c.env.API_ORIGIN}/v1/submissions/${runId}`,
    uploads,
  };

  await c.env.SESSIONS.put(`nonce:${nonce}`, JSON.stringify(response), {
    expirationTtl: 86400,
  });

  if (uploads.length === 0) {
    await c.env.VALIDATION.send({ run_id: runId, attempt: 0 });
  }

  return c.json(response, 202);
});

// ---------------------------------------------------------------------------
// 3. Complete. The runner calls this once every upload slot has been filled.
// ---------------------------------------------------------------------------

app.post("/:runId/complete", async (c) => {
  const runId = c.req.param("runId");
  if (!isUlid(runId)) return fail(c, "bad_request", "Malformed run id.");

  const body = await c.req.json().catch(() => null);
  if (!validateCompleteSubmission(body)) {
    return fail(c, "bad_request", "Invalid completion request.");
  }

  const row = await c.env.DB.prepare(
    `SELECT state, pending_artifacts FROM submissions WHERE run_id = ?1`,
  ).bind(runId).first<{ state: string; pending_artifacts: number }>();

  if (!row) return fail(c, "not_found", "Unknown submission.");
  if (row.state !== "awaiting_upload") {
    return c.json({ run_id: runId, state: row.state, updated_at: new Date().toISOString() });
  }
  if (row.pending_artifacts > 0) {
    return fail(
      c,
      "artifact_mismatch",
      `${row.pending_artifacts} declared artifact(s) were never uploaded.`,
    );
  }

  await c.env.DB.prepare(
    `UPDATE submissions SET state = 'queued', updated_at = ?2 WHERE run_id = ?1`,
  ).bind(runId, new Date().toISOString()).run();

  await c.env.VALIDATION.send({ run_id: runId, attempt: 0 });

  return c.json({ run_id: runId, state: "queued", updated_at: new Date().toISOString() }, 202);
});

// ---------------------------------------------------------------------------
// 4. Status.
// ---------------------------------------------------------------------------

app.get("/:runId", async (c) => {
  const runId = c.req.param("runId");
  if (!isUlid(runId)) return fail(c, "bad_request", "Malformed run id.");

  const accepted = await c.env.DB.prepare(
    `SELECT verification, accepted_at, findings_json FROM results WHERE run_id = ?1`,
  ).bind(runId).first<{ verification: string; accepted_at: string; findings_json: string }>();

  if (accepted) {
    return c.json({
      run_id: runId,
      state: "accepted",
      verification: accepted.verification,
      updated_at: accepted.accepted_at,
      result_url: `${c.env.SITE_ORIGIN}/results/${runId}`,
      findings: JSON.parse(accepted.findings_json || "[]") as Finding[],
    });
  }

  const pending = await c.env.DB.prepare(
    `SELECT state, updated_at, findings_json FROM submissions WHERE run_id = ?1`,
  ).bind(runId).first<{ state: string; updated_at: string; findings_json: string | null }>();

  if (!pending) return fail(c, "not_found", "Unknown submission.");

  return c.json({
    run_id: runId,
    state: pending.state,
    updated_at: pending.updated_at,
    findings: JSON.parse(pending.findings_json || "[]") as Finding[],
  });
});

export default app;
