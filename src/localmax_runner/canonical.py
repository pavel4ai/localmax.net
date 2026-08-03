"""RFC 8785 JSON Canonicalization Scheme.

The manifest is signed over its canonical form, and the API verifies that signature with an
independent implementation. Both sides must agree byte for byte, so key ordering, whitespace
and number formatting are all fixed here rather than left to the JSON encoder.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def _number(value: float | int) -> str:
    if isinstance(value, bool):  # bool is a subclass of int; must not reach here
        raise TypeError("bool is not a number")
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("Cannot canonicalize a non-finite number")
    if value == int(value) and abs(value) < 1e21:
        # ES6 Number#toString renders integral floats without a fractional part, and the
        # JavaScript verifier on the other side will do exactly that.
        return str(int(value))
    return repr(value)


def canonicalize(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted((k for k in value if value[k] is not None), key=lambda k: k.encode("utf-16-be"))
        return (
            "{"
            + ",".join(
                f"{json.dumps(k, ensure_ascii=False, separators=(',', ':'))}:{canonicalize(value[k])}"
                for k in items
            )
            + "}"
        )
    raise TypeError(f"Cannot canonicalize {type(value).__name__}")


def signing_payload(manifest: dict[str, Any]) -> bytes:
    """The exact bytes signed: the manifest with `signature.value` removed."""
    copy = dict(manifest)
    signature = copy.get("signature")
    if isinstance(signature, dict):
        copy["signature"] = {k: v for k, v in signature.items() if k != "value"}
    return canonicalize(copy).encode("utf-8")


def sha256_file(path, chunk: int = 1024 * 1024) -> tuple[str, int]:
    """Return (prefixed hex digest, byte size) for a file, streaming it."""
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
            size += len(block)
    return f"sha256:{digest.hexdigest()}", size


def sha256_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
