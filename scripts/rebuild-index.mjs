#!/usr/bin/env node
/**
 * Rebuild the live D1 index from the Git archive.
 *
 * D1 is a disposable read model; `results/` is the canonical record. This proves that
 * claim is real rather than aspirational — it is the recovery path, and it is exercised in
 * the release checklist rather than trusted on faith.
 *
 *   node scripts/rebuild-index.mjs --local
 *   node scripts/rebuild-index.mjs --remote
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "results");
const remote = process.argv.includes("--remote");

if (!existsSync(RESULTS)) {
  console.log("No results archive; nothing to rebuild.");
  process.exit(0);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".json")) yield path;
  }
}

const manifests = [...walk(RESULTS)].map((p) => JSON.parse(readFileSync(p, "utf8")));
manifests.sort((a, b) => a.run_id.localeCompare(b.run_id));

console.log(`${manifests.length} archived manifest(s).`);
console.log(
  "Re-validation and metric recomputation run inside the Worker, which owns that logic.\n" +
  "This script stages the manifests; the queue consumer rebuilds the derived rows so the\n" +
  "rebuild path and the live path can never diverge.",
);

const staging = join(ROOT, "tmp", "rebuild.sql");
const statements = ["DELETE FROM results;", "DELETE FROM result_artifacts;", "DELETE FROM profile_stats;"];
for (const manifest of manifests) {
  const json = JSON.stringify(manifest).replace(/'/g, "''");
  statements.push(
    `INSERT INTO submissions (run_id, nonce, state, profile_id, manifest_json, declared_bytes, ` +
    `pending_artifacts, created_at, updated_at) VALUES ('${manifest.run_id}', ` +
    `'${manifest.run_id.toLowerCase().padEnd(32, "0").slice(0, 32)}', 'queued', ` +
    `'${manifest.profile.id}', '${json}', 0, 0, '${manifest.created_at}', '${manifest.created_at}');`,
  );
}

writeFileSync(staging, statements.join("\n") + "\n");
execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "localmax", remote ? "--remote" : "--local",
   "--file", staging, "--config", "apps/api/wrangler.toml"],
  { cwd: ROOT, stdio: "inherit" },
);
console.log("Staged. The validation queue will republish each result.");
