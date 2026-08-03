"""Submission client.

Anonymous by design: no account, no email, no GitHub token. The only interactive step is a
one-click browser check, and the CLI polls for its completion. Every mutation carries a
client-generated nonce, so a retry after a dropped connection can never create a second
submission.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from . import __version__
from .config import api_url


class SubmitError(Exception):
    pass


def _raise_for_api(response: httpx.Response) -> None:
    if response.is_success:
        return
    try:
        body = response.json()
        message = body.get("message") or body.get("error") or response.text
        details = body.get("details") or []
    except Exception:
        message, details = response.text[:400], []
    suffix = ("\n  - " + "\n  - ".join(details[:8])) if details else ""
    raise SubmitError(f"{message}{suffix}")


class Submitter:
    def __init__(self, base_url: str | None = None, timeout: float = 60.0) -> None:
        self.base_url = (base_url or api_url()).rstrip("/")
        self._client = httpx.Client(timeout=timeout, follow_redirects=False)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Submitter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- browser verification ---------------------------------------------

    def request_challenge(self, profile_id: str) -> dict[str, Any]:
        response = self._client.post(
            f"{self.base_url}/v1/submissions/challenge",
            json={"runner_version": __version__, "profile_id": profile_id},
        )
        _raise_for_api(response)
        return response.json()

    def await_token(
        self, challenge_id: str, timeout_s: int = 600, on_wait: Callable[[int], None] | None = None,
    ) -> str:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            response = self._client.get(f"{self.base_url}/v1/submissions/challenge/{challenge_id}")
            _raise_for_api(response)
            state = response.json()
            if state.get("state") == "solved" and state.get("submission_token"):
                return str(state["submission_token"])
            if state.get("state") == "expired":
                raise SubmitError("The verification link expired. Run `localmax submit` again.")
            if on_wait:
                on_wait(int(deadline - time.monotonic()))
            time.sleep(2.0)
        raise SubmitError("Timed out waiting for browser verification.")

    # --- submission --------------------------------------------------------

    def create(self, manifest: dict[str, Any], token: str, nonce: str | None = None) -> dict[str, Any]:
        response = self._client.post(
            f"{self.base_url}/v1/submissions",
            json={
                "submission_token": token,
                "nonce": nonce or secrets.token_hex(16),
                "manifest": manifest,
            },
        )
        _raise_for_api(response)
        return response.json()

    def upload(self, upload_url: str, path: Path, media_type: str) -> None:
        size = path.stat().st_size
        with path.open("rb") as handle:
            response = self._client.put(
                upload_url,
                content=handle,
                headers={"Content-Type": media_type, "Content-Length": str(size)},
                timeout=httpx.Timeout(300.0),
            )
        _raise_for_api(response)

    def complete(self, run_id: str, nonce: str | None = None) -> dict[str, Any]:
        response = self._client.post(
            f"{self.base_url}/v1/submissions/{run_id}/complete",
            json={"nonce": nonce or secrets.token_hex(16)},
        )
        _raise_for_api(response)
        return response.json()

    def status(self, run_id: str) -> dict[str, Any]:
        response = self._client.get(f"{self.base_url}/v1/submissions/{run_id}")
        _raise_for_api(response)
        return response.json()

    def await_result(
        self, run_id: str, timeout_s: int = 300, on_state: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        last = ""
        while time.monotonic() < deadline:
            state = self.status(run_id)
            current = str(state.get("state", ""))
            if current != last and on_state:
                on_state(current)
                last = current
            if current in ("accepted", "rejected"):
                return state
            time.sleep(3.0)
        return self.status(run_id)
