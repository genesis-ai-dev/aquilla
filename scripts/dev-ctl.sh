#!/usr/bin/env bash
# Start/stop the local Aquilla dev stack outside Cursor's ephemeral shells.
#
# Usage:
#   ./scripts/dev-ctl.sh start    # background daemon (survives terminal close)
#   ./scripts/dev-ctl.sh stop
#   ./scripts/dev-ctl.sh status
#   ./scripts/dev-ctl.sh refresh  # restart stack (then Cmd+R in the browser)
#   ./scripts/dev-ctl.sh watch    # foreground health loop (debug)
#   ./scripts/dev-ctl.sh watch-start / watch-stop
#   ./scripts/dev-ctl.sh logs     # tail the daemon log
#   ./scripts/dev-ctl.sh attach   # open a dedicated Terminal tab (interactive)
#
# One-time shell commands (after ./scripts/install-aq-commands.sh):
#   startaq    # start watchdog + dev stack
#   refresh    # restart dev stack
#   stopaq     # stop watchdog + dev stack
#
# Flags passed through to dev-stack (after --):
#   ./scripts/dev-ctl.sh start -- --no-sandbox

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.dev-stack-logs"
LOG_FILE="$LOG_DIR/dev-stack.out"
PID_FILE="$LOG_DIR/dev-stack.pid"
WATCH_PID_FILE="$LOG_DIR/aq-watch.pid"
WATCH_LOG="$LOG_DIR/aq-watch.log"
WATCH_INTERVAL="${AQ_WATCH_INTERVAL:-30}"
SPA_URL="http://127.0.0.1:5173/"

mkdir -p "$LOG_DIR"

# fnm's multishell PATH is tied to the launching terminal and goes stale once
# that shell exits — detached children then lose node/pnpm and die quietly.
resolve_toolchain_bin() {
  if command -v fnm >/dev/null 2>&1; then
    local ver
    ver="$(fnm current 2>/dev/null || true)"
    if [[ -n "$ver" && -d "$HOME/.local/share/fnm/node-versions/$ver/installation/bin" ]]; then
      echo "$HOME/.local/share/fnm/node-versions/$ver/installation/bin"
      return 0
    fi
  fi
  dirname "$(command -v node)"
}

find_stack_pid() {
  pgrep -f "scripts/dev-stack.ts" 2>/dev/null | head -1
}

find_watch_pid() {
  if [[ -f "$WATCH_PID_FILE" ]]; then
    cat "$WATCH_PID_FILE"
  fi
}

watch_is_running() {
  local pid="${1:-$(find_watch_pid || true)}"
  is_running "$pid"
}

write_pid() {
  local pid="${1:-}"
  if [[ -n "$pid" ]]; then
    echo "$pid" >"$PID_FILE"
  fi
}

ensure_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if command -v colima >/dev/null 2>&1; then
    echo "[dev-ctl] starting Colima…"
    colima start
    return 0
  fi
  echo "[dev-ctl] Docker is not running and Colima is not installed." >&2
  echo "  Install Colima: brew install colima docker" >&2
  exit 1
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  fi
}

is_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

http_ready() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "$SPA_URL" 2>/dev/null || true)"
  [[ "$code" == "200" ]]
}

wait_ready() {
  local i
  for i in $(seq 1 90); do
    if http_ready; then
      return 0
    fi
    sleep 2
  done
  return 1
}

