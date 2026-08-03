#!/usr/bin/env bash
# Lifecycle tests for the yolo clipboard broker (defects:D262, tasks:T1795):
# parent-death registration, readiness, and cleanup races.
# Usage: bash clipboard-proxy-lifecycle-test.sh /path/to/yolo-clipboard-proxy
set -u
# A broker that dies before draining its gate bytes must not SIGPIPE the
# suite itself; the write fails and the assertion layer reports instead.
trap '' PIPE

PROXY="${1:?usage: clipboard-proxy-lifecycle-test.sh /path/to/yolo-clipboard-proxy}"
if [[ ! -x "$PROXY" ]]; then
  echo "FAIL: proxy not executable: $PROXY" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

FAILURES=0
TESTS_RUN=0
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cq-clip-life.XXXXXX")"
PIDS_TO_REAP=()
cleanup() {
  for pid in "${PIDS_TO_REAP[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

assert_ok() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -ne 0 ]]; then
    fail "$desc -- exit $status"
  fi
}

assert_fail() {
  local desc="$1" status="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$status" -eq 0 ]]; then
    fail "$desc -- expected non-zero exit"
  fi
}

assert_absent() {
  local desc="$1" path="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ -e "$path" ]]; then
    fail "$desc ($path exists)"
  fi
}

assert_present() {
  local desc="$1" path="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ ! -e "$path" ]]; then
    fail "$desc ($path missing)"
  fi
}

