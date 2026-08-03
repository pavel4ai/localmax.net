#!/usr/bin/env python3
"""Create new benchmark profile files from the tier/lane matrix.

This is a scaffolding tool, not a build step. It writes a profile only when the file does
not already exist, and it refuses outright to touch a profile whose `frozen` flag is true.
Profiles are hand-maintained after creation; regenerating a released profile would silently
invalidate every comparison built on it.

    python scripts/scaffold_profiles.py [--force-unfrozen]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILES = ROOT / "benchmarks" / "profiles"
TEMPLATE = PROFILES / "llm-entry-base.json"

GB = 1024**3

# tier -> (min_vram_bytes, min_ram_bytes, gpu_counts, architectures, platforms)
TIERS = {
    "entry": (12 * GB, 16 * GB, [1], ["ampere", "ada", "blackwell", "blackwell-gb10", "hopper"]),
    "enthusiast": (24 * GB, 32 * GB, [1], ["ampere", "ada", "blackwell", "blackwell-gb10", "hopper"]),
    "frontier": (64 * GB, 64 * GB, [1, 2], ["blackwell", "blackwell-gb10", "hopper"]),
}

LANES = {
    "base": ("bf16", "BF16", ["ampere", "ada", "blackwell", "blackwell-gb10", "hopper"]),
    "int4": ("int4_awq", "INT4", ["ampere", "ada", "blackwell", "blackwell-gb10", "hopper"]),
    "nvfp4": ("nvfp4", "NVFP4", ["blackwell", "blackwell-gb10"]),
}

# (category, tier, lane) -> model spec
MODELS: dict[tuple[str, str, str], dict] = {
    ("llm", "entry", "int4"): {
        "repository": "Qwen/Qwen3-8B-AWQ", "parameters_b": 8.0,
        "weights_bytes": 5 * GB, "license": "Apache-2.0",
    },
    ("llm", "entry", "nvfp4"): {
        "repository": "nvidia/Qwen3-8B-NVFP4", "parameters_b": 8.0,
        "weights_bytes": 5 * GB, "license": "Apache-2.0",
    },
    ("llm", "enthusiast", "base"): {
        "repository": "Qwen/Qwen3-8B", "parameters_b": 8.0,
        "weights_bytes": 16 * GB, "license": "Apache-2.0",
    },
    ("llm", "enthusiast", "int4"): {
        "repository": "Qwen/Qwen3-32B-AWQ", "parameters_b": 32.0,
        "weights_bytes": 18 * GB, "license": "Apache-2.0",
    },
    ("llm", "enthusiast", "nvfp4"): {
        "repository": "nvidia/Qwen3-32B-NVFP4", "parameters_b": 32.0,
        "weights_bytes": 18 * GB, "license": "Apache-2.0",
    },
    ("llm", "frontier", "base"): {
        "repository": "Qwen/Qwen3-32B", "parameters_b": 32.0,
        "weights_bytes": 64 * GB, "license": "Apache-2.0",
    },
    ("llm", "frontier", "int4"): {
        "repository": "Qwen/Qwen2.5-72B-Instruct-AWQ", "parameters_b": 72.0,
        "weights_bytes": 40 * GB, "license": "Qwen",
    },
    ("llm", "frontier", "nvfp4"): {
        "repository": "nvidia/Qwen2.5-72B-Instruct-NVFP4", "parameters_b": 72.0,
        "weights_bytes": 40 * GB, "license": "Qwen",
    },
    ("vision", "entry", "base"): {
        "repository": "Qwen/Qwen3-VL-4B-Instruct", "parameters_b": 4.0,
        "weights_bytes": 9 * GB, "license": "Apache-2.0",
    },
    ("vision", "enthusiast", "base"): {
        "repository": "Qwen/Qwen3-VL-8B-Instruct", "parameters_b": 8.0,
        "weights_bytes": 17 * GB, "license": "Apache-2.0",
    },
    ("vision", "frontier", "base"): {
        "repository": "Qwen/Qwen3-VL-32B-Instruct", "parameters_b": 32.0,
        "weights_bytes": 66 * GB, "license": "Apache-2.0",
    },
    ("diffusion", "entry", "base"): {
        "repository": "stabilityai/stable-diffusion-xl-base-1.0", "parameters_b": 3.5,
        "weights_bytes": 7 * GB, "license": "CreativeML-Open-RAIL-M++",
    },
    ("diffusion", "enthusiast", "base"): {
        "repository": "stabilityai/stable-diffusion-3.5-large", "parameters_b": 8.1,
        "weights_bytes": 17 * GB, "license": "Stability-Community",
    },
    ("diffusion", "frontier", "base"): {
        "repository": "black-forest-labs/FLUX.1-schnell", "parameters_b": 12.0,
        "weights_bytes": 24 * GB, "license": "Apache-2.0",
    },
}

# Which profiles ship at launch. Everything else is scaffolded but unpublished.
LAUNCH_SET = {
    ("llm", "entry", "base"), ("llm", "entry", "int4"),
    ("llm", "enthusiast", "base"), ("llm", "enthusiast", "int4"),
    ("llm", "frontier", "base"),
    ("vision", "entry", "base"), ("vision", "enthusiast", "base"),
    ("diffusion", "entry", "base"), ("diffusion", "enthusiast", "base"),
}

CATEGORY_LABEL = {"llm": "LLM", "vision": "Vision", "diffusion": "Diffusion"}
TIER_LABEL = {"entry": "Entry", "enthusiast": "Enthusiast", "frontier": "Frontier"}

VISION_TASKS = ["ocr", "chart", "document", "description", "reasoning"]


def vision_workloads() -> list[dict]:
    return [
        {
            "id": f"vision_{task}",
            "kind": "vision_task",
            "required_for_rank": True,
            "warmup_requests": 2,
            "measured_requests": 20,
            "timeout_s": 900,
            "config": {
                "task": task,
                "image_set": f"assets/vision/{task}",
                "image_long_edge_px": 1080,
                "prompt_file": f"assets/vision/{task}/prompt.txt",
                "max_output_tokens": 256,
                "concurrency": 1,
                "temperature": 0,
                "deterministic_gate": task in ("ocr", "chart", "document"),
            },
        }
        for task in VISION_TASKS
    ] + [
        {
            "id": "vision_throughput",
            "kind": "vision_task",
            "required_for_rank": True,
            "warmup_requests": 4,
            "measured_requests": 40,
            "timeout_s": 900,
            "config": {
                "task": "description",
                "image_set": "assets/vision/description",
                "image_long_edge_px": 1080,
                "prompt_file": "assets/vision/description/prompt.txt",
                "max_output_tokens": 128,
                "concurrency": 2,
                "temperature": 0,
                "deterministic_gate": False,
            },
        }
    ]


def diffusion_workloads() -> list[dict]:
    return [
        {
            "id": "t2i_1024",
            "kind": "diffusion_t2i",
            "required_for_rank": True,
            "warmup_requests": 1,
            "measured_requests": 12,
            "timeout_s": 1800,
            "config": {
                "width": 1024,
                "height": 1024,
                "steps": 30,
                "scheduler": "DPMSolverMultistep",
                "guidance_scale": 5.0,
                "batch_size": 1,
                "prompt_file": "assets/diffusion/prompts.json",
                "seeds": [1101, 2202, 3303, 4404],
                "vae_precision": "fp16",
                "attention": "sdpa",
                "cpu_offload": False,
                "compile": False,
            },
        }
    ]


def build(category: str, tier: str, lane: str, template: dict) -> dict:
    precision, lane_label, lane_archs = LANES[lane]
    min_vram, min_ram, gpu_counts, tier_archs = TIERS[tier]
    model = MODELS[(category, tier, lane)]
    archs = [a for a in tier_archs if a in lane_archs]

    p = json.loads(json.dumps(template))  # deep copy
    p["id"] = f"{category}-{tier}-{lane}"
    p["version"] = "0.1.0"
    p["frozen"] = False
    p["published"] = False
    p["category"] = category
    p["tier"] = tier
    p["lane"] = lane
    p["display_name"] = f"{CATEGORY_LABEL[category]} · {TIER_LABEL[tier]} · {lane_label}"

    p["requirements"].update(
        {
            "min_vram_bytes": min_vram,
            "min_system_ram_bytes": min_ram,
            "min_disk_bytes": max(3 * model["weights_bytes"], 32 * GB),
            "architectures": archs,
            "gpu_count": gpu_counts,
            "expected_download_bytes": model["weights_bytes"],
        }
    )
    if lane == "nvfp4":
        p["requirements"]["min_compute_capability"] = "12.0"

    p["model"] = {
        "repository": model["repository"],
        "revision": "PENDING",
        "precision": precision,
        "parameters_b": model["parameters_b"],
        "weights_bytes": model["weights_bytes"],
        "license": model["license"],
        "files": [],
    }

    if category == "diffusion":
        p["runtime"] = {
            "name": "diffusers",
            "version": "PENDING",
            "harness": "diffusion-adapter",
            "harness_version": "PENDING",
            "server_ready_timeout_s": 900,
            "flags": {
                "torch_dtype": "float16" if precision in ("fp16", "bf16") else precision,
                "enable_attention_slicing": False,
                "enable_vae_slicing": False,
                "enable_model_cpu_offload": False,
                "torch_compile": False,
            },
            "flag_overrides_allowed": [],
        }
        p["workloads"] = diffusion_workloads()
        p["ranking"] = {
            "metric": "seconds_per_step_s",
            "unit": "s/step",
            "direction": "lower_is_better",
            "source_workload": "t2i_1024",
            "secondary": [
                {"metric": "throughput_img_min", "label": "Images / min", "unit": "img/min",
                 "direction": "higher_is_better", "source_workload": "t2i_1024"},
                {"metric": "generation_p50_s", "label": "Per image p50", "unit": "s",
                 "direction": "lower_is_better", "source_workload": "t2i_1024"},
                {"metric": "generation_p95_s", "label": "Per image p95", "unit": "s",
                 "direction": "lower_is_better", "source_workload": "t2i_1024"},
                {"metric": "energy_per_image_j", "label": "Energy / image", "unit": "J",
                 "direction": "lower_is_better", "source_workload": "t2i_1024"},
                {"metric": "model_load_s", "label": "Pipeline load", "unit": "s",
                 "direction": "lower_is_better", "source_workload": "t2i_1024"},
            ],
            "gates": [
                {"metric": "error_ratio", "comparator": "lte", "value": 0.0,
                 "source_workload": "t2i_1024", "reason": "Any failed generation invalidates the measurement."},
                {"metric": "offload_ratio", "comparator": "lte", "value": 0.0,
                 "source_workload": "t2i_1024",
                 "reason": "CPU offload turns this into a system benchmark and is not comparable."},
            ],
        }
        p["validation"]["required_artifacts"] = [
            "raw_records", "telemetry", "system_report", "adapter_log", "sample_image",
        ]
        p["validation"]["plausibility"] = {
            "seconds_per_step_s": {"min": 0.001, "max": 120},
            "throughput_img_min": {"min": 0.01, "max": 600},
            "vram_peak_bytes": {"min": 1 * GB, "max": 192 * GB},
            "power_avg_w": {"min": 5, "max": 1200},
        }
        p["notes"] = [
            "Release candidate. Model revision and diffusers version are PENDING until the bake-off.",
            "Ranked on seconds per denoising step: it is resolution- and step-count-normalised, so it stays comparable if a future profile changes step count. Images per minute is derived from it and is the headline shown to readers.",
            "Diffusion is compute-bound where the LLM profiles are bandwidth-bound. This is deliberate: it is the counterweight that stops the site being one memory-bandwidth chart in three costumes.",
            "CPU offload is disabled and gated. A run that offloads is published but never ranked, because it measures the host as much as the GPU.",
        ]

    elif category == "vision":
        p["workloads"] = vision_workloads()
        p["runtime"]["flags"]["limit-mm-per-prompt"] = "image=1"
        p["runtime"]["flags"]["max-model-len"] = 32768
        p["ranking"] = {
            "metric": "throughput_img_min",
            "unit": "img/min",
            "direction": "higher_is_better",
            "source_workload": "vision_throughput",
            "secondary": [
                {"metric": "ttft_p50_ms", "label": "TTFT p50", "unit": "ms",
                 "direction": "lower_is_better", "source_workload": "vision_throughput"},
                {"metric": "ttft_p95_ms", "label": "TTFT p95", "unit": "ms",
                 "direction": "lower_is_better", "source_workload": "vision_throughput"},
                {"metric": "e2e_latency_p50_ms", "label": "End to end p50", "unit": "ms",
                 "direction": "lower_is_better", "source_workload": "vision_throughput"},
                {"metric": "decode_throughput_tok_s", "label": "Decode", "unit": "tok/s",
                 "direction": "higher_is_better", "source_workload": "vision_throughput"},
                {"metric": "image_prefill_p50_ms", "label": "Image encode p50", "unit": "ms",
                 "direction": "lower_is_better", "source_workload": "vision_throughput"},
                {"metric": "energy_per_image_j", "label": "Energy / image", "unit": "J",
                 "direction": "lower_is_better", "source_workload": "vision_throughput"},
            ],
            "gates": [
                {"metric": "quality_gate_pct", "comparator": "gte", "value": 90.0,
                 "source_workload": "vision_throughput",
                 "reason": "Deterministic OCR, chart and document answers must be at least 90% correct. A fast but wrong system is not ranked."},
                {"metric": "error_ratio", "comparator": "lte", "value": 0.0,
                 "source_workload": "vision_throughput", "reason": "Any failed request invalidates the measurement."},
            ],
        }
        p["validation"]["required_artifacts"] = [
            "raw_records", "telemetry", "system_report", "runtime_log", "quality_report",
        ]
        p["validation"]["plausibility"] = {
            "throughput_img_min": {"min": 0.01, "max": 10000},
            "ttft_p50_ms": {"min": 1, "max": 120000},
            "vram_peak_bytes": {"min": 1 * GB, "max": 192 * GB},
            "power_avg_w": {"min": 5, "max": 1200},
        }
        p["notes"] = [
            "Release candidate. Model revision, vLLM version and AIPerf commit are PENDING until the bake-off.",
            "Headline is images per minute at concurrency 2, which is what a reader actually wants to know.",
            "Quality is a gate, not a score. OCR, chart and document tasks have deterministic expected answers; description and reasoning are collected but never scored until a stable evaluator exists.",
            "Image encode time is separated from prompt prefill so the vision tower cost is visible.",
        ]

    else:  # llm
        p["runtime"]["flags"]["tensor-parallel-size"] = 1
        if tier == "frontier":
            p["runtime"]["flags"]["max-model-len"] = 32768
            p["notes"] = [
                "Release candidate. Model revision, vLLM version and AIPerf commit are PENDING until the bake-off.",
                "A 32B at BF16 is roughly 64 GB, which fits both a DGX Spark and a 2x96 GB workstation. A 70B BF16 baseline was rejected because it would exclude DGX Spark from its own tier.",
                "Both 1 and 2 GPU results are accepted, ranked separately. Tensor parallelism is recorded as a comparability key.",
                "RTX PRO 6000 Blackwell has no NVLink, so a 2-GPU result there communicates over PCIe. PCIe generation and width are recorded and shown on the result page.",
            ]
        else:
            p["notes"] = [
                "Release candidate. Model revision, vLLM version and AIPerf commit are PENDING until the bake-off.",
                "Decode and prefill throughput are reported separately: decode tracks memory bandwidth, prefill tracks compute.",
                f"{lane_label} lane. Ranked only against other {lane_label} results, because comparing precisions would compare different numerical workloads.",
            ]

    if (category, tier, lane) in LAUNCH_SET:
        p["published"] = False  # flipped on once two independent verified results exist
    return p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force-unfrozen", action="store_true",
                    help="Overwrite existing profiles that are not frozen.")
    args = ap.parse_args()

    template = json.loads(TEMPLATE.read_text())
    written, skipped = [], []

    for (category, tier, lane) in MODELS:
        path = PROFILES / f"{category}-{tier}-{lane}.json"
        if path.exists():
            existing = json.loads(path.read_text())
            if existing.get("frozen"):
                skipped.append(f"{path.name} (frozen)")
                continue
            if not args.force_unfrozen:
                skipped.append(f"{path.name} (exists)")
                continue
        profile = build(category, tier, lane, template)
        path.write_text(json.dumps(profile, indent=2) + "\n")
        written.append(path.name)

    for name in written:
        print(f"wrote    {name}")
    for name in skipped:
        print(f"skipped  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
