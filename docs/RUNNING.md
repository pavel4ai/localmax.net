# Running a benchmark

## Requirements

- Linux with the NVIDIA driver (550.54 or newer) and the NVIDIA Container Toolkit
- Docker, x86_64 or aarch64
- At least 12 GB of VRAM, and free disk for the model cache
- WSL2 works but is experimental; results from it are labelled

## Check first

```bash
docker run --rm --gpus all ghcr.io/pavel4ai/localmax-llm:latest doctor
```

Reports your GPU, driver, CUDA, RAM, disk, and which profiles you qualify for — with the
specific reason for any that you do not.

## Run

```bash
docker run --rm --gpus all -v ~/.localmax:/cache \
  ghcr.io/pavel4ai/localmax-llm:latest run llm-entry-fp8
```

Weights land in `~/.localmax` and are reused across profiles, so the second run of a tier
skips the download. Close other GPU work first: the runner records what it observes,
including your desktop compositor.

Useful flags:

| Flag | Purpose |
|---|---|
| `--gpus N` | Number of GPUs. Defaults to the smallest count the profile permits. |
| `--notes TEXT` | A public note on the result. |
| `--cooling air\|aio\|custom-loop\|blower\|passive` | Declared label. Never affects a score. |
| `--tuning stock\|undervolted\|overclocked\|power-limited` | Declared label, cross-checked against measured clocks. |
| `--notes TEXT` | A public note on the result. |
| `-y` | Skip the confirmation prompt. |

## Inspect before publishing

```bash
docker run --rm -v ~/.localmax:/cache \
  ghcr.io/pavel4ai/localmax-llm:latest inspect LAST
```

Entirely offline. Prints the manifest, every artifact that would be uploaded with its hash,
and the free text you supplied. Nothing has been transmitted at this point.

## Publish

```bash
docker run --rm -v ~/.localmax:/cache \
  ghcr.io/pavel4ai/localmax-llm:latest submit LAST
```

Prints a verification link. Open it, complete a one-click browser check, and the upload
proceeds. No account, no email, no GitHub token.

## Multi-GPU

Prospector profiles accept 1, 2, 4 or 8 GPUs, ranked separately. Tensor parallelism is a
comparability key, so a `tp2` result never shares a leaderboard with a single-GPU one.

A cluster counts as one system. LocalMax adds the VRAM of every node to decide the tier, so
eight DGX Sparks are one Prospector system. The interconnect is recorded, because across
nodes the network fabric governs how well the run scales.

```bash
docker run --rm --gpus all -v ~/.localmax:/cache \
  ghcr.io/pavel4ai/localmax-llm:latest run llm-prospector-fp8 --gpus 2
```

On an RTX PRO 6000 Blackwell pair there is no NVLink, so the two cards communicate over
PCIe. The link generation and width are recorded and shown on the result page, because they
materially affect how well tensor parallelism scales.

## DGX Spark

Use the same commands; Docker selects the `linux/arm64` image automatically. Two things
differ and both are visible on the result:

- Power is measured at the SoC module, not a GPU board. Those are different physical
  quantities, so a Spark result is never ranked for energy against a discrete card.
- Memory is unified. Capacity is enormous and bandwidth is modest, so expect strong
  Prospector-tier capacity results and comparatively low decode throughput. That is the real
  shape of the hardware, not a defect in the measurement.

## When something fails

An out-of-memory failure is a legitimate result and worth submitting: it records that this
profile does not fit this configuration. The runner marks the workload failed rather than
quietly retrying with looser settings, because a retried run would no longer belong to the
profile.

Report problems at <https://github.com/pavel4ai/localmax.net/issues> with the run ID.