assert_no_process() {
  local desc="$1" pid="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if kill -0 "$pid" 2>/dev/null; then
    fail "$desc (pid $pid still alive)"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

# Wait (bounded, order-driven) for a process to disappear.
wait_gone() {
  local pid="$1"
  for _ in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.02
  done
  return 1
}

# --- Deterministic stage kills ----------------------------------------------
# The mini-launcher spawns the broker with the sync FIFOs armed, then waits.
# The test holds the fifo ends, reads the stage byte, SIGKILLs the launcher at
# exactly that stage, then releases the remaining gates.
run_stage_case() {
  local stage="$1"
  local dir="$WORKDIR/case-$stage"
  mkdir -p "$dir"
  mkfifo "$dir/stage" "$dir/gate"
  (
    YOLO_CLIPBOARD_SYNC_STAGE="$dir/stage" YOLO_CLIPBOARD_SYNC_GATE="$dir/gate" \
      "$PROXY" broker --listen "$dir/launch/sock" --tmux-socket /tmp/x --tmux /bin/true &
    echo $! > "$dir/broker.pid"
    wait
  ) &
  local launcher_pid=$!
  PIDS_TO_REAP+=("$launcher_pid")
  # Open the stage reader first: the broker's first stage write unblocks.
  exec {STAGE_FD}<"$dir/stage"
  # Open the gate writer: the broker's first gate read unblocks.
  exec {GATE_FD}>"$dir/gate"
  local seen=""
  while [[ "$seen" != "$stage" ]]; do
    if ! read -r -n 1 -u "$STAGE_FD" seen; then
      break
    fi
    if [[ "$seen" != "$stage" ]]; then
      # Not the target stage: release the broker to the next stage.
      printf 'x' >&"$GATE_FD"
    fi
  done
  kill -KILL "$launcher_pid" 2>/dev/null
  wait "$launcher_pid" 2>/dev/null
  PIDS_TO_REAP=("${PIDS_TO_REAP[@]/$launcher_pid/}")
  # Release the target stage's gate and any later ones (the broker holds its
  # gate read end open across stages, so extra bytes simply buffer).
  printf 'x' >&"$GATE_FD"
  printf 'x' >&"$GATE_FD"
  local broker_pid
  broker_pid="$(< "$dir/broker.pid")"
  wait_gone "$broker_pid" || true
  assert_no_process "stage $stage: no broker survives a pre/post-registration parent SIGKILL" "$broker_pid"
  assert_absent "stage $stage: no socket survives" "$dir/launch/sock"
  assert_absent "stage $stage: no private launch directory survives" "$dir/launch"
  exec {STAGE_FD}<&-
  exec {GATE_FD}>&-
}

# A: SIGKILL before registration — the post-registration recheck must turn the
# fork/prctl window into a fatal exit before any bind.
run_stage_case A
# B: SIGKILL between registration and the recheck.
run_stage_case B
# C: SIGKILL after registration — pdeathsig delivers; the handler cleans up.
run_stage_case C

# --- Production yolo.sh readiness + cleanup ----------------------------------
# Minimal harness: fake bwrap records argv (and can sleep to hold the
# foreground launch open), fake jq, a live dummy inherited tmux socket.
BIN="$WORKDIR/bin"
mkdir -p "$BIN"
_bash_path="$(command -v bash)"
_python_path="$(command -v python3)"

cat > "$BIN/bwrap-record" <<EOF
#!$_bash_path
printf '%s\n' "\$@" > "\${RECORDER_DIR:?}/argv.txt"
EOF
chmod +x "$BIN/bwrap-record"

cat > "$BIN/bwrap-sleep" <<EOF
#!$_bash_path
printf '%s\n' "\$@" > "\${RECORDER_DIR:?}/argv.txt"
exec sleep 300
EOF
chmod +x "$BIN/bwrap-sleep"

cat > "$BIN/jq" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null || true
printf '{}\n'
EOF
chmod +x "$BIN/jq"

# A live dummy socket for the inherited TMUX coordinate.
DUMMY_SOCK="$WORKDIR/dummy-tmux.sock"
"$_python_path" - "$DUMMY_SOCK" <<'PY' &
import socket
import sys
import time

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(sys.argv[1])
sock.listen()
time.sleep(600)
PY
DUMMY_PID=$!
PIDS_TO_REAP+=("$DUMMY_PID")
for _ in $(seq 1 50); do [[ -S "$DUMMY_SOCK" ]] && break; sleep 0.02; done

SANDBOX_SCRIPT="$WORKDIR/llm-sandbox"
cp "$SCRIPT_DIR/llm-sandbox.sh" "$SANDBOX_SCRIPT"
chmod +x "$SANDBOX_SCRIPT"

run_yolo() { # $1 = bwrap flavor (bwrap-record|bwrap-sleep); rest = yolo args
  local flavor="$1"
  shift
  rm -f "$WORKDIR/recorder/argv.txt"
  mkdir -p "$WORKDIR/recorder" "$WORKDIR/home/rt"
  cp "$BIN/$flavor" "$BIN/bwrap"
  chmod +x "$BIN/bwrap"
  (
    cd "$WORKDIR"
    exec env -i \
      PATH="$BIN:$PATH" \
      HOME="$WORKDIR/home" \
      RECORDER_DIR="$WORKDIR/recorder" \
      XDG_RUNTIME_DIR="$WORKDIR/home/rt" \
      YOLO_LLM_SANDBOX="$SANDBOX_SCRIPT" \
      YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
      YOLO_NIX_LD="$(command -v true)" \
      YOLO_JQ="$BIN/jq" \
      YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
      YOLO_CLIPBOARD_PROXY="${YOLO_PROXY_UNDER_TEST:-$PROXY}" \
      YOLO_TMUX="$(command -v true)" \
      TMUX="$DUMMY_SOCK,0,0" \
      bash "$SCRIPT_DIR/yolo.sh" "$@"
  )
}

# Fake proxies for readiness states.
cat > "$BIN/fake-proxy-exited" <<EOF
#!$_bash_path
exit 42
EOF
chmod +x "$BIN/fake-proxy-exited"

cat > "$BIN/fake-proxy-stale" <<EOF
#!$_bash_path
# Parse --listen, create a STALE socket file (bound and abandoned), then idle.
listen=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --listen) listen="\$2"; shift 2 ;;
    --tmux-socket|--tmux) shift 2 ;;
    broker) shift ;;
    *) exit 64 ;;
  esac
done
[[ -n "\$listen" ]]
mkdir -p "\$(dirname "\$listen")"
"$_python_path" -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()' "\$listen"
echo \$\$ > "\$WORKDIR/stale.pid"
exec sleep 300
EOF
chmod +x "$BIN/fake-proxy-stale"

