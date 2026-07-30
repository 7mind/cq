{
  lib,
  pkgs,
  catalog,
  commands,
  promptRoot,
  mkCodexCommandSkills,
  ledgerMcpRegistration,
}:
let
  command =
    roleId: relations:
    {
      inherit roleId;
      roleKind = "orchestrator-command";
      name = "/cq:${lib.replaceStrings [ "/" ] [ ":" ] roleId}";
      canonicalSource = "commands/cq/${roleId}.md";
      surfaces = [
        "claude"
        "codex"
        "pi"
      ];
      sidecar = null;
      dispatchRelations = relations;
    };
  agent =
    roleId:
    {
      inherit roleId;
      roleKind = "dispatched-subagent";
      name = roleId;
      canonicalSource = "agents/${roleId}.md";
      surfaces = [
        "claude"
        "codex"
        "pi"
      ];
      sidecar.schemaRoleId = roleId;
      dispatchRelations = [ ];
    };
  recursion = targetRoleId: {
    kind = "recursion";
    inherit targetRoleId;
  };
  dispatch = targetRoleId: {
    kind = "dispatch";
    inherit targetRoleId;
  };

  fixtureCatalog = [
    (agent "worker")
    (command "entry" [
      (recursion "nested")
      (dispatch "worker")
    ])
    (command "nested" [ (recursion "entry") ])
  ];
  fixtureRoot = pkgs.runCommandLocal "codex-prompt-fixture" { } ''
    mkdir -p "$out/roles"
    touch "$out/catalog.json" "$out/roles/entry.md" \
      "$out/roles/nested.md" "$out/roles/worker.md"
  '';
  fixture = mkCodexCommandSkills {
    catalog = fixtureCatalog;
    promptRoot = fixtureRoot;
  };
  entry = fixture.skills.cq-entry;

  unsupportedRelation = builtins.tryEval (
    builtins.deepSeq (
      mkCodexCommandSkills {
        catalog = [
          (command "entry" [
            {
              kind = "shellout";
              targetRoleId = "entry";
            }
          ])
        ];
        promptRoot = fixtureRoot;
      }
    ) true
  );
  unsupportedSurface = builtins.tryEval (
    builtins.deepSeq (
      mkCodexCommandSkills {
        catalog = [
          ((command "entry" [ ]) // { surfaces = [ "claude" ]; })
        ];
        promptRoot = fixtureRoot;
      }
    ) true
  );
  invalidDispatchTarget = builtins.tryEval (
    builtins.deepSeq (
      mkCodexCommandSkills {
        catalog = [
          (command "entry" [ (dispatch "nested") ])
          (command "nested" [ ])
        ];
        promptRoot = fixtureRoot;
      }
    ) true
  );
  invalidSidecar = builtins.tryEval (
    builtins.deepSeq (
      mkCodexCommandSkills {
        catalog = [
          ((agent "worker") // { sidecar.schemaRoleId = "other"; })
        ];
        promptRoot = fixtureRoot;
      }
    ) true
  );
  collidingNames = builtins.tryEval (
    builtins.deepSeq (
      mkCodexCommandSkills {
        catalog = [
          (command "foo-bar" [ ])
          (command "foo/bar" [ ])
        ];
        promptRoot = fixtureRoot;
      }
    ) true
  );

  projected = mkCodexCommandSkills {
    inherit catalog promptRoot;
  };
  projectedSkillNames = builtins.attrNames projected.skills;
  projectedRoleNames = builtins.attrNames projected.roles;
  projectedAgentNames = builtins.attrNames projected.agents;
  projectedAgentPaths = map (name: ".codex/agents/${name}.toml") projectedAgentNames;
  projectedCommandPromptPaths = map (
    role: ".codex/prompts/cq:${lib.replaceStrings [ "/" ] [ ":" ] role.roleId}.md"
  ) (builtins.filter (role: role.roleKind == "orchestrator-command") catalog);
  sentinelPromptPath = ".codex/prompts/other:sentinel.md";
  sentinelPromptBody = "Unrelated legacy prompt.\n";

  evaluatedCodexModule = lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      ../hm/codex.nix
      (
        { lib, ... }:
        {
          options = {
            home.homeDirectory = lib.mkOption { type = lib.types.str; };
            home.file = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.anything;
              default = [ ];
            };
            programs.codex = lib.mkOption {
              type = lib.types.submodule {
                options = {
                  enable = lib.mkOption { type = lib.types.bool; };
                  enableMcpIntegration = lib.mkOption { type = lib.types.bool; };
                  package = lib.mkOption { type = lib.types.package; };
                  skills = lib.mkOption { type = lib.types.anything; };
                  context = lib.mkOption { type = lib.types.anything; };
                  settings = lib.mkOption {
                    type = (pkgs.formats.toml { }).type;
                    default = { };
                  };
                };
              };
              default = { };
            };
            smind.hm.dev.llm = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
          };
          config = {
            home.homeDirectory = "/home/test";
            programs.codex.settings.mcp_servers.ledger = ledgerMcpRegistration;
            smind.hm.dev.llm = {
              enable = true;
              merged = {
                commands = commands // {
                  "other/sentinel" = sentinelPromptBody;
                };
                skills = { };
                memoryText = "";
              };
            };
          };
        }
      )
    ];
  };
  codexHomeFiles = evaluatedCodexModule.config.home.file;
  codexPackage = evaluatedCodexModule.config.programs.codex.package;
  codexMcpRegistration =
    evaluatedCodexModule.config.programs.codex.settings.mcp_servers.ledger;
