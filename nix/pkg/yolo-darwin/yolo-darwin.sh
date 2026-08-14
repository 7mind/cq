#!/usr/bin/env bash
# macOS counterpart to the Linux bwrap launcher, using Seatbelt confinement.
#
# Required env vars (set by the Nix wrapper):
#   YOLO_SANDBOX_EXEC - path to the Darwin sandbox-exec wrapper/binary
#   YOLO_JQ           - path to jq binary
#   YOLO_CUSTOM_PROMPT - path to the shared prompt-composition library
#   YOLO_SANDBOX_ENTRYPOINT - shared secret/hook-loading child entrypoint

: "${YOLO_SANDBOX_EXEC:?must be set}"
: "${YOLO_JQ:?must be set}"
: "${YOLO_CUSTOM_PROMPT:?must be set}"
: "${YOLO_SANDBOX_ENTRYPOINT:?must be set}"

# An empty profile preserves each agent's native home-directory defaults.
PROFILE=""
UNSAFE_SHARE_HOME=0
# Applied only to the child; explicit pairs override profile-derived values.
ENV_PAIRS=()
SESSION_ENV_PAIRS=()
SANDBOX_PACKAGE_ENV_PAIRS=()
SOCKET_ENV_PAIRS=()
EXTRA_RO_PATHS=("${HOME}/.agents")
EXTRA_RW_PATHS=()
# Ad-hoc `--ro PATH` / `--rw PATH` grants given on the CLI, kept in submission
# order and rendered after every declarative grant: Seatbelt is last-match-wins.
CLI_PATH_GRANTS=()
CLEANUP_FILES=()
# Feature suppression: --disable=TAG is repeatable and comma-separated.
# shellcheck disable=SC2034
DISABLE_TAGS=()
# Feature activation: --enable=TAG (same syntax) turns on a feature that is OFF
# by default. Prompt fragments and pre-start hooks are on by default, so on
# Darwin --enable currently only feeds tag_active for future opt-in features;
# --disable always wins over --enable for the same tag.
# shellcheck disable=SC2034
ENABLE_TAGS=()
# shellcheck source=/dev/null
source "$YOLO_CUSTOM_PROMPT"

cleanup_yolo_tempfiles() {
  local file
  for file in "${CLEANUP_FILES[@]}"; do
    [[ -n "$file" ]] && rm -f -- "$file"
  done
}
trap cleanup_yolo_tempfiles EXIT

