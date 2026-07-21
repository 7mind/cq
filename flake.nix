{
  description = "cq — markdown-backed ledger suite (MCP + TUI/web) and a portable LLM coding-agent harness (Claude/Codex/Pi + yolo)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # LLM coding-agent harness dependencies, consumed by
    # homeManagerModules.dev-llm (the extracted Claude/Codex/Pi + yolo setup).
    # CodeGraph — semantic code-intelligence MCP server (colbymchenry/codegraph).
    # Upstream ships NO nix support, so `flake = false` (source only) tracking
    # `main` (the lock pins the rev); we vendor the build
    # (nix/pkg/codegraph/package.nix) with THIS flake's nixpkgs.
    # `nix flake update codegraph` to advance main.
    codegraph = {
      url = "github:colbymchenry/codegraph";
      flake = false;
    };
    # Darwin sandbox wrapper for claude-code (Linux uses the bubblewrap yolo).
    claude-code-sandbox.url = "github:neko-kai/claude-code-sandbox";
  };

  outputs = inputs@{ self, nixpkgs, flake-utils, ... }:
    let
      # The ledger products are pure Bun/TypeScript and build on Linux and
      # macOS alike. aarch64-darwin (Apple Silicon) is supported alongside
      # x86_64-linux. NOTE: the bun FOD hash is PER-SYSTEM — deps such as
      # @anthropic-ai/claude-agent-sdk ship per-os/cpu optional binaries, so
      # `bun install` yields platform-specific node_modules (see node-modules
      # outputHash below). The Linux-only harness packages (yolo, reattach-llm)
      # are gated to Linux in the packages set.
      buildSystems = [ "x86_64-linux" "aarch64-darwin" ];

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
          # Refresh after dependency changes (see README § Nix). PER-SYSTEM:
          # `bun install` filters os/cpu-specific optional deps (e.g.
          # @anthropic-ai/claude-agent-sdk-{darwin-arm64,linux-x64,…}) to the
          # build platform, so the FOD content — and thus the hash — differs per
          # system. To add a system: set its entry to nixpkgs lib.fakeHash
          # (sha256-AAAA…), `nix build .#node-modules`, paste the reported `got:`.
          outputHash = {
            "x86_64-linux" = "sha256-J6Z2LIvr1CEZGKh1bJtQquY1PdZ49Y3dQcV1PXS4MAc=";
            "aarch64-darwin" = "sha256-I5SAJnHLOR1mh43XqRwNcJaBptSm6IX4xeT8pPXHrJE=";
          }.${system} or (throw "ledger-node-modules: no FOD hash pinned for ${system}");
        };

        # Shell fragment: wire @cq/config as a RUNTIME dep of @cq/ledger. Since
        # T357, createLedgerStore() (in @cq/ledger) calls loadConfig() at startup
        # to pick the [ledger] backend, so @cq/config must resolve from inside
        # @cq/ledger AND its own deps (ajv + smol-toml) must be staged. Expects
        # $WORKSPACE/packages/cq-config already staged (node_modules removed) and
        # $WORKSPACE/packages/ledger/node_modules already created.
        cqConfigForLedger = ''
          mkdir -p "$WORKSPACE/packages/cq-config/node_modules"
          for dep in ajv smol-toml; do
            if [ -e "${bunNodeModules}/packages/cq-config/node_modules/$dep" ]; then
              ln -s "${bunNodeModules}/packages/cq-config/node_modules/$dep" \
                "$WORKSPACE/packages/cq-config/node_modules/$dep"
            fi
          done
          mkdir -p "$WORKSPACE/packages/ledger/node_modules/@cq"
          ln -s "$WORKSPACE/packages/cq-config" \
            "$WORKSPACE/packages/ledger/node_modules/@cq/config"
        '';

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
          for dep in zod yaml unified remark-frontmatter remark-parse remark-stringify minisearch postgres bun-types; do
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

          # @cq/ledger itself now imports @cq/config (createLedgerStore).
          ${cqConfigForLedger}
        '';

        # Shell fragment: stage @cq/ledger-live source + its workspace symlink
        # into $WORKSPACE. Shared by the TUI and web closures (both bundle/import
        # @cq/ledger-live). Idempotent — guarded so it can run once even when
        # both tuiClosure and webClosure are staged into the same $WORKSPACE
        # (the merged cqCli derivation). Expects $WORKSPACE/packages to exist.
        ledgerLiveSource = ''
          if [ ! -d "$WORKSPACE/packages/ledger-live" ]; then
            mkdir -p "$WORKSPACE/packages/ledger-live"
            cp -r packages/ledger-live/src "$WORKSPACE/packages/ledger-live/src"
            cp packages/ledger-live/package.json "$WORKSPACE/packages/ledger-live/"
          fi
        '';

        # Shell fragment: stage the @cq/ledger-tui source + its runtime closure
        # (ink + react + @modelcontextprotocol/sdk, the @cq/ledger-live link, and
        # the embedded-mode @cq/ledger-mcp + @cq/ledger workspace links). Expects
        # the embedded MCP server closure (embedServerClosure) to be staged FIRST
        # so $WORKSPACE/packages/{ledger,ledger-mcp} exist. Extracted from the
        # ledgerTui derivation so cqCli can reuse it once the standalone
        # derivation is removed (T392).
        tuiClosure = ''
          mkdir -p "$WORKSPACE/packages/ledger-tui"
          cp -r packages/ledger-tui/src "$WORKSPACE/packages/ledger-tui/src"
          cp packages/ledger-tui/package.json packages/ledger-tui/tsconfig.json \
            "$WORKSPACE/packages/ledger-tui/"
          # @cq/ledger-live (zero runtime deps) — source + workspace symlink.
          ${ledgerLiveSource}

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
        '';

        # Shell fragment: stage the @cq/ledger-web SPA source + its runtime
        # closure (index.html + react/react-dom/react-markdown/remark-gfm/
        # rehype-sanitize/elkjs links + @modelcontextprotocol/sdk, the
        # @cq/ledger-live link, the embedded-mode @cq/ledger-mcp + @cq/ledger
        # links, and the @cq/config link for serve.ts main()). Expects the
        # embedded MCP server closure (embedServerClosure) staged FIRST so
        # $WORKSPACE/packages/{ledger,ledger-mcp,cq-config} exist. Extracted
        # from the ledgerWeb derivation so cqCli can reuse it once the standalone
        # derivation is removed (T392). NOTE: the LEDGER_WEB_OUTDIR writable-
        # bundle wrapper env lives on the consuming derivation's makeWrapper
        # (it is a wrapper concern, not a staging one).
        webClosure = ''
          mkdir -p "$WORKSPACE/packages/ledger-web"
          cp -r packages/ledger-web/src "$WORKSPACE/packages/ledger-web/src"
          cp packages/ledger-web/index.html "$WORKSPACE/packages/ledger-web/"
          cp packages/ledger-web/package.json packages/ledger-web/tsconfig.json \
            "$WORKSPACE/packages/ledger-web/"
          # @cq/ledger-live (bundled by Bun.build) — source + workspace symlink.
          ${ledgerLiveSource}

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
        '';

        # cq — the ledger-suite CLI (`cq init|reset|erase`). A standalone Bun
        # bin (NOT embedded — it constructs an FsLedgerStore directly), modelled
        # on ledgerMcp; see the numbered installPhase below for the staging steps.
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

            # ── 1. Source: this binary + top-level workspace manifests ───── #
            # (@cq/ledger, @cq/ledger-mcp, @cq/cq-config, @cq/ledger-live and
            #  the tui/web SPA sources are staged by the closure fragments
            #  below — embedServerClosure / tuiClosure / webClosure.)
            cp -r packages/cq-cli "$WORKSPACE/packages/cq-cli"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"
            rm -rf "$WORKSPACE/packages/cq-cli/node_modules"

            # ── 2. Union closure: cq dispatches mcp|tui|web in-process via ── #
            #   dynamic import("@cq/ledger-{mcp,tui,web}"), so its workspace
            #   stages all four product stagings:
            #   (a) embedServerClosure — @cq/ledger + @cq/ledger-mcp + @cq/config
            #       (the `cq mcp` server AND the embedded TUI/web MCP servers);
            ${embedServerClosure}
            #   (b) tuiClosure — ink/react + @cq/ledger-tui source;
            ${tuiClosure}
            #   (c) webClosure — @cq/ledger-web SPA source + react/react-dom/
            #       react-markdown/remark-gfm/rehype-sanitize/elkjs + index.html.
            ${webClosure}

            # ── 3. cq-cli node_modules ──────────────────────────────────── #
            # The dispatcher resolves @cq/ledger (init/reset/erase build an
            # FsLedgerStore directly) plus the dynamically-imported
            # @cq/ledger-{mcp,tui,web,live} subcommand entrypoints.
            mkdir -p "$WORKSPACE/packages/cq-cli/node_modules/@cq"
            if [ -e "${bunNodeModules}/packages/cq-cli/node_modules/bun-types" ]; then
              ln -s "${bunNodeModules}/packages/cq-cli/node_modules/bun-types" \
                "$WORKSPACE/packages/cq-cli/node_modules/bun-types"
            fi
            ln -s "$WORKSPACE/packages/ledger" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/ledger"
            # @cq/config — cq-cli's runInit/runReset route through @cq/ledger's
            # createLedgerStore (T357), which imports @cq/config at startup.
            ln -s "$WORKSPACE/packages/cq-config" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/config"
            # Dispatcher subcommand entrypoints (dynamic import).
            ln -s "$WORKSPACE/packages/ledger-mcp" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/ledger-mcp"
            ln -s "$WORKSPACE/packages/ledger-tui" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/ledger-tui"
            ln -s "$WORKSPACE/packages/ledger-web" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/ledger-web"
            ln -s "$WORKSPACE/packages/ledger-live" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/ledger-live"

            # ── 4. Wrapper ──────────────────────────────────────────────── #
            # LEDGER_WEB_OUTDIR redirects embedded `cq web` Bun.build output to a
            # writable path (the store closure is read-only). Carried over from
            # the standalone ledger-web wrapper.
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/cq \
              --add-flags "run $WORKSPACE/packages/cq-cli/src/main.ts --" \
              --run 'export LEDGER_WEB_OUTDIR="''${LEDGER_WEB_OUTDIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/ledger-web/dist}"' \
              --set-default CQ_ASSETS_DIR "${./nix/pkg/cq-assets}" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 ]}

            runHook postInstall
          '';

          # Smoke assertion (D103): run the installed binary once so a staging
          # omission (a runtime dep missing from a closure fragment's symlink
          # loop) fails the BUILD instead of every later invocation. A healthy
          # dispatcher prints USAGE and exits 2 on the unknown `--help` token;
          # a module-resolution crash exits 1 with no usage text.
          doInstallCheck = true;
          installCheckPhase = ''
            runHook preInstallCheck
            set +e
            smoke=$(HOME=$TMPDIR $out/bin/cq --help 2>&1)
            code=$?
            set -e
            if [ "$code" -ne 2 ] || [ "''${smoke#*usage: cq}" = "$smoke" ]; then
              echo "cq smoke check FAILED (exit $code, expected usage + exit 2):" >&2
              echo "$smoke" >&2
              exit 1
            fi
            runHook postInstallCheck
          '';

          dontStrip = true;
          dontFixup = true;
        };
      in {
        packages = {
          default = cqCli;
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
          # in, for skill-less agents (consumers that can't load SKILL.md trees).
          # The file IS the store path; referencing llm-skills.package keeps
          # meta.yaml validation in the consumer's build graph.
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
          # CodeGraph — vendored from its `main` source (flake = false input),
          # built with our nixpkgs. platforms.unix -> builds on linux + darwin.
          codegraph = pkgs.callPackage ./nix/pkg/codegraph/package.nix {
            src = inputs.codegraph;
          };
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # ── Linux-only harness packages ────────────────────────────── #
          # yolo execs bubblewrap + nix-ld (Linux-only); the standalone
          # reattach-llm declares meta.platforms = linux. Excluded on macOS,
          # where the Darwin claude-code sandbox rides via claude-code-sandbox.
          reattach-llm = pkgs.callPackage ./nix/pkg/reattach-llm/default.nix { };
          # yolo builds its internal llm-sandbox helper itself. codegraph is no
          # longer a package input — it rides in via sandboxPackages (wired by
          # the home-manager module), so the bare package needs no args.
          yolo = pkgs.callPackage ./nix/pkg/yolo/default.nix { };
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isDarwin {
          # Darwin uses Seatbelt via claude-code-sandbox; Linux uses bwrap above.
          yolo-darwin = pkgs.callPackage ./nix/pkg/yolo-darwin/default.nix {
            claude-code-sandbox = inputs.claude-code-sandbox.packages.${system}.default;
          };
        };

        # Policy generation runs everywhere; real Seatbelt enforcement runs on Darwin.
        checks =
          {
            yolo-darwin-profile =
              pkgs.runCommand "yolo-darwin-profile"
                {
                  nativeBuildInputs = [ pkgs.shellcheck pkgs.bash pkgs.jq ];
                }
                ''
                  cp -r ${./nix/pkg/yolo} yolo
                  cp -r ${./nix/pkg/yolo-darwin} yolo-darwin
                  chmod -R u+w yolo-darwin
                  cd yolo-darwin
                  shellcheck ../yolo/custom-prompt.sh yolo-darwin.sh profile-test.sh
                  bash profile-test.sh
                  touch $out
                '';
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isDarwin {
          yolo-darwin-confinement =
            pkgs.runCommand "yolo-darwin-confinement"
              {
                nativeBuildInputs = [ self.packages.${system}.yolo-darwin ];
              }
              ''
                set -euo pipefail

                # Keep HOME outside the granted working directory.
                export HOME="$(mktemp -d)"
                work="$(mktemp -d)"

                inside="$work/inside.txt"
                echo "INSIDE-OK" > "$inside"

                # Exercise the blanket sibling-profile deny after the base allows.
                outside_dir="$HOME/.config/yolo/other-profile"
                mkdir -p "$outside_dir"
                outside="$outside_dir/secret.txt"
                echo "OUTSIDE-SECRET" > "$outside"

                cd "$work"

                if ! yolo cmd cat "$inside" > got-inside 2> err-inside; then
                  echo "FAIL: read of a file INSIDE \$PWD was denied" >&2
                  cat err-inside >&2
                  exit 1
                fi
                grep -q INSIDE-OK got-inside || {
                  echo "FAIL: inside-\$PWD read returned unexpected content" >&2
                  exit 1
                }

                # Reject both a successful read and a non-zero command that leaked data.
                if yolo cmd cat "$outside" > got-outside 2> err-outside; then
                  echo "FAIL: read of a file OUTSIDE \$PWD SUCCEEDED but must be denied" >&2
                  cat got-outside >&2
                  exit 1
                fi
                if grep -q OUTSIDE-SECRET got-outside; then
                  echo "FAIL: outside-\$PWD read leaked secret content to stdout despite non-zero exit" >&2
                  exit 1
                fi

                echo "yolo-darwin confinement OK: inside-\$PWD allowed, outside-\$PWD denied (no leak)"
                touch "$out"
              '';
        };

        apps.default = {
          type = "app";
          program = "${cqCli}/bin/cq";
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
      # its own local-model provider config.
      homeManagerModules.dev-llm = {
        imports = [
          (import ./nix/hm/dev-llm.nix { inherit inputs self; })
        ];
      };
    };
}
