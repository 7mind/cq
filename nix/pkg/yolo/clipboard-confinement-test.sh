#!/usr/bin/env bash
# Raw-socket confinement suite for the yolo bubblewrap sandbox (defects:D262).
#
# Modes:
#   --expect-vulnerable <git-revision>
#       Fail-first inventory: prove the named revision exposes every bind
#       family to a harmless AF_UNIX sentinel. Uses no tmux process.
#   <built-proxy>
#       Positive suite (tasks:T1793): prove the FIXED sources confine the
#       inherited host tmux socket — lexical aliases, exact hard links and
#       bind-mounted ancestor aliases, in source-equals-destination and
#       explicit SRC,DST forms — while preserving covering mounts, their
#       harmless siblings, and their ro/rw/dev semantics, and while clipboard
#       bytes round-trip through the dedicated broker socket only.
#
# Usage: bash clipboard-confinement-test.sh [--expect-vulnerable <git-revision> | <built-proxy>]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
_bash_path="$(command -v bash)"
_python_path="$(command -v python3)"
TARGET_REV="HEAD"
EXPECT_VULNERABLE=0
PROXY_BIN=""

if [[ $# -gt 0 ]]; then
  if [[ $# -eq 2 && "$1" == "--expect-vulnerable" ]]; then
    EXPECT_VULNERABLE=1
    TARGET_REV="$2"
  elif [[ $# -eq 1 && "$1" != --* ]]; then
    PROXY_BIN="$1"
  else
    echo "usage: $0 [--expect-vulnerable <git-revision> | <built-proxy>]" >&2
    exit 64
  fi
fi
if [[ $EXPECT_VULNERABLE -eq 0 ]]; then
  if [[ -z "$PROXY_BIN" || ! -x "$PROXY_BIN" ]]; then
    echo "usage: $0 [--expect-vulnerable <git-revision> | <built-proxy>] (proxy must be executable)" >&2
    exit 64
  fi
  PROXY_BIN="$(realpath -- "$PROXY_BIN")"
  command -v unshare >/dev/null
fi

command -v git >/dev/null
command -v python3 >/dev/null
command -v jq >/dev/null

FAILURES=0
TESTS_RUN=0
# AF_UNIX path names cap at 108 bytes, so keep every fixture below a short,
# caller-independent temporary root.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cq-yolo.XXXXXX")"
FAKE_HOME="$WORKDIR/home"
PROJECT_DIR="$WORKDIR/project"
FAKE_BIN="$WORKDIR/bin"
RECORDER_DIR="$WORKDIR/recorder"
TARGET_DIR="$WORKDIR/target"
XDG_STATE_DIR="$WORKDIR/xdg-state"
SOCKET_LEAF="sentinel-$$.sock"
SIBLING_LEAF="sibling-$SOCKET_LEAF"
EXCHANGE_DIR="/tmp/exchange"
EXCHANGE_SOCKET="$EXCHANGE_DIR/$SOCKET_LEAF"
EXCHANGE_DIR_CREATED=0
SENTINEL_PID=""
PROTECTED_PID=""
RT_BROKER_PID=""

cleanup() {
  if [[ -n "$SENTINEL_PID" ]]; then
    kill "$SENTINEL_PID" 2>/dev/null || true
    wait "$SENTINEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$PROTECTED_PID" ]]; then
    kill "$PROTECTED_PID" 2>/dev/null || true
    wait "$PROTECTED_PID" 2>/dev/null || true
  fi
  if [[ -n "$RT_BROKER_PID" ]]; then
    kill "$RT_BROKER_PID" 2>/dev/null || true
    wait "$RT_BROKER_PID" 2>/dev/null || true
  fi
  rm -f "$EXCHANGE_SOCKET"
  if [[ $EXCHANGE_DIR_CREATED -eq 1 ]]; then
    rmdir "$EXCHANGE_DIR" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

assert_true() {
  local description="$1"
  shift
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! "$@"; then
    fail "$description"
  fi
}

assert_source_contains() {
  local description="$1" file="$2" pattern="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! rg -q --fixed-strings -- "$pattern" "$file"; then
    fail "$description (missing $pattern)"
  fi
}

assert_excluded_source() {
  local description="$1" path="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ ! -e "$path" ]]; then
    fail "$description ($path is absent)"
    return
  fi
  # The precondition is environmental: this path must be outside the current
  # identity's control.  Where the identity CAN write (e.g. root inside the
  # Nix build sandbox, or a nixbld member), the exclusion is unevaluable here
  # and the family is skipped with an explicit diagnostic rather than a false
  # claim or a false failure.
  if [[ -w "$path" ]]; then
    echo "note: $description: $path is writable by this identity; exclusion precondition unevaluable, skipping" >&2
    return
  fi
}

# The test takes the production scripts from the requested revision.  This
# makes --expect-vulnerable a real fail-first check instead of a claim about a
# hand-maintained copy of an older launcher.  HEAD in a store layout (no git
# objects, e.g. the Nix check) reads the checked-out copies directly.
mkdir -p "$TARGET_DIR"
if [[ "$TARGET_REV" == "HEAD" ]] && ! git show "HEAD:nix/pkg/yolo/yolo.sh" >/dev/null 2>&1; then
  cp "$SCRIPT_DIR/yolo.sh" "$TARGET_DIR/yolo.sh"
  cp "$SCRIPT_DIR/llm-sandbox.sh" "$TARGET_DIR/llm-sandbox.sh"
  cp "$SCRIPT_DIR/custom-prompt.sh" "$TARGET_DIR/custom-prompt.sh"
else
  git show "$TARGET_REV:nix/pkg/yolo/yolo.sh" > "$TARGET_DIR/yolo.sh"
  git show "$TARGET_REV:nix/pkg/yolo/llm-sandbox.sh" > "$TARGET_DIR/llm-sandbox.sh"
  git show "$TARGET_REV:nix/pkg/yolo/custom-prompt.sh" > "$TARGET_DIR/custom-prompt.sh"
fi
# Pure Nix build sandboxes lack /usr/bin/env; rewrite the shebang yolo execs.
sed -i "1s|^#!/usr/bin/env bash|#!$_bash_path|" "$TARGET_DIR/llm-sandbox.sh"
chmod +x "$TARGET_DIR/yolo.sh" "$TARGET_DIR/llm-sandbox.sh"

# Exclusions must have repository-backed preconditions.  Generated files have
# no caller-controlled pathname; system sources come from immutable/root-owned
# locations.  A user-supplied loader deliberately remains a probe target below.
assert_source_contains "secret bind uses a generated temporary file" "$TARGET_DIR/yolo.sh" 'SECRET_TMPFILE="$(mktemp'
assert_source_contains "sandbox hook bind uses a generated temporary file" "$TARGET_DIR/yolo.sh" 'SANDBOX_HOOKS_TMPFILE="$(mktemp'
assert_source_contains "ssh config bind uses a generated temporary file" "$TARGET_DIR/yolo.sh" 'SSH_CONFIG_TMPFILE="$(mktemp'
assert_source_contains "clipboard proxy bind uses a generated temporary directory" "$TARGET_DIR/yolo.sh" 'CLIP_PROXY_DIR="$(mktemp -d'
assert_source_contains "llm sandbox declares its system source inventory" "$TARGET_DIR/llm-sandbox.sh" 'SYSTEM_RO_PATHS=('
for fixed_source in \
  /nix/store /nix/var /etc /bin /usr /run/current-system /run/wrappers \
  /run/systemd/resolve /run/nscd; do
  if [[ -e "$fixed_source" ]]; then
    assert_excluded_source "fixed Nix/system exclusion is root-owned or immutable" "$fixed_source"
  fi
done

mkdir -p "$FAKE_HOME" "$PROJECT_DIR" "$FAKE_BIN" "$RECORDER_DIR" "$TARGET_DIR" "$XDG_STATE_DIR"

# A strict recorder: argv and stdin use unsigned 64-bit length-prefixed frames.
# It connects to a socket only when that socket appears below a source actually
# handed to bwrap; it never interprets, starts, or controls a tmux
# server/session/window/pane/run-shell command.  Beyond the T1792 connection
# ledger it also records every bind triple (binds.tsv), classifies a covered
# candidate as masked when a LATER --ro-bind /dev/null entry covers its
# projected destination (masked.tsv), and captures the live YOLO_CLIPBOARD_SOCK
# / TMUX coordinates plus broker socket/dir modes during the launch.
cat > "$FAKE_BIN/bwrap" <<EOF
#!$_bash_path
set -euo pipefail
: "\${RECORDER_DIR:?}"
"$_python_path" -c 'import struct, sys; out = open(sys.argv[1], "wb"); [out.write(struct.pack("!Q", len(a.encode())) + a.encode()) for a in sys.argv[2:]]' "\$RECORDER_DIR/argv.frames" "\$@"
stdin_raw="\$RECORDER_DIR/.stdin.raw"
cat > "\$stdin_raw"
"$_python_path" -c 'import struct, sys; data = open(sys.argv[1], "rb").read(); open(sys.argv[2], "wb").write(struct.pack("!Q", len(data)) + data)' "\$stdin_raw" "\$RECORDER_DIR/stdin.frame"
rm -f "\$stdin_raw"
"$_python_path" - "\$RECORDER_DIR/argv.frames" "\$RECORDER_DIR/connections.tsv" "\$RECORDER_DIR/masked.tsv" "\$RECORDER_DIR/binds.tsv" "$SOCKET_LEAF" "$SIBLING_LEAF" <<'PY'
import os
import socket
import stat as statmod
import struct
import sys

raw = memoryview(open(sys.argv[1], 'rb').read())
argv = []
offset = 0
while offset < len(raw):
    if len(raw) - offset < 8:
        raise RuntimeError('truncated argv frame length')
    length, = struct.unpack('!Q', raw[offset:offset + 8])
    offset += 8
    if len(raw) - offset < length:
        raise RuntimeError('truncated argv frame payload')
    argv.append(bytes(raw[offset:offset + length]))
    offset += length
connections = open(sys.argv[2], 'a', encoding='utf-8')
masked = open(sys.argv[3], 'a', encoding='utf-8')
binds = open(sys.argv[4], 'a', encoding='utf-8')
socket_leaf = sys.argv[5]
sibling_leaf = sys.argv[6]

BIND_FORMS = (b'--bind', b'--ro-bind', b'--dev-bind')
entries = []  # (opt, src, dst) for every bind triple in order
setenvs = {}
i = 0
while i < len(argv):
    value = argv[i]
    if value in BIND_FORMS and i + 2 < len(argv):
        opt = os.fsdecode(argv[i])
        src = os.fsdecode(argv[i + 1])
        dst = os.fsdecode(argv[i + 2])
        entries.append((opt, src, dst))
        binds.write(f'{opt}\t{src}\t{dst}\n')
        binds.flush()
        i += 3
    elif value == b'--setenv' and i + 2 < len(argv):
        setenvs[os.fsdecode(argv[i + 1])] = os.fsdecode(argv[i + 2])
        i += 3
    else:
        i += 1

# Capture the live clipboard coordinates and broker socket/dir modes during
# the launch window (yolo removes them on exit, so only this moment exists).
clip_sock = setenvs.get('YOLO_CLIPBOARD_SOCK')
if clip_sock:
    try:
        sock_mode = statmod.S_IMODE(os.stat(clip_sock).st_mode)
        dir_mode = statmod.S_IMODE(os.stat(os.path.dirname(clip_sock)).st_mode)
        with open(os.path.join(os.path.dirname(sys.argv[2]), 'broker-modes.tsv'), 'a', encoding='utf-8') as modes:
            modes.write(f'{sock_mode:o}\t{dir_mode:o}\t{clip_sock}\n')
    except OSError:
        pass
tmux_env = setenvs.get('TMUX')
if tmux_env is not None:
    with open(os.path.join(os.path.dirname(sys.argv[2]), 'tmux-env.txt'), 'a', encoding='utf-8') as envf:
        envf.write((tmux_env if tmux_env else '<empty>') + '\n')

for index, (opt, src, dst) in enumerate(entries):
    if src == '/dev/null':
        continue
    candidates = [(src, dst)]
    if os.path.isdir(src):
        candidates.append((os.path.join(src, socket_leaf), os.path.normpath(os.path.join(dst, socket_leaf))))
        candidates.append((os.path.join(src, sibling_leaf), os.path.normpath(os.path.join(dst, sibling_leaf))))
    for candidate, projected in candidates:
        if not os.path.exists(candidate):
            continue
        try:
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(1)
            probe.connect(candidate)
            probe.close()
        except OSError:
            continue
        projected = os.path.normpath(projected)
        is_masked = False
        for later_opt, later_src, later_dst in entries[index + 1:]:
            if later_src == '/dev/null' and os.path.normpath(later_dst) == projected:
                is_masked = True
                break
        out = masked if is_masked else connections
        out.write(f'{candidate}\t{projected}\n')
        out.flush()
PY
EOF
chmod +x "$FAKE_BIN/bwrap"

# Put a denying recorder ahead of any host tmux binary.  Any launcher attempt
# becomes an observable test failure and cannot reach host tmux authority.
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${RECORDER_DIR:?}"
printf '%s\n' "$*" >> "$RECORDER_DIR/tmux-invocations"
exit 97
EOF
chmod +x "$FAKE_BIN/tmux"

# Activate the vulnerable baseline clipboard-broker branch without running
# tmux.  The fake broker exposes only sentinel symlinks and records its
# generated bind directory so the exact source and destination can be asserted
# below.  (Positive mode drives the real proxy binary instead.)
cat > "$FAKE_BIN/clipboard-proxy" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${RECORDER_DIR:?}"
: "${SENTINEL_SOCKET:?}"
: "${SOCKET_LEAF:?}"
[[ "${1:-}" == "broker" ]]
shift
listen=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --listen) listen="$2"; shift 2 ;;
    --tmux-socket|--tmux) shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -n "$listen" ]]
proxy_dir="$(dirname -- "$listen")"
printf '%s\n' "$proxy_dir" > "$RECORDER_DIR/clip-proxy-dir"
ln -s "$SENTINEL_SOCKET" "$listen"
ln -s "$SENTINEL_SOCKET" "$proxy_dir/$SOCKET_LEAF"
exec python3 -c 'import signal; signal.pause()'
EOF
chmod +x "$FAKE_BIN/clipboard-proxy"

# Establish a bind-mounted alias of a directory inside a private user+mount
# namespace, then exec the wrapped command.  Used by the mount-alias cases.
cat > "$FAKE_BIN/bindmount-run" <<EOF
#!$_bash_path
set -euo pipefail
mount --bind "\$1" "\$2"
shift 2
exec "\$@"
EOF
chmod +x "$FAKE_BIN/bindmount-run"

# The listener records only connection metadata (the kernel peer credentials),
# not bytes from a privileged protocol.  All harmless fixture sockets point at
# this one Unix-domain sentinel.
SENTINEL_SOCKET="$WORKDIR/s.sock"
"$_python_path" - "$SENTINEL_SOCKET" "$RECORDER_DIR/peers.tsv" <<'PY' &
import os
import socket
import struct
import sys

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(sys.argv[1])
sock.listen()
with open(sys.argv[2], 'a', encoding='utf-8') as peers:
    while True:
        connection, _ = sock.accept()
        try:
            credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            pid, uid, gid = struct.unpack('3i', credentials)
            peers.write(f'{pid}\t{uid}\t{gid}\n')
            peers.flush()
        finally:
            connection.close()
PY
SENTINEL_PID=$!
for _ in $(seq 1 50); do [[ -S "$SENTINEL_SOCKET" ]] && break; sleep 0.02; done
[[ -S "$SENTINEL_SOCKET" ]]

socket_at() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  rm -f "$path"
  ln -s "$SENTINEL_SOCKET" "$path"
}

