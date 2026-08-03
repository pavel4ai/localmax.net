# Privacy

LocalMax is anonymous by default. There are no accounts, no email address is required, and
no tracking or analytics scripts run on the website.

## What the runner collects

Hardware and software facts needed to make a result comparable:

- GPU model, count, VRAM size, driver version, CUDA version, PCIe link generation and width,
  power limit, and clock configuration
- CPU model, core count, total system RAM
- OS name and version, kernel version, container runtime version, architecture
- Benchmark profile ID and version, container image digest, model revision
- All measured metrics, the raw request/generation records they derive from, and GPU
  telemetry samples

## What the runner never collects

- Hostname, username, or any local filesystem path
- GPU serial numbers, board UUIDs, MAC addresses, or any stable hardware identifier
- Environment variables, shell history, or data about unrelated processes
- IP address is used transiently for rate limiting and is not stored with a result

## Your identity

A result may carry an optional public alias you type in. Separately, the runner generates a
random Ed25519 keypair on first use and stores it under `~/.localmax`. The public key acts
as a pseudonymous *system* identifier so your machine can have a result history.

It is derived from randomness, not from your hardware. Delete `~/.localmax/identity.json`
and you are a new, unlinkable system. It is never correlated with an IP address.

## Before anything is uploaded

`localmax inspect RUN_ID` prints the exact manifest and the full list of artifacts, offline.
`localmax submit` shows the same list and requires confirmation. Nothing is transmitted
before you accept it.

Log output is redacted locally before it is written to the evidence bundle: paths, home
directories, usernames, tokens, and anything matching a secret pattern are replaced.

## Retention

- Incomplete or rejected uploads are deleted after 7 days.
- Accepted evidence is retained while the result is public.
- Accepted manifests are public, permanent, and mirrored into Git history.

## Removal

Email `privacy@localmax.net` with the run ID and the signature produced by
`localmax prove RUN_ID`, which demonstrates control of the submitting key. We will remove
the result and its evidence. Git history is rewritten only for exposed secrets or personal
data.
