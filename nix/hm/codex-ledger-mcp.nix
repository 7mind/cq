{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;
  codexPromptRoot = import ../pkg/cq-assets/render-prompt-surface.nix {
    inherit pkgs lib;
    surface = "codex";
  };
  codexLedgerMcpRegistration =
    import ../lib/codex-ledger-mcp-registration.nix { inherit lib codexPromptRoot; };
in
{
  config = lib.mkIf cfg.enable {
    programs.codex.settings.mcp_servers.ledger = codexLedgerMcpRegistration (
      lib.hm.mcp.transformMcpServer {
        server = config.programs.mcp.servers.ledger;
      }
    );
  };
}
