# Portable home-manager module for the LLM coding-agent harness (Claude Code,
# Codex, Pi) plus the shared asset-bundle / MCP infrastructure and the
# bubblewrap `yolo` sandbox. Extracted from 7mind/nix-config so it can be
# consumed by any home-manager setup via `inputs.cq.homeManagerModules.dev-llm`.
#
# This file is a thin aggregator: the implementation is split across focused
# sibling modules, all sharing the `smind.hm.dev.llm.*` option namespace —
#
#   tools.nix   reusable shared infrastructure: the master `enable` switch, the
#               asset-bundle merge + `merged.*` views, the `programs.mcp`
#               registry, and the common host packages. (needs inputs + self)
#   claude.nix  Claude Code configuration (programs.claude-code).
#   codex.nix   Codex configuration (programs.codex).
#   pi.nix      Pi configuration (programs.pi); also carries the in-flake
#               programs.pi module definition (shared factory + Pi options).
#   yolo.nix    the bubblewrap `yolo` sandbox wrapper + its options. (needs inputs)
#
# Curried over the flake's own `inputs` (codegraph, claude-code-sandbox) and
# `self` (this flake — for the ledger packages/assets it re-uses).
{ inputs, self }:
{
  imports = [
    (import ./tools.nix { inherit inputs self; })
    ./claude.nix
    ./codex.nix
    ./pi.nix
    (import ./yolo.nix { inherit inputs; })
  ];
}
