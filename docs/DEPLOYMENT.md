# Deployment

## The API token

The token currently in `.cloudflare` is **zone-scoped only**. It can read the `localmax.net`
zone and its DNS records, and nothing else. Verified by direct probe:

| Capability | Status |
|---|---|
| Zone read (`localmax.net`) | ✅ works |
| DNS records | ✅ works |
| Account settings read | ❌ denied |
| Workers Scripts | ❌ denied |
| D1 | ❌ denied |
| R2 | ❌ denied |
| Workers KV | ❌ denied |
| Queues | ❌ denied |
| Pages | ❌ denied |
| Turnstile | ❌ denied |

Nothing can be deployed with it. Create a replacement at
<https://dash.cloudflare.com/profile/api-tokens> → **Create Custom Token** with:

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

> **Rotate the existing token as well.** It was written to a file in the working tree. It is
> gitignored and CI refuses to build if it is ever staged, but a credential that has touched
> disk in a shared directory should not be considered private.

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

Anonymous submission is gated on Turnstile, and the API refuses to accept submissions in
production without `TURNSTILE_SECRET_KEY`. Create a widget for `localmax.net`, then:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY --config apps/api/wrangler.toml
# and put the site key in [vars] TURNSTILE_SITE_KEY in the same file
```

Reads work without it; only publishing is blocked.

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

`.github/workflows/deploy.yml` deploys on push to `main`. Add two repository secrets:

```bash
gh secret set CLOUDFLARE_API_TOKEN   # the rescoped token
gh secret set CLOUDFLARE_ACCOUNT_ID  # f1407b52c0bb1b803fc4780c29c65c22
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
