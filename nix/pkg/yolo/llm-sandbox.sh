#!/usr/bin/env bash
set -euo pipefail

RW_PATHS=()
RO_PATHS=()
BINDS=()
RO_BINDS=()
DEV_BINDS=()
ENVS=()
CONFINE_SOCKET=""

show_help() {
  cat <<EOF
Usage: llm-sandbox [OPTIONS] -- COMMAND [ARGS...]

Wrapper around bubblewrap with simplified path whitelisting.

Options:
  --rw PATH        Add read-write path (only if exists)
  --ro PATH        Add read-only path (only if exists)
  --bind SRC,DST      Bind mount SRC to DST inside sandbox (read-write)
  --ro-bind SRC,DST   Bind mount SRC to DST inside sandbox (read-only)
  --dev-bind SRC,DST  Bind mount SRC to DST inside sandbox, allowing device access
  --confine-socket PATH  Unix socket that must stay unreachable inside the
                         sandbox: omit binds of the socket itself and mask
                         its projected destination under every covering bind
  --env VAR=VALUE     Set environment variable inside sandbox
  --help           Show this help

Example:
  llm-sandbox --rw "\$PWD" --env FOO=bar -- myapp --flag
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rw)
      RW_PATHS+=("$2")
      shift 2
      ;;
    --ro)
      RO_PATHS+=("$2")
      shift 2
      ;;
    --bind)
      BINDS+=("$2")
      shift 2
      ;;
    --ro-bind)
      RO_BINDS+=("$2")
      shift 2
      ;;
    --dev-bind)
      DEV_BINDS+=("$2")
      shift 2
      ;;
    --confine-socket)
      CONFINE_SOCKET="$2"
      shift 2
      ;;
    --env)
      ENVS+=("$2")
      shift 2
      ;;
    --help)
      show_help
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "Error: No command specified" >&2
  exit 1
fi

BWRAP_ARGS=(
  --unshare-all
  --share-net
  --die-with-parent
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --dir /var
  --symlink /run /var/run
)

# Bind /tmp/exchange for host<->sandbox file sharing (create if missing)
EXCHANGE_DIR="/tmp/exchange"
if [[ ! -d "$EXCHANGE_DIR" ]]; then
  mkdir -p "$EXCHANGE_DIR"
fi
BWRAP_ARGS+=(--bind "$EXCHANGE_DIR" "$EXCHANGE_DIR")

# Nix store must be bound first (other paths are symlinks into it)
NIX_PATHS=(
  /nix/store
  /nix/var
)

for path in "${NIX_PATHS[@]}"; do
  if [[ -e "$path" ]]; then
    BWRAP_ARGS+=(--ro-bind "$path" "$path")
  fi
done

# Note: /etc/profiles and ~/.nix-profile are symlinks into /nix/store,
# they work automatically since both /etc and /nix/store are bound
SYSTEM_RO_PATHS=(
  /etc
  /bin
  /usr
  /run/current-system
  /run/wrappers
  /run/systemd/resolve
  /run/nscd
)

for path in "${SYSTEM_RO_PATHS[@]}"; do
  if [[ -e "$path" ]]; then
    BWRAP_ARGS+=(--ro-bind "$path" "$path")
  fi
done

