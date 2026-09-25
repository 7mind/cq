{ inputs, self }:
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;
  system = pkgs.stdenv.hostPlatform.system;
  promptRoot = self.packages.${system}.claude-prompt-root;
  promptHomeFiles = lib.listToAttrs (
    map (
      role:
      let
        destination =
          if role.roleKind == "dispatched-subagent" then
            "${config.programs.claude-code.configDir}/agents/${role.roleId}.md"
          else
            "${config.programs.claude-code.configDir}/commands/cq/${role.roleId}.md";
      in
      lib.nameValuePair destination {
        source = "${promptRoot}/roles/${role.roleId}.md";
      }
    ) promptRoot.promptCatalog
  );
  claudeBase = inputs.ponygirls.packages.${system}.claude-code;
  claudeWrapped = pkgs.symlinkJoin {
    name = "claude-code-cq";
    inherit (claudeBase) version;
    passthru = {
      promptSurface = "claude";
      inherit promptRoot;
    };
    paths = [ claudeBase ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/claude \
        --set-default DISABLE_AUTOUPDATER 1 \
        --set CQ_PROMPT_SURFACE claude \
        --set CQ_PROMPT_ROOT ${promptRoot}
    '';
  };
  stopGateHook = pkgs.writeShellScript "claude-stop-advance-gate" ''
    set -u
    if [ -z "''${CLAUDE_CODE_SESSION_ID:-}" ]; then
      exit 0
    fi
    verdict="$(cq advance-gate --session "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD")"
    gate_status=$?
    if [ "$gate_status" -ne 0 ]; then
      printf '%s' "$verdict" | ${pkgs.jq}/bin/jq -c \
        '{decision: "block", reason: .reason}'
    fi
    exit 0
  '';
in
{
  config = lib.mkIf cfg.enable {
    programs.claude-code.package = lib.mkForce claudeWrapped;
    programs.claude-code.settings.hooks.Stop = [
      {
        matcher = "*";
        hooks = [
          {
            type = "command";
            command = "${stopGateHook}";
          }
        ];
      }
    ];
    home.file = promptHomeFiles;
  };
}
