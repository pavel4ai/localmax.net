"""LocalMax runner command line.

A resumable state machine with visible stages:

    doctor              what this system can run, and why not
    run PROFILE         acquire, serve, measure, package
    inspect RUN_ID      show exactly what would be published, offline
    submit RUN_ID       verify in a browser, upload, follow validation
    prove RUN_ID        sign a removal request with the submitting key
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from . import __version__
from .config import api_url, paths, platform_tag
from .profiles import ProfileError, check_eligibility, load, load_all

console = Console()


def _gb(value: float | int | None) -> str:
    return "—" if not value else f"{value / 1024 ** 3:.1f} GB"


def _resolve_run(run_id: str) -> Path:
    p = paths()
    if run_id.upper() == "LAST":
        if not p.last_run.exists():
            raise SystemExit("No previous run found. Run `localmax run PROFILE` first.")
        run_id = p.last_run.read_text().strip()
    directory = p.run_dir(run_id)
    if not (directory / "manifest.json").is_file():
        raise SystemExit(f"No completed run '{run_id}'. Use `localmax runs` to list them.")
    return directory


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------

def cmd_doctor(args: argparse.Namespace) -> int:
    from .system import inspect as inspect_system

    system = inspect_system()

    table = Table(show_header=False, box=None, pad_edge=False)
    table.add_column(style="dim", width=20)
    table.add_column()

    if system.gpus:
        for index, gpu in enumerate(system.gpus):
            detail = f"{_gb(gpu.vram_bytes)} · {gpu.architecture} · cc {gpu.compute_capability}"
            if gpu.pcie_gen:
                detail += f" · PCIe {gpu.pcie_gen}×{gpu.pcie_width}"
            table.add_row(f"GPU {index}", f"{gpu.name}\n[dim]{detail}[/dim]")
    else:
        table.add_row("GPU", "[red]none detected[/red]")

    table.add_row("Driver", f"{system.driver} · CUDA {system.cuda}")
    table.add_row("CPU", f"{system.cpu_model} ({system.cpu_cores}c/{system.cpu_threads}t, {system.cpu_arch})")
    table.add_row("System RAM", _gb(system.system_ram_bytes))
    table.add_row("Memory model", system.memory_type)
    table.add_row("OS", f"{system.os_name} · {system.kernel}")
    table.add_row("Platform", platform_tag())
    table.add_row("Free disk", _gb(system.free_disk_bytes))
    if system.virtualization != "none":
        table.add_row("Virtualisation", f"[yellow]{system.virtualization}[/yellow]")
    table.add_row("Cache", str(paths().root))
    table.add_row("API", api_url())

    console.print(Panel(table, title="System", border_style="dim"))

    if not system.gpus:
        console.print(
            "\n[red]No NVIDIA GPU detected.[/red] Check the driver on the host and that the "
            "container was started with [bold]--gpus all[/bold].\n"
        )
        return 1

    eligible = Table(box=None, pad_edge=False)
    eligible.add_column("Profile", style="bold")
    eligible.add_column("Tier")
    eligible.add_column("Min VRAM", justify="right")
    eligible.add_column("Est.", justify="right")
    eligible.add_column("Status")

    runnable = 0
    for profile in load_all():
        # Try each GPU count the profile permits, smallest first, and report the best
        # outcome: a single-GPU profile is runnable on a two-GPU host by using one card.
        verdict = None
        for count in sorted(profile.requirements.get("gpu_count", [1])):
            if count > system.gpu_count:
                continue
            candidate = check_eligibility(profile, system, count)
            if verdict is None or candidate.ok:
                verdict = candidate
            if candidate.ok:
                break
        if verdict is None:
            verdict = check_eligibility(profile, system)
        if verdict.ok:
            runnable += 1
            status = "[green]runnable[/green]"
            if verdict.warnings:
                status = "[yellow]runnable, with notes[/yellow]"
        else:
            status = f"[dim]{verdict.reasons[0]}[/dim]"
        minutes = profile.requirements.get("expected_runtime_minutes")
        eligible.add_row(
            profile.id,
            f"{profile['tier']} · {profile['lane']}",
            _gb(profile.requirements["min_vram_bytes"]),
            f"~{minutes:.0f} min" if minutes else "—",
            status,
        )

    console.print(Panel(eligible, title=f"Profiles ({runnable} runnable)", border_style="dim"))

    if args.profile:
        profile = load(args.profile)
        verdict = check_eligibility(profile, system)
        for warning in verdict.warnings:
            console.print(f"[yellow]note[/yellow]  {warning}")
        for reason in verdict.reasons:
            console.print(f"[red]blocked[/red]  {reason}")
        return 0 if verdict.ok else 1

    console.print(
        f"\nStart with: [bold]localmax run llm-entry-base[/bold]\n"
        if runnable else "\n[red]No profile can run on this system.[/red]\n"
    )
    return 0


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

def cmd_run(args: argparse.Namespace) -> int:
    from . import manifest as manifest_mod
    from . import models
    from .adapters import diffusion as diffusion_adapter
    from .adapters import llm as llm_adapter
    from .adapters import vision as vision_adapter
    from .identity import load_or_create
    from .runtime import VllmServer
    from .system import inspect as inspect_system
    from .telemetry import TelemetrySampler

    profile = load(args.profile)
    system = inspect_system()

    # Default to the smallest GPU count the profile permits that this system can supply.
    # Using every detected GPU would silently push a single-GPU profile into a
    # configuration it does not accept, on any multi-GPU workstation.
    allowed = sorted(profile.requirements.get("gpu_count", [1]))
    gpu_count = args.gpus or next(
        (c for c in allowed if c <= max(1, system.gpu_count)), allowed[0]
    )
    parallelism = "none" if gpu_count == 1 else f"tp{gpu_count}"

    verdict = check_eligibility(profile, system, gpu_count)
    for warning in verdict.warnings:
        console.print(f"[yellow]note[/yellow]  {warning}")
    if not verdict.ok:
        for reason in verdict.reasons:
            console.print(f"[red]blocked[/red]  {reason}")
        return 1

    minutes = profile.requirements.get("expected_runtime_minutes", 0)
    download = profile.requirements.get("expected_download_bytes", 0)

    preflight = Table(show_header=False, box=None, pad_edge=False)
    preflight.add_column(style="dim", width=18)
    preflight.add_column()
    preflight.add_row("Profile", f"{profile['display_name']}  [dim]v{profile['version']}[/dim]")
    preflight.add_row("Model", f"{profile['model']['repository']} · {profile['model']['precision']}")
    preflight.add_row("Runtime", f"{profile['runtime']['name']} {profile['runtime']['version']}")
    preflight.add_row("GPUs", f"{gpu_count} × {system.gpus[0].name}")
    preflight.add_row("Download", f"up to {_gb(download)} (cached after the first run)")
    preflight.add_row("Estimated", f"~{minutes:.0f} minutes")
    preflight.add_row("Collects", "hardware, software, metrics, raw records, GPU telemetry")
    preflight.add_row("Never sends", "hostname, username, paths, serials, environment")
    console.print(Panel(preflight, title="About to run", border_style="cyan"))

    if not args.yes:
        console.print("Continue? [dim](y/N)[/dim] ", end="")
        if input().strip().lower() not in ("y", "yes"):
            console.print("Cancelled. Nothing was run and nothing was sent.")
            return 130

    p = paths()
    p.ensure()
    run_id = manifest_mod.ulid()
    run_dir = p.run_dir(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    identity = load_or_create()
    started = time.perf_counter()
    progress = lambda message: console.print(f"[dim]·[/dim] {message}")

    try:
        model_path = models.download(profile, progress)
        revision = models.resolved_revision(profile, model_path)
    except Exception as exc:
        console.print(f"[red]Model acquisition failed:[/red] {exc}")
        return 1

    sampler = TelemetrySampler(
        run_dir / "telemetry.ndjson",
        interval_ms=int(profile.validation["telemetry_interval_ms"]),
        memory_type=system.memory_type,
    )

    workloads = []
    runtime_name = str(profile["runtime"]["name"])
    runtime_version = "unknown"
    harness = "builtin"
    harness_version = __version__
    flags = dict(profile["runtime"]["flags"])
    if gpu_count > 1:
        flags["tensor-parallel-size"] = gpu_count

    try:
        if profile.category == "diffusion":
            pipeline, load_seconds = diffusion_adapter.load_pipeline(model_path, flags, progress)
            harness = "diffusion-adapter"
            try:
                import diffusers

                runtime_version = diffusers.__version__
            except Exception:
                pass

            sampler.start()
            for workload in profile.workloads:
                result = diffusion_adapter.run_workload(
                    pipeline, workload, flags, run_dir / "sample.webp", progress
                )
                result.metrics["model_load_s"] = round(load_seconds, 3)
                workloads.append(result)
            sampler.stop()
        else:
            server = VllmServer(
                model_path=model_path,
                flags=flags,
                log_path=run_dir / "runtime.log",
                ready_timeout_s=int(profile["runtime"].get("server_ready_timeout_s", 900)),
                gpu_count=gpu_count,
            )
            progress("Starting the inference runtime")
            with server:
                runtime_version = server.version()
                model_name = server.served_model_name()
                if llm_adapter.harness_available():
                    harness = "aiperf"
                    harness_version = llm_adapter.harness_version()

                sampler.start()
                adapter = vision_adapter if profile.category == "vision" else llm_adapter
                for workload in profile.workloads:
                    result = adapter.run_workload(server.base_url, model_name, workload, progress)
                    if server.load_seconds is not None:
                        result.metrics["model_load_s"] = round(server.load_seconds, 3)
                    workloads.append(result)
                sampler.stop()
    except KeyboardInterrupt:
        sampler.stop()
        console.print("\n[yellow]Interrupted.[/yellow] Nothing was submitted.")
        return 130
    except Exception as exc:
        sampler.stop()
        console.print(f"[red]Run failed:[/red] {type(exc).__name__}: {exc}")
        return 1

    telemetry = sampler.summarize()
    artifacts = manifest_mod.write_evidence(run_dir, workloads, system)

    document = manifest_mod.build(
        run_id=run_id,
        profile=profile,
        system=system,
        workloads=workloads,
        telemetry=telemetry,
        artifacts=artifacts,
        identity=identity,
        model_revision=revision,
        runtime_name=runtime_name,
        runtime_version=runtime_version,
        runtime_flags=flags,
        harness=harness,
        harness_version=harness_version,
        duration_s=time.perf_counter() - started,
        parallelism=parallelism,
        cooling=args.cooling,
        tuning=args.tuning,
        alias=args.alias,
        system_name=args.system_name,
        notes=args.notes,
    )

    errors = manifest_mod.validate(document)
    if errors:
        console.print("[red]The manifest does not match the published schema:[/red]")
        for error in errors:
            console.print(f"  [red]·[/red] {error}")
        console.print("\nThis is a bug in the runner. Please report it with the run ID.")

    manifest_mod.save(run_dir, document)
    p.last_run.write_text(run_id)

    _print_summary(document, profile)
    console.print(
        f"\nRun ID [bold]{run_id}[/bold]\n"
        f"  Inspect:  [bold]localmax inspect {run_id}[/bold]\n"
        f"  Publish:  [bold]localmax submit {run_id}[/bold]\n"
    )
    return 0


def _print_summary(document: dict[str, Any], profile) -> None:
    head = document["headline"]
    table = Table(show_header=False, box=None, pad_edge=False)
    table.add_column(style="dim", width=24)
    table.add_column(justify="right")
    table.add_row(f"[bold]{head['metric']}[/bold]", f"[bold]{head['value']:g} {head['unit']}[/bold]")
    for metric, value in (head.get("secondary") or {}).items():
        table.add_row(metric, f"{value:g}")

    telemetry = document["telemetry"]
    table.add_row("", "")
    table.add_row("peak VRAM", _gb(telemetry.get("vram_peak_bytes")))
    if telemetry.get("power_avg_w"):
        domain = "SoC module" if telemetry["power_domain"] == "soc_module" else "GPU board"
        table.add_row(f"average power ({domain})", f"{telemetry['power_avg_w']:g} W")
    table.add_row("telemetry coverage", f"{telemetry['coverage_pct']:g}%")

    failed = [w for w in document["workloads"] if w["status"] != "passed"]
    border = "green" if not failed else "yellow"
    console.print(Panel(table, title=profile["display_name"], border_style=border))

    for workload in failed:
        console.print(
            f"[yellow]{workload['id']}: {workload['status']}[/yellow] — "
            f"{workload.get('failure_reason', 'no detail')}"
        )
    if failed:
        console.print(
            "[dim]A failed workload is still worth publishing: it records that this "
            "configuration does not fit this hardware.[/dim]"
        )


# ---------------------------------------------------------------------------
# inspect
# ---------------------------------------------------------------------------

def cmd_inspect(args: argparse.Namespace) -> int:
    from . import manifest as manifest_mod

    run_dir = _resolve_run(args.run_id)
    document = manifest_mod.load(run_dir)

    if args.json:
        console.print_json(json.dumps(document))
        return 0

    console.print(
        Panel(
            "This is exactly what would be published. Nothing has been transmitted.\n"
            "Everything below is either measured, pinned by the profile, or typed in by you.",
            border_style="cyan",
            title="Offline inspection",
        )
    )

    _print_summary(document, load(document["profile"]["id"]))

    artifacts = Table(box=None, pad_edge=False)
    artifacts.add_column("Artifact", style="bold")
    artifacts.add_column("Kind")
    artifacts.add_column("Size", justify="right")
    artifacts.add_column("SHA-256")
    for artifact in document["artifacts"]:
        artifacts.add_row(
            artifact["name"], artifact["kind"],
            f"{artifact['size_bytes'] / 1024:.0f} KB",
            artifact["hash"][7:23] + "…",
        )
    console.print(Panel(artifacts, title="Evidence to upload", border_style="dim"))

    submitter = document["submitter"]
    identity = Table(show_header=False, box=None, pad_edge=False)
    identity.add_column(style="dim", width=16)
    identity.add_column()
    identity.add_row("system key", submitter["system_key"][:24] + "…")
    identity.add_row("alias", submitter.get("alias") or "[dim]not set[/dim]")
    identity.add_row("system name", submitter.get("system_name") or "[dim]not set[/dim]")
    identity.add_row("notes", submitter.get("notes") or "[dim]none[/dim]")
    console.print(Panel(identity, title="Your labels (the only free text published)", border_style="dim"))

    errors = manifest_mod.validate(document)
    if errors:
        console.print("[red]Schema problems:[/red]")
        for error in errors:
            console.print(f"  · {error}")
    else:
        console.print("[green]✓[/green] Manifest validates against the published schema.")

    console.print(f"\nFull manifest: {run_dir / 'manifest.json'}")
    return 0


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------

def cmd_submit(args: argparse.Namespace) -> int:
    from . import manifest as manifest_mod
    from .submit import SubmitError, Submitter

    run_dir = _resolve_run(args.run_id)
    document = manifest_mod.load(run_dir)
    run_id = document["run_id"]

    errors = manifest_mod.validate(document)
    if errors:
        console.print("[red]This manifest is invalid and will not be sent:[/red]")
        for error in errors:
            console.print(f"  · {error}")
        return 1

    total = sum(a["size_bytes"] for a in document["artifacts"])
    console.print(
        f"Publishing [bold]{run_id}[/bold] to {api_url()}\n"
        f"  {len(document['artifacts'])} artifact(s), {total / 1024:.0f} KB total\n"
        f"  Run [bold]localmax inspect {run_id}[/bold] first if you have not.\n"
    )
    if not args.yes:
        console.print("Publish this result? [dim](y/N)[/dim] ", end="")
        if input().strip().lower() not in ("y", "yes"):
            console.print("Cancelled. Nothing was sent.")
            return 130

    try:
        with Submitter() as client:
            challenge = client.request_challenge(document["profile"]["id"])
            url = challenge["verify_url"]

            console.print(Panel(
                f"Open this link and complete the one-click check:\n\n  [bold]{url}[/bold]\n\n"
                "[dim]No account, no email. It only makes bulk fabrication expensive.[/dim]",
                border_style="cyan",
                title="Browser verification",
            ))
            if not args.no_browser:
                try:
                    webbrowser.open(url)
                except Exception:
                    pass

            with console.status("Waiting for verification…"):
                token = client.await_token(challenge["challenge_id"])
            console.print("[green]✓[/green] Verified")

            session = client.create(document, token)
            if session["state"] == "duplicate":
                console.print(f"[yellow]Already submitted.[/yellow] {session['status_url']}")
                return 0

            for upload in session.get("uploads", []):
                artifact = next(a for a in document["artifacts"] if a["hash"] == upload["hash"])
                console.print(f"[dim]↑[/dim] {artifact['name']} ({artifact['size_bytes'] / 1024:.0f} KB)")
                client.upload(upload["url"], run_dir / artifact["name"], artifact["media_type"])

            skipped = len(document["artifacts"]) - len(session.get("uploads", []))
            if skipped:
                console.print(f"[dim]{skipped} artifact(s) already in the store; deduplicated.[/dim]")

            client.complete(run_id)

            with console.status("Validating…"):
                final = client.await_result(
                    run_id, on_state=lambda s: console.print(f"[dim]·[/dim] {s}")
                )

    except SubmitError as exc:
        console.print(f"[red]Submission failed:[/red] {exc}")
        return 1
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted.[/yellow] Re-run `localmax submit` to resume.")
        return 130

    state = final.get("state")
    if state == "accepted":
        console.print(Panel(
            f"[green]Published[/green] as [bold]{final.get('verification', 'community')}[/bold]\n\n"
            f"  {final.get('result_url', '')}",
            border_style="green",
        ))
    elif state == "rejected":
        console.print("[red]Rejected.[/red]")
    else:
        console.print(f"[yellow]Still {state}.[/yellow] Check back at {api_url()}/v1/submissions/{run_id}")

    for finding in final.get("findings", []):
        colour = {"error": "red", "warning": "yellow"}.get(finding["severity"], "dim")
        console.print(f"[{colour}]{finding['severity']}[/{colour}]  {finding['message']}")

    return 0 if state == "accepted" else 1


# ---------------------------------------------------------------------------
# runs / profiles / prove
# ---------------------------------------------------------------------------

def cmd_runs(_: argparse.Namespace) -> int:
    from . import manifest as manifest_mod

    directory = paths().runs
    if not directory.is_dir():
        console.print("No runs yet.")
        return 0

    table = Table(box=None, pad_edge=False)
    table.add_column("Run ID", style="bold")
    table.add_column("Profile")
    table.add_column("Headline", justify="right")
    table.add_column("When")

    for run in sorted(directory.iterdir(), reverse=True)[:40]:
        if not (run / "manifest.json").is_file():
            continue
        document = manifest_mod.load(run)
        head = document["headline"]
        table.add_row(
            document["run_id"], document["profile"]["id"],
            f"{head['value']:g} {head['unit']}", document["created_at"][:16].replace("T", " "),
        )
    console.print(table)
    return 0


def cmd_profiles(_: argparse.Namespace) -> int:
    table = Table(box=None, pad_edge=False)
    for column in ("Profile", "Tier", "Lane", "Model", "Min VRAM", "State"):
        table.add_column(column, style="bold" if column == "Profile" else None)
    for profile in load_all():
        table.add_row(
            profile.id, str(profile["tier"]), str(profile["lane"]),
            f"{profile['model']['parameters_b']:g}B {profile['model']['precision']}",
            _gb(profile.requirements["min_vram_bytes"]),
            "frozen" if profile["frozen"] else "release candidate",
        )
    console.print(table)
    return 0


def cmd_prove(args: argparse.Namespace) -> int:
    """Sign a removal request, demonstrating control of the submitting key."""
    from .identity import load_or_create

    run_dir = _resolve_run(args.run_id)
    run_id = json.loads((run_dir / "manifest.json").read_text())["run_id"]
    identity = load_or_create()
    payload = f"localmax-removal-request:{run_id}".encode()
    console.print(Panel(
        f"Run ID:    {run_id}\n"
        f"System key: {identity.public_key_b64}\n"
        f"Signature:  {identity.sign_bytes(payload)}\n\n"
        "[dim]Email these three lines to privacy@localmax.net to have the result and its "
        "evidence removed.[/dim]",
        title="Removal proof",
        border_style="cyan",
    ))
    return 0


# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="localmax",
        description="Run open local-AI benchmarks and publish the results to localmax.net.",
    )
    parser.add_argument("--version", action="version", version=f"localmax {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="report what this system can run")
    doctor.add_argument("profile", nargs="?", help="check one profile in detail")
    doctor.set_defaults(func=cmd_doctor)

    run = sub.add_parser("run", help="run a benchmark profile")
    run.add_argument("profile")
    run.add_argument("--gpus", type=int, default=None, help="number of GPUs to use")
    run.add_argument("--alias", default=None, help="public display alias (optional)")
    run.add_argument("--system-name", default=None, help="name for this build (optional)")
    run.add_argument("--notes", default=None, help="public note on this result (optional)")
    run.add_argument(
        "--cooling", default="unknown",
        choices=["air", "aio", "custom-loop", "blower", "passive", "unknown"],
    )
    run.add_argument(
        "--tuning", default="unknown",
        choices=["stock", "power-limited", "undervolted", "overclocked", "unknown"],
    )
    run.add_argument("-y", "--yes", action="store_true", help="skip the confirmation prompt")
    run.set_defaults(func=cmd_run)

    inspect_cmd = sub.add_parser("inspect", help="show what a run would publish, offline")
    inspect_cmd.add_argument("run_id", nargs="?", default="LAST")
    inspect_cmd.add_argument("--json", action="store_true", help="print the raw manifest")
    inspect_cmd.set_defaults(func=cmd_inspect)

    submit_cmd = sub.add_parser("submit", help="publish a run")
    submit_cmd.add_argument("run_id", nargs="?", default="LAST")
    submit_cmd.add_argument("-y", "--yes", action="store_true")
    submit_cmd.add_argument("--no-browser", action="store_true", help="do not open a browser")
    submit_cmd.set_defaults(func=cmd_submit)

    sub.add_parser("runs", help="list local runs").set_defaults(func=cmd_runs)
    sub.add_parser("profiles", help="list benchmark profiles").set_defaults(func=cmd_profiles)

    prove = sub.add_parser("prove", help="sign a removal request for a run")
    prove.add_argument("run_id", nargs="?", default="LAST")
    prove.set_defaults(func=cmd_prove)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ProfileError as exc:
        console.print(f"[red]{exc}[/red]")
        return 2
    except KeyboardInterrupt:
        console.print("\nInterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
