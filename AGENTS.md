# Agent and contributor rules

## Non-negotiable

1. **Never commit secrets.** `.cloudflare`, `.dev.vars`, `.env`, and `*.pem` are gitignored.
   If a secret is ever committed, rotate it before removing it from history.
2. **Schemas are the source of truth.** `schemas/*.json` defines every contract. Python and
   TypeScript types are generated from or validated against them. Change the schema first.
3. **Released profiles are immutable.** Never edit a file under `benchmarks/profiles/` that
   has a frozen version. Publish a new version instead. Comparability depends on this.
4. **Never silently rewrite a submitted measurement.** Reject it, or annotate it. Values in
   an accepted manifest are exactly what the runner reported.
5. **Never execute submitted files** in CI or in a Worker. Parse only, in an isolated job.

## Layout

| Path | Owns |
|---|---|
| `schemas/` | JSON Schema contracts, versioned |
| `benchmarks/profiles/` | Immutable profiles, prompt sets, asset manifests |
| `src/localmax_runner/` | Python CLI, adapters, telemetry, signing, submission |
| `containers/` | Dockerfiles and entrypoints, multi-arch |
| `apps/api/` | Hono Worker: submission, queue consumer, read API |
| `apps/web/` | Astro site |
| `results/` | Accepted manifests only. No logs, traces, or media. |
| `docs/` | Architecture, methodology, operations |

## Conventions

- Python: 3.10+, Ruff, type hints on public functions, `pytest`. No network in unit tests.
- TypeScript: strict mode, no `any` in checked-in code, Vitest, Hono for the Worker.
- Astro: zero client JS by default. An island needs a written justification in review.
  The whole-site client JS budget is 30 kB gzipped.
- Metric names in manifests are `snake_case` and carry an explicit unit suffix
  (`_ms`, `_s`, `_tok_s`, `_bytes`, `_w`, `_j`).
- Every derived metric must be recomputable from raw values present in the same manifest.

## Design language

Minimalist and dense. Monochrome surfaces, a single accent, one typeface plus one mono
face. Data outranks decoration: no gradients, no drop shadows, no vendor logos as
navigation, no chart library. Charts are hand-written inline SVG and must expose their
source values as a table or download.
