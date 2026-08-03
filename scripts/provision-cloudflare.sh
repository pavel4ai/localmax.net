#!/usr/bin/env bash
#
# Provision every Cloudflare resource LocalMax needs, then deploy.
#
# Idempotent: existing resources are reused and their IDs written back into the wrangler
# configs. Safe to re-run.
#
#   source .cloudflare
#   export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_ACCOUNT_TOKEN"
#   ./scripts/provision-cloudflare.sh
#
# The token needs these permissions (see docs/DEPLOYMENT.md):
#   Account · Workers Scripts:Edit, Workers R2 Storage:Edit, Workers KV Storage:Edit,
#            D1:Edit, Queues:Edit, Turnstile:Edit, Account Settings:Read
#   Zone    · Workers Routes:Edit, DNS:Edit, Zone:Read   (on localmax.net)

set -euo pipefail

cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN (see .cloudflare)}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID (see .cloudflare)}"

WRANGLER="npx wrangler"
API_CONFIG="apps/api/wrangler.toml"

info() { printf '\033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

# --- 0. verify the token has what it needs ---------------------------------

info "Checking token permissions"
missing=0
check() {
  local label="$1" path="$2"
  # The API pretty-prints its responses, so the check has to tolerate whitespace after
  # the colon. Matching '"success":true' silently reports every permission as denied.
  if curl -fsS "https://api.cloudflare.com/client/v4${path}" \
       -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
       | grep -qE '"success":[[:space:]]*true'; then
    ok "$label"
  else
    warn "$label — DENIED"
    missing=1
  fi
}
check "Workers"  "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts"
check "D1"       "/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database"
check "R2"       "/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets"
check "KV"       "/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces"
check "Queues"   "/accounts/${CLOUDFLARE_ACCOUNT_ID}/queues"

if [ "$missing" -ne 0 ]; then
  cat >&2 <<'MSG'

The API token is missing account-level permissions. Create a new token at
https://dash.cloudflare.com/profile/api-tokens with:

  Account  Workers Scripts        Edit
  Account  Workers R2 Storage     Edit
  Account  Workers KV Storage     Edit
  Account  D1                     Edit
  Account  Queues                 Edit
  Account  Turnstile              Edit
  Account  Account Settings       Read
  Zone     Workers Routes         Edit    (localmax.net)
  Zone     DNS                    Edit    (localmax.net)
  Zone     Zone                   Read    (localmax.net)

MSG
  exit 1
fi

# --- 1. D1 -----------------------------------------------------------------

# Resource IDs are read back from the REST API rather than parsed out of CLI output:
# `wrangler d1 info` needs a valid database_id in the config to work at all, which is
# exactly what we are trying to discover, and its human output is not stable to parse.
cf_api() {
  curl -fsS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}$1" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
}

info "Creating the D1 database"
DB_ID=$(cf_api "/d1/database?name=localmax" \
        | python3 -c 'import sys,json;print(next((d["uuid"] for d in json.load(sys.stdin)["result"] if d["name"]=="localmax"),""))')
if [ -z "$DB_ID" ]; then
  $WRANGLER d1 create localmax >/dev/null
  DB_ID=$(cf_api "/d1/database?name=localmax" \
          | python3 -c 'import sys,json;print(next((d["uuid"] for d in json.load(sys.stdin)["result"] if d["name"]=="localmax"),""))')
fi
[ -n "$DB_ID" ] || { echo "Could not resolve the D1 database id" >&2; exit 1; }
ok "D1 localmax = $DB_ID"

# --- 2. R2 -----------------------------------------------------------------

info "Creating the R2 evidence bucket (private)"
$WRANGLER r2 bucket create localmax-evidence 2>/dev/null || ok "bucket already exists"
# Rejected and abandoned uploads expire on their own rather than accumulating cost.
$WRANGLER r2 bucket lifecycle add localmax-evidence \
  --name expire-incomplete --prefix "ev/" --expire-days 30 2>/dev/null || true
ok "R2 localmax-evidence"

# --- 3. KV -----------------------------------------------------------------