validate_env_pair() {
  if [[ ! "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    echo "Error: invalid --env value '$1' (expected KEY=VAL; KEY must match ^[A-Za-z_][A-Za-z0-9_]*)" >&2
    exit 1
  fi
}

print_help() {
  cat <<'EOF'
yolo — LLM tool launcher inside a macOS Seatbelt sandbox.

Usage: yolo-darwin [FLAGS...] <claude|codex|pi|shell|cmd> [args...]

Flags (must precede the subcommand):
  -p, --profile NAME     Use isolated config namespace ~/.config/yolo/NAME
                         (default: agents read their native home directories).
  -w, --work             Alias for `--profile work`.
      --disable=TAG      Drop prompt fragments and pre-start hooks carrying TAG
                         (repeatable, comma-separated).
      --enable=TAG       Turn on a feature that is off by default (repeatable,
                         comma-separated). No Darwin feature is opt-in yet
                         (Linux has "display"). --disable=TAG wins over
                         --enable=TAG.
      --ro PATH          Grant ad-hoc read-only access to PATH (repeatable;
                         skipped if missing).
      --rw PATH          Grant ad-hoc read-write access to PATH (repeatable;
                         skipped if missing).
      --env KEY=VAL      Set an env var inside the sandbox (repeatable).
      --unsafe-share-home  Allow running with $PWD == $HOME (grants all of $HOME
                         read-write; refused by default).
  -h, --help             Show this help and exit.

Subcommands:
  claude | codex | pi    Launch the named coding agent (bypass approvals).
  shell                  Interactive shell inside the sandbox.
  cmd <program> [args…]  Run an arbitrary command inside the sandbox.

The current working directory ($PWD) is always granted read-write. Additional
paths, packages, environment variables, secrets, and hooks can be configured
declaratively through smind.hm.dev.llm.yolo.*.
EOF
}

if [[ -n "${YOLO_SESSION_VARS:-}" ]]; then
  while IFS= read -r _session_pair; do
    [[ -z "$_session_pair" ]] && continue
    validate_env_pair "$_session_pair"
    SESSION_ENV_PAIRS+=("$_session_pair")
  done <<< "$YOLO_SESSION_VARS"
fi
if [[ -n "${YOLO_SANDBOX_BIN:-}" ]]; then
  SANDBOX_PACKAGE_ENV_PAIRS+=("PATH=$YOLO_SANDBOX_BIN:$PATH")
fi
if [[ -n "${YOLO_EXTRA_RO_PATHS:-}" ]]; then
  while IFS= read -r _path; do
    [[ -n "$_path" ]] && EXTRA_RO_PATHS+=("$_path")
  done <<< "$YOLO_EXTRA_RO_PATHS"
fi
if [[ -n "${YOLO_EXTRA_RW_PATHS:-}" ]]; then
  while IFS= read -r _path; do
    [[ -n "$_path" ]] && EXTRA_RW_PATHS+=("$_path")
  done <<< "$YOLO_EXTRA_RW_PATHS"
fi

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
    --enable=*)
      IFS=',' read -ra _etags <<< "${1#*=}"
      ENABLE_TAGS+=("${_etags[@]}")
      shift ;;
    --ro|--rw)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: $1 requires a path" >&2; exit 1
      fi
      CLI_PATH_GRANTS+=("${1#--}"$'\t'"$2"); shift 2 ;;
    --unsafe-share-home) UNSAFE_SHARE_HOME=1; shift ;;
    --env)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: $1 requires a KEY=VAL argument" >&2; exit 1
      fi
      validate_env_pair "$2"
      ENV_PAIRS+=("$2"); shift 2 ;;
    -h|--help) print_help; exit 0 ;;
    -*) echo "Unknown flag: $1" >&2; echo "Try 'yolo --help'." >&2; exit 1 ;;
    *) break ;;
  esac
done

# Tag state helpers, mirroring the Linux wrapper: a built-in feature asks
# `tag_active TAG on|off` with its default state, --disable=TAG always wins, and
# --enable=TAG only matters for a default-off feature.
is_disabled() {
  local _t
  for _t in "${DISABLE_TAGS[@]}"; do
    [[ "$_t" == "$1" ]] && return 0
  done
  return 1
}

is_enabled() {
  local _t
  for _t in "${ENABLE_TAGS[@]}"; do
    [[ "$_t" == "$1" ]] && return 0
  done
  return 1
}

tag_active() {
  is_disabled "$1" && return 1
  [[ "$2" == "on" ]] && return 0
  is_enabled "$1"
}

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
  print_help >&2
  exit 1
fi

SUBCMD="$1"; shift
CMD_ARGS=("$@")

