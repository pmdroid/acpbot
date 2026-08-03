#!/usr/bin/env bash
# Role selector for the acpbot image: host | worker | both
# One binary: acpbot host / acpbot worker
set -euo pipefail

ROLE="${1:-worker}"
STATE_DIR="${ACPBOT_STATE_DIR:-/data/state}"
export ACPBOT_STATE_DIR="$STATE_DIR"
mkdir -p "$STATE_DIR"

case "$ROLE" in
  host|acp-host)
    echo "acpbot: starting host (state=$STATE_DIR)"
    exec acpbot host
    ;;
  worker|start)
    echo "acpbot: starting worker (state=$STATE_DIR)"
    # Fail fast if host socket missing (same as bare binary).
    exec acpbot worker
    ;;
  both)
    # Dev convenience: host in background, worker in foreground.
    echo "acpbot: starting host + worker in one container"
    acpbot host &
    HOST_PID=$!
    # Wait briefly for the unix socket
    SOCK="${ACPBOT_ACP_HOST_SOCK:-$STATE_DIR/acp-host.sock}"
    for _ in $(seq 1 50); do
      if [ -S "$SOCK" ]; then
        break
      fi
      sleep 0.1
    done
    trap 'kill $HOST_PID 2>/dev/null || true' EXIT INT TERM
    exec acpbot worker
    ;;
  *)
    echo "usage: acpbot-entrypoint {host|worker|both}" >&2
    exit 2
    ;;
esac