socket_in() { socket_at "$1/$SOCKET_LEAF"; }

if [[ ! -d "$EXCHANGE_DIR" ]]; then
  mkdir -p "$EXCHANGE_DIR"
  EXCHANGE_DIR_CREATED=1
fi
socket_at "$EXCHANGE_SOCKET"

# User-writable/configurable source inventory.  Each directory source contains
# a socket leaf; direct socket sources use the sentinel itself.  The projected
# destination appears in connections.tsv, so both inherited and remapped paths
# are observable without giving the test any host-control authority.
socket_in "$PROJECT_DIR"
for directory in \
  "$FAKE_HOME/.cache" \
  "$FAKE_HOME/.ivy2" \
  "$FAKE_HOME/.local/state/cq" \
  "$XDG_STATE_DIR/cq" \
  "$FAKE_HOME/adhoc-ro" \
  "$FAKE_HOME/adhoc-rw" \
  "$FAKE_HOME/configured-ro" \
  "$FAKE_HOME/configured-rw" \
  "$FAKE_HOME/device" \
  "$FAKE_HOME/.config/git" \
  "$FAKE_HOME/.config/direnv" \
  "$FAKE_HOME/.local/share/direnv" \
  "$FAKE_HOME/.config/mcp" \
  "$FAKE_HOME/.claude" \
  "$FAKE_HOME/.config/claude" \
  "$FAKE_HOME/.codex" \
  "$FAKE_HOME/.config/codex" \
  "$FAKE_HOME/.pi" \
  "$FAKE_HOME/.config/fish" \
  "$FAKE_HOME/zdotdir"; do
  socket_in "$directory"
