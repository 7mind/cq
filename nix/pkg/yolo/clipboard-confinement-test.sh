#!/usr/bin/env bash
# Regression: raw bwrap socket binds expose the host socket's protocol, even
# when the mount is read-only.  This test deliberately uses no tmux process.
#
# Usage: bash clipboard-confinement-test.sh [--expect-vulnerable <git-revision>]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
TARGET_REV="HEAD"
EXPECT_VULNERABLE=0

if [[ $# -gt 0 ]]; then
  if [[ $# -ne 2 || "$1" != "--expect-vulnerable" ]]; then
    echo "usage: $0 [--expect-vulnerable <git-revision>]" >&2
    exit 64
  fi
  EXPECT_VULNERABLE=1
  TARGET_REV="$2"
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
EXCHANGE_DIR="/tmp/exchange"
EXCHANGE_SOCKET="$EXCHANGE_DIR/$SOCKET_LEAF"
EXCHANGE_DIR_CREATED=0
SENTINEL_PID=""

cleanup() {
  if [[ -n "$SENTINEL_PID" ]]; then
    kill "$SENTINEL_PID" 2>/dev/null || true
    wait "$SENTINEL_PID" 2>/dev/null || true
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
  if [[ ! -e "$path" || -w "$path" ]]; then
    fail "$description ($path is absent or writable)"
  fi
}

# The test takes the production scripts from the requested revision.  This
# makes --expect-vulnerable a real fail-first check instead of a claim about a
# hand-maintained copy of an older launcher.
mkdir -p "$TARGET_DIR"
git show "$TARGET_REV:nix/pkg/yolo/yolo.sh" > "$TARGET_DIR/yolo.sh"
git show "$TARGET_REV:nix/pkg/yolo/llm-sandbox.sh" > "$TARGET_DIR/llm-sandbox.sh"
git show "$TARGET_REV:nix/pkg/yolo/custom-prompt.sh" > "$TARGET_DIR/custom-prompt.sh"
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
# It only connects to a socket when that socket appears below a
# source actually handed to bwrap; it never interprets, starts, or controls a
# tmux server/session/window/pane/run-shell command.
_bash_path="$(command -v bash)"
_python_path="$(command -v python3)"
cat > "$FAKE_BIN/bwrap" <<EOF
#!$_bash_path
set -euo pipefail
: "\${RECORDER_DIR:?}"
"$_python_path" -c 'import struct, sys; out = open(sys.argv[1], "wb"); [out.write(struct.pack("!Q", len(a.encode())) + a.encode()) for a in sys.argv[2:]]' "\$RECORDER_DIR/argv.frames" "\$@"
stdin_raw="\$RECORDER_DIR/.stdin.raw"
cat > "\$stdin_raw"
"$_python_path" -c 'import struct, sys; data = open(sys.argv[1], "rb").read(); open(sys.argv[2], "wb").write(struct.pack("!Q", len(data)) + data)' "\$stdin_raw" "\$RECORDER_DIR/stdin.frame"
rm -f "\$stdin_raw"
"$_python_path" - "\$RECORDER_DIR/argv.frames" "\$RECORDER_DIR/connections.tsv" "$SOCKET_LEAF" <<'PY'
import os
import socket
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
out = open(sys.argv[2], 'a', encoding='utf-8')
socket_leaf = sys.argv[3]
for index, value in enumerate(argv[:-2]):
    if value not in (b'--bind', b'--ro-bind', b'--dev-bind'):
        continue
    src = os.fsdecode(argv[index + 1])
    dst = os.fsdecode(argv[index + 2])
    candidates = [src]
    if os.path.isdir(src):
        candidates.append(os.path.join(src, socket_leaf))
    for candidate in candidates:
        if not os.path.exists(candidate):
            continue
        try:
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(1)
            probe.connect(candidate)
            probe.close()
        except OSError:
            continue
        projected = dst if candidate == src else os.path.join(dst, socket_leaf)
        out.write(f'{candidate}\\t{projected}\\n')
        out.flush()
        break
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

# Activate the baseline clipboard-broker branch without running tmux.  The
# fake broker exposes only sentinel symlinks and records its generated bind
# directory so the exact source and destination can be asserted below.
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

# The listener records only connection metadata (the kernel peer credentials),
# not bytes from a privileged protocol.  All fixture sockets point at this one
# harmless Unix-domain sentinel.
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

run_yolo() {
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
      YOLO_CLIPBOARD_PROXY="$FAKE_BIN/clipboard-proxy" \
      YOLO_TMUX="$FAKE_BIN/tmux" \
      SENTINEL_SOCKET="$SENTINEL_SOCKET" \
      SOCKET_LEAF="$SOCKET_LEAF" \
      TMUX="$HOST_TMUX_SOCKET,0,0" \
      bash "$TARGET_DIR/yolo.sh" "$@"
  )
}

rm -f "$RECORDER_DIR/argv.frames" "$RECORDER_DIR/stdin.frame" "$RECORDER_DIR/connections.tsv"
run_yolo cmd true
socket_at "$FAKE_HOME/.config/yolo/overlap/claude/home.json"
run_yolo --profile overlap --ro "$FAKE_HOME/adhoc-ro" --rw "$FAKE_HOME/adhoc-rw" cmd true
CQ_TEST_XDG_STATE_HOME="" run_yolo cmd true

# Exercise llm-sandbox's explicit remapping forms independently of yolo's
# same-path convenience options.
(
  PATH="$FAKE_BIN:$PATH" \
    RECORDER_DIR="$RECORDER_DIR" \
    bash "$TARGET_DIR/llm-sandbox.sh" \
      --bind "$RAW_BIND_SRC,$RAW_BIND_DST" \
      --ro-bind "$RAW_RO_BIND_SRC,$RAW_RO_BIND_DST" \
      --dev-bind "$RAW_DEV_BIND_SRC,$RAW_DEV_BIND_DST" \
      -- true
)

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
TESTS_RUN=$((TESTS_RUN + 1))
if [[ ! -s "$RECORDER_DIR/clip-proxy-dir" ]]; then
  fail "clipboard proxy did not record its generated bind directory"
else
  CLIP_PROXY_BOUND_DIR="$(< "$RECORDER_DIR/clip-proxy-dir")"
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

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN confinement checks failed" >&2
  exit 1
fi
echo "clipboard-confinement-test: $TESTS_RUN checks passed (no tmux authority used)"
