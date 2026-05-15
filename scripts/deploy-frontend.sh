#!/usr/bin/env bash
#
# deploy-frontend.sh — sync dist/ to S3 and invalidate the CloudFront cache.
#
# Prereq:
#   1. `node build-frontend.mjs` has been run (creates dist/)
#   2. dist/amplify_outputs.js has been edited to contain the real AppSync
#      endpoint/region/apiKey from Secrets Manager — NOT the placeholder.
#   3. AWS CLI is authenticated with rights for s3:* on the bucket and
#      cloudfront:CreateInvalidation on the distribution.
#
# Env vars (set before running, or override on the command line):
#   S3_BUCKET            e.g. quintar-ops-frontend-dev
#   CF_DISTRIBUTION_ID   e.g. E1ABC234DEF567

set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET env var is required (e.g. quintar-ops-frontend-dev)}"
: "${CF_DISTRIBUTION_ID:?CF_DISTRIBUTION_ID env var is required}"

DIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist"

if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: $DIST_DIR not found. Run: node build-frontend.mjs" >&2
  exit 1
fi

# Sanity: refuse to ship if amplify_outputs.js still has placeholder values.
if grep -q 'YOUR-APPSYNC-ID\|YOUR-API-KEY' "$DIST_DIR/amplify_outputs.js"; then
  echo "ERROR: dist/amplify_outputs.js still has placeholder values." >&2
  echo "       Replace with real AppSync endpoint/region/apiKey before deploying." >&2
  exit 1
fi

echo "==> Syncing $DIST_DIR -> s3://$S3_BUCKET/"
aws s3 sync "$DIST_DIR/" "s3://$S3_BUCKET/" \
  --delete \
  --cache-control "max-age=300"

echo "==> Invalidating CloudFront ($CF_DISTRIBUTION_ID)"
aws cloudfront create-invalidation \
  --distribution-id "$CF_DISTRIBUTION_ID" \
  --paths "/*" \
  > /dev/null

echo "Done. Site live at https://playground.quintar.ai (after CF propagation, usually < 1 min)."
