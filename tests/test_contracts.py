"""Cross-language contract tests.

The runner and the API are written in different languages and must agree exactly on
canonicalization, hashing and percentile arithmetic. A disagreement in any of these would
present as a fabricated metric or an invalid signature, so they are pinned here against the
same fixtures the TypeScript suite uses.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from localmax_runner.adapters.base import percentile
from localmax_runner.canonical import canonicalize, signing_payload
from localmax_runner.identity import load_or_create
from localmax_runner.profiles import load_all, profile_hash
from localmax_runner.runtime import redact

ROOT = Path(__file__).resolve().parents[1]


# --- canonicalization ------------------------------------------------------

@pytest.mark.parametrize(
    "value,expected",
    [
        ({}, "{}"),
        ({"b": 1, "a": 2}, '{"a":2,"b":1}'),
        ({"a": [1, 2, 3]}, '{"a":[1,2,3]}'),
        ({"a": None}, "{}"),  # null-valued keys are dropped, as on the server
        ({"a": 1.0}, '{"a":1}'),  # ES6 number rendering
        ({"a": 0.5}, '{"a":0.5}'),
        ({"a": True, "b": False}, '{"a":true,"b":false}'),
        ({"z": "x", "A": "y"}, '{"A":"y","z":"x"}'),  # sorted by code unit: uppercase first
        ({"a": "quote\"and\\slash"}, '{"a":"quote\\"and\\\\slash"}'),
    ],
)
def test_canonicalize(value, expected):
    assert canonicalize(value) == expected


def test_canonicalization_matches_the_typescript_implementation():
    """The signature is verified by the Worker, so both sides must produce identical bytes."""
    fixture = {
        "b": 1,
        "a": [1, 2.5, "x", True, None],
        "nested": {"z": 0, "y": {"deep": "value"}},
        "unicode": "café ✓",
        "big": 12884901888,
    }
    script = ROOT / "scripts" / "canonicalize.mjs"
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", str(script)], input=json.dumps(fixture), capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert canonicalize(fixture) == result.stdout.strip()


def test_signing_payload_excludes_only_the_signature_value():
    manifest = {"a": 1, "signature": {"algorithm": "ed25519", "value": "SIG", "canonicalization": "jcs-rfc8785"}}
    payload = signing_payload(manifest).decode()
    assert "SIG" not in payload
    assert "ed25519" in payload
    assert "jcs-rfc8785" in payload


# --- signatures ------------------------------------------------------------

def test_signature_round_trip(tmp_path):
    identity = load_or_create(tmp_path / "identity.json")
    manifest = {"run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "signature": {"algorithm": "ed25519"}}
    manifest["signature"]["value"] = identity.sign_manifest(manifest)

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(identity.public_key_b64))
    public.verify(base64.b64decode(manifest["signature"]["value"]), signing_payload(manifest))


def test_signature_rejects_a_tampered_manifest(tmp_path):
    identity = load_or_create(tmp_path / "identity.json")
    manifest = {"headline": {"value": 100}, "signature": {"algorithm": "ed25519"}}
    manifest["signature"]["value"] = identity.sign_manifest(manifest)

    manifest["headline"]["value"] = 9999  # the obvious attack: inflate the number

    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(identity.public_key_b64))
    with pytest.raises(InvalidSignature):
        public.verify(base64.b64decode(manifest["signature"]["value"]), signing_payload(manifest))


def test_identity_is_stable_and_not_derived_from_hardware(tmp_path):
    first = load_or_create(tmp_path / "identity.json").public_key_b64
    second = load_or_create(tmp_path / "identity.json").public_key_b64
    assert first == second
    # A second, independent store must produce a different key: it is random, not a
    # fingerprint of this machine.
    assert load_or_create(tmp_path / "other.json").public_key_b64 != first


# --- percentiles -----------------------------------------------------------

@pytest.mark.parametrize(
    "values,p,expected",
    [
        ([], 50, None),
        ([5.0], 95, 5.0),
        ([1.0, 2.0, 3.0, 4.0], 50, 2.5),
        ([1.0, 2.0, 3.0, 4.0], 0, 1.0),
        ([1.0, 2.0, 3.0, 4.0], 100, 4.0),
        ([10.0, 20.0], 95, 19.5),
    ],
)
def test_percentile(values, p, expected):
    assert percentile(values, p) == expected


def test_percentile_matches_the_server():
    values = [3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0]
    script = ROOT / "scripts" / "percentile.mjs"
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", str(script)],
        input=json.dumps({"values": values, "percentiles": [50, 90, 95, 99]}),
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    server = json.loads(result.stdout)
    for p, expected in server.items():
        assert percentile(values, float(p)) == pytest.approx(expected, rel=1e-12)


# --- profiles --------------------------------------------------------------

def test_profile_hash_matches_the_worker_registry():
    """The hash in a manifest is checked against the Worker's own copy of the profile."""
    registry = ROOT / "apps" / "api" / "src" / "generated" / "registry.ts"
    if not registry.is_file():
        pytest.skip("registry not generated; run scripts/build-worker-assets.mjs")
    text = registry.read_text()
    for profile in load_all():
        assert f'"hash": "{profile.hash}"' in text, f"{profile.id} hash disagrees with the Worker"


def test_profile_hash_ignores_the_schema_key():
    base = {"id": "llm-entry-base", "version": "0.1.0"}
    assert profile_hash(base) == profile_hash({"$schema": "../x.json", **base})


def test_every_profile_declares_a_ranking_source_that_exists():
    for profile in load_all():
        ids = {w["id"] for w in profile.workloads}
        assert profile.ranking["source_workload"] in ids, profile.id
        for gate in profile.ranking.get("gates", []):
            assert gate["source_workload"] in ids, f"{profile.id}: {gate['metric']}"


def test_tier_minimums_are_consistent_across_profiles():
    expected = {"entry": 12, "enthusiast": 24, "frontier": 64}
    for profile in load_all():
        gb = profile.requirements["min_vram_bytes"] / 1024 ** 3
        assert gb == expected[profile["tier"]], profile.id


def test_nvfp4_profiles_exclude_pre_blackwell_architectures():
    for profile in load_all():
        if profile["lane"] == "nvfp4":
            assert "ampere" not in profile.requirements["architectures"], profile.id
            assert "ada" not in profile.requirements["architectures"], profile.id


# --- redaction -------------------------------------------------------------

@pytest.mark.parametrize(
    "text,must_not_contain",
    [
        ("loading from /home/pavel/models/x", "pavel"),
        ("token=hf_abcdefghijklmnopqrstuvwxyz012345", "hf_abcdefghijklmnopqrstuvwxyz012345"),
        ("Authorization: Bearer sk-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"),
        ("ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    ],
)
def test_redaction_removes_secrets_and_paths(text, must_not_contain):
    assert must_not_contain not in redact(text)
