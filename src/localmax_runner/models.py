"""Model acquisition.

Weights are pulled into a shared content cache and verified against the hashes pinned in the
profile. Model licences forbid redistributing most weights inside a container image, so they
are fetched at run time; recording the exact revision is what keeps the result comparable.
"""

from __future__ import annotations

import os
from pathlib import Path

from .canonical import sha256_file
from .config import paths
from .profiles import Profile, ProfileError


class ModelError(Exception):
    pass


def cache_dir() -> Path:
    directory = paths().models
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def local_path(profile: Profile) -> Path:
    repo = str(profile["model"]["repository"]).replace("/", "--")
    revision = str(profile["model"]["revision"])[:12]
    return cache_dir() / f"{repo}@{revision}"


def download(profile: Profile, progress=None) -> Path:
    """Fetch the pinned model revision into the cache, then verify every pinned hash."""
    model = profile["model"]
    revision = str(model["revision"])
    target = local_path(profile)

    if revision == "PENDING":
        # A release candidate has no frozen revision yet. Tracking the default branch is the
        # only option, and the resulting run is explicitly not reproducible.
        revision = "main"

    if not target.exists():
        try:
            from huggingface_hub import snapshot_download
        except ImportError as exc:  # pragma: no cover
            raise ModelError(
                "huggingface_hub is required to download model weights. It is preinstalled "
                "in the official containers; install it with `pip install huggingface_hub`."
            ) from exc

        if progress:
            progress(f"Downloading {model['repository']} @ {revision[:12]}")

        snapshot_download(
            repo_id=str(model["repository"]),
            revision=revision,
            local_dir=str(target),
            token=os.environ.get("HF_TOKEN") or None,
            max_workers=4,
            # Weights only; the cache is shared and duplicated blobs are expensive.
            ignore_patterns=["*.msgpack", "*.h5", "*.onnx", "*.pth", "original/*"],
        )

    verify(profile, target, progress)
    return target


def verify(profile: Profile, root: Path, progress=None) -> None:
    """Check every file hash the profile pins.

    An empty `files` list means the profile has not been frozen yet, so there is nothing to
    check — and the run is marked as a release candidate elsewhere rather than pretending
    the weights were verified.
    """
    files = profile["model"].get("files") or []
    if not files:
        return

    for entry in files:
        path = root / entry["path"]
        if not path.is_file():
            raise ModelError(f"Model file missing from the cache: {entry['path']}")
        if progress:
            progress(f"Verifying {entry['path']}")
        digest, size = sha256_file(path)
        if digest != entry["hash"]:
            raise ModelError(
                f"{entry['path']} does not match the hash pinned by profile "
                f"{profile.id}. Delete the cache entry and download it again."
            )
        if size != entry["size_bytes"]:
            raise ModelError(f"{entry['path']} is {size} bytes; the profile pins {entry['size_bytes']}.")


def resolved_revision(profile: Profile, root: Path) -> str:
    """The revision actually on disk, for the manifest.

    Falls back to a synthetic value for an unfrozen profile so the manifest still validates,
    while the release-candidate warning makes clear what that means.
    """
    revision = str(profile["model"]["revision"])
    if revision != "PENDING":
        return revision

    ref = root / ".huggingface" / "download" / "refs" / "main"
    for candidate in (ref, root / "refs" / "main"):
        try:
            text = candidate.read_text().strip()
            if len(text) == 40:
                return text
        except OSError:
            continue
    raise ProfileError(
        f"Profile {profile.id} pins no model revision and none could be resolved from the "
        "download. This profile is not yet runnable for a publishable result."
    )
