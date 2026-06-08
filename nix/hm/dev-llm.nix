# Portable home-manager module for the LLM coding-agent harness (Claude
# Code, Codex, Pi) plus the shared asset-bundle / MCP / yolo-sandbox
# infrastructure. Extracted from 7mind/nix-config so it can be consumed by
# any home-manager setup via `inputs.cq.homeManagerModules.dev-llm`.
#
# Curried over the flake's own `inputs` (codegraph, claude-code-sandbox) and
# `self` (this flake — for the ledger packages/assets it re-uses). All
# host/hardware-specific coupling (GPU flags, rootless-Podman socket, ollama
# models dir, ssh key) is surfaced as `smind.hm.dev.llm.*` options that the
# consumer wires from its own NixOS config. Local-model provider wiring
# deliberately stays out of this module.
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

  jsonFormat = pkgs.formats.json { };
  tomlFormat = pkgs.formats.toml { };

  codexPluginCc = pkgs.fetchFromGitHub {
    owner = "openai";
    repo = "codex-plugin-cc";
    rev = "6a5c2ba53b734f3cdd8daacbd49f68f3e6c8c167";
    hash = "sha256-4kqtfdHlcg3YXWX1og9b5JuLgnB/3Nj5dFMe4Ryt7No=";
  };

  codegraphPkg = inputs.codegraph.packages.${system}.default;

  # codex pinned to the GitHub static-binary release (../pkg/codex), built
  # directly so the module does not depend on the consumer overriding
  # `pkgs.codex` via an overlay.
  codexPkg = pkgs.callPackage ../pkg/codex/package.nix { };

  # claude-code pinned to the local native-tarball build (../pkg/claude-code),
  # built directly so the module does not depend on a consumer overlay.
  #
  # claudeExecpathFixed: nixpkgs' claude-code runs its inner binary via
  # `exec ld.so --library-path … inner`, so Node's process.execPath is the
  # dynamic loader. Claude exports that as CLAUDE_CODE_EXECPATH, and the
  # grep/find shims it writes into its shell snapshot then invoke `ld.so -G …`
  # / `ld.so -S …` → "error while loading shared libraries: -G". Fix: make the
  # inner binary self-contained (real glibc interp + rpath, taken from the
  # wrapper's own --library-path so the glibc always matches) and exec it
  # DIRECTLY, so execPath is the real binary and the bundled ugrep/bfs
  # multiplex (keyed on argv0) works. Verified: `exec -a ugrep <inner> -G …`
  # greps correctly once run directly.
  claudeBase = pkgs.callPackage ../pkg/claude-code/package.nix { };
  claudeExecpathFixed = claudeBase.overrideAttrs (old: {
    nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.patchelf ];
    postFixup = (old.postFixup or "") + ''
      inner="$out/libexec/claude-code/claude"
      if [ ! -e "$inner" ]; then
        echo "claudeExecpathFixed: inner binary missing at $inner" >&2; exit 1
      fi
      wrapper=""
      for w in "$out"/bin/*; do
        if [ -f "$w" ] && grep -qE 'ld-linux.*libexec/claude-code/claude' "$w"; then
          wrapper="$w"; break
        fi
      done
      if [ -z "$wrapper" ]; then
        echo "claudeExecpathFixed: no loader-indirection wrapper found" >&2; exit 1
      fi
      glibclib="$(grep -oE '/nix/store/[^ "]*-glibc-[^ "]*/lib' "$wrapper" | head -1)"
      if [ -z "$glibclib" ]; then
        echo "claudeExecpathFixed: could not determine glibc lib path" >&2; exit 1
      fi
      patchelf --set-interpreter "$glibclib/ld-linux-x86-64.so.2" --set-rpath "$glibclib" "$inner"
      for w in "$out"/bin/*; do
        [ -f "$w" ] && grep -qE 'ld-linux.*libexec/claude-code/claude' "$w" || continue
        grep -v -E '^exec .*ld-linux.*libexec/claude-code/claude' "$w" > "$w.tmp"
        printf 'exec -a "$0" %s "$@"\n' "$inner" >> "$w.tmp"
        chmod --reference="$w" "$w.tmp" 2>/dev/null || chmod +x "$w.tmp"
        mv "$w.tmp" "$w"
        if grep -qE 'ld-linux.*libexec/claude-code/claude' "$w"; then
          echo "claudeExecpathFixed: failed to rewrite $w" >&2; exit 1
        fi
      done
    '';
  });

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

  # Command bundles key entries as "<ns>/<name>" (e.g. "plan/advance").
  # Slash-prompt harnesses (Pi, Codex) discover templates from a flat,
  # non-recursive directory and derive the command name from the filename stem,
  # so "/" must fold into a separator surviving as one token. ":" matches
  # Claude's namespaced slash commands (/plan:advance) and keeps distinct keys
  # distinct (plain baseNameOf collapses plan/advance, implement/advance,
  # investigate/advance onto one "advance.md"). Pi's harness applies the same
  # transform internally (see mk-agent-harness).
  commandKeyToStem = key: lib.replaceStrings [ "/" ] [ ":" ] key;
  mergedContext = lib.concatMap (b: b.context) assetBundles;

  # Pi: vendored 0.78.0 formula (nixpkgs lags at 0.75.x, whose Codex/ChatGPT
  # subscription token exchange is broken). Bump procedure: edit version +
  # rerun the two fake-hash builds in pkg/pi-coding-agent/package.nix.
  piBase = pkgs.callPackage ../pkg/pi-coding-agent/package.nix { };

  # Provider/API-key secrets are no longer injected by the pi wrapper. They are
  # supplied to ALL harnesses by the yolo sandbox via
  # `smind.hm.dev.llm.yolo.secretSessionVariables` (composed into one file,
  # bound, and sourced inside the sandbox — see nix/hm/yolo.nix and pkg/yolo).

  # pi-search-hub's duckduckgo backend spawns `python3 -c "from ddgs import
  # DDGS …"` (no interpreter override; its `which ddgs` fallback only adds
  # ddgs's own site-packages, which under Nix omits ddgs's transitive deps, so
  # it fails here). We need a python3 whose env carries ddgs+deps. We can NOT
  # add it to home.packages — a bare python3 is already in that buildEnv and a
  # second one collides (bin/python3, bin/pydoc3.13). Instead we prefix it onto
  # PATH for the pi process only (below), so the python3 pi spawns resolves to
  # this env without touching the home-manager profile.
  ddgsPython = pkgs.python3.withPackages (ps: [ ps.ddgs ]);
  piWrapped = pkgs.symlinkJoin {
    name = "pi-coding-agent-wrapped";
    paths = [ piBase ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi \
        --prefix PATH : ${ddgsPython}/bin \
        --run 'export CQ_AGENTS_DIR="$HOME/.pi/agent/cq-agents"'
    '';
  };

  # Declarative pi-search-hub config (replaces rpiv-web-tools). pi-search-hub
  # reads ~/.pi/agent/extensions/search.json; we manage it as a read-only HM
  # store symlink (truly declarative — runtime `/search` mutations do not
  # persist; change a backend here). API keys are NOT stored here: each
  # backend's `apiKey` names the env var supplied to the sandbox via
  # `smind.hm.dev.llm.yolo.secretSessionVariables`, resolved by pi-search-hub's
  # "ALL_CAPS string => env var" rule. Tool names are unchanged (`web_search`,
  # `web_read`), so the grok
  # drop-client-web-search extension still applies.
  #
  # Fallback ORDER (selectionStrategy = "sequential"): pi-search-hub tries
  # backends in config object-key order, with `defaultBackend` hoisted first.
  # `pkgs.formats.json`/`toJSON` would sort keys alphabetically and lose that
  # order, so we emit the JSON with EXPLICIT key order from searchHubBackends —
  # edit that list to re-order. We front self-hosted SearXNG, then free DDG,
  # then the paid APIs, so paid backends are only reached if both free ones
  # fail. duckduckgo needs `ddgs` at runtime (ddgsPython, prefixed onto pi's
  # PATH in piWrapped above).
  searchHubBackends = [
    {
      name = "searxng";
      cfg = {
        enabled = true;
        instanceUrl = "https://searx.net.7mind.io";
      };
    }
    {
      name = "duckduckgo";
      cfg.enabled = true;
    }
    {
      name = "brave";
      cfg = {
        enabled = true;
        apiKey = "BRAVE_SEARCH_API_KEY";
      };
    }
    {
      name = "exa";
      cfg = {
        enabled = true;
        apiKey = "EXA_API_KEY";
      };
    }
    {
      name = "firecrawl";
      cfg = {
        enabled = true;
        apiKey = "FIRECRAWL_API_KEY";
      };
    }
  ];
  searchHubConfig = pkgs.writeText "pi-search-hub-config.json" ''
    {
      "defaultBackend": "searxng",
      "selectionStrategy": "sequential",
      "backends": {
    ${lib.concatStringsSep ",\n" (
      map (b: "    ${builtins.toJSON b.name}: ${builtins.toJSON b.cfg}") searchHubBackends
    )}
      }
    }
  '';

  # Pi has no native MCP; pi-mcp-adapter (added via enableMcpIntegration)
  # auto-reads ~/.config/mcp/mcp.json — but servers there are lazy (connect on
  # first tool call). This Pi-only override (higher precedence than the shared
  # file) re-declares the same servers with lifecycle="keep-alive" so Pi
  # connects them at startup and auto-reconnects. Kept out of the shared
  # programs.mcp registry so `lifecycle` doesn't leak into claude/codex configs.
  # `directTools` (gated by smind.hm.dev.llm.pi.mcpDirectTools) is likewise
  # Pi-only — it registers a server's tools directly instead of behind the
  # adapter's mcp() proxy, and stays out of the shared registry for the same
  # reason.
  piMcpDirectTools = config.smind.hm.dev.llm.pi.mcpDirectTools;
  piMcpJson = jsonFormat.generate "pi-mcp.json" {
    mcpServers = lib.mapAttrs
      (
        name: server:
          let
            directToolsEnabled =
              if lib.isList piMcpDirectTools then lib.elem name piMcpDirectTools else piMcpDirectTools;
          in
          server // { lifecycle = "keep-alive"; } // lib.optionalAttrs directToolsEnabled { directTools = true; }
      )
      config.programs.mcp.servers;
  };

  # Repo-agnostic operating manual appended INSIDE Pi's system prompt (via
  # ~/.pi/agent/APPEND_SYSTEM.md, auto-discovered by the resource loader). Pi's
  # built-in prompt is intentionally minimal (four core tools, no plan mode /
  # sub-agents / permission prompts / TODO tool / persistent memory); this fills
  # the harness-operating gap Claude Code provides natively. Deliberately NOT
  # project-specific — per-repo facts belong in AGENTS.md / CLAUDE.md (Pi
  # discovers both). Content lives in pkg/llm-contexts/pi-context.md.
  piAppendSystemPrompt = llmContexts.pi;

  claudeMemoryText = lib.concatStringsSep "\n\n" config.smind.hm.dev.llm.memorySections;

  # Wiring common to every skill-aware harness: enable it, feed the shared
  # programs.mcp registry, install the merged skill set, and the shared
  # memory text. Spread with `//` into each programs.<harness> block (no key
  # overlap with the harness-specific options).
  sharedAgentWiring = {
    enable = true;
    enableMcpIntegration = true;
    skills = mergedSkills;
    context = claudeMemoryText;
  };

  # SessionStart hook: surfaces hostname and sandbox state on every session
  # boot. Claude Code's injected environment block lists OS/shell/cwd but not
  # hostname, so without this the model guesses (and tends to assume the wrong
  # host). $SMIND_SANDBOXED is set by the yolo wrapper (pkg/yolo/yolo.sh) but
  # the matching `environment` skill is passive — declaring sandbox state
  # up-front avoids relying on the model to probe env vars.
  claudeSessionStartHook = pkgs.writeShellScript "claude-session-start-context" ''
    set -eu
    HOST="''${HOSTNAME:-$(hostname 2>/dev/null || echo unknown)}"
    if [ "''${SMIND_SANDBOXED:-0}" = "1" ]; then
      SANDBOX_LINE="Sandbox: ACTIVE (bubblewrap via the 'yolo' wrapper; SMIND_SANDBOXED=1). Writes persist only inside the project directory and /tmp/exchange. For access to \$HOME or system paths, follow the 'environment' skill's exchange-script workflow."
    else
      SANDBOX_LINE="Sandbox: NOT ACTIVE (SMIND_SANDBOXED unset). Filesystem writes are unrestricted; the exchange-script workflow is unnecessary."
    fi
    printf '%s\n' \
      'Runtime environment (injected by SessionStart hook):' \
      "- Hostname: $HOST. Use this exact value where CLAUDE.md or scripts reference the current host; do not rely on \$HOSTNAME (zsh, the user's login shell, does not export it)." \
      "- $SANDBOX_LINE"
  '';

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

    smind.hm.dev.llm.pi.mcpDirectTools = lib.mkOption {
      type = lib.types.either lib.types.bool (lib.types.listOf lib.types.str);
      default = false;
      example = [ "codegraph" "ledger" ];
      description = ''
        Register Pi MCP servers' tools individually instead of behind
        pi-mcp-adapter's single `mcp({search, tool})` proxy. The proxy exists
        for context-window economy (progressive disclosure), so this defaults
        off. `true` sets `directTools = true` on every server in
        {option}`programs.mcp.servers`; a list of server names enables it only
        for the named servers (e.g. `[ "codegraph" "ledger" ]`), leaving the
        rest proxied. Pi-only: applied in `piMcpJson`, not leaked into the
        shared MCP registry used by claude/codex.
      '';
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

      programs.claude-code = sharedAgentWiring // {
        # Bake DISABLE_AUTOUPDATER into the wrapper so it survives downstream
        # wrappers (yolo, bubblewrap, fresh-env exec) and Claude Code can't
        # self-update past the nix pin.
        package = pkgs.symlinkJoin {
          name = "claude-code-no-autoupdate";
          paths = [ claudeExecpathFixed ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/claude --set-default DISABLE_AUTOUPDATER 1
          '';
        };
        plugins = [ "${codexPluginCc}/plugins/codex" ];
        # Bundle-contributed commands/agents via the native options: keys
        # like "plan/advance" land at ~/.claude/commands/plan/advance.md
        # (slash command /plan:advance); agents at ~/.claude/agents/<name>.md.
        commands = mergedCommands;
        agents = mergedAgents;
        settings = {
          alwaysThinkingEnabled = true;
          theme = "dark";
          # Workaround for Claude Code 2.1.83+ regression where sandbox
          # detection fails even when bubblewrap/socat are on PATH (the
          # error reads "sandbox required but unavailable: ${j$}").
          sandbox = {
            failIfUnavailable = false;
          };
          tui = lib.mkIf config.smind.hm.dev.llm.fullscreenTui.enable "fullscreen";
          permissions = {
            allow = [ "Edit(/tmp/**)" ];
            # defaultMode = "bypassPermissions";  # commented out: this controls *permission prompts* (file edits etc.), not the AskUserQuestion tool
            # Disable the AskUserQuestion tool (the interactive multiple-choice "ask user" / question UI).
            # Tool name from https://code.claude.com/docs/en/tools-reference ; see also GitHub #10258.
            deny = [ "AskUserQuestion" ];
          };
          includeCoAuthoredBy = config.smind.hm.dev.llm.coAuthored.enable;
          attribution = lib.mkIf (!config.smind.hm.dev.llm.coAuthored.enable) { commit = ""; pr = ""; };
          effortLevel = "high";
          model = "claude-opus-4-8[1m]";
          spinnerVerbs = {
            mode = "replace";
            verbs = [ "Working" ];
          };
          hooks = {
            # Inject hostname + sandbox state into every session. See
            # claudeSessionStartHook above for rationale.
            SessionStart = [
              {
                matcher = "*";
                hooks = [
                  {
                    type = "command";
                    command = "${claudeSessionStartHook}";
                  }
                ];
              }
            ];
          };
          statusLine = {
            "type" = "command";
            "command" = ''
              CLAUDE_ACCOUNT="$(${pkgs.jq}/bin/jq -r '
                .oauthAccount.emailAddress //
                .oauthAccount.email //
                .oauthAccount.account.emailAddress //
                .oauthAccount.account.email //
                .oauthAccount.name //
                .oauthAccount.displayName //
                .oauthAccount.accountName //
                .account.emailAddress //
                .account.email //
                .account.name //
                empty
              ' "$HOME/.claude.json" 2>/dev/null)"
              if [ -z "$CLAUDE_ACCOUNT" ]; then
                CLAUDE_ACCOUNT="unknown-claude-account"
              fi
              printf '\033[2m\033[35m%s \033[0m\033[2m\033[37m%s \033[0m\033[2m@ %s \033[0m\033[2m\033[36min \033[1m\033[36m%s\033[0m' "$CLAUDE_ACCOUNT" "$(whoami)" "$(hostname -s)" "$(pwd | sed "s|^$HOME|~|")"
            '';
          };
        };
      };

      programs.codex = sharedAgentWiring // {
        package = codexPkg;
        settings = {
          model = "gpt-5.5";
          model_reasoning_effort = "xhigh";
          project_doc_fallback_filenames = [ "CLAUDE.md" ];
          features.multi_agent = true;
          features.fast_mode = false;
          features.steer = true;
        };
      };

      home.file.".codex/config.toml".force = true;

      home.file.".claude-work/settings.json".source =
        config.home.file."${config.programs.claude-code.configDir}/settings.json".source;
      home.file.".claude-work/CLAUDE.md".source =
        config.home.file."${config.programs.claude-code.configDir}/CLAUDE.md".source;

      programs.pi = sharedAgentWiring // {
        # Vendored Pi 0.78.0 wrapped to inject provider/search API keys from
        # agenix secrets at launch (see piWrapped/piSecretEnv).
        package = piWrapped;
        # Repo-agnostic operating manual appended inside Pi's (minimal) system
        # prompt; per-repo facts stay in AGENTS.md/CLAUDE.md (see definition).
        appendSystemPrompt = piAppendSystemPrompt;
        # Deliver ledger (and other bundle) "commands" (plan/* etc.) as
        # Pi prompt templates. The harness materializes keys like
        # "plan/advance" as prompts/plan:advance.md so that /plan:advance
        # works exactly as it does for Claude (/plan:advance) and Codex.
        promptTemplates = mergedCommands;
        settings = {
          theme = "dark";
          # xAI Grok Build (Coding Plan) via pi-xai (Responses API). grok-build
          # always reasons at maximum depth — it rejects an explicit
          # reasoningEffort / defaultThinkingLevel. `/login grok-build` (OAuth);
          # other providers (openai-codex, openrouter, ...) stay selectable at runtime.
          defaultProvider = "grok-build";
          defaultModel = "grok-build";
          # User-requested: terminal progress (OSC 9;4; off by default in 0.78+),
          # steering/follow-up modes, hide reasoning, disable install telemetry.
          terminal = {
            showTerminalProgress = true;
          };
          steeringMode = "all";
          followUpMode = "all";
          hideThinkingBlock = true;
          enableInstallTelemetry = false;
          # Pi packages (installed from npm on first run):
          # - pi-search-hub: unified web_search/web_read over 12 backends with
          #   auto-fallback (https://pi.dev/packages/pi-search-hub). Keys via
          #   piWrapped env; declaratively configured at
          #   ~/.pi/agent/extensions/search.json (see searchHubConfig).
          # - pi-anthropic-auth: Claude Pro/Max OAuth compat; activates only on
          #   Anthropic OAuth, passes everything else through (`/login anthropic`).
          # - pi-xai: xAI OAuth provider (`grok-build`) with Grok models/tools
          #   (`/login grok-build`). Installed straight from npm; the stale 128k
          #   contextWindow it hardcodes is corrected at runtime by the
          #   patch-grok-build-context-window.ts extension below (a models-only
          #   registerProvider override) rather than by vendoring its source.
          # - pi-ollama-cloud: Ollama Cloud provider (first-party, badlogic).
          #   Registers the `ollama-cloud` provider against https://ollama.com/v1
          #   (apiKey `$OLLAMA_API_KEY`; or ~/.pi/agent/ollama-cloud.json) — no
          #   local server. Self-contained: its only imports (@sinclair/typebox +
          #   the host pi API) come from Pi's jiti alias map, so Pi's managed
          #   `--legacy-peer-deps` install resolves everything.
          #   NOT "npm:@0xkobold/pi-ollama": that one declares the `ollama` npm
          #   package as a *peer* dependency, which Pi's --legacy-peer-deps
          #   managed install skips (and Pi does not alias `ollama`), so it fails
          #   to load with "Cannot find module 'ollama'".
          # - @sinamtz/pi-minimax-provider: MiniMax M3 provider (Anthropic-compat
          #   streaming). Registers the `minimax` provider against
          #   https://api.minimax.io (apiKey `$MINIMAX_API_KEY`). Self-contained:
          #   `@sinclair/typebox` is a regular dep (installed) and also aliased by
          #   Pi's loader, so the managed --legacy-peer-deps install resolves it.
          # (pi-mcp-adapter is added separately by enableMcpIntegration.)
          packages = [
            "npm:pi-search-hub"
            "npm:pi-ollama-cloud"
            "npm:@sinamtz/pi-minimax-provider"
            "npm:pi-xai"
          ];
          extensions = [
            # For grok-* requests, keep xAI's native server-side web_search and
            # remove only the pi-search-hub client tool of the same name.
            "${../pkg/pi-extensions/drop-client-web-search-for-grok.ts}"
            # pi-search-hub advertises a static all-12-backend list in the
            # web_search description + `backend` enum regardless of what's
            # configured, so the model picks unconfigured backends (which fail).
            # This rewrites the web_search tool definition per request to list
            # only the backends actually active per the live search.json. See
            # the extension header and the upstream bug-report draft.
            "${../pkg/pi-extensions/patch-search-hub-backends.ts}"
            # Correct pi-xai's stale 128k grok-build contextWindow to 256k via a
            # registerProvider override that replaces the model list (restating
            # baseUrl/api to satisfy pi-coding-agent ≥0.78.0 validation, omitting
            # oauth to preserve pi-xai's login). Replaces vendoring the patched
            # pi-xai source. See the extension header for the mechanism.
            "${../pkg/pi-extensions/patch-grok-build-context-window.ts}"
            # cq subagent-dispatch: registers the `dispatch_agent` tool the cq
            # shared prompts speak to. Reads the named agent markdown from
            # $CQ_AGENTS_DIR (T222) and runs it as an isolated, tool-filtered
            # child `pi -p` turn that cannot itself re-dispatch. See the
            # extension header for the Route-A subprocess mechanism (T221/T224).
            "${../pkg/pi-extensions/cq-subagent-dispatch.ts}"
            # Fix pi-ollama-cloud's broken web-tool auth: its getCloudApiKey
            # forgets to await the async getApiKey, so the OLLAMA_API_KEY env
            # fallback is dead code and ollama_web_search/_fetch fail with
            # "No Ollama Cloud API key configured" despite the key being set.
            # We re-register both tools (at load, pre-empting the package's
            # session_start registration) with corrected resolution. See header.
            "${../pkg/pi-extensions/fix-ollama-cloud-web-tools-auth.ts}"
          ];
        };
      };

      # Pi-specific MCP override: codegraph + ledger pinned keep-alive so Pi's
      # pi-mcp-adapter connects them at startup (see piMcpJson).
      home.file.".pi/agent/mcp.json".source = piMcpJson;

      # Declarative pi-search-hub config (see searchHubConfig). RO store symlink,
      # like mcp.json above.
      home.file.".pi/agent/extensions/search.json".source = searchHubConfig;

      # The bubblewrap sandbox + `yolo` wrapper live in the sibling yolo.nix
      # module (imported alongside this one). reattach-llm is a Linux-only tmux
      # reattach helper for the agent terminals — not a sandbox concern, so it
      # stays here.
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
    (lib.mkIf config.smind.hm.dev.llm.enable {
      # Codex exposes no native commands/agents option (unlike claude-code), so
      # deliver merged commands as ~/.codex/prompts/<stem>.md slash-prompts.
      # Separate mkMerge element because the block above sets attrpath
      # `home.file."<path>"`, which can't coexist with a dynamic `home.file =
      # <attrs>` in one attribute set.
      # commandKeyToStem turns "plan/advance" into plan:advance.md; Codex
      # namespaces ~/.codex/prompts/*.md under its own "prompts:" prefix (stem
      # verbatim, no char filtering), so this surfaces as /prompts:plan:advance.
      # Sharing commandKeyToStem with Pi keeps the two deliveries in lockstep.
      # Codex agents have no canonical markdown home and are intentionally not
      # materialized (Claude receives them via its agents option).
      home.file = lib.mapAttrs'
        (
          key: body: lib.nameValuePair ".codex/prompts/${commandKeyToStem key}.md" { text = body; }
        )
        mergedCommands;
    })
    (lib.mkIf config.smind.hm.dev.llm.enable {
      # Project individual cq agent markdowns to ~/.pi/agent/cq-agents/<name>.md
      # so the dispatch extension (T224) can discover them by reading the
      # directory pointed to by $CQ_AGENTS_DIR (set on piWrapped above).
      # Separate mkMerge element for the same reason as the Codex block above.
      home.file = lib.mapAttrs'
        (
          name: body: lib.nameValuePair ".pi/agent/cq-agents/${name}.md" { text = body; }
        )
        mergedAgents;
    })
  ];
}
