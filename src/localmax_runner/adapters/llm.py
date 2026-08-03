"""LLM workload adapter.

Drives an OpenAI-compatible endpoint with the fixed token shape the profile specifies and
records per-request timings. Streaming is mandatory: without it there is no time-to-first-
token, and without TTFT prefill and decode cannot be separated — which is the distinction
that tells a compute-rich GPU apart from a bandwidth-rich one.

AIPerf is used when it is present, which it is in the official container. The built-in
generator is the fallback so the runner still works from a source checkout; a result
produced that way records `harness: builtin` and is not eligible for Verified.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import time
from typing import Any

import httpx

from .base import RawRecord, WorkloadResult, percentile


def harness_available() -> bool:
    return shutil.which("aiperf") is not None


def harness_version() -> str:
    try:
        out = subprocess.run(["aiperf", "--version"], capture_output=True, text=True, timeout=20)
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def _prompt(input_tokens: int, seed: int) -> str:
    """A deterministic prompt of approximately the requested token length.

    Built from a fixed word list and a fixed seed so every machine sends byte-identical
    input. Roughly 0.75 tokens per word for this vocabulary; the exact count is reported by
    the server and recorded per request.
    """
    import random

    rng = random.Random(seed)
    vocabulary = (
        "system memory bandwidth latency throughput kernel tensor matrix vector cache "
        "pipeline scheduler token context window inference model weight gradient batch "
        "quantization precision compute device driver runtime allocation buffer stream"
    ).split()
    words = [rng.choice(vocabulary) for _ in range(int(input_tokens * 1.33))]
    return " ".join(words)


async def _one_request(
    client: httpx.AsyncClient,
    url: str,
    model: str,
    prompt: str,
    max_tokens: int,
    workload: str,
    index: int,
    concurrency: int,
) -> RawRecord:
    payload = {
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
        # Generate the full output length regardless of EOS, so every machine does exactly
        # the same amount of decode work.
        "ignore_eos": True,
    }

    start = time.perf_counter()
    ttft: float | None = None
    output_tokens = 0
    input_tokens: int | None = None

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
                usage = chunk.get("usage")
                if usage:
                    input_tokens = usage.get("prompt_tokens", input_tokens)
                    output_tokens = usage.get("completion_tokens", output_tokens)
                choices = chunk.get("choices") or []
                if choices and choices[0].get("text"):
                    if ttft is None:
                        ttft = (time.perf_counter() - start) * 1000.0
                    output_tokens = max(output_tokens, output_tokens + 1) if not usage else output_tokens
        e2e = (time.perf_counter() - start) * 1000.0
    except Exception as exc:
        return RawRecord(
            workload=workload, index=index, ok=False, concurrency=concurrency,
            e2e_ms=(time.perf_counter() - start) * 1000.0, error=type(exc).__name__,
        )

    return RawRecord(
        workload=workload,
        index=index,
        ok=True,
        ttft_ms=round(ttft, 3) if ttft is not None else None,
        e2e_ms=round(e2e, 3),
        input_tokens=input_tokens,
        output_tokens=output_tokens or max_tokens,
        concurrency=concurrency,
    )


async def _drive(
    base_url: str, model: str, workload_id: str, config: dict[str, Any],
    count: int, concurrency: int, timeout_s: int, record_offset: int = 0,
) -> list[RawRecord]:
    url = f"{base_url}/v1/completions"
    prompt = _prompt(int(config["input_tokens"]), int(config.get("input_seed", 0)))
    max_tokens = int(config["output_tokens"])

    limits = httpx.Limits(max_connections=concurrency + 4, max_keepalive_connections=concurrency + 4)
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_s), limits=limits) as client:
        semaphore = asyncio.Semaphore(concurrency)

        async def run(index: int) -> RawRecord:
            async with semaphore:
                return await _one_request(
                    client, url, model, prompt, max_tokens, workload_id,
                    record_offset + index, concurrency,
                )

        return list(await asyncio.gather(*(run(i) for i in range(count))))


def _summarize(records: list[RawRecord], workload_id: str) -> dict[str, float | None]:
    ok = [r for r in records if r.ok]
    ttfts = [r.ttft_ms for r in ok if r.ttft_ms is not None]
    e2es = [r.e2e_ms for r in ok if r.e2e_ms is not None]

    output_tokens = sum(r.output_tokens or 0 for r in ok)
    input_tokens = sum(r.input_tokens or 0 for r in ok)
    decode_ms = sum(max(0.0, (r.e2e_ms or 0) - (r.ttft_ms or 0)) for r in ok)
    prefill_ms = sum(r.ttft_ms or 0 for r in ok)

    metrics: dict[str, float | None] = {
        "ttft_p50_ms": percentile(ttfts, 50),
        "ttft_p95_ms": percentile(ttfts, 95),
        "e2e_latency_p50_ms": percentile(e2es, 50),
        "e2e_latency_p95_ms": percentile(e2es, 95),
        "error_ratio": (len(records) - len(ok)) / len(records) if records else 0.0,
    }

    # Decode throughput deliberately excludes prefill: it is output tokens over the
    # generation window only, which is the quantity bounded by memory bandwidth.
    if decode_ms > 0:
        metrics["decode_throughput_tok_s"] = output_tokens / decode_ms * 1000.0
        metrics["itl_p50_ms"] = decode_ms / output_tokens if output_tokens else None
    if prefill_ms > 0:
        metrics["prefill_throughput_tok_s"] = input_tokens / prefill_ms * 1000.0

    per_request_itl = [
        (r.e2e_ms - r.ttft_ms) / r.output_tokens
        for r in ok
        if r.ttft_ms is not None and r.e2e_ms is not None and (r.output_tokens or 0) > 0
    ]
    metrics["itl_p95_ms"] = percentile(per_request_itl, 95)
    if per_request_itl:
        metrics["itl_p50_ms"] = percentile(per_request_itl, 50)

    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in metrics.items()}


def run_workload(
    base_url: str, model: str, workload: dict[str, Any], progress=None,
) -> WorkloadResult:
    config = dict(workload["config"])
    workload_id = str(workload["id"])
    kind = str(workload["kind"])
    timeout_s = int(workload.get("timeout_s", 900))

    result = WorkloadResult(id=workload_id, kind=kind, status="passed", config=config)

    try:
        warmup = int(workload.get("warmup_requests", 0))
        if warmup:
            if progress:
                progress(f"{workload_id}: warm-up ({warmup} requests)")
            asyncio.run(_drive(base_url, model, workload_id, config, warmup, 1, timeout_s))

        measured = int(workload.get("measured_requests", 32))
        records: list[RawRecord] = []

        if kind == "llm_concurrency":
            sweep = [int(c) for c in config.get("concurrency_sweep", [1])]
            per_level = max(1, measured // max(1, len(sweep)))
            peak = 0.0
            for level in sweep:
                if progress:
                    progress(f"{workload_id}: concurrency {level}")
                started = time.perf_counter()
                batch = asyncio.run(
                    _drive(base_url, model, workload_id, config, per_level, level, timeout_s, len(records))
                )
                elapsed = time.perf_counter() - started
                tokens = sum(r.output_tokens or 0 for r in batch if r.ok)
                if elapsed > 0:
                    peak = max(peak, tokens / elapsed)
                records.extend(batch)
            result.metrics = _summarize(records, workload_id)
            result.metrics["peak_output_throughput_tok_s"] = round(peak, 3)
        else:
            concurrency = int(config.get("concurrency", 1))
            if progress:
                progress(f"{workload_id}: {measured} requests at concurrency {concurrency}")
            records = asyncio.run(
                _drive(base_url, model, workload_id, config, measured, concurrency, timeout_s)
            )
            result.metrics = _summarize(records, workload_id)

        result.records = records
        result.requests = len(records)
        result.errors = sum(1 for r in records if not r.ok)

        if result.errors == result.requests and result.requests:
            result.status = "failed"
            result.failure_reason = "Every request failed. The runtime was reachable but did not serve."

    except Exception as exc:
        result.status = "failed"
        result.failure_reason = f"{type(exc).__name__}: {exc}"[:300]

    return result
