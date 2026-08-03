"""Manifest assembly, evidence packaging and signing."""

from __future__ import annotations

import json
import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import SCHEMA_VERSION, __version__
from .adapters.base import WorkloadResult, write_records
from .canonical import sha256_file
from .config import container_digest, container_image, platform_tag
from .identity import Identity
from .profiles import Profile
from .system import SystemInfo
from .telemetry import TelemetrySummary

_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

_MEDIA_BY_SUFFIX = {
    ".ndjson": "application/x-ndjson",
    ".json": "application/json",
    ".log": "text/plain",
    ".gz": "application/gzip",
    ".webp": "image/webp",
    ".png": "image/png",
}

_KIND_BY_NAME = {
    "records.ndjson": "raw_records",
    "telemetry.ndjson": "telemetry",
    "system.json": "system_report",
    "runtime.log": "runtime_log",
    "adapter.log": "adapter_log",
    "sample.webp": "sample_image",
    "quality.json": "quality_report",
}


def ulid(now_ms: int | None = None) -> str:
    """Crockford base32 ULID: sortable by creation time, 80 bits of randomness."""
    timestamp = int(now_ms if now_ms is not None else time.time() * 1000)
    encoded = ""
    for _ in range(10):
        encoded = _ULID_ALPHABET[timestamp % 32] + encoded
        timestamp //= 32
    return encoded + "".join(_ULID_ALPHABET[secrets.randbelow(32)] for _ in range(16))


def write_evidence(
    run_dir: Path, workloads: list[WorkloadResult], system: SystemInfo,
) -> list[dict[str, Any]]:
    """Write the evidence bundle and return its artifact descriptors."""
    run_dir.mkdir(parents=True, exist_ok=True)

    write_records(run_dir / "records.ndjson", workloads)
    (run_dir / "system.json").write_text(
        json.dumps(
            {
                "hardware": system.hardware_manifest("unknown", "unknown", "none"),
                "software": system.software_manifest(),
                "free_disk_bytes": system.free_disk_bytes,
            },
            indent=2,
        )
    )

    quality = {
        workload.id: [
            {"index": r.index, "task": r.task, "correct": r.correct}
            for r in workload.records
            if r.correct is not None
        ]
        for workload in workloads
    }
    if any(quality.values()):
        (run_dir / "quality.json").write_text(json.dumps(quality, indent=2))

    artifacts: list[dict[str, Any]] = []
    for path in sorted(run_dir.iterdir()):
        if not path.is_file() or path.name in ("manifest.json", "status.json"):
            continue
        kind = _KIND_BY_NAME.get(path.name)
        if kind is None:
            continue
        digest, size = sha256_file(path)
        if size == 0:
            continue
        artifacts.append({
            "name": path.name,
            "kind": kind,
            "hash": digest,
            "size_bytes": size,
            "media_type": _MEDIA_BY_SUFFIX.get(path.suffix, "text/plain"),
            "required": True,
        })
    return artifacts


def headline(profile: Profile, workloads: list[WorkloadResult]) -> dict[str, Any]:
    ranking = profile.ranking
    source = next((w for w in workloads if w.id == ranking["source_workload"]), None)
    value = (source.metrics.get(ranking["metric"]) if source else None) or 0.0

    secondary: dict[str, float] = {}
    for entry in ranking.get("secondary", []):
        origin = next(
            (w for w in workloads if w.id == entry.get("source_workload", ranking["source_workload"])),
            None,
        )
        metric = origin.metrics.get(entry["metric"]) if origin else None
        if isinstance(metric, (int, float)):
            secondary[entry["metric"]] = round(float(metric), 5)

    return {
        "metric": ranking["metric"],
        "value": round(float(value), 5),
        "unit": ranking["unit"],
        "secondary": secondary,
    }


def build(
    *,
    run_id: str,
    profile: Profile,
    system: SystemInfo,
    workloads: list[WorkloadResult],
    telemetry: TelemetrySummary,
    artifacts: list[dict[str, Any]],
    identity: Identity,
    model_revision: str,
    runtime_name: str,
    runtime_version: str,
    runtime_flags: dict[str, Any],
    harness: str,
    harness_version: str,
    duration_s: float,
    parallelism: str,
    cooling: str,
    tuning: str,
    alias: str | None,
    system_name: str | None,
    notes: str | None,
) -> dict[str, Any]:
    digest = container_digest()
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "duration_s": round(duration_s, 2),
        "profile": profile.manifest_stub(),
        "model": {
            "repository": str(profile["model"]["repository"]),
            "revision": model_revision,
            "precision": str(profile["model"]["precision"]),
            "parameters_b": float(profile["model"]["parameters_b"]),
            "weights_bytes": int(profile["model"].get("weights_bytes", 0)),
            "license": str(profile["model"].get("license", "")),
        },
        "container": {
            "image": container_image(),
            # Without an injected digest this is not an official image, and the server will
            # keep the result at Community. Fabricating one here would defeat the check.
            "digest": digest or ("sha256:" + "0" * 64),
            "runner_version": __version__,
            "platform": platform_tag(),
            "official": bool(digest),
        },
        "runtime": {
            "name": runtime_name,
            "version": runtime_version,
            "harness": harness,
            "harness_version": harness_version,
            "flags": {k: v for k, v in runtime_flags.items()},
        },
        "hardware": system.hardware_manifest(cooling, tuning, parallelism),
        "software": system.software_manifest(),
        "workloads": [w.to_manifest() for w in workloads],
        "headline": headline(profile, workloads),
        "telemetry": telemetry.to_manifest(),
        "artifacts": artifacts,
        "submitter": {"system_key": identity.public_key_b64},
        "signature": {"algorithm": "ed25519", "canonicalization": "jcs-rfc8785"},
    }

    if alias:
        manifest["submitter"]["alias"] = alias[:40]
    if system_name:
        manifest["submitter"]["system_name"] = system_name[:60]
    if notes:
        manifest["submitter"]["notes"] = notes[:500]

    manifest["signature"]["value"] = identity.sign_manifest(manifest)
    return manifest


def save(run_dir: Path, manifest: dict[str, Any]) -> Path:
    path = run_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return path


def load(run_dir: Path) -> dict[str, Any]:
    return json.loads((run_dir / "manifest.json").read_text())


def validate(manifest: dict[str, Any]) -> list[str]:
    """Validate against the published schema before anything is uploaded.

    Catching a contract violation locally turns a confusing server rejection into a specific
    message, and keeps invalid submissions off the wire entirely.
    """
    try:
        import jsonschema
    except ImportError:
        return []

    schema_dir = Path(os.environ.get("LOCALMAX_SCHEMAS", "/opt/localmax/schemas"))
    if not schema_dir.is_dir():
        schema_dir = Path(__file__).resolve().parents[2] / "schemas"
    result_schema = schema_dir / "result.schema.json"
    if not result_schema.is_file():
        return []

    store = {}
    for path in schema_dir.glob("*.schema.json"):
        document = json.loads(path.read_text())
        store[f"https://localmax.net/schemas/{path.name}"] = document

    schema = json.loads(result_schema.read_text())
    resolver = jsonschema.RefResolver(base_uri=schema["$id"], referrer=schema, store=store)
    validator = jsonschema.Draft202012Validator(schema, resolver=resolver)
    return [
        f"{'/'.join(str(p) for p in error.absolute_path) or '(root)'}: {error.message}"
        for error in sorted(validator.iter_errors(manifest), key=lambda e: list(e.absolute_path))
    ][:25]
