#!/usr/bin/env bash
# Unit/integration tests for yolo-clipboard-proxy (defects:D262).
# Usage: bash clipboard-proxy-test.sh /path/to/yolo-clipboard-proxy
set -u

PROXY="${1:?usage: clipboard-proxy-test.sh /path/to/yolo-clipboard-proxy}"
if [[ ! -x "$PROXY" ]]; then
  echo "FAIL: proxy not executable: $PROXY" >&2
  exit 1
fi

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; [[ -n "${BROKER_PID:-}" ]] && kill "$BROKER_PID" 2>/dev/null || true' EXIT

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
    echo "FAIL: $desc -- expected to contain [$needle], got [$haystack]"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_ok() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -ne 0 ]]; then
    echo "FAIL: $desc -- exit $status"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_fail() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -eq 0 ]]; then
    echo "FAIL: $desc -- expected non-zero exit"
    FAILURES=$((FAILURES + 1))
  fi
}

# Fake tmux: records argv + stdin, serves a fixed buffer for save-buffer.
# Use an absolute bash shebang — pure Nix build sandboxes often lack
# /usr/bin/env, and a missing interpreter surfaces as ENOENT on spawn.
FAKE_TMUX="$WORKDIR/fake-tmux"
FAKE_STATE="$WORKDIR/tmux-state"
_bash_path="$(command -v bash)"
mkdir -p "$FAKE_STATE"
printf 'initial-buffer' > "$FAKE_STATE/buffer"
{
  printf '#!%s\n' "$_bash_path"
  cat <<'EOF'
set -euo pipefail
STATE_DIR="${FAKE_TMUX_STATE:?}"
printf '%s\n' "$@" > "$STATE_DIR/last-argv"
# Parse fixed shape: -S <sock> <cmd> ...
sock=""
cmd=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -S) sock="$2"; shift 2 ;;
    *)
      if [[ -z "$cmd" ]]; then cmd="$1"; shift
      else args+=("$1"); shift
      fi
      ;;
  esac
done
printf '%s' "$sock" > "$STATE_DIR/last-sock"
case "$cmd" in
  load-buffer)
    path="${args[0]:-}"
    if [[ "$path" == "-" ]]; then
      cat > "$STATE_DIR/buffer"
    else
      cp "$path" "$STATE_DIR/buffer"
    fi
    ;;
  save-buffer)
    path="${args[0]:-}"
    if [[ "$path" == "-" ]]; then
      cat "$STATE_DIR/buffer"
    else
      cp "$STATE_DIR/buffer" "$path"
    fi
    ;;
  *)
    echo "fake-tmux: unexpected command '$cmd'" >&2
    exit 64
    ;;
esac
EOF
} > "$FAKE_TMUX"
chmod +x "$FAKE_TMUX"
export FAKE_TMUX_STATE="$FAKE_STATE"

SOCK_DIR="$WORKDIR/clip"
mkdir -p "$SOCK_DIR"
chmod 700 "$SOCK_DIR"
SOCK="$SOCK_DIR/sock"

"$PROXY" broker \
  --listen "$SOCK" \
  --tmux-socket /tmp/does-not-need-to-exist.sock \
  --tmux "$FAKE_TMUX" &
BROKER_PID=$!

for _ in $(seq 1 50); do
  [[ -S "$SOCK" ]] && break
  sleep 0.05
done
if [[ ! -S "$SOCK" ]]; then
  echo "FAIL: broker did not create socket"
  exit 1
fi
TESTS_RUN=$((TESTS_RUN + 1))

export YOLO_CLIPBOARD_SOCK="$SOCK"

# --- client set/get round-trip ---
set +e
printf 'hello-clipboard' | "$PROXY" client set
ST=$?
set -e
assert_ok "client set" "$ST"
GOT="$("$PROXY" client get)"
assert_eq "client get returns set payload" "hello-clipboard" "$GOT"

# After get, last command is save-buffer; set again and inspect fixed argv.
set +e
printf 'payload-2' | "$PROXY" client set
ST=$?
set -e
assert_ok "client set payload-2" "$ST"
ARGV="$(tr '\n' ' ' < "$FAKE_STATE/last-argv")"
assert_contains "broker invokes fixed load-buffer argv" "$ARGV" "load-buffer"
assert_contains "broker passes stdin marker '-'" "$ARGV" "-"
assert_eq "buffer content after set" "payload-2" "$(cat "$FAKE_STATE/buffer")"

# --- tmux shim: load-buffer / save-buffer ---
printf 'via-shim' | "$PROXY" tmux-shim load-buffer -
assert_ok "shim load-buffer" "$?"
assert_eq "shim load-buffer wrote buffer" "via-shim" "$(cat "$FAKE_STATE/buffer")"

GOT="$("$PROXY" tmux-shim save-buffer -)"
assert_eq "shim save-buffer" "via-shim" "$GOT"

GOT="$("$PROXY" tmux-shim show-buffer)"
assert_eq "shim show-buffer" "via-shim" "$GOT"

# argv0==tmux path (symlink)
SHIM_DIR="$WORKDIR/shim"
mkdir -p "$SHIM_DIR"
ln -s "$PROXY" "$SHIM_DIR/tmux"
printf 'argv0-tmux' | PATH="$SHIM_DIR:$PATH" tmux load-buffer -
assert_eq "argv0 tmux load-buffer" "argv0-tmux" "$(cat "$FAKE_STATE/buffer")"

# --- rejections: dangerous verbs must fail closed ---
set +e
ERR="$("$PROXY" tmux-shim run-shell 'id' 2>&1)"
ST=$?
set -e
assert_fail "run-shell rejected" "$ST"
assert_contains "run-shell error names the command" "$ERR" "run-shell"

set +e
ERR="$("$PROXY" tmux-shim new-window -d 2>&1)"
ST=$?
set -e
assert_fail "new-window rejected" "$ST"

set +e
ERR="$("$PROXY" tmux-shim new-session 2>&1)"
ST=$?
set -e
assert_fail "new-session rejected" "$ST"

set +e
ERR="$("$PROXY" tmux-shim send-keys 'x' 2>&1)"
ST=$?
set -e
assert_fail "send-keys rejected" "$ST"

set +e
ERR="$("$PROXY" tmux-shim load-buffer -b other - 2>&1)"
ST=$?
set -e
assert_fail "named buffer -b rejected" "$ST"

# --- size limit ---
set +e
# 1 MiB + 1 should fail at client
dd if=/dev/zero bs=1024 count=1025 2>/dev/null | "$PROXY" client set >/dev/null 2>&1
ST=$?
set -e
assert_fail "oversized set rejected" "$ST"

# Broker must still be alive after rejections
kill -0 "$BROKER_PID" 2>/dev/null
assert_ok "broker still running" "$?"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN clipboard-proxy tests failed"
  exit 1
fi
echo "All $TESTS_RUN clipboard-proxy tests passed"
