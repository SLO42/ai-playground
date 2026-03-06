#!/usr/bin/env bash
# patch-agentdb.sh — Postinstall: fix agentdb paths + preserve daemon PID state
# The package exports from dist/controllers/ but tsc outputs to dist/src/controllers/

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- 1. AgentDB dist/controllers fix ---
AGENTDB_DIST="node_modules/agentdb/dist"

if [[ -d "$AGENTDB_DIST/src/controllers" && ! -e "$AGENTDB_DIST/controllers" ]]; then
  ln -s src/controllers "$AGENTDB_DIST/controllers"
  echo "[patch-agentdb] Symlinked dist/controllers -> dist/src/controllers"
fi

# --- 2. Ensure state directories survive npm install ---
mkdir -p "$PROJECT_ROOT/.claude-flow"
mkdir -p "$PROJECT_ROOT/.playground"

# --- 3. Recover daemon PID state ---
# If the daemon process is still alive but the PID file was lost, try to recover.
PID_FILE="$PROJECT_ROOT/.claude-flow/daemon.pid"
PID_BACKUP="$PROJECT_ROOT/.claude-flow/.daemon.pid.bak"
STATE_FILE="$PROJECT_ROOT/.claude-flow/daemon-state.json"

is_windows() {
  [[ "$OSTYPE" == "msys" || "$OSTYPE" == "mingw"* || "$OSTYPE" == "cygwin" ]];
}

is_alive() {
  local pid="$1"
  if is_windows; then
    tasklist //FI "PID eq $pid" 2>/dev/null | grep -q "$pid"
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

# Restore PID file from backup if missing but backup exists
if [[ ! -f "$PID_FILE" && -f "$PID_BACKUP" ]]; then
  backup_pid=$(cat "$PID_BACKUP" 2>/dev/null | tr -d '[:space:]')
  if [[ -n "$backup_pid" && "$backup_pid" =~ ^[0-9]+$ ]] && is_alive "$backup_pid"; then
    cp "$PID_BACKUP" "$PID_FILE"
    echo "[postinstall] Recovered daemon PID $backup_pid from backup"
  else
    rm -f "$PID_BACKUP"
  fi
fi

# Create/update backup of current PID file
if [[ -f "$PID_FILE" ]]; then
  cp "$PID_FILE" "$PID_BACKUP"
fi
