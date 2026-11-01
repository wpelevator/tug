#!/usr/bin/env bash
set -euo pipefail

: "${TUG_NODE_NAME:?TUG_NODE_NAME is required}"
: "${TUG_STATE_DIR:=/var/lib/tug}"
: "${TUG_APPLY:=true}"
: "${TUG_POLL_INTERVAL_MS:=2000}"

echo "[$TUG_NODE_NAME] starting fake VPS Docker daemon"
mkdir -p /var/lib/docker /var/run "$TUG_STATE_DIR"
# A container restart kills dockerd without its normal pid-file cleanup.
rm -f /var/run/docker.pid /var/run/docker.sock
dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs >/var/log/dockerd.log 2>&1 &

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

echo "[$TUG_NODE_NAME] waiting for provisioned identity"
IDENTITY_DIR="/tokens/${TUG_NODE_NAME}"
if [ ! -s "$TUG_STATE_DIR/agent.json" ]; then
  for i in $(seq 1 120); do
    [ -s "$IDENTITY_DIR/agent.json" ] && break
    sleep 1
  done
  if [ ! -s "$IDENTITY_DIR/agent.json" ]; then
    echo "missing identity $IDENTITY_DIR/agent.json" >&2
    exit 1
  fi
  install -m 0600 "$IDENTITY_DIR/agent.json" "$TUG_STATE_DIR/agent.json"
fi

export TUG_NODE_NAME TUG_STATE_DIR TUG_APPLY TUG_POLL_INTERVAL_MS
exec node /app/src/main.ts agent