case "$SUBCMD" in
  claude|codex|pi|shell) ;;
  cmd)
    if [[ ${#CMD_ARGS[@]} -eq 0 ]]; then
      echo "Usage: yolo-darwin [flags...] cmd <program> [args...]" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown tool: $SUBCMD" >&2
    echo "Supported: claude, codex, pi, shell, cmd" >&2
    exit 1
    ;;
esac

# Match Linux yolo's container-runtime contract. Seatbelt already grants
# network*, so the socket needs only filesystem visibility; the generic path
# renderer grants both a stable symlink and its canonical runtime target.
if [[ -n "${YOLO_PODMAN_SOCKET_PATH:-}" && -n "${YOLO_PODMAN_SOCKET_URI:-}" ]]; then
  if [[ -S "$YOLO_PODMAN_SOCKET_PATH" ]]; then
    EXTRA_RO_PATHS+=("$YOLO_PODMAN_SOCKET_PATH")
    SOCKET_ENV_PAIRS+=("DOCKER_HOST=$YOLO_PODMAN_SOCKET_URI")
    SOCKET_ENV_PAIRS+=("CONTAINER_HOST=$YOLO_PODMAN_SOCKET_URI")
  else
    echo "warning: podsvc-llm Podman socket not available, skipping bind: $YOLO_PODMAN_SOCKET_PATH" >&2
  fi
fi

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

_logical_absolute_path() {
  local path="$1" dir base
  [[ "$path" == /* ]] || path="$PWD/$path"
  while [[ "$path" != "/" && "$path" == */ ]]; do path="${path%/}"; done
  if [[ "$path" == "/" ]]; then
    printf /
    return
  fi
  dir="${path%/*}"
  base="${path##*/}"
  [[ -n "$dir" ]] || dir="/"
  (cd -P -- "$dir" && printf '%s/%s' "$(pwd -P)" "$base")
}

_render_parent_metadata_grant() {
  local path="$1" parent esc_parent
  parent="${path%/*}"
  printf '(allow file-read-metadata\n'
  while [[ -n "$parent" && "$parent" != "/" ]]; do
    esc_parent="$(_sb_escape "$parent")"
    printf '    (literal "%s")\n' "$esc_parent"
    parent="${parent%/*}"
  done
  printf '    (literal "/"))\n'
}

_render_path_grant() {
  local access="$1" path="$2" esc_path
  esc_path="$(_sb_escape "$path")"
  _render_parent_metadata_grant "$path"
  if [[ "$access" == ro ]]; then
    printf '(allow file-read* file-read-metadata\n'
  else
    printf '(allow file-read* file-write* file-write-create file-read-metadata file-ioctl\n'
  fi
  printf '    (literal "%s")\n' "$esc_path"
  printf '    (subpath "%s"))\n' "$esc_path"
}

_render_one_path_grant() {
  local access="$1" raw="$2" logical canonical
  [[ -e "$raw" ]] || return 0
  logical="$(_logical_absolute_path "$raw")"
  canonical="$(realpath "$logical" 2>/dev/null || printf '%s' "$logical")"
  printf '\n;; Explicit %s grant: %s\n' "$access" "$logical"
  _render_path_grant "$access" "$logical"
  if [[ "$canonical" != "$logical" ]]; then
    _render_path_grant "$access" "$canonical"
  fi
}

_render_configured_path_grants() {
  local access raw grant
  for access in ro rw; do
    if [[ "$access" == ro ]]; then
      set -- "${EXTRA_RO_PATHS[@]}"
    else
      set -- "${EXTRA_RW_PATHS[@]}"
    fi
    for raw in "$@"; do
      _render_one_path_grant "$access" "$raw"
    done
  done
  for grant in "${CLI_PATH_GRANTS[@]}"; do
    _render_one_path_grant "${grant%%$'\t'*}" "${grant#*$'\t'}"
  done
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
    printf ';; Ancestor grants let realpath/canonicalize traverse to the profile.\n'
    printf '(allow file-read-metadata\n'
    printf '    (literal "/Users")\n'
    printf '    (literal (param "HOME_DIR")))\n'
    printf '(allow file-read*\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.config"))\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.config/yolo"))\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.config/yolo/%s")))\n' "$name"
    printf '(allow file-read* file-write* file-write-create file-read-metadata file-ioctl\n'
    printf '    ;; literal roots are required by realpath/canonicalize; subpath covers descendants\n'
    printf '    (literal (string-append (param "HOME_DIR") "/.config/yolo/%s/claude"))\n' "$name"
    printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo/%s/claude"))\n' "$name"
    printf '    (literal (string-append (param "HOME_DIR") "/.config/yolo/%s/codex"))\n' "$name"
    printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo/%s/codex"))\n' "$name"
    printf '    (literal (string-append (param "HOME_DIR") "/.config/yolo/%s/pi"))\n' "$name"
    printf '    (subpath (string-append (param "HOME_DIR") "/.config/yolo/%s/pi")))\n' "$name"
  fi
  _render_configured_path_grants
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
profile_asset_matches() {
  local src="$1" dst="$2"
  [[ ! -L "$dst" ]] || return 1
  if [[ -d "$src" ]]; then
    [[ -d "$dst" ]] && diff -qr "$src" "$dst" >/dev/null
  elif [[ -f "$src" ]]; then
    [[ -f "$dst" ]] && cmp -s "$src" "$dst"
  else
    return 1
  fi
}

sync_profile_asset() {
  local src="$1" dst="$2"
  [[ -e "$src" ]] || return 0
  if [[ -e "$dst" || -L "$dst" ]]; then
    profile_asset_matches "$src" "$dst" && return 0
    local backup_index=1 backup
    backup="${dst}.yolobak-${backup_index}"
    while [[ -e "$backup" || -L "$backup" ]]; do
      backup_index=$((backup_index + 1))
      backup="${dst}.yolobak-${backup_index}"
    done
    mv "$dst" "$backup"
  fi
  cp -RL "$src" "$dst"
}

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
    sync_profile_asset "$src" "$dst"
  done
}

prepare_profile_assets() {
  [[ -z "$PROFILE" ]] && return 0
  reshare_profile_assets claude
  reshare_profile_assets codex
  reshare_profile_assets pi
  ensure_codex_config "$CODEX_HOME/config.toml" "${HOME}/.codex/config.toml" "$PWD"
}

# Host pre-start hooks run for agent subcommands only. Hooks are best-effort and
# a hook is omitted when any of its tags occurs in the --disable set.
run_prestart_hooks() {
  [[ -z "${YOLO_PREHOOKS_JSON:-}" ]] && return 0
  local disabled hook
  # shellcheck disable=SC2016
  local disabled_filter='$ARGS.positional' hook_filter='.[] | select((.tags - $dis) == .tags) | .command + "\u0000"'
  disabled="$("$YOLO_JQ" -nc "$disabled_filter" --args "${DISABLE_TAGS[@]}")"
  while IFS= read -r -d '' hook; do
    [[ -z "$hook" ]] && continue
    bash -c "$hook" || echo "warning: yolo pre-start hook failed (continuing)" >&2
  done < <(
    printf '%s' "$YOLO_PREHOOKS_JSON" \
      | "$YOLO_JQ" -j --argjson dis "$disabled" "$hook_filter"
  )
}

# Environment precedence increases from profile, container socket defaults,
# extra-package PATH, and declarative session variables to user --env. Secrets
# load inside Seatbelt after those values, while SMIND_SANDBOXED remains
# non-overridable.
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

  local secret_tmpfile="" sandbox_hooks_tmpfile="" have_secret=0
  local disabled_hooks composed_hooks line name path
  # shellcheck disable=SC2016
  local disabled_filter='$ARGS.positional' sandbox_hook_filter='.[] | select((.tags - $dis) == .tags) | .command + "\n"'
  local -a entrypoint_env=()
  if [[ -n "${YOLO_SECRET_VARS:-}" ]]; then
    secret_tmpfile="$(mktemp "${TMPDIR:-/tmp}/yolo-darwin-secrets.XXXXXX")"
    chmod 600 "$secret_tmpfile"
    CLEANUP_FILES+=("$secret_tmpfile")
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      name="${line%%=*}"
      path="${line#*=}"
      if [[ -r "$path" ]]; then
        printf '%s=%s\n' "$name" "$(cat -- "$path")" >> "$secret_tmpfile"
        have_secret=1
      else
        echo "warning: secret for $name not readable at $path; skipping" >&2
      fi
    done <<< "$YOLO_SECRET_VARS"
    if [[ $have_secret -eq 1 ]]; then
      entrypoint_env+=("YOLO_SECRETS_FILE=$secret_tmpfile")
    else
      rm -f -- "$secret_tmpfile"
      secret_tmpfile=""
    fi
  fi

  case "$subcmd" in
    claude|codex|pi)
      if [[ -n "${YOLO_SANDBOX_HOOKS_JSON:-}" ]]; then
        disabled_hooks="$("$YOLO_JQ" -nc "$disabled_filter" --args "${DISABLE_TAGS[@]}")"
        composed_hooks="$(
          printf '%s' "$YOLO_SANDBOX_HOOKS_JSON" \
            | "$YOLO_JQ" -j --argjson dis "$disabled_hooks" "$sandbox_hook_filter"
        )"
        if [[ -n "$composed_hooks" ]]; then
          sandbox_hooks_tmpfile="$(mktemp "${TMPDIR:-/tmp}/yolo-darwin-hooks.XXXXXX")"
          chmod 600 "$sandbox_hooks_tmpfile"
          printf '%s\n' "$composed_hooks" > "$sandbox_hooks_tmpfile"
          CLEANUP_FILES+=("$sandbox_hooks_tmpfile")
          entrypoint_env+=("YOLO_SANDBOX_HOOKS_FILE=$sandbox_hooks_tmpfile")
        fi
      fi
      ;;
  esac

  # Keep the generated policy private and remove it after the confined process.
  local yolo_sb_profile status sandbox_entrypoint bash_executable
  yolo_sb_profile="$(mktemp "${TMPDIR:-/tmp}/yolo-darwin-sb.XXXXXXXX")"
  chmod 600 "$yolo_sb_profile"
  CLEANUP_FILES+=("$yolo_sb_profile")
  render_sandbox_profile "$PROFILE" "$PWD" > "$yolo_sb_profile"
  local sandbox_argv=("$YOLO_SANDBOX_EXEC" --use-profile "$yolo_sb_profile" --target-dir "$PWD" --)
  local child_argv=("${agent_argv[@]}" "$@")
  sandbox_entrypoint="$YOLO_SANDBOX_ENTRYPOINT"
  bash_executable="$BASH"
  if [[ ${#entrypoint_env[@]} -gt 0 ]]; then
    child_argv=("$bash_executable" "$sandbox_entrypoint" "${child_argv[@]}")
  fi
  local yolo_vars=("${!YOLO_@}")
  unset "${yolo_vars[@]}"
  env \
    "${PROFILE_ENV_PAIRS[@]}" \
    "${SOCKET_ENV_PAIRS[@]}" \
    "${SANDBOX_PACKAGE_ENV_PAIRS[@]}" \
    "${SESSION_ENV_PAIRS[@]}" \
    "${ENV_PAIRS[@]}" \
    SMIND_SANDBOXED=1 \
    "${entrypoint_env[@]}" \
    "${sandbox_argv[@]}" \
    "${child_argv[@]}"
  status=$?
  cleanup_yolo_tempfiles
  CLEANUP_FILES=()
  return "$status"
}

prepare_profile_assets
case "$SUBCMD" in
  claude|codex|pi) run_prestart_hooks ;;
esac

case "$SUBCMD" in
  claude)
    yolo_exec_agent claude "${CMD_ARGS[@]}"
    ;;

  codex)
    # File credential stores prevent named profiles from sharing Keychain state.
    if [[ -z "$PROFILE" ]]; then
      ensure_codex_config "${HOME}/.codex/config.toml" "${HOME}/.codex/config.toml" "$PWD"
    fi
    yolo_exec_agent codex "${CMD_ARGS[@]}"
    ;;

  pi)
    yolo_exec_agent pi "${CMD_ARGS[@]}"
    ;;

  shell)
    yolo_exec_agent shell "${CMD_ARGS[@]}"
    ;;

  cmd)
    yolo_exec_agent cmd "${CMD_ARGS[@]}"
    ;;
esac
