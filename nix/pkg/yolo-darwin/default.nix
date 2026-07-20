{
  lib,
  writeShellScriptBin,
  jq,
  claude-code-sandbox,
  # Keychain services use <prefix><profile>; the wrapper exports this prefix.
  keychainServicePrefix ? "claude-code-",
}:

let
  yoloDarwinScript = ./yolo-darwin.sh;
  bin = writeShellScriptBin "yolo" ''
    export YOLO_SANDBOX_EXEC="${claude-code-sandbox}/bin/claude-code-sandbox"
    export YOLO_JQ="${jq}/bin/jq"
    export YOLO_KEYCHAIN_SERVICE_PREFIX="${keychainServicePrefix}"
    exec bash ${yoloDarwinScript} "$@"
  '';
in
bin // { meta = bin.meta // { platforms = lib.platforms.darwin; }; }
