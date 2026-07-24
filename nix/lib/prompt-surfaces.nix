{ lib }:
let
  promptSurfaces = [
    "claude"
    "codex"
    "pi"
  ];

  intentionalDifferenceKinds = [
    "invocation-syntax"
    "dispatch-protocol"
    "recursion-protocol"
    "tool-vocabulary"
  ];

  fail = path: detail: throw "prompt-surface schema: ${path}: ${detail}";

  validatePromptSurface =
    path: value:
    if !builtins.isString value || !(builtins.elem value promptSurfaces) then
      fail path "expected one of ${lib.concatStringsSep ", " promptSurfaces}"
    else
      value;

  unique =
    values:
    builtins.foldl' (
      result: value:
      if builtins.elem value result then result else result ++ [ value ]
    ) [ ] values;

  validateIntentionalDifference =
    declaration:
    if !builtins.isAttrs declaration then
      fail "intentionalDifference" "expected an attribute set"
    else if builtins.attrNames declaration != [
      "kind"
      "reason"
      "surfaces"
    ] then
      fail "intentionalDifference" "expected exactly kind, reason, and surfaces"
    else if
      !builtins.isString declaration.kind
      || !(builtins.elem declaration.kind intentionalDifferenceKinds)
    then
      fail "intentionalDifference.kind"
        "expected one of ${lib.concatStringsSep ", " intentionalDifferenceKinds}"
    else if !builtins.isString declaration.reason || builtins.match ".*[^[:space:]].*" declaration.reason == null then
      fail "intentionalDifference.reason" "expected a non-empty string"
    else if !builtins.isList declaration.surfaces then
      fail "intentionalDifference.surfaces" "expected a list"
    else if builtins.length declaration.surfaces < 2 then
      fail "intentionalDifference.surfaces" "expected at least two participating surfaces"
    else if builtins.length declaration.surfaces != builtins.length (unique declaration.surfaces) then
      fail "intentionalDifference.surfaces" "duplicate prompt surface"
    else
      declaration
      // {
        surfaces = lib.imap0 (
          index: surface:
          validatePromptSurface "intentionalDifference.surfaces[${toString index}]" surface
        ) declaration.surfaces;
      };

  serializeIntentionalDifference =
    declaration:
    builtins.toJSON (validateIntentionalDifference declaration);
in
{
  inherit
    promptSurfaces
    intentionalDifferenceKinds
    validatePromptSurface
    validateIntentionalDifference
    serializeIntentionalDifference
    ;
}
