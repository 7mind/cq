#!/usr/bin/env bash
set -u

if [[ $# -ne 3 ]]; then
  echo "usage: codegraph-bootstrap.sh <codegraph> <jq> <git>" >&2
  exit 2
fi

cg="$1"
jq="$2"
git="$3"
root="$("$git" rev-parse --show-toplevel 2>/dev/null || pwd -P)"
root="$(realpath "$root")"
expected_index="$root/.codegraph"

if [[ -n "$root" ]] && ! grep -qxF '.codegraph/' "$root/.gitignore" 2>/dev/null; then
  if [[ -s "$root/.gitignore" ]] && [[ -n "$(tail -c1 "$root/.gitignore")" ]]; then
    printf '\n' >> "$root/.gitignore"
  fi
  printf '%s\n' '.codegraph/' >> "$root/.gitignore"
fi

status_json="$("$cg" status --json "$root" 2>/dev/null || true)"
initialized="$(printf '%s' "$status_json" | "$jq" -r '.initialized // false' 2>/dev/null || printf false)"
file_count="$(printf '%s' "$status_json" | "$jq" -r '.fileCount // 0' 2>/dev/null || printf 0)"
index_path="$(printf '%s' "$status_json" | "$jq" -r '.indexPath // empty' 2>/dev/null || true)"

local_index=false
if [[ "$initialized" == "true" ]] && [[ -n "$index_path" ]]; then
  normalized_index="$(realpath "$index_path")"
  [[ "$normalized_index" == "$expected_index" ]] && local_index=true
fi

if [[ "$local_index" == "true" ]] && [[ "$file_count" -gt 0 ]]; then
  echo "yolo: syncing CodeGraph index for ${root}…" >&2
  "$cg" sync "$root" >&2 || echo "warning: codegraph sync failed; continuing with the existing index" >&2
elif [[ "$local_index" == "true" ]]; then
  echo "yolo: building CodeGraph index for $root (one-time; pass --disable=codegraph to skip)…" >&2
  "$cg" index "$root" >&2 || echo "warning: codegraph index failed; launching without a code index" >&2
else
  echo "yolo: building CodeGraph index for $root (one-time; pass --disable=codegraph to skip)…" >&2
  "$cg" init "$root" >&2 || echo "warning: codegraph init failed; launching without a code index" >&2
fi