info "Creating the KV namespace for sessions and nonces"
kv_lookup() {
  cf_api "/storage/kv/namespaces?per_page=100" \
    | python3 -c 'import sys,json;print(next((n["id"] for n in json.load(sys.stdin)["result"] if n["title"].endswith("SESSIONS")),""))'
}
KV_ID=$(kv_lookup)
if [ -z "$KV_ID" ]; then
  $WRANGLER kv namespace create SESSIONS >/dev/null 2>&1 || true
  KV_ID=$(kv_lookup)
fi
[ -n "$KV_ID" ] || { echo "Could not resolve the KV namespace id" >&2; exit 1; }
ok "KV SESSIONS = $KV_ID"

# --- 4. Queues -------------------------------------------------------------

info "Creating the validation queue and its dead-letter queue"
$WRANGLER queues create localmax-validation 2>/dev/null || ok "queue already exists"
$WRANGLER queues create localmax-validation-dlq 2>/dev/null || ok "DLQ already exists"
ok "Queues ready"

# --- 5. write the IDs back -------------------------------------------------

info "Writing resource IDs into $API_CONFIG"
python3 - "$DB_ID" "$KV_ID" <<'PY'
import pathlib, re, sys
db_id, kv_id = sys.argv[1], sys.argv[2]
p = pathlib.Path("apps/api/wrangler.toml")
s = p.read_text()
s = re.sub(r'(\[\[d1_databases\]\][\s\S]*?database_id = )"[^"]*"', rf'\1"{db_id}"', s, count=1)
s = re.sub(r'(\[\[kv_namespaces\]\][\s\S]*?\nid = )"[^"]*"', rf'\1"{kv_id}"', s, count=1)
p.write_text(s)
print("wrangler.toml updated")
PY

# --- 6. migrate ------------------------------------------------------------

info "Applying database migrations"
$WRANGLER d1 migrations apply localmax --remote --config "$API_CONFIG"

# --- 7. secrets ------------------------------------------------------------

info "Worker secrets"
for name in TURNSTILE_SECRET_KEY IP_HASH_SALT; do
  if ! $WRANGLER secret list --config "$API_CONFIG" 2>/dev/null | grep -q "\"$name\""; then
    case "$name" in
      IP_HASH_SALT)
        # Only ever used to salt a transient rate-limiting hash; never stored on a result.
        python3 -c 'import secrets;print(secrets.token_hex(32))' \
          | $WRANGLER secret put IP_HASH_SALT --config "$API_CONFIG"
        ;;
      *)
        warn "$name is not set. Create a Turnstile widget for localmax.net, then run:"
        echo "      npx wrangler secret put TURNSTILE_SECRET_KEY --config $API_CONFIG"
        echo "    and put its site key in [vars] TURNSTILE_SITE_KEY."
        ;;
    esac
  else
    ok "$name already set"
  fi
done

warn "GitHub App secrets are optional; without them the hourly Git archive is skipped"
echo "      GITHUB_APP_ID · GITHUB_APP_PRIVATE_KEY · GITHUB_APP_INSTALLATION_ID"

# --- 8. deploy -------------------------------------------------------------

info "Building worker assets"
node scripts/build-worker-assets.mjs

info "Deploying the API"
$WRANGLER deploy --config "$API_CONFIG"

info "Building and deploying the website"
npm run build --workspace apps/web
$WRANGLER deploy --config apps/web/dist/server/wrangler.json

# --- 9. verify -------------------------------------------------------------

info "Smoke test"
for i in $(seq 1 12); do
  if curl -fsS https://api.localmax.net/health -o /tmp/lm-health.json 2>/dev/null \
     && grep -q '"ok":true' /tmp/lm-health.json; then
    ok "API healthy"
    break
  fi
  echo "    waiting for DNS and the route to settle ($i/12)"
  sleep 10
done

curl -fsS https://api.localmax.net/v1/profiles >/dev/null && ok "profiles endpoint"
curl -fsS https://localmax.net/ -o /tmp/lm-home.html && grep -q LocalMax /tmp/lm-home.html && ok "website"

cat <<'DONE'

Deployed.

  https://localmax.net
  https://api.localmax.net

Next:
  1. Create a Turnstile widget for localmax.net and set TURNSTILE_SECRET_KEY plus the
     site key, or anonymous submission stays closed.
  2. Tag a release to build and sign the containers:  git tag v0.1.0 && git push --tags
  3. Until a signed image exists, every submission is Community and unranked, which is
     correct: nothing has been published that a result could be verified against.
DONE