done

RAW_BIND_SRC="$FAKE_HOME/raw-bind-src"
RAW_RO_BIND_SRC="$FAKE_HOME/raw-ro-bind-src"
RAW_DEV_BIND_SRC="$FAKE_HOME/raw-dev-bind-src"
RAW_BIND_DST="$FAKE_HOME/raw-bind-dst"
RAW_RO_BIND_DST="$FAKE_HOME/raw-ro-bind-dst"
RAW_DEV_BIND_DST="$FAKE_HOME/raw-dev-bind-dst"
socket_in "$RAW_BIND_SRC"
socket_in "$RAW_RO_BIND_SRC"
socket_in "$RAW_DEV_BIND_SRC"

for leaf in \
  .direnvrc .zshrc .zshenv .zprofile .zlogin .zlogout \
  .bashrc .bash_profile .bash_login .profile .inputrc \
  .claude.json .config/pulse/cookie; do
  socket_at "$FAKE_HOME/$leaf"
done

# Named profiles and read-only re-shares have different sources and projected
# destinations.  Seed ordinary config files that yolo itself parses/copies.
printf 'model = "test"\n' > "$FAKE_HOME/.codex/config.toml"
for profile_agent in claude codex pi; do
  socket_in "$FAKE_HOME/.config/yolo/overlap/$profile_agent/home"
  socket_in "$FAKE_HOME/.config/yolo/overlap/$profile_agent/config"
done
for leaf in \
  .claude/skills .claude/plugins .claude/commands .claude/agents \
  .claude/settings.json .claude/CLAUDE.md \
  .codex/AGENTS.md .codex/prompts .codex/skills \
  .pi/agent/settings.json .pi/agent/AGENTS.md .pi/agent/APPEND_SYSTEM.md \
  .pi/agent/cq-agents .pi/agent/prompts .pi/agent/skills \
  .pi/agent/extensions .pi/agent/mcp.json; do
  socket_at "$FAKE_HOME/$leaf"
done

# Configurable raw sockets, including a deliberately user-controlled nix-ld
# source.  That fixture prevents an accidental broad "loader is trusted"
# exclusion from hiding a caller-controlled path.
PODMAN_SOCKET="$FAKE_HOME/podman.sock"
PIPEWIRE_SOCKET="$FAKE_HOME/runtime/pipewire-0"
PULSE_SOCKET="$FAKE_HOME/runtime/pulse/native"
LOADER_SOCKET="$FAKE_HOME/user-nix-ld.sock"
HOST_TMUX_SOCKET="$FAKE_HOME/host-tmux.sock"
for socket_path in "$PODMAN_SOCKET" "$PIPEWIRE_SOCKET" "$PULSE_SOCKET" "$LOADER_SOCKET" "$HOST_TMUX_SOCKET"; do
  socket_at "$socket_path"
done

