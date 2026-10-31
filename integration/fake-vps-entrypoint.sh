#!/usr/bin/env bash
set -euo pipefail

: "${LAUNCHPAD_NODE_NAME:?LAUNCHPAD_NODE_NAME is required}"
: "${LAUNCHPAD_CONTROL_URL:=http://control:8080}"
: "${LAUNCHPAD_STATE_DIR:=/var/lib/launchpad}"
: "${LAUNCHPAD_APPLY:=true}"
: "${LAUNCHPAD_POLL_INTERVAL_MS:=2000}"

echo "[$LAUNCHPAD_NODE_NAME] starting fake VPS Docker daemon"
mkdir -p /var/lib/docker /var/run "$LAUNCHPAD_STATE_DIR"
dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs ${LAUNCHPAD_REGISTRY:+--insecure-registry "$LAUNCHPAD_REGISTRY"} >/var/log/dockerd.log 2>&1 &

for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = "60" ]; then
    echo "dockerd did not become ready" >&2
    tail -200 /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 1
done

echo "[$LAUNCHPAD_NODE_NAME] waiting for provisioned token"
TOKEN_FILE="/tokens/${LAUNCHPAD_NODE_NAME}.env"
for i in $(seq 1 120); do
  if [ -s "$TOKEN_FILE" ]; then
    # shellcheck disable=SC1090
    source "$TOKEN_FILE"
    break
  fi
  sleep 1
done

if [ -z "${LAUNCHPAD_AGENT_TOKEN:-}" ]; then
  echo "missing token file $TOKEN_FILE" >&2
  exit 1
fi

if [ -n "${LAUNCHPAD_REGISTRY:-}" ] && [ -n "${LAUNCHPAD_REGISTRY_TOKEN:-}" ]; then
  echo "[$LAUNCHPAD_NODE_NAME] docker login $LAUNCHPAD_REGISTRY"
  for i in $(seq 1 10); do
    if echo "$LAUNCHPAD_REGISTRY_TOKEN" | docker login "$LAUNCHPAD_REGISTRY" --username "$LAUNCHPAD_NODE_NAME" --password-stdin; then
      break
    fi
    if [ "$i" = "10" ]; then
      echo "docker login to $LAUNCHPAD_REGISTRY failed" >&2
      exit 1
    fi
    sleep 2
  done
fi

export LAUNCHPAD_CONTROL_URL LAUNCHPAD_NODE_NAME LAUNCHPAD_AGENT_TOKEN LAUNCHPAD_STATE_DIR LAUNCHPAD_APPLY LAUNCHPAD_POLL_INTERVAL_MS
exec node /app/src/main.ts agent
