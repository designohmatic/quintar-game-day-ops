#!/usr/bin/env bash
#
# deploy-backend.sh — rsync backend code to EC2 and reload PM2.
#
# Prereqs (one-time, see DEPLOY.md):
#   - EC2 box has /opt/quintar/game-day-ops/ owned by the deploy user
#   - PM2 already running with the quintar-ops app entry from ecosystem.config.js
#   - The EC2 instance role has secretsmanager:GetSecretValue on quintar-ops/*
#
# Env vars:
#   EC2_HOST   e.g. ec2-user@10.0.0.42  (must be set up in ~/.ssh/config or
#                                        reachable with the agent's key)

set -euo pipefail

: "${EC2_HOST:?EC2_HOST env var is required (e.g. ec2-user@10.0.0.42)}"

APP_DIR="/opt/quintar/game-day-ops"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Pushing code to $EC2_HOST:$APP_DIR"
# Note: ecosystem.config.js is NOT pushed — IT maintains the existing one on
# the box and merges the quintar-ops entry from this repo into it by hand.
rsync -avz \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  --exclude='.claude/' \
  --exclude='.env.local' \
  --exclude='amplify_outputs.js' \
  "$SRC_DIR/server" \
  "$SRC_DIR/roster.json" \
  "$SRC_DIR/template.json" \
  "$EC2_HOST:$APP_DIR/"

echo "==> Installing prod deps and reloading PM2"
# shellcheck disable=SC2087
ssh "$EC2_HOST" bash <<'REMOTE'
set -euo pipefail
cd /opt/quintar/game-day-ops/server
npm ci --omit=dev
pm2 reload quintar-ops
pm2 save
REMOTE

echo "==> Health check"
ssh "$EC2_HOST" "curl -sf http://localhost:3005/health" && echo
echo "Done. Tail logs: ssh $EC2_HOST 'pm2 logs quintar-ops --lines 30'"