# --- Positive-mode fixtures: the protected inherited tmux socket and its
# alias matrix.  The protected socket is a REAL second listener, never a
# symlink: a symlink would canonicalize outside its directory and defeat the
# ancestor fixtures.  The harness never asserts on its peer log — only on
# where the recorder could (masked.tsv) or could not (connections.tsv) reach
# it through the final bind set.
PROTECTED_DIR="$FAKE_HOME/tmux-1000"
PROTECTED_SOCK="$PROTECTED_DIR/$SOCKET_LEAF"
if [[ $EXPECT_VULNERABLE -eq 0 ]]; then
  mkdir -p "$PROTECTED_DIR"
  "$_python_path" - "$PROTECTED_SOCK" "$RECORDER_DIR/protected-peers.tsv" <<'PY' &
import socket
import struct
import sys

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(sys.argv[1])
sock.listen()
with open(sys.argv[2], 'a', encoding='utf-8') as peers:
    while True:
        connection, _ = sock.accept()
        try:
            credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            pid, uid, gid = struct.unpack('3i', credentials)
            peers.write(f'{pid}\t{uid}\t{gid}\n')
            peers.flush()
        finally:
            connection.close()
PY
  PROTECTED_PID=$!
  for _ in $(seq 1 50); do [[ -S "$PROTECTED_SOCK" ]] && break; sleep 0.02; done
  [[ -S "$PROTECTED_SOCK" ]]

  # A harmless sibling sharing the protected directory: confinement must mask
  # only the projected socket and keep this sibling reachable.
  socket_at "$PROTECTED_DIR/$SIBLING_LEAF"

  # Lexical alias of the protected directory (symlink), the mount-alias
  # destination, and an exact hard link to the listening socket.
  ln -s "$PROTECTED_DIR" "$FAKE_HOME/tmux-alias-link"
  mkdir -p "$FAKE_HOME/mnt-alias"
  ln "$PROTECTED_SOCK" "$FAKE_HOME/hardlink-$SOCKET_LEAF"
fi

RUN_PREFIX=()
run_yolo() {
  local _proxy="$FAKE_BIN/clipboard-proxy" _tmux_env="$HOST_TMUX_SOCKET,0,0"
  if [[ $EXPECT_VULNERABLE -eq 0 ]]; then
    _proxy="$PROXY_BIN"
    _tmux_env="$PROTECTED_SOCK,4242,0"
  fi
  (
    cd "$PROJECT_DIR"
    PATH="$FAKE_BIN:$PATH" \
      RECORDER_DIR="$RECORDER_DIR" \
      HOME="$FAKE_HOME" \
      XDG_STATE_HOME="${CQ_TEST_XDG_STATE_HOME-$XDG_STATE_DIR}" \
      XDG_RUNTIME_DIR="$FAKE_HOME/runtime" \
      ZDOTDIR="$FAKE_HOME/zdotdir" \
      YOLO_LLM_SANDBOX="$TARGET_DIR/llm-sandbox.sh" \
      YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
      YOLO_NIX_LD="$LOADER_SOCKET" \
      YOLO_JQ="$(command -v jq)" \
      YOLO_CUSTOM_PROMPT="$TARGET_DIR/custom-prompt.sh" \
      YOLO_PODMAN_SOCKET_PATH="$PODMAN_SOCKET" \
      YOLO_PODMAN_SOCKET_URI="unix://$PODMAN_SOCKET" \
      YOLO_EXTRA_RO_PATHS="$FAKE_HOME/configured-ro" \
      YOLO_EXTRA_RW_PATHS="$FAKE_HOME/configured-rw" \
      YOLO_EXTRA_DEV_PATHS="$FAKE_HOME/device"$'\t'"gpu" \
      YOLO_CLIPBOARD_PROXY="$_proxy" \
      YOLO_TMUX="$FAKE_BIN/tmux" \
      SENTINEL_SOCKET="$SENTINEL_SOCKET" \
      SOCKET_LEAF="$SOCKET_LEAF" \
      TMUX="$_tmux_env" \
      "${RUN_PREFIX[@]}" \
      bash "$TARGET_DIR/yolo.sh" "$@"
  )
}

run_sandbox() {
  local -a _args=()
  if [[ $EXPECT_VULNERABLE -eq 0 ]]; then
    _args+=(--confine-socket "$PROTECTED_SOCK")
  fi
  (
    cd "$PROJECT_DIR"
    env PATH="$FAKE_BIN:$PATH" RECORDER_DIR="$RECORDER_DIR" \
      "${RUN_PREFIX[@]}" \
      bash "$TARGET_DIR/llm-sandbox.sh" "${_args[@]}" "$@"
  )
}

rm -f "$RECORDER_DIR/argv.frames" "$RECORDER_DIR/stdin.frame" "$RECORDER_DIR/connections.tsv" "$RECORDER_DIR/masked.tsv" "$RECORDER_DIR/binds.tsv"
run_yolo cmd true
socket_at "$FAKE_HOME/.config/yolo/overlap/claude/home.json"
run_yolo --profile overlap --ro "$FAKE_HOME/adhoc-ro" --rw "$FAKE_HOME/adhoc-rw" cmd true
CQ_TEST_XDG_STATE_HOME="" run_yolo cmd true

# Exercise llm-sandbox's explicit remapping forms independently of yolo's
# same-path convenience options.
run_sandbox \
  --bind "$RAW_BIND_SRC,$RAW_BIND_DST" \
  --ro-bind "$RAW_RO_BIND_SRC,$RAW_RO_BIND_DST" \
  --dev-bind "$RAW_DEV_BIND_SRC,$RAW_DEV_BIND_DST" \
  -- true

# Shell-specific producers: execute the launcher for every supported shell
# name.  The recorder exits before the command, so these fixtures never start
# an interactive shell.
for shell_name in zsh bash fish; do
  shell_path="$FAKE_BIN/$shell_name"
  ln -sf "$_bash_path" "$shell_path"
  SHELL="$shell_path" run_yolo shell -c true
done

if [[ ! -s "$RECORDER_DIR/argv.frames" ]]; then
  fail "strict argv recorder received no bwrap invocation"
fi
if [[ ! -f "$RECORDER_DIR/stdin.frame" ]]; then
  fail "strict stdin recorder did not run"
fi
if [[ ! -s "$RECORDER_DIR/connections.tsv" ]]; then
  fail "no raw socket bind reached the harmless sentinel"
fi
if [[ ! -s "$RECORDER_DIR/peers.tsv" ]]; then
  fail "sentinel observed no direct connection"
fi
if [[ -e "$RECORDER_DIR/tmux-invocations" ]]; then
  fail "launcher invoked tmux: $(tr '\n' ' ' < "$RECORDER_DIR/tmux-invocations")"
fi

CLIP_PROXY_BOUND_DIR="$WORKDIR/missing-clip-proxy-dir"
if [[ $EXPECT_VULNERABLE -eq 1 ]]; then
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ ! -s "$RECORDER_DIR/clip-proxy-dir" ]]; then
    fail "clipboard proxy did not record its generated bind directory"
  else
    CLIP_PROXY_BOUND_DIR="$(< "$RECORDER_DIR/clip-proxy-dir")"
  fi
