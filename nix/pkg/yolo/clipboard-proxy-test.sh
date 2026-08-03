#!/usr/bin/env bash
# Unit/integration tests for yolo-clipboard-proxy (defects:D262, tasks:T1794).
# Usage: bash clipboard-proxy-test.sh /path/to/yolo-clipboard-proxy
set -u

PROXY="${1:?usage: clipboard-proxy-test.sh /path/to/yolo-clipboard-proxy}"
if [[ ! -x "$PROXY" ]]; then
  echo "FAIL: proxy not executable: $PROXY" >&2
  exit 1
fi

# Named bounds mirrored from main.rs (the suite pins them as the contract).
CLIPBOARD_MAX_BYTES=1048576
DIAGNOSTIC_MAX_BYTES=4096
ADAPTER_DEADLINE_SECONDS=10
SCHEDULING_TOLERANCE_SECONDS=5

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

# Strict recorder: every adapter invocation appends ONE line to argv.log with
# the complete argv joined by U+001F (never present in these arguments), so the
# suite compares whole argv vectors and counts invocations — no substrings.
FAKE_TMUX="$WORKDIR/fake-tmux"
FAKE_STATE="$WORKDIR/tmux-state"
_bash_path="$(command -v bash)"
_python_path="$(command -v python3)"
mkdir -p "$FAKE_STATE"
printf 'initial-buffer' > "$FAKE_STATE/buffer"
: > "$FAKE_STATE/argv.log"
{
  printf '#!%s\n' "$_bash_path"
  cat <<'EOF'
set -euo pipefail
STATE_DIR="${FAKE_TMUX_STATE:?}"
MODE="$(cat "$STATE_DIR/mode" 2>/dev/null || echo normal)"
STDOUT_SIZE="$(cat "$STATE_DIR/stdout_size" 2>/dev/null || echo 0)"
STDERR_SIZE="$(cat "$STATE_DIR/stderr_size" 2>/dev/null || echo 0)"
python3 -c 'import sys; open(sys.argv[1], "a").write("\x1f".join(sys.argv[2:]) + "\n")' \
  "$STATE_DIR/argv.log" "$@"
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
case "$MODE" in
  normal)
    case "$cmd" in
      load-buffer)
        if [[ "${args[0]:-}" == "-" ]]; then cat > "$STATE_DIR/buffer"; else cp "${args[0]}" "$STATE_DIR/buffer"; fi
        ;;
      save-buffer)
        if [[ "${args[0]:-}" == "-" ]]; then cat "$STATE_DIR/buffer"; else cp "$STATE_DIR/buffer" "${args[0]}"; fi
        ;;
      *)
        echo "fake-tmux: unexpected command '$cmd'" >&2
        exit 64
        ;;
    esac
    ;;
  big-stdout)
    if [[ "$cmd" == "save-buffer" ]]; then
      head -c "$STDOUT_SIZE" /dev/zero | tr '\0' 'x'
    fi
    ;;
  big-stderr-fail)
    head -c "$STDERR_SIZE" /dev/zero | tr '\0' 'e' >&2
    exit 1
    ;;
  stderr-first)
    # Fill stderr beyond pipe capacity BEFORE consuming stdin: without
    # concurrent bounded pumping this deadlocks the broker and its client.
    head -c 262144 /dev/zero | tr '\0' 'e' >&2
    cat > "$STATE_DIR/buffer"
    ;;
  hang)
    sleep 3600
    ;;
  *)
    echo "fake-tmux: unknown mode '$MODE'" >&2
    exit 64
    ;;
esac
EOF
} > "$FAKE_TMUX"
chmod +x "$FAKE_TMUX"
export FAKE_TMUX_STATE="$FAKE_STATE"

adapter_count() { wc -l < "$FAKE_STATE/argv.log" | tr -d ' '; }

# $1 description, $2 expected argv vector joined by U+001F
assert_last_argv() {
  local desc="$1" expected="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  local actual
  actual="$(tail -1 "$FAKE_STATE/argv.log")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $desc -- expected argv [$expected], got [$actual]"
    FAILURES=$((FAILURES + 1))
  fi
}

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

