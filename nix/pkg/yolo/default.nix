{
  lib,
  pkgs,
  nix-ld,
  jq,
  codegraph,
  podmanSocketPath ? null,
  podmanSocketUri ? null,
  llmSshKeyPath ? null,
  extraReadOnlyPaths ? [ ],
  extraReadWritePaths ? [ ],
  extraDevicePaths ? [ ],
  ollamaModelsDir ? null,
  promptForClaude ? "",
  promptForPi ? "",
  secretSessionVariables ? { },
  sandboxPackages ? [ ],
  sessionVariables ? { },
}:

let
  yoloScript = ./yolo.sh;

  # The bubblewrap path-whitelisting layer yolo execs internally (see
  # llm-sandbox.sh / `exec "$YOLO_LLM_SANDBOX"`). It has no use on its own, so
  # it is built here as a private helper rather than a standalone package — the
  # script is installed verbatim (its own `#!/usr/bin/env bash` shebang).
  llmSandbox = pkgs.runCommandLocal "llm-sandbox" { } ''
    install -Dm755 ${./llm-sandbox.sh} $out/bin/llm-sandbox
  '';
  # Tiny entrypoint that runs INSIDE the sandbox to load the composed secrets
  # file into the env before exec'ing the real command (used only when
  # secretSessionVariables are set). Installed like llm-sandbox; its store path
  # is reachable in the sandbox via the ro-bound /nix/store.
  secretsExec = pkgs.runCommandLocal "yolo-secrets-exec" { } ''
    install -Dm755 ${./secrets-exec.sh} $out/bin/yolo-secrets-exec
  '';
  podmanExports = lib.optionalString (podmanSocketPath != null) ''
    export YOLO_PODMAN_SOCKET_PATH=${lib.escapeShellArg podmanSocketPath}
    export YOLO_PODMAN_SOCKET_URI=${lib.escapeShellArg podmanSocketUri}
  '';
  llmSshKeyExports = lib.optionalString (llmSshKeyPath != null) ''
    export YOLO_LLM_SSH_KEY_PATH=${lib.escapeShellArg llmSshKeyPath}
  '';
  ollamaExports = lib.optionalString (ollamaModelsDir != null) ''
    export YOLO_OLLAMA_MODELS_DIR=${lib.escapeShellArg ollamaModelsDir}
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
  extraDevExports = lib.optionalString (extraDevicePaths != [ ]) ''
    export YOLO_EXTRA_DEV_PATHS=${lib.escapeShellArg (joinPaths extraDevicePaths)}
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
  # Per-agent system-prompt additions, composed at Nix-eval time from
  # promptExtensions (target/when filtering done in the home-manager module).
  # Passed verbatim; yolo.sh appends via --append-system-prompt when non-empty.
  promptClaudeExports = lib.optionalString (promptForClaude != "") ''
    export YOLO_PROMPT_CLAUDE=${lib.escapeShellArg promptForClaude}
  '';
  promptPiExports = lib.optionalString (promptForPi != "") ''
    export YOLO_PROMPT_PI=${lib.escapeShellArg promptForPi}
  '';
in
pkgs.writeShellScriptBin "yolo" ''
  export YOLO_LLM_SANDBOX="${llmSandbox}/bin/llm-sandbox"
  export YOLO_SECRETS_EXEC="${secretsExec}/bin/yolo-secrets-exec"
  export YOLO_NIX_LD="${nix-ld}/bin/nix-ld"
  export YOLO_JQ="${jq}/bin/jq"
  export YOLO_CODEGRAPH_BIN="${codegraph}/bin/codegraph"
  ${podmanExports}
  ${llmSshKeyExports}
  ${ollamaExports}
  ${extraRoExports}
  ${extraRwExports}
  ${extraDevExports}
  ${secretVarsExports}
  ${sandboxBinExports}
  ${sessionVarsExports}
  ${promptClaudeExports}
  ${promptPiExports}
  exec bash ${yoloScript} "$@"
''
