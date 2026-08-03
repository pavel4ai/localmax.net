import { Hono } from "hono";
import type { Env } from "../env";
import { fail } from "../lib/http";
import { objectKey } from "../lib/validation";

const app = new Hono<{ Bindings: Env }>();

interface UploadSlot {
  run_id: string;
  hash: string;
  size_bytes: number;
  media_type: string;
  expires_at: number;
}

/**
 * Single-use evidence upload.
 *
 * The body is streamed straight into R2 with the expected SHA-256 attached, so R2 itself
 * rejects content that does not hash to the declared value. Nothing is buffered in the
 * Worker, nothing is unpacked, and the key is derived from the hash rather than from
 * anything the client chooses, so a caller cannot write to an arbitrary object path.
 */
app.put("/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[0-9a-f]{48}$/.test(token)) return fail(c, "bad_request", "Malformed upload token.");

  const raw = await c.env.SESSIONS.get(`upload:${token}`);
  if (!raw) return fail(c, "token_expired", "This upload slot has expired or was already used.");

  const slot = JSON.parse(raw) as UploadSlot;
  if (Date.now() > slot.expires_at) {
    await c.env.SESSIONS.delete(`upload:${token}`);
    return fail(c, "token_expired", "This upload slot has expired.");
  }

  const declaredLength = Number(c.req.header("Content-Length") ?? "");
  if (!Number.isFinite(declaredLength) || declaredLength !== slot.size_bytes) {
    return fail(
      c,
      "artifact_mismatch",
      `Content-Length must be exactly ${slot.size_bytes} bytes for this slot.`,
    );
  }

  const body = c.req.raw.body;
  if (!body) return fail(c, "bad_request", "Empty request body.");

  const key = objectKey(slot.hash);
  const expectedSha256 = slot.hash.replace(/^sha256:/, "");

  try {
    await c.env.EVIDENCE.put(key, body, {
      sha256: expectedSha256,
      httpMetadata: {
        contentType: slot.media_type,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { run_id: slot.run_id },
    });
  } catch {
    // R2 raises when the streamed bytes do not hash to the value we passed in.
    return fail(
      c,
      "artifact_mismatch",
      "The uploaded content does not match the declared SHA-256. Nothing was stored.",
    );
  }

  // Slot is single use.
  await c.env.SESSIONS.delete(`upload:${token}`);

  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO artifacts (hash, size_bytes, media_type, kind, refcount, created_at)
       VALUES (?1, ?2, ?3, 'evidence', 0, ?4)
       ON CONFLICT(hash) DO NOTHING`,
    ).bind(slot.hash, slot.size_bytes, slot.media_type, now),
    c.env.DB.prepare(
      `UPDATE submissions
          SET uploaded_bytes = uploaded_bytes + ?2,
              pending_artifacts = MAX(0, pending_artifacts - 1),
              updated_at = ?3
        WHERE run_id = ?1`,
    ).bind(slot.run_id, slot.size_bytes, now),
  ]);

  return c.json({ ok: true, hash: slot.hash, size_bytes: slot.size_bytes }, 201);
});

export default app;
