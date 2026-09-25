{
  lib,
  pkgs,
  inputs,
  self,
}:
let
  testSelf = {
    inherit (self) llmAssets;
    packages.${pkgs.stdenv.hostPlatform.system}.cq =
      pkgs.writeShellScriptBin "cq-test" "exit 0";
  };
  toolsModule = import (inputs.ponygirls.outPath + "/nix/hm/tools.nix") {
    inputs = inputs.ponygirls.inputs;
  };
  integrationModule = import ../hm/integration.nix { self = testSelf; };
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
        integrationModule
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
                type = lib.types.submodule {
                  options = {
                    enable = lib.mkOption {
                      type = lib.types.bool;
                      default = false;
                    };
                    servers = lib.mkOption {
                      type = lib.types.attrsOf lib.types.anything;
                      default = { };
                    };
                  };
                };
                default = { };
              };
              xdg.configHome = lib.mkOption {
                type = lib.types.str;
              };
              xdg.stateHome = lib.mkOption {
                type = lib.types.str;
              };
              xdg.configFile = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
              };
              smind.hm.dev.llm.yolo.extraReadOnlyPaths = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
              };
              smind.hm.dev.llm.yolo.extraReadWritePaths = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
              };
              smind.hm.dev.llm.yolo.piSharedAssets = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
              };
            };
            config = {
              smind.hm.dev.llm.enable = true;
              smind.hm.dev.llm.cq.globalConfig = globalConfig;
              xdg.configHome = configHome;
              xdg.stateHome = "/home/test/.local/state";
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
assert builtins.elem "/home/test/.local/state/cq" configured.config.smind.hm.dev.llm.yolo.extraReadWritePaths;
assert builtins.elem "/home/test/.config/cq" configured.config.smind.hm.dev.llm.yolo.extraReadOnlyPaths;
assert builtins.elem "cq-agents" configured.config.smind.hm.dev.llm.yolo.piSharedAssets;
assert configured.config.programs.mcp.servers.ledger.args == [ "mcp" ];
{
  passed = true;
  inherit configBody;
}
