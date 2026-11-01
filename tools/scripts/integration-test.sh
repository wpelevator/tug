#!/usr/bin/env bash
set -euo pipefail

# CI prebuilds the images with a layer cache and sets TUG_COMPOSE_BUILD="" to skip the rebuild.
BUILD_FLAG=${TUG_COMPOSE_BUILD---build}

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.integration.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-tug-it}
# Connect target only: the credential's public URL (https://control:8443) is what gets verified.
CONTROL=${TUG_CONTROL_URL:-https://127.0.0.1:18080}

cleanup() {
  if [ "${KEEP_INTEGRATION_STACK:-false}" != "true" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d $BUILD_FLAG

CRED_DIR=$(mktemp -d)
CRED="$CRED_DIR/root.credential.json"
for i in $(seq 1 120); do
  if docker compose -p "$PROJECT" -f "$COMPOSE_FILE" cp provisioner:/tokens/root.credential.json "$CRED" >/dev/null 2>&1 && [ -s "$CRED" ]; then
    chmod 0600 "$CRED"
    break
  fi
  if [ "$i" = "120" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --no-color
    exit 1
  fi
  sleep 1
done

TUG_CONFIG=$(mktemp)
export TUG_CONFIG TUG_CREDENTIAL_FILE="$CRED" TUG_CONTROL_URL="$CONTROL"
node -e 'require("node:fs").writeFileSync(process.env.TUG_CONFIG, "{}")'
node src/cli.ts secret-set SAMPLE_SECRET --project sample --value integration-secret
node src/cli.ts deploy -f docker-compose.sample.yml --project sample
node tools/scripts/integration-verify.js

echo "integration test passed"
