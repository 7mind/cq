#!/usr/bin/env bash
# macOS counterpart to the Linux bwrap launcher, using Seatbelt confinement.
#
# Required env vars (set by the Nix wrapper):
#   YOLO_SANDBOX_EXEC - path to the Darwin sandbox-exec wrapper/binary
#   YOLO_JQ           - path to jq binary
#   YOLO_CUSTOM_PROMPT - path to the shared prompt-composition library
# Darwin applies --disable tags to prompt fragments; Linux also applies them to
# bwrap-only resources and hooks that Darwin does not provide.

: "${YOLO_SANDBOX_EXEC:?must be set}"
: "${YOLO_JQ:?must be set}"
: "${YOLO_CUSTOM_PROMPT:?must be set}"

# An empty profile preserves each agent's native home-directory defaults.
PROFILE=""
UNSAFE_SHARE_HOME=0
# Applied only to the child; explicit pairs override profile-derived values.
ENV_PAIRS=()
# Feature suppression: --disable=TAG is repeatable and comma-separated.
# shellcheck disable=SC2034
DISABLE_TAGS=()
# shellcheck source=/dev/null
source "$YOLO_CUSTOM_PROMPT"

validate_env_pair() {
  if [[ ! "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    echo "Error: invalid --env value '$1' (expected KEY=VAL; KEY must match ^[A-Za-z_][A-Za-z0-9_]*)" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: $1 requires a profile name" >&2; exit 1
      fi
      PROFILE="$2"; shift 2 ;;
    --work|-w) PROFILE="work"; shift ;;
    --disable=*)
      IFS=',' read -ra _dtags <<< "${1#*=}"
      DISABLE_TAGS+=("${_dtags[@]}")
      shift ;;
    --unsafe-share-home) UNSAFE_SHARE_HOME=1; shift ;;
    --env)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: $1 requires a KEY=VAL argument" >&2; exit 1
      fi
      validate_env_pair "$2"
      ENV_PAIRS+=("$2"); shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

# Profile names map directly to paths under ~/.config/yolo.
if [[ -n "$PROFILE" && ( ! "$PROFILE" =~ ^[A-Za-z0-9._-]+$ || "$PROFILE" == "." || "$PROFILE" == ".." ) ]]; then
  echo "Error: invalid profile name '$PROFILE' (allowed: letters, digits, '.', '_', '-'; not '.' or '..')" >&2
  exit 1
fi

