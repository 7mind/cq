#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: codegraph-bootstrap-test.sh <codegraph> <jq> <git>" >&2
  exit 2
fi

cg="$1"
jq="$2"
git="$3"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
bootstrap="$script_dir/codegraph-bootstrap.sh"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
parent="$workdir/parent"
child="$parent/child"
mkdir -p "$child"
parent="$(cd "$parent" && pwd -P)"
child="$(cd "$child" && pwd -P)"

"$git" -C "$parent" init -q
printf 'export const parent = 1;\n' > "$parent/parent.ts"
"$cg" init "$parent" >/dev/null 2>&1

"$git" -C "$child" init -q
printf 'export const child = 2;\n' > "$child/child.ts"
test ! -e "$child/.codegraph"

cold_output="$(cd "$child" && bash "$bootstrap" "$cg" "$jq" "$git" 2>&1)"
[[ "$cold_output" == *"building CodeGraph index for $child"* ]]
test -f "$child/.codegraph/codegraph.db"

status_json="$(cd "$child" && "$cg" status --json)"
[[ "$(printf '%s' "$status_json" | "$jq" -r .projectPath)" == "$child" ]]
[[ "$(printf '%s' "$status_json" | "$jq" -r .fileCount)" -eq 1 ]]

warm_output="$(cd "$child" && bash "$bootstrap" "$cg" "$jq" "$git" 2>&1)"
[[ "$warm_output" == *"syncing CodeGraph index for $child"* ]]

echo "CodeGraph bootstrap ancestor-index regression passed"
