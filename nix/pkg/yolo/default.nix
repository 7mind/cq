{
  lib,
  pkgs,
  nix-ld,
  jq,
  codegraph,
  podmanSocketPath ? null,
  podmanSocketUri ? null,
  hwNvidiaEnable ? false,
  hwAmdGpuEnable ? false,
  hwIntelGpuEnable ? false,
  llmSshKeyPath ? null,
  gpuByDefault ? false,
  extraReadOnlyPaths ? [ ],
  extraReadWritePaths ? [ ],
  ollamaModelsDir ? null,
  extraPromptFragments ? [ ],
  secretPaths ? [ ],
  sandboxPackages ? [ ],
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
  # Provider/API-key secret file paths to ro-bind into the sandbox. Newline-
  # joined like the extra-path lists; yolo.sh splits on newline and the
  # llm-sandbox layer skips any path that is absent on this host.
  secretPathExports = lib.optionalString (secretPaths != [ ]) ''
    export YOLO_SECRET_PATHS=${lib.escapeShellArg (joinPaths secretPaths)}
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
  promptExports = lib.optionalString (extraPromptFragments != [ ]) ''
    export YOLO_EXTRA_PROMPT=${lib.escapeShellArg (lib.concatStringsSep "\n\n" extraPromptFragments)}
  '';
in
pkgs.writeShellScriptBin "yolo" ''
  export YOLO_LLM_SANDBOX="${llmSandbox}/bin/llm-sandbox"
  export YOLO_NIX_LD="${nix-ld}/bin/nix-ld"
  export YOLO_JQ="${jq}/bin/jq"
  export YOLO_CODEGRAPH_BIN="${codegraph}/bin/codegraph"
  export YOLO_HW_NVIDIA_ENABLE=${if hwNvidiaEnable then "1" else "0"}
  export YOLO_HW_AMD_GPU_ENABLE=${if hwAmdGpuEnable then "1" else "0"}
  export YOLO_HW_INTEL_GPU_ENABLE=${if hwIntelGpuEnable then "1" else "0"}
  export YOLO_GPU_DEFAULT=${if gpuByDefault then "1" else "0"}
  ${podmanExports}
  ${llmSshKeyExports}
  ${ollamaExports}
  ${extraRoExports}
  ${extraRwExports}
  ${secretPathExports}
  ${sandboxBinExports}
  ${promptExports}
  exec bash ${yoloScript} "$@"
''
