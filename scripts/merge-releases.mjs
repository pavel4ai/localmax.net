#!/usr/bin/env node
/** Merge per-image released-images.json artifacts from a matrix build into one file. */
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "containers", "released-images.json");
const dir = process.argv[2];

const merged = JSON.parse(readFileSync(PATH, "utf8"));
merged.images ??= [];
const seen = new Set(merged.images.map((i) => i.digest));

function* walk(d) {
  for (const entry of readdirSync(d)) {
    const p = join(d, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (entry === "released-images.json") yield p;
  }
}

for (const path of walk(dir)) {
  for (const image of JSON.parse(readFileSync(path, "utf8")).images ?? []) {
    if (!seen.has(image.digest)) {
      merged.images.push(image);
      seen.add(image.digest);
    }
  }
}

merged.images.sort((a, b) => a.released_at.localeCompare(b.released_at));
writeFileSync(PATH, JSON.stringify(merged, null, 2) + "\n");
console.log(`${merged.images.length} released image digest(s) on record`);
