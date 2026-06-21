# Pi configuration for the LLM coding-agent harness, split out of dev-llm.nix.
# Unlike Claude/Codex (whose `programs.*` modules come from the downstream's
# home-manager), Pi's `programs.pi` module is defined in THIS flake — the
# definition is inlined in the `imports` below (shared factory + Pi-specific
# options) — and then configured here. The shared asset bundles / MCP registry /
# merged views come from the sibling tools.nix via
# `smind.hm.dev.llm.{enable,merged.*,…}`.
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;
  piCfg = config.programs.pi;
  jsonFormat = pkgs.formats.json { };

  # The `programs.pi` module is defined IN THIS FLAKE (Pi isn't in home-manager
  # upstream): the common agent-harness surface comes from the shared factory,
  # plus the Pi-specific options (extensionsDir / mcpAdapterPackage /
  # appendSystemPrompt) declared in the inline module below. Both are imported
  # at the bottom; this file then configures the resulting `programs.pi`.
  mkAgentHarness = import ../lib/mk-agent-harness.nix;

  llmContexts = pkgs.callPackage ../pkg/llm-contexts/default.nix { };

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
        --set CQ_HARNESS pi \
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
  piMcpDirectTools = cfg.pi.mcpDirectTools;
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

  # Auto-driver extension: the whole subdirectory is copied to the store so
  # index.ts can resolve its sibling imports (./decision, ./driver, etc.) at
  # runtime. Pi's settings.extensions receives the index.ts store path inside
  # that directory derivation.
  autoDriverDir = ../pkg/pi-extensions/auto-driver;

  # Wiring common to every skill-aware harness (see claude.nix); spread with
  # `//` into the programs.pi block (no key overlap).
  sharedAgentWiring = {
    enable = true;
    enableMcpIntegration = true;
    skills = cfg.merged.skills;
    context = cfg.merged.memoryText;
  };
