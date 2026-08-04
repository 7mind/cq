#!/usr/bin/env bash
# Hook-authority tests for the yolo clipboard bridge (defects:D262,
# tasks:T1796): accepted fixed operations CAN trigger host-configured tmux
# hooks, and rejected traffic can trigger neither the adapter nor the hooks.
#
# The fixture uses ONLY a test-owned private tmux server, configured with
# exit-empty off so it remains alive with zero sessions; its hooks set server
# options only and may never invoke run-shell. It never contacts an inherited
# or active host server, and the broker only ever receives the private socket.
#
# Usage: bash clipboard-proxy-hook-test.sh /path/to/yolo-clipboard-proxy /path/to/tmux
set -u

PROXY="${1:?usage: clipboard-proxy-hook-test.sh /path/to/yolo-clipboard-proxy /path/to/tmux}"
TMUX_REAL="${2:?usage: clipboard-proxy-hook-test.sh /path/to/yolo-clipboard-proxy /path/to/tmux}"
if [[ ! -x "$PROXY" || ! -x "$TMUX_REAL" ]]; then
  echo "FAIL: proxy or tmux not executable: $PROXY / $TMUX_REAL" >&2
  exit 1
fi

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cq-clip-hook.XXXXXX")"
BROKER_PID=""
SERVER_SOCK="$WORKDIR/private-tmux.sock"
cleanup() {
  if [[ -n "$BROKER_PID" ]]; then
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  "$TMUX_REAL" -S "$SERVER_SOCK" kill-server 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$expected" != "$actual" ]]; then
    fail "$desc -- expected [$expected], got [$actual]"
  fi
}

assert_fail() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -eq 0 ]]; then
    fail "$desc -- expected non-zero exit"
  fi
}

hook_value() { # $1 = hook marker name; prints its server-option value or empty
  # show -gq: a plain show -g on an unset option is itself a command error and
  # would re-arm command-error while we measure it.
  "$TMUX_REAL" -S "$SERVER_SOCK" show -gq "$1" 2>/dev/null | awk '{print $2}'
}

# --- Private server: detached fixture session for hook context, exit-empty
# off so the server remains alive with zero sessions after teardown. Hooks
# set server options only — none may invoke run-shell.
"$TMUX_REAL" -S "$SERVER_SOCK" new-session -d -s fixture sleep 300
"$TMUX_REAL" -S "$SERVER_SOCK" set -g exit-empty off
"$TMUX_REAL" -S "$SERVER_SOCK" set-hook -g after-load-buffer 'set -g @hook-load 1'
"$TMUX_REAL" -S "$SERVER_SOCK" set-hook -g after-save-buffer 'set -g @hook-save 1'
"$TMUX_REAL" -S "$SERVER_SOCK" set-hook -g command-error 'set -g @hook-error 1'

# --- Broker bound to the private server only.
"$PROXY" broker \
  --listen "$WORKDIR/broker.sock" \
  --tmux-socket "$SERVER_SOCK" \
  --tmux "$TMUX_REAL" &
BROKER_PID=$!
for _ in $(seq 1 50); do [[ -S "$WORKDIR/broker.sock" ]] && break; sleep 0.05; done
[[ -S "$WORKDIR/broker.sock" ]]
export YOLO_CLIPBOARD_SOCK="$WORKDIR/broker.sock"

sessions_now() { "$TMUX_REAL" -S "$SERVER_SOCK" list-sessions 2>/dev/null; }
panes_now() { "$TMUX_REAL" -S "$SERVER_SOCK" list-panes -a 2>/dev/null | wc -l | tr -d ' '; }
BEFORE_SESSIONS="$(sessions_now)"
BEFORE_PANES="$(panes_now)"

# --- Accepted SET: fixed load-buffer triggers after-load-buffer.
printf 'hook-payload' | "$PROXY" client set
assert_eq "accepted SET triggered after-load-buffer" "1" "$(hook_value @hook-load)"

# --- Accepted GET: fixed save-buffer triggers after-save-buffer.
"$PROXY" client get >/dev/null
assert_eq "accepted GET triggered after-save-buffer" "1" "$(hook_value @hook-save)"

# --- An accepted fixed operation fails harmlessly: GET against the emptied
# buffer makes save-buffer fail, and command-error marks the event.
"$TMUX_REAL" -S "$SERVER_SOCK" delete-buffer
"$PROXY" client get >/dev/null 2>&1
assert_fail "accepted GET on the emptied buffer fails harmlessly" "$?"
assert_eq "harmless accepted failure triggered command-error" "1" "$(hook_value @hook-error)"

# --- Rejected traffic: shim rejections and frame violations must produce
# zero adapter calls and zero hook markers. Clear all markers first.
"$TMUX_REAL" -S "$SERVER_SOCK" set -gu @hook-load
"$TMUX_REAL" -S "$SERVER_SOCK" set -gu @hook-save
"$TMUX_REAL" -S "$SERVER_SOCK" set -gu @hook-error

"$PROXY" tmux-shim run-shell 'touch /tmp/cq-clip-hook-escape' >/dev/null 2>&1
assert_fail "run-shell is rejected before any server contact" "$?"
"$PROXY" tmux-shim new-window -d >/dev/null 2>&1
assert_fail "new-window is rejected" "$?"
"$PROXY" tmux-shim load-buffer -b other - >/dev/null 2>&1
assert_fail "named buffer is rejected" "$?"
python3 - "$WORKDIR/broker.sock" <<'PY'
import socket
import struct
import sys

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(5)
sock.connect(sys.argv[1])
# Valid SET frame with trailing garbage: rejected, never reaches the adapter.
sock.sendall(bytes([1]) + struct.pack("<I", 3) + b"abc" + b"X")
reply = sock.recv(64)
sock.close()
sys.exit(0 if len(reply) >= 1 and reply[0] == 1 else 1)
PY
assert_eq "trailing frame answered with an error" "0" "$?"

assert_eq "rejections produced no after-load-buffer marker" "" "$(hook_value @hook-load)"
assert_eq "rejections produced no after-save-buffer marker" "" "$(hook_value @hook-save)"
assert_eq "rejections produced no command-error marker" "" "$(hook_value @hook-error)"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ -e /tmp/cq-clip-hook-escape ]]; then
  fail "run-shell reached the server (escape marker created)"
  rm -f /tmp/cq-clip-hook-escape
fi

# --- The operations created no session, window, or pane.
assert_eq "operations created no session" "$BEFORE_SESSIONS" "$(sessions_now)"
assert_eq "operations created no window or pane" "$BEFORE_PANES" "$(panes_now)"

# --- Teardown: kill the fixture session; the server, configured to remain
# alive with zero sessions, stays up and empty.
"$TMUX_REAL" -S "$SERVER_SOCK" kill-session -t fixture
TESTS_RUN=$((TESTS_RUN + 1))
if [[ -n "$(sessions_now)" ]]; then
  fail "server holds sessions after fixture teardown: $(sessions_now)"
fi
"$TMUX_REAL" -S "$SERVER_SOCK" show -g exit-empty >/dev/null 2>&1
assert_eq "private server remains alive with zero sessions" "0" "$?"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN clipboard-proxy hook tests failed" >&2
  exit 1
fi
echo "All $TESTS_RUN clipboard-proxy hook tests passed"
