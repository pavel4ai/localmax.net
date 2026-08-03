"""System inspection.

Collects everything that makes a result comparable and nothing that identifies the machine.
The exclusions are as deliberate as the inclusions: no hostname, no username, no paths, no
GPU serial or board UUID, no MAC address, no environment.
"""

from __future__ import annotations

import contextlib
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psutil

try:  # pynvml ships as `nvidia-ml-py`
    import pynvml

    _NVML = True
except Exception:  # pragma: no cover - absent on a machine with no driver
    _NVML = False


# Compute capability major -> LocalMax architecture name.
_ARCH_BY_CC = {
    (8, 0): "ampere", (8, 6): "ampere", (8, 7): "ampere",
    (8, 9): "ada",
    (9, 0): "hopper",
    (10, 0): "blackwell", (12, 0): "blackwell",
    (12, 1): "blackwell-gb10",
}


@dataclass
class GpuInfo:
    name: str
    vram_bytes: int
    architecture: str
    compute_capability: str
    power_limit_w: float | None = None
    power_default_limit_w: float | None = None
    graphics_clock_max_mhz: int | None = None
    memory_clock_max_mhz: int | None = None
    pcie_gen: int | None = None
    pcie_width: int | None = None
    supports_fp8: bool = False
    supports_nvfp4: bool = False

    def to_manifest(self) -> dict[str, Any]:
        out = {
            "name": self.name,
            "vram_bytes": self.vram_bytes,
            "architecture": self.architecture,
            "compute_capability": self.compute_capability,
            "supports_fp8": self.supports_fp8,
            "supports_nvfp4": self.supports_nvfp4,
        }
        for key in (
            "power_limit_w", "power_default_limit_w", "graphics_clock_max_mhz",
            "memory_clock_max_mhz", "pcie_gen", "pcie_width",
        ):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out


@dataclass
class SystemInfo:
    gpus: list[GpuInfo] = field(default_factory=list)
    driver: str = "unknown"
    cuda: str = "unknown"
    cpu_model: str = "unknown"
    cpu_cores: int = 1
    cpu_threads: int = 1
    cpu_arch: str = "x86_64"
    system_ram_bytes: int = 0
    memory_type: str = "discrete"
    os_name: str = "unknown"
    kernel: str = "unknown"
    container_runtime: str | None = None
    virtualization: str = "none"
    free_disk_bytes: int = 0

    @property
    def gpu_count(self) -> int:
        return len(self.gpus)

    @property
    def total_vram_bytes(self) -> int:
        return sum(g.vram_bytes for g in self.gpus)

    def hardware_manifest(self, cooling: str, tuning: str, parallelism: str) -> dict[str, Any]:
        interconnect = (
            "unified" if self.memory_type == "unified"
            else "pcie" if self.gpu_count > 1
            else "none"
        )
        return {
            "gpus": [g.to_manifest() for g in self.gpus],
            "gpu_count": self.gpu_count,
            "parallelism": parallelism,
            "interconnect": interconnect,
            "cpu": {
                "model": self.cpu_model,
                "cores": self.cpu_cores,
                "threads": self.cpu_threads,
                "arch": self.cpu_arch,
            },
            "system_ram_bytes": self.system_ram_bytes,
            "memory_type": self.memory_type,
            "cooling": cooling,
            "tuning": tuning,
        }

    def software_manifest(self) -> dict[str, Any]:
        return {
            "os": self.os_name,
            "kernel": self.kernel,
            "arch": self.cpu_arch,
            "driver": self.driver,
            "cuda": self.cuda,
            "container_runtime": self.container_runtime or "unknown",
            "virtualization": self.virtualization,
        }


def _cpu_model() -> str:
    try:
        text = Path("/proc/cpuinfo").read_text()
    except OSError:
        return platform.processor() or "unknown"
    for key in ("model name", "Model", "Hardware", "cpu model"):
        match = re.search(rf"^{key}\s*:\s*(.+)$", text, re.MULTILINE)
        if match:
            return match.group(1).strip()
    return platform.processor() or "unknown"


def _os_name() -> str:
    try:
        release = Path("/etc/os-release").read_text()
        match = re.search(r'^PRETTY_NAME="?([^"\n]+)"?$', release, re.MULTILINE)
        if match:
            return match.group(1)
    except OSError:
        pass
    return f"{platform.system()} {platform.release()}"


def _virtualization() -> str:
    """Detect WSL2, which behaves differently enough to be worth labelling."""
    try:
        version = Path("/proc/version").read_text().lower()
        if "microsoft" in version or "wsl" in version:
            return "wsl2"
    except OSError:
        pass
    if Path("/sys/hypervisor/type").exists():
        return "vm"
    return "none"


def _container_runtime() -> str | None:
    if Path("/.dockerenv").exists():
        return "docker"
    try:
        if "docker" in Path("/proc/1/cgroup").read_text():
            return "docker"
    except OSError:
        pass
    return None


