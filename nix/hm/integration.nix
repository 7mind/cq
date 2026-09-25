{ self }:
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;
  system = pkgs.stdenv.hostPlatform.system;
  cqPackage = self.packages.${system}.cq;
  genericAssets = {
    inherit (self.llmAssets) skills context;
    commands = { };
    agents = { };
  };
in
{
  options.smind.hm.dev.llm.cq.globalConfig = lib.mkOption {
    type = lib.types.nullOr lib.types.lines;
    default = null;
    description = ''
      Optional global cq.toml content installed through
      xdg.configFile."cq/cq.toml". The [ledger] and [project] tables are
      local-only; configure their backend, projectId, and name values in each
      repository's cq.toml instead.
    '';
  };

  config = lib.mkMerge [
    {
      # CQ's rendered role surfaces are projected by the agent-specific
      # modules below. Only the generic skills and context enter Ponygirls'
      # cross-agent asset materializer.
      smind.hm.dev.llm.assetBundles = lib.mkAfter [ genericAssets ];
    }
    (lib.mkIf cfg.enable {
      programs.mcp.servers.ledger = {
        command = "${cqPackage}/bin/cq";
        args = [ "mcp" ];
      };

      home.packages = [ cqPackage ];

      # Ponygirls exposes generic sandbox path contributions. CQ owns the
      # policy decision that its state is writable and its global config is
      # read-only.
      smind.hm.dev.llm.yolo.extraReadWritePaths = lib.mkAfter [ "${config.xdg.stateHome}/cq" ];
      smind.hm.dev.llm.yolo.extraReadOnlyPaths = lib.mkAfter [ "${config.xdg.configHome}/cq" ];
      smind.hm.dev.llm.yolo.piSharedAssets = lib.mkAfter [ "cq-agents" ];
    })
    (lib.mkIf (cfg.enable && cfg.cq.globalConfig != null) {
      xdg.configFile."cq/cq.toml".text = cfg.cq.globalConfig;
    })
  ];
}
