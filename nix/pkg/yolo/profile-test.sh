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
  "$FAKE_HOME/.agents" \
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

run_profile_yolo() {
  local config_home="$1"
  {
    cd "$PROJECT_DIR" &&
      HOME="$FAKE_HOME" \
      XDG_CONFIG_HOME="$config_home" \
      YOLO_LLM_SANDBOX="$FAKE_BIN/record-sandbox" \
      YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
      YOLO_NIX_LD="$(command -v true)" \
      YOLO_JQ="$(command -v jq)" \
      YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
      bash "$SCRIPT" --profile foo cmd true
  } 2>&1
}

GLOBAL_CONFIG_HOME="$WORKDIR/xdg-config"
mkdir -p "$GLOBAL_CONFIG_HOME/cq"
printf 'reviewers = []\n' > "$GLOBAL_CONFIG_HOME/cq/cq.toml"
OUT="$(run_profile_yolo "$GLOBAL_CONFIG_HOME")"
STATUS=$?

assert_eq "named profile launch succeeds" "0" "$STATUS"
assert_contains \
  "named profile shares the agents registry read-only" \
  "$OUT" \
  $'--ro\n'"$FAKE_HOME/.agents"
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
assert_contains \
  "absolute XDG config home shares cq configuration read-only" \
  "$OUT" \
  $'--ro\n'"$GLOBAL_CONFIG_HOME/cq"

PROFILE_CODEX_CONFIG="$FAKE_HOME/.config/yolo/foo/codex/home/config.toml"
assert_contains \
  "named profile seeds its codex config from the main profile" \
  "$(cat "$PROFILE_CODEX_CONFIG")" \
  "x"
assert_contains \
  "named profile trusts the launch directory" \
  "$(cat "$PROFILE_CODEX_CONFIG")" \
  "[projects.\"$PROJECT_DIR\"]"

# A profile launched once into a directory it already trusts must still pick up
# later changes to the main config.
printf 'x\nmain-profile-edit\n' > "$FAKE_HOME/.codex/config.toml"
OUT="$(run_profile_yolo "$GLOBAL_CONFIG_HOME")"
assert_contains \
  "relaunch re-syncs the profile codex config with the main profile" \
  "$(cat "$PROFILE_CODEX_CONFIG")" \
  "main-profile-edit"
assert_contains \
  "relaunch keeps trusting the launch directory" \
  "$(cat "$PROFILE_CODEX_CONFIG")" \
  "[projects.\"$PROJECT_DIR\"]"
printf 'x\n' > "$FAKE_HOME/.codex/config.toml"

mkdir -p "$FAKE_HOME/.config/cq"
printf 'reviewers = []\n' > "$FAKE_HOME/.config/cq/cq.toml"
OUT="$(run_profile_yolo relative-config-home)"
assert_contains \
  "relative XDG config home falls back to the home config directory" \
  "$OUT" \
  $'--ro\n'"$FAKE_HOME/.config/cq"

# Tag gating: audio is on by default, display passthrough (Wayland + X11) is off
# by default, and --disable beats --enable for the same tag.
FAKE_XDG="$WORKDIR/xdg"
mkdir -p "$FAKE_XDG"
WAYLAND_SOCKET="$FAKE_XDG/wayland-9"
_python_path="$(command -v python3)"
if [[ -z "$_python_path" ]]; then
  echo "FATAL: python3 is required to bind the socket fixtures" >&2
  exit 1
fi
bind_unix_socket() {
  "$_python_path" - "$1" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.close()
PY
}
bind_unix_socket "$WAYLAND_SOCKET"

# The X11 socket directory is fixed by the protocol (/tmp/.X11-unix), so the
# fixture has to live there. Display :99 is outside the range a real session
# uses; create it only if absent and remove exactly what we created.
X11_SOCKET="/tmp/.X11-unix/X99"
X11_FIXTURE=0
if mkdir -p /tmp/.X11-unix 2>/dev/null && [[ ! -e "$X11_SOCKET" ]] \
   && bind_unix_socket "$X11_SOCKET" 2>/dev/null; then
  X11_FIXTURE=1
  trap 'rm -f "$X11_SOCKET"; rm -rf "$WORKDIR"' EXIT
fi

XAUTH_FILE="$FAKE_HOME/.Xauthority"
printf 'fake-cookie\n' > "$XAUTH_FILE"

TEST_WAYLAND_DISPLAY="wayland-9"
TEST_DISPLAY=":99"

