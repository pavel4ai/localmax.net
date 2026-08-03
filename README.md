<div align="center">

# LocalMax

**Benchmark. Compare. Max out your local AI.**

Open benchmarks for local generative AI — LLM, Vision, and Diffusion — measured on real
hardware, from a 12 GB RTX 3060 to a dual RTX PRO 6000 workstation to a DGX Spark.

[localmax.net](https://localmax.net) · [Methodology](https://localmax.net/methodology) · [Run a benchmark](https://localmax.net/run)

</div>

---

## What this is

You run one command. A pinned container starts a pinned inference runtime with a pinned
model, drives it with a pinned workload, records what your machine did, and publishes the
result. Everyone runs the same test, so the numbers mean something.

```bash
docker run --rm --gpus all -v ~/.localmax:/cache \
  ghcr.io/pavel4ai/localmax-llm:latest run llm-entry-base
```

What is fixed: model, revision, quantization, runtime, flags, prompts, input/output token
lengths, image set, diffusion steps and seeds.

What varies: **your hardware, and therefore your results** — tokens/s, TTFT, inter-token
latency, prefill throughput, seconds per diffusion step, images/minute, peak VRAM, watts,
joules per token.

## The benchmark matrix

Three categories × three VRAM tiers × three quantization lanes. A tier is defined by the
VRAM the ranked run is meant to *fill*, so every class of hardware has a workload that
actually stresses it.

| Tier | Min VRAM | Baseline lane (BF16 — universal, ranked) | INT4 lane (Ampere+) | NVFP4 lane (Blackwell) |
|---|---|---|---|---|
| **Entry** | 12 GB | 4B-class | 8B-class | 8B-class |
| **Enthusiast** | 24 GB | 8B-class | 30B-class | 30B-class |
| **Frontier** | 64 GB | 30B-class | 70B-class | 70B-class |

Results are only ranked against results in the same **profile** — same category, tier,
lane, runtime, GPU count and parallelism. Cross-lane and cross-tier comparison is shown,
but never ranked.

See [`benchmarks/profiles/`](benchmarks/profiles/) for the immutable profile definitions and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## Supported hardware

| Class | Examples | Tiers |
|---|---|---|
| Entry | RTX 3060 12 GB, 4060 Ti 16 GB, 4070, 5070 | Entry |
| Enthusiast | RTX 3090, 4090, 5090 | Entry, Enthusiast |
| Frontier | RTX PRO 6000 Blackwell (×1, ×2), DGX Spark (GB10) | all three |

NVIDIA only in v1. Linux x86_64 and **arm64 (DGX Spark / GB10)**. WSL2 is experimental.

DGX Spark reports **SoC module power**, not discrete board power — it is never ranked for
energy against a discrete GPU. See [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).

## Repository layout

```
schemas/                JSON Schema contracts (profile, result, API) — source of truth
benchmarks/profiles/    Immutable profile definitions + prompt/asset sets
src/localmax_runner/    Python CLI: doctor, run, inspect, submit
containers/             Multi-arch OCI images (llm, vision, diffusion)
apps/api/               Hono Worker: submission, validation queue, read API
apps/web/               Astro site (SSR on Workers, near-zero client JS)
results/                Accepted manifests, archived from D1 in batches
docs/                   Architecture, methodology, operations
```

## Deploy

Live at [localmax.net](https://localmax.net). Provisioning is idempotent, so this both
creates a fresh environment and reconciles an existing one:

```bash
source .cloudflare && ./scripts/provision-cloudflare.sh
```

The token must be account-scoped; [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) lists the exact
permissions and what gets created.

## Development

```bash
npm install                 # workspace root
npm run dev:api             # Hono Worker on :8787 with local D1/R2/KV
npm run dev:web             # Astro on :4321
npm run seed:local          # migrate + 263 demonstration results
npm run test                # TS + Python test suites
python -m pip install -e ".[dev]"
python -m localmax_runner doctor
```

## Trust

Every accepted result carries a verification state:

- **Community** — valid manifest, incomplete evidence or unofficial image. Shown, never ranked.
- **Verified** — official signed image, immutable profile, complete evidence, all automated
  checks passed, metrics recomputed from raw data. Ranked.

Verified means the protocol was followed and the evidence is internally consistent. It does
not prove the operator was honest. Anomaly review and public evidence cover the rest.

## Licenses

Code is Apache-2.0 ([`LICENSE`](LICENSE)). Accepted result data is CC BY 4.0
([`LICENSE-DATA`](LICENSE-DATA)). Benchmark input assets carry their own licenses, recorded
per asset in the profile definitions.

## Security and privacy

Report vulnerabilities per [`SECURITY.md`](SECURITY.md). What the runner collects, and what
it deliberately does not, is in [`PRIVACY.md`](PRIVACY.md).
