{ lib }:
let
  schema = import ./prompt-surfaces.nix { inherit lib; };

  knownDeclaration = {
    kind = "dispatch-protocol";
    reason = "Pi routes dispatched roles through the cq-subagent extension.";
    surfaces = [
      "claude"
      "pi"
    ];
  };

  fixtureJson = lib.removeSuffix "\n" (builtins.readFile ./prompt-surfaces-fixture.json);

  rejects =
    value:
    !(builtins.tryEval (
      builtins.deepSeq (schema.validateIntentionalDifference value) true
    )).success;
in
assert schema.promptSurfaces == [
  "claude"
  "codex"
  "pi"
];
assert schema.intentionalDifferenceKinds == [
  "invocation-syntax"
  "dispatch-protocol"
  "recursion-protocol"
  "tool-vocabulary"
];
assert schema.serializeIntentionalDifference knownDeclaration == fixtureJson;
assert rejects (knownDeclaration // { kind = "content"; });
assert rejects (knownDeclaration // { surfaces = [ "terminal" "pi" ]; });
assert rejects (knownDeclaration // { surfaces = [ "pi" "pi" ]; });
assert rejects (knownDeclaration // { surfaces = [ "pi" ]; });
assert rejects (knownDeclaration // { reason = "  "; });
assert rejects (builtins.removeAttrs knownDeclaration [ "reason" ]);
assert rejects (knownDeclaration // { extra = true; });
assert rejects [ knownDeclaration ];
true
