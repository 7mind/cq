{
  lib,
  pkgs,
  commands,
  mkCodexCommandSkills,
}:
let
  mkFixtureBody =
    description: instructions:
    "---\n"
    + "description: ${description}\n"
    + "argument-hint: <value>\n"
    + "allowed-tools: Read\n"
    + "---\n\n"
    + instructions
    + "\n";

  advanceBody = mkFixtureBody "Fixture workflow." "Run /cq:plan:advance inline with $ARGUMENTS.";
  planAdvanceBody = mkFixtureBody "Advance planning." "Tell the user to re-run /cq:plan.";
  planBody = mkFixtureBody "Start planning." "Plan.";

  projected = mkCodexCommandSkills {
    "cq/advance" = advanceBody;
    "cq/plan" = planBody;
    "cq/plan/advance" = planAdvanceBody;
    "other/ignored" = planBody;
  };

  advance = projected.cq-advance;
  advanceReference = advance.references."cq-advance.md";
  planAdvanceReference = advance.references."cq-plan-advance.md";
  missingDescription = builtins.tryEval (
    builtins.deepSeq (mkCodexCommandSkills { "cq/missing" = "No metadata.\n"; }) true
  );
  collidingNames = builtins.tryEval (
    builtins.deepSeq (mkCodexCommandSkills {
      "cq/foo-bar" = planBody;
      "cq/foo/bar" = planBody;
    }) true
  );
  unresolvedReference = builtins.tryEval (
    builtins.deepSeq (
      mkCodexCommandSkills {
        "cq/advance" = mkFixtureBody "Broken workflow." "Run /cq:missing inline.";
      }
    ) true
  );

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
                inherit commands;
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
assert
  builtins.attrNames projected == [
    "cq-advance"
    "cq-plan"
    "cq-plan-advance"
  ];
assert lib.hasPrefix ''
  ---
  name: cq-advance
  description: "Fixture workflow. Invoke explicitly as $cq-advance."
  ---
'' advance.skillMd;
assert lib.hasInfix "Treat text accompanying `$cq-advance` in the user's request as"
  advance.skillMd;
assert lib.hasInfix "When a source says to run or execute one **INLINE**"
  advance.skillMd;
assert
  builtins.attrNames advance.references == [
    "cq-advance.md"
    "cq-plan-advance.md"
    "cq-plan.md"
  ];
assert lib.hasInfix "$cq-plan-advance" advanceReference;
assert lib.hasInfix "$cq-plan" planAdvanceReference;
assert !lib.hasInfix "$cq-plan:advance" advanceReference;
assert !lib.hasInfix "/cq:" advance.skillMd;
assert lib.all (reference: !lib.hasInfix "/cq:" reference) (
  builtins.attrValues advance.references
);
assert lib.hasInfix "/cq:plan:advance" advanceBody;
assert !missingDescription.success;
assert !collidingNames.success;
assert !unresolvedReference.success;
assert builtins.hasAttr ".codex/skills/cq-advance/SKILL.md" codexHomeFiles;
assert
  builtins.hasAttr ".codex/skills/cq-advance/references/cq-plan-advance.md"
    codexHomeFiles;
assert builtins.hasAttr ".codex/prompts/cq:advance.md" codexHomeFiles;
assert
  !lib.hasInfix "/cq:"
    codexHomeFiles.".codex/skills/cq-advance/references/cq-advance.md".text;
assert lib.all (entry: entry.assertion) evaluatedCodexModule.config.assertions;
true
