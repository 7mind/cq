#!/usr/bin/env bash
# Deterministic tests source the real pre-exec helpers without reaching exec.
# They cover yolo's policy fragment, profile layout, and HOME guard. Live
# Seatbelt enforcement must run outside Nix's own Darwin sandbox because
# sandbox-exec cannot nest there; see README.md's manual checklist.
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SCRIPT="$SCRIPT_DIR/yolo-darwin.sh"
GOLDEN_FILE="$SCRIPT_DIR/testdata/profile-foo.sb"

# Satisfy mandatory paths; these commands are never invoked before the exec seam.
_true_path="$(command -v true || echo /bin/true)"
_bash_path="$(command -v bash || echo /bin/bash)"
_jq_path="$(command -v jq || echo /usr/bin/jq)"
_python_path="$(command -v python3 || echo /usr/bin/python3)"
export YOLO_SANDBOX_EXEC="$_true_path"
export YOLO_JQ="$_jq_path"
export YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh"

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
TEST_SANDBOX_ENTRYPOINT="$WORKDIR/yolo-sandbox-entrypoint"
cp "$SCRIPT_DIR/../yolo/sandbox-entrypoint.sh" "$TEST_SANDBOX_ENTRYPOINT"
chmod +x "$TEST_SANDBOX_ENTRYPOINT"
export YOLO_SANDBOX_ENTRYPOINT="$TEST_SANDBOX_ENTRYPOINT"
PROJECT_DIR="$WORKDIR/project"
FAKE_HOME="$WORKDIR/home"
mkdir -p "$PROJECT_DIR" "$FAKE_HOME"

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $desc -- expected [$expected], got [$actual]"
    FAILURES=$((FAILURES + 1))
  fi
}
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
assert_zero() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -ne 0 ]]; then
    echo "FAIL: $desc -- expected exit 0, got $status"
    FAILURES=$((FAILURES + 1))
  fi
}
assert_nonzero() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -eq 0 ]]; then
    echo "FAIL: $desc -- expected non-zero exit, got 0"
    FAILURES=$((FAILURES + 1))
  fi
}
# Octal file mode, portable across GNU (stat -c) and BSD/macOS (stat -f) stat.
_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

run_script() {
  # These cases exit before sandbox execution.
  OUT="$(cd "$PROJECT_DIR" && HOME="$FAKE_HOME" bash "$SCRIPT" "$@" 2>&1)"
  STATUS=$?
}

# Source through the pre-exec helpers while excluding dispatch and exec.
PREFIX="$WORKDIR/prefix.sh"
awk '/^yolo_exec_agent\(\) \{/{exit} {print}' "$SCRIPT" > "$PREFIX"

render_profile() {
  (cd "$PROJECT_DIR" && HOME="$FAKE_HOME" bash -c \
    'source "$1" cmd true; _render_yolo_rules "$2" "$3"' _ "$PREFIX" "$@")
}
render_profile_cli() {
  (cd "$PROJECT_DIR" && HOME="$FAKE_HOME" bash -c \
    'p="$1"; shift; source "$p" "$@"; _render_yolo_rules "$PROFILE" "$PWD"' _ "$PREFIX" "$@")
}
dump_state() {
  (cd "$PROJECT_DIR" && HOME="$FAKE_HOME" bash -c '
     p="$1"; shift; source "$p"
     echo "PROFILE=${PROFILE:-}"
     echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<unset>}"
     echo "CODEX_HOME=${CODEX_HOME:-<unset>}"
     echo "PI_PROFILE_DIR=${PI_PROFILE_DIR:-<unset>}"
   ' _ "$PREFIX" "$@")
}
source_guard() {
  local dir="$1" home="$2"; shift 2
  OUT="$(cd "$dir" && HOME="$home" bash -c 'source "$1" cmd true' _ "$PREFIX" "$@" 2>&1)"
  STATUS=$?
}

# ── usage / dispatch (exit before exec) ─────────────────────────────────────
run_script
assert_nonzero "no args exits non-zero" "$STATUS"
assert_contains "no args prints usage" "$OUT" "Usage: yolo-darwin"
run_script --help
assert_zero "--help exits zero" "$STATUS"
assert_contains "--help documents ad-hoc read-only paths" "$OUT" "--ro PATH"
assert_contains "--help documents ad-hoc read-write paths" "$OUT" "--rw PATH"
run_script bogus
assert_nonzero "unknown subcommand exits non-zero" "$STATUS"
assert_contains "unknown subcommand lists supported tools" "$OUT" "claude, codex, pi, shell, cmd"
run_script --profile .. cmd true
assert_nonzero "invalid profile '..' exits non-zero" "$STATUS"
assert_contains "invalid profile '..' reports charset error" "$OUT" "invalid profile name"
run_script
assert_contains "usage mentions --disable" "$OUT" "--disable=TAG"
assert_contains "usage mentions --enable" "$OUT" "--enable=TAG"

# ── generated policy ─────────────────────────────────────────────────────────
RENDERED="$(render_profile foo /tmp/x)"
GOLDEN="$(cat "$GOLDEN_FILE" 2>/dev/null || true)"
assert_eq "rendered foo profile matches testdata/profile-foo.sb" "$GOLDEN" "$RENDERED"
mkdir -p "$FAKE_HOME/.agents"
RENDERED_AGENTS="$(render_profile foo /tmp/x)"
assert_contains "allows ~/.agents read-only" "$RENDERED_AGENTS" \
  $'(allow file-read* file-read-metadata\n    (literal "'"$FAKE_HOME/.agents"$'")\n    (subpath "'"$FAKE_HOME/.agents"$'"))'