run_yolo() {
  {
    cd "$PROJECT_DIR" &&
      HOME="$FAKE_HOME" \
      XDG_RUNTIME_DIR="$FAKE_XDG" \
      WAYLAND_DISPLAY="$TEST_WAYLAND_DISPLAY" \
      DISPLAY="$TEST_DISPLAY" \
      XAUTHORITY="$XAUTH_FILE" \
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
assert_not_contains "dynamic gpu devices are not bound by default" "$OUT" "/dev/dri,/dev/dri"

OUT="$(run_yolo_cmd --enable=gpu)"
assert_not_contains "--enable=gpu does not enable dynamic passthrough" "$OUT" "/dev/dri,/dev/dri"

OUT="$(run_yolo_cmd --enable=dyngpu)"
STATUS=$?
assert_eq "--enable=dyngpu remains non-fatal" "0" "$STATUS"
assert_contains "--enable=dyngpu binds DRM devices" "$OUT" "/dev/dri,/dev/dri"
assert_contains "--enable=dyngpu binds AMD KFD" "$OUT" "/dev/kfd,/dev/kfd"
assert_contains "--enable=dyngpu binds NVIDIA control devices" "$OUT" "/dev/nvidiactl,/dev/nvidiactl"
assert_contains "--enable=dyngpu binds NVIDIA render devices" "$OUT" "/dev/nvidia0,/dev/nvidia0"
assert_contains "--enable=dyngpu binds NixOS graphics and Vulkan drivers" "$OUT" "/run/opengl-driver"
assert_contains "--enable=dyngpu binds 32-bit graphics and Vulkan drivers" "$OUT" "/run/opengl-driver-32"
assert_contains "--enable=dyngpu binds device metadata" "$OUT" "/sys"
if [[ ! -e /dev/dri && ! -e /dev/kfd && ! -e /dev/nvidiactl && ! -e /dev/nvidia0 ]]; then
  assert_contains "--enable=dyngpu warns when GPU devices are absent" "$OUT" "no GPU device nodes found"
fi

OUT="$(run_yolo_cmd --enable=dyngpu --disable=dyngpu)"
assert_not_contains "--disable drops enabled dynamic gpu devices" "$OUT" "/dev/dri,/dev/dri"

STATIC_GPU_RECORD=$'/dev/static-gpu\tgpu'
OUT="$(YOLO_EXTRA_DEV_PATHS="$STATIC_GPU_RECORD" run_yolo_cmd --disable=dyngpu)"
assert_contains "--disable=dyngpu preserves static gpu devices" "$OUT" "/dev/static-gpu,/dev/static-gpu"

OUT="$(YOLO_EXTRA_DEV_PATHS="$STATIC_GPU_RECORD" run_yolo_cmd --disable=gpu)"
assert_not_contains "--disable=gpu drops static gpu devices" "$OUT" "/dev/static-gpu,/dev/static-gpu"

OUT="$(YOLO_EXTRA_DEV_PATHS="$STATIC_GPU_RECORD" run_yolo_cmd --enable=dyngpu --disable=gpu)"
assert_contains "--disable=gpu preserves enabled dynamic gpu devices" "$OUT" "/dev/dri,/dev/dri"
assert_not_contains "--disable=gpu still drops static gpu devices with dyngpu enabled" "$OUT" "/dev/static-gpu,/dev/static-gpu"

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

# X11 / XWayland leg of the same tag. /tmp is a tmpfs inside the sandbox, so the
# X socket and the auth file must be bound explicitly.
if [[ $X11_FIXTURE -eq 1 ]]; then
  OUT="$(run_yolo_cmd)"
  assert_not_contains "x11 socket is not bound by default" "$OUT" "$X11_SOCKET"

  OUT="$(run_yolo_cmd --enable=display)"
  assert_contains "--enable=display binds the x11 socket" "$OUT" "$X11_SOCKET"
  assert_contains "--enable=display sets DISPLAY" "$OUT" "DISPLAY=:99"
  assert_contains "--enable=display binds the x11 auth file" "$OUT" "$XAUTH_FILE"
  assert_contains "--enable=display sets XAUTHORITY" "$OUT" "XAUTHORITY=$XAUTH_FILE"

  TEST_DISPLAY=":99.0"
  OUT="$(run_yolo_cmd --enable=display)"
  assert_contains "screen suffix resolves to the same x11 socket" "$OUT" "$X11_SOCKET"

  TEST_DISPLAY=":99"
  OUT="$(run_yolo_cmd --enable=display --disable=display)"
  assert_not_contains "--disable drops the x11 socket too" "$OUT" "$X11_SOCKET"
else
  echo "SKIP: could not create the $X11_SOCKET fixture; x11 bind assertions skipped"
fi

TEST_DISPLAY=":98"
OUT="$(run_yolo_cmd --enable=display)"
assert_contains "missing x11 socket warns" "$OUT" "no X11 socket at /tmp/.X11-unix/X98"

TEST_DISPLAY="remotehost:0"
OUT="$(run_yolo_cmd --enable=display)"
assert_not_contains "non-local DISPLAY is left to the shared network namespace" "$OUT" "no X11 socket at"
TEST_DISPLAY=":99"

OUT="$(run_yolo --help)"
assert_contains "usage documents --enable" "$OUT" "--enable=TAG"
assert_contains "usage documents dynamic gpu passthrough" "$OUT" "dyngpu"

# Ad-hoc CLI binds must be appended after every built-in bind: bwrap applies
# mounts in argv order, so the last bind covering a path wins.
CLI_RO="$WORKDIR/cli-ro"
CLI_RW="$WORKDIR/cli-rw"
DECL_RO="$WORKDIR/decl-ro"
DECL_RW="$WORKDIR/decl-rw"
mkdir -p "$CLI_RO" "$CLI_RW" "$DECL_RO" "$DECL_RW"

arg_index() {
  printf '%s\n' "$1" | grep -n -x -F -- "$2" | tail -1 | cut -d: -f1
}

assert_after() {
  local desc="$1" haystack="$2" later="$3" earlier="$4"
  local later_idx earlier_idx
  later_idx="$(arg_index "$haystack" "$later")"
  earlier_idx="$(arg_index "$haystack" "$earlier")"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ -z "$later_idx" || -z "$earlier_idx" || "$later_idx" -le "$earlier_idx" ]]; then
    echo "FAIL: $desc -- expected [$later] ($later_idx) after [$earlier] ($earlier_idx)"
    FAILURES=$((FAILURES + 1))
  fi
}

