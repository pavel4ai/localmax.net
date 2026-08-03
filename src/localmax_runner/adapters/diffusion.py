"""Text-to-image diffusion adapter.

Unlike the LLM and vision paths there is no server: the pipeline is driven in-process,
because a diffusion step count is the unit of work and interposing HTTP would add noise
comparable to the thing being measured.

Ranked on seconds per denoising step. That figure is resolution- and step-count-normalised,
so it stays meaningful if a future profile changes either; images per minute is derived from
it and is what the reader sees. CPU offload is disabled and gated — a run that offloads is
measuring the host as much as the GPU.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from ..config import assets_dir
from .base import RawRecord, WorkloadResult, percentile


def _prompts(prompt_file: str) -> list[str]:
    path = assets_dir() / prompt_file.replace("assets/", "")
    if path.is_file():
        data = json.loads(path.read_text())
        return [str(p) for p in (data["prompts"] if isinstance(data, dict) else data)]
    # Project-owned fallback so a source checkout can still exercise the path. The official
    # container ships the pinned set, and its hash is recorded in the profile.
    return [
        "a cross-section diagram of a mechanical watch movement, technical illustration, white background",
        "an aerial photograph of a container terminal at dawn, long shadows, high detail",
        "a still life of laboratory glassware on a steel bench, soft directional light",
    ]


def load_pipeline(model_path: Path, flags: dict[str, Any], progress=None):
    """Build the pinned diffusers pipeline. Returns (pipeline, load_seconds)."""
    import torch
    from diffusers import AutoPipelineForText2Image

    started = time.perf_counter()
    dtype = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }.get(str(flags.get("torch_dtype", "float16")), torch.float16)

    if progress:
        progress("Loading the diffusion pipeline")

    pipeline = AutoPipelineForText2Image.from_pretrained(
        str(model_path), torch_dtype=dtype, use_safetensors=True,
    )
    pipeline = pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)

    if flags.get("enable_attention_slicing"):
        pipeline.enable_attention_slicing()
    if flags.get("enable_vae_slicing"):
        pipeline.enable_vae_slicing()
    if flags.get("enable_model_cpu_offload"):
        pipeline.enable_model_cpu_offload()

    return pipeline, time.perf_counter() - started


def run_workload(
    pipeline, workload: dict[str, Any], flags: dict[str, Any],
    sample_output: Path | None = None, progress=None,
) -> WorkloadResult:
    import torch

    config = dict(workload["config"])
    workload_id = str(workload["id"])
    result = WorkloadResult(id=workload_id, kind=str(workload["kind"]), status="passed", config=config)

    prompts = _prompts(str(config["prompt_file"]))
    seeds = [int(s) for s in config.get("seeds", [0])]
    steps = int(config["steps"])
    width, height = int(config["width"]), int(config["height"])
    guidance = float(config["guidance_scale"])
    batch = int(config.get("batch_size", 1))
    measured = int(workload.get("measured_requests", 12))

    def generate(prompt: str, seed: int):
        generator = torch.Generator(device="cuda").manual_seed(seed)
        return pipeline(
            prompt=prompt,
            num_inference_steps=steps,
            guidance_scale=guidance,
            width=width,
            height=height,
            num_images_per_prompt=batch,
            generator=generator,
        )

    try:
        # One untimed warm-up: the first generation pays for autotuning and kernel
        # compilation, and including it would make the result depend on cache state.
        warmup = int(workload.get("warmup_requests", 1))
        for _ in range(warmup):
            if progress:
                progress(f"{workload_id}: warm-up generation")
            generate(prompts[0], seeds[0])
        torch.cuda.synchronize()

        records: list[RawRecord] = []
        saved = False

        for index in range(measured):
            prompt = prompts[index % len(prompts)]
            seed = seeds[index % len(seeds)]
            if progress:
                progress(f"{workload_id}: image {index + 1}/{measured}")

            torch.cuda.synchronize()
            started = time.perf_counter()
            output = generate(prompt, seed)
            torch.cuda.synchronize()
            duration = time.perf_counter() - started

            records.append(RawRecord(
                workload=workload_id, index=index, ok=True,
                duration_s=round(duration, 5), steps=steps, seed=seed,
            ))

            if sample_output and not saved:
                # One compressed sample per run: enough to confirm the pipeline produced a
                # real image, small enough not to dominate the evidence budget.
                output.images[0].save(sample_output, format="WEBP", quality=80, method=4)
                saved = True

        durations = [r.duration_s for r in records if r.duration_s is not None]
        mean = sum(durations) / len(durations) if durations else 0.0

        result.metrics = {
            "seconds_per_step_s": round(mean / steps, 6) if steps else None,
            "throughput_img_min": round(60.0 / mean * batch, 4) if mean > 0 else None,
            "generation_p50_s": percentile(durations, 50),
            "generation_p95_s": percentile(durations, 95),
            "error_ratio": 0.0,
            "offload_ratio": 1.0 if flags.get("enable_model_cpu_offload") else 0.0,
        }
        result.records = records
        result.requests = len(records)

    except Exception as exc:
        result.status = "oom" if "out of memory" in str(exc).lower() else "failed"
        result.failure_reason = f"{type(exc).__name__}: {exc}"[:300]

    return result