# Live broker: readiness succeeds and the sandbox sees the broker coordinate.
run_yolo bwrap-record cmd true
assert_ok "live broker launch succeeds" "$?"
TESTS_RUN=$((TESTS_RUN + 1))
if ! grep -qx 'YOLO_CLIPBOARD_SOCK' "$WORKDIR/recorder/argv.txt"; then
  fail "live broker readiness did not yield a clipboard coordinate"
fi
TESTS_RUN=$((TESTS_RUN + 1))
if awk -v dummy="$DUMMY_SOCK" '/^TMUX$/{getline; if (index($0, dummy)) found=1} END{exit !found}' "$WORKDIR/recorder/argv.txt"; then
  fail "sandbox TMUX value leaked the inherited host socket path"
fi
# The foreground run is over: the broker and its private dir must be gone.
assert_absent "normal launcher exit removed the private launch directory" \
  "$(find "$WORKDIR/home/rt" -maxdepth 1 -name 'yolo-clip.*' -print -quit 2>/dev/null || echo /nonexistent)"
if pgrep -f "yolo-clipboard-proxy broker.*$WORKDIR" >/dev/null 2>&1; then
  TESTS_RUN=$((TESTS_RUN + 1))
  fail "normal launcher exit left a broker alive"
  pkill -f "yolo-clipboard-proxy broker.*$WORKDIR" || true
fi

# Exited child: the broker dies before readiness; yolo fails closed (blank
# TMUX, no broker, no dir) but still launches.
YOLO_PROXY_UNDER_TEST="$BIN/fake-proxy-exited" run_yolo bwrap-record cmd true 2> "$WORKDIR/stderr.exited"
assert_ok "exited-child launch still completes (fail-closed clipboard)" "$?"
TESTS_RUN=$((TESTS_RUN + 1))
if ! grep -q "broker exited before becoming ready" "$WORKDIR/stderr.exited"; then
  fail "exited-child readiness state not distinguished in diagnostics"
fi
TESTS_RUN=$((TESTS_RUN + 1))
if ! awk '/^TMUX$/{getline; if ($0 == "") found=1} END{exit !found}' "$WORKDIR/recorder/argv.txt"; then
  fail "exited-child launch did not blank the sandbox TMUX"
fi
assert_absent "exited-child leaves no private launch directory" \
  "$(find "$WORKDIR/home/rt" -maxdepth 1 -name 'yolo-clip.*' -print -quit 2>/dev/null || echo /nonexistent)"

# Stale socket: a socket file exists but nothing accepts; readiness times out
# with the stale-socket diagnostic and the wedged child is terminated+reaped.
YOLO_PROXY_UNDER_TEST="$BIN/fake-proxy-stale" run_yolo bwrap-record cmd true 2> "$WORKDIR/stderr.stale"
assert_ok "stale-socket launch still completes (fail-closed clipboard)" "$?"
TESTS_RUN=$((TESTS_RUN + 1))
if ! grep -q "never accepted a connection" "$WORKDIR/stderr.stale"; then
  fail "stale-socket readiness state not distinguished in diagnostics"
fi
if [[ -s "$WORKDIR/stale.pid" ]]; then
  assert_no_process "timeout terminated and reaped the wedged broker" "$(< "$WORKDIR/stale.pid")"
fi
assert_absent "stale-socket timeout leaves no private launch directory" \
  "$(find "$WORKDIR/home/rt" -maxdepth 1 -name 'yolo-clip.*' -print -quit 2>/dev/null || echo /nonexistent)"

