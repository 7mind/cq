#!/usr/bin/env bash
# Regression: synthesized ssh_config must bind at the resolved real path, not
# the NixOS /etc/ssh/ssh_config symlink (bwrap fails on the symlink path with
# "Can't create file at /etc/ssh/ssh_config: No such file or directory").
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
  "$FAKE_HOME/.codex" \
  "$FAKE_HOME/.config/claude" \
  "$FAKE_HOME/.config/codex" \
  "$FAKE_HOME/.config/mcp" \
  "$FAKE_HOME/.config/git" \
  "$FAKE_HOME/.config/direnv" \
  "$FAKE_HOME/.local/share/direnv" \
  "$FAKE_HOME/.local/state/cq" \
  "$FAKE_HOME/.cache" \
  "$FAKE_HOME/.ivy2" \
  "$FAKE_HOME/.pi/agent"

printf '%s\n' \
  "#!$_bash_path" \
  'printf "%s\n" "$@"' \
  > "$FAKE_BIN/record-sandbox"
chmod +x "$FAKE_BIN/record-sandbox"

assert_true() {
  local desc="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! eval "$2"; then
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

# Gate: only run when the host exhibits the NixOS failure condition. Non-NixOS
# hosts leave /etc/ssh/ssh_config alone, so there is nothing to assert here.
if [[ ! -r /etc/ssh/ssh_config ]] \
   || ! grep -qE '^[[:space:]]*Include[[:space:]]+/nix/store/' /etc/ssh/ssh_config; then
  echo "SKIP: host /etc/ssh/ssh_config does not Include /nix/store paths"
  exit 0
fi

_ssh_cfg_dest="$(readlink -f /etc/ssh/ssh_config || true)"
if [[ -z "$_ssh_cfg_dest" ]]; then
  echo "SKIP: readlink -f /etc/ssh/ssh_config failed"
  exit 0
fi

OUT="$({
  cd "$PROJECT_DIR" &&
    HOME="$FAKE_HOME" \
    YOLO_LLM_SANDBOX="$FAKE_BIN/record-sandbox" \
    YOLO_SANDBOX_ENTRYPOINT="$(command -v true)" \
    YOLO_NIX_LD="$(command -v true)" \
    YOLO_JQ="$(command -v jq)" \
    YOLO_CUSTOM_PROMPT="$SCRIPT_DIR/custom-prompt.sh" \
    bash "$SCRIPT" cmd true
} 2>&1)"
STATUS=$?

assert_true "yolo cmd records sandbox args successfully" "[[ $STATUS -eq 0 ]]"
assert_true \
  "ssh_config bind destination is the resolved real path ($_ssh_cfg_dest)" \
  "[[ \"\$OUT\" == *\"$_ssh_cfg_dest\"* ]]"
assert_true \
  "ssh_config bind is NOT at the NixOS symlink path /etc/ssh/ssh_config" \
  "[[ \"\$OUT\" != *\",/etc/ssh/ssh_config\"* ]]"

# Live bwrap smoke: binding at the real path must succeed and surface content
# via the /etc/ssh/ssh_config symlink chain OpenSSH follows.
if command -v bwrap >/dev/null 2>&1; then
  TMP="$(mktemp "${TMPDIR:-/tmp}/yolo-ssh-config-test.XXXXXX")"
  printf 'Host *\n    ForwardX11 no\n' > "$TMP"
  CONTENT="$(
    bwrap --unshare-all --share-net --die-with-parent \
      --dev /dev --proc /proc --tmpfs /tmp \
      --ro-bind /nix/store /nix/store \
      --ro-bind /etc /etc \
      --ro-bind "$TMP" "$_ssh_cfg_dest" \
      -- cat /etc/ssh/ssh_config 2>&1
  )"
  BSTATUS=$?
  rm -f "$TMP"
  assert_true "bwrap bind at realpath succeeds" "[[ $BSTATUS -eq 0 ]]"
  assert_true "overlay visible via /etc/ssh/ssh_config" "[[ \"\$CONTENT\" == *'ForwardX11 no'* ]]"
fi

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES of $TESTS_RUN tests failed"
  echo "--- recorded sandbox args ---"
  echo "$OUT"
  exit 1
fi
echo "All $TESTS_RUN tests passed"
