# Normalized LLM-asset bundle for this repo, consumed by a home-manager
# materializer (e.g. 7mind/nix-config) as `inputs.<this>.llmAssets`.
#
# Pure, eval-time, IFD-FREE: every value is read with builtins.readFile /
# readDir over THIS flake's source tree (no derivation output is read), so a
# consumer can splice the attrset straight into module config without forcing a
# build. The shape is the cross-repo contract — keep it stable:
#
#   { skills   = { <name>      = "<meta+content string>"; };
#     commands = { "<ns>/<name>" = "<file body>"; };   # → /<ns>:<name>
#     agents   = { <name>      = "<file body>"; };      # subagent defs
#     context  = [ "<CLAUDE.md / AGENTS.md fragment>" ]; }
#
# Directory convention under ./llm:
#   commands/<ns>/<name>.md        agents/<name>.md
#   skills/<name>/{meta.yaml,content.md}     context.md (optional)
{ lib }:
let
  # Recursively collect every *.md under `dir`, keyed by its path relative to
  # `dir` with the `.md` stripped (so commands/plan/start.md → "plan/start").
  collectMd = dir:
    lib.concatMapAttrs
      (name: type:
        if type == "directory" then
          lib.mapAttrs'
            (k: v: lib.nameValuePair "${name}/${k}" v)
            (collectMd (dir + "/${name}"))
        else if lib.hasSuffix ".md" name then
          { ${lib.removeSuffix ".md" name} = builtins.readFile (dir + "/${name}"); }
        else { })
      (builtins.readDir dir);

  collectMdIn = sub: if builtins.pathExists sub then collectMd sub else { };

  # skills/<name>/{meta.yaml,content.md} → "---\n<meta>---\n\n<content>"
  # (matches the inline-string shape the upstream `programs.<agent>.skills`
  # option expects; never a store path, to stay IFD-free).
  skillNames =
    if builtins.pathExists ./skills then
      builtins.attrNames (lib.filterAttrs (_: t: t == "directory") (builtins.readDir ./skills))
    else [ ];
  mkSkill = name:
    "---\n"
    + builtins.readFile (./skills + "/${name}/meta.yaml")
    + "---\n\n"
    + builtins.readFile (./skills + "/${name}/content.md");
in
{
  commands = collectMdIn ./commands;
  agents = collectMdIn ./agents;
  skills = lib.genAttrs skillNames mkSkill;
  context = lib.optional (builtins.pathExists ./context.md) (builtins.readFile ./context.md);
}
