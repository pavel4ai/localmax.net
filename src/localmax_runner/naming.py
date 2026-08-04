"""Public system labels.

A contributed system is shown under a name derived from its public key, never under one a
person typed. The same machine always gets the same label, and nothing in the label points
back to an operator.

The five-character code is the part that matters to a contributor: it is how they find their
own results later, and the only thing they need to share them.

The Worker derives the identical label from the same source list, so the terminal shows
exactly what the site will.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

from .config import profiles_dir


@lru_cache(maxsize=1)
def _table() -> tuple[list[str], str]:
    for candidate in (
        profiles_dir().parent / "system-names.json",
        Path(__file__).resolve().parents[2] / "benchmarks" / "system-names.json",
    ):
        if candidate.is_file():
            data = json.loads(candidate.read_text())
            return data["names"], data["alphabet"]
    raise FileNotFoundError("system-names.json is missing from the image")


def derive(system_key: str) -> tuple[str, str, str]:
    """Return (name, code, label) for a base64 Ed25519 public key."""
    names, alphabet = _table()
    digest = hashlib.sha256(system_key.encode("utf-8")).hexdigest()

    name = names[int(digest[0:8], 16) % len(names)]
    code = "".join(alphabet[int(digest[8 + i * 2 : 10 + i * 2], 16) % 32] for i in range(5))
    return name, code, f"{name}-{code}"
