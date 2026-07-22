# shellcheck shell=bash
# Compose the --append-system-prompt text for an agent from YOLO_PROMPT_JSON — a
# JSON array of { target, tags, prompt } objects (see promptExtensions). Keep
# objects whose target matches the agent (or "*") and none of whose tags is in
# the wrapper's DISABLE_TAGS set, then join their prompts with blank lines.
compose_prompt() {
  local agent="$1" dis
  [[ -z "${YOLO_PROMPT_JSON:-}" ]] && return 0
  # shellcheck disable=SC2016
  dis="$("$YOLO_JQ" -nc '$ARGS.positional' --args "${DISABLE_TAGS[@]}")"
  # shellcheck disable=SC2016
  printf '%s' "$YOLO_PROMPT_JSON" | "$YOLO_JQ" -r \
    --arg agent "$agent" --argjson dis "$dis" '
      [ .[]
        | select((.target == $agent or .target == "*") and ((.tags - $dis) == .tags))
        | .prompt
      ] | join("\n\n")
    '
}
