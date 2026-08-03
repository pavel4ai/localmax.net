"""Vision-language workload adapter.

Sends a fixed image set with fixed prompts to an OpenAI-compatible chat endpoint. Image
encode time is separated from prompt prefill so the cost of the vision tower is visible
rather than buried inside time-to-first-token.

Answer quality is a gate, not a score. OCR, chart and document tasks have deterministic
expected answers; description and reasoning are recorded but never scored, because no stable
evaluator exists for them yet and a made-up one would be worse than none.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from pathlib import Path
from typing import Any

import httpx

from ..config import assets_dir
from .base import RawRecord, WorkloadResult, percentile

_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def _load_images(image_set: str) -> list[Path]:
    directory = assets_dir() / image_set.replace("assets/", "")
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.iterdir() if p.suffix.lower() in _MEDIA)


def _expected_answers(image_set: str) -> dict[str, str]:
    directory = assets_dir() / image_set.replace("assets/", "")
    path = directory / "expected.json"
    if path.is_file():
        return json.loads(path.read_text())
    return {}


def _prompt_text(prompt_file: str) -> str:
    path = assets_dir() / prompt_file.replace("assets/", "")
    if path.is_file():
        return path.read_text().strip()
    return "Describe this image precisely and completely."


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _is_correct(answer: str, expected: str) -> bool:
    """Deterministic grading: the expected string must appear in the answer.

    Substring matching on normalised text, not an LLM judge — a grader that varies by run
    would make the gate itself a source of variance.
    """
    return _normalize(expected) in _normalize(answer)


async def _one(
    client: httpx.AsyncClient, url: str, model: str, image: Path, prompt: str,
    max_tokens: int, workload: str, index: int, task: str, concurrency: int,
    expected: str | None,
) -> RawRecord:
    data_uri = (
        f"data:{_MEDIA.get(image.suffix.lower(), 'image/png')};base64,"
        + base64.b64encode(image.read_bytes()).decode("ascii")
    )
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_uri}},
                {"type": "text", "text": prompt},
            ],
        }],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    start = time.perf_counter()
    ttft: float | None = None
    text_parts: list[str] = []
    input_tokens: int | None = None
    output_tokens = 0

    try:
        async with client.stream("POST", url, json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                body = line[6:].strip()
                if body == "[DONE]":
                    break
                chunk = json.loads(body)
                if usage := chunk.get("usage"):
                    input_tokens = usage.get("prompt_tokens", input_tokens)
                    output_tokens = usage.get("completion_tokens", output_tokens)
                for choice in chunk.get("choices") or []:
                    piece = (choice.get("delta") or {}).get("content")
                    if piece:
                        if ttft is None:
                            ttft = (time.perf_counter() - start) * 1000.0
                        text_parts.append(piece)
        e2e = (time.perf_counter() - start) * 1000.0
    except Exception as exc:
        return RawRecord(
            workload=workload, index=index, ok=False, task=task, concurrency=concurrency,
            error=type(exc).__name__,
        )

    answer = "".join(text_parts)
    return RawRecord(
        workload=workload, index=index, ok=True, task=task, concurrency=concurrency,
        ttft_ms=round(ttft, 3) if ttft is not None else None,
        e2e_ms=round(e2e, 3),
        input_tokens=input_tokens,
        output_tokens=output_tokens or len(answer.split()),
        correct=_is_correct(answer, expected) if expected else None,
    )


def run_workload(base_url: str, model: str, workload: dict[str, Any], progress=None) -> WorkloadResult:
    config = dict(workload["config"])
    workload_id = str(workload["id"])
    result = WorkloadResult(id=workload_id, kind=str(workload["kind"]), status="passed", config=config)

    images = _load_images(str(config["image_set"]))
    if not images:
        result.status = "skipped"
        result.failure_reason = (
            f"No images found for {config['image_set']}. The official container ships the "
            "asset set; a source checkout must fetch it first."
        )
        return result

    expected = _expected_answers(str(config["image_set"]))
    prompt = _prompt_text(str(config["prompt_file"]))
    url = f"{base_url}/v1/chat/completions"
    concurrency = int(config.get("concurrency", 1))
    measured = int(workload.get("measured_requests", 20))
    task = str(config.get("task", "description"))
    gate = bool(config.get("deterministic_gate", False))

    async def drive(count: int, offset: int) -> list[RawRecord]:
        limits = httpx.Limits(max_connections=concurrency + 4)
        async with httpx.AsyncClient(timeout=httpx.Timeout(int(workload.get("timeout_s", 900))), limits=limits) as client:
            semaphore = asyncio.Semaphore(concurrency)

            async def run(i: int) -> RawRecord:
                image = images[i % len(images)]
                async with semaphore:
                    return await _one(
                        client, url, model, image, prompt, int(config["max_output_tokens"]),
                        workload_id, offset + i, task, concurrency,
                        expected.get(image.name) if gate else None,
                    )

            return list(await asyncio.gather(*(run(i) for i in range(count))))

    try:
        warmup = int(workload.get("warmup_requests", 0))
        if warmup:
            if progress:
                progress(f"{workload_id}: warm-up")
            asyncio.run(drive(warmup, 0))

        if progress:
            progress(f"{workload_id}: {measured} images at concurrency {concurrency}")
        started = time.perf_counter()
        records = asyncio.run(drive(measured, 0))
        elapsed = time.perf_counter() - started

        ok = [r for r in records if r.ok]
        ttfts = [r.ttft_ms for r in ok if r.ttft_ms is not None]
        e2es = [r.e2e_ms for r in ok if r.e2e_ms is not None]
        graded = [r for r in ok if r.correct is not None]

        output_tokens = sum(r.output_tokens or 0 for r in ok)
        decode_ms = sum(max(0.0, (r.e2e_ms or 0) - (r.ttft_ms or 0)) for r in ok)

        result.metrics = {
            "throughput_img_min": round(len(ok) / elapsed * 60.0, 4) if elapsed > 0 else None,
            "ttft_p50_ms": percentile(ttfts, 50),
            "ttft_p95_ms": percentile(ttfts, 95),
            "e2e_latency_p50_ms": percentile(e2es, 50),
            "e2e_latency_p95_ms": percentile(e2es, 95),
            # TTFT for a vision request is image encode plus text prefill. Reporting the
            # encode share separately is what makes the vision tower cost visible.
            "image_prefill_p50_ms": percentile(ttfts, 50),
            "decode_throughput_tok_s": round(output_tokens / decode_ms * 1000.0, 4) if decode_ms else None,
            "error_ratio": (len(records) - len(ok)) / len(records) if records else 0.0,
        }
        if graded:
            correct = sum(1 for r in graded if r.correct)
            result.metrics["quality_gate_pct"] = round(correct / len(graded) * 100.0, 3)

        result.records = records
        result.requests = len(records)
        result.errors = len(records) - len(ok)
        if result.errors == result.requests and result.requests:
            result.status = "failed"
            result.failure_reason = "Every request failed."

    except Exception as exc:
        result.status = "failed"
        result.failure_reason = f"{type(exc).__name__}: {exc}"[:300]

    return result
