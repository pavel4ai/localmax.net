#!/usr/bin/env node
/**
 * Release gate: the whole site's client JavaScript stays under 30 kB gzipped.
 *
 * Every chart is server-rendered SVG, so there should be almost nothing here. The budget
 * exists to make a regression loud — an accidentally hydrated component is easy to add and
 * hard to notice.
 */
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "apps", "web", "dist", "client");
const BUDGET = 30 * 1024;

if (!existsSync(CLIENT)) {
  console.log("No client build output; nothing to measure.");
  process.exit(0);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".js")) yield path;
  }
}

let total = 0;
const files = [];
for (const path of walk(CLIENT)) {
  const size = gzipSync(readFileSync(path)).length;
  total += size;
  files.push([path.replace(CLIENT + "/", ""), size]);
}

files.sort((a, b) => b[1] - a[1]);
for (const [name, size] of files.slice(0, 10)) {
  console.log(`  ${(size / 1024).toFixed(1)} kB  ${name}`);
}
console.log(`\nClient JavaScript: ${(total / 1024).toFixed(1)} kB gzipped (budget ${BUDGET / 1024} kB)`);

if (total > BUDGET) {
  console.error("::error::Client JavaScript budget exceeded.");
  process.exit(1);
}
