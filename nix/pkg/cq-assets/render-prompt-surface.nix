{
  pkgs,
  lib,
  surface,
}:
let
  assets = import ./assets.nix { inherit lib; };
  validatedSurface =
    if builtins.elem surface assets.promptSurfaces then
      surface
    else
      throw "render-prompt-surface: unsupported surface \"${surface}\"";
  surfaceFragments = builtins.filter (
    entry: entry.surface == validatedSurface
  ) assets.promptFragmentSources;
  assetFiles = map (
    role: ./. + "/${role.canonicalSource}"
  ) assets.catalog
  ++ map (
    entry: ./. + "/${entry.source}"
  ) surfaceFragments;
  expectedAssetFileCount = builtins.length (lib.unique assetFiles);
  filteredAssets = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions assetFiles;
  };
  configRoot = ../cq-ledgers/packages/cq-config;
  rendererSource = lib.fileset.toSource {
    root = configRoot;
    fileset = lib.fileset.unions [
      (configRoot + "/scripts/render-prompt-surface.ts")
      (configRoot + "/src/promptCatalog.ts")
      (configRoot + "/src/promptRenderer.ts")
      # The schema sidecars stamp the per-role contract versions into the
      # attested surface manifest (T683); keep this closure in sync with the
      # render script's sidecar imports.
      (configRoot + "/src/schemas/implement-conflict-resolver.ts")
      (configRoot + "/src/schemas/implement-reviewer.ts")
      (configRoot + "/src/schemas/implement-worker.ts")
      (configRoot + "/src/schemas/investigate-evidence.ts")
      (configRoot + "/src/schemas/investigate-explorer.ts")
      (configRoot + "/src/schemas/investigate-prober.ts")
      (configRoot + "/src/schemas/plan-advance.ts")
      (configRoot + "/src/schemas/plan-reviewer.ts")
      (configRoot + "/src/schemas/research-experimenter.ts")
      (configRoot + "/src/schemas/research-explorer.ts")
    ];
  };
  catalogFile = builtins.toFile "cq-prompt-catalog.json" assets.catalogJson;
  sourcePathsFile = pkgs.writeText "cq-prompt-source-paths.json" (
    builtins.toJSON (
      map (role: {
        inherit (role) canonicalSource;
        path = "${filteredAssets}/${role.canonicalSource}";
      }) assets.catalog
    )
  );
  fragmentPathsFile = pkgs.writeText "cq-${validatedSurface}-prompt-fragment-paths.json" (
    builtins.toJSON (
      map (entry: {
        inherit (entry) roleId fragment;
        path = "${filteredAssets}/${entry.source}";
      }) surfaceFragments
    )
  );
in
pkgs.runCommand "cq-${validatedSurface}-prompt-root"
  {
    nativeBuildInputs = [ pkgs.bun ];
    passthru.promptCatalog = assets.catalog;
  }
  ''
    test "$(find ${rendererSource} -type f | wc -l)" -eq 13
    test "$(find ${filteredAssets} -type f | wc -l)" -eq ${toString expectedAssetFileCount}
    bun run ${rendererSource}/scripts/render-prompt-surface.ts \
      ${lib.escapeShellArg validatedSurface} \
      ${catalogFile} \
      ${sourcePathsFile} \
      ${fragmentPathsFile} \
      "$out"
  ''
