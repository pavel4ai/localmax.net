#!/usr/bin/env node
/**
 * Append a signed image digest to the released list the validator trusts.
 *
 * The platform list is supplied by the caller from the registry rather than assumed: an
 * image built only for amd64 must not carry a provenance record claiming arm64, which is
 * exactly the sort of quiet inaccuracy that makes a trust store worthless.
 */
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

for (const key of ["image", "tag", "digest", "platform"]) {
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
    platform: args.platform,
    released_at: new Date().toISOString(),
  });
}
writeFileSync(PATH, JSON.stringify(file, null, 2) + "\n");
console.log(`recorded ${args.image}@${args.digest}`);