assert_contains "allows read+write to \$PWD (/tmp/x)" "$RENDERED" '(subpath "/tmp/x")'
assert_contains "allows ~/.cache" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.cache"))'
# Regression: cq's default XDG primary lives here and must remain reachable
# from the confined MCP server and Claude stop hook.
assert_contains "allows cq default XDG state" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.local/state/cq"))'
RENDERED_CUSTOM_XDG="$(XDG_STATE_HOME='/tmp/custom state' render_profile foo /tmp/x)"
assert_contains "allows cq custom absolute XDG state" "$RENDERED_CUSTOM_XDG" '(subpath "/tmp/custom state/cq")'
assert_contains "allows cq default global config read-only" "$RENDERED" \
  $'(allow file-read* file-read-metadata\n    (subpath (string-append (param "HOME_DIR") "/.config/cq")))'
RENDERED_CUSTOM_XDG_CONFIG="$(XDG_CONFIG_HOME='/tmp/custom config' render_profile foo /tmp/x)"
assert_contains "allows cq custom absolute global config read-only" "$RENDERED_CUSTOM_XDG_CONFIG" \
  $'(allow file-read* file-read-metadata\n    (subpath "/tmp/custom config/cq"))'
RENDERED_RELATIVE_XDG_CONFIG="$(XDG_CONFIG_HOME='relative-config' render_profile foo /tmp/x)"
assert_contains "relative XDG config home falls back to the home config directory" \
  "$RENDERED_RELATIVE_XDG_CONFIG" \
  $'(allow file-read* file-read-metadata\n    (subpath (string-append (param "HOME_DIR") "/.config/cq")))'
assert_contains "allows /Users metadata traversal" "$RENDERED" '(literal "/Users")'
assert_contains "allows home root metadata traversal" "$RENDERED" '(literal (param "HOME_DIR"))'
assert_contains "allows named profile .config read traversal" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.config"))'
assert_contains "allows named profile yolo read traversal" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.config/yolo"))'
assert_contains "allows active profile root read traversal" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.config/yolo/foo"))'
assert_contains "allows active profile claude dir" "$RENDERED" '"/.config/yolo/foo/claude"'
assert_contains "allows active profile claude root canonicalization" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.config/yolo/foo/claude"))'
assert_contains "allows active profile codex dir" "$RENDERED" '"/.config/yolo/foo/codex"'
assert_contains "allows active profile codex root canonicalization" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.config/yolo/foo/codex"))'
assert_contains "allows active profile pi dir" "$RENDERED" '"/.config/yolo/foo/pi"'
assert_contains "allows active profile pi root canonicalization" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.config/yolo/foo/pi"))'
assert_contains "explicitly denies the ~/.config/yolo profiles tree" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.config/yolo")))'
assert_not_contains "no (version 1) line (the base provides it)" "$RENDERED" '(version 1)'

DECL_RO="$WORKDIR/declarative-ro"
DECL_RW="$WORKDIR/declarative-rw"
CLI_RO="$WORKDIR/cli-ro"
CLI_RW="$WORKDIR/cli-rw"
SSH_TARGET="$WORKDIR/ssh-key-target"
SSH_LINK="$WORKDIR/ssh-key"
PODMAN_SOCKET_TARGET="$WORKDIR/runtime/podman/podman-machine-default-api.sock"
PODMAN_SOCKET_LINK="$FAKE_HOME/.local/share/containers/podman/machine/podman.sock"
PODMAN_SOCKET_URI="unix://$PODMAN_SOCKET_LINK"
mkdir -p \
  "$DECL_RO" \
  "$DECL_RW" \
  "$CLI_RO" \
  "$CLI_RW" \
  "$(dirname "$PODMAN_SOCKET_TARGET")" \
  "$(dirname "$PODMAN_SOCKET_LINK")"
printf private-key > "$SSH_TARGET"
ln -s "$SSH_TARGET" "$SSH_LINK"
"$_python_path" - "$PODMAN_SOCKET_TARGET" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.close()
PY
ln -s "$PODMAN_SOCKET_TARGET" "$PODMAN_SOCKET_LINK"
RENDERED_PATHS="$(
  YOLO_EXTRA_RO_PATHS="$DECL_RO"$'\n'"$SSH_LINK" \
  YOLO_EXTRA_RW_PATHS="$DECL_RW" \
    render_profile_cli --profile foo --ro "$CLI_RO" --rw "$CLI_RW" cmd true
)"
assert_contains "declarative read-only path receives only read operations" "$RENDERED_PATHS" \
  $'(allow file-read* file-read-metadata\n    (literal "'"$DECL_RO"$'")\n    (subpath "'"$DECL_RO"$'"))'
assert_contains "CLI read-only path receives only read operations" "$RENDERED_PATHS" \
  $'(allow file-read* file-read-metadata\n    (literal "'"$CLI_RO"$'")\n    (subpath "'"$CLI_RO"$'"))'
assert_contains "declarative read-write path receives write operations" "$RENDERED_PATHS" \
  $'(allow file-read* file-write* file-write-create file-read-metadata file-ioctl\n    (literal "'"$DECL_RW"$'")\n    (subpath "'"$DECL_RW"$'"))'