OUT="$(YOLO_EXTRA_RO_PATHS="$DECL_RO" YOLO_EXTRA_RW_PATHS="$DECL_RW" \
  run_yolo --profile foo --ro "$CLI_RO" --rw "$CLI_RW" cmd true)"
assert_after "CLI --ro follows the declarative read-only binds" "$OUT" "$CLI_RO" "$DECL_RO"
assert_after "CLI --ro follows the declarative read-write binds" "$OUT" "$CLI_RO" "$DECL_RW"
assert_after "CLI --ro follows the built-in \$PWD bind" "$OUT" "$CLI_RO" "$PROJECT_DIR"
assert_after "CLI --ro follows the built-in agents-registry bind" "$OUT" "$CLI_RO" "$FAKE_HOME/.agents"
assert_after "CLI --ro follows the profile claude binds" "$OUT" \
  "$CLI_RO" "$FAKE_HOME/.config/yolo/foo/claude/home,$FAKE_HOME/.claude"
assert_after "CLI --ro follows the profile pi binds" "$OUT" \
  "$CLI_RO" "$FAKE_HOME/.pi/agent/mcp.json,$FAKE_HOME/.pi/agent/mcp.json"
assert_after "CLI --rw follows the CLI --ro that preceded it" "$OUT" "$CLI_RW" "$CLI_RO"
assert_after "the sandbox command separator still follows the CLI binds" "$OUT" "--" "$CLI_RW"

# Declarative (home-manager) extras sit between the two: after every built-in
# bind including the profile-specific ones, but still under the CLI binds.
assert_after "declarative --ro follows the built-in agents-registry bind" "$OUT" \
  "$DECL_RO" "$FAKE_HOME/.agents"
assert_after "declarative --ro follows the profile claude re-shares" "$OUT" \
  "$DECL_RO" "$FAKE_HOME/.claude/settings.json,$FAKE_HOME/.claude/settings.json"
assert_after "declarative --rw follows the profile pi binds" "$OUT" \
  "$DECL_RW" "$FAKE_HOME/.pi/agent/mcp.json,$FAKE_HOME/.pi/agent/mcp.json"
assert_after "CLI --ro follows the declarative extras" "$OUT" "$CLI_RO" "$DECL_RW"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