in
{
  package = codexPackage;
  mcpRegistration = codexMcpRegistration;
  # The RENDERED global native-agent declarations (defects:D178 half (b)), keyed by
  # agent name. Surfaced so a flake check can build and inspect the actual TOML:
  # evaluation alone only instantiates these derivations, and the writer's quoting
  # is exactly the part that eval cannot prove.
  agentFiles = lib.listToAttrs (
    map (
      name: lib.nameValuePair name codexHomeFiles.".codex/agents/${name}.toml".source
    ) projectedAgentNames
  );
  agentNames = projectedAgentNames;
  passed =
    assert builtins.attrNames fixture.skills == [
      "cq-entry"
      "cq-nested"
    ];
    assert fixture.roles.worker.sidecar.schemaRoleId == "worker";
    assert entry.roleIds == [
      "worker"
      "entry"
      "nested"
    ];
    # defects:D178 half (a): the dispatched role `worker` is in the closure
    # (roleIds above) but is NEITHER advertised NOR shipped as a reference. Only
    # the command roles are.
    assert builtins.attrNames entry.references == [
      "cq-entry.md"
      "cq-nested.md"
    ];
    assert entry.references."cq-entry.md" == "${fixtureRoot}/roles/entry.md";
    assert entry.references."cq-nested.md" == "${fixtureRoot}/roles/nested.md";
    assert !(builtins.hasAttr "role-worker.md" entry.references);
    assert lib.hasInfix "Treat text accompanying `$cq-entry`" entry.skillMd;
    assert lib.hasInfix "`$cq-nested`" entry.skillMd;
    assert !lib.hasInfix "role `worker`" entry.skillMd;
    assert !lib.hasInfix "references/role-worker.md" entry.skillMd;
    assert !lib.hasInfix "/cq:" entry.skillMd;
    # defects:D178 half (b): the same role IS declared as a global native agent,
    # carrying exactly the three keys researches:RS11 ARM 3-real measured.
    assert builtins.attrNames fixture.agents == [ "worker" ];
    assert builtins.attrNames fixture.agents.worker == [
      "description"
      "developer_instructions"
      "name"
    ];
    assert fixture.agents.worker.name == "worker";
    assert fixture.agents.worker.developer_instructions == "${fixtureRoot}/roles/worker.md";
    assert lib.hasInfix "worker" fixture.agents.worker.description;
    assert !unsupportedRelation.success;
    assert !unsupportedSurface.success;
    assert !invalidDispatchTarget.success;
    assert !invalidSidecar.success;
    assert !collidingNames.success;
    assert builtins.length projectedSkillNames == 15;
    assert builtins.length projectedRoleNames == 9;
    assert projectedAgentNames == projectedRoleNames;
    assert projected.catalog == "${promptRoot}/catalog.json";
    assert lib.all (name: builtins.hasAttr ".codex/skills/${name}" codexHomeFiles) projectedSkillNames;
    # Every dispatched role reaches the GLOBAL ~/.codex/agents/ dir — the one
    # researches:RS11 measured, not a repository-local ./.codex/agents/ (which is
    # advertised but unspawnable, openai/codex#26408).
    assert lib.all (path: builtins.hasAttr path codexHomeFiles) projectedAgentPaths;
    # No dispatched role body is shipped into any command skill any more.
    assert lib.all (
      skillName: !(lib.any (name: lib.hasPrefix "role-" name) (
        builtins.attrNames projected.skills.${skillName}.references
      ))
    ) projectedSkillNames;
    assert lib.all (path: !(builtins.hasAttr path codexHomeFiles)) projectedCommandPromptPaths;
    assert codexHomeFiles.${sentinelPromptPath}.text == sentinelPromptBody;
    assert codexPackage.promptSurface == "codex";
    assert codexPackage.promptRoot == promptRoot;
    assert lib.all (entry: entry.assertion) evaluatedCodexModule.config.assertions;
    true;
}