# User-provided RO paths (filter out /nix/* as already bound)
for path in "${RO_PATHS[@]}"; do
  if [[ -e "$path" ]] && [[ "$path" != /nix/* ]]; then
    BWRAP_ARGS+=(--ro-bind "$path" "$path")
  fi
done

# User-provided RW paths
for path in "${RW_PATHS[@]}"; do
  if [[ -e "$path" ]]; then
    BWRAP_ARGS+=(--bind "$path" "$path")
  fi
done

for bind in "${BINDS[@]}"; do
  IFS=',' read -r src dst <<< "$bind"
  if [[ -e "$src" ]]; then
    BWRAP_ARGS+=(--bind "$src" "$dst")
  fi
done

for bind in "${RO_BINDS[@]}"; do
  IFS=',' read -r src dst <<< "$bind"
  if [[ -e "$src" ]]; then
    BWRAP_ARGS+=(--ro-bind "$src" "$dst")
  fi
done

for bind in "${DEV_BINDS[@]}"; do
  IFS=',' read -r src dst <<< "$bind"
  if [[ -e "$src" ]]; then
    BWRAP_ARGS+=(--dev-bind "$src" "$dst")
  fi
done

for env in "${ENVS[@]}"; do
  IFS='=' read -r name value <<< "$env"
  BWRAP_ARGS+=(--setenv "$name" "$value")
done

# --- Inherited tmux socket confinement (defects:D262, tasks:T1793) ----------
# yolo passes --confine-socket when it inherited a live host tmux socket. That
# socket must stay unreachable inside the sandbox no matter which bind would
# expose it: directly, through a lexical alias (symlink, '..', redundant
# spelling), through an exact hard link, or through a bind-mounted ancestor
# alias. Now that the complete bind set is concrete, every bind source is
# canonicalized and compared against the protected socket by path AND by
# filesystem object identity. An exact-socket source is omitted with a
# diagnostic; a bind covering the socket through an ancestor is preserved —
# harmless siblings keep their read-only/read-write/device semantics — while
# the projected socket destination is masked with /dev/null. Masks are appended
# after every other bind, and a final assertion proves that the last bind
# covering each projected socket is its own mask, so no later bind can
# re-expose it. Any resolution or identity failure refuses the launch.
if [[ -n "$CONFINE_SOCKET" ]]; then
  _confine_sock="$CONFINE_SOCKET"
  if [[ ! -S "$_confine_sock" ]]; then
    echo "llm-sandbox: confined tmux socket '$_confine_sock' is not a live socket; refusing launch" >&2
    exit 1
  fi
  if ! _confine_canon="$(realpath -- "$_confine_sock")"; then
    echo "llm-sandbox: cannot canonicalize confined tmux socket '$_confine_sock'; refusing launch" >&2
    exit 1
  fi

  # Same filesystem object (dev:inode) after dereferencing either spelling?
  _confine_same_object() {
    local a b
    a="$(stat -Lc '%d:%i' -- "$1" 2>/dev/null)" || return 1
    b="$(stat -Lc '%d:%i' -- "$2" 2>/dev/null)" || return 1
    [[ -n "$a" && -n "$b" && "$a" == "$b" ]]
  }

  # Prints the protected socket's path relative to $1 when $1 covers it —
  # lexically after canonicalization, or by object identity against any
  # ancestor (a bind-mounted alias has its own canonical path but shares the
  # ancestor's dev:inode). Returns 1 when $1 covers neither.
  _confine_relative_projection() {
    local csrc="$1" ancestor
    if [[ "$csrc" == "/" ]]; then
      printf '%s' "${_confine_canon#/}"
      return 0
    fi
    if [[ "$_confine_canon" == "$csrc"/* ]]; then
      printf '%s' "${_confine_canon#"$csrc"/}"
      return 0
    fi
    ancestor="$(dirname -- "$_confine_canon")"
    while [[ -n "$ancestor" && "$ancestor" != "/" ]]; do
      if _confine_same_object "$csrc" "$ancestor"; then
        printf '%s' "${_confine_canon#"$ancestor"/}"
        return 0
      fi
      ancestor="$(dirname -- "$ancestor")"
    done
    return 1
  }

  CONFINE_MASKS=()
  _confined_args=()
  _i=0
  while [[ $_i -lt ${#BWRAP_ARGS[@]} ]]; do
    _opt="${BWRAP_ARGS[$_i]}"
    case "$_opt" in
      --bind|--ro-bind|--dev-bind)
        _src="${BWRAP_ARGS[$((_i + 1))]}"
        _dst="${BWRAP_ARGS[$((_i + 2))]}"
        if ! _csrc="$(realpath -- "$_src")"; then
          echo "llm-sandbox: cannot canonicalize bind source '$_src'; refusing launch" >&2
          exit 1
        fi
        if [[ "$_csrc" == "$_confine_canon" ]] || _confine_same_object "$_csrc" "$_confine_canon"; then
          echo "llm-sandbox: omitting bind of confined tmux socket '$_src'" >&2
          _i=$((_i + 3))
          continue
        fi
        if _rel="$(_confine_relative_projection "$_csrc")" && [[ -n "$_rel" ]]; then
          # Project the socket through this covering bind to its sandbox-side
          # destination (lexical normalization only; the destination need not
          # exist on the host).
          _proj="$(realpath -ms -- "$_dst/$_rel")"
          _dup=0
          for _seen in "${CONFINE_MASKS[@]:-}"; do
            [[ "$_seen" == "$_proj" ]] && _dup=1
          done
          [[ $_dup -eq 0 ]] && CONFINE_MASKS+=("$_proj")
        fi
        _confined_args+=("$_opt" "$_src" "$_dst")
        _i=$((_i + 3))
        ;;
      *)
        _confined_args+=("$_opt")
        _i=$((_i + 1))
        ;;
    esac
  done

  # Masks go last so no later bind can re-expose a projected socket.
  for _proj in "${CONFINE_MASKS[@]:-}"; do
    [[ -n "$_proj" ]] || continue
    _confined_args+=(--ro-bind /dev/null "$_proj")
  done

  # Ordering assertion: the last bind whose destination is an ancestor-or-equal
  # of each projected socket must be that socket's own /dev/null mask.
  for _proj in "${CONFINE_MASKS[@]:-}"; do
    [[ -n "$_proj" ]] || continue
    _last_cover=""
    _i=0
    while [[ $_i -lt ${#_confined_args[@]} ]]; do
      _opt="${_confined_args[$_i]}"
      case "$_opt" in
        --bind|--ro-bind|--dev-bind)
          _ndst="$(realpath -ms -- "${_confined_args[$((_i + 2))]}")"
          if [[ "$_ndst" == "$_proj" || "$_proj" == "$_ndst"/* ]]; then
            _last_cover="$_opt|${_confined_args[$((_i + 1))]}|$_ndst"
          fi
          _i=$((_i + 3))
          ;;
        *)
          _i=$((_i + 1))
          ;;
      esac
    done
    if [[ "$_last_cover" != "--ro-bind|/dev/null|$_proj" ]]; then
      echo "llm-sandbox: final mount order would re-expose confined tmux socket at '$_proj'; refusing launch" >&2
      exit 1
    fi
  done

  BWRAP_ARGS=("${_confined_args[@]}")
fi

set -x
exec bwrap "${BWRAP_ARGS[@]}" "$@"
