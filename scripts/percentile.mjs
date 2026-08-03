#!/usr/bin/env node
// Emit percentiles using the Worker's own implementation, so the Python runner can be
// pinned against it. A divergence here would look like a fabricated metric to the
// validator, so the two must be tested together rather than merely written to match.
import { percentile } from "../apps/api/src/lib/stats.ts";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const { values, percentiles } = JSON.parse(input);
  const sorted = [...values].sort((a, b) => a - b);
  const out = {};
  for (const p of percentiles) out[p] = percentile(sorted, p);
  process.stdout.write(JSON.stringify(out));
});
