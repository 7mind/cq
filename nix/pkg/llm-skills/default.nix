# llm-skills — the shared SKILL.md set (progressive-disclosure skills) plus
# build-time meta.yaml validation. Split out of the former llm-prompts package
# (its context fragments now live in ../llm-contexts).
{
  lib,
  stdenvNoCC,
  yq-go,
}:
let
  skillNames = builtins.attrNames (
    lib.filterAttrs (_: t: t == "directory") (builtins.readDir ./skills)
  );

  mkSkill =
    name:
    "---\n"
    + builtins.readFile (./skills + "/${name}/meta.yaml")
    + "---\n\n"
    + builtins.readFile (./skills + "/${name}/content.md");

  validated = stdenvNoCC.mkDerivation {
    name = "llm-skills";
    src = ./.;

    nativeBuildInputs = [ yq-go ];

    doCheck = true;
    checkPhase = ''
      bash validate-skills.sh skills/*/meta.yaml
    '';

    installPhase = ''
      mkdir -p $out
      cp -r skills $out/skills
    '';

    meta = with lib; {
      description = "LLM agent skills (SKILL.md set) with build-time meta.yaml validation";
      license = [ licenses.mit ];
      maintainers = with maintainers; [ pshirshov ];
    };
  };
in
{
  # name -> SKILL.md content ('---\n<meta>---\n\n<content>'). Inline strings,
  # never store paths, so consumers don't trigger IFD on a store path at eval.
  skills = lib.genAttrs skillNames mkSkill;

  # Raw body of the `environment` skill's content.md — folded into the
  # pre-composed context for skill-less agents (see ../llm-contexts and the
  # flake's llm-context-with-env output).
  environmentContent = builtins.readFile ./skills/environment/content.md;

  # Build-time-validated derivation (skills meta.yaml checks); also carries the
  # skills tree under $out/skills for inspection.
  package = validated;
}