def _cuda_version() -> str:
    """The CUDA version the *driver* supports.

    Read from NVML rather than by shelling out to nvcc: a runtime container has no
    compiler, so the nvcc path reports "unknown" exactly where it matters most — inside the
    official image. The driver's version is also the one that governs what the inference
    runtime can do, which is what makes a result comparable.
    """
    if _NVML:
        try:
            pynvml.nvmlInit()
            try:
                raw = pynvml.nvmlSystemGetCudaDriverVersion_v2()
            except Exception:
                raw = pynvml.nvmlSystemGetCudaDriverVersion()
            pynvml.nvmlShutdown()
            return f"{raw // 1000}.{(raw % 1000) // 10}"
        except Exception:
            with contextlib.suppress(Exception):
                pynvml.nvmlShutdown()

    if shutil.which("nvcc"):
        try:
            out = subprocess.run(["nvcc", "--version"], capture_output=True, text=True, timeout=10)
            match = re.search(r"release (\d+\.\d+)", out.stdout)
            if match:
                return match.group(1)
        except Exception:
            pass
    return "unknown"


def _nvfp4_supported(major: int, minor: int) -> bool:
    # NVFP4 is a Blackwell-generation tensor core format: compute capability 10.x and 12.x.
    return major >= 10


def _fp8_supported(major: int, minor: int) -> bool:
    # FP8 arrives with Ada (8.9) and Hopper (9.0); Ampere has no FP8 unit.
    return (major, minor) >= (8, 9)


def inspect(collect_gpus: bool = True) -> SystemInfo:
    info = SystemInfo(
        cpu_model=_cpu_model(),
        cpu_cores=psutil.cpu_count(logical=False) or 1,
        cpu_threads=psutil.cpu_count(logical=True) or 1,
        cpu_arch="aarch64" if platform.machine() in ("aarch64", "arm64") else "x86_64",
        system_ram_bytes=psutil.virtual_memory().total,
        os_name=_os_name(),
        kernel=platform.release(),
        container_runtime=_container_runtime(),
        virtualization=_virtualization(),
        cuda=_cuda_version(),
    )
    with contextlib.suppress(OSError):
        info.free_disk_bytes = shutil.disk_usage("/").free

    if not collect_gpus or not _NVML:
        return info

    try:
        pynvml.nvmlInit()
    except Exception:
        return info

    try:
        driver = pynvml.nvmlSystemGetDriverVersion()
        info.driver = driver.decode() if isinstance(driver, bytes) else str(driver)

        for index in range(pynvml.nvmlDeviceGetCount()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            name = pynvml.nvmlDeviceGetName(handle)
            name = name.decode() if isinstance(name, bytes) else str(name)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            major, minor = pynvml.nvmlDeviceGetCudaComputeCapability(handle)

            gpu = GpuInfo(
                name=name,
                vram_bytes=int(memory.total),
                architecture=_ARCH_BY_CC.get((major, minor), "blackwell" if major >= 10 else "ampere"),
                compute_capability=f"{major}.{minor}",
                supports_fp8=_fp8_supported(major, minor),
                supports_nvfp4=_nvfp4_supported(major, minor),
            )

            for attr, getter, scale in (
                ("power_limit_w", pynvml.nvmlDeviceGetPowerManagementLimit, 1000.0),
                ("power_default_limit_w", pynvml.nvmlDeviceGetPowerManagementDefaultLimit, 1000.0),
            ):
                with contextlib.suppress(Exception):
                    setattr(gpu, attr, round(getter(handle) / scale, 1))
            for attr, clock in (
                ("graphics_clock_max_mhz", pynvml.NVML_CLOCK_GRAPHICS),
                ("memory_clock_max_mhz", pynvml.NVML_CLOCK_MEM),
            ):
                with contextlib.suppress(Exception):
                    setattr(gpu, attr, int(pynvml.nvmlDeviceGetMaxClockInfo(handle, clock)))
            # Max, not current: NVML reports the *negotiated* link state, which drops to
            # Gen1 x8 when the GPU is idle. Recording that would make every result look
            # like it ran in a crippled slot.
            for attr, getter in (
                ("pcie_gen", pynvml.nvmlDeviceGetMaxPcieLinkGeneration),
                ("pcie_width", pynvml.nvmlDeviceGetMaxPcieLinkWidth),
            ):
                with contextlib.suppress(Exception):
                    setattr(gpu, attr, int(getter(handle)))

            info.gpus.append(gpu)

        # GB10 and other integrated parts share system memory with the CPU, which changes
        # what VRAM, bandwidth and wattage all mean.
        if info.gpus and (
            info.cpu_arch == "aarch64"
            or info.gpus[0].architecture == "blackwell-gb10"
            or abs(info.gpus[0].vram_bytes - info.system_ram_bytes) / max(1, info.system_ram_bytes) < 0.1
        ):
            info.memory_type = "unified"
    finally:
        with contextlib.suppress(Exception):
            pynvml.nvmlShutdown()

    return info
