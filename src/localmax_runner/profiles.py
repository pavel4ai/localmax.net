"""Profile loading and integrity.

The profile hash travels in every manifest and is recomputed independently by the API. It is
what makes "which rules were in force for this run" an answerable question, and what makes a
silently edited profile detectable rather than merely discouraged.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .canonical import canonicalize, sha256_text
from .config import profiles_dir


class ProfileError(Exception):
    pass


@dataclass
class Profile:
    data: dict[str, Any]
    hash: str
    path: Path

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    @property
    def id(self) -> str:
        return str(self.data["id"])

    @property
    def category(self) -> str:
        return str(self.data["category"])

    @property
    def requirements(self) -> dict[str, Any]:
        return self.data["requirements"]

    @property
    def workloads(self) -> list[dict[str, Any]]:
        return self.data["workloads"]

    @property
    def ranking(self) -> dict[str, Any]:
        return self.data["ranking"]

    @property
    def validation(self) -> dict[str, Any]:
        return self.data["validation"]

    def manifest_stub(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "version": self.data["version"],
            "category": self.category,
            "tier": self.data["tier"],
            "lane": self.data["lane"],
            "hash": self.hash,
            "frozen": bool(self.data.get("frozen", False)),
        }


def profile_hash(data: dict[str, Any]) -> str:
    """Hash of the canonical profile with `$schema` stripped.

    `$schema` is an editor affordance, not part of the pinned rules, so it must not change
    the hash. The API strips it identically before hashing.
    """
    payload = {k: v for k, v in data.items() if k != "$schema"}
    return sha256_text(canonicalize(payload))


def load(profile_id: str) -> Profile:
    path = profiles_dir() / f"{profile_id}.json"
    if not path.is_file():
        available = ", ".join(sorted(p.stem for p in profiles_dir().glob("*.json")))
        raise ProfileError(f"Unknown profile '{profile_id}'. Available: {available or 'none'}")
    data = json.loads(path.read_text())
    return Profile(data=data, hash=profile_hash(data), path=path)


def load_all() -> list[Profile]:
    out = []
    for path in sorted(profiles_dir().glob("*.json")):
        data = json.loads(path.read_text())
        out.append(Profile(data=data, hash=profile_hash(data), path=path))
    return out


@dataclass
class Eligibility:
    ok: bool
    reasons: list[str]
    warnings: list[str]


def check_eligibility(profile: Profile, system, gpu_count: int | None = None) -> Eligibility:
    """Can this system run this profile at all?

    Refusing early with a specific reason is much better than starting a fifteen-minute run
    that will die on an allocation failure.
    """
    reasons: list[str] = []
    warnings: list[str] = []
    req = profile.requirements
    count = gpu_count or system.gpu_count

    if system.gpu_count == 0:
        return Eligibility(False, ["No NVIDIA GPU was detected. Check the driver and --gpus all."], [])

    total_vram = sum(g.vram_bytes for g in system.gpus[:count])
    if total_vram < req["min_vram_bytes"]:
        reasons.append(
            f"Needs {req['min_vram_bytes'] / 1024**3:.0f} GB total VRAM; this system has "
            f"{total_vram / 1024**3:.1f} GB across {count} GPU(s)."
        )

    gpu = system.gpus[0]
    if gpu.architecture not in req["architectures"]:
        reasons.append(
            f"{gpu.architecture} cannot run the {profile['lane']} lane "
            f"(requires {', '.join(req['architectures'])})."
        )

    allowed_counts = req.get("gpu_count", [1])
    if count not in allowed_counts:
        reasons.append(
            f"This profile accepts {' or '.join(str(c) for c in allowed_counts)} GPU(s); "
            f"{count} were selected."
        )

    min_ram = req.get("min_system_ram_bytes", 0)
    if system.system_ram_bytes < min_ram:
        warnings.append(
            f"System RAM is {system.system_ram_bytes / 1024**3:.0f} GB; "
            f"{min_ram / 1024**3:.0f} GB is recommended."
        )

    min_disk = req.get("min_disk_bytes", 0)
    if system.free_disk_bytes and system.free_disk_bytes < min_disk:
        reasons.append(
            f"Needs {min_disk / 1024**3:.0f} GB free disk for the model cache; "
            f"{system.free_disk_bytes / 1024**3:.0f} GB available."
        )

    if system.virtualization == "wsl2":
        warnings.append(
            "Running under WSL2. This is supported but experimental, and the result is "
            "labelled as such."
        )
    if system.memory_type == "unified":
        warnings.append(
            "Unified memory system. Power is reported at the SoC module, so this result "
            "carries no efficiency figure comparable with discrete GPUs."
        )
    if str(profile["model"]["revision"]) == "PENDING":
        warnings.append(
            f"Profile {profile.id} is a release candidate ({profile['version']}); its model "
            "revision is not frozen yet and its leaderboard is provisional."
        )

    return Eligibility(not reasons, reasons, warnings)
