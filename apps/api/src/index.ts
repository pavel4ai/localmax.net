import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

import { runArchive, runEvidenceCleanup } from "./archive";
import { handleValidationBatch } from "./consumer";
import type { Env, ValidationMessage } from "./env";
import evidence from "./routes/evidence";
import read from "./routes/read";
import submissions from "./routes/submissions";
import uploads from "./routes/uploads";
import { fail } from "./lib/http";

const app = new Hono<{ Bindings: Env }>();

app.use("*", secureHeaders());

// The website reaches the API through a service binding, so browser CORS only matters for
// third parties reading the open data. Reads are public; writes are not.
app.use("/v1/*", async (c, next) => {
  const handler = cors({
    origin: c.req.method === "GET" ? "*" : [c.env.SITE_ORIGIN],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  });
  return handler(c, next);
});

app.get("/", (c) =>
  c.json({
    service: "localmax-api",
    docs: `${c.env.SITE_ORIGIN}/methodology`,
    version: "0.1.0",
    endpoints: [
      "GET  /v1/profiles",
      "GET  /v1/profiles/:id",
      "GET  /v1/leaderboard/:profileId",
      "GET  /v1/results",
      "GET  /v1/results/:runId",
      "GET  /v1/distribution/:profileId",
      "GET  /v1/hardware",
      "GET  /v1/hardware/:gpuKey",
      "GET  /v1/compare?ids=",
      "GET  /v1/stats",
      "GET  /v1/evidence/:hash",
      "POST /v1/submissions/challenge",
      "POST /v1/submissions",
      "PUT  /v1/uploads/:token",
    ],
  }),
);

app.get("/health", async (c) => {
  const probe = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return c.json({ ok: probe?.ok === 1, environment: c.env.ENVIRONMENT });
});

/** Public site key so the verification page can render Turnstile without a build-time bake. */
app.get("/v1/config", (c) =>
  c.json({ turnstile_site_key: c.env.TURNSTILE_SITE_KEY, site_origin: c.env.SITE_ORIGIN }),
);

app.route("/v1/submissions", submissions);
app.route("/v1/uploads", uploads);
app.route("/v1/evidence", evidence);
app.route("/v1", read);

app.notFound((c) => fail(c, "not_found", "No such endpoint."));

app.onError((error, c) => {
  console.error("unhandled", error);
  return fail(c, "internal", "The request could not be completed.");
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<ValidationMessage>, env: Env): Promise<void> {
    await handleValidationBatch(batch, env);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const archived = await runArchive(env);
        const removed = await runEvidenceCleanup(env);
        console.log(`archive: ${archived.archived} result(s), cleanup: ${removed} object(s)`);
      })(),
    );
  },
};
