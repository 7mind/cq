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
assert_contains "sandbox clears inherited environment" "$OUT" "--clearenv"
assert_contains "sandbox preserves HOME" "$OUT" $'--setenv\nHOME\n'"$HOME"
assert_contains "sandbox preserves PATH" "$OUT" $'--setenv\nPATH\n'

OUT_RUNTIME="$(PATH="$FAKE_BIN:$PATH" TERMINFO_DIRS=/test/terminfo \
  TERM_PROGRAM=tmux XDG_SESSION_TYPE=tty NIX_LD=/test/ld NIXPKGS_CONFIG=/test/nixpkgs.nix \
  LOCALE_ARCHIVE=/test/locale NIX_CONFIG=host-only bash "$SCRIPT" -- true 2>&1)"
assert_contains "terminal database is retained" "$OUT_RUNTIME" $'--setenv\nTERMINFO_DIRS\n/test/terminfo'
assert_contains "terminal program is retained" "$OUT_RUNTIME" $'--setenv\nTERM_PROGRAM\ntmux'
assert_contains "session type is retained" "$OUT_RUNTIME" $'--setenv\nXDG_SESSION_TYPE\ntty'
assert_contains "Nix loader is retained" "$OUT_RUNTIME" $'--setenv\nNIX_LD\n/test/ld'
assert_contains "nixpkgs configuration path is retained" "$OUT_RUNTIME" $'--setenv\nNIXPKGS_CONFIG\n/test/nixpkgs.nix'
assert_contains "locale archive is retained" "$OUT_RUNTIME" $'--setenv\nLOCALE_ARCHIVE\n/test/locale'
if [[ "$OUT_RUNTIME" == *$'--setenv\nNIX_CONFIG\n'* ]]; then
  echo "FAIL: NIX_CONFIG was forwarded"
  FAILURES=$((FAILURES + 1))
fi

OUT_EXPLICIT="$(PATH="$FAKE_BIN:$PATH" GH_TOKEN=host-token bash "$SCRIPT" --env GH_TOKEN=explicit-token -- true 2>&1)"
assert_contains "explicit environment is added" "$OUT_EXPLICIT" $'--setenv\nGH_TOKEN\nexplicit-token'

# Bind precedence: bwrap applies mounts in argv order, so the caller's own
# ordering must survive verbatim — a later --ro/--rw/--bind must be able to
# override an earlier one regardless of which flavour each one used.
ORDER_DIR="$WORKDIR/order"
mkdir -p "$ORDER_DIR/a" "$ORDER_DIR/b" "$ORDER_DIR/c" "$ORDER_DIR/d"
ORDER_OUT="$(PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" \
  --rw "$ORDER_DIR/a" \
  --ro-bind "$ORDER_DIR/b,$ORDER_DIR/b" \
  --ro "$ORDER_DIR/c" \
  --bind "$ORDER_DIR/d,$ORDER_DIR/d" \
  --ro "$ORDER_DIR/a" \
  -- true 2>/dev/null)"
ORDER_SEEN="$(printf '%s\n' "$ORDER_OUT" | grep -F -- "$ORDER_DIR" | tr '\n' ' ')"
assert_eq \
  "bind flavours are emitted in the order they were given" \
  "$ORDER_DIR/a $ORDER_DIR/a $ORDER_DIR/b $ORDER_DIR/b $ORDER_DIR/c $ORDER_DIR/c $ORDER_DIR/d $ORDER_DIR/d $ORDER_DIR/a $ORDER_DIR/a " \
  "$ORDER_SEEN"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  echo "$OUT"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
