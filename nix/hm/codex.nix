{ inputs, self }:
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;
  system = pkgs.stdenv.hostPlatform.system;
  promptRoot = self.packages.${system}.codex-prompt-root;
  codexBase = inputs.ponygirls.packages.${system}.codex;
  harnessEnv = import ../lib/codex-harness-env.nix { inherit lib; };
  codexWrapped = pkgs.symlinkJoin {
    name = "codex-cq";
    inherit (codexBase) version;
    passthru = {
      promptSurface = "codex";
      inherit promptRoot;
    };
    paths = [ codexBase ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      if [ ! -e "$out/bin/codex-code-mode-host" ]; then
        echo "codex-cq: missing codex-code-mode-host in $out/bin" >&2
        exit 1
      fi
      wrapProgram $out/bin/codex \
        --prefix PATH : "$out/bin" \
        --set CQ_PROMPT_SURFACE codex \
        --set CQ_HARNESS codex \
        --set CQ_PROMPT_ROOT ${promptRoot}
    '';
  };
  projection = (import ../lib/codex-command-skills.nix { inherit lib; }) {
    catalog = self.llmAssets.catalog;
    inherit promptRoot;
  };
  skillNameCollisions =
    lib.intersectLists
      (builtins.attrNames cfg.merged.skills)
      (builtins.attrNames projection.skills);
  mkCommandSkillPackage =
    skillName: spec:
    pkgs.runCommandLocal "${skillName}-codex-skill" { } (
      ''
        set -eu
        mkdir -p "$out/references"
        cp ${builtins.toFile "${skillName}-SKILL.md" spec.skillMd} "$out/SKILL.md"
      ''
      + lib.concatMapStringsSep "\n" (
        referenceName: ''
          cp ${spec.references.${referenceName}} "$out/references/${referenceName}"
        ''
      ) (builtins.attrNames spec.references)
    );
  commandSkillFiles = lib.mapAttrs' (
    skillName: source:
    lib.nameValuePair ".codex/skills/${skillName}" { inherit source; }
  ) (lib.mapAttrs mkCommandSkillPackage projection.skills);
  tomlLiteralDelimiter = "'''";
  mkAgentPackage =
    agentName: declaration:
    let
      header = pkgs.writeText "${agentName}-codex-agent-header" (
        "name = \"${declaration.name}\"\n"
        + "description = \"${declaration.description}\"\n"
        + "developer_instructions = ${tomlLiteralDelimiter}\n"
      );
    in
    pkgs.runCommandLocal "${agentName}-codex-agent" { } ''
      set -eu
      body=${declaration.developer_instructions}
      if grep -qF ${lib.escapeShellArg tomlLiteralDelimiter} "$body"; then
        echo "codex agent ${agentName}: role body contains a TOML multi-line literal delimiter" >&2
        exit 1
      fi
      {
        cat ${header}
        cat "$body"
        printf '\n%s\n' ${lib.escapeShellArg tomlLiteralDelimiter}
      } > "$out"
    '';
  agentFiles = lib.mapAttrs' (
    agentName: source:
    lib.nameValuePair ".codex/agents/${agentName}.toml" { inherit source; }
  ) (lib.mapAttrs mkAgentPackage projection.agents);
  withHarness = registration:
    lib.recursiveUpdate registration { env.CQ_HARNESS = "codex"; };
in
{
  config = lib.mkIf cfg.enable {
    programs.codex.package = lib.mkForce codexWrapped;
    programs.codex.settings.mcp_servers.ledger = lib.mkDefault (withHarness (
      lib.hm.mcp.transformMcpServer {
        server = config.programs.mcp.servers.ledger;
      }
    ));

    home.file = commandSkillFiles // agentFiles;

    assertions = [
      {
        assertion = skillNameCollisions == [ ];
        message =
          "Codex CQ command skills collide with shared skills: "
          + lib.concatStringsSep ", " skillNameCollisions;
      }
      {
        assertion = harnessEnv.exportsCodexHarness codexWrapped.buildCommand;
        message = "Codex wrapper does not export CQ_HARNESS=codex";
      }
    ];
  };
}
