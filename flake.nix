{
  description = "ledger-suite — markdown-backed ledgers: MCP server + TUI/web frontends (Bun)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # All products are pure Bun/TypeScript; pin to x86_64-linux for the
      # hermetic outputs (the dev shell is available on other systems too).
      buildSystems = [ "x86_64-linux" ];
    in
    flake-utils.lib.eachSystem buildSystems (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # ------------------------------------------------------------------ #
        # Fixed-output derivation: fetches all npm dependencies via           #
        # `bun install --frozen-lockfile`. Nix allows network access inside   #
        # FODs; hermeticity is guaranteed by the output hash.                 #
        # ------------------------------------------------------------------ #
        bunNodeModules = pkgs.stdenv.mkDerivation {
          pname = "ledger-node-modules";
          version = "0.0.1";

          # Only manifest files so the FOD hash is stable across source edits.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./bun.lock
              ./bunfig.toml
              ./packages/ledger/package.json
              ./packages/ledger-mcp/package.json
              ./packages/ledger-tui/package.json
              ./packages/ledger-web/package.json
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

            mkdir -p $out/packages/ledger $out/packages/ledger-mcp \
                     $out/packages/ledger-tui $out/packages/ledger-web
            cp -r packages/ledger/node_modules     $out/packages/ledger/node_modules
            cp -r packages/ledger-mcp/node_modules $out/packages/ledger-mcp/node_modules
            cp -r packages/ledger-tui/node_modules $out/packages/ledger-tui/node_modules
            cp -r packages/ledger-web/node_modules $out/packages/ledger-web/node_modules

            runHook postInstall
          '';

          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          # Refresh after dependency changes (see README § Nix).
          outputHash = "sha256-B2IEK35KNFZpD3iISmh+EIUzWyjwbi8TxJXq/tJ4U/M=";
        };

        # ------------------------------------------------------------------ #
        # ledger-mcp — the standalone ledger MCP server.                       #
        #                                                                      #
        # Serves the 14-tool ledger surface over stdio or Streamable HTTP      #
        # (`--http [host:]port`), backed by a file-backed FsLedgerStore. The   #
        # closure is the @cq/ledger library + the @cq/ledger-mcp binary plus   #
        # their runtime npm deps from the shared FOD.                          #
        # ------------------------------------------------------------------ #
        ledgerMcp = pkgs.stdenv.mkDerivation {
          pname = "ledger-mcp";
          version = "0.0.1";

          src = ./.;

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

            # ── 4. Wrapper ──────────────────────────────────────────────── #
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ledger-mcp \
              --add-flags "run $WORKSPACE/packages/ledger-mcp/src/main.ts --" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          dontStrip = true;
          dontFixup = true;
        };

        # ------------------------------------------------------------------ #
        # ledger-tui — Ink terminal UI client for a ledger MCP server.         #
        #                                                                      #
        # A pure MCP client over Streamable HTTP (`ledger-tui --url <url>`).   #
        # Runtime closure: ink + react + @modelcontextprotocol/sdk (+ their    #
        # transitive deps via the FOD .bun store). @cq/ledger is type-only.    #
        # ------------------------------------------------------------------ #
        ledgerTui = pkgs.stdenv.mkDerivation {
          pname = "ledger-tui";
          version = "0.0.1";

          src = ./.;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/ledger-tui
            mkdir -p "$WORKSPACE/packages/ledger-tui" $out/bin

            cp -r packages/ledger-tui/src "$WORKSPACE/packages/ledger-tui/src"
            cp packages/ledger-tui/package.json "$WORKSPACE/packages/ledger-tui/"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"

            mkdir -p "$WORKSPACE/packages/ledger-tui/node_modules/@modelcontextprotocol"
            for dep in ink react bun-types; do
              if [ -e "${bunNodeModules}/packages/ledger-tui/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger-tui/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger-tui/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger-tui/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger-tui/node_modules/@modelcontextprotocol/sdk"

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ledger-tui \
              --add-flags "run $WORKSPACE/packages/ledger-tui/src/main.tsx --" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          dontStrip = true;
          dontFixup = true;
        };

        # ------------------------------------------------------------------ #
        # ledger-web — static server for the browser explorer/editor + DAG.    #
        #                                                                      #
        # Serves the React bundle (Bun.build at startup) and injects a default  #
        # MCP URL; the browser is a pure MCP client to a separately-running     #
        # `ledger-mcp --http` (CORS-enabled). The server imports no npm deps,   #
        # but Bun.build resolves the browser bundle's react / react-dom /       #
        # @modelcontextprotocol/sdk from the closure at build time.             #
        # LEDGER_WEB_OUTDIR redirects the bundler output to a writable path.    #
        # ------------------------------------------------------------------ #
        ledgerWeb = pkgs.stdenv.mkDerivation {
          pname = "ledger-web";
          version = "0.0.1";

          src = ./.;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/ledger-web
            mkdir -p "$WORKSPACE/packages/ledger-web" $out/bin

            cp -r packages/ledger-web/src "$WORKSPACE/packages/ledger-web/src"
            cp packages/ledger-web/index.html "$WORKSPACE/packages/ledger-web/"
            cp packages/ledger-web/package.json "$WORKSPACE/packages/ledger-web/"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"

            mkdir -p "$WORKSPACE/packages/ledger-web/node_modules/@modelcontextprotocol"
            for dep in react react-dom react-markdown remark-gfm rehype-sanitize bun-types; do
              if [ -e "${bunNodeModules}/packages/ledger-web/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger-web/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger-web/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger-web/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/ledger-web/node_modules/@modelcontextprotocol/sdk"

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/ledger-web \
              --add-flags "run $WORKSPACE/packages/ledger-web/src/serve.ts --" \
              --run 'export LEDGER_WEB_OUTDIR="''${LEDGER_WEB_OUTDIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/ledger-web/dist}"' \
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
          # Expose for debugging / hash refresh.
          node-modules = bunNodeModules;
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
      });
}
