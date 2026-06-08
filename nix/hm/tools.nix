# Reusable shared infrastructure for the LLM coding-agent harness, split out of
# dev-llm.nix. Owns the cross-agent surface that the per-agent modules
# (claude.nix / codex.nix / pi.nix) and the sandbox (yolo.nix) build on:
#
#   * the master `smind.hm.dev.llm.enable` switch,
#   * the contributed-asset-bundle merge (skills/commands/agents/context) and
#     the read-only `smind.hm.dev.llm.merged.*` views the agent modules consume,
#   * the shared `programs.mcp` registry (codegraph + ledger), and
#   * the common host packages (gh, node, codegraph, ledger CLIs, sandbox glue).
#
# Curried over the flake's `inputs` (codegraph, claude-code-sandbox) and `self`
# (the ledger packages + llmAssets this flake contributes).
{ inputs, self }:
{ config
, lib
, pkgs
, ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  isLinux = pkgs.stdenv.hostPlatform.isLinux;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;

  codegraphPkg = inputs.codegraph.packages.${system}.default;

  # Prompt content lives in two sibling packages: pkg/llm-skills (SKILL.md set
  # + build-time validation) and pkg/llm-contexts (general context + Pi's
  # operating manual). Environment guidance is a skill for skill-aware agents;
  # skill-less agents (consumers that can't load SKILL.md trees) get the
  # pre-composed llm-context-with-env.
  llmSkills = pkgs.callPackage ../pkg/llm-skills/default.nix { };
  llmContexts = pkgs.callPackage ../pkg/llm-contexts/default.nix { };

  # The ledger suite lives in THIS flake (cq). Re-use its packages + the LLM
  # asset bundle it contributes.
  ledgerPkgs = self.packages.${system};
  ledgerPkg = ledgerPkgs.ledger-mcp;
  ledgerAssets = self.llmAssets;
  # The ledger-* CLI tools (ledger-mcp/ledger-tui/ledger-web) put on PATH so
  # the agents (and the user) can drive the ledger directly, not only via MCP.
  ledgerTools = [
    ledgerPkgs.ledger-mcp
    ledgerPkgs.ledger-tui
    ledgerPkgs.ledger-web
  ];

  # Canonical llmAssets bundle from the two in-repo packages: skills from
  # llm-skills, general context from llm-contexts. Symmetric with
  # ledger.llmAssets. (Commands/agents come from the ledger bundle; none here.)
  llmPromptsBundle = {
    skills = llmSkills.skills;
    commands = { };
    agents = { };
    context = [ llmContexts.general ];
  };

  # Aggregate every contributed asset bundle into one merged view. Mirrors
  # the memorySections list-contribution idiom: any module/flake appends a
  # bundle to smind.hm.dev.llm.assetBundles and the materializer below fans
  # it into every agent. Later bundles win on key collisions (`//`).
  assetBundles = config.smind.hm.dev.llm.assetBundles;
  mergeAttrField = field: lib.foldl' (acc: b: acc // b.${field}) { } assetBundles;
  mergedSkills = mergeAttrField "skills";
  mergedCommands = mergeAttrField "commands";
  mergedAgents = mergeAttrField "agents";
  mergedContext = lib.concatMap (b: b.context) assetBundles;
  claudeMemoryText = lib.concatStringsSep "\n\n" config.smind.hm.dev.llm.memorySections;

  # Command bundles key entries as "<ns>/<name>" (e.g. "plan/advance").
  # Slash-prompt harnesses (Pi, Codex) discover templates from a flat,
  # non-recursive directory and derive the command name from the filename stem,
  # so "/" must fold into a separator surviving as one token. ":" matches
  # Claude's namespaced slash commands (/plan:advance) and keeps distinct keys
  # distinct (plain baseNameOf collapses plan/advance, implement/advance,
  # investigate/advance onto one "advance.md"). Pi's harness applies the same
  # transform internally (see mk-agent-harness).
  commandKeyToStem = key: lib.replaceStrings [ "/" ] [ ":" ] key;
in
{
  options = {
    smind.hm.dev.llm.enable = lib.mkEnableOption "LLM development environment variables";

    # Read-only views of the merged asset bundles, exposed so sibling modules
    # can reuse the same skill set and memory text without re-folding
    # `assetBundles`/`memorySections`.
    smind.hm.dev.llm.merged.skills = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      readOnly = true;
      description = "Merged skill set across all contributed asset bundles.";
    };

    smind.hm.dev.llm.merged.commands = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      readOnly = true;
      description = "Merged slash-command set across all contributed bundles.";
    };

    smind.hm.dev.llm.merged.agents = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      readOnly = true;
      description = "Merged subagent set across all contributed bundles.";
    };

    smind.hm.dev.llm.merged.memoryText = lib.mkOption {
      type = lib.types.lines;
      readOnly = true;
      description = "Concatenated Claude/Codex/Pi memory text (AGENTS.md).";
    };

    smind.hm.dev.llm.memorySections = lib.mkOption {
      type = lib.types.listOf lib.types.lines;
      default = [ ];
      description = "Sections used to build Claude/Codex memory text.";
    };

    smind.hm.dev.llm.assetBundles = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            skills = lib.mkOption {
              type = lib.types.attrsOf lib.types.lines;
              default = { };
              description = "name -> SKILL.md content ('---\\nmeta---\\n\\ncontent').";
            };
            commands = lib.mkOption {
              type = lib.types.attrsOf lib.types.lines;
              default = { };
              description = "key '<ns>/<name>' -> markdown body (slash command /<ns>:<name>).";
            };
            agents = lib.mkOption {
              type = lib.types.attrsOf lib.types.lines;
              default = { };
              description = "name -> subagent definition (with name/description/tools frontmatter).";
            };
            context = lib.mkOption {
              type = lib.types.listOf lib.types.lines;
              default = [ ];
              description = "CLAUDE.md/AGENTS.md memory fragments.";
            };
          };
        }
      );
      default = [ ];
      description = ''
        Contributed LLM asset bundles (cross-repo llmAssets shape). Any
        module or flake appends a bundle here; a single materializer fans
        every asset type (skills, commands, agents, context) into every
        agent's filesystem layout globally. Mirrors the memorySections
        list-contribution idiom.
      '';
    };

    smind.hm.dev.llm.coAuthored.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Include Co-Authored-By: <llm> in commit message";
    };

    smind.hm.dev.llm.fullscreenTui.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable fullscreen TUI mode for agent CLIs that support it";
    };
  };

  config = lib.mkMerge [
    {
      # Read-only merged views for sibling modules to reuse.
      smind.hm.dev.llm.merged = {
        skills = mergedSkills;
        commands = mergedCommands;
        agents = mergedAgents;
        memoryText = claudeMemoryText;
      };
      # Base context (and any other bundle context fragments) flow in via the
      # asset bundles; mkBefore keeps them ahead of host/user-specific
      # sections appended elsewhere with mkAfter.
      smind.hm.dev.llm.memorySections = lib.mkBefore mergedContext;
      # In-repo prompts first (base), ledger after (may override on key
      # collisions). External modules append further bundles elsewhere.
      smind.hm.dev.llm.assetBundles = lib.mkBefore [ llmPromptsBundle ledgerAssets ];
    }
    (lib.mkIf config.smind.hm.dev.llm.enable {
      # commandKeyToStem ("/"→":") is injective only while no two bundle keys
      # share a stem. Fail-fast if a future bundle introduces a collision
      # (e.g. "a/b" and "a:b"), which would otherwise silently overwrite one
      # slash-prompt for Pi and Codex.
      assertions =
        let
          keys = builtins.attrNames mergedCommands;
          stemOf = lib.groupBy commandKeyToStem keys;
          collisions = lib.filterAttrs (_stem: ks: lib.length ks > 1) stemOf;
        in
        [
          {
            assertion = collisions == { };
            message =
              "smind.hm.dev.llm: command bundle keys collide after commandKeyToStem "
              + "('/'→':'): "
              + lib.concatStringsSep "; " (
                lib.mapAttrsToList (stem: ks: "${stem} ⇐ ${lib.concatStringsSep ", " ks}") collisions
              );
          }
        ];

      # CodeGraph MCP server — declared once, pulled into each agent CLI via
      # its enableMcpIntegration option below. Started on-demand per project by
      # the agent; building the per-project index is a manual `codegraph init -i`.
      programs.mcp = {
        enable = true;
        servers.codegraph = {
          command = "${codegraphPkg}/bin/codegraph";
          args = [ "serve" "--mcp" ];
        };
        # markdown-ledger MCP server. stdio transport; --cwd defaults to the
        # agent's process CWD, so one global server serves a per-project
        # ledger. Pass "--http" "PORT" instead for a shared HTTP instance.
        servers.ledger = {
          command = "${ledgerPkg}/bin/ledger-mcp";
          args = [ ];
        };
      };

      # Shared host packages. The bubblewrap sandbox + `yolo` wrapper live in
      # the sibling yolo.nix module; reattach-llm is a Linux-only tmux reattach
      # helper for the agent terminals (not a sandbox concern, so it stays here).
      home.packages = [
        pkgs.gh
        pkgs.nodejs # required by claude-code plugins (.mjs scripts)
        codegraphPkg # for `codegraph init -i` per-project bootstrap
      ]
      ++ ledgerTools
      ++ lib.optionals isDarwin [
        inputs.claude-code-sandbox.packages.${system}.default
      ]
      ++ lib.optionals isLinux [
        (pkgs.callPackage ../pkg/reattach-llm/default.nix { })
      ];
    })
  ];
}