fi

required_labels=(
  exchange project cache ivy xdg-cq-state fallback-cq-state adhoc-ro adhoc-rw
  configured-ro configured-rw clipboard-proxy raw-bind raw-ro-bind raw-dev-bind podman pipewire
  pulse pulse-cookie device git direnv direnv-share direnvrc mcp claude-default
  claude-json-default claude-config codex-default codex-config pi-default
  profile-claude-home profile-claude-json profile-claude-config
  profile-codex-home profile-codex-config profile-pi-home
  claude-reshare-skills claude-reshare-plugins claude-reshare-commands
  claude-reshare-agents claude-reshare-settings claude-reshare-instructions
  codex-reshare-instructions codex-reshare-prompts codex-reshare-skills
  pi-reshare-settings pi-reshare-instructions pi-reshare-append-system
  pi-reshare-agents pi-reshare-prompts pi-reshare-skills pi-reshare-extensions
  pi-reshare-mcp zshrc zshenv zprofile zlogin zlogout bashrc bash-profile
  bash-login profile inputrc fish-config zdotdir user-controlled-nix-loader
)
required_sources=(
  "$EXCHANGE_SOCKET" "$PROJECT_DIR/$SOCKET_LEAF" "$FAKE_HOME/.cache/$SOCKET_LEAF"
  "$FAKE_HOME/.ivy2/$SOCKET_LEAF" "$XDG_STATE_DIR/cq/$SOCKET_LEAF"
  "$FAKE_HOME/.local/state/cq/$SOCKET_LEAF" "$FAKE_HOME/adhoc-ro/$SOCKET_LEAF"
  "$FAKE_HOME/adhoc-rw/$SOCKET_LEAF" "$FAKE_HOME/configured-ro/$SOCKET_LEAF"
  "$FAKE_HOME/configured-rw/$SOCKET_LEAF" "$CLIP_PROXY_BOUND_DIR/$SOCKET_LEAF"
  "$RAW_BIND_SRC/$SOCKET_LEAF"
  "$RAW_RO_BIND_SRC/$SOCKET_LEAF" "$RAW_DEV_BIND_SRC/$SOCKET_LEAF"
  "$PODMAN_SOCKET" "$PIPEWIRE_SOCKET" "$PULSE_SOCKET"
  "$FAKE_HOME/.config/pulse/cookie" "$FAKE_HOME/device/$SOCKET_LEAF"
  "$FAKE_HOME/.config/git/$SOCKET_LEAF" "$FAKE_HOME/.config/direnv/$SOCKET_LEAF"
  "$FAKE_HOME/.local/share/direnv/$SOCKET_LEAF" "$FAKE_HOME/.direnvrc"
  "$FAKE_HOME/.config/mcp/$SOCKET_LEAF" "$FAKE_HOME/.claude/$SOCKET_LEAF"
  "$FAKE_HOME/.claude.json" "$FAKE_HOME/.config/claude/$SOCKET_LEAF"
  "$FAKE_HOME/.codex/$SOCKET_LEAF" "$FAKE_HOME/.config/codex/$SOCKET_LEAF"
  "$FAKE_HOME/.pi/$SOCKET_LEAF"
  "$FAKE_HOME/.config/yolo/overlap/claude/home/$SOCKET_LEAF"
  "$FAKE_HOME/.config/yolo/overlap/claude/home.json"
  "$FAKE_HOME/.config/yolo/overlap/claude/config/$SOCKET_LEAF"
  "$FAKE_HOME/.config/yolo/overlap/codex/home/$SOCKET_LEAF"
  "$FAKE_HOME/.config/yolo/overlap/codex/config/$SOCKET_LEAF"
  "$FAKE_HOME/.config/yolo/overlap/pi/home/$SOCKET_LEAF"
  "$FAKE_HOME/.claude/skills" "$FAKE_HOME/.claude/plugins"
  "$FAKE_HOME/.claude/commands" "$FAKE_HOME/.claude/agents"
  "$FAKE_HOME/.claude/settings.json" "$FAKE_HOME/.claude/CLAUDE.md"
  "$FAKE_HOME/.codex/AGENTS.md" "$FAKE_HOME/.codex/prompts"
  "$FAKE_HOME/.codex/skills" "$FAKE_HOME/.pi/agent/settings.json"
  "$FAKE_HOME/.pi/agent/AGENTS.md" "$FAKE_HOME/.pi/agent/APPEND_SYSTEM.md"
  "$FAKE_HOME/.pi/agent/cq-agents" "$FAKE_HOME/.pi/agent/prompts"
  "$FAKE_HOME/.pi/agent/skills" "$FAKE_HOME/.pi/agent/extensions"
  "$FAKE_HOME/.pi/agent/mcp.json" "$FAKE_HOME/.zshrc" "$FAKE_HOME/.zshenv"
  "$FAKE_HOME/.zprofile" "$FAKE_HOME/.zlogin" "$FAKE_HOME/.zlogout"
  "$FAKE_HOME/.bashrc" "$FAKE_HOME/.bash_profile" "$FAKE_HOME/.bash_login"
  "$FAKE_HOME/.profile" "$FAKE_HOME/.inputrc" "$FAKE_HOME/.config/fish/$SOCKET_LEAF"
  "$FAKE_HOME/zdotdir/$SOCKET_LEAF" "$LOADER_SOCKET"
)
required_destinations=(
  "$EXCHANGE_SOCKET" "$PROJECT_DIR/$SOCKET_LEAF" "$FAKE_HOME/.cache/$SOCKET_LEAF"
  "$FAKE_HOME/.ivy2/$SOCKET_LEAF" "$XDG_STATE_DIR/cq/$SOCKET_LEAF"
  "$FAKE_HOME/.local/state/cq/$SOCKET_LEAF" "$FAKE_HOME/adhoc-ro/$SOCKET_LEAF"
  "$FAKE_HOME/adhoc-rw/$SOCKET_LEAF" "$FAKE_HOME/configured-ro/$SOCKET_LEAF"
  "$FAKE_HOME/configured-rw/$SOCKET_LEAF" "$CLIP_PROXY_BOUND_DIR/$SOCKET_LEAF"
  "$RAW_BIND_DST/$SOCKET_LEAF"
  "$RAW_RO_BIND_DST/$SOCKET_LEAF" "$RAW_DEV_BIND_DST/$SOCKET_LEAF"
  "$PODMAN_SOCKET" "$PIPEWIRE_SOCKET" "$PULSE_SOCKET"
  "$FAKE_HOME/.config/pulse/cookie" "$FAKE_HOME/device/$SOCKET_LEAF"
  "$FAKE_HOME/.config/git/$SOCKET_LEAF" "$FAKE_HOME/.config/direnv/$SOCKET_LEAF"
  "$FAKE_HOME/.local/share/direnv/$SOCKET_LEAF" "$FAKE_HOME/.direnvrc"
  "$FAKE_HOME/.config/mcp/$SOCKET_LEAF" "$FAKE_HOME/.claude/$SOCKET_LEAF"
  "$FAKE_HOME/.claude.json" "$FAKE_HOME/.config/claude/$SOCKET_LEAF"
  "$FAKE_HOME/.codex/$SOCKET_LEAF" "$FAKE_HOME/.config/codex/$SOCKET_LEAF"
  "$FAKE_HOME/.pi/$SOCKET_LEAF" "$FAKE_HOME/.claude/$SOCKET_LEAF"
  "$FAKE_HOME/.claude.json" "$FAKE_HOME/.config/claude/$SOCKET_LEAF"
  "$FAKE_HOME/.codex/$SOCKET_LEAF" "$FAKE_HOME/.config/codex/$SOCKET_LEAF"
  "$FAKE_HOME/.pi/$SOCKET_LEAF"
  "$FAKE_HOME/.claude/skills" "$FAKE_HOME/.claude/plugins"
  "$FAKE_HOME/.claude/commands" "$FAKE_HOME/.claude/agents"
  "$FAKE_HOME/.claude/settings.json" "$FAKE_HOME/.claude/CLAUDE.md"
  "$FAKE_HOME/.codex/AGENTS.md" "$FAKE_HOME/.codex/prompts"
  "$FAKE_HOME/.codex/skills" "$FAKE_HOME/.pi/agent/settings.json"
  "$FAKE_HOME/.pi/agent/AGENTS.md" "$FAKE_HOME/.pi/agent/APPEND_SYSTEM.md"
  "$FAKE_HOME/.pi/agent/cq-agents" "$FAKE_HOME/.pi/agent/prompts"
  "$FAKE_HOME/.pi/agent/skills" "$FAKE_HOME/.pi/agent/extensions"
  "$FAKE_HOME/.pi/agent/mcp.json" "$FAKE_HOME/.zshrc" "$FAKE_HOME/.zshenv"
  "$FAKE_HOME/.zprofile" "$FAKE_HOME/.zlogin" "$FAKE_HOME/.zlogout"
  "$FAKE_HOME/.bashrc" "$FAKE_HOME/.bash_profile" "$FAKE_HOME/.bash_login"
  "$FAKE_HOME/.profile" "$FAKE_HOME/.inputrc" "$FAKE_HOME/.config/fish/$SOCKET_LEAF"
  "$FAKE_HOME/zdotdir/$SOCKET_LEAF" "/lib64/ld-linux-x86-64.so.2"
)

