{
  description = "cq — Web UI for the Claude Agent SDK (Bun + React + WebSocket)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    # The native SDK binary (@anthropic-ai/claude-agent-sdk-linux-x64) is
    # linux-x64-only.  Restrict hermetic build outputs to that system; the
    # devShell is still available on other platforms via eachDefaultSystem.
    let
      buildSystems = [ "x86_64-linux" ];
    in
    flake-utils.lib.eachSystem buildSystems (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # ------------------------------------------------------------------ #
        # Fixed-output derivation: fetches all npm dependencies via           #
        # `bun install --frozen-lockfile`.  Nix allows network access inside  #
        # FODs; hermeticity is guaranteed by the output hash.                 #
        #                                                                      #
        # Output layout:                                                       #
        #   $out/node_modules/          — root hoisted store (.bun/ + links)  #
        #   $out/packages/server/node_modules/                                 #
        #   $out/packages/web/node_modules/                                    #
        #   $out/packages/shared/node_modules/                                 #
        # ------------------------------------------------------------------ #
        bunNodeModules = pkgs.stdenv.mkDerivation {
          pname = "cq-node-modules";
          version = "0.0.1";

          # Only manifest files so the FOD hash is stable across source edits.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./bun.lock
              ./bunfig.toml
              ./packages/shared/package.json
              ./packages/server/package.json
              ./packages/web/package.json
              ./packages/ledger/package.json
              ./packages/cq-mcp/package.json
              ./packages/e2e/package.json
            ];
          };

          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

          dontConfigure = true;
          dontFixup = true;

          buildPhase = ''
            runHook preBuild

            export HOME=$(mktemp -d)
            export XDG_CACHE_HOME="$HOME/.cache"
            # Redirect bun's tarball cache into a throw-away directory.
            export BUN_INSTALL_CACHE_DIR="$HOME/.bun-cache"
            mkdir -p "$BUN_INSTALL_CACHE_DIR"

            # --backend=copyfile: copies instead of hardlinks (hardlinks across
            #   mount-points fail in the Nix sandbox).
            # --ignore-scripts: skip lifecycle scripts that might need network;
            #   the claude-agent-sdk packages carry no postinstall scripts.
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

            # Per-workspace node_modules.  These contain relative symlinks into
            # ../../../../node_modules/.bun/... (resolved at runtime against the
            # workspace root) plus @cq/* workspace symlinks pointing to
            # ../../../shared etc.
            #
            # We copy them here unchanged; the @cq/* symlinks are REWRITTEN in
            # the final `cq` derivation's installPhase to absolute paths so they
            # survive being placed in a different part of the store tree.
            mkdir -p $out/packages/server $out/packages/web $out/packages/shared \
                     $out/packages/ledger $out/packages/cq-mcp
            cp -r packages/server/node_modules $out/packages/server/node_modules
            cp -r packages/web/node_modules    $out/packages/web/node_modules
            cp -r packages/shared/node_modules $out/packages/shared/node_modules
            cp -r packages/ledger/node_modules $out/packages/ledger/node_modules
            cp -r packages/cq-mcp/node_modules $out/packages/cq-mcp/node_modules

            runHook postInstall
          '';

          # Nix verifies the hash after the build finishes.
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          # Updated after the first build (see README § Nix for workflow).
          outputHash = "sha256-F1JSOq4Vyc53Wm6fDNf9KTVnW1OCg30/2bFHGHoww8A=";
        };

        # ------------------------------------------------------------------ #
        # Final package                                                        #
        # ------------------------------------------------------------------ #
        cq = pkgs.stdenv.mkDerivation {
          pname = "cq";
          version = "0.0.1";

          src = ./.;

          nativeBuildInputs = [ pkgs.bun pkgs.makeWrapper ];

          dontConfigure = true;
          # Bun transpiles TypeScript at runtime; buildWeb() is invoked by the
          # server's start path — no separate compile step needed here.
          buildPhase = "true";

          installPhase = ''
            runHook preInstall

            WORKSPACE=$out/share/cq
            mkdir -p "$WORKSPACE" $out/bin

            # ── 1. Copy full workspace source ──────────────────────────── #
            # Exclude existing node_modules (replaced below with FOD refs).
            cp -r . "$WORKSPACE/"
            rm -rf \
              "$WORKSPACE/node_modules" \
              "$WORKSPACE/packages/server/node_modules" \
              "$WORKSPACE/packages/web/node_modules" \
              "$WORKSPACE/packages/shared/node_modules" \
              "$WORKSPACE/packages/ledger/node_modules" \
              "$WORKSPACE/packages/cq-mcp/node_modules"

            # ── 2. Root node_modules ────────────────────────────────────── #
            # Create a real directory that mirrors the FOD's root node_modules
            # structure, so we can add extra entries (e.g. @anthropic-ai/*).
            # Top-level entries are symlinked into the FOD to avoid copying.
            mkdir -p "$WORKSPACE/node_modules"
            for entry in ${bunNodeModules}/node_modules/*; do
              ln -s "$entry" "$WORKSPACE/node_modules/$(basename $entry)"
            done
            for entry in ${bunNodeModules}/node_modules/.*; do
              base=$(basename "$entry")
              # Skip . and ..
              [ "$base" = "." ] || [ "$base" = ".." ] || \
                ln -s "$entry" "$WORKSPACE/node_modules/$base"
            done
            # Expose the SDK binary package at the root node_modules level
            # (satisfies deployment tooling that looks there, e.g. acceptance tests).
            mkdir -p "$WORKSPACE/node_modules/@anthropic-ai"
            ln -s ${bunNodeModules}/node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.150/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 \
              "$WORKSPACE/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"

            # ── 3. Per-workspace node_modules ───────────────────────────── #
            # The FOD's per-package node_modules contain:
            #   a) symlinks to ../../../../node_modules/.bun/... — these stay
            #      valid because the relative path from packages/X/node_modules/
            #      to the root node_modules is the same (3–4 levels up).
            #   b) @cq/* workspace symlinks — these MUST be rewritten: in the
            #      FOD they point to ../../../shared (→ FOD/packages/shared,
            #      which has no source).  We replace them with absolute paths
            #      into $WORKSPACE/packages/*.

            # server
            mkdir -p "$WORKSPACE/packages/server/node_modules/@anthropic-ai" \
                     "$WORKSPACE/packages/server/node_modules/@cq"
            # npm deps — preserved as symlinks relative to their original depth
            ln -s ${bunNodeModules}/packages/server/node_modules/@anthropic-ai/claude-agent-sdk \
              "$WORKSPACE/packages/server/node_modules/@anthropic-ai/claude-agent-sdk"
            ln -s ${bunNodeModules}/packages/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 \
              "$WORKSPACE/packages/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"
            # @anthropic-ai/sdk — used by titleGenerator.ts for the Haiku
            # session-title call. Distinct package from claude-agent-sdk; was
            # added in the resume-from-history rework (outer-4) but the closure
            # spec wasn't updated, breaking `nix run` at runtime.
            ln -s ${bunNodeModules}/packages/server/node_modules/@anthropic-ai/sdk \
              "$WORKSPACE/packages/server/node_modules/@anthropic-ai/sdk"
            ln -s ${bunNodeModules}/packages/server/node_modules/zod \
              "$WORKSPACE/packages/server/node_modules/zod"
            ln -s ${bunNodeModules}/packages/server/node_modules/bun-types \
              "$WORKSPACE/packages/server/node_modules/bun-types"
            # workspace deps — absolute so they resolve to source, not FOD stubs
            ln -s "$WORKSPACE/packages/shared" \
              "$WORKSPACE/packages/server/node_modules/@cq/shared"
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/server/node_modules/@cq/ledger"
            ln -s "$WORKSPACE/packages/cq-mcp" \
              "$WORKSPACE/packages/server/node_modules/@cq/cq-mcp"
            # bin shim so node_modules/.bin/cq-mcp resolves via the workspace
            # symlink to packages/cq-mcp/src/main.ts (executable Bun script).
            mkdir -p "$WORKSPACE/packages/server/node_modules/.bin"
            ln -s ../@cq/cq-mcp/src/main.ts \
              "$WORKSPACE/packages/server/node_modules/.bin/cq-mcp"

            # web
            mkdir -p "$WORKSPACE/packages/web/node_modules/@types" \
                     "$WORKSPACE/packages/web/node_modules/@happy-dom" \
                     "$WORKSPACE/packages/web/node_modules/@cq"
            ln -s ${bunNodeModules}/packages/web/node_modules/@types/react \
              "$WORKSPACE/packages/web/node_modules/@types/react"
            ln -s ${bunNodeModules}/packages/web/node_modules/@types/react-dom \
              "$WORKSPACE/packages/web/node_modules/@types/react-dom"
            ln -s ${bunNodeModules}/packages/web/node_modules/react \
              "$WORKSPACE/packages/web/node_modules/react"
            ln -s ${bunNodeModules}/packages/web/node_modules/react-dom \
              "$WORKSPACE/packages/web/node_modules/react-dom"
            ln -s ${bunNodeModules}/packages/web/node_modules/react-markdown \
              "$WORKSPACE/packages/web/node_modules/react-markdown"
            ln -s ${bunNodeModules}/packages/web/node_modules/remark-gfm \
              "$WORKSPACE/packages/web/node_modules/remark-gfm"
            ln -s ${bunNodeModules}/packages/web/node_modules/shiki \
              "$WORKSPACE/packages/web/node_modules/shiki"
            ln -s ${bunNodeModules}/packages/web/node_modules/bun-types \
              "$WORKSPACE/packages/web/node_modules/bun-types"
            ln -s ${bunNodeModules}/packages/web/node_modules/@happy-dom/global-registrator \
              "$WORKSPACE/packages/web/node_modules/@happy-dom/global-registrator"
            # workspace dep
            ln -s "$WORKSPACE/packages/shared" \
              "$WORKSPACE/packages/web/node_modules/@cq/shared"

            # shared (no workspace deps)
            mkdir -p "$WORKSPACE/packages/shared/node_modules"
            ln -s ${bunNodeModules}/packages/shared/node_modules/zod \
              "$WORKSPACE/packages/shared/node_modules/zod"
            ln -s ${bunNodeModules}/packages/shared/node_modules/bun-types \
              "$WORKSPACE/packages/shared/node_modules/bun-types"

            # ledger (npm deps used at runtime: anthropic-ai/claude-agent-sdk,
            # minisearch, remark-*, unified, yaml, zod; no @cq/* workspace deps).
            # minisearch backs the in-memory FTS index (fts_search). It must be
            # in the closure for BOTH @cq/ledger consumers — the cq server AND
            # the cq-mcp stdio binary — but cq-mcp's @cq/ledger is a symlink to
            # this same packages/ledger (see below), so symlinking it here once
            # covers both.
            mkdir -p "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai"
            for dep in zod yaml unified remark-frontmatter remark-parse remark-stringify minisearch bun-types; do
              if [ -e "${bunNodeModules}/packages/ledger/node_modules/$dep" ]; then
                ln -s "${bunNodeModules}/packages/ledger/node_modules/$dep" \
                  "$WORKSPACE/packages/ledger/node_modules/$dep"
              fi
            done
            ln -s ${bunNodeModules}/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk \
              "$WORKSPACE/packages/ledger/node_modules/@anthropic-ai/claude-agent-sdk"

            # cq-mcp (runtime: @cq/ledger workspace, @modelcontextprotocol/sdk, zod)
            mkdir -p "$WORKSPACE/packages/cq-mcp/node_modules/@modelcontextprotocol" \
                     "$WORKSPACE/packages/cq-mcp/node_modules/@cq" \
                     "$WORKSPACE/packages/cq-mcp/node_modules/.bin"
            ln -s ${bunNodeModules}/packages/cq-mcp/node_modules/@modelcontextprotocol/sdk \
              "$WORKSPACE/packages/cq-mcp/node_modules/@modelcontextprotocol/sdk"
            ln -s ${bunNodeModules}/packages/cq-mcp/node_modules/zod \
              "$WORKSPACE/packages/cq-mcp/node_modules/zod"
            if [ -e "${bunNodeModules}/packages/cq-mcp/node_modules/bun-types" ]; then
              ln -s "${bunNodeModules}/packages/cq-mcp/node_modules/bun-types" \
                "$WORKSPACE/packages/cq-mcp/node_modules/bun-types"
            fi
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/cq-mcp/node_modules/@cq/ledger"

            # ── 4. Wrapper ──────────────────────────────────────────────── #
            # CWD is left as-is (wherever the user invokes `cq`) so that the
            # log directory default (./var/log) lands somewhere writable.
            # CQ_WEB_OUTDIR redirects Bun.build output away from the read-only
            # Nix store into a user-writable cache directory.
            # Bun resolves imports via import.meta.dir (absolute, store-relative)
            # and node_modules walk — independent of CWD — so no --chdir needed.
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/cq \
              --add-flags "run $WORKSPACE/packages/server/src/main.ts --" \
              --run 'export CQ_WEB_OUTDIR="''${CQ_WEB_OUTDIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/cq/web-dist}"' \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            # cq-mcp: standalone stdio MCP binary used by Codex sessions to
            # reach the same ledger tool surface as Claude sessions. The Codex
            # CLI spawns it as an external process via mcp_servers.cq.command.
            # Closure presence is required by D-CQMCP-NIX.
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/cq-mcp \
              --add-flags "run $WORKSPACE/packages/cq-mcp/src/main.ts --" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          # Do NOT strip or fixup: the 240 MB native claude binary must not be
          # modified by strip/patchelf heuristics.
          dontStrip = true;
          dontFixup = true;
        };
      in {
        packages = {
          default = cq;
          cq = cq;
          # Expose for debugging / hash refresh.
          cq-node-modules = bunNodeModules;
        };

        apps.default = {
          type = "app";
          program = "${cq}/bin/cq";
        };

        devShells.default = pkgs.mkShell {
          name = "cq-dev";

          packages = with pkgs; [
            bun
            nodejs_22
            sqlite
            sqlite-interactive
            git
            jq
            ripgrep
            fd
            gh
            # Playwright Chromium bundle: pinned via flake. The PLAYWRIGHT_*
            # env vars below tell @playwright/test where to find the binary
            # so it does NOT try to download from the internet.
            playwright-driver.browsers
          ];

          shellHook = ''
            echo "cq dev shell"
            echo "  bun:    $(bun --version)"
            echo "  node:   $(node --version)"
            echo "  sqlite: $(sqlite3 --version | awk '{print $1}')"
            export BUN_INSTALL_CACHE_DIR="$PWD/.cache/bun"
            mkdir -p "$BUN_INSTALL_CACHE_DIR"
            # Playwright: use the flake-provisioned browsers, don't download.
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
          '';
        };
      });
}
