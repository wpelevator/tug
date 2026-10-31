#!/usr/bin/env bash
set -euo pipefail

# CI prebuilds the images with a layer cache and sets TUG_COMPOSE_BUILD="" to skip the rebuild.
BUILD_FLAG=${TUG_COMPOSE_BUILD---build}

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.integration.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-tug-it}
TOKEN=${TUG_TOKEN:-integration-token}
CONTROL=${TUG_CONTROL_URL:-http://localhost:18080}

cleanup() {
  if [ "${KEEP_INTEGRATION_STACK:-false}" != "true" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d $BUILD_FLAG

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

TUG_CONFIG=$(mktemp)
export TUG_CONFIG TUG_TOKEN="$TOKEN" TUG_CONTROL_URL="$CONTROL"
node -e 'require("node:fs").writeFileSync(process.env.TUG_CONFIG, "{}")'
node src/cli.ts init --control-url "$CONTROL" --token "$TOKEN" --project sample
node src/cli.ts secret-set SAMPLE_SECRET --project sample --value integration-secret
node src/cli.ts deploy -f docker-compose.sample.yml --project sample
node tools/scripts/integration-verify.js

echo "integration test passed"
