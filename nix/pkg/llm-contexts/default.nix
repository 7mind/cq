# llm-contexts — the global context fragments (CLAUDE.md / AGENTS.md memory and
# the Pi operating manual). Split out of the former llm-prompts package (skills
# now live in ../llm-skills).
#
#   general-context.md  base global context shared by every agent
#   pi-context.md       Pi's repo-agnostic operating manual, appended INSIDE
#                       Pi's system prompt (~/.pi/agent/APPEND_SYSTEM.md)
{
  lib,
  stdenvNoCC,
}:
let
  general = builtins.readFile ./general-context.md;
  pi = builtins.readFile ./pi-context.md;

  package = stdenvNoCC.mkDerivation {
    name = "llm-contexts";
    src = ./.;
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out
      cp general-context.md pi-context.md $out/
    '';
    meta = with lib; {
      description = "LLM agent global context fragments (general + Pi operating manual)";
      license = [ licenses.mit ];
      maintainers = with maintainers; [ pshirshov ];
    };
  };
in
{
  # Inline-string fragments (never store paths), mirroring the skills contract.
  inherit general pi package;
}
