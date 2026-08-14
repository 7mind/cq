#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="$(cd "$script_dir/../../.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  exec nix develop "$repository" --command "$0" "$@"
fi

pi_output="$(nix build "$repository#pi-coding-agent" --no-link --print-out-paths)"
if [[ -z "$pi_output" || "$pi_output" == *$'\n'* ]]; then
  echo "expected exactly one pi-coding-agent output path" >&2
  exit 1
fi
pi_module="$pi_output/lib/node_modules/pi-monorepo"
if [[ ! -f "$pi_module/package.json" ]]; then
  echo "pi-coding-agent output lacks lib/node_modules/pi-monorepo/package.json" >&2
  exit 1
fi

# Each package's frozen lockfile supplies TypeScript, @types/node, and bun-types;
# only the host package comes from the repository's Nix derivation.
for project in auto-driver ledger-status; do
  project_dir="$script_dir/$project"
  (
    cd "$project_dir"
    bun install --frozen-lockfile --no-progress --ignore-scripts
  )

  link="$project_dir/node_modules/@earendil-works/pi-coding-agent"
  if [[ -L "$link" ]]; then
    unlink "$link"
  elif [[ -e "$link" ]]; then
    echo "refusing to replace non-symlink Pi module at $link" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$link")"
  ln -s "$pi_module" "$link"

  echo "typecheck: $project"
  (
    cd "$project_dir"
    bun run typecheck
  )
done
