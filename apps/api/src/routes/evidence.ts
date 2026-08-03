import { Hono } from "hono";
import type { Env } from "../env";
import { fail } from "../lib/http";
import { objectKey } from "../lib/validation";

const app = new Hono<{ Bindings: Env }>();

/** Media types safe to render inline. Everything else downloads as an attachment. */
const INLINE = new Set(["image/webp", "image/png", "application/json", "text/plain", "application/x-ndjson"]);

/**
 * Read-only evidence by content hash.
 *
 * The bucket is private; this is the only path out of it. Content is addressed by hash, so
 * the URL cannot be manipulated into reading anything the manifest did not reference, and
 * the response is served with headers that stop a browser treating uploaded bytes as active
 * content.
 */
app.get("/:hash", async (c) => {
  const hash = c.req.param("hash");
  const normalized = hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    return fail(c, "bad_request", "Malformed evidence hash.");
  }

  // Only evidence attached to an accepted result is retrievable.
  const known = await c.env.DB.prepare(
    `SELECT ra.name, ra.kind, a.media_type, a.size_bytes
       FROM result_artifacts ra
       JOIN artifacts a ON a.hash = ra.hash
       JOIN results r ON r.run_id = ra.run_id
      WHERE ra.hash = ?1 LIMIT 1`,
  ).bind(normalized).first<{ name: string; kind: string; media_type: string; size_bytes: number }>();

  if (!known) return fail(c, "not_found", "No accepted result references this evidence.");

  const object = await c.env.EVIDENCE.get(objectKey(normalized));
  if (!object) return fail(c, "not_found", "Evidence is no longer stored.");

  const inline = INLINE.has(known.media_type);
  const headers = new Headers({
    "Content-Type": known.media_type,
    "Content-Length": String(known.size_bytes),
    // Content-addressed, therefore immutable.
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${known.name.replace(/[^\w.-]/g, "_")}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
  });

  return new Response(object.body, { headers });
});

export default app;
