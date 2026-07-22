{
  lib,
  pkgs,
  nix-ld,
  jq,
  podmanSocketPath ? null,
  podmanSocketUri ? null,
  extraReadOnlyPaths ? [ ],
  extraReadWritePaths ? [ ],
  extraDevicePaths ? [ ],
  promptJson ? "[]",
  prehooksJson ? "[]",
  sandboxHooksJson ? "[]",
  secretSessionVariables ? { },
  sandboxPackages ? [ ],
  sessionVariables ? { },
}:

let
  yoloScript = ./yolo.sh;
  customPromptScript = pkgs.writeText "yolo-custom-prompt.sh" (builtins.readFile ./custom-prompt.sh);

  # The bubblewrap path-whitelisting layer yolo execs internally (see
  # llm-sandbox.sh / `exec "$YOLO_LLM_SANDBOX"`). It has no use on its own, so
  # it is built here as a private helper rather than a standalone package — the
  # script is installed verbatim (its own `#!/usr/bin/env bash` shebang).
  llmSandbox = pkgs.runCommandLocal "llm-sandbox" { } ''
    install -Dm755 ${./llm-sandbox.sh} $out/bin/llm-sandbox
  '';
  # In-sandbox entrypoint: loads the composed secrets file into the env and
  # sources the composed sandbox pre-start hook script before exec'ing the real
  # command (used when secretSessionVariables and/or sandbox pre-start hooks are
  # set). Installed like llm-sandbox; reachable in the sandbox via /nix/store.
  sandboxEntrypoint = pkgs.runCommandLocal "yolo-sandbox-entrypoint" { } ''
    install -Dm755 ${./sandbox-entrypoint.sh} $out/bin/yolo-sandbox-entrypoint
  '';
  podmanExports = lib.optionalString (podmanSocketPath != null) ''
    export YOLO_PODMAN_SOCKET_PATH=${lib.escapeShellArg podmanSocketPath}
    export YOLO_PODMAN_SOCKET_URI=${lib.escapeShellArg podmanSocketUri}
  '';
  # Newline-joined path lists: paths cannot contain newlines, so this is
  # unambiguous and survives shell quoting. yolo.sh splits on newline.
  joinPaths = paths: lib.concatStringsSep "\n" paths;
  extraRoExports = lib.optionalString (extraReadOnlyPaths != [ ]) ''
    export YOLO_EXTRA_RO_PATHS=${lib.escapeShellArg (joinPaths extraReadOnlyPaths)}
  '';
  extraRwExports = lib.optionalString (extraReadWritePaths != [ ]) ''
    export YOLO_EXTRA_RW_PATHS=${lib.escapeShellArg (joinPaths extraReadWritePaths)}
  '';
  # Device records, one TAB-separated `path<TAB>tags-csv` line per entry (paths
  # and tags contain no tab or newline). yolo.sh splits on newline then tab, and
  # drops a record if any of its tags is in the `--disable=<tag>` set.
  devLines = map (d: "${d.path}\t${lib.concatStringsSep "," d.tags}") extraDevicePaths;
  extraDevExports = lib.optionalString (extraDevicePaths != [ ]) ''
    export YOLO_EXTRA_DEV_PATHS=${lib.escapeShellArg (lib.concatStringsSep "\n" devLines)}
  '';
  # Secret session variables: ENV_VAR -> host secret-file path. Serialized as
  # one newline-joined NAME=path line per entry (paths cannot contain newlines).
  # yolo.sh reads each file's content on the host into a single 0600 NAME=VALUE
  # file, binds only THAT file into the sandbox, and re-exports it inside — so
  # secrets reach every harness's env without ever passing through bwrap argv
  # (unlike --env) and without mounting each secret individually.
  secretVarLines = lib.mapAttrsToList (name: path: "${name}=${path}") secretSessionVariables;
  secretVarsExports = lib.optionalString (secretSessionVariables != { }) ''
    export YOLO_SECRET_VARS=${lib.escapeShellArg (lib.concatStringsSep "\n" secretVarLines)}
  '';
  # Extra packages exposed only inside the sandbox: collect them into one
  # buildEnv and hand yolo.sh its bin dir (already reachable via the ro-bound
  # /nix/store) to prepend onto the sandboxed command's PATH. Built lazily —
  # only forced when the list is non-empty (the export below is otherwise "").
  sandboxEnv = pkgs.buildEnv {
    name = "yolo-sandbox-packages";
    paths = sandboxPackages;
  };
  sandboxBinExports = lib.optionalString (sandboxPackages != [ ]) ''
    export YOLO_SANDBOX_BIN=${sandboxEnv}/bin
  '';
  # Declarative session env vars set INSIDE the sandbox. Serialized as one
  # newline-joined NAME=VALUE line per entry; yolo.sh splits on newline and
  # the llm-sandbox layer splits each line on the first `=`, so values may
  # contain `=` (but not newlines).
  sessionVarLines = lib.mapAttrsToList (name: value: "${name}=${value}") sessionVariables;
  sessionVarsExports = lib.optionalString (sessionVariables != { }) ''
    export YOLO_SESSION_VARS=${lib.escapeShellArg (lib.concatStringsSep "\n" sessionVarLines)}
  '';
  # System-prompt extensions as a JSON array of { target, tags, prompt } objects
  # (the home-manager module does the Nix-`when` filtering and builds the JSON).
  # yolo.sh composes each agent's prompt at launch with jq — keeping objects
  # whose target matches and none of whose tags is in the `--disable` set — so
  # runtime suppression (e.g. `--disable=gpu`) drops the matching note too. JSON
  # carries multi-line prompt bodies with no extra escaping.
  promptJsonExports = lib.optionalString (promptJson != "[]") ''
    export YOLO_PROMPT_JSON=${lib.escapeShellArg promptJson}
  '';
  # Host pre-start hooks as a JSON array of { command, tags } objects (the
  # home-manager module builds the JSON). yolo.sh runs them on the host before an
  # agent session, dropping hooks whose tags are in the `--disable` set.
  prehooksJsonExports = lib.optionalString (prehooksJson != "[]") ''
    export YOLO_PREHOOKS_JSON=${lib.escapeShellArg prehooksJson}
  '';
  # Sandbox pre-start hooks as a JSON array of { command, tags }. yolo.sh
  # composes the surviving (non-disabled) commands into one script, binds it,
  # and the in-sandbox entrypoint sources it before exec.
  sandboxHooksJsonExports = lib.optionalString (sandboxHooksJson != "[]") ''
    export YOLO_SANDBOX_HOOKS_JSON=${lib.escapeShellArg sandboxHooksJson}
  '';
in
pkgs.writeShellScriptBin "yolo" ''
  export YOLO_LLM_SANDBOX="${llmSandbox}/bin/llm-sandbox"
  export YOLO_SANDBOX_ENTRYPOINT="${sandboxEntrypoint}/bin/yolo-sandbox-entrypoint"
  export YOLO_NIX_LD="${nix-ld}/bin/nix-ld"
  export YOLO_JQ="${jq}/bin/jq"
  export YOLO_CUSTOM_PROMPT="${customPromptScript}"
  ${podmanExports}
  ${extraRoExports}
  ${extraRwExports}
  ${extraDevExports}
  ${secretVarsExports}
  ${sandboxBinExports}
  ${sessionVarsExports}
  ${promptJsonExports}
  ${prehooksJsonExports}
  ${sandboxHooksJsonExports}
  exec bash ${yoloScript} "$@"
''
