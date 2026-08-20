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
    openai-codex-plugin = {
      url = "github:openai/codex-plugin-cc";
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

        mkCodexCommandSkills = import ./nix/lib/codex-command-skills.nix { lib = pkgs.lib; };
        promptSurfacesTest = import ./nix/lib/prompt-surfaces-test.nix {
          lib = pkgs.lib;
        };
        promptCatalogTest = import ./nix/lib/prompt-catalog-test.nix {
          lib = pkgs.lib;
        };
        claudePromptRoot = import ./nix/pkg/cq-assets/render-prompt-surface.nix {
          inherit pkgs;
          lib = pkgs.lib;
          surface = "claude";
        };
        codexPromptRoot = import ./nix/pkg/cq-assets/render-prompt-surface.nix {
          inherit pkgs;
          lib = pkgs.lib;
          surface = "codex";
        };
        codexLedgerMcpRegistration = import ./nix/lib/codex-ledger-mcp-registration.nix {
          lib = pkgs.lib;
          inherit codexPromptRoot;
        };
        codexProjection = mkCodexCommandSkills {
          catalog = llmAssets.catalog;
          promptRoot = codexPromptRoot;
        };
        codexCqSkillSpecs = codexProjection.skills;
        codexCommandSkillsTest = import ./nix/lib/codex-command-skills-test.nix {
          lib = pkgs.lib;
          inherit
            pkgs
            mkCodexCommandSkills
            ;
          catalog = llmAssets.catalog;
          commands = llmAssets.commands;
          promptRoot = codexPromptRoot;
          ledgerMcpRegistration = {
            command = "${cqCli}/bin/cq";
            args = [ "mcp" ];
          };
        };
        codexHarnessEnv = import ./nix/lib/codex-harness-env.nix { lib = pkgs.lib; };
        # T691 / defects:D178 half (b): parse one rendered native-agent declaration
        # and check it against the role body it must carry. A FILE rather than a
        # `python3 -c` string: the assertions need both quote characters, which no
        # single-quoted shell argument can carry.
        verifyCodexAgentDeclaration = pkgs.writeText "verify-codex-agent-declaration.py" ''
          import sys
          import tomllib

          name, declaration_path, body_path = sys.argv[1:4]
          expected_keys = ["description", "developer_instructions", "name"]

          with open(declaration_path, "rb") as handle:
              document = tomllib.load(handle)

          if sorted(document) != expected_keys:
              sys.exit(f"{name}: expected keys {expected_keys}, got {sorted(document)}")
          if document["name"] != name:
              sys.exit(f"{name}: the name field is {document['name']!r}")
          if not str(document["description"]).strip():
              sys.exit(f"{name}: the description is empty")

          body = document["developer_instructions"]
          with open(body_path, "r", encoding="utf-8") as handle:
              expected_body = handle.read()

          if not body.strip():
              sys.exit(f"{name}: developer_instructions is empty")
          if body.rstrip("\n") != expected_body.rstrip("\n"):
              sys.exit(f"{name}: developer_instructions is not the role body verbatim")
        '';
        claudePromptHomeTest = import ./nix/lib/claude-prompt-home-test.nix {
          lib = pkgs.lib;
          inherit pkgs claudePromptRoot;
          claudeModule = import ./nix/hm/claude.nix { inherit inputs self; };
        };
        globalCqConfigHomeTest = import ./nix/lib/global-cq-config-home-test.nix {
          lib = pkgs.lib;
          inherit
            pkgs
            inputs
            self
            ;
        };
        piPromptRoot = import ./nix/pkg/cq-assets/render-prompt-surface.nix {
          inherit pkgs;
          lib = pkgs.lib;
          surface = "pi";
        };
        piPromptRootTest = import ./nix/lib/pi-prompt-root-test.nix {
          lib = pkgs.lib;
          inherit pkgs piPromptRoot;
        };
        piCodingAgent = pkgs.callPackage ./nix/pkg/pi-coding-agent/package.nix { };

        packagedPromptSurfaceVerifierSource =
          let
            configRoot = ./nix/pkg/cq-ledgers/packages/cq-config;
          in
          pkgs.lib.fileset.toSource {
            root = configRoot;
            fileset = pkgs.lib.fileset.unions [
              (configRoot + "/scripts/validate-prompt-surface-attestation.ts")
              (configRoot + "/src/packagedPromptSurface.ts")
              (configRoot + "/src/promptCatalog.ts")
              (configRoot + "/src/promptRenderer.ts")
            ];
          };

        # Shared *-prompt-root check snippet (T1597): validate the attested
        # packaged-surface manifest and exact catalog-derived role closure
        # through the canonical TypeScript serializer contract.
        verifySurfaceAttestation = surface: root: ''
          set -eu
          ${pkgs.bun}/bin/bun run \
            ${packagedPromptSurfaceVerifierSource}/scripts/validate-prompt-surface-attestation.ts \
            ${pkgs.lib.escapeShellArg surface} \
            ${pkgs.lib.escapeShellArg (toString root)}
        '';

        nodeGypRuntimeProbe = pkgs.writeText "cq-node-gyp-runtime-probe.ts" ''
          import { join } from "node:path";
          import { pathToFileURL } from "node:url";

          const ledgerRoot = process.argv[2];
          if (ledgerRoot === undefined || ledgerRoot.trim() === "") {
            throw new Error("missing-ledger-root");
          }
          const modulePath = join(ledgerRoot, "src", "managedWorktree.ts");
          const module = await import(pathToFileURL(modulePath).href);
          const binDir = module.resolveNodeGypBinDir(modulePath);
          if (binDir === null) throw new Error("missing-node-gyp-provider");
          const executable = join(binDir, "node-gyp");
          if (!(await Bun.file(executable).exists())) {
            throw new Error(`missing-node-gyp-executable: ''${executable}`);
          }
          const result = Bun.spawnSync([executable, "--version"], {
            cwd: ledgerRoot,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `node-gyp-execution-failed: exit=''${result.exitCode} stderr=''${result.stderr.toString().trim()}`,
            );
          }
          console.log(JSON.stringify({
            executable,
            version: result.stdout.toString().trim(),
          }));
        '';

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
              ./nix/pkg/cq-ledgers/packages/process-control/package.json
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

            # D240: Bun nondeterministically materializes dependency-local
            # node_modules/.bin directories. These package-script PATH entries
            # are unused because this --ignore-scripts FOD executes no package
            # scripts; preserve the root and workspace-package executable sets.
            top_level_bins() {
              for bin_dir in node_modules/.bin packages/*/node_modules/.bin; do
                if [ -d "$bin_dir" ]; then
                  find "$bin_dir" -mindepth 1 -maxdepth 1 -print
                fi
              done | sort
            }
            top_level_bins_before="$(top_level_bins)"
            for modules_dir in node_modules packages/*/node_modules; do
              if [ -d "$modules_dir" ]; then
                find "$modules_dir" -mindepth 2 -type d -name .bin \
                  -prune -exec rm -rf {} +
              fi
            done
            if [ "$(top_level_bins)" != "$top_level_bins_before" ]; then
              echo "nested .bin normalization changed a top-level executable set" >&2
              exit 1
            fi
            nested_bins="$({
              for modules_dir in node_modules packages/*/node_modules; do
                if [ -d "$modules_dir" ]; then
                  find "$modules_dir" -mindepth 2 -type d -name .bin -print
                fi
              done
            } | sort)"
            if [ -n "$nested_bins" ]; then
              echo "nested node_modules/.bin directory survived normalization" >&2
              printf '%s\n' "$nested_bins" >&2
              exit 1
            fi

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out

            # @cq/process-control has no external runtime dependencies; its
            # workspace link is staged from source by cqCli below. Excluding
            # that source-relative link keeps this dependency-only FOD's
            # output byte-identical across source-only workspace additions.
            rm -f \
              packages/cq-cli/node_modules/@cq/process-control \
              packages/cq-config/node_modules/@cq/process-control
            rmdir packages/cq-config/node_modules/@cq 2>/dev/null || true

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
            "x86_64-linux" = "sha256-bWl1yOIVweIhg84FVJGx+q/B9ZO4wEdGxAoZBCdSD74=";
            "aarch64-darwin" = "sha256-o6DHi9UeCgeseZFloOcjZpBKLL9LEEvNOIajCQHqWuE=";
          }.${system} or (throw "ledger-node-modules: no FOD hash pinned for ${system}");
        };

        # The Pi extensions remain three standalone Bun projects outside the
        # cq-ledgers workspace. Fetch only their manifests and lockfiles in the
        # fixed-output derivation so source-only edits do not invalidate the
        # dependency closure.
        piExtensionsNodeModules = pkgs.stdenv.mkDerivation {
          pname = "pi-extensions-node-modules";
          version = "0.0.1";

          src = pkgs.lib.fileset.toSource {
            root = ./nix/pkg/pi-extensions;
            fileset = pkgs.lib.fileset.unions [
              ./nix/pkg/pi-extensions/package.json
              ./nix/pkg/pi-extensions/bun.lock
              ./nix/pkg/pi-extensions/auto-driver/package.json
              ./nix/pkg/pi-extensions/auto-driver/bun.lock
              ./nix/pkg/pi-extensions/ledger-status/package.json
              ./nix/pkg/pi-extensions/ledger-status/bun.lock
            ];
          };

          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

          dontConfigure = true;
          dontFixup = true;

          buildPhase = ''
            runHook preBuild

            cacheRoot="$NIX_BUILD_TOP/pi-extensions-cache"
            export XDG_CACHE_HOME="$cacheRoot/xdg"
            export BUN_INSTALL_CACHE_DIR="$cacheRoot/bun-install"
            mkdir -p "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR"

            for project in . auto-driver ledger-status; do
              (
                cd "$project"
                bun install \
                  --frozen-lockfile \
                  --no-progress \
                  --backend=copyfile \
                  --ignore-scripts
              )
            done

            top_level_bins() {
              bin_dir="$1/node_modules/.bin"
              if [ -d "$bin_dir" ]; then
                find "$bin_dir" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort
              fi
            }
            for project in . auto-driver ledger-status; do
              modules_dir="$project/node_modules"
              top_level_bins_before="$(top_level_bins "$project")"
              if [ -d "$modules_dir" ]; then
                find "$modules_dir" -mindepth 2 -type d -name .bin \
                  -prune -exec rm -rf {} +
              fi
              if [ "$(top_level_bins "$project")" != "$top_level_bins_before" ]; then
                echo "nested .bin normalization changed the top-level executable set for $project" >&2
                exit 1
              fi
              nested_bins="$({
                if [ -d "$modules_dir" ]; then
                  find "$modules_dir" -mindepth 2 -type d -name .bin -print
                fi
              } | LC_ALL=C sort)"
              if [ -n "$nested_bins" ]; then
                echo "nested node_modules/.bin directory survived normalization for $project" >&2
                printf '%s\n' "$nested_bins" >&2
                exit 1
              fi
            done

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/auto-driver" "$out/ledger-status"
            cp -r node_modules "$out/node_modules"
            cp -r auto-driver/node_modules "$out/auto-driver/node_modules"
            cp -r ledger-status/node_modules "$out/ledger-status/node_modules"

            runHook postInstall
          '';

          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = {
            "x86_64-linux" = "sha256-ORbui1fC2T8R4/p5Xc2Lc8cbQ0wLbbP3nYS/ppLsTbE=";
            "aarch64-darwin" = "sha256-PqvzZMmeFBj9qn2fAO3ze07hb1mAQ3DnUbsT2B43Doc=";
          }.${system} or (throw "pi-extensions-node-modules: no FOD hash pinned for ${system}");
        };

        # Preserve repository-relative paths because the false-drained
        # regression locates cq-ledgers from the test file. The source closure
        # deliberately excludes every dependency tree.
        piExtensionsTestSource = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./nix/pkg/pi-extensions
            ./nix/pkg/cq-ledgers/package.json
            ./nix/pkg/cq-ledgers/bun.lock
            ./nix/pkg/cq-ledgers/bunfig.toml
            ./nix/pkg/cq-ledgers/tsconfig.base.json
            ./nix/pkg/cq-ledgers/packages/cq-cli
            ./nix/pkg/cq-ledgers/packages/cq-config
            ./nix/pkg/cq-ledgers/packages/process-control
            ./nix/pkg/cq-ledgers/packages/ledger
          ];
        };
        piExtensionsTypecheckSource = pkgs.lib.fileset.toSource {
          root = ./nix/pkg/pi-extensions;
          fileset = pkgs.lib.fileset.unions [
            ./nix/pkg/pi-extensions/auto-driver
            ./nix/pkg/pi-extensions/ledger-status
          ];
        };
        cqShapeTypecheckSource = pkgs.lib.fileset.toSource {
          root = ./nix/pkg/cq-ledgers;
          fileset = pkgs.lib.fileset.unions [
            ./nix/pkg/cq-ledgers/packages/cq-config
            ./nix/pkg/cq-ledgers/packages/process-control
            ./nix/pkg/cq-ledgers/packages/ledger
          ];
        };
        piExtensionsTypecheck = import ./nix/pkg/pi-extensions/typecheck.nix {
          inherit
            pkgs
            bunNodeModules
            piCodingAgent
            piExtensionsNodeModules
            ;
          cqLedgersSource = cqShapeTypecheckSource;
          source = piExtensionsTypecheckSource;
        };

        # Shell fragment: wire @cq/config as a RUNTIME dep of @cq/ledger. Since
        # T357, createLedgerStore() (in @cq/ledger) calls loadConfig() at startup
        # to pick the [ledger] backend, so @cq/config must resolve from inside
        # @cq/ledger AND its own dependencies must be staged. Expects
        # $WORKSPACE/packages/{cq-config,process-control} already staged and
        # $WORKSPACE/packages/ledger/node_modules already created.
        cqConfigForLedger = ''
          mkdir -p "$WORKSPACE/packages/cq-config/node_modules/@cq"
          for dep in ajv smol-toml; do
            if [ -e "${bunNodeModules}/packages/cq-config/node_modules/$dep" ]; then
              ln -s "${bunNodeModules}/packages/cq-config/node_modules/$dep" \
                "$WORKSPACE/packages/cq-config/node_modules/$dep"
            fi
          done
          ln -s "$WORKSPACE/packages/process-control" \
            "$WORKSPACE/packages/cq-config/node_modules/@cq/process-control"
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
                   "$WORKSPACE/packages/ledger/node_modules/@modelcontextprotocol" \
                   "$WORKSPACE/packages/ledger/node_modules/.bin"
          for dep in zod yaml unified remark-frontmatter remark-parse remark-stringify minisearch postgres bun-types; do
            if [ -e "${bunNodeModules}/packages/ledger/node_modules/$dep" ]; then
              ln -s "${bunNodeModules}/packages/ledger/node_modules/$dep" \
                "$WORKSPACE/packages/ledger/node_modules/$dep"
            fi
          done
          ln -s ${bunNodeModules}/packages/ledger/node_modules/node-gyp \
            "$WORKSPACE/packages/ledger/node_modules/node-gyp"
          cat > "$WORKSPACE/packages/ledger/node_modules/.bin/node-gyp" <<'EOF'
#!${pkgs.runtimeShell}
exec ${pkgs.nodejs_22}/bin/node ${bunNodeModules}/packages/ledger/node_modules/node-gyp/bin/node-gyp.js "$@"
EOF
          chmod +x "$WORKSPACE/packages/ledger/node_modules/.bin/node-gyp"
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

        codexPackage = pkgs.callPackage ./nix/pkg/codex/package.nix { };
        substitutedCodexRole = pkgs.writeShellScriptBin "cq-codex-role" "exit 0";

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
            cp -r packages/process-control "$WORKSPACE/packages/process-control"
            cp package.json bun.lock bunfig.toml tsconfig.base.json "$WORKSPACE/"
            rm -rf "$WORKSPACE/packages/cq-cli/node_modules"
            rm -rf "$WORKSPACE/packages/process-control/node_modules"

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
            ln -s "$WORKSPACE/packages/process-control" \
              "$WORKSPACE/packages/cq-cli/node_modules/@cq/process-control"

            ${pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
              mkdir -p $out/libexec
              $CC -Wall -Wextra -Werror \
                packages/process-control/native/darwin-process-identity.c \
                -o $out/libexec/cq-process-identity
            ''}

            # ── 4. Immutable prompt surfaces ────────────────────────────── #
            mkdir -p "$WORKSPACE/prompt-surfaces"
            ln -s ${claudePromptRoot} "$WORKSPACE/prompt-surfaces/claude"
            ln -s ${codexPromptRoot} "$WORKSPACE/prompt-surfaces/codex"
            ln -s ${piPromptRoot} "$WORKSPACE/prompt-surfaces/pi"

            # ── 5. Wrapper ──────────────────────────────────────────────── #
            # LEDGER_WEB_OUTDIR redirects embedded `cq web` Bun.build output to a
            # writable path (the store closure is read-only). Carried over from
            # the standalone ledger-web wrapper.
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/cq \
              --add-flags "run $WORKSPACE/packages/cq-cli/src/main.ts --" \
              --run 'export LEDGER_WEB_OUTDIR="''${LEDGER_WEB_OUTDIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/ledger-web/dist}"' \
              --set-default CQ_PROMPT_SURFACES_ROOT "$WORKSPACE/prompt-surfaces" \
              --set CQ_PROCESS_IDENTITY_HELPER "$out/libexec/cq-process-identity" \
              --prefix PATH : ${pkgs.lib.makeBinPath ([ pkgs.bun pkgs.nodejs_22 pkgs.git ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.procps ])}
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/cq-codex-role \
              --add-flags "run $WORKSPACE/packages/cq-config/scripts/codex-role-dispatch.ts --" \
              --set-default CQ_PROMPT_ROOT "$WORKSPACE/prompt-surfaces/codex" \
              --set-default CQ_CODEX_LEDGER_COMMAND "$out/bin/cq" \
              --set CQ_PROCESS_IDENTITY_HELPER "$out/libexec/cq-process-identity" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.nodejs_22 pkgs.git ]}

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

            fakeCodex=$TMPDIR/fake-codex
            cat > "$fakeCodex" <<'EOF'
#!${pkgs.runtimeShell}
set -eu
test "$1" = exec
cat > "$TMPDIR/cq-codex-role.launch"
printf '%s\n' '{"attestationId":"att_packaged_role_acknowledgement","generation":7,"inputCapability":{"scope":"fetch-input","token":"cq_input_packaged_role_acknowledgement"},"resultCapability":{"scope":"store-result","token":"cq_result_packaged_role_acknowledgement"},"gitChangeCapability":{"scope":"git-change","token":"cq_git_packaged_role_acknowledgement"}}' | \
  cmp -s - "$TMPDIR/cq-codex-role.launch"
printf '%s\n' '{"type":"thread.started","thread_id":"packaged-role-thread"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"ledger","tool":"store_result","result":{"content":[{"type":"text","text":"{\"state\":\"gate-pending\",\"result\":{\"state\":\"gate-pending\",\"attestationId\":\"att_packaged_role_acknowledgement\",\"generation\":7,\"submittedAt\":\"2026-08-13T09:00:00.000Z\",\"outputDigest\":\"digest-bound-output\"}}"}]}}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"state\":\"gate-pending\",\"attestationId\":\"att_packaged_role_acknowledgement\",\"generation\":7,\"outputDigest\":\"digest-bound-output\"}"}}'
printf '%s\n' '{"type":"turn.completed"}'
EOF
            chmod +x "$fakeCodex"

            fakeLedger=$TMPDIR/fake-ledger
            cat > "$fakeLedger" <<EOF
#!${pkgs.runtimeShell}
set -eu
case " \$* " in
  *" --parent-gate-finalize "*)
    IFS= read -r request
    test "\$request" = '{"attestationId":"att_packaged_role_acknowledgement","generation":7,"parentGateCapability":{"scope":"parent-gate","token":"cq_parent_gate_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"}}'
    printf '%s\n' '{"state":"result-stored","attestationId":"att_packaged_role_acknowledgement","generation":7,"storedAt":"2026-08-13T09:01:00.000Z","outputDigest":"digest-bound-output"}'
    ;;
  *) exec "$out/bin/cq" "\$@" ;;
esac
EOF
            chmod +x "$fakeLedger"

            roleCwd=$TMPDIR/role-cwd
            ledgerCwd=$TMPDIR/ledger-cwd
            mkdir -p "$roleCwd" "$ledgerCwd"
            printf '%s\n' '[ledger]' 'backend = "fs"' > "$ledgerCwd/cq.toml"
            ${pkgs.git}/bin/git init -q "$roleCwd"
            roleStdout=$TMPDIR/cq-codex-role.stdout
            if ! printf '%s\n' '{"roleId":"implement-worker","handle":{"attestationId":"att_packaged_role_acknowledgement","generation":7},"inputCapability":{"scope":"fetch-input","token":"cq_input_packaged_role_acknowledgement"},"resultCapability":{"scope":"store-result","token":"cq_result_packaged_role_acknowledgement"},"parentGateCapability":{"scope":"parent-gate","token":"cq_parent_gate_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"},"gitChangeCapability":{"scope":"git-change","token":"cq_git_packaged_role_acknowledgement"},"effectTargetRef":"tasks:T1983","cwd":"'"$roleCwd"'","ledgerCwd":"'"$ledgerCwd"'","model":"test-model","reasoningEffort":"high","sandboxMode":"read-only","timeoutMs":30000}' | \
              HOME=$TMPDIR \
              CQ_CODEX_EXECUTABLE="$fakeCodex" \
              CQ_CODEX_LEDGER_COMMAND="$fakeLedger" \
              $out/bin/cq-codex-role > "$roleStdout"; then
              echo "cq-codex-role packaged acknowledgement check FAILED" >&2
              exit 1
            fi
            if ! printf '%s\n' '{"attestationId":"att_packaged_role_acknowledgement","generation":7}' | \
              cmp -s - "$roleStdout"; then
              echo "cq-codex-role packaged acknowledgement check emitted unexpected stdout:" >&2
              cat "$roleStdout" >&2
              exit 1
            fi

            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              # Behavioral-Active, Effectual-GoodCommunication. Regression D320:
              # exercise the installed wrapper through a real PTY and keep its
              # input open until the role has launched and settled its result.
              rm -f "$TMPDIR/cq-codex-role.launch"
              rolePtyInput=$TMPDIR/cq-codex-role.pty-input
              rolePtyStdout=$TMPDIR/cq-codex-role.pty-stdout
              rolePtyStderr=$TMPDIR/cq-codex-role.pty-stderr
              mkfifo "$rolePtyInput"
              exec 9<>"$rolePtyInput"
              HOME=$TMPDIR \
                CQ_CODEX_EXECUTABLE="$fakeCodex" \
                CQ_CODEX_LEDGER_COMMAND="$fakeLedger" \
                ${pkgs.coreutils}/bin/timeout 10s \
                ${pkgs.util-linux}/bin/script --quiet --return \
                  --command "$out/bin/cq-codex-role" \
                  "$TMPDIR/cq-codex-role.typescript" \
                  < "$rolePtyInput" > "$rolePtyStdout" 2> "$rolePtyStderr" &
              rolePtyPid=$!
              printf '%s\n' '{"roleId":"implement-worker","handle":{"attestationId":"att_packaged_role_acknowledgement","generation":7},"inputCapability":{"scope":"fetch-input","token":"cq_input_packaged_role_acknowledgement"},"resultCapability":{"scope":"store-result","token":"cq_result_packaged_role_acknowledgement"},"parentGateCapability":{"scope":"parent-gate","token":"cq_parent_gate_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"},"gitChangeCapability":{"scope":"git-change","token":"cq_git_packaged_role_acknowledgement"},"effectTargetRef":"tasks:T1983","cwd":"'"$roleCwd"'","ledgerCwd":"'"$ledgerCwd"'","model":"test-model","reasoningEffort":"high","sandboxMode":"read-only","timeoutMs":30000}' >&9
              set +e
              wait "$rolePtyPid"
              rolePtyStatus=$?
              set -e
              exec 9>&-
              exec 9<&-
              if [ "$rolePtyStatus" -ne 0 ]; then
                echo "cq-codex-role did not settle before PTY EOF (exit $rolePtyStatus):" >&2
                cat "$rolePtyStderr" >&2
                exit 1
              fi
              if [ ! -s "$TMPDIR/cq-codex-role.launch" ]; then
                echo "cq-codex-role PTY-open launch did not reach the fake Codex executable" >&2
                exit 1
              fi
              tr -d '\r' < "$rolePtyStdout" > "$TMPDIR/cq-codex-role.pty-normalized"
              if ! grep -Fxq '{"attestationId":"att_packaged_role_acknowledgement","generation":7}' \
                "$TMPDIR/cq-codex-role.pty-normalized"; then
                echo "cq-codex-role PTY-open result did not settle:" >&2
                cat "$rolePtyStdout" >&2
                exit 1
              fi
            ''}

            assertRoleInputRefusal() {
              refusalName=$1
              expectedDiagnostic=$2
              refusalInput=$3
              refusalStdout=$TMPDIR/cq-codex-role-$refusalName.stdout
              refusalStderr=$TMPDIR/cq-codex-role-$refusalName.stderr
              rm -f "$TMPDIR/cq-codex-role.launch"
              set +e
              HOME=$TMPDIR \
                CQ_CODEX_EXECUTABLE="$fakeCodex" \
                $out/bin/cq-codex-role \
                  < "$refusalInput" > "$refusalStdout" 2> "$refusalStderr"
              refusalStatus=$?
              set -e
              if [ "$refusalStatus" -eq 0 ]; then
                echo "cq-codex-role accepted $refusalName input" >&2
                exit 1
              fi
              if ! grep -Fxq "$expectedDiagnostic" "$refusalStderr"; then
                echo "cq-codex-role $refusalName refusal was not deterministic:" >&2
                cat "$refusalStderr" >&2
                exit 1
              fi
              if [ -e "$TMPDIR/cq-codex-role.launch" ]; then
                echo "cq-codex-role used child capabilities for $refusalName input" >&2
                exit 1
              fi
              if grep -Fq 'T2068_CAPABILITY_SENTINEL' "$refusalStdout" "$refusalStderr"; then
                echo "cq-codex-role leaked input capabilities for $refusalName input" >&2
                exit 1
              fi
            }

            incompleteRoleInput=$TMPDIR/cq-codex-role.incomplete
            printf '%s' '{"roleId":"implement-worker","inputCapability":{"scope":"fetch-input","token":"T2068_CAPABILITY_SENTINEL"}}' \
              > "$incompleteRoleInput"
            assertRoleInputRefusal \
              incomplete \
              'codex-role-dispatch: request ended before a newline-terminated JSON value' \
              "$incompleteRoleInput"

            malformedRoleInput=$TMPDIR/cq-codex-role.malformed
            printf '%s\n' '{"roleId":"implement-worker","inputCapability":{"scope":"fetch-input","token":"T2068_CAPABILITY_SENTINEL"}' \
              > "$malformedRoleInput"
            assertRoleInputRefusal \
              malformed \
              'codex-role-dispatch: request must contain one valid JSON object' \
              "$malformedRoleInput"

            oversizedRoleInput=$TMPDIR/cq-codex-role.oversized
            printf '%s' 'T2068_CAPABILITY_SENTINEL' > "$oversizedRoleInput"
            head -c 65537 /dev/zero | tr '\0' x >> "$oversizedRoleInput"
            assertRoleInputRefusal \
              oversized \
              'codex-role-dispatch: request exceeds 65536 bytes before newline' \
              "$oversizedRoleInput"

            gateRepo=$TMPDIR/gate-repo
            gateAlias=$TMPDIR/gate-repo-alias
            gateOutside=$TMPDIR/gate-outside
            mkdir -p "$gateRepo/nested" "$gateOutside"
            ${pkgs.git}/bin/git init -q "$gateRepo"
            ln -s "$gateRepo" "$gateAlias"
            gateRun() {
              ${pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.util-linux}/bin/setsid"} $out/bin/cq gate run "$@"
            }
            gateRun \
              --worktree "$gateRepo" \
              --command-cwd "$gateRepo/nested" \
              -- ${pkgs.runtimeShell} -c 'pwd > "$1"' shell "$TMPDIR/gate-pwd"
            test "$(cat "$TMPDIR/gate-pwd")" = "$gateRepo/nested"
            if gateRun \
              --worktree "$gateRepo" \
              --command-cwd "$gateOutside" \
              -- ${pkgs.runtimeShell} -c 'touch "$1"' shell "$TMPDIR/escaped-ran"; then
              echo "cq gate accepted an escaping command-cwd" >&2
              exit 1
            fi
            test ! -e "$TMPDIR/escaped-ran"

            gateRun \
              --worktree "$gateRepo" \
              --command-cwd "$gateRepo" \
              -- ${pkgs.runtimeShell} -c \
                'touch "$1"; while test ! -e "$2"; do sleep 0.02; done' \
                shell "$TMPDIR/gate-ready" "$TMPDIR/gate-release" &
            firstGate=$!
            attempts=0
            while test ! -e "$TMPDIR/gate-ready"; do
              attempts=$((attempts + 1))
              if test "$attempts" -ge 250; then
                echo "cq gate contention holder did not start" >&2
                exit 1
              fi
              sleep 0.02
            done
            if gateRun \
              --worktree "$gateAlias" \
              --command-cwd "$gateAlias" \
              -- ${pkgs.runtimeShell} -c true; then
              echo "cq gate admitted a canonical-equivalent contender" >&2
              exit 1
            fi
            touch "$TMPDIR/gate-release"
            wait "$firstGate"
            ${pkgs.bun}/bin/bun test \
              "$WORKSPACE/packages/cq-config/test/dispatchTransportRouter.test.ts" \
              --test-name-pattern T2045
            PATH=$out/bin:${pkgs.lib.makeBinPath ([ pkgs.bun pkgs.nodejs_22 pkgs.git ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.procps ])}:$PATH \
              CQ_TEST_CODEX_ROLE_EXECUTABLE=$out/bin/cq-codex-role \
              CQ_TEST_SUBSTITUTED_CODEX_ROLE_EXECUTABLE=${substitutedCodexRole}/bin/cq-codex-role \
              CQ_TEST_CODEX_SANDBOX_EXECUTABLE=${codexPackage}/bin/codex \
              CQ_TEST_GIT_EXECUTABLE=${pkgs.git}/bin/git \
              ${pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.util-linux}/bin/setsid"} \
              ${pkgs.bun}/bin/bun test \
                "$WORKSPACE/packages/cq-config/test/codexGateIntegration.test.ts" \
                "$WORKSPACE/packages/ledger-mcp/test/gitChangeDispatchCapability.test.ts" \
                "$WORKSPACE/packages/ledger-mcp/test/packagedCodexRoleGitBroker.test.ts"
            runHook postInstallCheck
          '';

          dontStrip = true;
          dontFixup = true;
        };
      in
      {
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
          codex = codexPackage;
          pi-coding-agent = piCodingAgent;
          claude-prompt-root = claudePromptRoot;
          codex-prompt-root = codexPromptRoot;
          pi-prompt-root = piPromptRoot;
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
          yolo = self.packages.${system}.yolo-darwin;
        };

        # Deterministic launcher/policy checks run on every build system. A live
        # sandbox-exec probe cannot run inside Nix's own Darwin Seatbelt sandbox
        # (nested sandbox_apply returns EPERM), so runtime confinement is verified
        # outside the Nix builder; see docs/macos-home-manager.md.
        checks =
          {
            global-cq-config-home =
              assert globalCqConfigHomeTest.passed;
              pkgs.runCommand "global-cq-config-home" { } "touch $out";
            cq-node-gyp-runtime = pkgs.runCommand "cq-node-gyp-runtime" {
              nativeBuildInputs = [ pkgs.bun pkgs.nodejs_22 ];
            } ''
              set -eu
              mkdir -p "$out"

              positiveLedger=${cqCli}/share/cq/packages/ledger
              ${pkgs.bun}/bin/bun run ${nodeGypRuntimeProbe} "$positiveLedger" \
                > "$out/positive.json"

              negativeRoot="$TMPDIR/negative-artifact"
              mkdir -p "$negativeRoot/packages"
              cp -a "$positiveLedger" "$negativeRoot/packages/ledger"
              chmod -R u+w "$negativeRoot/packages/ledger"
              rm -f \
                "$negativeRoot/packages/ledger/node_modules/node-gyp" \
                "$negativeRoot/packages/ledger/node_modules/.bin/node-gyp"
              set +e
              ${pkgs.bun}/bin/bun run ${nodeGypRuntimeProbe} \
                "$negativeRoot/packages/ledger" \
                > "$out/negative.log" 2>&1
              negativeCode=$?
              set -e
              if [ "$negativeCode" -eq 0 ] || \
                 ! grep -Fq missing-node-gyp-provider "$out/negative.log"; then
                echo "node-gyp provider omission did not fail closed" >&2
                cat "$out/negative.log" >&2
                exit 1
              fi
            '';

            pi-extensions-tests = pkgs.stdenvNoCC.mkDerivation {
              pname = "pi-extensions-tests";
              version = "0.0.1";
              src = piExtensionsTestSource;

              nativeBuildInputs = [ pkgs.bun pkgs.nodejs_22 ]
                ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.stdenv.cc ];

              dontConfigure = true;
              dontInstall = true;

              buildPhase = ''
                runHook preBuild
                set -eu

                repository="$NIX_BUILD_TOP/repository"
                cp -r "$src" "$repository"
                chmod -R u+w "$repository"
                cacheRoot="$NIX_BUILD_TOP/pi-extensions-test-cache"
                export XDG_CACHE_HOME="$cacheRoot/xdg"
                export BUN_INSTALL_CACHE_DIR="$cacheRoot/bun-install"
                export XDG_STATE_HOME="$NIX_BUILD_TOP/pi-extensions-test-state"
                mkdir -p "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR" "$XDG_STATE_HOME"
                cd "$repository"

                testManifest="$NIX_BUILD_TOP/pi-extensions-tests.manifest"
                find nix/pkg/pi-extensions -type f -name '*.test.ts' -print \
                  | LC_ALL=C sort > "$testManifest"
                if grep -Fq node_modules "$testManifest"; then
                  echo "the source-only Pi extension test manifest contains node_modules" >&2
                  cat "$testManifest" >&2
                  exit 1
                fi
                echo "pi-extensions source-only test manifest:"
                cat "$testManifest"

                piExtensionsRoot="$repository/nix/pkg/pi-extensions"
                cp -r ${piExtensionsNodeModules}/node_modules \
                  "$piExtensionsRoot/node_modules"
                cp -r ${piExtensionsNodeModules}/auto-driver/node_modules \
                  "$piExtensionsRoot/auto-driver/node_modules"
                cp -r ${piExtensionsNodeModules}/ledger-status/node_modules \
                  "$piExtensionsRoot/ledger-status/node_modules"
                chmod -R u+w \
                  "$piExtensionsRoot/node_modules" \
                  "$piExtensionsRoot/auto-driver/node_modules" \
                  "$piExtensionsRoot/ledger-status/node_modules"
                patchShebangs \
                  "$piExtensionsRoot/node_modules" \
                  "$piExtensionsRoot/auto-driver/node_modules" \
                  "$piExtensionsRoot/ledger-status/node_modules"

                cqLedgersRoot="$repository/nix/pkg/cq-ledgers"
                ln -s ${bunNodeModules}/node_modules "$cqLedgersRoot/node_modules"
                for package in cq-cli cq-config ledger; do
                  cp -r "${bunNodeModules}/packages/$package/node_modules" \
                    "$cqLedgersRoot/packages/$package/node_modules"
                done
                mkdir -p "$piExtensionsRoot/node_modules/@cq"
                ln -s "$cqLedgersRoot/packages/process-control" \
                  "$piExtensionsRoot/node_modules/@cq/process-control"
                # The [agent_efforts] equivalence test (D209) in
                # cq-subagent-dispatch.test.ts imports @cq/config (test-time
                # only — the extension itself stays copy-not-import).
                ln -s "$cqLedgersRoot/packages/cq-config" \
                  "$piExtensionsRoot/node_modules/@cq/config"

                ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
                  mkdir -p "$NIX_BUILD_TOP/libexec"
                  $CC -Wall -Wextra -Werror \
                    "$cqLedgersRoot/packages/process-control/native/darwin-process-identity.c" \
                    -o "$NIX_BUILD_TOP/libexec/cq-process-identity"
                  export CQ_PROCESS_IDENTITY_HELPER="$NIX_BUILD_TOP/libexec/cq-process-identity"
                ''}

                for project in \
                  nix/pkg/pi-extensions \
                  nix/pkg/pi-extensions/auto-driver \
                  nix/pkg/pi-extensions/ledger-status; do
                  echo "typecheck: $project"
                  (cd "$project" && ${pkgs.bun}/bin/bun run typecheck)
                  echo "typecheck succeeded: $project"
                done

                set --
                while IFS= read -r testPath; do
                  set -- "$@" "$testPath"
                done < "$testManifest"
                if [ "$#" -ne 10 ]; then
                  echo "expected ten Pi extension test arguments, got $#" >&2
                  exit 1
                fi
                set -x
                ${pkgs.bun}/bin/bun test "$@"
                set +x

                runHook postBuild
                touch "$out"
              '';
            };
            pi-extensions-typecheck = piExtensionsTypecheck;
            yolo-profile =
              pkgs.runCommand "yolo-profile"
                {
                  nativeBuildInputs = [
                    pkgs.shellcheck
                    pkgs.bash
                    pkgs.jq
                    pkgs.git
                    pkgs.python3
                    self.packages.${system}.codegraph
                    # Confinement/lifecycle/hook suites: nested-bubblewrap probe,
                    # mount-namespace fixtures, real tmux for the private server,
                    # and the procps tools the lifecycle suite measures with.
                    pkgs.bubblewrap
                    pkgs.util-linux
                    pkgs.coreutils
                    pkgs.gnugrep
                    pkgs.gawk
                    pkgs.findutils
                    pkgs.ripgrep
                    pkgs.procps
                    pkgs.tmux
                  ];
                }
                ''
                  cp -r ${./nix/pkg/yolo} yolo
                  chmod -R u+w yolo
                  cd yolo
                  shellcheck --severity=warning custom-prompt.sh yolo.sh llm-sandbox.sh profile-test.sh codegraph-bootstrap.sh codegraph-bootstrap-test.sh llm-sandbox-test.sh clipboard-confinement-test.sh clipboard-proxy-test.sh clipboard-proxy-lifecycle-test.sh clipboard-proxy-hook-test.sh
                  bash profile-test.sh
                  bash codegraph-bootstrap-test.sh "$(command -v codegraph)" "$(command -v jq)" "$(command -v git)"
                  bash llm-sandbox-test.sh
                  echo "yolo-profile: profile suites passed"

                  PROXY=${self.packages.${system}.yolo.passthru.clipboardProxy}/bin/yolo-clipboard-proxy
                  bash clipboard-proxy-test.sh "$PROXY"
                  echo "yolo-profile: framing suite passed"
                  bash clipboard-proxy-lifecycle-test.sh "$PROXY"
                  echo "yolo-profile: lifecycle suite passed"
                  # Only the hook suite may start a server: its test-owned,
                  # isolated, no-session tmux server (exit-empty off).
                  bash clipboard-proxy-hook-test.sh "$PROXY" "${pkgs.tmux}/bin/tmux"
                  echo "yolo-profile: hook suite passed"

                  # Corrected capability probe: execute the bound Nix-store
                  # coreutils (a bare /bin/true does not exist in the build
                  # sandbox and would prove nothing). Only when user and mount
                  # namespaces work does the confinement matrix run.
                  if bwrap --unshare-all --share-net --ro-bind /nix/store /nix/store -- "${pkgs.coreutils}/bin/true"; then
                    bash clipboard-confinement-test.sh "$PROXY"
                    echo "yolo-profile: confinement suite passed"
                  else
                    echo "yolo-profile: nested-bubblewrap unavailable (userns/mount-ns probe failed); skipping confinement suite"
                  fi
                  touch $out
                '';
            yolo-darwin-profile =
              pkgs.runCommand "yolo-darwin-profile"
                {
                  nativeBuildInputs = [ pkgs.shellcheck pkgs.bash pkgs.jq pkgs.python3 ];
                }
                ''
                  cp -r ${./nix/pkg/yolo} yolo
                  cp -r ${./nix/pkg/yolo-darwin} yolo-darwin
                  chmod -R u+w yolo-darwin
                  cd yolo-darwin
                  shellcheck ../yolo/custom-prompt.sh yolo-darwin.sh profile-test.sh
                  grep -Fq '"/.config/mcp"' ${inputs.claude-code-sandbox}/noread.sb
                  grep -Fq '"/.config/direnv"' ${inputs.claude-code-sandbox}/noread.sb
                  grep -Fq '"/.local/share/direnv"' ${inputs.claude-code-sandbox}/noread.sb
                  grep -Fq '"/.direnvrc"' ${inputs.claude-code-sandbox}/noread.sb
                  bash profile-test.sh
                  touch $out
                '';
            # T865(a): the FOCUSED evaluation of exactly one fact — the packaged
            # Codex wrapper exports CQ_HARNESS=codex, the selector the ledger
            # MCP server consumes (proven at the other boundary by
            # packages/ledger-mcp/test/codexHarnessSelection.test.ts).
            #
            # It does NOT duplicate T863's two guards; it closes what neither
            # covers. T863's eval-time guard is the home-manager assertion in
            # nix/hm/codex.nix, which codex-cq-skills below reaches only through
            # `lib.all (entry: entry.assertion)` over twenty-odd assertions
            # (discarding their messages); it also matched `lib.hasInfix
            # "CQ_HARNESS codex"`, which ACCEPTS `--set CQ_HARNESS codex-foo`
            # (measured) — that assertion now shares the anchored predicate used
            # here. T863's other guard, the anchored `rg -q "CQ_HARNESS='codex'"`
            # in codex-cq-skills, does catch a changed value, but only by
            # BUILDING the wrapper over the codex static binary, which is not an
            # evaluation. This check is build-free
            # (`nix eval .#checks.<system>.codex-harness-env.drvPath` suffices),
            # names the failing fact, and mutation-checks its own predicate via
            # `selfTest`.
            codex-harness-env =
              assert codexHarnessEnv.selfTest;
              assert pkgs.lib.assertMsg
                (codexHarnessEnv.exportsCodexHarness codexCommandSkillsTest.package.buildCommand)
                "the packaged Codex wrapper does not export exactly CQ_HARNESS=codex";
              pkgs.runCommand "codex-harness-env" { } "touch $out";
            codex-mcp-harness-selection =
              let
                registration = codexLedgerMcpRegistration {
                  command = "${cqCli}/bin/cq";
                  args = [ "mcp" ];
                };
                registrationJson = pkgs.writeText
                  "codex-ledger-mcp-registration.json"
                  (builtins.toJSON registration);
                registrationEnvArgs = pkgs.lib.mapAttrsToList
                  (name: value: "${name}=${value}")
                  (registration.env or { });
              in
              pkgs.runCommand "codex-mcp-harness-selection"
                {
                  nativeBuildInputs = [ pkgs.jq pkgs.coreutils ];
                }
                ''
                  set -eu
                  root="$NIX_BUILD_TOP/project"
                  state="$NIX_BUILD_TOP/state"
                  mkdir -p "$root" "$state"
                  cp ${./nix/pkg/cq-ledgers/packages/ledger-mcp/test/fixtures/t865/codex-selection.cq.toml} \
                    "$root/cq.toml"
                  chmod u+w "$root/cq.toml"
                  cat >> "$root/cq.toml" <<'EOF'

                  [ledger]
                  backend = "xdg"
                  projectId = "codex-mcp-harness-selection"
                  EOF

                  {
                    printf '%s\n' \
                      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"codex-mcp-harness-selection","version":"1"}}}' \
                      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_config","arguments":{"section":"planners"}}}' \
                      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"prepare_dispatch","arguments":{"roleId":"implement-worker","input":{"taskId":"T1627","headline":"Bind Codex preparation to the exact Codex prompt artifact","description":"Verify the materialized registration provenance.","acceptance":"Persist the exact Codex prompt digest.","worktreePath":"/tmp/wt-T1627","branch":"implement/T1627","baseCommit":"1c0405a6a3c287eab42502520ed5f2807d6d3f7b"},"idempotencyKey":"T1627-nix-codex-provenance","timeoutMs":600000,"expectedChild":{"childId":"nix-check-child","runId":"nix-check-run"}}}}'
                  } | env -i \
                    HOME="$NIX_BUILD_TOP/home" \
                    XDG_STATE_HOME="$state" \
                    ${pkgs.lib.escapeShellArgs registrationEnvArgs} \
                    ${registration.command} ${pkgs.lib.escapeShellArgs registration.args} --cwd "$root" \
                    > responses.jsonl

                  planner_payload="$(
                    ${pkgs.jq}/bin/jq -r '
                      select(.id == 2)
                      | .result.content[0].text
                    ' responses.jsonl
                  )"
                  prepared_payload="$(
                    ${pkgs.jq}/bin/jq -r '
                      select(.id == 3)
                      | .result.content[0].text
                    ' responses.jsonl
                  )"
                  expected_prompt_digest="$(${pkgs.coreutils}/bin/sha256sum \
                    ${codexPromptRoot}/roles/implement-worker.md | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
                  ${pkgs.jq}/bin/jq -e '
                    .command == ${builtins.toJSON registration.command}
                    and .args == [
                      "mcp",
                      "--prompt-surface",
                      "codex",
                      "--prompt-root",
                      ${builtins.toJSON (toString codexPromptRoot)}
                    ]
                    and .env == {
                      "CQ_HARNESS":"codex",
                      "CQ_PROMPT_ROOT":${builtins.toJSON (toString codexPromptRoot)},
                      "CQ_PROMPT_SURFACE":"codex"
                    }
                  ' ${registrationJson} >/dev/null || {
                    echo "materialized registration omitted exact Codex prompt selectors/environment" >&2
                    printf '%s\n' "$planner_payload" >&2
                    exit 1
                  }
                  printf '%s\n' "$planner_payload" | tee /dev/stderr | ${pkgs.jq}/bin/jq -e '
                    .configured == true
                    and ([.planners[].alias] == ["codex"])
                    and ([.planners[] | select(.alias == "opus" or .harness == "claude")] | length == 0)
                  ' >/dev/null
                  printf '%s\n' "$prepared_payload" | tee /dev/stderr | ${pkgs.jq}/bin/jq -e \
                    --arg expectedPromptDigest "$expected_prompt_digest" '
                      .accepted == true
                      and .prepared.promptProvenance.surface == "codex"
                      and .prepared.promptProvenance.promptDigest == $expectedPromptDigest
                    ' >/dev/null
                  touch "$out"
                '';
            codex-cq-skills =
              assert codexCommandSkillsTest.passed;
              pkgs.runCommand "codex-cq-skills" { } ''
                set -eu
                # D150: anchor to the exact makeWrapper export form so CQ_PROMPT_SURFACE='codexx'
                # cannot satisfy the check (the prior CQ_PROMPT_SURFACE.*codex infix did).
                ${pkgs.ripgrep}/bin/rg -q "CQ_PROMPT_SURFACE='codex'" ${codexCommandSkillsTest.package}/bin/codex
                ${pkgs.ripgrep}/bin/rg -q "CQ_HARNESS='codex'" ${codexCommandSkillsTest.package}/bin/codex
                ${pkgs.ripgrep}/bin/rg -q ${pkgs.lib.escapeShellArg (toString codexPromptRoot)} ${codexCommandSkillsTest.package}/bin/codex
                # D150 negative probe: the anchored pattern must reject the codexx impostor.
                printf '%s\n' "export CQ_PROMPT_SURFACE='codexx'" > d150-codexx-probe.sh
                if ${pkgs.ripgrep}/bin/rg -q "CQ_PROMPT_SURFACE='codex'" d150-codexx-probe.sh; then
                  echo "D150: anchored CQ_PROMPT_SURFACE='codex' incorrectly matched codexx" >&2
                  exit 1
                fi
                mkdir -p "$out"
                ${pkgs.lib.concatMapStringsSep "\n"
                  (name: ''
                    mkdir -p "$out/${name}"
                    cp ${builtins.toFile "${name}-SKILL.md" codexCqSkillSpecs.${name}.skillMd} \
                      "$out/${name}/SKILL.md"
                    mkdir -p "$out/${name}/references"
                    ${pkgs.lib.concatMapStringsSep "\n"
                      (referenceName: ''
                        cp ${codexCqSkillSpecs.${name}.references.${referenceName}} \
                          "$out/${name}/references/${referenceName}"
                      '')
                      (builtins.attrNames codexCqSkillSpecs.${name}.references)}
                  '')
                  (builtins.attrNames codexCqSkillSpecs)}
                test "$(
                  find "$out" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l
                )" -eq "${toString (builtins.length (builtins.attrNames codexCqSkillSpecs))}"
                test "$(find ${codexPromptRoot}/roles -type f -name '*.md' | wc -l)" -eq 25
                ${verifySurfaceAttestation "codex" codexPromptRoot}
                # D151: single-backslash Rust-regex escapes; rg exit 2 is a hard error
                # (a missing path used to slip through the `if rg; then fail; fi` form).
                # Forbidden vocabulary pattern shared by roles + generated skills.
                codex_forbid_pat='Agent\(|Task\(|dispatch_agent\(|/cq:|\{\{cq:fragment:'
                set +e
                ${pkgs.ripgrep}/bin/rg -n "$codex_forbid_pat" ${codexPromptRoot}/roles
                rc=$?
                set -e
                if [ "$rc" -eq 0 ]; then
                  echo "Codex prompt roles contain foreign or unresolved vocabulary" >&2
                  exit 1
                elif [ "$rc" -ge 2 ]; then
                  echo "rg failed (exit $rc) scanning Codex prompt roles" >&2
                  exit 1
                fi
                cmp ${builtins.toFile "cq-expected-codex-catalog.json" llmAssets.catalogJson} \
                  ${codexProjection.catalog}
                set +e
                ${pkgs.ripgrep}/bin/rg -n "$codex_forbid_pat" "$out"
                rc=$?
                set -e
                if [ "$rc" -eq 0 ]; then
                  echo "generated Codex skills contain foreign or unresolved vocabulary" >&2
                  exit 1
                elif [ "$rc" -ge 2 ]; then
                  echo "rg failed (exit $rc) scanning generated Codex skills" >&2
                  exit 1
                fi
                # D151 negative probe: the forbid pattern must match a real forbidden token.
                printf '%s\n' 'Agent(foreign)' > d151-forbid-probe.md
                set +e
                ${pkgs.ripgrep}/bin/rg -n "$codex_forbid_pat" d151-forbid-probe.md
                rc=$?
                set -e
                if [ "$rc" -ne 0 ]; then
                  echo "D151: forbid pattern failed to match Agent( on the negative probe (exit $rc)" >&2
                  exit 1
                fi

                # defects:D178 half (b): every dispatched role is materialised as a
                # GLOBAL native-agent declaration, and the rendered TOML is parsed
                # as BYTES — evaluation only proves the derivation exists, not that
                # the writer's quoting produced a parseable document with the role
                # body intact. Verified in a build-directory scratch dir, never
                # next to $out.
                agentsDir="$NIX_BUILD_TOP/codex-agents"
                mkdir -p "$agentsDir"
                ${pkgs.lib.concatMapStringsSep "\n"
                  (name: ''
                    cp ${codexCommandSkillsTest.agentFiles.${name}} "$agentsDir/${name}.toml"
                    ${pkgs.python3}/bin/python3 ${verifyCodexAgentDeclaration} \
                      ${name} "$agentsDir/${name}.toml" ${codexPromptRoot}/roles/${name}.md
                  '')
                  codexCommandSkillsTest.agentNames}
                test "$(find "$agentsDir" -maxdepth 1 -name '*.toml' | wc -l)" \
                  -eq "${toString (builtins.length codexCommandSkillsTest.agentNames)}"
                # The declared roster is the dispatched-role roster, not a subset.
                test "${toString (builtins.length codexCommandSkillsTest.agentNames)}" -eq 9
                # Half (a) again, on the RENDERED bytes rather than the nix source:
                # no dispatched role body may reach a skill package.
                if find "$out" -name 'role-*.md' | ${pkgs.gnugrep}/bin/grep -q .; then
                  echo "a dispatched role body was shipped into a Codex skill" >&2
                  exit 1
                fi
              '';
            prompt-surfaces =
              assert promptSurfacesTest;
              pkgs.runCommand "prompt-surfaces" { } "touch $out";
            prompt-catalog =
              assert promptCatalogTest;
              pkgs.runCommand "prompt-catalog" { } "touch $out";
            claude-prompt-root = pkgs.runCommand "claude-prompt-root-check" { } ''
              test "$(find ${claudePromptRoot}/roles -type f -name '*.md' | wc -l)" -eq 25
              test -f ${claudePromptRoot}/roles/begin.md
              cmp ${builtins.toFile "cq-expected-prompt-catalog.json" llmAssets.catalogJson} \
                ${claudePromptRoot}/catalog.json
              ${verifySurfaceAttestation "claude" claudePromptRoot}
              set +e
              ${pkgs.ripgrep}/bin/rg -n '\{\{cq:fragment:|CQ_HARNESS' ${claudePromptRoot}
              rc=$?
              set -e
              if [ "$rc" -eq 0 ]; then
                echo "packaged Claude prompt root contains an unresolved renderer token" >&2
                exit 1
              elif [ "$rc" -ge 2 ]; then
                echo "rg failed (exit $rc) scanning Claude prompt root" >&2
                exit 1
              fi
              touch "$out"
            '';
            pi-prompt-root = pkgs.runCommand "pi-prompt-root-check" { } ''
              : ${if piPromptRootTest.passed then "pi-home-manager-projection-ok" else "pi-home-manager-projection-failed"}
              # D150: exact makeWrapper export; pinocchio must not match.
              ${pkgs.ripgrep}/bin/rg -q "CQ_PROMPT_SURFACE='pi'" ${piPromptRootTest.package}/bin/pi
              ${pkgs.ripgrep}/bin/rg -q ${pkgs.lib.escapeShellArg (toString piPromptRoot)} ${piPromptRootTest.package}/bin/pi
              printf '%s\n' "export CQ_PROMPT_SURFACE='pinocchio'" > d150-pinocchio-probe.sh
              if ${pkgs.ripgrep}/bin/rg -q "CQ_PROMPT_SURFACE='pi'" d150-pinocchio-probe.sh; then
                echo "D150: anchored CQ_PROMPT_SURFACE='pi' incorrectly matched pinocchio" >&2
                exit 1
              fi
              test "$(find ${piPromptRoot}/roles -type f -name '*.md' | wc -l)" -eq 25
              test -f ${piPromptRoot}/roles/begin.md
              cmp ${builtins.toFile "cq-expected-prompt-catalog.json" llmAssets.catalogJson} \
                ${piPromptRoot}/catalog.json
              ${verifySurfaceAttestation "pi" piPromptRoot}
              test -f ${piPromptRootTest.dispatchExtension}
              test -f ${piPromptRootTest.dispatchExtensionDir}/cq-subagent-native-session.ts
              test -e ${piPromptRootTest.dispatchExtensionDir}/node_modules/@cq/process-control/src/index.ts
              ${pkgs.bun}/bin/bun -e \
                'await import(${builtins.toJSON "${piPromptRootTest.dispatchExtensionDir}/cq-subagent-native-session.ts"})'
              ${pkgs.bun}/bin/bun -e \
                'await import(${builtins.toJSON "${piPromptRootTest.dispatchExtensionDir}/cq-subagent-process-lifecycle.ts"})'
              ${pkgs.ripgrep}/bin/rg -q 'from "@cq/process-control"' \
                ${piPromptRootTest.dispatchExtensionDir}/cq-subagent-process-lifecycle.ts
              # D180: the wrapper must DEFAULT CQ_AGENTS_DIR, not clobber it —
              # a pre-set CQ_AGENTS_DIR survives; unset/empty falls back to
              # ''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cq-agents. Extract the
              # wrapper's real export line and evaluate it under both envs.
              ${pkgs.gnugrep}/bin/grep -m1 -o 'export CQ_AGENTS_DIR=.*' \
                ${piPromptRootTest.package}/bin/pi > cq-agents-dir-export.sh
              test -s cq-agents-dir-export.sh
              test "$(env -u CQ_AGENTS_DIR PI_CODING_AGENT_DIR=/preset/pi HOME=/home/test \
                ${pkgs.bash}/bin/bash -c '. ./cq-agents-dir-export.sh; printf %s "$CQ_AGENTS_DIR"')" \
                = "/preset/pi/cq-agents"
              test "$(CQ_AGENTS_DIR=/custom/agents PI_CODING_AGENT_DIR=/preset/pi \
                ${pkgs.bash}/bin/bash -c '. ./cq-agents-dir-export.sh; printf %s "$CQ_AGENTS_DIR"')" \
                = "/custom/agents"
              ${pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
                test -x ${piPromptRootTest.dispatchExtensionDir}/libexec/cq-process-identity
                ${pkgs.ripgrep}/bin/rg -Fq \
                  ${pkgs.lib.escapeShellArg "${piPromptRootTest.dispatchExtensionDir}/libexec/cq-process-identity"} \
                  ${piPromptRootTest.package}/bin/pi
              ''}
              ${pkgs.jq}/bin/jq -e '
                .mcpServers.ledger.lifecycle == "keep-alive"
                and .mcpServers.ledger.directTools == true
                and .mcpServers.ledger.type == "stdio"
                and (.mcpServers.ledger | has("url") | not)
                and (.mcpServers.ledger | has("enabled") | not)
                and (.mcpServers.ledger | has("env") | not)
                and (.mcpServers.ledger | has("headers") | not)
                and ([.mcpServers.ledger[] | select(. == null)] | length == 0)
              ' ${piPromptRootTest.mcpJson} >/dev/null
              set +e
              ${pkgs.ripgrep}/bin/rg -n '\{\{cq:fragment:|CQ_HARNESS|\$cq-|mcp__ledger__|Agent\(' ${piPromptRoot}/roles
              rc=$?
              set -e
              if [ "$rc" -eq 0 ]; then
                echo "packaged Pi prompt root contains a foreign or unresolved renderer token" >&2
                exit 1
              elif [ "$rc" -ge 2 ]; then
                echo "rg failed (exit $rc) scanning Pi prompt roles" >&2
                exit 1
              fi
              touch "$out"
            '';
            claude-prompt-home = claudePromptHomeTest;
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            # T1587: the real-adapter leg for T586. Local Bun runs keep their
            # explicit PostgreSQL skip; this check provisions the dependency
            # and makes that skip a failure.
            cq-ledger-parent-liveness-postgres = pkgs.stdenv.mkDerivation {
              pname = "cq-ledger-parent-liveness-postgres-check";
              version = "0.0.1";

              src = ./nix/pkg/cq-ledgers;

              nativeBuildInputs = [ pkgs.bun ];
              nativeCheckInputs = [
                pkgs.git
                pkgs.postgresql
                pkgs.postgresqlTestHook
                pkgs.python3
              ];

              dontConfigure = true;
              dontBuild = true;
              doCheck = true;
              postgresqlEnableTCP = 1;

              postPatch = ''
                ln -s ${bunNodeModules}/node_modules node_modules
                for package in cq-config ledger ledger-live ledger-mcp ledger-web; do
                  cp -r "${bunNodeModules}/packages/$package/node_modules" \
                    "packages/$package/node_modules"
                done
              '';

              # runHook invokes this string before postgresqlTestHook's
              # postgresqlStart pre-check hook.
              preCheck = ''
                export HOME="$NIX_BUILD_TOP/home"
                mkdir -p "$HOME"

                negativeLog="$NIX_BUILD_TOP/t1855-required-live-negative.log"
                set +e
                env -u CQ_TEST_PG_URL CQ_TEST_REQUIRE_PG=1 \
                  ${pkgs.bun}/bin/bun test packages/ledger/test/plan-lifecycle-store-conformance.test.ts \
                    --test-name-pattern 'PostgresLedgerStore' \
                    > "$negativeLog" 2>&1
                negativeCode=$?
                set -e
                if [ "$negativeCode" -eq 0 ]; then
                  echo "T1855 required-live preflight passed without CQ_TEST_PG_URL" >&2
                  cat "$negativeLog" >&2
                  exit 1
                fi
                if ! grep -Fq \
                  'CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN' \
                  "$negativeLog"; then
                  echo "T1855 required-live preflight failed for an unexpected reason" >&2
                  cat "$negativeLog" >&2
                  exit 1
                fi

                PGPORT="$(${pkgs.python3}/bin/python3 - <<'PY'
import socket

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
                )"
                export PGPORT
                postgresqlExtraSettings="
                listen_addresses = '127.0.0.1'
                port = $PGPORT
                "
                export postgresqlExtraSettings
              '';

              checkPhase = ''
                runHook preCheck

                ${pkgs.postgresql}/bin/pg_isready \
                  --host 127.0.0.1 \
                  --port "$PGPORT" \
                  --username "$PGUSER" \
                  --dbname "$PGDATABASE"
                export CQ_TEST_PG_URL="postgresql://$PGUSER@127.0.0.1:$PGPORT/$PGDATABASE?sslmode=disable"
                export CQ_TEST_REQUIRE_PG=1

                positiveLog="$NIX_BUILD_TOP/t1855-live.log"
                if ! ${pkgs.bun}/bin/bun test packages/ledger/test/plan-lifecycle-store-conformance.test.ts \
                  --test-name-pattern 'PostgresLedgerStore' \
                  > "$positiveLog" 2>&1; then
                  cat "$positiveLog" >&2
                  exit 1
                fi
                cat "$positiveLog"
                if ! grep -Fq \
                  '(pass) PlanLifecycleStore contract — PostgresLedgerStore (two connections)' \
                  "$positiveLog"; then
                  echo "T1855 live selector executed no named PostgreSQL conformance leg" >&2
                  exit 1
                fi
                if grep -Fq '(skip)' "$positiveLog"; then
                  echo "T1855 live selector skipped a PostgreSQL conformance leg" >&2
                  exit 1
                fi
                if ! grep -Fq \
                  'rejects claim and publish on an absent or terminal coordination milestone before any allocation' \
                  "$positiveLog"; then
                  echo "T1855 live selector did not execute the parent-liveness leg" >&2
                  exit 1
                fi

                attestationLog="$NIX_BUILD_TOP/t2144-parent-gate-attestation.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/cq-config/test/attestationStore-postgres.test.ts \
                  > "$attestationLog" 2>&1; then
                  cat "$attestationLog" >&2
                  exit 1
                fi
                cat "$attestationLog"
                if grep -Fq '(skip)' "$attestationLog" || ! grep -F '(pass)' "$attestationLog" | grep -Fq \
                  'parent-owned gate staging, reclaim, stale-epoch refusal, and exact replay survive restarts'; then
                  echo "T2144 live PostgreSQL parent-gate attestation leg did not execute" >&2
                  exit 1
                fi

                storeLog="$NIX_BUILD_TOP/t1858-store.log"
                if ! ${pkgs.bun}/bin/bun test packages/ledger/test/store-postgres.test.ts \
                  --test-name-pattern 'PostgresLedgerStore' \
                  > "$storeLog" 2>&1; then
                  cat "$storeLog" >&2
                  exit 1
                fi
                cat "$storeLog"
                if grep -Fq '(skip)' "$storeLog"; then
                  echo "T1858 store-postgres run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'close-versus-create serializes to exactly one winner via either API' \
                  'close-versus-reopen refuses resurrection under a closed parent in both winner orderings' \
                  'direct and canonical closure report identical sorted blockers' \
                  'archive-versus-create/reopen/legacy-nonterminal-unarchive serializes in both winner orderings'; do
                  if ! grep -F "(pass)" "$storeLog" | grep -Fq "$expectedLeg"; then
                    echo "T1858 store-postgres run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                migrationLog="$NIX_BUILD_TOP/t1960-migration.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-root-migration.test.ts \
                  packages/ledger/test/workset-postgres-schema-divergence.test.ts \
                  packages/ledger/test/ideas-ambient-migration.test.ts \
                  packages/cq-cli/test/migrate-postgres.test.ts \
                  packages/ledger/test/postgres-tenant-bootstrap.test.ts \
                  > "$migrationLog" 2>&1; then
                  cat "$migrationLog" >&2
                  exit 1
                fi
                cat "$migrationLog"
                if grep -Fq '(skip)' "$migrationLog"; then
                  echo "T1960 PostgreSQL migration/divergence run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'treats a tenant carrying only roots as non-empty' \
                  'relocates durable tenant rows and remains idempotent' \
                  'migrates the xdg primary into postgres' \
                  'preserves roots and epoch in the divergence shadow'; do
                  if ! grep -F "(pass)" "$migrationLog" | grep -Fq "$expectedLeg"; then
                    echo "T1960 PostgreSQL migration run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                ownerLifecycleLog="$NIX_BUILD_TOP/t1976-owner-lifecycle.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-owner-lifecycle.test.ts \
                  packages/cq-cli/test/backup-restore-postgres.test.ts \
                  > "$ownerLifecycleLog" 2>&1; then
                  cat "$ownerLifecycleLog" >&2
                  exit 1
                fi
                cat "$ownerLifecycleLog"
                if grep -Fq '(skip)' "$ownerLifecycleLog"; then
                  echo "T1976 live PostgreSQL owner lifecycle/backup run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'PostgresLedgerStore canonical owner lifecycle [BA]' \
                  'round-trips items + a milestone + logs through backup'; do
                  if ! grep -F '(pass)' "$ownerLifecycleLog" | grep -Fq "$expectedLeg"; then
                    echo "T1976 live PostgreSQL owner lifecycle run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                resetLifecycleLog="$NIX_BUILD_TOP/t1976-reset-lifecycle.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/cq-cli/test/reset-erase-postgres.test.ts \
                  --test-name-pattern 'cq reset / cq erase — postgres tenant scoping' \
                  > "$resetLifecycleLog" 2>&1; then
                  cat "$resetLifecycleLog" >&2
                  exit 1
                fi
                cat "$resetLifecycleLog"
                if grep -Fq '(skip)' "$resetLifecycleLog"; then
                  echo "T1976 live PostgreSQL reset run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'configured backup completes before one-transaction reset and one notify refreshes a live peer' \
                  'reset refreshes after an admitted stale-cache peer write, backs it up, then notifies once' \
                  'a reseed statement failure rolls back wipe, reseed, and empty roots together'; do
                  if ! grep -F '(pass)' "$resetLifecycleLog" | grep -Fq "$expectedLeg"; then
                    echo "T1976 live PostgreSQL reset run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                brokerLog="$NIX_BUILD_TOP/t1979-live-postgres-broker.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-postgres-disconnect.test.ts \
                  --test-name-pattern 'broker disconnect retains the row until its guardian settles descendants' \
                  > "$brokerLog" 2>&1; then
                  cat "$brokerLog" >&2
                  exit 1
                fi
                cat "$brokerLog"
                if ! grep -Fq \
                  '(pass) workset postgres disconnect [T1958] > broker disconnect retains the row until its guardian settles descendants' \
                  "$brokerLog" || grep -Fq '(skip)' "$brokerLog"; then
                  echo "T1979 live PostgreSQL broker-disconnect leg did not execute" >&2
                  exit 1
                fi

                ownedWriteLog="$NIX_BUILD_TOP/t1966-live-owned-write.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-owned-write-postgres.test.ts \
                  packages/ledger/test/workset-coordination-bundle-postgres.test.ts \
                  packages/ledger/test/workset-coordination-bundle-postgres-faults.test.ts \
                  > "$ownedWriteLog" 2>&1; then
                  cat "$ownedWriteLog" >&2
                  exit 1
                fi
                cat "$ownedWriteLog"
                if grep -Fq '(skip)' "$ownedWriteLog"; then
                  echo "T1966 live PostgreSQL owned-write run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'workset owned-write contract [T1962] — PostgresLedgerStore' \
                  'workset coordination-bundle contract [T1962] — PostgresLedgerStore' \
                  'statement failure rolls back the tenant and emits no post-commit hook' \
                  'post-commit NOTIFY invalidates a peer after the complete owned write'; do
                  if ! grep -F '(pass)' "$ownedWriteLog" | grep -Fq "$expectedLeg"; then
                    echo "T1966 live PostgreSQL owned-write run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                planWorksetLog="$NIX_BUILD_TOP/t1971-live-plan-workset.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-plan-lifecycle-postgres.test.ts \
                  packages/ledger/test/workset-plan-lifecycle-postgres-faults.test.ts \
                  > "$planWorksetLog" 2>&1; then
                  cat "$planWorksetLog" >&2
                  exit 1
                fi
                cat "$planWorksetLog"
                if grep -Fq '(skip)' "$planWorksetLog"; then
                  echo "T1971 live PostgreSQL workset plan-lifecycle run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'PostgresLedgerStore workset-guarded plan lifecycle [BA]' \
                  'serializes guarded and raw same-goal writes in both lock orders' \
                  'statement failure rolls back tenant rows and restart retries as new' \
                  'backend disconnect aborts the transaction without a replay row' \
                  'post-commit NOTIFY reveals the complete lifecycle graph to a peer' \
                  'serializes same-tenant replacements while preserving tenant isolation'; do
                  if ! grep -F '(pass)' "$planWorksetLog" | grep -Fq "$expectedLeg"; then
                    echo "T1971 live PostgreSQL workset plan-lifecycle run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                genericMutationLog="$NIX_BUILD_TOP/t1975-live-generic-mutation.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-generic-mutation-postgres.test.ts \
                  packages/ledger/test/workset-generic-mutation-postgres-faults.test.ts \
                  > "$genericMutationLog" 2>&1; then
                  cat "$genericMutationLog" >&2
                  exit 1
                fi
                cat "$genericMutationLog"
                if grep -Fq '(skip)' "$genericMutationLog"; then
                  echo "T1975 live PostgreSQL generic-mutation run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'workset generic-mutation contract [T1961] — postgres-durable' \
                  'allowed status update under restrictive roots persists across restart' \
                  'post-commit NOTIFY publishes generic writes and a rolled-back denial stays silent' \
                  'cross-server: peer setRoots waits for holder generic mutation then observes result'; do
                  if ! grep -F '(pass)' "$genericMutationLog" | grep -Fq "$expectedLeg"; then
                    echo "T1975 live PostgreSQL generic-mutation run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                worksetReplacementLog="$NIX_BUILD_TOP/t1980-live-workset-replacement.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/workset-root-replacement-postgres.test.ts \
                  > "$worksetReplacementLog" 2>&1; then
                  cat "$worksetReplacementLog" >&2
                  exit 1
                fi
                cat "$worksetReplacementLog"
                if grep -Fq '(skip)' "$worksetReplacementLog"; then
                  echo "T1980 live PostgreSQL workset replacement run skipped" >&2
                  exit 1
                fi
                for expectedLeg in \
                  'absorbs a peer-created root into cache and FTS before returning' \
                  'rejects a root archived while replacement waits at the exclusive boundary'; do
                  if ! grep -F '(pass)' "$worksetReplacementLog" | grep -Fq "$expectedLeg"; then
                    echo "T1980 live PostgreSQL workset replacement run did not execute: $expectedLeg" >&2
                    exit 1
                  fi
                done

                coherenceLog="$NIX_BUILD_TOP/t1975-live-coherence.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/postgres-coherence-watcher.test.ts \
                  > "$coherenceLog" 2>&1; then
                  cat "$coherenceLog" >&2
                  exit 1
                fi
                cat "$coherenceLog"
                if grep -Fq '(skip)' "$coherenceLog" || \
                   ! grep -F '(pass)' "$coherenceLog" | grep -Fq \
                     "pushes A's writes to B, isolates other tenants, and reconverges after a LISTEN drop"; then
                  echo "T1975 live PostgreSQL coherence watcher did not execute" >&2
                  exit 1
                fi

                stressLog="$NIX_BUILD_TOP/t1975-live-multi-writer-stress.log"
                if ! ${pkgs.bun}/bin/bun test \
                  packages/ledger/test/multi-writer-stress-postgres.test.ts \
                  > "$stressLog" 2>&1; then
                  cat "$stressLog" >&2
                  exit 1
                fi
                cat "$stressLog"
                if grep -Fq '(skip)' "$stressLog" || \
                   ! grep -F '(pass)' "$stressLog" | grep -Fq \
                     'zero lost updates, zero parse/read failures'; then
                  echo "T1975 live PostgreSQL multi-writer stress did not execute" >&2
                  exit 1
                fi

                runHook postCheck
              '';

              installPhase = ''
                touch "$out"
              '';
            };
            cq-serve-live-boot = pkgs.stdenv.mkDerivation {
              pname = "cq-serve-live-boot-check";
              version = "0.0.1";

              src = ./nix/pkg/cq-ledgers;

              nativeBuildInputs = [ pkgs.bun ];
              nativeCheckInputs = [
                pkgs.postgresql
                pkgs.postgresqlTestHook
                pkgs.python3
              ];

              dontConfigure = true;
              dontBuild = true;
              doCheck = true;
              postgresqlEnableTCP = 1;

              postPatch = ''
                ln -s ${bunNodeModules}/node_modules node_modules
                for package in cq-config ledger ledger-live ledger-mcp ledger-web; do
                  cp -r "${bunNodeModules}/packages/$package/node_modules" \
                    "packages/$package/node_modules"
                done
              '';

              # runHook invokes this string before postgresqlTestHook's
              # postgresqlStart pre-check hook.
              preCheck = ''
                export HOME="$NIX_BUILD_TOP/home"
                mkdir -p "$HOME"

                negativeLog="$NIX_BUILD_TOP/t586-required-live-negative.log"
                set +e
                env -u CQ_TEST_PG_URL CQ_TEST_REQUIRE_PG=1 \
                  ${pkgs.bun}/bin/bun test packages/ledger-web/test/hubServe.test.ts \
                    --test-name-pattern 'cq serve — live boot \(T586\)' \
                    > "$negativeLog" 2>&1
                negativeCode=$?
                set -e
                if [ "$negativeCode" -eq 0 ]; then
                  echo "T586 required-live preflight passed without CQ_TEST_PG_URL" >&2
                  cat "$negativeLog" >&2
                  exit 1
                fi
                if ! grep -Fq \
                  'CQ_TEST_REQUIRE_PG=1 requires CQ_TEST_PG_URL to contain a PostgreSQL DSN' \
                  "$negativeLog"; then
                  echo "T586 required-live preflight failed for an unexpected reason" >&2
                  cat "$negativeLog" >&2
                  exit 1
                fi

                PGPORT="$(${pkgs.python3}/bin/python3 - <<'PY'
import socket

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
                )"
                export PGPORT
                postgresqlExtraSettings="
                listen_addresses = '127.0.0.1'
                port = $PGPORT
                "
                export postgresqlExtraSettings
              '';

              checkPhase = ''
                runHook preCheck

                ${pkgs.postgresql}/bin/pg_isready \
                  --host 127.0.0.1 \
                  --port "$PGPORT" \
                  --username "$PGUSER" \
                  --dbname "$PGDATABASE"
                export CQ_TEST_PG_URL="postgresql://$PGUSER@127.0.0.1:$PGPORT/$PGDATABASE?sslmode=disable"
                export CQ_TEST_REQUIRE_PG=1

                positiveLog="$NIX_BUILD_TOP/t586-live.log"
                if ! ${pkgs.bun}/bin/bun test packages/ledger-web/test/hubServe.test.ts \
                  --test-name-pattern 'cq serve — live boot \(T586\)' \
                  > "$positiveLog" 2>&1; then
                  cat "$positiveLog" >&2
                  exit 1
                fi
                cat "$positiveLog"
                expectedPass='(pass) cq serve — live boot (T586) > boots with --pg-url --port 0, no repo cwd; serves the bundle + the projects listing'
                if ! grep -Fq "$expectedPass" "$positiveLog"; then
                  echo "T586 live selector did not execute its acceptance test" >&2
                  exit 1
                fi
                if [ "$(grep -cF '(pass)' "$positiveLog")" -ne 1 ] || \
                   grep -Fq '(skip)' "$positiveLog"; then
                  echo "T586 live selector executed an unexpected test set or skipped" >&2
                  exit 1
                fi

                # T1725: separate lifecycle log for G147 dangling/active/archived
                # PostgresLedgerStore cases (distinct from the ordinary Bun skip).
                lifecycleLog="$NIX_BUILD_TOP/t1725-lifecycle.log"
                if ! ${pkgs.bun}/bin/bun test packages/ledger/test/plan-lifecycle-store-conformance.test.ts \
                  --test-name-pattern 'PostgresLedgerStore.*(rejects draft-key|rejects dangling known-ledger|accepts active and archived)' \
                  > "$lifecycleLog" 2>&1; then
                  cat "$lifecycleLog" >&2
                  exit 1
                fi
                cat "$lifecycleLog"
                for expectedLeg in \
                  'rejects draft-key ledger refs and dangling leftovers without state leakage (T1724/D204)' \
                  'rejects dangling known-ledger refs on milestone/task × dependsOn/blockedBy without leakage (T1724)' \
                  'accepts active and archived materialized dependencies'; do
                  if ! grep -F "(pass)" "$lifecycleLog" | grep -Fq "$expectedLeg"; then
                    echo "T1725 lifecycle log missing pass: $expectedLeg" >&2
                    exit 1
                  fi
                done
                if grep -Fq '(skip)' "$lifecycleLog"; then
                  echo "T1725 lifecycle log skipped a PostgreSQL selector" >&2
                  exit 1
                fi

                runHook postCheck
              '';

              installPhase = ''
                touch "$out"
              '';
            };

            # Boot a NixOS VM with services.cq-server enabled and prove the hub
            # comes up over a native, tuned Postgres: the schema bootstraps, the
            # web bundle serves, and /api/projects answers.
            cq-server-nixos = pkgs.testers.runNixOSTest {
              name = "cq-server";
              node.specialArgs = { inherit self; };
              nodes.machine = { ... }: {
                imports = [ self.nixosModules.cq-server ];
                services.cq-server = {
                  enable = true;
                  # Non-loopback bind exercises the Q273 token gate: the module
                  # injects the token via CQ_SERVE_TOKEN (env), not a --token flag.
                  host = "0.0.0.0";
                  tokenFile = "/etc/cq-server-token";
                };
                environment.etc."cq-server-token".text = "s3cr3t-token";
                # The hub rebuilds the web bundle with bun on start — give it headroom.
                virtualisation.memorySize = 2048;
                environment.systemPackages = [ pkgs.curl ];
              };
              testScript = ''
                start_all()
                machine.wait_for_unit("postgresql.service")
                machine.wait_for_unit("cq-server.service")
                machine.wait_for_open_port(5190)
                # The token gate: /api/projects is 401 without a bearer token.
                machine.succeed(
                    "test $(curl -s -o /dev/null -w '%{http_code}' "
                    "http://127.0.0.1:5190/api/projects) = 401"
                )
                # With the token (injected via CQ_SERVE_TOKEN), it returns the
                # (initially empty) tenant registry.
                machine.succeed(
                    "curl -sf -H 'Authorization: Bearer s3cr3t-token' "
                    "http://127.0.0.1:5190/api/projects | grep -q '\"projects\"'"
                )
                # The React bundle is served at / (unauthenticated either way).
                machine.succeed("curl -sf http://127.0.0.1:5190/ | grep -qi 'html'")
                # The Postgres schema bootstrapped its tables under the cq role.
                machine.succeed(
                    "sudo -u postgres psql -tAc "
                    "\"select count(*) from information_schema.tables "
                    "where table_schema='public' and table_name='items'\" cq | grep -q 1"
                )
                # The secret is injected via env, not the argument list: it must
                # not appear in the service process's /proc cmdline.
                machine.succeed(
                    "pid=$(systemctl show -p MainPID --value cq-server.service); "
                    "! tr '\\0' ' ' < /proc/$pid/cmdline | grep -q s3cr3t-token"
                )
              '';
            };
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

      # NixOS module: the `cq serve` multi-tenant hub over a native, tuned
      # PostgreSQL (no containers). Curried over `self` so `package` defaults to
      # this flake's `cq` build for the host system. See ./nix/nixos/cq-server.nix.
      nixosModules.cq-server = import ./nix/nixos/cq-server.nix { inherit self; };
      nixosModules.default = self.nixosModules.cq-server;
    };
}