assert_contains "CLI read-write path receives write operations" "$RENDERED_PATHS" \
  $'(allow file-read* file-write* file-write-create file-read-metadata file-ioctl\n    (literal "'"$CLI_RW"$'")\n    (subpath "'"$CLI_RW"$'"))'
assert_contains "declared SSH-key symlink receives read access" "$RENDERED_PATHS" "(literal \"$SSH_LINK\")"
assert_contains "declared SSH-key target receives read access" "$RENDERED_PATHS" "(literal \"$SSH_TARGET\")"

# Seatbelt is last-match-wins, so ad-hoc CLI grants must render after every
# declarative grant — including declarative read-write ones.
grant_line() {
  printf '%s\n' "$RENDERED_PATHS" | grep -n -F -- ";; Explicit $1 grant: $2" | tail -1 | cut -d: -f1
}
assert_grant_after() {
  local desc="$1" later_access="$2" later_path="$3" earlier_access="$4" earlier_path="$5"
  local later_idx earlier_idx
  later_idx="$(grant_line "$later_access" "$later_path")"
  earlier_idx="$(grant_line "$earlier_access" "$earlier_path")"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ -z "$later_idx" || -z "$earlier_idx" || "$later_idx" -le "$earlier_idx" ]]; then
    echo "FAIL: $desc -- expected $later_access $later_path ($later_idx) after $earlier_access $earlier_path ($earlier_idx)"
    FAILURES=$((FAILURES + 1))
  fi
}
assert_grant_after "CLI read-only grant follows the declarative read-only grant" \
  ro "$CLI_RO" ro "$DECL_RO"
assert_grant_after "CLI read-only grant follows the declarative read-write grant" \
  ro "$CLI_RO" rw "$DECL_RW"
assert_grant_after "CLI read-write grant follows the CLI read-only grant that preceded it" \
  rw "$CLI_RW" ro "$CLI_RO"

# Declarative grants outrank the profile-specific re-grants they may overlap.
PROFILE_REGRANT_LINE="$(printf '%s\n' "$RENDERED_PATHS" \
  | grep -n -F -- '(subpath (string-append (param "HOME_DIR") "/.config/yolo/foo/pi")))' | tail -1 | cut -d: -f1)"
DECL_RO_LINE="$(grant_line ro "$DECL_RO")"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ -z "$PROFILE_REGRANT_LINE" || -z "$DECL_RO_LINE" || "$DECL_RO_LINE" -le "$PROFILE_REGRANT_LINE" ]]; then
  echo "FAIL: declarative grant follows the active-profile re-grant -- expected declarative ($DECL_RO_LINE) after profile ($PROFILE_REGRANT_LINE)"
  FAILURES=$((FAILURES + 1))
fi

# Named profiles override any upstream grants to native agent homes.
assert_contains "named: denies real ~/.claude" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.claude"))'
assert_contains "named: denies real ~/.claude.json" "$RENDERED" '(literal (string-append (param "HOME_DIR") "/.claude.json"))'
assert_contains "named: denies real ~/.codex" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.codex"))'
assert_contains "named: denies real ~/.gemini" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.gemini"))'
assert_contains "named: denies real ~/.pi" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.pi"))'
assert_contains "named: denies claude-cli-nodejs cache" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/Library/Caches/claude-cli-nodejs"))'
assert_not_contains "named: pi real auth.json is NOT re-allowed" "$RENDERED" '/.pi/agent/auth.json'
assert_not_contains "named: no pi shared-asset re-allow (copied, not symlinked)" "$RENDERED" '/.pi/agent/settings.json'

# precedence (Seatbelt last-match-wins): cache-allow < yolo-deny < active-reallow
DENY_LINE="$(printf '%s\n' "$RENDERED" | grep -n '(subpath (string-append (param "HOME_DIR") "/.config/yolo")))' | head -1 | cut -d: -f1)"
REALLOW_LINE="$(printf '%s\n' "$RENDERED" | grep -n '"/.config/yolo/foo/claude"' | tail -1 | cut -d: -f1)"
CACHE_LINE="$(printf '%s\n' "$RENDERED" | grep -n '(subpath (string-append (param "HOME_DIR") "/.cache"))' | head -1 | cut -d: -f1)"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ -z "$DENY_LINE" || -z "$REALLOW_LINE" || -z "$CACHE_LINE" || "$CACHE_LINE" -ge "$DENY_LINE" || "$DENY_LINE" -ge "$REALLOW_LINE" ]]; then
  echo "FAIL: precedence -- expected cache($CACHE_LINE) < yolo-deny($DENY_LINE) < active-reallow($REALLOW_LINE)"
  FAILURES=$((FAILURES + 1))
fi

RENDERED_DEFAULT="$(render_profile '' /tmp/x)"
assert_contains "default: allows real ~/.claude" "$RENDERED_DEFAULT" '(subpath (string-append (param "HOME_DIR") "/.claude"))'
assert_contains "default: allows real ~/.pi" "$RENDERED_DEFAULT" '(subpath (string-append (param "HOME_DIR") "/.pi"))'
assert_not_contains "default: no per-profile yolo/<name> re-allow" "$RENDERED_DEFAULT" '(param "HOME_DIR") "/.config/yolo/'
assert_not_contains "default: no real-home deny (uses the real homes directly)" "$RENDERED_DEFAULT" 'Library/Caches/claude-cli-nodejs'
assert_not_contains "default: no pi shared-asset re-allow block" "$RENDERED_DEFAULT" '/.pi/agent/settings.json'