# Resolve symlinks portably; stock macOS does not provide `readlink -f`.
_canonicalize() { (cd -P -- "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
_pwd_real="$(_canonicalize "${PWD}")"
_home_real="$(_canonicalize "${HOME}")"
if [[ "$_pwd_real" == "$_home_real" && $UNSAFE_SHARE_HOME -ne 1 ]]; then
  echo "Error: refusing to run yolo-darwin from \$HOME ($_home_real)." >&2
  echo "       \$PWD is bound read-write into the sandbox, so this would expose your" >&2
  echo "       entire home directory (credentials, keys, history) and defeat profile" >&2
  echo "       isolation. cd into a project subdirectory, or pass --unsafe-share-home" >&2
  echo "       to override." >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: yolo-darwin [--profile NAME|-p NAME] [--work] [--disable=TAG]... [--unsafe-share-home] [--env KEY=VAL]... <claude|codex|pi|shell|cmd> [args...]" >&2
  exit 1
fi

SUBCMD="$1"; shift
CMD_ARGS=("$@")

profile_dir() { printf '%s/.config/yolo/%s/%s' "${HOME}" "${PROFILE}" "$1"; }

# PI_CODING_AGENT_DIR relocates pi's entire per-user state for named profiles;
# leaving these variables unset preserves native defaults for the empty profile.
PROFILE_ENV_PAIRS=()
if [[ -n "$PROFILE" ]]; then
  CLAUDE_CONFIG_DIR="$(profile_dir claude)"
  CODEX_HOME="$(profile_dir codex)"
  PI_PROFILE_DIR="$(profile_dir pi)"
  mkdir -p "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$PI_PROFILE_DIR"
  chmod 700 "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$PI_PROFILE_DIR"
  PROFILE_ENV_PAIRS+=("CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" "CODEX_HOME=$CODEX_HOME" "PI_CODING_AGENT_DIR=$PI_PROFILE_DIR")
else
  PI_PROFILE_DIR="${HOME}/.pi"
fi

# Seatbelt profile rendering
_sb_escape() {
  local p="$1"
  p="${p//\\/\\\\}"
  p="${p//\"/\\\"}"
  printf '%s' "$p"
}

# `--use-profile` replaces the tool's built-in policy, so prepend the pinned
# tool's current noread profile instead of maintaining a copy here.
_render_base() {
  local base
  base="$("$YOLO_SANDBOX_EXEC" --write-base-profile /dev/stdout)"
  if [[ -z "$base" ]]; then
    echo "Error: '$YOLO_SANDBOX_EXEC --write-base-profile' produced no output; cannot render the sandbox base profile." >&2
    exit 1
  fi
  printf '%s\n' "$base"
}

# Emits yolo's policy fragment after the base. Seatbelt uses last-match-wins,
# so broad denies precede the active-profile grant. HOME remains a runtime
# parameter while literal PWD keeps this fragment deterministic for testing.
_render_yolo_rules() {
  local name="$1" pwd_dir="$2"
  local esc_pwd esc_cq_state label
  esc_pwd="$(_sb_escape "$pwd_dir")"
  if [[ -n "${XDG_STATE_HOME:-}" && "$XDG_STATE_HOME" == /* ]]; then
    esc_cq_state="$(_sb_escape "${XDG_STATE_HOME%/}/cq")"
  else
    esc_cq_state=""
  fi
  if [[ -n "$name" ]]; then label="$name"; else label="(default)"; fi

  printf ';; yolo-darwin rules appended after claude-code-sandbox noread.sb.\n'
  printf ';; Profile: %s\n' "$label"
  printf ';; Network remains open; filesystem grants are narrowed below.\n\n'
  printf ';; Grant PWD, shared cache, cq state, and native homes for the default profile.\n'
  printf '(allow file-read* file-write* file-write-create file-read-metadata file-ioctl\n'
  printf '    (subpath "%s")\n' "$esc_pwd"
  printf '    (subpath (string-append (param "HOME_DIR") "/.cache"))\n'
  if [[ -n "$esc_cq_state" ]]; then
    printf '    (subpath "%s")\n' "$esc_cq_state"
  else
    printf '    (subpath (string-append (param "HOME_DIR") "/.local/state/cq"))\n'
  fi
  if [[ -z "$name" ]]; then
    printf '    ;; default profile: the agents'"'"' real home config dirs\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.claude"))\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.claude.json"))\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.claude.json.backup"))\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.codex"))\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.pi"))\n'
  fi
  printf ')\n\n'

  printf ';; Deny every named profile before re-granting the active one.\n'
  printf '(deny file-read* file-write* file-write-create\n'
  printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo")))\n'

  if [[ -n "$name" ]]; then
    printf '\n'
    printf ';; Override base grants to native agent homes for named profiles.\n'
    printf ';; Shared HM assets are copied into the active profile before launch.\n'
    printf '(deny file-read* file-write* file-write-create\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.claude"))\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.claude.json"))\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.claude.json.backup"))\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.codex"))\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.gemini"))\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.pi"))\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/Library/Caches/claude-cli-nodejs")))\n'
    printf '\n'
    printf ';; Re-grant active profile "%s" last; siblings remain denied.\n' "$name"
    printf '(allow file-read* file-write* file-write-create file-read-metadata file-ioctl\n'
    printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo/%s/claude"))\n' "$name"
    printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo/%s/codex"))\n' "$name"
    printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo/%s/pi")))\n' "$name"
  fi
}

render_sandbox_profile() {
  local name="$1" pwd_dir="$2"
  _render_base
  printf '\n'
  _render_yolo_rules "$name" "$pwd_dir"
}

# Materialize the immutable HM config as a writable file. File-backed
# credentials keep named profiles out of the shared macOS Keychain, while
# persisted PWD trust avoids Codex prompting on every launch.
ensure_codex_config() {
  local out_file="$1" base_file="$2" trusted_dir="$3"
  local trust_header tmp
  trust_header="[projects.\"${trusted_dir}\"]"

  if [[ -f "$out_file" && ! -L "$out_file" ]] \
    && grep -qF "$trust_header" "$out_file" \
    && grep -q '^cli_auth_credentials_store[[:space:]]*=[[:space:]]*"file"' "$out_file" \
    && grep -q '^mcp_oauth_credentials_store[[:space:]]*=[[:space:]]*"file"' "$out_file"; then
    return 0
  fi

  mkdir -p "$(dirname "$out_file")"
  tmp="$(mktemp)"
  # Read through the HM symlink before replacing an in-place base file.
  [[ -e "$base_file" ]] && cat -- "$base_file" > "$tmp" 2>/dev/null

  # These keys must precede all TOML tables or they inherit the last table.
  # Existing keys remain untouched to avoid duplicate-key parse failures.
  if ! grep -q '^cli_auth_credentials_store[[:space:]]*=' "$tmp" 2>/dev/null; then
    { printf 'cli_auth_credentials_store = "file"\n'; cat -- "$tmp"; } > "${tmp}.new" && mv -- "${tmp}.new" "$tmp"
  fi
  if ! grep -q '^mcp_oauth_credentials_store[[:space:]]*=' "$tmp" 2>/dev/null; then
    { printf 'mcp_oauth_credentials_store = "file"\n'; cat -- "$tmp"; } > "${tmp}.new" && mv -- "${tmp}.new" "$tmp"
  fi

  # TOML table headers are absolute, so a missing project table can append safely.
  grep -qF "$trust_header" "$tmp" 2>/dev/null \
    || printf '\n%s\ntrust_level = "trusted"\n' "$trust_header" >> "$tmp"

  rm -f "$out_file"
  mv -- "$tmp" "$out_file"
  chmod u+w "$out_file"
}

# pi resolves all per-user state below PI_CODING_AGENT_DIR. Its MCP registry
# remains shared because pi-mcp-adapter reads ~/.config/mcp/mcp.json directly.
PI_SHARED_ASSETS=(settings.json AGENTS.md APPEND_SYSTEM.md cq-agents prompts skills extensions mcp.json)
# Seatbelt cannot bind-mount HM assets, so copy and dereference store symlinks.
# Copy-if-absent preserves profile edits; HM updates require profile recreation.
reshare_profile_assets() {
  local agent="$1"
  [[ -z "$PROFILE" ]] && return 0
  local src_dir dst_dir
  local -a assets
  case "$agent" in
    claude) src_dir="${HOME}/.claude";   dst_dir="$CLAUDE_CONFIG_DIR"; assets=(settings.json CLAUDE.md skills plugins commands agents) ;;
    codex)  src_dir="${HOME}/.codex";    dst_dir="$CODEX_HOME";        assets=(AGENTS.md prompts skills) ;;
    pi)     src_dir="${HOME}/.pi/agent"; dst_dir="$PI_PROFILE_DIR";    assets=("${PI_SHARED_ASSETS[@]}") ;;
    *) return 0 ;;
  esac
  mkdir -p "$dst_dir"
  local a src dst
  for a in "${assets[@]}"; do
    src="$src_dir/$a"
    dst="$dst_dir/$a"
    [[ -e "$src" && ! -e "$dst" ]] && cp -RL "$src" "$dst"
  done
}

# Environment precedence increases from profile to Claude token to user --env.
# SMIND_SANDBOXED remains non-overridable because agent tooling relies on it.
yolo_exec_agent() {
  local subcmd="$1"; shift
  # cmd supplies its executable through "$@"; other modes prepend fixed argv.
  local agent_prompt=""
  local agent_argv=()
  case "$subcmd" in
    claude)
      agent_prompt="$(compose_prompt claude)"
      agent_argv=(claude --permission-mode bypassPermissions --disallowed-tools AskUserQuestion)
      [[ -n "$agent_prompt" ]] && agent_argv+=(--append-system-prompt "$agent_prompt")
      ;;
    codex)  agent_argv=(codex --dangerously-bypass-approvals-and-sandbox --search) ;;
    pi)
      agent_prompt="$(compose_prompt pi)"
      agent_argv=(pi)
      [[ -n "$agent_prompt" ]] && agent_argv+=(--append-system-prompt "$agent_prompt")
      ;;
    shell)  agent_argv=("${SHELL:-/bin/sh}") ;;
    cmd)    agent_argv=() ;;
  esac
  # Keep the generated policy private and remove it after the confined process.
  local yolo_sb_profile
  yolo_sb_profile="$(mktemp "${TMPDIR:-/tmp}/yolo-darwin-sb.XXXXXXXX")"
  chmod 600 "$yolo_sb_profile"
  # shellcheck disable=SC2064
  trap "rm -f -- '$yolo_sb_profile'" EXIT
  render_sandbox_profile "$PROFILE" "$PWD" > "$yolo_sb_profile"
  local sandbox_argv=("$YOLO_SANDBOX_EXEC" --use-profile "$yolo_sb_profile" --target-dir "$PWD" --)
  exec env "${PROFILE_ENV_PAIRS[@]}" "${ENV_PAIRS[@]}" SMIND_SANDBOXED=1 "${sandbox_argv[@]}" "${agent_argv[@]}" "$@"
}

case "$SUBCMD" in
  claude)
    reshare_profile_assets claude
    yolo_exec_agent claude "${CMD_ARGS[@]}"
    ;;

  codex)
    # File credential stores prevent named profiles from sharing Keychain state.
    ensure_codex_config "${CODEX_HOME:-${HOME}/.codex}/config.toml" "${HOME}/.codex/config.toml" "$PWD"
    reshare_profile_assets codex
    yolo_exec_agent codex "${CMD_ARGS[@]}"
    ;;

  pi)
    reshare_profile_assets pi
    yolo_exec_agent pi "${CMD_ARGS[@]}"
    ;;

  shell)
    yolo_exec_agent shell "${CMD_ARGS[@]}"
    ;;

  cmd)
    if [[ ${#CMD_ARGS[@]} -eq 0 ]]; then
      echo "Usage: yolo-darwin [flags...] cmd <program> [args...]" >&2; exit 1
    fi
    yolo_exec_agent cmd "${CMD_ARGS[@]}"
    ;;

  *)
    echo "Unknown tool: $SUBCMD" >&2
    echo "Supported: claude, codex, pi, shell, cmd" >&2
    exit 1
    ;;
esac
