# Deployment

## Status

**Deployed.** <https://localmax.net> and <https://api.localmax.net> are live.

| Resource | Identifier |
|---|---|
| D1 | `localmax` · `9213a459-085c-4480-99a9-ff3c585f77a5` |
| R2 | `localmax-evidence` (private) |
| KV | `SESSIONS` · `4dd415265b2c4dd5845fdcbc765e6d7e` |
| Queue | `localmax-validation` + `localmax-validation-dlq` |
| Turnstile | `0x4AAAAAAEFeDtlaeyxznTXA` (localmax.net, www.localmax.net) |

## The API token

The token must be account-scoped. A zone-only token — the default if you start from the
DNS templates — can read the zone and nothing else, and fails on the first resource it
tries to create. Create one at <https://dash.cloudflare.com/profile/api-tokens> →
**Create Custom Token** with:

| Scope | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Workers KV Storage | Edit |
| Account | D1 | Edit |
| Account | Queues | Edit |
| Account | Turnstile | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |
| Zone | DNS | Edit |
| Zone | Zone | Read |

Account resources: `f1407b52c0bb1b803fc4780c29c65c22`. Zone resources: `localmax.net`.

The **Edit Cloudflare Workers** template covers most of it but omits D1, Queues and
Turnstile — add those three by hand.

> **Treat `.cloudflare` as compromised-by-default.** It holds a live token in the working
> tree. It is gitignored and CI fails the build if it is ever staged, but a credential that
> has touched disk in a shared directory should be rotated on a schedule regardless.

## One command

```bash
source .cloudflare
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_ACCOUNT_TOKEN"
./scripts/provision-cloudflare.sh
```

It checks the token first and stops with the exact missing permission if it is still
insufficient. Then it creates the D1 database, the private R2 bucket with a lifecycle rule,
the KV namespace, the queue and its dead-letter queue; writes the resulting IDs back into
`apps/api/wrangler.toml`; applies migrations; generates a random `IP_HASH_SALT`; and deploys
both Workers. It is idempotent.

## What gets created

| Resource | Name | Purpose |
|---|---|---|
| Worker | `localmax-api` | Submission, validation queue consumer, read API, hourly archive cron |
| Worker | `localmax-web` | Astro SSR site with static assets |
| D1 | `localmax` | Live result store — rebuildable from `results/` |
| R2 | `localmax-evidence` | Private, content-addressed evidence |
| KV | `SESSIONS` | Submission sessions, nonces, upload slots. All TTL'd |
| Queue | `localmax-validation` (+ DLQ) | Asynchronous validation |

`api.localmax.net` and `localmax.net` are attached as custom domains by the route
declarations in each `wrangler.toml`. The site reaches the API over a **service binding**, so
the API never has to be publicly reachable for the site to render.

## Order matters

The API deploys before the website. The site binds to it as a service; deploying the site
against a missing binding takes the whole front end down. `deploy.yml` and the provisioning
script both enforce this.

## Turnstile

Configured. The widget covers `localmax.net` and `www.localmax.net` in managed mode; its
site key is in `[vars] TURNSTILE_SITE_KEY` and its secret is a Worker secret.

To rotate:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY --config apps/api/wrangler.toml
# and update [vars] TURNSTILE_SITE_KEY in the same file
```

Reads never require it; only publishing does. The API refuses submissions in production
if the secret is absent, rather than silently accepting unverified ones.

## The Git archive (optional)

Accepted results are batched into an hourly commit to `results/`. Without a GitHub App the
cron logs a skip and everything else keeps working — results stay live in D1 and simply are
not mirrored yet.

To enable it, create a GitHub App with **Contents: Read & write** on
`pavel4ai/localmax.net`, install it, and set:

```bash
npx wrangler secret put GITHUB_APP_ID --config apps/api/wrangler.toml
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config apps/api/wrangler.toml
npx wrangler secret put GITHUB_APP_INSTALLATION_ID --config apps/api/wrangler.toml
```

## Continuous deployment

Enabled. `.github/workflows/deploy.yml` deploys on push to `main`, gated on the
`CLOUDFLARE_CONFIGURED` repository variable so the workflow skips cleanly rather than
failing if the credentials are ever removed.

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh variable set CLOUDFLARE_CONFIGURED --body true
```

## Local development

```bash
npm ci
npm run seed:local          # migrate + 263 demonstration results
npm run dev:api             # :8787, local D1/R2/KV
npm run dev:web             # :4321
```

The seed writes directly to `results`, bypassing submission, signing and validation — it
exists so the site can be reviewed before real contributors exist, and must never be pointed
at production.

## Containers

```bash
git tag v0.1.0 && git push --tags
```

Builds `linux/amd64` and `linux/arm64`, signs with Cosign, publishes an SBOM and provenance,
and appends each digest to `containers/released-images.json`.

**Until that list is non-empty, every submission is Community and unranked.** That is
correct rather than a bug: Verified means the container digest matches something the project
actually published, and nothing has been published yet.
