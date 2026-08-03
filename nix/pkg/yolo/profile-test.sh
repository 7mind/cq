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

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: $desc -- expected output NOT to contain [$needle]"
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

# Tag gating: audio is on by default, Wayland display passthrough is off by
# default, and --disable beats --enable for the same tag.
FAKE_XDG="$WORKDIR/xdg"
mkdir -p "$FAKE_XDG"
WAYLAND_SOCKET="$FAKE_XDG/wayland-9"
_python_path="$(command -v python3)"
if [[ -z "$_python_path" ]]; then
  echo "FATAL: python3 is required to bind the Wayland socket fixture" >&2
  exit 1
fi
"$_python_path" - "$WAYLAND_SOCKET" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.close()
PY

TEST_WAYLAND_DISPLAY="wayland-9"

run_yolo() {
  {
    cd "$PROJECT_DIR" &&
      HOME="$FAKE_HOME" \
      XDG_RUNTIME_DIR="$FAKE_XDG" \
      WAYLAND_DISPLAY="$TEST_WAYLAND_DISPLAY" \
      YOLO_LLM_SANDBOX="$FAKE_BIN/record-sandbox" \
      YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
      YOLO_NIX_LD="$(command -v true)" \
      YOLO_JQ="$(command -v jq)" \
      YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
      bash "$SCRIPT" "$@"
  } 2>&1
}

run_yolo_cmd() { run_yolo "$@" --profile foo cmd true; }

OUT="$(run_yolo_cmd)"
assert_not_contains "wayland socket is not bound by default" "$OUT" "$WAYLAND_SOCKET"
assert_not_contains "WAYLAND_DISPLAY is not set by default" "$OUT" "WAYLAND_DISPLAY=wayland-9"
assert_contains "audio socket is bound by default" "$OUT" "$FAKE_XDG/pipewire-0"

OUT="$(run_yolo_cmd --enable=display)"
assert_contains "--enable=display binds the wayland socket" "$OUT" "$WAYLAND_SOCKET"
assert_contains "--enable=display sets WAYLAND_DISPLAY" "$OUT" "WAYLAND_DISPLAY=wayland-9"
assert_contains "--enable=display sets XDG_RUNTIME_DIR" "$OUT" "XDG_RUNTIME_DIR=$FAKE_XDG"

OUT="$(run_yolo_cmd --enable=other,display)"
assert_contains "--enable is comma-separated" "$OUT" "$WAYLAND_SOCKET"

OUT="$(run_yolo_cmd --enable=display --disable=display)"
assert_not_contains "--disable beats a preceding --enable" "$OUT" "$WAYLAND_SOCKET"

OUT="$(run_yolo_cmd --disable=display --enable=display)"
assert_not_contains "--disable beats a following --enable" "$OUT" "$WAYLAND_SOCKET"

OUT="$(run_yolo_cmd --enable=audio --disable=audio)"
assert_not_contains "--enable does not resurrect a disabled default-on tag" "$OUT" "$FAKE_XDG/pipewire-0"

TEST_WAYLAND_DISPLAY="wayland-absent"
OUT="$(run_yolo_cmd --enable=display)"
assert_contains "missing wayland socket warns" "$OUT" "no Wayland socket at"
TEST_WAYLAND_DISPLAY="wayland-9"

OUT="$(run_yolo --help)"
assert_contains "usage documents --enable" "$OUT" "--enable=TAG"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
