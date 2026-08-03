"""Inference runtime supervision.

Starts the pinned runtime with exactly the flags the profile specifies, waits for it to be
serving, and captures its log. The runner never retries with different settings after a
failure: a configuration that does not fit is a result, and silently loosening it would
produce a number that no longer belongs to the profile.
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx


class RuntimeError_(Exception):
    """Runtime failed to start or serve."""


# Patterns redacted from the captured log before it is written to the evidence bundle.
_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"/home/[^/\s]+"), "/home/USER"),
    (re.compile(r"/Users/[^/\s]+"), "/Users/USER"),
    (re.compile(r"/root\b"), "/root"),
    (re.compile(r"\bhf_[A-Za-z0-9]{20,}\b"), "hf_REDACTED"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "gh_REDACTED"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"), "sk-REDACTED"),
    (re.compile(r"(?i)(authorization|api[-_]?key|token)\s*[:=]\s*\S+"), r"\1: REDACTED"),
]


def redact(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


class VllmServer:
    """A pinned vLLM OpenAI-compatible server."""

    def __init__(
        self,
        model_path: Path,
        flags: dict[str, Any],
        log_path: Path,
        port: int = 8100,
        ready_timeout_s: int = 900,
        gpu_count: int = 1,
    ) -> None:
        self.model_path = model_path
        self.flags = dict(flags)
        self.log_path = log_path
        self.port = port
        self.ready_timeout_s = ready_timeout_s
        self.gpu_count = gpu_count
        self._process: subprocess.Popen | None = None
        self._log = None
        self.load_seconds: float | None = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def command(self) -> list[str]:
        if not shutil.which("vllm"):
            raise RuntimeError_(
                "vllm is not installed. Use the official localmax-llm container, which pins "
                "the exact version the profile requires."
            )
        cmd = ["vllm", "serve", str(self.model_path), "--port", str(self.port), "--host", "127.0.0.1"]
        for key, value in self.flags.items():
            if isinstance(value, bool):
                if value:
                    cmd.append(f"--{key}")
            else:
                cmd.extend([f"--{key}", str(value)])
        return cmd

    def __enter__(self) -> VllmServer:
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = self.log_path.open("w")
        started = time.monotonic()

        env = dict(os.environ)
        env["VLLM_LOGGING_LEVEL"] = "INFO"
        # Pin visible devices so a multi-GPU host running a single-GPU profile really does
        # use one device, rather than whichever the runtime happens to pick.
        env["CUDA_VISIBLE_DEVICES"] = ",".join(str(i) for i in range(self.gpu_count))

        self._process = subprocess.Popen(
            self.command(),
            stdout=self._log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        self._wait_ready(started)

    def _wait_ready(self, started: float) -> None:
        deadline = started + self.ready_timeout_s
        with httpx.Client(timeout=5.0) as client:
            while time.monotonic() < deadline:
                if self._process and self._process.poll() is not None:
                    raise RuntimeError_(
                        f"The runtime exited with code {self._process.returncode} before it "
                        f"began serving. The captured log is in the run directory."
                    )
                try:
                    response = client.get(f"{self.base_url}/health")
                    if response.status_code == 200:
                        self.load_seconds = time.monotonic() - started
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(2.0)
        raise RuntimeError_(
            f"The runtime did not become ready within {self.ready_timeout_s}s. On a "
            "minimum-VRAM system this usually means the model did not fit."
        )

    def stop(self) -> None:
        if self._process and self._process.poll() is None:
            try:
                os.killpg(os.getpgid(self._process.pid), signal.SIGTERM)
                self._process.wait(timeout=45)
            except Exception:
                try:
                    os.killpg(os.getpgid(self._process.pid), signal.SIGKILL)
                except Exception:
                    pass
        if self._log:
            self._log.close()
            self._log = None
        # Redact in place: the log is about to become public evidence.
        try:
            self.log_path.write_text(redact(self.log_path.read_text(errors="replace")))
        except OSError:
            pass

    def version(self) -> str:
        try:
            out = subprocess.run(["vllm", "--version"], capture_output=True, text=True, timeout=20)
            return out.stdout.strip().splitlines()[-1] if out.stdout.strip() else "unknown"
        except Exception:
            return "unknown"

    def served_model_name(self) -> str:
        try:
            with httpx.Client(timeout=10.0) as client:
                data = client.get(f"{self.base_url}/v1/models").json()
                return str(data["data"][0]["id"])
        except Exception:
            return str(self.model_path)
