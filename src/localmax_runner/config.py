"""Filesystem layout and environment configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_API_URL = "https://api.localmax.net"


def home() -> Path:
    """Root of the runner's persistent state.

    Inside a container this is the mounted cache volume, so model weights and the system
    identity survive between runs and across profiles.
    """
    return Path(os.environ.get("LOCALMAX_HOME") or Path.home() / ".localmax")


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def models(self) -> Path:
        return self.root / "models"

    @property
    def runs(self) -> Path:
        return self.root / "runs"

    @property
    def identity(self) -> Path:
        return self.root / "identity.json"

    @property
    def last_run(self) -> Path:
        return self.root / "last-run"

    def run_dir(self, run_id: str) -> Path:
        return self.runs / run_id

    def ensure(self) -> None:
        for directory in (self.root, self.models, self.runs):
            directory.mkdir(parents=True, exist_ok=True)


def paths() -> Paths:
    return Paths(home())


def api_url() -> str:
    return os.environ.get("LOCALMAX_API_URL", DEFAULT_API_URL).rstrip("/")


def profiles_dir() -> Path:
    """Where the pinned profile files live.

    Baked into the image at /opt/localmax/profiles; falls back to the repository checkout so
    the CLI is usable from a source tree during development.
    """
    packaged = Path(os.environ.get("LOCALMAX_PROFILES", "/opt/localmax/profiles"))
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[2] / "benchmarks" / "profiles"


def assets_dir() -> Path:
    packaged = Path(os.environ.get("LOCALMAX_ASSETS", "/opt/localmax/assets"))
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[2] / "benchmarks" / "assets"


def container_image() -> str:
    """Image reference and digest, injected at build time by the Dockerfile."""
    return os.environ.get("LOCALMAX_IMAGE", "local/localmax-runner")


def container_digest() -> str | None:
    digest = os.environ.get("LOCALMAX_IMAGE_DIGEST")
    if digest and digest.startswith("sha256:") and len(digest) == 71:
        return digest
    return None


def platform_tag() -> str:
    import platform as _platform

    return "linux/arm64" if _platform.machine() in ("aarch64", "arm64") else "linux/amd64"
