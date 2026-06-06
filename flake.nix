{
  description = "cq — markdown-backed ledger suite (MCP + TUI/web) and a portable LLM coding-agent harness (Claude/Codex/Pi + yolo)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # LLM coding-agent harness dependencies, consumed by
    # homeManagerModules.dev-llm (the extracted Claude/Codex/Pi + yolo setup).
    # CodeGraph — semantic code-intelligence MCP server. Pinned to the open
    # PR that adds the flake; bump to upstream once merged.
    codegraph = {
      url = "github:uxtechie/codegraph/implement-nix-flake-support";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Darwin sandbox wrapper for claude-code (Linux uses the bubblewrap yolo).
    claude-code-sandbox.url = "github:neko-kai/claude-code-sandbox";
  };

  outputs = inputs@{ self, nixpkgs, flake-utils, ... }:
    let
      # All products are pure Bun/TypeScript; pin to x86_64-linux for the
      # hermetic outputs (the dev shell is available on other systems too).
      buildSystems = [ "x86_64-linux" ];

      # System-agnostic: the LLM prompt/skill assets this repo contributes to a
      # home-manager LLM toolbelt. Pure/eval-time (IFD-free) — consumed as
      # `inputs.<this>.llmAssets`. See ./nix/pkg/cq-assets/assets.nix for the shape.
      llmAssets = import ./nix/pkg/cq-assets/assets.nix { lib = nixpkgs.lib; };
    in
    (flake-utils.lib.eachSystem buildSystems (system:
      let
        # allowUnfree: the LLM harness bundles proprietary agent CLIs
        # (claude-code is unfree). The ledger packages themselves are free.
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        # Fixed-output derivation: fetches all npm dependencies via
        # `bun install --frozen-lockfile`. Nix allows network access inside
        # FODs; hermeticity is guaranteed by the output hash.
        bunNodeModules = pkgs.stdenv.mkDerivation {
          pname = "ledger-node-modules";
          version = "0.0.1";

          # Only manifest files so the FOD hash is stable across source edits.
          # The Bun workspace lives under ./nix/pkg/cq-ledgers; rooting toSource
          # there keeps the in-store layout (and thus the FOD hash) unchanged.
          src = pkgs.lib.fileset.toSource {
            root = ./nix/pkg/cq-ledgers;
            fileset = pkgs.lib.fileset.unions [
              ./nix/pkg/cq-ledgers/package.json
              ./nix/pkg/cq-ledgers/bun.lock
              ./nix/pkg/cq-ledgers/bunfig.toml
              ./nix/pkg/cq-ledgers/packages/cq-config/package.json
              ./nix/pkg/cq-ledgers/packages/cq-cli/package.json
              ./nix/pkg/cq-ledgers/packages/ledger/package.json
              ./nix/pkg/cq-ledgers/packages/ledger-live/package.json
              ./nix/pkg/cq-ledgers/packages/ledger-mcp/package.json
              ./nix/pkg/cq-ledgers/packages/ledger-tui/package.json
              ./nix/pkg/cq-ledgers/packages/ledger-web/package.json
            ];
          };

          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

          dontConfigure = true;
          dontFixup = true;

          buildPhase = ''
            runHook preBuild

            export HOME=$(mktemp -d)
            export XDG_CACHE_HOME="$HOME/.cache"
            export BUN_INSTALL_CACHE_DIR="$HOME/.bun-cache"
            mkdir -p "$BUN_INSTALL_CACHE_DIR"

            # --backend=copyfile: copies instead of hardlinks (hardlinks across
            #   mount-points fail in the Nix sandbox).
            # --ignore-scripts: skip lifecycle scripts (e.g. node-pty's native
            #   build) — no product closure needs them.
            bun install \
              --frozen-lockfile \
              --no-progress \
              --backend=copyfile \
              --ignore-scripts

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out

            # Root node_modules: the .bun/ hoisted store plus top-level symlinks.
            cp -r node_modules $out/node_modules

            mkdir -p $out/packages/cq-config $out/packages/cq-cli \
                     $out/packages/ledger $out/packages/ledger-live $out/packages/ledger-mcp \
                     $out/packages/ledger-tui $out/packages/ledger-web
            cp -r packages/cq-config/node_modules     $out/packages/cq-config/node_modules
            cp -r packages/cq-cli/node_modules        $out/packages/cq-cli/node_modules
            cp -r packages/ledger/node_modules      $out/packages/ledger/node_modules
            cp -r packages/ledger-live/node_modules $out/packages/ledger-live/node_modules
            cp -r packages/ledger-mcp/node_modules  $out/packages/ledger-mcp/node_modules
            cp -r packages/ledger-tui/node_modules  $out/packages/ledger-tui/node_modules
            cp -r packages/ledger-web/node_modules  $out/packages/ledger-web/node_modules

            runHook postInstall
          '';

          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          # Refresh after dependency changes (see README § Nix).
          outputHash = "sha256-vCfIJBEcTWTcEQGWHo59PIAAcsSXxYX9w1CUsnmvd/Y=";
        };

        # Shell fragment: stage the @cq/ledger + @cq/ledger-mcp source and
        # their node_modules into $WORKSPACE so a FRONTEND can run the ledger
        # MCP server EMBEDDED in-process (ledger-tui/-web with no --mcp-url).
        # Mirrors the standalone ledger-mcp product's wiring. Expects $WORKSPACE
        # to be set by the caller.
        embedServerClosure = ''
          cp -r packages/ledger     "$WORKSPACE/packages/ledger"
          cp -r packages/ledger-mcp "$WORKSPACE/packages/ledger-mcp"
          cp -r packages/cq-config  "$WORKSPACE/packages/cq-config"
          rm -rf \
            "$WORKSPACE/packages/ledger/node_modules" \
            "$WORKSPACE/packages/ledger-mcp/node_modules" \
            "$WORKSPACE/packages/cq-config/node_modules"

          # @cq/ledger runtime deps.
          mkdir -p "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai" \
                   "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol"
          for dep in zod yaml unified remark-frontmatter remark-parse remark-stringify minisearch bun-types; do
            if [ -e "${bunNodeModules}/packages/ledger/node_modules/$dep" ]; then
              ln -s "${bunNodeModules}/packages/ledger/node_modules/$dep" \
                "$WORKSPACE/packages/ledger/node_modules/$dep"
            fi
          done
          ln -s ${bunNodeModules}/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk \
            "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk"
          ln -s ${bunNodeModules}/packages/ledger/node_modules/@modelcontextprotocol/sdk \
            "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol/sdk"

          # @cq/ledger-mcp runtime deps + its @cq/ledger workspace link.
          mkdir -p "$WORKSPACE/packages/ledger-mcp/node_modules/@modelcontextprotocol" \
                   "$WORKSPACE/packages/ledger-mcp/node_modules/@cq"
          ln -s ${bunNodeModules}/packages/ledger-mcp/node_modules/@modelcontextprotocol/sdk \
            "$WORKSPACE/packages/ledger-mcp/node_modules/@modelcontextprotocol/sdk"
          if [ -e "${bunNodeModules}/packages/ledger-mcp/node_modules/bun-types" ]; then
            ln -s "${bunNodeModules}/packages/ledger-mcp/node_modules/bun-types" \
              "$WORKSPACE/packages/ledger-mcp/node_modules/bun-types"
          fi
          ln -s "$WORKSPACE/packages/ledger" \
            "$WORKSPACE/packages/ledger-mcp/node_modules/@cq/ledger"
          ln -s "$WORKSPACE/packages/cq-config" \
            "$WORKSPACE/packages/ledger-mcp/node_modules/@cq/config"
        '';

        # ledger-mcp — the standalone ledger MCP server. Serves the 18-tool
        # ledger surface over stdio or Streamable HTTP (`--http [host:]port`),
        # backed by a file-backed FsLedgerStore. Closure: the @cq/ledger library
        # + @cq/ledger-mcp binary plus their runtime npm deps from the shared FOD.
        ledgerMcp = pkgs.stdenv.mkDerivation {
          pname = "ledger-mcp";
          version = "0.0.1";

          src = ./nix/pkg/cq-ledgers;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          # Bun transpiles TypeScript at runtime; no compile step here.
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/ledger-mcp
            mkdir -p "$WORKSPACE/packages" $out/bin

            # ── 1. Source: the library + this binary ────────────────────── #
            cp -r packages/ledger    "$WORKSPACE/packages/ledger"
            cp -r packages/ledger-mcp "$WORKSPACE/packages/ledger-mcp"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"
            rm -rf \
              "$WORKSPACE/packages/ledger/node_modules" \
              "$WORKSPACE/packages/ledger-mcp/node_modules"

            # ── 2. ledger node_modules ──────────────────────────────────── #
            # Runtime deps: minisearch (FTS), remark-*/unified/yaml (parser),
            # zod, @modelcontextprotocol/sdk (stdio tool registration), and
            # @anthropic-ai/claude-agent-sdk (the JS `tool()` helper the
            # @cq/ledger barrel re-exports — NOT the native binary).
            mkdir -p "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai" \
                     "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol"
            for dep in zod yaml unified remark-frontmatter remark-parse remark-stringify minisearch bun-types; do
              if [ -e "${bunNodeModules}/packages/ledger/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk \
              "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk"
            ln -s ${bunNodeModules}/packages/ledger/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol/sdk"

            # ── 3. ledger-mcp node_modules ──────────────────────────────── #
            mkdir -p "$WORKSPACE/packages/ledger-mcp/node_modules/@modelcontextprotocol" \
                     "$WORKSPACE/packages/ledger-mcp/node_modules/@cq"
            ln -s ${bunNodeModules}/packages/ledger-mcp/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger-mcp/node_modules/@modelcontextprotocol/sdk"
            if [ -e "${bunNodeModules}/packages/ledger-mcp/node_modules/bun-types" ]; then
              ln -s "${bunNodeModules}/packages/ledger-mcp/node_modules/bun-types" \
                "$WORKSPACE/packages/ledger-mcp/node_modules/bun-types"
            fi
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/ledger-mcp/node_modules/@cq/ledger"

            # @cq/config — config-capability parser dep of @cq/ledger-mcp.
            cp -r packages/cq-config "$WORKSPACE/packages/cq-config"
            rm -rf "$WORKSPACE/packages/cq-config/node_modules"
            ln -s "$WORKSPACE/packages/cq-config" \
              "$WORKSPACE/packages/ledger-mcp/node_modules/@cq/config"

            # ── 4. Wrapper ──────────────────────────────────────────────── #
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ledger-mcp \
              --add-flags "run $WORKSPACE/packages/ledger-mcp/src/main.ts --" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          dontStrip = true;
          dontFixup = true;
        };

        # ledger-tui — Ink terminal UI, a pure MCP client. Two modes: REMOTE
        # (`--mcp-url <url>`, Streamable HTTP) or EMBEDDED (default; MCP server
        # in-process over an in-memory transport, root from `--cwd`/$LEDGER_ROOT/
        # CWD). Runtime closure: ink + react + @modelcontextprotocol/sdk, plus
        # the embedded @cq/ledger + @cq/ledger-mcp server closure.
        ledgerTui = pkgs.stdenv.mkDerivation {
          pname = "ledger-tui";
          version = "0.0.1";

          src = ./nix/pkg/cq-ledgers;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/ledger-tui
            mkdir -p "$WORKSPACE/packages/ledger-tui" $out/bin

            cp -r packages/ledger-tui/src "$WORKSPACE/packages/ledger-tui/src"
            cp packages/ledger-tui/package.json packages/ledger-tui/tsconfig.json \
              "$WORKSPACE/packages/ledger-tui/"
            # @cq/ledger-live (zero runtime deps) — source + workspace symlink.
            mkdir -p "$WORKSPACE/packages/ledger-live"
            cp -r packages/ledger-live/src "$WORKSPACE/packages/ledger-live/src"
            cp packages/ledger-live/package.json "$WORKSPACE/packages/ledger-live/"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"

            # Embedded MCP server closure (@cq/ledger + @cq/ledger-mcp).
            ${embedServerClosure}

            mkdir -p "$WORKSPACE/packages/ledger-tui/node_modules/@modelcontextprotocol" \
                     "$WORKSPACE/packages/ledger-tui/node_modules/@cq"
            for dep in ink react bun-types; do
              if [ -e "${bunNodeModules}/packages/ledger-tui/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger-tui/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger-tui/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger-tui/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger-tui/node_modules/@modelcontextprotocol/sdk"
            ln -s "$WORKSPACE/packages/ledger-live" \
              "$WORKSPACE/packages/ledger-tui/node_modules/@cq/ledger-live"
            # Embedded-mode workspace links: the TUI imports @cq/ledger-mcp at
            # runtime (which resolves @cq/ledger from its own node_modules).
            ln -s "$WORKSPACE/packages/ledger-mcp" \
              "$WORKSPACE/packages/ledger-tui/node_modules/@cq/ledger-mcp"
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/ledger-tui/node_modules/@cq/ledger"

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ledger-tui \
              --add-flags "run $WORKSPACE/packages/ledger-tui/src/main.tsx --" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          dontStrip = true;
          dontFixup = true;
        };

        # ledger-web — static server for the browser explorer/editor + DAG.
        # Serves the React bundle (Bun.build at startup). Two modes: PROXY
        # (`--mcp-url`, reverse-proxies same-origin /mcp+/ws to a separate
        # `ledger-mcp --http`) or EMBEDDED (default; hosts the MCP server
        # in-process on /mcp+/ws, root from `--cwd`/$LEDGER_ROOT/CWD). Bun.build
        # resolves the browser bundle's react / react-dom / sdk from the closure;
        # the embedded server adds the @cq/ledger + @cq/ledger-mcp closure.
        # LEDGER_WEB_OUTDIR redirects bundler output to a writable path.
        ledgerWeb = pkgs.stdenv.mkDerivation {
          pname = "ledger-web";
          version = "0.0.1";

          src = ./nix/pkg/cq-ledgers;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/ledger-web
            mkdir -p "$WORKSPACE/packages/ledger-web" $out/bin

            cp -r packages/ledger-web/src "$WORKSPACE/packages/ledger-web/src"
            cp packages/ledger-web/index.html "$WORKSPACE/packages/ledger-web/"
            cp packages/ledger-web/package.json packages/ledger-web/tsconfig.json \
              "$WORKSPACE/packages/ledger-web/"
            # @cq/ledger-live (bundled by Bun.build) — source + workspace symlink.
            mkdir -p "$WORKSPACE/packages/ledger-live"
            cp -r packages/ledger-live/src "$WORKSPACE/packages/ledger-live/src"
            cp packages/ledger-live/package.json "$WORKSPACE/packages/ledger-live/"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"

            # Embedded MCP server closure (@cq/ledger + @cq/ledger-mcp).
            ${embedServerClosure}

            mkdir -p "$WORKSPACE/packages/ledger-web/node_modules/@modelcontextprotocol" \
                     "$WORKSPACE/packages/ledger-web/node_modules/@cq"
            for dep in react react-dom react-markdown remark-gfm rehype-sanitize bun-types elkjs; do
              if [ -e "${bunNodeModules}/packages/ledger-web/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger-web/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger-web/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger-web/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger-web/node_modules/@modelcontextprotocol/sdk"
            ln -s "$WORKSPACE/packages/ledger-live" \
              "$WORKSPACE/packages/ledger-web/node_modules/@cq/ledger-live"
            # Embedded-mode workspace links: serve.ts imports @cq/ledger-mcp at
            # runtime (which resolves @cq/ledger from its own node_modules).
            ln -s "$WORKSPACE/packages/ledger-mcp" \
              "$WORKSPACE/packages/ledger-web/node_modules/@cq/ledger-mcp"
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/ledger-web/node_modules/@cq/ledger"
            # @cq/config — cq.toml parser used by serve.ts main() (T187).
            ln -s "$WORKSPACE/packages/cq-config" \
              "$WORKSPACE/packages/ledger-web/node_modules/@cq/config"

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ledger-web \
              --add-flags "run $WORKSPACE/packages/ledger-web/src/serve.ts --" \
              --run 'export LEDGER_WEB_OUTDIR="''${LEDGER_WEB_OUTDIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/ledger-web/dist}"' \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          dontStrip = true;
          dontFixup = true;
        };

        # cq — the ledger-suite CLI (`cq init|reset|erase`). A standalone Bun
        # bin (NOT embedded — it constructs an FsLedgerStore directly), modelled
        # on ledgerMcp: stage @cq/cli + @cq/ledger source, strip their
        # node_modules, symlink @cq/ledger (+ its runtime deps from the shared
        # FOD) + @cq/config under cq-cli/node_modules/@cq, makeWrapper bun.
        cqCli = pkgs.stdenv.mkDerivation {
          pname = "cq";
          version = "0.0.1";

          src = ./nix/pkg/cq-ledgers;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/cq
            mkdir -p "$WORKSPACE/packages" $out/bin

            # ── 1. Source: the library + this binary ────────────────────── #
            cp -r packages/ledger "$WORKSPACE/packages/ledger"
            cp -r packages/cq-cli "$WORKSPACE/packages/cq-cli"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"
            rm -rf \
              "$WORKSPACE/packages/ledger/node_modules" \
              "$WORKSPACE/packages/cq-cli/node_modules"

            # ── 2. ledger node_modules (runtime deps, mirrors ledgerMcp) ──── #
            mkdir -p "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai" \
                     "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol"
            for dep in zod yaml unified remark-frontmatter remark-parse remark-stringify minisearch bun-types; do
              if [ -e "${bunNodeModules}/packages/ledger/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk \
              "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk"
            ln -s ${bunNodeModules}/packages/ledger/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol/sdk"

            # ── 3. cq-cli node_modules ──────────────────────────────────── #
            mkdir -p "$WORKSPACE/packages/cq-cli/node_modules/@cq"
            if [ -e "${bunNodeModules}/packages/cq-cli/node_modules/bun-types" ]; then
              ln -s "${bunNodeModules}/packages/cq-cli/node_modules/bun-types" \
                "$WORKSPACE/packages/cq-cli/node_modules/bun-types"
            fi
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/ledger"

            # @cq/config — kept in the closure for parity with the other
            # products; cq-cli resolves it from here should it ever import it.
            cp -r packages/cq-config "$WORKSPACE/packages/cq-config"
            rm -rf "$WORKSPACE/packages/cq-config/node_modules"
            ln -s "$WORKSPACE/packages/cq-config" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/config"

            # ── 4. Wrapper ──────────────────────────────────────────────── #
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/cq \
              --add-flags "run $WORKSPACE/packages/cq-cli/src/main.ts --" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          dontStrip = true;
          dontFixup = true;
        };
      in {
        packages = {
          default = ledgerMcp;
          ledger-mcp = ledgerMcp;
          ledger-tui = ledgerTui;
          ledger-web = ledgerWeb;
          cq = cqCli;
          # Expose for debugging / hash refresh.
          node-modules = bunNodeModules;

          # ── LLM coding-agent harness support packages ──────────────── #
          # The building blocks of homeManagerModules.dev-llm, exposed so
          # consumers (and CI) can build them directly.
          # llm-skills: the validated SKILL.md set (also carries $out/skills).
          llm-skills = (pkgs.callPackage ./nix/pkg/llm-skills/default.nix { }).package;
          # llm-contexts: the general + Pi context fragments as files.
          llm-contexts = (pkgs.callPackage ./nix/pkg/llm-contexts/default.nix { }).package;
          # llm-context-with-env: general context + the environment skill folded
          # in, for skill-less agents (Copilot, Vibe). The file IS the store
          # path; referencing llm-skills.package keeps meta.yaml validation in the
          # consumer's build graph. Consumed by nix-config's dev-opencode.
          llm-context-with-env =
            let
              skills = pkgs.callPackage ./nix/pkg/llm-skills/default.nix { };
              contexts = pkgs.callPackage ./nix/pkg/llm-contexts/default.nix { };
            in
            pkgs.runCommandLocal "context-with-env.md" { } ''
              : "${skills.package}" # pull skill validation into the build graph
              cp ${pkgs.writeText "context-with-env-body" (contexts.general + "\n\n" + skills.environmentContent)} "$out"
            '';
          claude-code = pkgs.callPackage ./nix/pkg/claude-code/package.nix { };
          codex = pkgs.callPackage ./nix/pkg/codex/package.nix { };
          pi-coding-agent = pkgs.callPackage ./nix/pkg/pi-coding-agent/package.nix { };
          pi-xai-patched = pkgs.callPackage ./nix/pkg/pi-xai-patched/package.nix { };
          reattach-llm = pkgs.callPackage ./nix/pkg/reattach-llm/default.nix { };
          # yolo builds its internal llm-sandbox helper itself.
          yolo = pkgs.callPackage ./nix/pkg/yolo/default.nix {
            codegraph = inputs.codegraph.packages.${system}.default;
          };
        };

        apps.default = {
          type = "app";
          program = "${ledgerMcp}/bin/ledger-mcp";
        };
        apps.ledger-mcp = {
          type = "app";
          program = "${ledgerMcp}/bin/ledger-mcp";
        };
        apps.ledger-tui = {
          type = "app";
          program = "${ledgerTui}/bin/ledger-tui";
        };
        apps.ledger-web = {
          type = "app";
          program = "${ledgerWeb}/bin/ledger-web";
        };
        apps.cq = {
          type = "app";
          program = "${cqCli}/bin/cq";
        };

        devShells.default = pkgs.mkShell {
          name = "ledger-suite-dev";

          packages = with pkgs; [
            bun
            nodejs_22
            git
            jq
            ripgrep
            fd
            gh
            # node-pty's native addon (ledger-tui's PTY e2e) builds via node-gyp.
            python3
            gnumake
            gcc
          ];

          shellHook = ''
            echo "ledger-suite dev shell"
            echo "  bun:  $(bun --version)"
            echo "  node: $(node --version)"
            export BUN_INSTALL_CACHE_DIR="$PWD/.cache/bun"
            mkdir -p "$BUN_INSTALL_CACHE_DIR"
          '';
        };
      }))
    // {
      # System-agnostic LLM assets (prompts/skills) — see ./nix/pkg/cq-assets/assets.nix.
      inherit llmAssets;

      # Portable home-manager module: the Claude Code / Codex / Pi coding-agent
      # harness, shared asset-bundle + MCP infrastructure, and the bubblewrap
      # `yolo` sandbox. Curried over this flake's inputs + self. The consumer
      # wires host/hardware values via `smind.hm.dev.llm.*` options and keeps
      # its own opencode / copilot / vibe + local-model provider config.
      homeManagerModules.dev-llm = {
        imports = [
          (import ./nix/hm/dev-llm.nix { inherit inputs self; })
          ./nix/hm/programs-pi.nix
        ];
      };
    };
}
