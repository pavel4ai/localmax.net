"""Pseudonymous system identity.

A random Ed25519 keypair is generated on first use and kept in the cache volume. Its public
key is the system identifier, so a machine can accumulate a result history across driver
updates and benchmark versions.

It is derived from randomness, never from hardware. Deleting the file makes the machine a
new, unlinkable system — which is the point: the alternative, fingerprinting the hardware,
would be a stable identifier the contributor could not escape.
"""

from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .canonical import signing_payload
from .config import paths


class Identity:
    def __init__(self, private_key: Ed25519PrivateKey) -> None:
        self._private = private_key

    @property
    def public_key_b64(self) -> str:
        raw = self._private.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        return base64.b64encode(raw).decode("ascii")

    def sign_manifest(self, manifest: dict) -> str:
        return base64.b64encode(self._private.sign(signing_payload(manifest))).decode("ascii")

    def sign_bytes(self, payload: bytes) -> str:
        return base64.b64encode(self._private.sign(payload)).decode("ascii")


def load_or_create(path: Path | None = None) -> Identity:
    target = path or paths().identity
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        data = json.loads(target.read_text())
        raw = base64.b64decode(data["private_key"])
        return Identity(Ed25519PrivateKey.from_private_bytes(raw))

    private = Ed25519PrivateKey.generate()
    raw = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    identity = Identity(private)
    payload = {
        "version": 1,
        "private_key": base64.b64encode(raw).decode("ascii"),
        "public_key": identity.public_key_b64,
        "note": (
            "Randomly generated system identity for localmax.net. Not derived from your "
            "hardware. Delete this file to become a new, unlinkable system."
        ),
    }
    target.write_text(json.dumps(payload, indent=2))
    os.chmod(target, stat.S_IRUSR | stat.S_IWUSR)
    return identity
