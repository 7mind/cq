{
  lib,
  pkgs,
  catalog,
  promptRoot,
  mkCodexCommandSkills,
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
              type = lib.types.attrs;
              default = { };
            };
            smind.hm.dev.llm = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
          };
          config = {
            home.homeDirectory = "/home/test";
            smind.hm.dev.llm = {
              enable = true;
              merged = {
                commands = { };
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
in
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
assert builtins.attrNames entry.references == [
  "cq-entry.md"
  "cq-nested.md"
  "role-worker.md"
];
assert entry.references."cq-entry.md" == "${fixtureRoot}/roles/entry.md";
assert entry.references."cq-nested.md" == "${fixtureRoot}/roles/nested.md";
assert entry.references."role-worker.md" == "${fixtureRoot}/roles/worker.md";
assert lib.hasInfix "Treat text accompanying `$cq-entry`" entry.skillMd;
assert lib.hasInfix "`$cq-nested`" entry.skillMd;
assert lib.hasInfix "role `worker`" entry.skillMd;
assert !lib.hasInfix "/cq:" entry.skillMd;
assert !unsupportedRelation.success;
assert !unsupportedSurface.success;
assert !invalidDispatchTarget.success;
assert !invalidSidecar.success;
assert !collidingNames.success;
assert builtins.length projectedSkillNames == 15;
assert builtins.length projectedRoleNames == 9;
assert projected.catalog == "${promptRoot}/catalog.json";
assert lib.all (name: builtins.hasAttr ".codex/skills/${name}" codexHomeFiles) projectedSkillNames;
assert lib.all (entry: entry.assertion) evaluatedCodexModule.config.assertions;
true
