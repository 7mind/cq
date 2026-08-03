#!/usr/bin/env bash
# defects:D262 — prove clipboard transfer works while host tmux control is unreachable.
# Usage: bash clipboard-escape-test.sh /path/to/yolo-clipboard-proxy
set -euo pipefail

PROXY="${1:?usage: clipboard-escape-test.sh /path/to/yolo-clipboard-proxy}"
command -v tmux >/dev/null
command -v bwrap >/dev/null

WORKDIR="$(mktemp -d)"
# Host tmux socket lives outside every sandbox bind on purpose.
HOST_DIR="$(mktemp -d)"
BROKER_PID=""
TMUX_SOCK="$HOST_DIR/tmux.sock"

cleanup() {
  if [[ -n "${BROKER_PID:-}" ]]; then
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  tmux -S "$TMUX_SOCK" kill-server 2>/dev/null || true
  rm -rf "$WORKDIR" "$HOST_DIR"
}
trap cleanup EXIT

tmux -S "$TMUX_SOCK" new-session -d -s d262 "sleep 120"
HOST_PID="$(tmux -S "$TMUX_SOCK" display-message -p '#{pid}')"
printf 'seed' | tmux -S "$TMUX_SOCK" load-buffer -

BIN_DIR="$WORKDIR/bin"
mkdir -p "$BIN_DIR"
cp "$PROXY" "$BIN_DIR/yolo-clipboard-proxy"
chmod +x "$BIN_DIR/yolo-clipboard-proxy"

CLIP_DIR="$WORKDIR/clip"
mkdir -p "$CLIP_DIR"
chmod 700 "$CLIP_DIR"
CLIP_SOCK="$CLIP_DIR/sock"

"$BIN_DIR/yolo-clipboard-proxy" broker \
  --listen "$CLIP_SOCK" \
  --tmux-socket "$TMUX_SOCK" \
  --tmux "$(command -v tmux)" &
BROKER_PID=$!
for _ in $(seq 1 50); do
  [[ -S "$CLIP_SOCK" ]] && break
  sleep 0.05
done
[[ -S "$CLIP_SOCK" ]]

SHIM_DIR="$WORKDIR/shim"
mkdir -p "$SHIM_DIR"
ln -s "$BIN_DIR/yolo-clipboard-proxy" "$SHIM_DIR/tmux"

MARKER_HOST="$HOST_DIR/host-escape-marker"

bwrap \
  --unshare-all \
  --share-net \
  --die-with-parent \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --ro-bind /nix /nix \
  --ro-bind /etc /etc \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /run/current-system /run/current-system \
  --bind "$CLIP_DIR" "$CLIP_DIR" \
  --ro-bind "$BIN_DIR" "$BIN_DIR" \
  --ro-bind "$SHIM_DIR" "$SHIM_DIR" \
  --setenv PATH "$SHIM_DIR:/run/current-system/sw/bin:/bin" \
  --setenv YOLO_CLIPBOARD_SOCK "$CLIP_SOCK" \
  --setenv TMUX "${TMUX_SOCK},${HOST_PID},0" \
  --setenv HOME /tmp \
  -- bash -c "
    set -euo pipefail
    # Host tmux socket must not be visible inside the sandbox.
    if [[ -e '${TMUX_SOCK}' ]]; then
      echo 'FAIL: host tmux socket is visible inside sandbox' >&2
      exit 1
    fi
    printf 'from-sandbox' | tmux load-buffer -
    got=\$(tmux save-buffer -)
    test \"\$got\" = 'from-sandbox'
    if tmux run-shell 'echo ESCAPED > ${MARKER_HOST}' 2>/tmp/rs.err; then
      echo 'FAIL: run-shell succeeded' >&2
      exit 1
    fi
    if tmux new-window -d 2>/tmp/nw.err; then
      echo 'FAIL: new-window succeeded' >&2
      exit 1
    fi
    if tmux display-message -p '#{pid}' 2>/tmp/dm.err; then
      echo 'FAIL: display-message succeeded' >&2
      exit 1
    fi
    real_tmux=/run/current-system/sw/bin/tmux
    if [[ -x \$real_tmux ]]; then
      if \"\$real_tmux\" -S '${TMUX_SOCK}' display-message -p '#{pid}' 2>/tmp/real.err; then
        echo 'FAIL: absolute-path tmux reached host socket' >&2
        exit 1
      fi
    fi
    echo SANDBOX_OK
  "

if [[ -e "$MARKER_HOST" ]]; then
  echo "FAIL: host escape marker was created at $MARKER_HOST" >&2
  exit 1
fi

HOST_BUF="$(tmux -S "$TMUX_SOCK" save-buffer -)"
if [[ "$HOST_BUF" != "from-sandbox" ]]; then
  echo "FAIL: host tmux buffer is '$HOST_BUF', expected 'from-sandbox'" >&2
  exit 1
fi

echo "clipboard-escape-test: ALL CHECKS PASSED"