# --- Round-trip size matrix: zero, ordinary (with NUL+newline), exactly 1 MiB.
: > "$WORKDIR/p0"
printf 'a\0b\nc\n' > "$WORKDIR/p17"
"$_python_path" -c 'import sys; sys.stdout.buffer.write(bytes(range(256)) * 4096)' > "$WORKDIR/p1m"
for size_name in p0 p17 p1m; do
  "$PROXY" client set < "$WORKDIR/$size_name"
  ST=$?
  assert_ok "client set $size_name" "$ST"
  "$PROXY" client get > "$WORKDIR/${size_name}.out"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! cmp -s "$WORKDIR/$size_name" "$WORKDIR/${size_name}.out"; then
    echo "FAIL: round-trip $size_name differs"
    FAILURES=$((FAILURES + 1))
  fi
done

# --- Strict argv vectors and invocation counts.
COUNT_BEFORE="$(adapter_count)"
printf 'vector-set' | "$PROXY" client set
ST=$?
assert_ok "client set for argv vector" "$ST"
assert_last_argv "SET invokes the exact fixed load-buffer vector" \
  "-S"$'\x1f'"/tmp/does-not-need-to-exist.sock"$'\x1f'"load-buffer"$'\x1f'"-"
GOT="$("$PROXY" client get)"
assert_eq "client get returns set payload" "vector-set" "$GOT"
assert_last_argv "GET invokes the exact fixed save-buffer vector" \
  "-S"$'\x1f'"/tmp/does-not-need-to-exist.sock"$'\x1f'"save-buffer"$'\x1f'"-"
assert_eq "adapter invoked once per valid op" "$((COUNT_BEFORE + 2))" "$(adapter_count)"

# --- tmux shim: load-buffer / save-buffer / show-buffer ---
printf 'via-shim' | "$PROXY" tmux-shim load-buffer -
assert_ok "shim load-buffer" "$?"
assert_eq "shim load-buffer wrote buffer" "via-shim" "$(cat "$FAKE_STATE/buffer")"
assert_last_argv "shim SET keeps the exact vector" \
  "-S"$'\x1f'"/tmp/does-not-need-to-exist.sock"$'\x1f'"load-buffer"$'\x1f'"-"

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

# --- Rejections: dangerous verbs, unknown options, named buffers. The strict
# recorder must not count a single adapter invocation for any of them.
COUNT_BEFORE="$(adapter_count)"
ERR="$("$PROXY" tmux-shim run-shell 'id' 2>&1)"
ST=$?
assert_fail "run-shell rejected" "$ST"
assert_contains "run-shell error names the command" "$ERR" "run-shell"

ERR="$("$PROXY" tmux-shim new-window -d 2>&1)"
ST=$?
assert_fail "new-window rejected" "$ST"

ERR="$("$PROXY" tmux-shim new-session 2>&1)"
ST=$?
assert_fail "new-session rejected" "$ST"

ERR="$("$PROXY" tmux-shim send-keys 'x' 2>&1)"
ST=$?
assert_fail "send-keys rejected" "$ST"

ERR="$("$PROXY" tmux-shim load-buffer -b other - 2>&1)"
ST=$?
assert_fail "named buffer -b rejected" "$ST"

ERR="$("$PROXY" tmux-shim load-buffer --bogus - 2>&1)"
ST=$?
assert_fail "unknown load-buffer option rejected" "$ST"

assert_eq "zero adapter invocations across every rejection" "$COUNT_BEFORE" "$(adapter_count)"

# --- Frame-level negatives: unknown tags, truncated headers and payloads,
# trailing data, declared oversized. None may reach the adapter.
COUNT_BEFORE="$(adapter_count)"
"$_python_path" - "$SOCK" "$CLIPBOARD_MAX_BYTES" <<'PY'
import socket
import struct
import sys

sock_path, limit = sys.argv[1], int(sys.argv[2])
outcomes = []

def exchange(payload, expect_response):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(sock_path)
    s.sendall(payload)
    if not expect_response:
        s.shutdown(socket.SHUT_WR)
    data = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
            if len(data) > 65536:
                break
    except socket.timeout:
        pass
    except ConnectionResetError:
        pass
    s.close()
    return data

