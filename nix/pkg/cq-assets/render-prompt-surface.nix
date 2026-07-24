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
  }
  ''
    test "$(find ${rendererSource} -type f | wc -l)" -eq 3
    test "$(find ${filteredAssets} -type f | wc -l)" -eq ${toString expectedAssetFileCount}
    bun run ${rendererSource}/scripts/render-prompt-surface.ts \
      ${lib.escapeShellArg validatedSurface} \
      ${catalogFile} \
      ${sourcePathsFile} \
      ${fragmentPathsFile} \
      "$out"
  ''