RENDERED_ESC="$(render_profile foo '/tmp/a"b\c')"
assert_contains "\$PWD with special chars is escaped for SBPL" "$RENDERED_ESC" '(subpath "/tmp/a\"b\\c")'

# ── profile -> dir resolution (named profile: 700 dirs; default: real homes) ─
DUMP="$(dump_state --profile foo cmd true)"
assert_contains "named: CLAUDE_CONFIG_DIR under yolo/foo/claude" "$DUMP" "CLAUDE_CONFIG_DIR=$FAKE_HOME/.config/yolo/foo/claude"
assert_contains "named: CODEX_HOME under yolo/foo/codex" "$DUMP" "CODEX_HOME=$FAKE_HOME/.config/yolo/foo/codex"
assert_contains "named: PI_PROFILE_DIR under yolo/foo/pi" "$DUMP" "PI_PROFILE_DIR=$FAKE_HOME/.config/yolo/foo/pi"
assert_eq "named: CLAUDE_CONFIG_DIR created mode 700" "700" "$(_mode "$FAKE_HOME/.config/yolo/foo/claude")"
assert_eq "named: CODEX_HOME created mode 700" "700" "$(_mode "$FAKE_HOME/.config/yolo/foo/codex")"
assert_eq "named: pi dir created mode 700" "700" "$(_mode "$FAKE_HOME/.config/yolo/foo/pi")"

DUMP_DEFAULT="$(dump_state cmd true)"
assert_contains "default: CLAUDE_CONFIG_DIR unset" "$DUMP_DEFAULT" "CLAUDE_CONFIG_DIR=<unset>"
assert_contains "default: CODEX_HOME unset" "$DUMP_DEFAULT" "CODEX_HOME=<unset>"
assert_contains "default: PI_PROFILE_DIR is the real ~/.pi" "$DUMP_DEFAULT" "PI_PROFILE_DIR=$FAKE_HOME/.pi"

# ── Claude native per-profile authentication ──────────────────────────────────
FAKE_BIN="$WORKDIR/fake-bin"
mkdir -p "$FAKE_BIN"
printf '%s\n' \
  "#!$_bash_path" \
  "printf invoked > \"\$FAKE_SECURITY_MARKER\"" \
  "if [[ \"\${FAKE_SECURITY_FAIL:-0}\" == 1 ]]; then exit 44; fi" \
  'printf "%s\n" custom-keychain-token' > "$FAKE_BIN/security"
printf '%s\n' \
  "#!$_bash_path" \
  "printf \"sandbox_oauth=%s\\n\" \"\${CLAUDE_CODE_OAUTH_TOKEN:-<unset>}\"" > "$FAKE_BIN/sandbox"
# The generated script, rather than this test process, expands its positional parameters.
# shellcheck disable=SC2016
# These single-quoted lines are generated script source, not expressions here.
# shellcheck disable=SC2016
printf '%s\n' \
  "#!$_bash_path" \
  'if [[ "${1:-}" == "--write-base-profile" ]]; then printf "(version 1)\n"; exit 0; fi' \
  'while [[ $# -gt 0 ]]; do' \
  '  if [[ "$1" == "--append-system-prompt" ]]; then' \
  '    printf "prompt<<%s>>\n" "$2"' \
  '    shift 2' \
  '  else' \
  '    shift' \
  '  fi' \
  'done' \
  'env | sed -n "/^YOLO_/s/=.*//p" | sort' > "$FAKE_BIN/prompt-sandbox"
# shellcheck disable=SC2016
printf '%s\n' \
  "#!$_bash_path" \
  'if [[ "${1:-}" == "--write-base-profile" ]]; then printf "(version 1)\n"; exit 0; fi' \
  '[[ -n "${CAPTURE_ARGS_FILE:-}" ]] && printf "%s\n" "$@" > "$CAPTURE_ARGS_FILE"' \
  '[[ -n "${CAPTURE_POINTERS_FILE:-}" ]] && printf "%s\n%s\n" "${YOLO_SECRETS_FILE:-}" "${YOLO_SANDBOX_HOOKS_FILE:-}" > "$CAPTURE_POINTERS_FILE"' \
  'previous=' \
  'for arg in "$@"; do' \
  '  if [[ "$previous" == "--use-profile" && -n "${CAPTURE_PROFILE_FILE:-}" ]]; then cp "$arg" "$CAPTURE_PROFILE_FILE"; break; fi' \
  '  previous="$arg"' \
  'done' \
  'while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done' \
  '[[ "${1:-}" == "--" ]] && shift' \
  'exec "$@"' > "$FAKE_BIN/capture-sandbox"
# shellcheck disable=SC2016
printf '%s\n' \
  "#!$_bash_path" \
  'printf "DECLARED=%s\n" "${DECLARED:-<unset>}"' \
  'printf "ORDER=%s\n" "${ORDER:-<unset>}"' \
  'printf "SECRET_VALUE=%s\n" "${SECRET_VALUE:-<unset>}"' \
  'printf "SANDBOX_HOOK=%s\n" "${SANDBOX_HOOK:-<unset>}"' \
  'printf "DISABLED_HOOK=%s\n" "${DISABLED_HOOK:-<unset>}"' \
  'printf "DOCKER_HOST=%s\n" "${DOCKER_HOST:-<unset>}"' \
  'printf "CONTAINER_HOST=%s\n" "${CONTAINER_HOST:-<unset>}"' \
  'printf "EXTRA_TOOL=%s\n" "$(command -v yolo-extra-tool || printf missing)"' \
  'env | sed -n "/^YOLO_/s/=.*//p" | sort' > "$FAKE_BIN/pi"
