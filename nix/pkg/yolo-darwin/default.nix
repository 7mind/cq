{ lib
, buildEnv
, writeShellScriptBin
, writeText
, writeTextFile
, jq
, claude-code-sandbox
, extraReadOnlyPaths ? [ ]
, extraReadWritePaths ? [ ]
, promptJson ? "[]"
, prehooksJson ? "[]"
, sandboxHooksJson ? "[]"
, secretSessionVariables ? { }
, sandboxPackages ? [ ]
, sessionVariables ? { }
,
}:

let
  yoloDarwinScript = ./yolo-darwin.sh;
  # Read through the source-tree symlink and materialize a regular store file;
  # copying the yolo-darwin directory alone would preserve a dangling link.
  customPromptScript = writeText "yolo-custom-prompt.sh" (builtins.readFile ./custom-prompt.sh);
  sandboxEntrypoint = writeTextFile {
    name = "yolo-sandbox-entrypoint";
    destination = "/bin/yolo-sandbox-entrypoint";
    executable = true;
    text = builtins.readFile ../yolo/sandbox-entrypoint.sh;
  };
  joinLines = lib.concatStringsSep "\n";
  extraRoExports = lib.optionalString (extraReadOnlyPaths != [ ]) ''
    export YOLO_EXTRA_RO_PATHS=${lib.escapeShellArg (joinLines extraReadOnlyPaths)}
  '';
  extraRwExports = lib.optionalString (extraReadWritePaths != [ ]) ''
    export YOLO_EXTRA_RW_PATHS=${lib.escapeShellArg (joinLines extraReadWritePaths)}
  '';
  secretVarLines = lib.mapAttrsToList (name: path: "${name}=${path}") secretSessionVariables;
  secretVarsExports = lib.optionalString (secretSessionVariables != { }) ''
    export YOLO_SECRET_VARS=${lib.escapeShellArg (joinLines secretVarLines)}
  '';
  sandboxEnv = buildEnv {
    name = "yolo-darwin-sandbox-packages";
    paths = sandboxPackages;
  };
  sandboxBinExports = lib.optionalString (sandboxPackages != [ ]) ''
    export YOLO_SANDBOX_BIN=${sandboxEnv}/bin
  '';
  sessionVarLines = lib.mapAttrsToList (name: value: "${name}=${value}") sessionVariables;
  sessionVarsExports = lib.optionalString (sessionVariables != { }) ''
    export YOLO_SESSION_VARS=${lib.escapeShellArg (joinLines sessionVarLines)}
  '';
  promptJsonExports = lib.optionalString (promptJson != "[]") ''
    export YOLO_PROMPT_JSON=${lib.escapeShellArg promptJson}
  '';
  prehooksJsonExports = lib.optionalString (prehooksJson != "[]") ''
    export YOLO_PREHOOKS_JSON=${lib.escapeShellArg prehooksJson}
  '';
  sandboxHooksJsonExports = lib.optionalString (sandboxHooksJson != "[]") ''
    export YOLO_SANDBOX_HOOKS_JSON=${lib.escapeShellArg sandboxHooksJson}
  '';
  bin = writeShellScriptBin "yolo" ''
    export YOLO_SANDBOX_EXEC="${claude-code-sandbox}/bin/claude-sandbox"
    export YOLO_JQ="${jq}/bin/jq"
    export YOLO_CUSTOM_PROMPT="${customPromptScript}"
    export YOLO_SANDBOX_ENTRYPOINT="${sandboxEntrypoint}/bin/yolo-sandbox-entrypoint"
    ${extraRoExports}
    ${extraRwExports}
    ${secretVarsExports}
    ${sandboxBinExports}
    ${sessionVarsExports}
    ${promptJsonExports}
    ${prehooksJsonExports}
    ${sandboxHooksJsonExports}
    exec bash ${yoloDarwinScript} "$@"
  '';
in
bin // { meta = bin.meta // { platforms = lib.platforms.darwin; }; }
