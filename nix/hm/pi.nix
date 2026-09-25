{ inputs, self }:
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;
  system = pkgs.stdenv.hostPlatform.system;
  promptRoot = self.packages.${system}.pi-prompt-root;
  catalogAgents = lib.filter (role: role.roleKind == "dispatched-subagent") self.llmAssets.catalog;
  catalogCommands = lib.filter (role: role.roleKind == "orchestrator-command") self.llmAssets.catalog;
  promptTemplates = lib.listToAttrs (
    map (
      role: lib.nameValuePair "cq/${role.roleId}" "${promptRoot}/roles/${role.roleId}.md"
    ) catalogCommands
  );
  catalogAgentNames = map (role: role.roleId) catalogAgents;
  agentHomeFiles =
    lib.mapAttrs'
      (
        name: body: lib.nameValuePair ".pi/agent/cq-agents/${name}.md" { text = body; }
      )
      (lib.filterAttrs (name: _: !(builtins.elem name catalogAgentNames)) cfg.merged.agents)
    // lib.listToAttrs (
      map (
        role:
        lib.nameValuePair ".pi/agent/cq-agents/${role.roleId}.md" {
          source = "${promptRoot}/roles/${role.roleId}.md";
        }
      ) catalogAgents
    );
  dispatchSource = ../pkg/pi-extensions/cq-subagent-dispatch;
  dispatchExtension = pkgs.runCommand "cq-pi-subagent-dispatch-extension" {
    nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.stdenv.cc ];
  } ''
    mkdir -p "$out/node_modules/@cq"
    cp -R ${dispatchSource}/. "$out/"
    ln -s ${../pkg/cq-ledgers/packages/process-control} \
      "$out/node_modules/@cq/process-control"
    ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
      mkdir -p "$out/libexec"
      $CC -Wall -Wextra -Werror \
        ${../pkg/cq-ledgers/packages/process-control/native/darwin-process-identity.c} \
        -o "$out/libexec/cq-process-identity"
    ''}
  '';
  ddgsPython = pkgs.python3.withPackages (ps: [ ps.ddgs ]);
  piBase = inputs.ponygirls.packages.${system}.pi-coding-agent;
  piWrapped = pkgs.symlinkJoin {
    name = "pi-coding-agent-cq";
    passthru = {
      promptSurface = "pi";
      inherit promptRoot;
    };
    paths = [ piBase ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi \
        --prefix PATH : ${ddgsPython}/bin \
        --set CQ_HARNESS pi \
        --set CQ_PROMPT_SURFACE pi \
        --set CQ_PROMPT_ROOT ${promptRoot} \
        --set CQ_PROCESS_IDENTITY_HELPER "${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin "${dispatchExtension}/libexec/cq-process-identity"}" \
        --run 'export CQ_AGENTS_DIR=''${CQ_AGENTS_DIR:-"''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cq-agents"}'
    '';
  };
in
{
  config = lib.mkIf cfg.enable {
    programs.pi = {
      package = lib.mkForce piWrapped;
      promptTemplates = promptTemplates;
      settings.extensions = [
        "${dispatchExtension}/index.ts"
        "${../pkg/pi-extensions/auto-driver}/index.ts"
        "${../pkg/pi-extensions/ledger-status}/index.ts"
      ];
    };

    # Rendered CQ prompts call ledger tools by name rather than through Pi's
    # progressive-disclosure MCP proxy.
    smind.hm.dev.llm.pi.mcpDirectTools = lib.mkDefault [ "ledger" ];

    home.file = agentHomeFiles // {
      ".pi/agent/role-tool-profiles.json".source = "${promptRoot}/role-tool-profiles.json";
    };
  };
}
