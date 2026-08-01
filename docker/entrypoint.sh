#!/usr/bin/env bash
# Role selector for the acpbot image: host | worker | both
set -euo pipefail

ROLE="${1:-worker}"
STATE_DIR="${ACPBOT_STATE_DIR:-${TACP_STATE_DIR:-/data/state}}"
export ACPBOT_STATE_DIR="$STATE_DIR"
export TACP_STATE_DIR="$STATE_DIR"
mkdir -p "$STATE_DIR"

case "$ROLE" in
  host|acp-host)
    echo "acpbot: starting acp-host (state=$STATE_DIR)"
    exec acpbot-host
    ;;
  worker|start)
    echo "acpbot: starting worker (state=$STATE_DIR)"
    # Fail fast if host socket missing (same as bare binary).
    exec acpbot
    ;;
  both)
    # Dev convenience: host in background, worker in foreground.
    echo "acpbot: starting host + worker in one container"
    acpbot-host &
    HOST_PID=$!
    # Wait briefly for the unix socket
    for _ in $(seq 1 50); do
      if [ -S "${ACPBOT_ACP_HOST_SOCK:-$STATE_DIR/acp-host.sock}" ] \
        || [ -S "${TACP_ACP_HOST_SOCK:-$STATE_DIR/acp-host.sock}" ] \
        || [ -S "$STATE_DIR/acp-host.sock" ]; then
        break
      fi
      sleep 0.1
    done
    trap 'kill $HOST_PID 2>/dev/null || true' EXIT INT TERM
    exec acpbot
    ;;
  *)
    echo "usage: acpbot-entrypoint {host|worker|both}" >&2
    exit 2
    ;;
esac