# In the positive suite the clipboard-proxy family is not a sentinel case:
# the real broker occupies its own dedicated socket (asserted separately via
# binds/modes/TMUX below).  Drop that one aligned entry from the inventory.
if [[ $EXPECT_VULNERABLE -eq 0 ]]; then
  kept_labels=() kept_sources=() kept_destinations=()
  for index in "${!required_labels[@]}"; do
    if [[ "${required_labels[$index]}" != "clipboard-proxy" ]]; then
      kept_labels+=("${required_labels[$index]}")
      kept_sources+=("${required_sources[$index]}")
      kept_destinations+=("${required_destinations[$index]}")
    fi
  done
  required_labels=("${kept_labels[@]}")
  required_sources=("${kept_sources[@]}")
  required_destinations=("${kept_destinations[@]}")
fi

for index in "${!required_labels[@]}"; do
  label="${required_labels[$index]}"
  source_path="${required_sources[$index]}"
  destination_path="${required_destinations[$index]}"
  expected_record="$source_path"$'\t'"$destination_path"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! grep -Fxq "$expected_record" "$RECORDER_DIR/connections.tsv"; then
    fail "$label did not produce a direct sentinel connection"
  else
    echo "VULNERABLE: $label $expected_record"
  fi
done

if [[ $EXPECT_VULNERABLE -eq 1 && $FAILURES -ne 0 ]]; then
  echo "expected vulnerable revision $TARGET_REV did not expose every inventoried bind" >&2
fi