chmod +x \
  "$FAKE_BIN/security" \
  "$FAKE_BIN/sandbox" \
  "$FAKE_BIN/prompt-sandbox" \
  "$FAKE_BIN/capture-sandbox" \
  "$FAKE_BIN/pi"

run_claude_exec() {
  local security_fail="$1"
  rm -f "$WORKDIR/security-invoked"
  OUT="$(
    cd "$PROJECT_DIR" &&
      unset CLAUDE_CODE_OAUTH_TOKEN &&
      HOME="$FAKE_HOME" \
      USER=test-user \
      PATH="$FAKE_BIN:$PATH" \
      FAKE_SECURITY_FAIL="$security_fail" \
      FAKE_SECURITY_MARKER="$WORKDIR/security-invoked" \
      YOLO_SANDBOX_EXEC="$FAKE_BIN/sandbox" \
      bash "$SCRIPT" --profile foo claude 2>&1
  )"
  STATUS=$?
}

run_claude_exec 0
assert_zero "claude launch with an available custom Keychain token succeeds" "$STATUS"
assert_contains "claude does not inject a custom Keychain token" "$OUT" "sandbox_oauth=<unset>"
assert_eq "claude does not query a custom Keychain token" "no" "$(if [[ -e "$WORKDIR/security-invoked" ]]; then echo yes; else echo no; fi)"
run_claude_exec 1
assert_zero "claude launch with no custom Keychain token succeeds" "$STATUS"
assert_not_contains "claude does not warn about custom-token fallback" "$OUT" "falling back to the shared login credential"

# ── custom system prompt ──
PROMPT_JSON='[{"target":"claude","tags":[],"prompt":"claude only"},{"target":"*","tags":["gpu"],"prompt":"shared line"},{"target":"*","tags":["audio"],"prompt":"audio line"},{"target":"pi","tags":[],"prompt":"pi only"}]'
run_prompt_exec() {
  OUT="$(
    cd "$PROJECT_DIR" &&
      HOME="$FAKE_HOME" \
      YOLO_PROMPT_JSON="$PROMPT_JSON" \
      YOLO_TEST_SENTINEL=present \
      YOLO_SANDBOX_EXEC="$FAKE_BIN/prompt-sandbox" \
      bash "$SCRIPT" "$@" 2>&1
  )"
  STATUS=$?
}

run_prompt_exec claude
assert_zero "claude launch with custom prompt succeeds" "$STATUS"
assert_contains "claude receives targeted and shared prompt fragments" "$OUT" $'prompt<<claude only\n\nshared line\n\naudio line>>'
assert_not_contains "claude excludes pi-targeted prompt fragments" "$OUT" "pi only"
# Regression: D1 — orchestration variables must stop at the launcher boundary.
assert_not_contains "confined child excludes the YOLO orchestration namespace" "$OUT" "YOLO_"
run_prompt_exec pi
assert_zero "pi launch with custom prompt succeeds" "$STATUS"
assert_contains "pi receives shared and targeted prompt fragments" "$OUT" $'prompt<<shared line\n\naudio line\n\npi only>>'
assert_not_contains "pi excludes claude-targeted prompt fragments" "$OUT" "claude only"
run_prompt_exec --disable=unused,gpu --disable=audio claude
assert_zero "claude launch with disabled prompt tags succeeds" "$STATUS"
assert_contains "repeatable and comma-separated disable tags preserve untagged fragments" "$OUT" "prompt<<claude only>>"
assert_not_contains "disabled gpu prompt fragment is excluded" "$OUT" "shared line"
assert_not_contains "disabled audio prompt fragment is excluded" "$OUT" "audio line"
run_prompt_exec --enable=display,audio --disable=audio claude
assert_zero "claude launch with enable tags succeeds" "$STATUS"
assert_not_contains "--disable beats --enable for the same tag" "$OUT" "audio line"
assert_contains "--enable leaves default-on fragments intact" "$OUT" "shared line"

