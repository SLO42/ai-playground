#!/usr/bin/env bash
# daemon-ctl.sh — Safe daemon start/stop with proper PID cleanup on Windows + POSIX
# Usage: ./scripts/daemon-ctl.sh [start|stop|restart|status]

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$PROJECT_ROOT/.claude-flow"
PID_FILE="$STATE_DIR/daemon.pid"
STATE_FILE="$STATE_DIR/daemon-state.json"
LOG_FILE="$STATE_DIR/daemon.log"

# Detect OS
is_windows() {
  [[ "$OSTYPE" == "msys" || "$OSTYPE" == "mingw"* || "$OSTYPE" == "cygwin" ]];
}

# Check if a PID is alive (works on both Windows and POSIX)
is_alive() {
  local pid="$1"
  if is_windows; then
    tasklist //FI "PID eq $pid" 2>/dev/null | grep -q "$pid"
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

# Kill a process safely (works on both Windows and POSIX)
safe_kill() {
  local pid="$1"
  if ! is_alive "$pid"; then
    return 0
  fi

  echo "Stopping daemon (PID: $pid)..."

  if is_windows; then
    taskkill //PID "$pid" //T 2>/dev/null || true
    sleep 1
    if is_alive "$pid"; then
      echo "Force killing PID $pid..."
      taskkill //F //PID "$pid" //T 2>/dev/null || true
    fi
  else
    kill "$pid" 2>/dev/null || true
    # Wait up to 3 seconds for graceful shutdown
    for i in 1 2 3; do
      if ! is_alive "$pid"; then break; fi
      sleep 1
    done
    if is_alive "$pid"; then
      echo "Force killing PID $pid..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}

# Clean up stale PID file and daemon state
cleanup_stale() {
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
    if [[ -n "$old_pid" && "$old_pid" =~ ^[0-9]+$ ]]; then
      if is_alive "$old_pid"; then
        safe_kill "$old_pid"
      fi
    fi
    rm -f "$PID_FILE"
  fi

  # Reset daemon-state.json running flag
  if [[ -f "$STATE_FILE" ]]; then
    if command -v node &>/dev/null; then
      node -e "
        const fs = require('fs');
        try {
          const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
          s.running = false;
          fs.writeFileSync('$STATE_FILE', JSON.stringify(s, null, 2));
        } catch {}
      " 2>/dev/null || true
    fi
  fi
}

cmd_stop() {
  echo "Stopping daemon..."
  cleanup_stale
  # Also try the CLI stop command
  cd "$PROJECT_ROOT"
  npx @claude-flow/cli@latest daemon stop 2>/dev/null || true
  echo "Daemon stopped."
}

cmd_start() {
  # Always clean up before starting
  cleanup_stale
  echo "Starting daemon..."
  cd "$PROJECT_ROOT"

  # On Windows, the CLI's built-in background spawn breaks on paths with spaces
  # (e.g. "C:\Program Files\nodejs\node.exe"). Instead, we run foreground mode
  # and let bash handle backgrounding — bash properly quotes the path.
  npx @claude-flow/cli@latest daemon start --foreground \
    >> "$LOG_FILE" 2>&1 &

  # The foreground daemon writes its own PID file with the real Windows PID.
  # Wait for it to appear (up to 10 seconds).
  local waited=0
  while [[ ! -f "$PID_FILE" && $waited -lt 10 ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if [[ -f "$PID_FILE" ]]; then
    local real_pid
    real_pid=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
    # Update state file
    if command -v node &>/dev/null; then
      node -e "
        const fs = require('fs');
        const f = '$STATE_FILE';
        try {
          const s = JSON.parse(fs.readFileSync(f,'utf8'));
          s.running = true;
          s.startedAt = new Date().toISOString();
          fs.writeFileSync(f, JSON.stringify(s, null, 2));
        } catch {}
      " 2>/dev/null || true
    fi
    # Backup PID file so postinstall can recover it
    cp "$PID_FILE" "$STATE_DIR/.daemon.pid.bak" 2>/dev/null || true
    echo "Daemon started in background (PID: $real_pid)"
    echo "Logs: $LOG_FILE"
  else
    echo "ERROR: Daemon failed to start. Check $LOG_FILE"
    return 1
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
    if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]] && is_alive "$pid"; then
      echo "Daemon is running (PID: $pid)"
      return 0
    else
      echo "Daemon is not running (stale PID file: $pid)"
      cleanup_stale
      return 1
    fi
  else
    echo "Daemon is not running (no PID file)"
    return 1
  fi
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
