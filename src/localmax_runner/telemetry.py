"""GPU telemetry sampling.

Runs on a background thread for the whole measured window and writes one NDJSON record per
sample. Two things matter for trust: the sample interval is fixed by the profile, and the
coverage figure reports honestly how much of the run was actually observed — a result with
gaps cannot reach Verified.

The power domain is recorded explicitly. A discrete board and a GB10 SoC module are
different physical quantities, and conflating them would silently corrupt every efficiency
comparison on the site.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import pynvml

    _NVML = True
except Exception:  # pragma: no cover
    _NVML = False

import psutil


@dataclass
class TelemetrySummary:
    power_domain: str = "unavailable"
    coverage_pct: float = 0.0
    sample_interval_ms: int = 100
    samples: int = 0
    power_avg_w: float | None = None
    power_peak_w: float | None = None
    energy_j: float | None = None
    vram_peak_bytes: int = 0
    system_ram_peak_bytes: int = 0
    gpu_util_avg_pct: float | None = None
    temperature_peak_c: float | None = None
    throttle: dict[str, int] = field(default_factory=lambda: {
        "thermal_count": 0, "power_count": 0, "reliability_count": 0,
    })

    def to_manifest(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "power_domain": self.power_domain,
            "coverage_pct": round(self.coverage_pct, 2),
            "sample_interval_ms": self.sample_interval_ms,
            "samples": self.samples,
            "vram_peak_bytes": self.vram_peak_bytes,
            "system_ram_peak_bytes": self.system_ram_peak_bytes,
            "throttle_events": dict(self.throttle),
        }
        for key in ("power_avg_w", "power_peak_w", "energy_j", "gpu_util_avg_pct", "temperature_peak_c"):
            value = getattr(self, key)
            if value is not None:
                out[key] = round(value, 2)
        return out


class TelemetrySampler:
    """Background NVML sampler. Use as a context manager around the measured window."""

    def __init__(self, output: Path, interval_ms: int = 100, memory_type: str = "discrete") -> None:
        self.output = output
        self.interval_s = max(0.01, interval_ms / 1000.0)
        self.interval_ms = interval_ms
        self.memory_type = memory_type
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._samples: list[dict[str, Any]] = []
        self._started_at = 0.0
        self._stopped_at = 0.0
        self._error: str | None = None

    def __enter__(self) -> TelemetrySampler:
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def start(self) -> None:
        self._started_at = time.monotonic()
        self._thread = threading.Thread(target=self._loop, name="localmax-telemetry", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        self._stopped_at = time.monotonic()
        self._write()

    def _loop(self) -> None:
        if not _NVML:
            self._error = "NVML unavailable"
            return
        try:
            pynvml.nvmlInit()
            handles = [
                pynvml.nvmlDeviceGetHandleByIndex(i) for i in range(pynvml.nvmlDeviceGetCount())
            ]
        except Exception as exc:  # pragma: no cover
            self._error = str(exc)
            return

        try:
            while not self._stop.is_set():
                tick = time.monotonic()
                sample: dict[str, Any] = {"t": round(tick - self._started_at, 4), "gpus": []}
                for handle in handles:
                    entry: dict[str, Any] = {}
                    try:
                        entry["power_w"] = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
                    except Exception:
                        pass
                    try:
                        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
                        entry["vram_used_bytes"] = int(memory.used)
                    except Exception:
                        pass
                    try:
                        rates = pynvml.nvmlDeviceGetUtilizationRates(handle)
                        entry["util_pct"] = int(rates.gpu)
                    except Exception:
                        pass
                    try:
                        entry["temp_c"] = int(
                            pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
                        )
                    except Exception:
                        pass
                    try:
                        reasons = pynvml.nvmlDeviceGetCurrentClocksThrottleReasons(handle)
                        entry["throttle"] = int(reasons)
                    except Exception:
                        pass
                    sample["gpus"].append(entry)

                sample["host_ram_used_bytes"] = psutil.virtual_memory().used
                self._samples.append(sample)

                elapsed = time.monotonic() - tick
                self._stop.wait(max(0.0, self.interval_s - elapsed))
        finally:
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass

    def _write(self) -> None:
        self.output.parent.mkdir(parents=True, exist_ok=True)
        with self.output.open("w") as handle:
            for sample in self._samples:
                handle.write(json.dumps(sample, separators=(",", ":")) + "\n")

    def summarize(self) -> TelemetrySummary:
        summary = TelemetrySummary(sample_interval_ms=self.interval_ms, samples=len(self._samples))
        wall = max(1e-9, self._stopped_at - self._started_at)

        if not self._samples:
            summary.coverage_pct = 0.0
            return summary

        # Coverage is the share of wall time the sampler actually observed. A sampler starved
        # by a busy host produces gaps, and a result with gaps is not Verified.
        observed = len(self._samples) * self.interval_s
        summary.coverage_pct = min(100.0, (observed / wall) * 100.0)

        summary.power_domain = "soc_module" if self.memory_type == "unified" else "gpu_board"

        power_totals: list[float] = []
        utils: list[float] = []
        energy = 0.0
        previous_t = 0.0

        for sample in self._samples:
            gpus = sample.get("gpus", [])
            watts = sum(g["power_w"] for g in gpus if "power_w" in g)
            if watts:
                power_totals.append(watts)
                energy += watts * max(0.0, sample["t"] - previous_t)
            previous_t = sample["t"]

            vram = sum(g.get("vram_used_bytes", 0) for g in gpus)
            summary.vram_peak_bytes = max(summary.vram_peak_bytes, vram)
            summary.system_ram_peak_bytes = max(
                summary.system_ram_peak_bytes, sample.get("host_ram_used_bytes", 0)
            )

            for g in gpus:
                if "util_pct" in g:
                    utils.append(float(g["util_pct"]))
                if "temp_c" in g:
                    summary.temperature_peak_c = max(summary.temperature_peak_c or 0.0, float(g["temp_c"]))
                reasons = g.get("throttle", 0)
                # NVML clock-throttle reason bitmask.
                if reasons & 0x0000000000000040:  # SW_THERMAL_SLOWDOWN
                    summary.throttle["thermal_count"] += 1
                elif reasons & 0x0000000000000080:  # HW_THERMAL_SLOWDOWN
                    summary.throttle["thermal_count"] += 1
                if reasons & 0x0000000000000004:  # SW_POWER_CAP
                    summary.throttle["power_count"] += 1
                if reasons & 0x0000000000000008:  # HW_SLOWDOWN
                    summary.throttle["reliability_count"] += 1

        if power_totals:
            summary.power_avg_w = sum(power_totals) / len(power_totals)
            summary.power_peak_w = max(power_totals)
            summary.energy_j = energy
        else:
            summary.power_domain = "unavailable"

        if utils:
            summary.gpu_util_avg_pct = sum(utils) / len(utils)

        return summary