in
{
  imports = [
    # Common agent-harness surface (enable/package/configDir/settings/context/
    # skills/enableMcpIntegration), built from the shared factory. Pi config
    # layout (https://pi.dev/docs/latest):
    #   ~/.pi/agent/settings.json   global settings (JSON)
    #   ~/.pi/agent/AGENTS.md       concatenated agent instructions / memory
    #   ~/.pi/agent/skills/<n>/SKILL.md   skills (progressive disclosure)
    #   ~/.pi/agent/extensions/*.ts       auto-discovered TS extensions
    #   settings.packages / settings.extensions   npm:/git: packages + local exts
    #   PI_CODING_AGENT_DIR         overrides the ~/.pi/agent location
    # MCP: Pi has no built-in MCP. The `pi-mcp-adapter` package reads
    # ~/.config/mcp/mcp.json — which `programs.mcp` already writes — so
    # enableMcpIntegration only adds the adapter to settings.packages.
    (mkAgentHarness {
      name = "pi";
      prettyName = "Pi";
      defaultConfigDir = ".pi/agent";
      configDirEnv = "PI_CODING_AGENT_DIR";
      formatType = "json";
      settingsFile = "settings.json";
      contextFile = "AGENTS.md";
      skillsSubdir = "skills";
      # Ledger (and other) command bundles provide keys like "plan/advance".
      # Materialise as prompts/plan:advance.md so Pi's prompt-template
      # discovery turns them into invocable /plan:advance slash commands
      # (matching the frontmatter description/argument-hint format).
      promptTemplatesSubdir = "prompts";
    })
  ];

  options = {
    # Pi-specific extras on top of the shared agent-harness surface declared by
    # the mkAgentHarness factory above (enable/package/configDir/settings/…).
    programs.pi.extensionsDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Directory of TypeScript extensions symlinked into
        {file}`extensions/` under {option}`programs.pi.configDir`.
        Each entry is either {file}`<name>.ts` or {file}`<name>/index.ts`.
      '';
      example = lib.literalExpression "./pi-extensions";
    };

    programs.pi.mcpAdapterPackage = lib.mkOption {
      type = lib.types.str;
      default = "npm:pi-mcp-adapter";
      description = ''
        Pi package spec for the MCP adapter, added to
        {option}`programs.pi.settings.packages` when
        {option}`programs.pi.enableMcpIntegration` is set. Pin a version
        with e.g. {command}`"npm:pi-mcp-adapter@1.2.3"`.
      '';
    };

    programs.pi.appendSystemPrompt = lib.mkOption {
      type = lib.types.either lib.types.lines lib.types.path;
      default = "";
      description = ''
        Content appended verbatim to Pi's built-in system prompt, written to
        {file}`APPEND_SYSTEM.md` in {option}`programs.pi.configDir` (Pi
        auto-discovers it there). Unlike {option}`programs.pi.context`
        (AGENTS.md, loaded as {var}`<project_context>`), this lands *inside*
        the system prompt and therefore carries higher authority. Use it for
        global, repo-agnostic behavioural rules; keep project-specific facts
        in {option}`programs.pi.context`. Either inline content or a path.
        Empty string disables the file.
      '';
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

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      programs.pi = sharedAgentWiring // {
        # Vendored Pi 0.78.0 wrapped to set CQ_HARNESS=pi, CQ_AGENTS_DIR, and the
        # ddgs python on PATH (see piWrapped). Provider/search API keys are supplied
        # by the yolo sandbox (smind.hm.dev.llm.yolo.secretSessionVariables), not here.
        package = piWrapped;
        # Repo-agnostic operating manual appended inside Pi's (minimal) system
        # prompt; per-repo facts stay in AGENTS.md/CLAUDE.md (see definition).
        appendSystemPrompt = piAppendSystemPrompt;
        # Deliver ledger (and other bundle) "commands" (plan/* etc.) as
        # Pi prompt templates. The harness materializes keys like
        # "plan/advance" as prompts/plan:advance.md so that /plan:advance
        # works exactly as it does for Claude (/plan:advance) and Codex.
        promptTemplates = cfg.merged.commands;
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
          #   the sandbox secretSessionVariables; declaratively configured at
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
            # cq auto-driver: registers /cq:advance:auto, /cq:plan:auto,
            # /cq:investigate:auto, and /cq:implement:auto — drive-and-await
            # loops that re-run the underlying cq:* command until its terminal
            # predicate is satisfied (T465–T468). The entrypoint (index.ts)
            # imports sibling modules (./decision, ./driver, ./decide, ./oracle)
            # so the whole auto-driver/ directory is copied to the store via
            # `autoDriverDir`; Pi receives the index.ts path within that tree.
            "${autoDriverDir}/index.ts"
          ];
        };
      };

      # Pi-specific MCP override: codegraph + ledger pinned keep-alive so Pi's
      # pi-mcp-adapter connects them at startup (see piMcpJson).
      home.file.".pi/agent/mcp.json".source = piMcpJson;

      # Declarative pi-search-hub config (see searchHubConfig). RO store symlink,
      # like mcp.json above.
      home.file.".pi/agent/extensions/search.json".source = searchHubConfig;
    }
    {
      # Project individual cq agent markdowns to ~/.pi/agent/cq-agents/<name>.md
      # so the dispatch extension (T224) can discover them by reading the
      # directory pointed to by $CQ_AGENTS_DIR (set on piWrapped above).
      # Separate mkMerge element because the block above sets static
      # `home.file."<path>"` entries that can't coexist with a dynamic
      # `home.file = <attrs>` in one attribute set.
      home.file = lib.mapAttrs'
        (
          name: body: lib.nameValuePair ".pi/agent/cq-agents/${name}.md" { text = body; }
        )
        cfg.merged.agents;
    }
    # Pi-specific extras (gated on the programs.pi sub-options declared above).
    # Pi's adapter reads the shared ~/.config/mcp/mcp.json registry (written by
    # programs.mcp); we only need to add the adapter to settings.packages (the
    # list merges with the package set above).
    (lib.mkIf piCfg.enableMcpIntegration {
      programs.pi.settings.packages = [ piCfg.mcpAdapterPackage ];
    })
    (lib.mkIf (piCfg.extensionsDir != null) {
      home.file."${piCfg.configDir}/extensions" = {
        source = piCfg.extensionsDir;
        recursive = true;
      };
    })
    (lib.mkIf (piCfg.appendSystemPrompt != "") {
      home.file."${piCfg.configDir}/APPEND_SYSTEM.md" =
        if lib.isPath piCfg.appendSystemPrompt then
          { source = piCfg.appendSystemPrompt; }
        else
          { text = piCfg.appendSystemPrompt; };
    })
  ]);
}
