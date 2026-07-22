{
  lib,
  writeShellScriptBin,
  writeText,
  jq,
  claude-code-sandbox,
  promptJson ? "[]",
}:

let
  yoloDarwinScript = ./yolo-darwin.sh;
  # Read through the source-tree symlink and materialize a regular store file;
  # copying the yolo-darwin directory alone would preserve a dangling link.
  customPromptScript = writeText "yolo-custom-prompt.sh" (builtins.readFile ./custom-prompt.sh);
  promptJsonExports = lib.optionalString (promptJson != "[]") ''
    export YOLO_PROMPT_JSON=${lib.escapeShellArg promptJson}
  '';
  bin = writeShellScriptBin "yolo" ''
    export YOLO_SANDBOX_EXEC="${claude-code-sandbox}/bin/claude-sandbox"
    export YOLO_JQ="${jq}/bin/jq"
    export YOLO_CUSTOM_PROMPT="${customPromptScript}"
    ${promptJsonExports}
    exec bash ${yoloDarwinScript} "$@"
  '';
in
bin // { meta = bin.meta // { platforms = lib.platforms.darwin; }; }
