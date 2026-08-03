# Security policy

## Reporting

Report vulnerabilities privately through GitHub Security Advisories on this repository, or
to `security@localmax.net`. Do not open a public issue. We aim to acknowledge within 72
hours and to publish a fix or mitigation within 30 days.

Please include: affected component, reproduction steps, impact, and any proof of concept.

## Trust boundaries

LocalMax accepts anonymous, untrusted, attacker-controlled input from the public internet.
The following boundaries are load-bearing.

| Boundary | Control |
|---|---|
| Runner → API | Ed25519-signed bundle, one-time nonce, Turnstile challenge, per-IP and per-session rate limits |
| API → R2 | Private bucket. Uploads bound to session, declared hash, exact byte size, media type, and a short expiry. Never a bare presigned PUT to an arbitrary key. |
| API → validation | Cloudflare Queue. The Worker never parses a large artifact inline. |
| Validation → repository | GitHub App scoped to `results/**` and pull requests only. No user tokens are ever accepted or stored. |
| Public reads | Evidence is served through a read-only Worker route by content hash, with `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and an attachment disposition for non-media types. |

## Explicit non-guarantees

- A valid signature proves a bundle was produced by one runner installation and was not
  modified afterwards. It does **not** prove the reported hardware is real or that the
  operator was honest.
- **Verified** means protocol compliance and evidence consistency. It is not an audit.

## Hardening rules

- Benchmark containers run unprivileged, with `--cap-drop ALL`, a read-only root filesystem,
  and only explicit cache and output mounts.
- Released images are signed with Cosign and ship an SBOM and provenance. The image digest
  is recorded in every result.
- Uploaded artifacts are never executed, never unpacked by the Worker, and never rendered
  as active content.
- Validation jobs that parse untrusted data run in a disposable, network-restricted runner.
- All API mutations are idempotent by nonce, so a retry cannot double-submit.
