#!/usr/bin/env bash
# Regression tests exercise the public yolo CLI with a recording sandbox.
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SCRIPT="$SCRIPT_DIR/yolo.sh"

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
PROJECT_DIR="$WORKDIR/project"
FAKE_HOME="$WORKDIR/home"
FAKE_BIN="$WORKDIR/bin"
_bash_path="$(command -v bash)"
mkdir -p \
  "$PROJECT_DIR" \
  "$FAKE_BIN" \
  "$FAKE_HOME/.claude" \
  "$FAKE_HOME/.codex/prompts" \
  "$FAKE_HOME/.codex/skills" \
  "$FAKE_HOME/.config/claude" \
  "$FAKE_HOME/.config/codex" \
  "$FAKE_HOME/.config/mcp" \
  "$FAKE_HOME/.pi/agent/cq-agents" \
  "$FAKE_HOME/.pi/agent/prompts"
printf 'x\n' > "$FAKE_HOME/.codex/AGENTS.md"
printf 'x\n' > "$FAKE_HOME/.codex/config.toml"
printf 'x\n' > "$FAKE_HOME/.codex/prompts/cq:plan.md"
printf 'x\n' > "$FAKE_HOME/.pi/agent/APPEND_SYSTEM.md"
printf 'x\n' > "$FAKE_HOME/.pi/agent/cq-agents/plan-reviewer.md"
printf 'x\n' > "$FAKE_HOME/.pi/agent/prompts/cq:plan.md"

printf '%s\n' \
  "#!$_bash_path" \
  'printf "%s\n" "$@"' \
  > "$FAKE_BIN/record-sandbox"
chmod +x "$FAKE_BIN/record-sandbox"

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $desc -- expected output to contain [$needle]"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $desc -- expected [$expected], got [$actual]"
    FAILURES=$((FAILURES + 1))
  fi
}

OUT="$({
  cd "$PROJECT_DIR" &&
    HOME="$FAKE_HOME" \
    YOLO_LLM_SANDBOX="$FAKE_BIN/record-sandbox" \
    YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
    YOLO_NIX_LD="$(command -v true)" \
    YOLO_JQ="$(command -v jq)" \
    YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
    bash "$SCRIPT" --profile foo cmd true
} 2>&1)"
STATUS=$?

assert_eq "named profile launch succeeds" "0" "$STATUS"
assert_contains \
  "named profile re-shares Codex prompts read-only" \
  "$OUT" \
  "$FAKE_HOME/.codex/prompts,$FAKE_HOME/.codex/prompts"
assert_contains \
  "named profile re-shares Pi prompts read-only" \
  "$OUT" \
  "$FAKE_HOME/.pi/agent/prompts,$FAKE_HOME/.pi/agent/prompts"
assert_contains \
  "named profile re-shares Pi cq agents read-only" \
  "$OUT" \
  "$FAKE_HOME/.pi/agent/cq-agents,$FAKE_HOME/.pi/agent/cq-agents"
assert_contains \
  "named profile re-shares Pi appended system prompt read-only" \
  "$OUT" \
  "$FAKE_HOME/.pi/agent/APPEND_SYSTEM.md,$FAKE_HOME/.pi/agent/APPEND_SYSTEM.md"

# --- defects:D262: host tmux socket must NOT be bound; clipboard broker must ---
# Recording sandbox + a fake clipboard proxy that leaves a socket so yolo.sh's
# readiness loop succeeds.
FAKE_TMUX_DIR="$WORKDIR/fake-tmux-dir"
mkdir -p "$FAKE_TMUX_DIR"
FAKE_TMUX_SOCK="$FAKE_TMUX_DIR/default"

FAKE_PROXY="$FAKE_BIN/fake-clipboard-proxy"
{
  printf '#!%s\n' "$_bash_path"
  cat <<'EOF'
set -euo pipefail
listen=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --listen) listen="$2"; shift 2 ;;
    --tmux-socket|--tmux|--max-bytes) shift 2 ;;
    broker) shift ;;
    *) shift ;;
  esac
done
[[ -n "$listen" ]] || exit 1
printf 'started\n' > "${listen}.started"
exec python3 - "$listen" <<'PY'
import os, socket, sys, signal
path = sys.argv[1]
if os.path.exists(path):
    os.remove(path)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
server.listen(1)
server.settimeout(0.5)
os.chmod(path, 0o600)

def _stop(*_):
    try:
        server.close()
    finally:
        raise SystemExit(0)

signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)
while True:
    try:
        conn, _ = server.accept()
        conn.close()
    except socket.timeout:
        continue
    except OSError:
        break
PY
EOF
} > "$FAKE_PROXY"
chmod +x "$FAKE_PROXY"

# Real Unix socket standing in for the host tmux socket.
python3 - "$FAKE_TMUX_SOCK" <<'PY' &
import os, socket, sys, time
path = sys.argv[1]
if os.path.exists(path):
    os.remove(path)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.listen(1)
time.sleep(120)
PY
FAKE_TMUX_HOLD_PID=$!
for _ in $(seq 1 50); do
  [[ -S "$FAKE_TMUX_SOCK" ]] && break
  sleep 0.05
done
if [[ -S "$FAKE_TMUX_SOCK" ]]; then
  assert_eq "fixture host tmux socket exists" "1" "1"
else
  assert_eq "fixture host tmux socket exists" "1" "0"
fi

FAKE_SHIM_DIR="$WORKDIR/tmux-shim"
mkdir -p "$FAKE_SHIM_DIR"
ln -s "$FAKE_PROXY" "$FAKE_SHIM_DIR/tmux"

OUT_D262="$({ 
  cd "$PROJECT_DIR" &&
    HOME="$FAKE_HOME" \
    TMUX="${FAKE_TMUX_SOCK},12345,0" \
    YOLO_LLM_SANDBOX="$FAKE_BIN/record-sandbox" \
    YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
    YOLO_NIX_LD="$(command -v true)" \
    YOLO_JQ="$(command -v jq)" \
    YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
    YOLO_CLIPBOARD_PROXY="$FAKE_PROXY" \
    YOLO_CLIPBOARD_SHIM_DIR="$FAKE_SHIM_DIR" \
    YOLO_TMUX="$(command -v true)" \
    bash "$SCRIPT" cmd true
} 2>&1)"
STATUS_D262=$?
assert_eq "D262 launch with TMUX succeeds" "0" "$STATUS_D262"
assert_contains \
  "D262 binds a yolo-clip broker directory" \
  "$OUT_D262" \
  "yolo-clip."
# The host tmux socket DIRECTORY must never appear as a bind argument.
TMUX_DIR_HITS="$(printf '%s\n' "$OUT_D262" | grep -cF -- "$FAKE_TMUX_DIR" || true)"
assert_eq \
  "D262 does not bind the host tmux socket directory" \
  "0" \
  "$TMUX_DIR_HITS"
assert_contains \
  "D262 exports YOLO_CLIPBOARD_SOCK into the sandbox" \
  "$OUT_D262" \
  "YOLO_CLIPBOARD_SOCK="
assert_contains \
  "D262 prepends the tmux shim dir to PATH" \
  "$OUT_D262" \
  "PATH=$FAKE_SHIM_DIR:"

kill "$FAKE_TMUX_HOLD_PID" 2>/dev/null || true
wait "$FAKE_TMUX_HOLD_PID" 2>/dev/null || true

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
