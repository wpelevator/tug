#!/usr/bin/env bash
set -euo pipefail

: "${TUG_NODE_NAME:?TUG_NODE_NAME is required}"
: "${TUG_CONTROL_URL:=http://control:8080}"
: "${TUG_STATE_DIR:=/var/lib/tug}"
: "${TUG_APPLY:=true}"
: "${TUG_POLL_INTERVAL_MS:=2000}"

echo "[$TUG_NODE_NAME] starting fake VPS Docker daemon"
mkdir -p /var/lib/docker /var/run "$TUG_STATE_DIR"
dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs ${TUG_REGISTRY:+--insecure-registry "$TUG_REGISTRY"} >/var/log/dockerd.log 2>&1 &

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

echo "[$TUG_NODE_NAME] waiting for provisioned token"
TOKEN_FILE="/tokens/${TUG_NODE_NAME}.env"
for i in $(seq 1 120); do
  if [ -s "$TOKEN_FILE" ]; then
    # shellcheck disable=SC1090
    source "$TOKEN_FILE"
    break
  fi
  sleep 1
done

if [ -z "${TUG_AGENT_TOKEN:-}" ]; then
  echo "missing token file $TOKEN_FILE" >&2
  exit 1
fi

if [ -n "${TUG_REGISTRY:-}" ] && [ -n "${TUG_REGISTRY_TOKEN:-}" ]; then
  echo "[$TUG_NODE_NAME] docker login $TUG_REGISTRY"
  for i in $(seq 1 10); do
    if echo "$TUG_REGISTRY_TOKEN" | docker login "$TUG_REGISTRY" --username "$TUG_NODE_NAME" --password-stdin; then
      break
    fi
    if [ "$i" = "10" ]; then
      echo "docker login to $TUG_REGISTRY failed" >&2
      exit 1
    fi
    sleep 2
  done
fi

export TUG_CONTROL_URL TUG_NODE_NAME TUG_AGENT_TOKEN TUG_STATE_DIR TUG_APPLY TUG_POLL_INTERVAL_MS
exec node /app/src/main.ts agent