# ── configured environment, secrets, packages, and hooks ─────────────────────
EXTRA_BIN="$WORKDIR/extra-bin"
mkdir -p "$EXTRA_BIN"
printf '%s\n' "#!$_bash_path" 'exit 0' > "$EXTRA_BIN/yolo-extra-tool"
chmod +x "$EXTRA_BIN/yolo-extra-tool"
SECRET_SOURCE="$WORKDIR/secret-token"
printf '%s\n' "from-secret-file" > "$SECRET_SOURCE"
HOST_HOOK_MARKER="$WORKDIR/host-hook"
DISABLED_HOST_HOOK_MARKER="$WORKDIR/disabled-host-hook"
CAPTURE_ARGS_FILE="$WORKDIR/captured-args"
CAPTURE_POINTERS_FILE="$WORKDIR/captured-pointers"
CAPTURE_PROFILE_FILE="$WORKDIR/captured-profile"
# shellcheck disable=SC2016
HOST_HOOKS="$(
  "$_jq_path" -nc \
    --arg run "printf host > '$HOST_HOOK_MARKER'" \
    --arg skip "printf disabled > '$DISABLED_HOST_HOOK_MARKER'" \
    '[{command:$run,tags:[]},{command:$skip,tags:["skip"]}]'
)"
SANDBOX_HOOKS="$(
  "$_jq_path" -nc \
    '[{command:"export SANDBOX_HOOK=ran",tags:[]},{command:"export DISABLED_HOOK=ran",tags:["skip"]}]'
)"
OUT="$(
  cd "$PROJECT_DIR" &&
    unset DOCKER_HOST CONTAINER_HOST &&
    HOME="$FAKE_HOME" \
    PATH="$FAKE_BIN:$PATH" \
    CAPTURE_ARGS_FILE="$CAPTURE_ARGS_FILE" \
    CAPTURE_POINTERS_FILE="$CAPTURE_POINTERS_FILE" \
    CAPTURE_PROFILE_FILE="$CAPTURE_PROFILE_FILE" \
    YOLO_SANDBOX_EXEC="$FAKE_BIN/capture-sandbox" \
    YOLO_SANDBOX_BIN="$EXTRA_BIN" \
    YOLO_SESSION_VARS=$'DECLARED=session\nORDER=session\nSECRET_VALUE=session' \
    YOLO_SECRET_VARS="SECRET_VALUE=$SECRET_SOURCE" \
    YOLO_PODMAN_SOCKET_PATH="$PODMAN_SOCKET_LINK" \
    YOLO_PODMAN_SOCKET_URI="$PODMAN_SOCKET_URI" \
    YOLO_PREHOOKS_JSON="$HOST_HOOKS" \
    YOLO_SANDBOX_HOOKS_JSON="$SANDBOX_HOOKS" \
    bash "$SCRIPT" --disable=skip --env ORDER=cli --env SECRET_VALUE=cli pi 2>&1
)"
STATUS=$?
assert_zero "configured environment launch succeeds" "$STATUS"
assert_contains "declarative session variable reaches agent" "$OUT" "DECLARED=session"
assert_contains "explicit --env overrides declarative session variable" "$OUT" "ORDER=cli"
assert_contains "secret file value overrides non-secret values" "$OUT" "SECRET_VALUE=from-secret-file"
assert_contains "sandbox hook exports reach agent" "$OUT" "SANDBOX_HOOK=ran"
assert_contains "disabled sandbox hook does not run" "$OUT" "DISABLED_HOOK=<unset>"
assert_contains "Podman socket URI reaches Docker clients" "$OUT" "DOCKER_HOST=$PODMAN_SOCKET_URI"
assert_contains "Podman socket URI reaches Podman clients" "$OUT" "CONTAINER_HOST=$PODMAN_SOCKET_URI"
CAPTURED_PROFILE="$(cat "$CAPTURE_PROFILE_FILE" 2>/dev/null || true)"
assert_contains "Podman stable socket symlink receives read access" "$CAPTURED_PROFILE" "(literal \"$PODMAN_SOCKET_LINK\")"
assert_contains "Podman runtime socket target receives read access" "$CAPTURED_PROFILE" "(literal \"$PODMAN_SOCKET_TARGET\")"
assert_contains "extra package bin is prepended to PATH" "$OUT" "EXTRA_TOOL=$EXTRA_BIN/yolo-extra-tool"
assert_not_contains "configured child excludes YOLO orchestration variables" "$OUT" "YOLO_"
assert_eq "enabled host hook runs" "host" "$(cat "$HOST_HOOK_MARKER" 2>/dev/null || true)"
assert_eq "disabled host hook does not run" "absent" "$(if [[ -e "$DISABLED_HOST_HOOK_MARKER" ]]; then echo present; else echo absent; fi)"
CAPTURED_ARGS="$(cat "$CAPTURE_ARGS_FILE" 2>/dev/null || true)"
assert_not_contains "secret value never appears in sandbox argv" "$CAPTURED_ARGS" "from-secret-file"
SECRET_TMP_PATH="$(sed -n '1p' "$CAPTURE_POINTERS_FILE" 2>/dev/null)"
HOOK_TMP_PATH="$(sed -n '2p' "$CAPTURE_POINTERS_FILE" 2>/dev/null)"
assert_contains "secret tempfile is supplied to sandbox entrypoint" "$SECRET_TMP_PATH" "yolo-darwin-secrets."
assert_contains "hook tempfile is supplied to sandbox entrypoint" "$HOOK_TMP_PATH" "yolo-darwin-hooks."
assert_eq "secret temp file is removed after launch" "absent" "$(if [[ -n "$SECRET_TMP_PATH" && -e "$SECRET_TMP_PATH" ]]; then echo present; else echo absent; fi)"
assert_eq "sandbox-hook temp file is removed after launch" "absent" "$(if [[ -n "$HOOK_TMP_PATH" && -e "$HOOK_TMP_PATH" ]]; then echo present; else echo absent; fi)"