# Background form: the function body execs yolo directly, so `$!` IS the
# yolo.sh process and TERM/KILL reach its traps (an extra subshell layer
# would eat the signal and defer cleanup past the assertions).
run_yolo_bg() {
  local flavor="$1"
  shift
  rm -f "$WORKDIR/recorder/argv.txt"
  mkdir -p "$WORKDIR/recorder" "$WORKDIR/home/rt"
  cp "$BIN/$flavor" "$BIN/bwrap"
  chmod +x "$BIN/bwrap"
  cd "$WORKDIR" || exit 1
  exec env -i \
    PATH="$BIN:$PATH" \
    HOME="$WORKDIR/home" \
    RECORDER_DIR="$WORKDIR/recorder" \
    XDG_RUNTIME_DIR="$WORKDIR/home/rt" \
    YOLO_LLM_SANDBOX="$SANDBOX_SCRIPT" \
    YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
    YOLO_NIX_LD="$(command -v true)" \
    YOLO_JQ="$BIN/jq" \
    YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
    YOLO_CLIPBOARD_PROXY="${YOLO_PROXY_UNDER_TEST:-$PROXY}" \
    YOLO_TMUX="$(command -v true)" \
    TMUX="$DUMMY_SOCK,0,0" \
    bash "$SCRIPT_DIR/yolo.sh" "$@"
}

# Repeated signaled launcher exits (TERM): production traps route through
# cleanup; nothing broker- or filesystem-side survives, across rounds.
for round in 1 2 3; do
  run_yolo_bg bwrap-sleep cmd true &
  yolo_pid=$!
  for _ in $(seq 1 150); do
    [[ -s "$WORKDIR/recorder/argv.txt" ]] && break
    sleep 0.02
  done
  kill -TERM "$yolo_pid"
  wait "$yolo_pid"
  yolo_status=$?
  pkill -f 'sleep 300' 2>/dev/null || true
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ $yolo_status -ne 143 ]]; then
    fail "round $round: signaled launcher did not exit 143 (got $yolo_status)"
  fi
  assert_absent "round $round: signaled launcher removed the private launch directory" \
    "$(find "$WORKDIR/home/rt" -maxdepth 1 -name 'yolo-clip.*' -print -quit 2>/dev/null || echo /nonexistent)"
  if pgrep -f "yolo-clipboard-proxy broker.*$WORKDIR" >/dev/null 2>&1; then
    TESTS_RUN=$((TESTS_RUN + 1))
    fail "round $round: signaled launcher left a broker alive"
    pkill -f "yolo-clipboard-proxy broker.*$WORKDIR" || true
  fi
done

# Non-clean parent death (SIGKILL) of the production launcher after readiness:
# the broker's own pdeathsig + handler must clean socket and directory.
run_yolo_bg bwrap-sleep cmd true &
yolo_pid=$!
for _ in $(seq 1 150); do
  [[ -s "$WORKDIR/recorder/argv.txt" ]] && break
  sleep 0.02
done
kill -KILL "$yolo_pid"
wait "$yolo_pid" 2>/dev/null
pkill -f 'sleep 300' 2>/dev/null || true
for _ in $(seq 1 150); do
  pgrep -f "yolo-clipboard-proxy broker.*$WORKDIR" >/dev/null 2>&1 || break
  sleep 0.02
done
TESTS_RUN=$((TESTS_RUN + 1))
if pgrep -f "yolo-clipboard-proxy broker.*$WORKDIR" >/dev/null 2>&1; then
  fail "SIGKILLed launcher left a broker alive (pdeathsig did not fire)"
  pkill -f "yolo-clipboard-proxy broker.*$WORKDIR" || true
fi
assert_absent "SIGKILLed launcher: broker removed its private launch directory" \
  "$(find "$WORKDIR/home/rt" -maxdepth 1 -name 'yolo-clip.*' -print -quit 2>/dev/null || echo /nonexistent)"

# Canary: nothing outside the private launch directory is touched.
mkdir -p "$WORKDIR/home/rt/canary-dir"
printf 'canary' > "$WORKDIR/home/rt/canary-dir/marker"
YOLO_PROXY_UNDER_TEST="$BIN/fake-proxy-exited" run_yolo bwrap-record cmd true >/dev/null 2>&1
assert_present "cleanup removes only the private launch directory" "$WORKDIR/home/rt/canary-dir/marker"

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN clipboard-proxy lifecycle tests failed" >&2
  exit 1
fi
echo "All $TESTS_RUN clipboard-proxy lifecycle tests passed"
