#!/usr/bin/env node
/** Append a signed image digest to the released list the validator trusts. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "containers", "released-images.json");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, []),
);

for (const key of ["image", "tag", "digest"]) {
  if (!args[key]) {
    console.error(`missing --${key}`);
    process.exit(1);
  }
}

const file = JSON.parse(readFileSync(PATH, "utf8"));
file.images ??= [];
if (!file.images.some((i) => i.digest === args.digest)) {
  file.images.push({
    image: args.image,
    tag: args.tag,
    digest: args.digest,
    platform: "linux/amd64,linux/arm64",
    released_at: new Date().toISOString(),
  });
}
writeFileSync(PATH, JSON.stringify(file, null, 2) + "\n");
console.log(`recorded ${args.image}@${args.digest}`);