# An absent configured socket matches Linux yolo: warn, skip the grant, and do
# not advertise an unusable endpoint to Docker-compatible clients.
MISSING_PODMAN_SOCKET="$WORKDIR/missing-podman.sock"
OUT="$(
  cd "$PROJECT_DIR" &&
    unset DOCKER_HOST CONTAINER_HOST &&
    HOME="$FAKE_HOME" \
    PATH="$FAKE_BIN:$PATH" \
    YOLO_SANDBOX_EXEC="$FAKE_BIN/capture-sandbox" \
    YOLO_PODMAN_SOCKET_PATH="$MISSING_PODMAN_SOCKET" \
    YOLO_PODMAN_SOCKET_URI="unix://$MISSING_PODMAN_SOCKET" \
    bash "$SCRIPT" pi 2>&1
)"
STATUS=$?
assert_zero "missing configured Podman socket does not prevent launch" "$STATUS"
assert_contains "missing configured Podman socket emits a warning" "$OUT" \
  "warning: podsvc-llm Podman socket not available, skipping bind: $MISSING_PODMAN_SOCKET"
assert_contains "missing configured Podman socket leaves Docker endpoint unset" "$OUT" "DOCKER_HOST=<unset>"
assert_contains "missing configured Podman socket leaves Podman endpoint unset" "$OUT" "CONTAINER_HOST=<unset>"

# ── copied HM assets ─────────────────────────────────────────────────────────
RESHARE_HOME="$WORKDIR/reshare-home"
mkdir -p \
  "$RESHARE_HOME/.claude/skills" \
  "$RESHARE_HOME/.codex/prompts" \
  "$RESHARE_HOME/.codex/skills" \
  "$RESHARE_HOME/.pi/agent/cq-agents" \
  "$RESHARE_HOME/.pi/agent/prompts" \
  "$RESHARE_HOME/.pi/agent/skills"
echo x > "$RESHARE_HOME/.claude/settings.json"
echo x > "$RESHARE_HOME/.claude/CLAUDE.md"
echo x > "$RESHARE_HOME/.codex/AGENTS.md"
printf 'model = "test"\n' > "$RESHARE_HOME/.codex/config.toml"
echo x > "$RESHARE_HOME/.codex/prompts/cq:plan.md"
echo x > "$RESHARE_HOME/.pi/agent/settings.json"
echo x > "$RESHARE_HOME/.pi/agent/APPEND_SYSTEM.md"
echo x > "$RESHARE_HOME/.pi/agent/cq-agents/plan-reviewer.md"
echo x > "$RESHARE_HOME/.pi/agent/prompts/cq:plan.md"
run_profile_sync() {
  cd "$PROJECT_DIR" &&
    HOME="$RESHARE_HOME" \
    PATH="$FAKE_BIN:$PATH" \
    YOLO_SANDBOX_EXEC="$FAKE_BIN/capture-sandbox" \
    bash "$SCRIPT" --profile foo cmd true 2>&1
}
OUT="$(run_profile_sync)"
STATUS=$?
assert_zero "cmd launch prepares every profile's assets" "$STATUS"
RESHARE_PROF="$RESHARE_HOME/.config/yolo/foo"
_is_real_file() { if [[ -f "$1" && ! -L "$1" ]]; then echo yes; else echo no; fi; }
_is_real_dir()  { if [[ -d "$1" && ! -L "$1" ]]; then echo yes; else echo no; fi; }
assert_eq "reshare: claude settings.json copied as a real file" "yes" "$(_is_real_file "$RESHARE_PROF/claude/settings.json")"
assert_eq "reshare: claude CLAUDE.md copied as a real file" "yes" "$(_is_real_file "$RESHARE_PROF/claude/CLAUDE.md")"
assert_eq "reshare: claude skills copied as a real dir" "yes" "$(_is_real_dir "$RESHARE_PROF/claude/skills")"
assert_eq "reshare: codex AGENTS.md copied as a real file" "yes" "$(_is_real_file "$RESHARE_PROF/codex/AGENTS.md")"
assert_eq "reshare: codex prompts copied as a real dir" "yes" "$(_is_real_dir "$RESHARE_PROF/codex/prompts")"
assert_eq "reshare: codex skills copied as a real dir" "yes" "$(_is_real_dir "$RESHARE_PROF/codex/skills")"
assert_eq "reshare: pi settings.json copied as a real file" "yes" "$(_is_real_file "$RESHARE_PROF/pi/settings.json")"
assert_eq "reshare: pi appended system prompt copied as a real file" "yes" "$(_is_real_file "$RESHARE_PROF/pi/APPEND_SYSTEM.md")"
assert_eq "reshare: pi cq agents copied as a real dir" "yes" "$(_is_real_dir "$RESHARE_PROF/pi/cq-agents")"
assert_eq "reshare: pi prompts copied as a real dir" "yes" "$(_is_real_dir "$RESHARE_PROF/pi/prompts")"
assert_eq "reshare: pi skills copied as a real dir" "yes" "$(_is_real_dir "$RESHARE_PROF/pi/skills")"
assert_eq "reshare: copied content matches the source" "x" "$(cat "$RESHARE_PROF/codex/AGENTS.md")"
assert_eq "reshare: copied Codex prompt content matches the source" "x" "$(cat "$RESHARE_PROF/codex/prompts/cq:plan.md" 2>/dev/null)"
assert_contains "cmd launch materializes Codex profile config" "$(cat "$RESHARE_PROF/codex/config.toml" 2>/dev/null)" 'model = "test"'
assert_contains "cmd launch trusts the launch directory" "$(cat "$RESHARE_PROF/codex/config.toml" 2>/dev/null)" "[projects.\"$PROJECT_DIR\"]"

