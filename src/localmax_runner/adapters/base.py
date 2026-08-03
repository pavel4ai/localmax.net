"""Shared adapter types and statistics."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class RawRecord:
    """One request or generation. The atom every published metric is derived from."""

    workload: str
    index: int
    ok: bool
    ttft_ms: float | None = None
    e2e_ms: float | None = None
    duration_s: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    steps: int | None = None
    concurrency: int | None = None
    task: str | None = None
    correct: bool | None = None
    seed: int | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class WorkloadResult:
    id: str
    kind: str
    status: str
    config: dict[str, Any]
    metrics: dict[str, float | None] = field(default_factory=dict)
    requests: int = 0
    errors: int = 0
    failure_reason: str | None = None
    records: list[RawRecord] = field(default_factory=list)

    def to_manifest(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "config": self.config,
            "requests": self.requests,
            "errors": self.errors,
            "metrics": {k: v for k, v in self.metrics.items() if v is not None},
        }
        if self.failure_reason:
            out["failure_reason"] = self.failure_reason[:300]
        return out


def percentile(values: list[float], p: float) -> float | None:
    """Linear-interpolation percentile, matching the server's implementation exactly.

    Both sides must agree, because a mismatch here would look like a fabricated metric.
    """
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (p / 100.0) * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def write_records(path: Path, results: list[WorkloadResult]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as handle:
        for result in results:
            for record in result.records:
                handle.write(json.dumps(record.to_json(), separators=(",", ":")) + "\n")
