#!/usr/bin/env bash
# Update codex to the latest version published on GitHub.
#
# Bumps the `version` field and refreshes the four per-platform SRI hashes in
# package.nix. Run from anywhere — the script edits the package.nix that sits
# next to it.
#
# Keep this in sync with the manual instructions in package.nix. If you change
# one, change the other.

set -euo pipefail

no_build=false
if [[ "${1:-}" == "--no-build" ]]; then
  no_build=true
fi

cd "$(dirname "$0")"
pkg_nix="package.nix"

current=$(sed -nE 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"([^"]+)";.*/\1/p' "$pkg_nix" | head -n1)
latest=$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest | jq -r '.tag_name | sub("^rust-v"; "")')

echo "current: $current"
echo "latest:  $latest"

if [[ "$current" == "$latest" ]]; then
  echo "already up to date"
  exit 0
fi

platforms=(x86_64-linux aarch64-linux x86_64-darwin aarch64-darwin)

declare -A assets=(
  [x86_64-linux]="codex-x86_64-unknown-linux-musl.tar.gz"
  [aarch64-linux]="codex-aarch64-unknown-linux-musl.tar.gz"
  [x86_64-darwin]="codex-x86_64-apple-darwin.tar.gz"
  [aarch64-darwin]="codex-aarch64-apple-darwin.tar.gz"
)

# Fetch all hashes up-front so a mid-run failure does not leave package.nix in a
# half-updated state.
declare -A new_hashes
for system in "${platforms[@]}"; do
  asset="${assets[$system]}"
  url="https://github.com/openai/codex/releases/download/rust-v${latest}/${asset}"
  echo "fetching ${asset}..."
  sha=$(nix-prefetch-url --type sha256 "$url" 2>/dev/null)
  new_hashes[$system]=$(nix hash convert --hash-algo sha256 --to sri "$sha")
  printf '  %s\n' "${new_hashes[$system]}"
done

sed -i -E "s|^([[:space:]]*version[[:space:]]*=[[:space:]]*\")[^\"]+(\";)|\1${latest}\2|" "$pkg_nix"

for system in "${platforms[@]}"; do
  asset="${assets[$system]}"
  new_sri="${new_hashes[$system]}"
  old_sri=$(grep -A1 "asset = \"$asset\";" "$pkg_nix" | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -n1)
  if [[ -z "$old_sri" ]]; then
    echo "could not find existing hash for $asset in $pkg_nix" >&2
    exit 1
  fi
  if [[ "$old_sri" != "$new_sri" ]]; then
    sed -i "s|${old_sri}|${new_sri}|" "$pkg_nix"
  fi
done

echo
echo "updated $pkg_nix to $latest"

if [[ "$no_build" == true ]]; then
  echo "skipping build (--no-build)"
  exit 0
fi

nix build .#codex
