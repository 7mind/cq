#!/usr/bin/env bash
# D539: flake.nix refuses a dirty self.rev, so the gate's Nix checks would
# otherwise never run while work is uncommitted. `git stash create` commits
# the working tree's tracked content without touching the worktree or any ref;
# a clean tree uses HEAD. Untracked files are excluded, exactly as Nix excludes
# them from a dirty git flake.
#
# Cleanliness is decided by `git status`, which compares content. `git stash
# create` alone exits 1 silently when a tracked file changed only its mtime:
# it sees a stat change, refreshes the index, and then finds nothing to stash.
set -euo pipefail

ledger_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repository_root="$(git -C "$ledger_root" rev-parse --show-toplevel)"
if [[ -z "$(git -C "$repository_root" status --porcelain --untracked-files=no)" ]]; then
  revision="$(git -C "$repository_root" rev-parse HEAD)"
else
  revision="$(git -C "$repository_root" stash create)"
fi
printf 'git+file://%s?rev=%s\n' "$repository_root" "$revision"