# ---------------------------------------------------------------------------
# Positive suite (tasks:T1793): the inherited host tmux socket is confined
# under every alias form, covering mounts keep their siblings and semantics,
# and clipboard bytes round-trip only through the dedicated broker socket.
# ---------------------------------------------------------------------------
if [[ $EXPECT_VULNERABLE -eq 0 ]]; then
  # The default inventory invocations add no covering bind of the protected
  # directory, so nothing may be masked yet (no over-masking).
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ -s "$RECORDER_DIR/masked.tsv" ]]; then
    fail "default launch masked projections without any covering bind: $(cat "$RECORDER_DIR/masked.tsv")"
  fi

  # The raw tmux-directory capability is gone: no default bind may name the
  # protected socket or its directory.
  TESTS_RUN=$((TESTS_RUN + 1))
  if awk -F'\t' -v sock="$PROTECTED_SOCK" -v dir="$PROTECTED_DIR" \
      '$2 == sock || $2 == dir { found=1 } END { exit found ? 0 : 1 }' "$RECORDER_DIR/binds.tsv"; then
    fail "a default launch bind still names the protected tmux socket or its directory"
  fi

  # The dedicated broker coordinate is the only sandbox TMUX value, with
  # fixed non-host fields.
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ ! -s "$RECORDER_DIR/tmux-env.txt" ]]; then
    fail "no TMUX coordinate was recorded inside the sandbox"
  else
    while IFS= read -r tmux_value; do
      if [[ "$tmux_value" == "<empty>" ]]; then
        continue
      fi
      if [[ "$tmux_value" != "$FAKE_HOME/runtime/yolo-clip."*"/sock,0,0" ]]; then
        fail "sandbox TMUX is not the dedicated broker coordinate with fixed fields: $tmux_value"
      fi
      if [[ "$tmux_value" == *"$PROTECTED_SOCK"* || "$tmux_value" == *4242* ]]; then
        fail "sandbox TMUX leaks the host socket path or server PID: $tmux_value"
      fi
    done < "$RECORDER_DIR/tmux-env.txt"
  fi

  # The private launch directory is mode 0700 and the broker socket 0600.
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! awk -F'\t' '$1 == "600" && $2 == "700" { ok=1 } END { exit ok ? 0 : 1 }' \
      "$RECORDER_DIR/broker-modes.tsv" 2>/dev/null; then
    fail "broker socket is not mode 0600 inside a mode-0700 directory: $(cat "$RECORDER_DIR/broker-modes.tsv" 2>/dev/null)"
  fi

  # With no broker configured, TMUX stays blank rather than leaking the host
  # socket path or server PID.
  rm -f "$RECORDER_DIR/tmux-env.txt"
  run_yolo_no_proxy() {
    (
      cd "$PROJECT_DIR"
      PATH="$FAKE_BIN:$PATH" \
        RECORDER_DIR="$RECORDER_DIR" \
        HOME="$FAKE_HOME" \
        XDG_STATE_HOME="$XDG_STATE_DIR" \
        XDG_RUNTIME_DIR="$FAKE_HOME/runtime" \
        ZDOTDIR="$FAKE_HOME/zdotdir" \
        YOLO_LLM_SANDBOX="$TARGET_DIR/llm-sandbox.sh" \
        YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
        YOLO_NIX_LD="$LOADER_SOCKET" \
        YOLO_JQ="$(command -v jq)" \
        YOLO_CUSTOM_PROMPT="$TARGET_DIR/custom-prompt.sh" \
        TMUX="$PROTECTED_SOCK,4242,0" \
        bash "$TARGET_DIR/yolo.sh" cmd true
    )
  }
  run_yolo_no_proxy
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! grep -Fxq '<empty>' "$RECORDER_DIR/tmux-env.txt"; then
    fail "sandbox TMUX is not blank when no clipboard broker is configured"
  fi
  TESTS_RUN=$((TESTS_RUN + 1))
  if grep -q -e "$PROTECTED_SOCK" -e '4242' "$RECORDER_DIR/tmux-env.txt"; then
    fail "sandbox TMUX leaks the host socket path or server PID without a broker"
  fi

  # --- Alias matrix -------------------------------------------------------
  # reset_case clears the per-case ledgers; assert_covering_case then proves:
  # the covering bind keeps its type, the harmless sibling still connects at
  # the projected destination, the protected socket records zero direct
  # connections, and its projection is masked by a later /dev/null bind.
  reset_case() {
    : > "$RECORDER_DIR/connections.tsv"
    : > "$RECORDER_DIR/masked.tsv"
    : > "$RECORDER_DIR/binds.tsv"
  }

  # $1 label, $2 expected bind type, $3 sibling projection, $4 protected projection
  assert_covering_case() {
    local label="$1" opt="$2" sibling="$3" protected="$4"
    TESTS_RUN=$((TESTS_RUN + 1))
    if ! awk -F'\t' -v p="$sibling" '$2 == p { ok=1 } END { exit ok ? 0 : 1 }' "$RECORDER_DIR/connections.tsv"; then
      fail "$label: harmless sibling did not connect at $sibling"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    if awk -F'\t' -v p="$protected" '$2 == p { found=1 } END { exit found ? 0 : 1 }' "$RECORDER_DIR/connections.tsv"; then
      fail "$label: protected socket recorded a direct connection at $protected"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    if ! awk -F'\t' -v p="$protected" '$2 == p { ok=1 } END { exit ok ? 0 : 1 }' "$RECORDER_DIR/masked.tsv"; then
      fail "$label: protected socket projection is not masked at $protected"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    if ! awk -F'\t' -v p="$protected" '$1 == "--ro-bind" && $2 == "/dev/null" && $3 == p { ok=1 } END { exit ok ? 0 : 1 }' "$RECORDER_DIR/binds.tsv"; then
      fail "$label: no /dev/null mask bind for $protected"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    local cover_line mask_line
    cover_line="$(awk -F'\t' -v p="$protected" '$1 != "--ro-bind" || $2 != "/dev/null" { last=NR } END { print last+0 }' "$RECORDER_DIR/binds.tsv")"
    mask_line="$(awk -F'\t' -v p="$protected" '$1 == "--ro-bind" && $2 == "/dev/null" && $3 == p { print NR }' "$RECORDER_DIR/binds.tsv" | tail -1)"
    if [[ -z "$mask_line" || "$cover_line" -ge "$mask_line" ]]; then
      fail "$label: a later bind can re-expose $protected (cover at $cover_line, mask at $mask_line)"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    if ! awk -F'\t' -v o="$opt" '$1 == o { ok=1 } END { exit ok ? 0 : 1 }' "$RECORDER_DIR/binds.tsv"; then
      fail "$label: covering bind lost its $opt semantics"
    fi
  }

  # $1 label, $2 exact-socket source, $3 stderr capture
  assert_omission_case() {
    local label="$1" src="$2" stderr_file="$3"
    TESTS_RUN=$((TESTS_RUN + 1))
    if awk -F'\t' -v s="$src" '$2 == s { found=1 } END { exit found ? 0 : 1 }' "$RECORDER_DIR/binds.tsv"; then
      fail "$label: exact-socket bind $src was not omitted"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    if ! grep -Fq "omitting bind of confined tmux socket '$src'" "$stderr_file"; then
      fail "$label: no fail-visible omission diagnostic for $src"
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    if awk -F'\t' -v s="$src" '$1 == s { found=1 } END { exit found ? 0 : 1 }' "$RECORDER_DIR/connections.tsv" "$RECORDER_DIR/masked.tsv" 2>/dev/null; then
      fail "$label: exact-socket source $src still recorded a connection"
    fi
  }

  P_SIBLING="$PROTECTED_DIR/$SIBLING_LEAF"
  P_SOCK="$PROTECTED_SOCK"

  # 1. Direct ancestor, source-equals-destination and explicit SRC,DST.
  reset_case
  run_yolo --rw "$PROTECTED_DIR" cmd true
  assert_covering_case "ancestor src=dst" "--bind" "$P_SIBLING" "$P_SOCK"

  reset_case
  run_sandbox --bind "$PROTECTED_DIR,$FAKE_HOME/remapped-tmux" -- true
  assert_covering_case "ancestor SRC,DST" "--bind" \
    "$FAKE_HOME/remapped-tmux/$SIBLING_LEAF" "$FAKE_HOME/remapped-tmux/$SOCKET_LEAF"

  # 2. Symlink alias of the protected directory.
  reset_case
  run_yolo --rw "$FAKE_HOME/tmux-alias-link" cmd true
  assert_covering_case "symlink alias src=dst" "--bind" \
    "$FAKE_HOME/tmux-alias-link/$SIBLING_LEAF" "$FAKE_HOME/tmux-alias-link/$SOCKET_LEAF"

  reset_case
  run_sandbox --bind "$FAKE_HOME/tmux-alias-link,$FAKE_HOME/remapped-link" -- true
  assert_covering_case "symlink alias SRC,DST" "--bind" \
    "$FAKE_HOME/remapped-link/$SIBLING_LEAF" "$FAKE_HOME/remapped-link/$SOCKET_LEAF"

  # 3. '..' spelling (through an existing intermediate directory).
  reset_case
  run_yolo --rw "$FAKE_HOME/.cache/../tmux-1000" cmd true
  assert_covering_case "dotdot spelling src=dst" "--bind" "$P_SIBLING" "$P_SOCK"

  reset_case
  run_sandbox --bind "$FAKE_HOME/.cache/../tmux-1000,$FAKE_HOME/remapped-dotdot" -- true
  assert_covering_case "dotdot spelling SRC,DST" "--bind" \
    "$FAKE_HOME/remapped-dotdot/$SIBLING_LEAF" "$FAKE_HOME/remapped-dotdot/$SOCKET_LEAF"

  # 4. Redundant spelling (double slash).
  reset_case
  run_yolo --rw "$FAKE_HOME//tmux-1000" cmd true
  assert_covering_case "redundant spelling src=dst" "--bind" "$P_SIBLING" "$P_SOCK"

  reset_case
  run_sandbox --bind "$FAKE_HOME//tmux-1000,$FAKE_HOME/remapped-redundant" -- true
  assert_covering_case "redundant spelling SRC,DST" "--bind" \
    "$FAKE_HOME/remapped-redundant/$SIBLING_LEAF" "$FAKE_HOME/remapped-redundant/$SOCKET_LEAF"

  # 5. Exact hard link to the listening socket: omission + diagnostic.
  reset_case
  run_yolo --rw "$FAKE_HOME/hardlink-$SOCKET_LEAF" cmd true 2> "$RECORDER_DIR/stderr.hardlink-rw"
  assert_omission_case "exact hard link src=dst" "$FAKE_HOME/hardlink-$SOCKET_LEAF" "$RECORDER_DIR/stderr.hardlink-rw"

  reset_case
  run_sandbox --bind "$FAKE_HOME/hardlink-$SOCKET_LEAF,$FAKE_HOME/remapped-hardlink" -- true \
    2> "$RECORDER_DIR/stderr.hardlink-bind"
  assert_omission_case "exact hard link SRC,DST" "$FAKE_HOME/hardlink-$SOCKET_LEAF" "$RECORDER_DIR/stderr.hardlink-bind"

  # 6. Bind-mounted alias of the protected directory (private mount namespace).
  reset_case
  RUN_PREFIX=(unshare --user --map-root-user --mount "$FAKE_BIN/bindmount-run" "$PROTECTED_DIR" "$FAKE_HOME/mnt-alias")
  run_yolo --rw "$FAKE_HOME/mnt-alias" cmd true
  RUN_PREFIX=()
  assert_covering_case "bind-mounted ancestor alias src=dst" "--bind" \
    "$FAKE_HOME/mnt-alias/$SIBLING_LEAF" "$FAKE_HOME/mnt-alias/$SOCKET_LEAF"

  reset_case
  RUN_PREFIX=(unshare --user --map-root-user --mount "$FAKE_BIN/bindmount-run" "$PROTECTED_DIR" "$FAKE_HOME/mnt-alias")
  run_sandbox --bind "$FAKE_HOME/mnt-alias,$FAKE_HOME/remapped-mnt" -- true
  RUN_PREFIX=()
  assert_covering_case "bind-mounted ancestor alias SRC,DST" "--bind" \
    "$FAKE_HOME/remapped-mnt/$SIBLING_LEAF" "$FAKE_HOME/remapped-mnt/$SOCKET_LEAF"

  # 7. Semantics preservation: read-only and device covering binds.
  reset_case
  run_yolo --ro "$PROTECTED_DIR" cmd true
  assert_covering_case "read-only ancestor" "--ro-bind" "$P_SIBLING" "$P_SOCK"

  reset_case
  run_sandbox --dev-bind "$PROTECTED_DIR,$FAKE_HOME/remapped-dev" -- true
  assert_covering_case "device ancestor" "--dev-bind" \
    "$FAKE_HOME/remapped-dev/$SIBLING_LEAF" "$FAKE_HOME/remapped-dev/$SOCKET_LEAF"

  # 8. Re-exposing ordering: a later bind whose destination is an ancestor of
  # an earlier projection must not unmask the socket.
  reset_case
  run_sandbox \
    --bind "$PROTECTED_DIR,$FAKE_HOME/reexp/deep" \
    --bind "$FAKE_HOME,$FAKE_HOME/reexp" \
    -- true
  assert_covering_case "re-exposing ordering deep" "--bind" \
    "$FAKE_HOME/reexp/deep/$SIBLING_LEAF" "$FAKE_HOME/reexp/deep/$SOCKET_LEAF"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! awk -F'\t' -v p="$FAKE_HOME/reexp/tmux-1000/$SOCKET_LEAF" \
      '$1 == "--ro-bind" && $2 == "/dev/null" && $3 == p { ok=1 } END { exit ok ? 0 : 1 }' "$RECORDER_DIR/binds.tsv"; then
    fail "re-exposing ordering: home-wide bind projection has no /dev/null mask"
  fi

  # --- Clipboard bytes round-trip only through the dedicated broker socket.
  RT_DIR="$WORKDIR/rt"
  mkdir -p "$RT_DIR"
  RT_FAKE_STATE="$RT_DIR/tmux-state"
  mkdir -p "$RT_FAKE_STATE"
  RT_TMUX="$RT_DIR/fake-tmux"
  {
    printf '#!%s\n' "$_bash_path"
    cat <<'EOF'
set -euo pipefail
STATE_DIR="${FAKE_TMUX_STATE:?}"
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
case "$cmd" in
  load-buffer) cat > "$STATE_DIR/buffer" ;;
  save-buffer) cat "$STATE_DIR/buffer" ;;
  *) echo "fake-tmux: unexpected command '$cmd'" >&2; exit 64 ;;
