#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SCRIPT="$SCRIPT_DIR/llm-sandbox.sh"

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
FAKE_BIN="$WORKDIR/bin"
_bash_path="$(command -v bash)"
mkdir -p "$FAKE_BIN"

printf '%s\n' \
  "#!$_bash_path" \
  'printf "%s\n" "$@"' \
  > "$FAKE_BIN/bwrap"
chmod +x "$FAKE_BIN/bwrap"

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

OUT="$(PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" -- true 2>&1)"
STATUS=$?

assert_eq "sandbox invocation succeeds" "0" "$STATUS"
assert_contains \
  "sandbox provides the NixOS runtime-directory alias" \
  "$OUT" \
  $'--dir\n/var\n--symlink\n/run\n/var/run'

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  echo "$OUT"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
