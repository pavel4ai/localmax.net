#!/usr/bin/env node
/**
 * A frozen profile is immutable.
 *
 * Editing one silently invalidates every comparison built on it: results published before
 * and after would sit on the same leaderboard while having measured different things. This
 * refuses the change at the gate rather than discovering it in the data later.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : "HEAD~1";

let changed = [];
try {
  changed = execSync(`git diff --name-only ${base}...HEAD -- benchmarks/profiles`, {
    cwd: ROOT, encoding: "utf8",
  }).split("\n").filter(Boolean);
} catch {
  console.log("No comparison point available; skipping the frozen-profile check.");
  process.exit(0);
}

let violations = 0;
for (const file of changed) {
  let previous;
  try {
    previous = JSON.parse(execSync(`git show ${base}:${file}`, { cwd: ROOT, encoding: "utf8" }));
  } catch {
    continue; // newly added file
  }
  if (!previous.frozen) continue;

  const current = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  if (JSON.stringify(previous) !== JSON.stringify(current)) {
    violations++;
    console.error(`✗ ${file} is frozen and was modified. Publish a new version instead.`);
  }
}

if (violations) process.exit(1);
console.log(`${changed.length} profile file(s) changed, no frozen profile modified.`);
