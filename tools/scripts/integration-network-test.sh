#!/usr/bin/env bash
# End-to-end check of the WireGuard mesh, service DNS and Caddy ingress across three privileged
# fake VPSes. Needs a Docker host whose kernel supports WireGuard (e.g. Docker Desktop, any Linux 5.6+).
set -euo pipefail

# CI prebuilds the images with a layer cache and sets TUG_COMPOSE_BUILD="" to skip the rebuild.
BUILD_FLAG=${TUG_COMPOSE_BUILD---build}

COMPOSE_FILES=(-f docker-compose.integration.yml -f docker-compose.integration-network.yml)
PROJECT=${COMPOSE_PROJECT_NAME:-tug-it-net}
# Connect target only: the credential's public URL (https://control:8443) is what gets verified.
CONTROL=${TUG_CONTROL_URL:-https://127.0.0.1:18080}

cleanup() {
  if [ "${KEEP_INTEGRATION_STACK:-false}" != "true" ]; then
    docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" up -d $BUILD_FLAG

CRED_DIR=$(mktemp -d)
CRED="$CRED_DIR/root.credential.json"
for i in $(seq 1 120); do
  if docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" cp provisioner:/tokens/root.credential.json "$CRED" >/dev/null 2>&1 && [ -s "$CRED" ]; then
    chmod 0600 "$CRED"
    break
  fi
  if [ "$i" = "120" ]; then
    docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" logs --no-color
    exit 1
  fi
  sleep 1
done

TUG_CONFIG=$(mktemp)
export TUG_CONFIG TUG_CREDENTIAL_FILE="$CRED" TUG_CONTROL_URL="$CONTROL"
node -e 'require("node:fs").writeFileSync(process.env.TUG_CONFIG, "{}")'
node src/cli.ts deploy -f docker-compose.network-sample.yml --project netdemo --timeout 240
COMPOSE_PROJECT_NAME="$PROJECT" node tools/scripts/integration-verify-network.js

echo "network integration test passed"
