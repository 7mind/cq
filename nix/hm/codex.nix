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

  assets = import ../pkg/cq-assets/assets.nix { inherit lib; };
  codexHarnessEnv = import ../lib/codex-harness-env.nix { inherit lib; };
  codexLedgerMcpRegistration =
    import ../lib/codex-ledger-mcp-registration.nix { inherit lib codexPromptRoot; };
  codexPromptRoot = import ../pkg/cq-assets/render-prompt-surface.nix {
    inherit pkgs lib;
    surface = "codex";
  };
  codexWrapped = pkgs.symlinkJoin {
    name = "codex-with-prompt-root";
    inherit (codexPkg) version;
    passthru = {
      promptSurface = "codex";
      promptRoot = codexPromptRoot;
    };
    paths = [ codexPkg ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/codex \
        --set CQ_PROMPT_SURFACE codex \
        --set CQ_HARNESS codex \
        --set CQ_PROMPT_ROOT ${codexPromptRoot}
    '';
  };
  mkCodexCommandSkills = import ../lib/codex-command-skills.nix { inherit lib; };
  codexProjection = mkCodexCommandSkills {
    catalog = assets.catalog;
    promptRoot = codexPromptRoot;
  };
  cqCommandSkillSpecs = codexProjection.skills;
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
          cp ${spec.references.${referenceName}} "$out/references/${referenceName}"
        ''
      ) (builtins.attrNames spec.references)
    );

  cqCommandSkillPackages = lib.mapAttrs mkCodexCommandSkillPackage cqCommandSkillSpecs;
  cqCommandSkillFiles = lib.mapAttrs' (
    skillName: source:
    lib.nameValuePair ".codex/skills/${skillName}" { inherit source; }
  ) cqCommandSkillPackages;

  # TOML's multi-line LITERAL delimiter. Held as a binding because a role body is
  # markdown: a literal string processes NO escapes, so backslashes and quotes in
  # the prompt survive byte-for-byte, which a basic (`"""`) string would mangle.
  # Kept out of the `''` build scripts below, where `'''` is nix's own escape for
  # `''` and would silently emit the wrong delimiter.
  tomlLiteralDelimiter = "'''";

  # defects:D178 half (b): render one dispatched role's global native-agent
  # declaration. The body is CONCATENATED at build time rather than interpolated,
  # so the rendered prompt root is not needed during evaluation.
  mkCodexAgentPackage =
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
        echo "codex agent ${agentName}: the role body contains a TOML multi-line literal delimiter" >&2
        exit 1
      fi
      {
        cat ${header}
        printf '%s\n' "$(cat "$body")"
        printf '%s\n' ${lib.escapeShellArg tomlLiteralDelimiter}
      } > "$out"
    '';

  cqAgentPackages = lib.mapAttrs mkCodexAgentPackage codexProjection.agents;
  # The GLOBAL $CODEX_HOME/agents dir — `~/.codex/agents/`, the one
  # researches:RS11 measured. NOT a repository-local `./.codex/agents/`, which is
  # advertised but unspawnable (openai/codex#26408).
  cqAgentFiles = lib.mapAttrs' (
    agentName: source:
    lib.nameValuePair ".codex/agents/${agentName}.toml" { inherit source; }
  ) cqAgentPackages;

  # Command bundles key entries as "<ns>/<name>"; flat slash-prompt harnesses
  # derive the command name from the filename stem, so fold "/" → ":" (matching
  # the same transform tools.nix uses for its collision assertion and Claude's
  # namespaced /plan:advance).
  commandKeyToStem = key: lib.replaceStrings [ "/" ] [ ":" ] key;
  catalogCommandKeys = map (
    role: "cq/${role.roleId}"
  ) (builtins.filter (
    role: role.roleKind == "orchestrator-command"
  ) assets.catalog);
  legacyPromptCommands = lib.filterAttrs (
    key: _: !(builtins.elem key catalogCommandKeys)
  ) cfg.merged.commands;

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
        package = codexWrapped;
        settings = {
          model = "gpt-5.6-sol";
          model_reasoning_effort = "xhigh";
          project_doc_fallback_filenames = [ "CLAUDE.md" ];
          features.multi_agent = true;
          features.fast_mode = false;
          features.steer = true;
          mcp_servers.ledger = codexLedgerMcpRegistration (
            lib.hm.mcp.transformMcpServer {
              server = config.programs.mcp.servers.ledger;
            }
          );
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
        {
          # T863: the packaged Codex wrapper must export CQ_HARNESS=codex (the
          # active configuration selector T861 wired into cq-config) alongside
          # its existing prompt-surface variables. symlinkJoin folds `postBuild`
          # into `buildCommand`, which IS on the resulting attrset, so inspect
          # that directly — this handle also fails if `postBuild` is ever
          # unwired from symlinkJoin, unlike a free-standing let-bound string.
          # T865: the check is the ANCHORED argument-triple predicate, shared
          # with the focused `codex-harness-env` flake check, so a CHANGED value
          # fails here too (`lib.hasInfix "CQ_HARNESS codex"` accepted
          # `--set CQ_HARNESS codex-foo`).
          assertion = codexHarnessEnv.exportsCodexHarness codexWrapped.buildCommand;
          message = "Codex wrapper does not export CQ_HARNESS=codex (the active configuration selector)";
        }
      ];
    }
    {
      # Materialize each catalog-projected Codex cq skill package as one
      # directory symlink. Codex follows symlinked skill directories but ignores
      # a real directory whose SKILL.md is itself a symlink. Retain legacy
      # prompts from every merged bundle separately.
      # Separate mkMerge element because the block above sets attrpath
      # `home.file."<path>"`, which can't coexist with a dynamic `home.file =
      # <attrs>` in one attribute set.
      # commandKeyToStem turns "plan/advance" into plan:advance.md; Codex
      # namespaces ~/.codex/prompts/*.md under its own "prompts:" prefix (stem
      # verbatim, no char filtering), so this surfaces as /prompts:plan:advance.
      # Dispatched roles stay in the immutable Codex prompt root and NO LONGER
      # enter any command skill (defects:D178 half (a)). Each is instead declared
      # as a global native agent under `.codex/agents/`, so its body reaches the
      # child through the collaboration transport and never through the parent.
      home.file =
        cqCommandSkillFiles
        // cqAgentFiles
        // lib.mapAttrs'
          (
            key: body: lib.nameValuePair ".codex/prompts/${commandKeyToStem key}.md" { text = body; }
          )
          legacyPromptCommands;
    }
  ]);
}
