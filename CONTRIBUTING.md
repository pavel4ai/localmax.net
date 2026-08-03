# Contributing

## Submitting a benchmark result

You do not need to contribute code, or even a GitHub account. Run the container and submit:

```bash
docker run --rm --gpus all -v ~/.localmax:/cache \
  ghcr.io/pavel4ai/localmax-llm:latest run llm-entry-base
```

Read [`docs/RUNNING.md`](docs/RUNNING.md) first.

## Contributing code

1. Open an issue before large changes. Profile and schema changes always need one.
2. `npm install && python -m pip install -e ".[dev]"`
3. `npm run check` and `pytest` must pass. CI runs the same commands.
4. Conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`).

## Changing a benchmark profile

This is the highest-risk change in the project because it silently invalidates comparisons.

- A **frozen** profile is immutable. Never edit it. Add a new version directory.
- A change to the model, revision, quantization, runtime, runtime flags, prompt set, token
  shape, image assets, step count, scheduler, seeds, or metric definitions is a **major**
  version bump and creates a separate leaderboard.
- Documentation, comments, and display names may change in a patch version.
- Every profile change needs conformance data from at least two GPU classes, including the
  tier's minimum-VRAM reference system.

## Adding a GPU to the hardware registry

Add it to `benchmarks/hardware.json` with model name, VRAM bytes, memory bandwidth,
architecture, compute capability, FP8 and NVFP4 support, and the tiers it qualifies for.
Bandwidth and VRAM must cite a manufacturer specification.

## Reporting a suspicious result

Open an issue with the run ID and what looks wrong. Do not accuse a contributor. Maintainers
compare the manifest against the evidence and the distribution for that GPU, and either
annotate, demote, or remove the result. The audit trail is public.
