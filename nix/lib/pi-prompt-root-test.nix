{
  lib,
  pkgs,
  piPromptRoot,
}:
let
  evaluatedPiModule = lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      ../hm/pi.nix
      (
        { lib, ... }:
        {
          options = {
            home.homeDirectory = lib.mkOption { type = lib.types.str; };
            home.file = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            home.packages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
            };
            home.sessionVariables = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
            };
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.anything;
              default = [ ];
            };
            programs.mcp.servers = lib.mkOption {
              type = lib.types.attrs;
              default = { };
            };
            smind.hm.dev.llm.enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
            };
            smind.hm.dev.llm.merged.commands = lib.mkOption {
              type = lib.types.attrsOf lib.types.lines;
              default = { };
            };
            smind.hm.dev.llm.merged.agents = lib.mkOption {
              type = lib.types.attrsOf lib.types.lines;
              default = { };
            };
            smind.hm.dev.llm.merged.skills = lib.mkOption {
              type = lib.types.attrsOf lib.types.lines;
              default = { };
            };
            smind.hm.dev.llm.merged.memoryText = lib.mkOption {
              type = lib.types.lines;
              default = "";
            };
          };
          config = {
            home.homeDirectory = "/home/test";
            # Mirror programs.mcp submodule defaults (nullOr / empty attrs) so
            # the Pi override path must strip them — raw merge would re-emit
            # JSON null and crash pi-mcp-adapter (issue #222).
            programs.mcp.servers.ledger = {
              command = "/nix/store/test-cq/bin/cq";
              args = [ "mcp" ];
              url = null;
              enabled = null;
              env = { };
              headers = { };
            };
            smind.hm.dev.llm = {
              enable = true;
              merged = {
                commands = {
                  "cq/begin" = "unrendered canonical command";
                  "other/example" = "external command";
                };
                agents = {
                  "plan-reviewer" = "unrendered canonical agent";
                  "external-agent" = "external agent";
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
  files = evaluatedPiModule.config.home.file;
  piPackage = evaluatedPiModule.config.programs.pi.package;
  piSettings = evaluatedPiModule.config.programs.pi.settings;
  dispatchExtension = lib.findFirst (
    extension:
      lib.hasInfix "cq-pi-subagent-dispatch-extension" extension
      && lib.hasSuffix "/index.ts" extension
  ) null piSettings.extensions;
  dispatchExtensionDir =
    if dispatchExtension == null then
      throw "Pi settings do not install cq-subagent-dispatch/index.ts"
    else
      builtins.dirOf dispatchExtension;
  command = files."/home/test/.pi/agent/prompts/cq:begin.md";
  externalCommand = files."/home/test/.pi/agent/prompts/other:example.md";
  agent = files.".pi/agent/cq-agents/plan-reviewer.md";
  externalAgent = files.".pi/agent/cq-agents/external-agent.md";
  roleToolProfiles = files.".pi/agent/role-tool-profiles.json";
  appendSystem = files."/home/test/.pi/agent/APPEND_SYSTEM.md";
  # D157: expose the mcp.json path for BUILD-TIME jq only. Do NOT
  # `builtins.readFile` + `builtins.fromJSON` here — that is IFD against a
  # store path and forces a darwin builder when evaluating
  # `checks.<system>.pi-prompt-root.drvPath` on a non-darwin host. Ledger MCP
  # field asserts live in flake.nix's pi-prompt-root runCommand via jq.
  mcpJson = files.".pi/agent/mcp.json".source;
in
{
  inherit mcpJson dispatchExtension dispatchExtensionDir;
  package = piPackage;
  passed =
    assert command.source == "${piPromptRoot}/roles/begin.md";
    assert externalCommand.text == "external command";
    assert agent.source == "${piPromptRoot}/roles/plan-reviewer.md";
    assert externalAgent.text == "external agent";
    assert roleToolProfiles.source == "${piPromptRoot}/role-tool-profiles.json";
    assert piPackage.promptSurface == "pi";
    assert piPackage.promptRoot == piPromptRoot;
    assert lib.hasInfix ''fetch_prompt("investigate/advance")'' appendSystem.text;
    assert dispatchExtension != null;
    assert lib.all (entry: entry.assertion) evaluatedPiModule.config.assertions;
    true;
}
