#!/usr/bin/env bash
# Deterministic tests source the real pre-exec helpers without reaching exec.
# They cover yolo's policy fragment, profile layout, and HOME guard; the
# Darwin-only flake check covers the upstream base and Seatbelt enforcement.
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SCRIPT="$SCRIPT_DIR/yolo-darwin.sh"
GOLDEN_FILE="$SCRIPT_DIR/testdata/profile-foo.sb"

# Satisfy mandatory paths; these commands are never invoked before the exec seam.
_true_path="$(command -v true || echo /bin/true)"
_bash_path="$(command -v bash || echo /bin/bash)"
_jq_path="$(command -v jq || echo /usr/bin/jq)"
export YOLO_SANDBOX_EXEC="$_true_path"
export YOLO_JQ="$_jq_path"
export YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh"

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
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
run_script bogus
assert_nonzero "unknown subcommand exits non-zero" "$STATUS"
assert_contains "unknown subcommand lists supported tools" "$OUT" "claude, codex, pi, shell, cmd"
run_script --profile .. cmd true
assert_nonzero "invalid profile '..' exits non-zero" "$STATUS"
assert_contains "invalid profile '..' reports charset error" "$OUT" "invalid profile name"
run_script
assert_contains "usage mentions --disable" "$OUT" "--disable=TAG"

# ── generated policy ─────────────────────────────────────────────────────────
RENDERED="$(render_profile foo /tmp/x)"
GOLDEN="$(cat "$GOLDEN_FILE" 2>/dev/null || true)"
assert_eq "rendered foo profile matches testdata/profile-foo.sb" "$GOLDEN" "$RENDERED"
assert_contains "allows read+write to \$PWD (/tmp/x)" "$RENDERED" '(subpath "/tmp/x")'
assert_contains "allows ~/.cache" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.cache"))'
assert_contains "allows active profile claude dir" "$RENDERED" '"/.config/yolo/foo/claude"'
assert_contains "allows active profile codex dir" "$RENDERED" '"/.config/yolo/foo/codex"'
assert_contains "allows active profile pi dir" "$RENDERED" '"/.config/yolo/foo/pi"'
assert_contains "explicitly denies the ~/.config/yolo profiles tree" "$RENDERED" '(subpath (string-append (param "HOME_DIR") "/.config/yolo")))'
assert_not_contains "no (version 1) line (the base provides it)" "$RENDERED" '(version 1)'

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
  'done' > "$FAKE_BIN/prompt-sandbox"
chmod +x "$FAKE_BIN/security" "$FAKE_BIN/sandbox" "$FAKE_BIN/prompt-sandbox"

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
      YOLO_SANDBOX_EXEC="$FAKE_BIN/prompt-sandbox" \
      bash "$SCRIPT" "$@" 2>&1
  )"
  STATUS=$?
}

run_prompt_exec claude
assert_zero "claude launch with custom prompt succeeds" "$STATUS"
assert_contains "claude receives targeted and shared prompt fragments" "$OUT" $'prompt<<claude only\n\nshared line\n\naudio line>>'
assert_not_contains "claude excludes pi-targeted prompt fragments" "$OUT" "pi only"
run_prompt_exec pi
assert_zero "pi launch with custom prompt succeeds" "$STATUS"
assert_contains "pi receives shared and targeted prompt fragments" "$OUT" $'prompt<<shared line\n\naudio line\n\npi only>>'
assert_not_contains "pi excludes claude-targeted prompt fragments" "$OUT" "claude only"
run_prompt_exec --disable=unused,gpu --disable=audio claude
assert_zero "claude launch with disabled prompt tags succeeds" "$STATUS"
assert_contains "repeatable and comma-separated disable tags preserve untagged fragments" "$OUT" "prompt<<claude only>>"
assert_not_contains "disabled gpu prompt fragment is excluded" "$OUT" "shared line"
assert_not_contains "disabled audio prompt fragment is excluded" "$OUT" "audio line"

# ── copied HM assets ─────────────────────────────────────────────────────────
# Run all agents in one shell so a second pass can verify copy-if-absent.
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
echo x > "$RESHARE_HOME/.codex/prompts/cq:plan.md"
echo x > "$RESHARE_HOME/.pi/agent/settings.json"
echo x > "$RESHARE_HOME/.pi/agent/APPEND_SYSTEM.md"
echo x > "$RESHARE_HOME/.pi/agent/cq-agents/plan-reviewer.md"
echo x > "$RESHARE_HOME/.pi/agent/prompts/cq:plan.md"
(cd "$PROJECT_DIR" && HOME="$RESHARE_HOME" bash -c '
  source "$1" --profile foo cmd true
  reshare_profile_assets claude
  reshare_profile_assets codex
  reshare_profile_assets pi
  echo sentinel > "$CLAUDE_CONFIG_DIR/settings.json"
  reshare_profile_assets claude
  exit 0
' _ "$PREFIX")
assert_zero "reshare subshell ran" "$?"
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
assert_eq "reshare: copy-if-absent preserves an existing dest (sentinel)" "sentinel" "$(cat "$RESHARE_PROF/claude/settings.json")"

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