# A profile launched once into a directory it already trusts must still pick up
# later changes to the main config.
printf 'model = "test"\nmain-profile-edit = true\n' > "$RESHARE_HOME/.codex/config.toml"
OUT="$(run_profile_sync)"
STATUS=$?
assert_zero "relaunch into a trusted directory succeeds" "$STATUS"
assert_contains "relaunch re-syncs the Codex profile config with the main profile" \
  "$(cat "$RESHARE_PROF/codex/config.toml" 2>/dev/null)" 'main-profile-edit = true'
assert_contains "relaunch keeps trusting the launch directory" \
  "$(cat "$RESHARE_PROF/codex/config.toml" 2>/dev/null)" "[projects.\"$PROJECT_DIR\"]"
assert_contains "relaunch keeps the file-backed CLI credential store" \
  "$(cat "$RESHARE_PROF/codex/config.toml" 2>/dev/null)" 'cli_auth_credentials_store = "file"'
assert_contains "relaunch keeps the file-backed MCP credential store" \
  "$(cat "$RESHARE_PROF/codex/config.toml" 2>/dev/null)" 'mcp_oauth_credentials_store = "file"'
assert_eq "reshare: initial copy does not create a backup" "absent" "$(if [[ -e "$RESHARE_PROF/claude/settings.json.yolobak-1" ]]; then echo present; else echo absent; fi)"

echo sentinel > "$RESHARE_PROF/claude/settings.json"
echo user-prompt > "$RESHARE_PROF/codex/prompts/cq:plan.md"
echo user-only > "$RESHARE_PROF/codex/prompts/user.md"
OUT="$(run_profile_sync)"
STATUS=$?
assert_zero "second launch synchronizes every profile's assets" "$STATUS"
assert_eq "reshare: differing file is overwritten from source" "x" "$(cat "$RESHARE_PROF/claude/settings.json")"
assert_eq "reshare: differing file is preserved in first backup" "sentinel" "$(cat "$RESHARE_PROF/claude/settings.json.yolobak-1" 2>/dev/null)"
assert_eq "reshare: differing directory is overwritten from source" "x" "$(cat "$RESHARE_PROF/codex/prompts/cq:plan.md" 2>/dev/null)"
assert_eq "reshare: differing directory is preserved in first backup" "user-prompt" "$(cat "$RESHARE_PROF/codex/prompts.yolobak-1/cq:plan.md" 2>/dev/null)"
assert_eq "reshare: user-only directory content is preserved in backup" "user-only" "$(cat "$RESHARE_PROF/codex/prompts.yolobak-1/user.md" 2>/dev/null)"
assert_eq "reshare: user-only directory content is absent after sync" "absent" "$(if [[ -e "$RESHARE_PROF/codex/prompts/user.md" ]]; then echo present; else echo absent; fi)"

OUT="$(run_profile_sync)"
STATUS=$?
assert_zero "unchanged launch keeps synchronized profile assets" "$STATUS"
assert_eq "reshare: unchanged file does not create another backup" "absent" "$(if [[ -e "$RESHARE_PROF/claude/settings.json.yolobak-2" ]]; then echo present; else echo absent; fi)"
assert_eq "reshare: unchanged directory does not create another backup" "absent" "$(if [[ -e "$RESHARE_PROF/codex/prompts.yolobak-2" ]]; then echo present; else echo absent; fi)"

echo second-edit > "$RESHARE_PROF/claude/settings.json"
OUT="$(run_profile_sync)"
STATUS=$?
assert_zero "later differing launch synchronizes profile assets" "$STATUS"
assert_eq "reshare: later differing file is overwritten from source" "x" "$(cat "$RESHARE_PROF/claude/settings.json")"
assert_eq "reshare: later differing file uses next backup suffix" "second-edit" "$(cat "$RESHARE_PROF/claude/settings.json.yolobak-2" 2>/dev/null)"

# ── $PWD==$HOME refusal guard (+ --unsafe-share-home + symlink canonicalization)
source_guard "$FAKE_HOME" "$FAKE_HOME"
assert_nonzero "PWD==HOME refused" "$STATUS"
assert_contains "PWD==HOME error message" "$OUT" "refusing to run yolo-darwin from \$HOME"
source_guard "$PROJECT_DIR" "$FAKE_HOME"
assert_zero "a non-home project dir is allowed" "$STATUS"
HOME_SUBDIR="$FAKE_HOME/subdir"; mkdir -p "$HOME_SUBDIR"
source_guard "$HOME_SUBDIR" "$FAKE_HOME"
assert_zero "a subdir of \$HOME is allowed (guard fires on PWD==HOME only)" "$STATUS"
SYMLINK_HOME="$WORKDIR/home-symlink"; ln -s "$FAKE_HOME" "$SYMLINK_HOME"
source_guard "$SYMLINK_HOME" "$FAKE_HOME"
assert_nonzero "symlinked \$PWD resolving to \$HOME refuses (portable canonicalization)" "$STATUS"
OUT="$(cd "$SYMLINK_HOME" && HOME="$FAKE_HOME" bash -c 'source "$1" --unsafe-share-home cmd true' _ "$PREFIX" 2>&1)"; STATUS=$?
assert_zero "--unsafe-share-home overrides the symlinked-\$HOME refusal" "$STATUS"

# ── summary ─────────────────────────────────────────────────────────────────
echo "$TESTS_RUN assertions run, $FAILURES failed."
[[ "$FAILURES" -eq 0 ]]