collect_extra_args() {
  local args=()
  local seen_dash_dash=0
  for arg in "$@"; do
    if [[ "$seen_dash_dash" -eq 1 ]]; then
      args+=("$arg")
    elif [[ "$arg" == "--" ]]; then
      seen_dash_dash=1
    fi
  done
  if [[ ${#args[@]} -eq 0 ]]; then
    args=(--no-sandbox)
  fi
  printf '%s ' "${args[@]}"
}

cmd_start() {
  local pid extra_args launcher toolchain_bin
  pid="$(read_pid || true)"
  if is_running "$pid"; then
    echo "[dev-ctl] already running (pid $pid)"
    echo "         $SPA_URL"
    exit 0
  fi
  pid="$(find_stack_pid || true)"
  if is_running "$pid"; then
    write_pid "$pid"
    echo "[dev-ctl] already running (pid $pid)"
    echo "         $SPA_URL"
    exit 0
  fi
  if http_ready; then
    echo "[dev-ctl] something is already serving $SPA_URL (no pid file)"
    exit 0
  fi

  ensure_docker

  extra_args="$(collect_extra_args "$@")"
  toolchain_bin="$(resolve_toolchain_bin)"
  launcher="$LOG_DIR/launcher.sh"
  cat >"$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$(printf '%q' "$toolchain_bin"):\$PATH"
cd $(printf '%q' "$ROOT")
exec pnpm dev -- ${extra_args}
EOF
  chmod +x "$launcher"

  echo "[dev-ctl] starting dev stack in background…"
  echo "[dev-ctl] log: $LOG_FILE"

  nohup "$launcher" >>"$LOG_FILE" 2>&1 < /dev/null &
  disown "$!" 2>/dev/null || true

  if wait_ready; then
    pid="$(find_stack_pid || true)"
    write_pid "$pid"
    echo "[dev-ctl] ready"
    echo "         web -> $SPA_URL"
    echo "         pid -> ${pid:-unknown}"
    echo "         stop with: ./scripts/dev-ctl.sh stop"
  else
    echo "[dev-ctl] timed out waiting for $SPA_URL — check logs:" >&2
    echo "         tail -f $LOG_FILE" >&2
    exit 1
  fi
}

cmd_stop() {
  local pid
  pid="$(read_pid || true)"
  if is_running "$pid"; then
    echo "[dev-ctl] stopping pid $pid…"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do
      if ! is_running "$pid"; then
        break
      fi
      sleep 1
    done
    if is_running "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  if pkill -f "scripts/dev-stack.ts" 2>/dev/null; then
    echo "[dev-ctl] stopped dev-stack process tree"
  elif ! is_running "$pid"; then
    echo "[dev-ctl] no running dev-stack found"
  fi
  rm -f "$PID_FILE"
  echo "[dev-ctl] stopped"
}

cmd_status() {
  local pid
  pid="$(read_pid || true)"
  if ! is_running "$pid"; then
    pid="$(find_stack_pid || true)"
    if is_running "$pid"; then
      write_pid "$pid"
    fi
  fi
  if is_running "$pid"; then
    echo "running (pid $pid)"
  elif http_ready; then
    echo "responding at $SPA_URL (untracked — started outside dev-ctl?)"
  else
    echo "stopped"
    exit 1
  fi
  echo "log: $LOG_FILE"
}

cmd_logs() {
  touch "$LOG_FILE"
  tail -f "$LOG_FILE"
}

cmd_refresh() {
  echo "[dev-ctl] refreshing dev stack…"
  cmd_stop || true
  sleep 1
  cmd_start "$@"
  echo "[dev-ctl] stack restarted."
  echo "[dev-ctl] reload the app in your browser (Cmd+R) — that picks up the new servers."
  echo "         $SPA_URL"
}

cmd_watch() {
  local extra_args
  extra_args="$(collect_extra_args "$@")"
  ensure_docker
  echo "[aq-watch] watching $SPA_URL every ${WATCH_INTERVAL}s (log: $WATCH_LOG)"
  if ! http_ready; then
    echo "[aq-watch] stack is down — starting…"
    cmd_start "$@" || true
  fi
  while true; do
    if ! http_ready; then
      echo "[aq-watch] $(date '+%H:%M:%S') stack unreachable — restarting…" >>"$WATCH_LOG"
      cmd_stop || true
      sleep 2
      if ! cmd_start "$@"; then
        echo "[aq-watch] $(date '+%H:%M:%S') restart failed — will retry" >>"$WATCH_LOG"
      fi
    fi
    sleep "$WATCH_INTERVAL"
  done
}

cmd_watch_start() {
  if watch_is_running; then
    echo "[aq-watch] already running (pid $(find_watch_pid))"
    if ! http_ready; then
      echo "[aq-watch] stack is down — restarting…"
      cmd_refresh "$@"
    else
      echo "         $SPA_URL"
    fi
    exit 0
  fi

  ensure_docker
  echo "[aq-watch] starting watchdog…"
  nohup bash "$ROOT/scripts/dev-ctl.sh" watch "$@" >>"$WATCH_LOG" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$WATCH_PID_FILE"

  if ! http_ready; then
    cmd_start "$@"
  fi

  echo "[aq-watch] watchdog running (pid $pid)"
  echo "         web  -> $SPA_URL"
  echo "         log  -> $WATCH_LOG"
  echo "         stop -> stopaq"
}

cmd_watch_stop() {
  local pid
  pid="$(find_watch_pid || true)"
  if watch_is_running "$pid"; then
    echo "[aq-watch] stopping watchdog (pid $pid)…"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      if ! watch_is_running "$pid"; then
        break
      fi
      sleep 1
    done
    if watch_is_running "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  else
    pkill -f "dev-ctl.sh watch" 2>/dev/null || true
  fi
  rm -f "$WATCH_PID_FILE"
  echo "[aq-watch] watchdog stopped"
}

cmd_stop_all() {
  cmd_watch_stop
  cmd_stop
}

cmd_attach() {
  ensure_docker
  local extra_args
  extra_args="$(collect_extra_args "$@")"
  osascript <<EOF
tell application "Terminal"
  activate
  do script "cd $(printf '%q' "$ROOT") && pnpm dev -- ${extra_args}"
end tell
EOF
  echo "[dev-ctl] opened Terminal tab — leave it open while you work"
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    start) cmd_start "$@" ;;
    stop) cmd_stop ;;
    refresh) cmd_refresh "$@" ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    watch) cmd_watch "$@" ;;
    watch-start|watchstart) cmd_watch_start "$@" ;;
    watch-stop|watchstop) cmd_watch_stop ;;
    stop-all|stopall) cmd_stop_all ;;
    attach) cmd_attach "$@" ;;
    ""|-h|--help|help) usage ;;
    *)
      echo "unknown command: $cmd" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
