#!/usr/bin/env node
// Emit the RFC 8785 canonical form of a JSON document read from stdin, using the exact
// implementation the Worker signs against. Used by the cross-language contract tests.
import { canonicalize } from "../apps/api/src/lib/canonical.ts";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => process.stdout.write(canonicalize(JSON.parse(input))));
