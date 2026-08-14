{
  lib,
  pkgs,
  inputs,
  self,
}:
let
  toolsModule = import ../hm/tools.nix { inherit inputs self; };
  configBody = ''
    reviewers = ["reviewer-a", "reviewer-b"]
  '';
  evaluate =
    {
      globalConfig,
      configHome,
    }:
    lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        toolsModule
        (
          { lib, ... }:
          {
            options = {
              assertions = lib.mkOption {
                type = lib.types.listOf lib.types.attrs;
                default = [ ];
              };
              home.packages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              programs.mcp = lib.mkOption {
                type = lib.types.attrs;
                default = { };
              };
              xdg.configHome = lib.mkOption {
                type = lib.types.str;
              };
              xdg.configFile = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
              };
            };
            config = {
              smind.hm.dev.llm.enable = true;
              smind.hm.dev.llm.cq.globalConfig = globalConfig;
              xdg.configHome = configHome;
            };
          }
        )
      ];
    };
  unset = evaluate {
    globalConfig = null;
    configHome = "/home/test/.config";
  };
  configured = evaluate {
    globalConfig = configBody;
    configHome = "/home/test/.config";
  };
  customHome = evaluate {
    globalConfig = configBody;
    configHome = "/home/test/config-root";
  };
in
assert !(builtins.hasAttr "cq/cq.toml" unset.config.xdg.configFile);
assert configured.config.xdg.configFile."cq/cq.toml".text == configBody;
assert customHome.config.xdg.configHome == "/home/test/config-root";
assert customHome.config.xdg.configFile."cq/cq.toml".text == configBody;
{
  passed = true;
  inherit configBody;
}
