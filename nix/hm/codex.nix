# Codex configuration for the LLM coding-agent harness, split out of
# dev-llm.nix. Configures the (downstream-provided) `programs.codex` module;
# the shared asset bundles / MCP registry / merged views come from the sibling
# tools.nix via `smind.hm.dev.llm.{enable,merged.*,…}`.
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;

  # codex pinned to the GitHub static-binary release (../pkg/codex), built
  # directly so the module does not depend on the consumer overriding
  # `pkgs.codex` via an overlay.
  codexPkg = pkgs.callPackage ../pkg/codex/package.nix { };

  mkCodexCommandSkills = import ../lib/codex-command-skills.nix { inherit lib; };
  cqCommandSkillSpecs = mkCodexCommandSkills cfg.merged.commands;
  skillNameCollisions =
    lib.intersectLists
      (builtins.attrNames cfg.merged.skills)
      (builtins.attrNames cqCommandSkillSpecs);

  mkCodexCommandSkillPackage =
    skillName: spec:
    pkgs.runCommandLocal "${skillName}-codex-skill" { } (
      ''
        set -eu
        mkdir -p "$out/references"
        cp ${builtins.toFile "${skillName}-SKILL.md" spec.skillMd} "$out/SKILL.md"
      ''
      + lib.concatMapStringsSep "\n" (
        referenceName: ''
          cp ${
            builtins.toFile "${skillName}-${referenceName}" spec.references.${referenceName}
          } "$out/references/${referenceName}"
        ''
      ) (builtins.attrNames spec.references)
    );

  cqCommandSkillPackages = lib.mapAttrs mkCodexCommandSkillPackage cqCommandSkillSpecs;
  cqCommandSkillFiles = lib.mapAttrs' (
    skillName: source:
    lib.nameValuePair ".codex/skills/${skillName}" { inherit source; }
  ) cqCommandSkillPackages;

  # Command bundles key entries as "<ns>/<name>"; flat slash-prompt harnesses
  # derive the command name from the filename stem, so fold "/" → ":" (matching
  # the same transform tools.nix uses for its collision assertion and Claude's
  # namespaced /plan:advance).
  commandKeyToStem = key: lib.replaceStrings [ "/" ] [ ":" ] key;

  # Wiring common to every skill-aware harness (see claude.nix); spread with
  # `//` into the programs.codex block (no key overlap).
  sharedAgentWiring = {
    enable = true;
    enableMcpIntegration = true;
    skills = cfg.merged.skills;
    context = cfg.merged.memoryText;
  };
in
{
  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      programs.codex = sharedAgentWiring // {
        package = codexPkg;
        settings = {
          model = "gpt-5.6-sol";
          model_reasoning_effort = "xhigh";
          project_doc_fallback_filenames = [ "CLAUDE.md" ];
          features.multi_agent = true;
          features.fast_mode = false;
          features.steer = true;
        };
      };

      home.file.".codex/config.toml".force = true;

      assertions = [
        {
          assertion = skillNameCollisions == [ ];
          message =
            "Codex cq command skills collide with shared skills: "
            + lib.concatStringsSep ", " skillNameCollisions;
        }
      ];
    }
    {
      # Materialize each Codex-specific cq skill package as one directory
      # symlink. Codex follows symlinked skill directories but ignores a real
      # directory whose SKILL.md is itself a symlink. Retain legacy prompts.
      # Separate mkMerge element because the block above sets attrpath
      # `home.file."<path>"`, which can't coexist with a dynamic `home.file =
      # <attrs>` in one attribute set.
      # commandKeyToStem turns "plan/advance" into plan:advance.md; Codex
      # namespaces ~/.codex/prompts/*.md under its own "prompts:" prefix (stem
      # verbatim, no char filtering), so this surfaces as /prompts:plan:advance.
      # Codex agents have no canonical markdown home and are intentionally not
      # materialized (Claude receives them via its agents option).
      home.file =
        cqCommandSkillFiles
        // lib.mapAttrs'
          (
            key: body: lib.nameValuePair ".codex/prompts/${commandKeyToStem key}.md" { text = body; }
          )
          cfg.merged.commands;
    }
  ]);
}
