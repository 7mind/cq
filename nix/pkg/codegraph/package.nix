# CodeGraph — semantic code-intelligence MCP server (a Node/TypeScript CLI over
# a tree-sitter knowledge graph).
#
# Vendored derivation: upstream (colbymchenry/codegraph) ships NO nix support,
# so we build it from source with THIS flake's nixpkgs. `src` is the `codegraph`
# flake input (github, flake = false, tracking main; the lock pins the rev).
# buildNpmPackage runs the `build` script (tsc + copy-assets: the tree-sitter
# `.wasm` grammars and schema.sql -> dist/) and we add a `--liftoff-only`
# launcher wrapper.
#
# To bump: `nix flake update codegraph`; if `package-lock.json` changed, refresh
# `hash` below (set it to lib.fakeHash, build, paste the reported `got:` hash).
{
  lib,
  buildNpmPackage,
  fetchNpmDeps,
  nodejs_24,
  src,
}:

buildNpmPackage {
  pname = "codegraph";
  version = (builtins.fromJSON (builtins.readFile "${src}/package.json")).version;

  inherit src;

  npmDeps = fetchNpmDeps {
    inherit src;
    # Hash of the pinned main rev's package-lock.json closure. Refresh on bumps.
    hash = "sha256-7cGlc4q+9DoPsyPDos5BfE9n2Qmvlvl8QEDiD/y6+e0=";
  };

  nodejs = nodejs_24;

  npmBuildScript = "build";
  npmInstallFlags = [ "--ignore-scripts" ];
  dontNpmRebuild = true;

  # `build` runs the `copy-assets` npm script (.wasm + schema.sql -> dist/), so
  # there is nothing extra to stage here. Pure JS + WASM, no native addons.
  installPhase = ''
    runHook preInstall

    # Application code + production node_modules (populated by buildNpmPackage).
    mkdir -p $out/lib/codegraph
    cp -r dist $out/lib/codegraph/dist
    cp package.json $out/lib/codegraph/
    cp -r node_modules $out/lib/codegraph/node_modules

    # Launcher wrapper: --liftoff-only keeps tree-sitter's large WASM grammars
    # on V8's Liftoff baseline compiler, avoiding the turboshaft Zone OOM
    # (CodeGraph issues #293/#298). Built with printf (not a heredoc) so the
    # shebang lands at column 0 regardless of this nix string's indentation.
    # CODEGRAPH_TELEMETRY defaults to 0: upstream sends anonymous usage
    # telemetry unless opted out, and the CLI opt-out (~/.codegraph/
    # telemetry.json) does not survive sandboxed sessions. The env var wins
    # over stored config; an explicit CODEGRAPH_TELEMETRY=1 still opts in.
    mkdir -p $out/bin
    printf '#!/bin/sh\nexport CODEGRAPH_TELEMETRY="''${CODEGRAPH_TELEMETRY:-0}"\nexec %s --liftoff-only %s/lib/codegraph/dist/bin/codegraph.js "$@"\n' \
      '${nodejs_24}/bin/node' "$out" > $out/bin/codegraph
    chmod +x $out/bin/codegraph

    runHook postInstall
  '';

  meta = {
    description =
      "Semantic code intelligence for AI agents — local-first knowledge graph over tree-sitter";
    homepage = "https://github.com/colbymchenry/codegraph";
    license = lib.licenses.mit;
    mainProgram = "codegraph";
    platforms = lib.platforms.unix;
  };
}