# Unknown tag: one ERR response, no adapter.
r = exchange(bytes([99]), True)
outcomes.append(("unknown-tag-err", len(r) >= 1 and r[0] == 1))
# Truncated length header: connection closes with no response.
r = exchange(bytes([1, 0, 0]), False)
outcomes.append(("truncated-header-closed", r == b""))
# Truncated payload (declare 100, deliver 10): closed, no response.
r = exchange(bytes([1]) + struct.pack("<I", 100) + b"0123456789", False)
outcomes.append(("truncated-payload-closed", r == b""))
# Trailing data after a complete request: ERR, no adapter.
r = exchange(bytes([1]) + struct.pack("<I", 3) + b"abc" + b"X", True)
outcomes.append(("trailing-err", len(r) >= 1 and r[0] == 1))
# Declared oversized request: ERR before any body is read.
r = exchange(bytes([1]) + struct.pack("<I", limit + 1), True)
outcomes.append(("oversized-declared-err", len(r) >= 1 and r[0] == 1))

for name, ok in outcomes:
    print(f'{name}={"1" if ok else "0"}')
    if not ok:
        sys.exit(1)
PY
ST=$?
assert_ok "frame-level negatives are rejected" "$ST"
assert_eq "zero adapter invocations across frame negatives" "$COUNT_BEFORE" "$(adapter_count)"

# --- Declared and streamed input bounds: exactly-limit succeeds,
# limit-plus-one fails, and the proxy stops reading after at most
# limit-plus-one bytes.
head -c $((CLIPBOARD_MAX_BYTES + 1)) /dev/zero | "$PROXY" client set >/dev/null 2>&1
ST=$?
assert_fail "declared limit-plus-one set rejected" "$ST"

"$_python_path" - "$PROXY" "$CLIPBOARD_MAX_BYTES" <<'PY'
import subprocess
import sys

proxy, limit = sys.argv[1], int(sys.argv[2])
proc = subprocess.Popen(
    [proxy, "tmux-shim", "load-buffer", "-"],
    stdin=subprocess.PIPE,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
written = 0
chunk = b"y" * 65536
try:
    while written < limit + 2 * 1024 * 1024:
        proc.stdin.write(chunk)
        proc.stdin.flush()
        written += len(chunk)
except (BrokenPipeError, ConnectionResetError):
    pass
try:
    proc.stdin.close()
except BrokenPipeError:
    pass
status = proc.wait()
slack = 524288
print(f"shim-status={status} written={written} cap-plus-slack={limit + 1 + slack}")
sys.exit(0 if (status != 0 and written <= limit + 1 + slack) else 1)
PY
ST=$?
assert_ok "shim stops reading after at most limit-plus-one bytes" "$ST"

# --- Strict-adapter fixtures ------------------------------------------------

# Exactly-limit adapter stdout succeeds.
printf 'big-stdout\n' > "$FAKE_STATE/mode"
printf '%s\n' "$CLIPBOARD_MAX_BYTES" > "$FAKE_STATE/stdout_size"
GOT_SIZE="$("$PROXY" client get | wc -c | tr -d ' ')"
assert_eq "exactly-limit adapter stdout succeeds" "$CLIPBOARD_MAX_BYTES" "$GOT_SIZE"

# Limit-plus-one adapter stdout fails with a bounded diagnostic.
printf '%s\n' "$((CLIPBOARD_MAX_BYTES + 1))" > "$FAKE_STATE/stdout_size"
ERR="$("$PROXY" client get 2>&1)"
ST=$?
assert_fail "limit-plus-one adapter stdout rejected" "$ST"
assert_contains "stdout overflow is attributed by the broker" "$ERR" "stdout exceeds the"
TESTS_RUN=$((TESTS_RUN + 1))
diag="${ERR#yolo-clipboard-proxy client: }"
if [[ $(printf '%s' "$diag" | wc -c) -gt $DIAGNOSTIC_MAX_BYTES ]]; then
  echo "FAIL: stdout-overflow diagnostic exceeds its bound (> $DIAGNOSTIC_MAX_BYTES bytes)"
  FAILURES=$((FAILURES + 1))
fi

# Oversized adapter stderr on failure: the diagnostic stays within its bound.
printf 'big-stderr-fail\n' > "$FAKE_STATE/mode"
printf '100000\n' > "$FAKE_STATE/stderr_size"
ERR="$(printf 'x' | "$PROXY" client set 2>&1)"
ST=$?
assert_fail "adapter failure surfaces" "$ST"
assert_contains "adapter failure keeps the broker diagnostic form" "$ERR" "failed (status"
TESTS_RUN=$((TESTS_RUN + 1))
diag="${ERR#yolo-clipboard-proxy client: }"
if [[ $(printf '%s' "$diag" | wc -c) -gt $DIAGNOSTIC_MAX_BYTES ]]; then
  echo "FAIL: adapter-failure diagnostic exceeds its bound (> $DIAGNOSTIC_MAX_BYTES bytes)"
  FAILURES=$((FAILURES + 1))
fi

# stderr filled beyond pipe capacity before the child consumes stdin:
# concurrent pumping must avoid the pipe deadlock.
printf 'stderr-first\n' > "$FAKE_STATE/mode"
start=$SECONDS
printf 'stderr-first-payload' | "$PROXY" client set >/dev/null 2>&1
ST=$?
assert_ok "stderr-first does not deadlock the adapter" "$ST"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ $((SECONDS - start)) -ge $ADAPTER_DEADLINE_SECONDS ]]; then
  echo "FAIL: stderr-first completed only at the deadline boundary ($((SECONDS - start))s)"
  FAILURES=$((FAILURES + 1))
