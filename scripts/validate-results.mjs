#!/usr/bin/env node
/**
 * Validate every archived result manifest against the published schema.
 *
 * The archive is the canonical record and the live database is rebuilt from it, so an
 * invalid file here would poison the index on the next rebuild.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "results");
const BASE = "https://localmax.net/schemas/";

if (!existsSync(RESULTS)) {
  console.log("No results archive yet.");
  process.exit(0);
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of readdirSync(join(ROOT, "schemas")).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(ROOT, "schemas", f), "utf8")), BASE + f);
}
const validate = ajv.getSchema(BASE + "result.schema.json");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".json")) yield path;
  }
}

let checked = 0;
let failures = 0;
for (const path of walk(RESULTS)) {
  checked++;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!validate(manifest)) {
    failures++;
    console.error(`✗ ${path.replace(ROOT + "/", "")}`);
    for (const e of validate.errors.slice(0, 5)) {
      console.error(`    ${e.instancePath || "/"} ${e.message}`);
    }
  }
}

console.log(`${checked} result(s) checked, ${failures} invalid.`);
process.exit(failures ? 1 : 0);
