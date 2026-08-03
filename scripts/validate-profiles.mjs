#!/usr/bin/env node
/** Validate every benchmark profile against the published schema and the project's rules. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://localmax.net/schemas/";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of readdirSync(join(ROOT, "schemas")).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(ROOT, "schemas", f), "utf8")), BASE + f);
}
const validate = ajv.getSchema(BASE + "profile.schema.json");

const TIER_VRAM = { entry: 12, enthusiast: 24, frontier: 64 };
let failures = 0;

for (const file of readdirSync(join(ROOT, "benchmarks", "profiles")).sort()) {
  if (!file.endsWith(".json")) continue;
  const profile = JSON.parse(readFileSync(join(ROOT, "benchmarks", "profiles", file), "utf8"));
  const { $schema, ...body } = profile;
  const problems = [];

  if (!validate(body)) {
    problems.push(...validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`));
  }

  if (`${body.category}-${body.tier}-${body.lane}` !== body.id) {
    problems.push(`id "${body.id}" disagrees with category/tier/lane`);
  }
  if (file !== `${body.id}.json`) problems.push(`filename does not match id "${body.id}"`);

  const gb = body.requirements?.min_vram_bytes / 1024 ** 3;
  if (gb !== TIER_VRAM[body.tier]) {
    problems.push(`tier ${body.tier} must require ${TIER_VRAM[body.tier]} GB, found ${gb}`);
  }

  const ids = new Set((body.workloads ?? []).map((w) => w.id));
  if (!ids.has(body.ranking?.source_workload)) {
    problems.push(`ranking.source_workload "${body.ranking?.source_workload}" is not a workload`);
  }
  for (const gate of body.ranking?.gates ?? []) {
    if (!ids.has(gate.source_workload)) {
      problems.push(`gate ${gate.metric} references unknown workload "${gate.source_workload}"`);
    }
  }

  // NVFP4 is Blackwell-only hardware; listing an older architecture would let a card that
  // physically cannot run the lane appear on its leaderboard.
  if (body.lane === "nvfp4") {
    for (const arch of body.requirements?.architectures ?? []) {
      if (["ampere", "ada", "hopper"].includes(arch)) {
        problems.push(`nvfp4 lane must not accept ${arch}`);
      }
    }
  }

  if (problems.length) {
    failures++;
    console.error(`\n✗ ${file}`);
    for (const p of problems) console.error(`    ${p}`);
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failures) {
  console.error(`\n${failures} profile(s) failed validation.`);
  process.exit(1);
}
console.log("\nAll profiles valid.");
