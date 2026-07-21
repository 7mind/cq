{
  lib,
  writeShellScriptBin,
  jq,
  claude-code-sandbox,
}:

let
  yoloDarwinScript = ./yolo-darwin.sh;
  bin = writeShellScriptBin "yolo" ''
    export YOLO_SANDBOX_EXEC="${claude-code-sandbox}/bin/claude-sandbox"
    export YOLO_JQ="${jq}/bin/jq"
    exec bash ${yoloDarwinScript} "$@"
  '';
in
bin // { meta = bin.meta // { platforms = lib.platforms.darwin; }; }
