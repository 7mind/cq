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

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
