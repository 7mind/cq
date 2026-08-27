{
  lib,
  pkgs,
  claudeModule,
  claudePromptRoot,
}:
let
  promptCatalog = claudePromptRoot.promptCatalog;
  homeDirectory = "/home/test";
  configDir = "${homeDirectory}/.claude";
  rawCommands = lib.listToAttrs (
    map
      (role: lib.nameValuePair "cq/${role.roleId}" "RAW-COMMAND-MUST-NOT-INSTALL ${role.roleId}\n")
      (builtins.filter (role: role.roleKind == "orchestrator-command") promptCatalog)
  );
  rawAgents = lib.listToAttrs (
    map
      (role: lib.nameValuePair role.roleId "RAW-AGENT-MUST-NOT-INSTALL ${role.roleId}\n")
      (builtins.filter (role: role.roleKind == "dispatched-subagent") promptCatalog)
  );
  settingsFile = pkgs.writeText "claude-settings-fixture.json" "{}\n";
  contextFile = pkgs.writeText "claude-context-fixture.md" "fixture context\n";

  evaluate = extraModule: lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      claudeModule
      (
        { lib, ... }:
        {
          options = {
            home.file = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            programs.claude-code = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
            smind.hm.dev.llm.enable = lib.mkOption {
              type = lib.types.bool;
            };
            smind.hm.dev.llm.merged = lib.mkOption {
              type = lib.types.attrs;
            };
            smind.hm.dev.llm.coAuthored.enable = lib.mkOption {
              type = lib.types.bool;
            };
            smind.hm.dev.llm.fullscreenTui.enable = lib.mkOption {
              type = lib.types.bool;
            };
          };
          config = {
            home.file = {
              "${configDir}/settings.json".source = settingsFile;
              "${configDir}/CLAUDE.md".source = contextFile;
            };
            programs.claude-code = {
              inherit configDir;
              commands = { };
              agents = { };
            };
            smind.hm.dev.llm = {
              enable = true;
              merged = {
                skills = { };
                memoryText = "";
                commands = rawCommands;
                agents = rawAgents;
              };
              coAuthored.enable = true;
              fullscreenTui.enable = true;
            };
          };
        }
      )
      extraModule
    ];
  };

  evaluated = evaluate {
    config.smind.hm.dev.llm.openaiCodexPlugin.enable = true;
  };
  disabledEvaluation = evaluate {
    config.smind.hm.dev.llm.openaiCodexPlugin.enable = false;
  };

  homeFiles = evaluated.config.home.file;
  claudeConfig = evaluated.config.programs.claude-code;
  disabledClaudeConfig = disabledEvaluation.config.programs.claude-code;
  roleTarget =
    role:
    if role.roleKind == "dispatched-subagent" then
      "${configDir}/agents/${role.roleId}.md"
    else
      "${configDir}/commands/cq/${role.roleId}.md";
  roleSource = role: "${claudePromptRoot}/roles/${role.roleId}.md";
  relativeTarget = role: lib.removePrefix "${homeDirectory}/" (roleTarget role);
  checkRole =
    role:
    let
      target = roleTarget role;
      source = roleSource role;
    in
    if builtins.hasAttr target homeFiles && homeFiles.${target} ? source then
      ''
        test ${lib.escapeShellArg (toString homeFiles.${target}.source)} = ${lib.escapeShellArg source}
        mkdir -p "$out/home/$(dirname ${lib.escapeShellArg (relativeTarget role)})"
        cp ${lib.escapeShellArg (toString homeFiles.${target}.source)} \
          "$out/home/${relativeTarget role}"
        cmp "$out/home/${relativeTarget role}" ${lib.escapeShellArg source}
      ''
    else
      ''
        echo "missing Claude prompt home.file target: ${target}" >&2
        exit 1
      '';
  commandCount = builtins.length (
    builtins.filter (role: role.roleKind == "orchestrator-command") promptCatalog
  );
  agentCount = builtins.length (
    builtins.filter (role: role.roleKind == "dispatched-subagent") promptCatalog
  );
in
pkgs.runCommand "claude-prompt-home-check"
  {
    nativeBuildInputs = [ pkgs.ripgrep ];
  }
  ''
    set -eu
    mkdir -p "$out/home"
    ${lib.concatMapStringsSep "\n" checkRole promptCatalog}

    test ${toString (builtins.length promptCatalog)} -eq 26
    test ${toString commandCount} -eq 16
    test ${toString agentCount} -eq 9
    test ${lib.escapeShellArg claudeConfig.package.promptSurface} = claude
    test ${lib.escapeShellArg (toString claudeConfig.package.promptRoot)} = ${lib.escapeShellArg (toString claudePromptRoot)}
    test ${toString (builtins.length (builtins.attrNames claudeConfig.plugins))} -eq 1
    test ${toString (builtins.length (builtins.attrNames disabledClaudeConfig.plugins))} -eq 0
    rg -q 'CQ_PROMPT_SURFACE.*claude' ${claudeConfig.package}/bin/claude
    rg -q ${lib.escapeShellArg (toString claudePromptRoot)} ${claudeConfig.package}/bin/claude
    test "$(find "$out/home/${lib.removePrefix "${homeDirectory}/" configDir}/commands/cq" -type f -name '*.md' | wc -l)" -eq ${toString commandCount}
    test "$(find "$out/home/${lib.removePrefix "${homeDirectory}/" configDir}/agents" -type f -name '*.md' | wc -l)" -eq ${toString agentCount}
    test -f "$out/home/${lib.removePrefix "${homeDirectory}/" configDir}/commands/cq/begin.md"
    test ${lib.escapeShellArg (builtins.toJSON (claudeConfig.commands or { }))} = '{}'
    test ${lib.escapeShellArg (builtins.toJSON (claudeConfig.agents or { }))} = '{}'
    if rg -n 'RAW-(COMMAND|AGENT)-MUST-NOT-INSTALL|\{\{cq:fragment:|CQ_HARNESS' "$out"; then
      echo "Claude prompt home contains raw or unresolved prompt bytes" >&2
      exit 1
    fi
  ''
