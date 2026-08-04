#!/usr/bin/env bash
# E2E: acp-host remote WebSocket on an OrbStack Linux VM, client on macOS.
#
# Usage:
#   bash scripts/e2e-remote-host-orb.sh
# Env:
#   ORB_MACHINE   default: barkvisor-u24
#   HOST_PORT     default: 18791
#   HOST_TOKEN    default: e2e-orb-token
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ORB_MACHINE="${ORB_MACHINE:-barkvisor-u24}"
HOST_PORT="${HOST_PORT:-18791}"
HOST_TOKEN="${HOST_TOKEN:-e2e-orb-token}"
# Prefer a path under the repo (Orb VMs can write Mac paths that are project-local).
SCRATCH="${SCRATCH:-$ROOT/data/e2e-orb}"
mkdir -p "$SCRATCH"

BIN_LINUX="$ROOT/dist/acpbot-linux-arm64"
STATE_REMOTE="$SCRATCH/remote-state"
STATE_LOCAL="$SCRATCH/local-state"
CONFIG_REMOTE="$SCRATCH/remote-config.toml"
PID_FILE="$SCRATCH/remote-host.pid"
LOG_FILE="$SCRATCH/remote-host.log"
RESULT_FILE="$SCRATCH/e2e-result.json"

log() { printf '[e2e-orb] %s\n' "$*"; }

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]]; then
      orb run -m "$ORB_MACHINE" kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # also kill by port if leftover
  orb run -m "$ORB_MACHINE" sh -c \
    "fuser -k ${HOST_PORT}/tcp 2>/dev/null || true" || true
}
trap cleanup EXIT

log "machine=$ORB_MACHINE port=$HOST_PORT"

# Resolve VM IP
VM_IP="$(orb run -m "$ORB_MACHINE" sh -c "ip -4 -o addr show eth0 | awk '{print \$4}' | cut -d/ -f1" | tr -d '[:space:]')"
if [[ -z "$VM_IP" ]]; then
  log "failed to resolve VM IP"
  exit 1
fi
log "vm_ip=$VM_IP"

# Compile linux arm64 binary if missing or source newer
if [[ ! -x "$BIN_LINUX" ]] || [[ src/main.ts -nt "$BIN_LINUX" ]]; then
  log "compiling acpbot for bun-linux-arm64..."
  mkdir -p dist
  bun build --compile --target=bun-linux-arm64 --outfile="$BIN_LINUX" src/main.ts
fi

# Remote host config (no bot token required for host)
mkdir -p "$STATE_REMOTE" "$STATE_LOCAL"
cat >"$CONFIG_REMOTE" <<EOF
# e2e remote host - generated
default_agent = "grok-build"
log_level = "info"
store_path = "$STATE_REMOTE/store.json"
state_dir = "$STATE_REMOTE"

[host_listen]
port = $HOST_PORT
host = "0.0.0.0"
token = "$HOST_TOKEN"
EOF

# Paths are Mac paths; Orb mounts them at the same location on the VM.
log "starting remote acp-host on $ORB_MACHINE..."
orb run -m "$ORB_MACHINE" sh -c "
  mkdir -p '$STATE_REMOTE'
  export ACPBOT_CONFIG='$CONFIG_REMOTE'
  export ACPBOT_STATE_DIR='$STATE_REMOTE'
  export ACPBOT_HOST_LISTEN_PORT=$HOST_PORT
  export ACPBOT_HOST_LISTEN_HOST=0.0.0.0
  export ACPBOT_HOST_TOKEN='$HOST_TOKEN'
  nohup '$BIN_LINUX' host >'$LOG_FILE' 2>&1 &
  echo \$! >'$PID_FILE'
  sleep 0.3
  cat '$PID_FILE'
"

# Wait for listen
for i in $(seq 1 40); do
  if grep -q "remote WebSocket" "$LOG_FILE" 2>/dev/null \
    || grep -q "listening on" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  # also try TCP
  if orb run -m "$ORB_MACHINE" sh -c "ss -lnt 2>/dev/null | grep -q ':$HOST_PORT' || netstat -lnt 2>/dev/null | grep -q ':$HOST_PORT'"; then
    break
  fi
  sleep 0.25
done

log "remote host log (tail):"
tail -20 "$LOG_FILE" || true

# Client e2e on Mac against VM IP
export E2E_REMOTE_URL="ws://${VM_IP}:${HOST_PORT}"
export E2E_REMOTE_TOKEN="$HOST_TOKEN"
export E2E_RESULT_FILE="$RESULT_FILE"
export E2E_SCRATCH="$SCRATCH"

log "running client checks against $E2E_REMOTE_URL"
python3 "$ROOT/scripts/e2e-run-client.py" "$ROOT/scripts/e2e-remote-host-client.ts"

log "OK - results in $RESULT_FILE"
cat "$RESULT_FILE"
echo
log "passed"
exit 0