fi

# A child that hangs indefinitely is killed and reaped within the named
# deadline plus a fixed scheduling tolerance; the diagnostic stays bounded.
printf 'hang\n' > "$FAKE_STATE/mode"
start=$SECONDS
ERR="$(printf 'x' | "$PROXY" client set 2>&1)"
ST=$?
elapsed=$((SECONDS - start))
assert_fail "hanging adapter request fails" "$ST"
assert_contains "hang diagnostic names the deadline" "$ERR" "deadline"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ $elapsed -gt $((ADAPTER_DEADLINE_SECONDS + SCHEDULING_TOLERANCE_SECONDS)) ]]; then
  echo "FAIL: hanging adapter was not killed within deadline+tolerance (${elapsed}s > $((ADAPTER_DEADLINE_SECONDS + SCHEDULING_TOLERANCE_SECONDS))s)"
  FAILURES=$((FAILURES + 1))
fi
TESTS_RUN=$((TESTS_RUN + 1))
diag="${ERR#yolo-clipboard-proxy client: }"
if [[ $(printf '%s' "$diag" | wc -c) -gt $DIAGNOSTIC_MAX_BYTES ]]; then
  echo "FAIL: hang diagnostic exceeds its bound (> $DIAGNOSTIC_MAX_BYTES bytes)"
  FAILURES=$((FAILURES + 1))
fi

# The broker stays available: the next valid request succeeds.
printf 'normal\n' > "$FAKE_STATE/mode"
pkill -f 'sleep 3600' 2>/dev/null || true
printf 'after-hang' | "$PROXY" client set
ST=$?
assert_ok "broker serves the next valid request after overflow and hang" "$ST"
GOT="$("$PROXY" client get)"
assert_eq "next request round-trips" "after-hang" "$GOT"

# --- Malformed responses (client side): garbage tags and oversized frames
# are rejected; the strict adapter is not involved at all.
BOGUS_SOCK="$WORKDIR/bogus.sock"
"$_python_path" - "$BOGUS_SOCK" <<'PY' &
import socket
import struct
import sys

srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sys.argv[1])
srv.listen()
for reply in (bytes([77]), bytes([2]) + struct.pack("<I", 1048577), bytes([1]) + struct.pack("<I", 4097)):
    conn, _ = srv.accept()
    conn.sendall(reply)
    conn.close()
PY
BOGUS_PID=$!
for _ in $(seq 1 50); do [[ -S "$BOGUS_SOCK" ]] && break; sleep 0.05; done
YOLO_CLIPBOARD_SOCK="$BOGUS_SOCK" "$PROXY" client get >/dev/null 2>&1
ST1=$?
YOLO_CLIPBOARD_SOCK="$BOGUS_SOCK" "$PROXY" client get >/dev/null 2>&1
ST2=$?
YOLO_CLIPBOARD_SOCK="$BOGUS_SOCK" "$PROXY" client get >/dev/null 2>&1
ST3=$?
wait "$BOGUS_PID" 2>/dev/null || true
assert_fail "garbage response tag rejected" "$ST1"
assert_fail "oversized DATA frame rejected" "$ST2"
assert_fail "oversized ERR frame rejected" "$ST3"

# Broker must still be alive after everything
kill -0 "$BROKER_PID" 2>/dev/null
assert_ok "broker still running" "$?"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN clipboard-proxy tests failed"
  exit 1
fi
echo "All $TESTS_RUN clipboard-proxy tests passed"