esac
EOF
  } > "$RT_TMUX"
  chmod +x "$RT_TMUX"
  export FAKE_TMUX_STATE="$RT_FAKE_STATE"
  "$PROXY_BIN" broker \
    --listen "$RT_DIR/sock" \
    --tmux-socket "$PROTECTED_SOCK" \
    --tmux "$RT_TMUX" &
  RT_BROKER_PID=$!
  for _ in $(seq 1 50); do [[ -S "$RT_DIR/sock" ]] && break; sleep 0.05; done
  [[ -S "$RT_DIR/sock" ]]
  printf 'nul\0byte\nnewline\n' > "$RT_DIR/payload"
  YOLO_CLIPBOARD_SOCK="$RT_DIR/sock" "$PROXY_BIN" tmux-shim load-buffer - < "$RT_DIR/payload"
  YOLO_CLIPBOARD_SOCK="$RT_DIR/sock" "$PROXY_BIN" tmux-shim save-buffer - > "$RT_DIR/roundtrip"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! cmp -s "$RT_DIR/payload" "$RT_DIR/roundtrip"; then
    fail "NUL/newline clipboard bytes did not round-trip through the broker socket"
  fi
fi

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN confinement checks failed" >&2
  exit 1
fi
if [[ $EXPECT_VULNERABLE -eq 1 ]]; then
  echo "clipboard-confinement-test: $TESTS_RUN checks passed (no tmux authority used)"
else
  echo "clipboard-confinement-test: $TESTS_RUN checks passed (inherited tmux socket confined; clipboard brokered)"
fi
