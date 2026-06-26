#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.integration.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-pad-launch-it}
TOKEN=${LAUNCHPAD_TOKEN:-integration-token}
CONTROL=${LAUNCHPAD_CONTROL_URL:-http://localhost:18080}

cleanup() {
  if [ "${KEEP_INTEGRATION_STACK:-false}" != "true" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build

for i in $(seq 1 120); do
  if curl -fsS "$CONTROL/healthz" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = "120" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --no-color
    exit 1
  fi
  sleep 1
done

LAUNCHPAD_CONFIG=$(mktemp)
export LAUNCHPAD_CONFIG LAUNCHPAD_TOKEN="$TOKEN" LAUNCHPAD_CONTROL_URL="$CONTROL"
node src/cli.js init --control-url "$CONTROL" --token "$TOKEN" --project sample
node src/cli.js secret:set SAMPLE_SECRET --project sample --value integration-secret
node src/cli.js deploy -f docker-compose.sample.yml --project sample --no-build-upload
node scripts/integration-verify.js
LAUNCHPAD_REGISTRY_URL=http://localhost:15000 node scripts/integration-verify-registry-auth.js

echo "integration test passed"
