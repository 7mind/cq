{ lib }:
let
  assets = import ../pkg/cq-assets/assets.nix { inherit lib; };
  catalog = assets.catalog;
  first = builtins.head catalog;

  replaceAt =
    index: replacement: values:
    lib.imap0 (current: value: if current == index then replacement value else value) values;

  reject =
    value:
    !(builtins.tryEval (
      builtins.deepSeq (assets.validatePromptCatalog value) true
    )).success;

  withFirst =
    update:
    replaceAt 0 (role: role // update role) catalog;

  withBegin =
    update:
    replaceAt 9 (role: role // update role) catalog;

  invalidFragmentCatalog = withFirst (role: {
    fragmentBindings = replaceAt 0 (
      binding: binding // { fragment = "terminal-command"; }
    ) role.fragmentBindings;
  });

  invalidDispatchCatalog = withBegin (role: {
    dispatchRelations = replaceAt 0 (
      relation: relation // { targetRoleId = "missing-role"; }
    ) role.dispatchRelations;
  });

  begin = builtins.elemAt catalog 9;
  assetsSource = builtins.readFile ../pkg/cq-assets/assets.nix;
in
assert builtins.length catalog == 24;
assert first.roleId == "plan-advance";
assert (lib.last catalog).roleId == "reviewers";
assert begin.canonicalSource == "commands/cq/begin.md";
assert begin.roleKind == "orchestrator-command";
assert begin.sidecar == null;
assert first.sidecar == { schemaRoleId = "plan-advance"; };
assert builtins.fromJSON assets.catalogJson == catalog;
assert assets.promptCatalogProjection == {
  schemaVersion = 1;
  inherit catalog;
  catalogMetadataHash = assets.catalogMetadataHash;
  fragmentContracts = assets.fragmentContracts;
};
assert assets.catalogMetadataHash == builtins.hashString "sha256" assets.catalogJson;
assert assets.catalogMetadataHash
  == "0be090117ba27b3615ec2d9e181bba39fb3386042949f31dc42489eb123f2a42";
assert assets.promptSurfaceLayout == map (
  surface:
  let
    root = "$out/share/cq/prompt-surfaces/${surface}";
  in
  {
    inherit surface root;
    catalog = "${root}/catalog.json";
    surfaceMetadata = "${root}/surface.json";
    roles = "${root}/roles";
    roleArtifacts = map (role: {
      roleId = role.roleId;
      path = "${root}/roles/${role.roleId}.md";
    }) catalog;
  }
) [
  "claude"
  "codex"
  "pi"
];
assert !lib.hasInfix "promptCatalog.gen.ts" assetsSource;
assert reject (withFirst (_: { surfaces = [ "claude" "terminal" ]; }));
assert reject (withFirst (_: { canonicalSource = "agents/missing.md"; }));
assert reject invalidFragmentCatalog;
assert reject (withFirst (_: { sidecar = { schemaRoleId = "plan-reviewer"; }; }));
assert reject invalidDispatchCatalog;
assert reject (catalog ++ [ first ]);
assert reject (builtins.tail catalog);
true
