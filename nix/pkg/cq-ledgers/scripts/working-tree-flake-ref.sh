#!/usr/bin/env bash
# D539: flake.nix refuses a dirty self.rev, so the gate's Nix checks would
# otherwise never run while work is uncommitted. `git stash create` commits
# the working tree's tracked content without touching the index, the worktree
# or any ref; a clean tree yields nothing and falls back to HEAD. Untracked
# files are excluded, exactly as Nix excludes them from a dirty git flake.
set -euo pipefail

ledger_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repository_root="$(git -C "$ledger_root" rev-parse --show-toplevel)"
revision="$(git -C "$repository_root" stash create)"
if [[ -z "$revision" ]]; then
  revision="$(git -C "$repository_root" rev-parse HEAD)"
fi
printf 'git+file://%s?rev=%s\n' "$repository_root" "$revision"
