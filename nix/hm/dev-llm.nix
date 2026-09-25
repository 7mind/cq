{ inputs, self }:
{
  imports = [
    inputs.ponygirls.homeManagerModules.dev-llm
    (import ./integration.nix { inherit self; })
    (import ./claude.nix { inherit inputs self; })
    (import ./codex.nix { inherit inputs self; })
    (import ./pi.nix { inherit inputs self; })
  ];
}
