# Portable home-manager module for the `yolo` bubblewrap sandbox wrapper.
#
# Split out of dev-llm.nix (which had grown to own the whole Claude/Codex/Pi
# harness AND the sandbox) so the sandbox's options + package wiring live in one
# focused module. Imported alongside dev-llm via `homeManagerModules.dev-llm`,
# so it shares the same `config`: it reuses `smind.hm.dev.llm.enable` as its
# on/off switch. Provider/API-key secrets are wired here via
# `smind.hm.dev.llm.yolo.secretSessionVariables` (composed + sourced inside the
# sandbox), so every harness in the sandbox inherits them.
#
# Curried over the flake's `inputs` (for the codegraph package the per-project
# index bootstrap needs). All host/hardware coupling (GPU flags, rootless-Podman
# socket, ollama models dir, ssh key) is surfaced as `smind.hm.dev.llm.*`
# options the consumer wires from its own NixOS config.
{ inputs }:
{ config
, lib
, pkgs
, ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  isLinux = pkgs.stdenv.hostPlatform.isLinux;
  codegraphPkg = inputs.codegraph.packages.${system}.default;

  cfg = config.smind.hm.dev.llm;

  yoloPkg = pkgs.callPackage ../pkg/yolo/default.nix {
    codegraph = codegraphPkg;
    podmanSocketPath = cfg.podman.socketPath;
    podmanSocketUri = cfg.podman.socketUri;
    hwNvidiaEnable = cfg.yolo.gpu.nvidiaEnable;
    hwAmdGpuEnable = cfg.yolo.gpu.amdEnable;
    hwIntelGpuEnable = cfg.yolo.gpu.intelEnable;
    llmSshKeyPath = cfg.llmSshKeyPath;
    gpuByDefault = cfg.yolo.gpuByDefault;
    extraReadOnlyPaths = cfg.yolo.extraReadOnlyPaths;
    extraReadWritePaths = cfg.yolo.extraReadWritePaths;
    extraPromptFragments = cfg.yolo.extraPromptFragments;
    # Bind the host's ollama models dir (the consumer sets this from its own
    # services.ollama.models); null skips the bind.
    ollamaModelsDir = cfg.ollamaModelsDir;
    # Extra packages exposed ONLY inside the sandbox (not the host profile).
    sandboxPackages = cfg.yolo.packages;
    # Declarative env vars set inside the sandbox session.
    sessionVariables = cfg.yolo.sessionVariables;
    # Secret-file-backed env vars composed + sourced inside the sandbox.
    secretSessionVariables = cfg.yolo.secretSessionVariables;
  };
in
{
  options = {
    # Host/hardware coupling surfaced as plain options; the consumer wires
    # them from its own NixOS config (GPU hw flags, rootless-Podman socket,
    # ollama models dir). All default to off/null so a bare consumer works.
    smind.hm.dev.llm.podman.socketPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Host path of a rootless-Podman socket to bind into the yolo sandbox,
        exposing container access to sandboxed agents. null disables it.
      '';
    };

    smind.hm.dev.llm.podman.socketUri = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        DOCKER_HOST-style URI for the rootless-Podman socket bound via
        {option}`smind.hm.dev.llm.podman.socketPath`. null disables it.
      '';
    };

    smind.hm.dev.llm.ollamaModelsDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Host directory holding the ollama models, ro-bound into the yolo
        sandbox so local-model agents can read them. null skips the bind.
      '';
    };

    smind.hm.dev.llm.llmSshKeyPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Path to an SSH private key to ro-bind into the yolo sandbox. Used on
        llm-worker hosts to give the unattended `llm` user access to the
        agenix-managed SSH key for git push / remote ssh from inside the
        bubblewrap sandbox. The key is bound at the same path it lives at
        on the host; agents must reference it explicitly
        (e.g. `GIT_SSH_COMMAND='ssh -i <path>'`).
      '';
    };

    smind.hm.dev.llm.yolo.gpu.nvidiaEnable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Host has an NVIDIA GPU the yolo `--gpu` flag should expose.";
    };

    smind.hm.dev.llm.yolo.gpu.amdEnable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Host has an AMD GPU the yolo `--gpu` flag should expose.";
    };

    smind.hm.dev.llm.yolo.gpu.intelEnable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Host has an Intel GPU the yolo `--gpu` flag should expose.";
    };

    smind.hm.dev.llm.yolo.gpuByDefault = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Default the `--gpu` flag on for `yolo` invocations on this host.
        Users can still opt out with `--no-gpu`. Has no effect on hosts
        with none of `smind.hw.{nvidia,amd.gpu,intel.gpu}.enable` set.
      '';
    };

    smind.hm.dev.llm.yolo.extraReadOnlyPaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Extra host paths to ro-bind into the yolo sandbox. Paths that don't
        exist on the host are silently skipped (handled by llm-sandbox.sh).
        Use this for per-host bulk storage (e.g. `/srv/nvme`) that should
        be visible read-only to sandboxed agents.
      '';
    };

    smind.hm.dev.llm.yolo.extraReadWritePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Extra host paths to rw-bind into the yolo sandbox. Same skip-on-missing
        semantics as `extraReadOnlyPaths`.
      '';
    };

    smind.hm.dev.llm.yolo.extraPromptFragments = lib.mkOption {
      type = lib.types.listOf lib.types.lines;
      default = [ ];
      description = ''
        Extra text fragments appended (separated by blank lines) to the
        claude `--append-system-prompt` after the YOLO authorization line.
        Use for per-host context (e.g. "this is the home NAS, /srv/nvme
        holds the photo library").
      '';
    };

    smind.hm.dev.llm.yolo.packages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.ripgrep pkgs.jq pkgs.shellcheck ]";
      description = ''
        Extra packages to expose on `PATH` INSIDE the yolo sandbox without
        installing them into the host home profile. The packages are collected
        into a single `buildEnv` whose `bin` directory is prepended to the
        sandboxed command's `PATH` (the closure is already reachable via the
        ro-bound `/nix/store`, so no extra bind is needed). Applies to every
        `yolo` subcommand (claude/codex/pi/shell/cmd). Linux-only, like the rest
        of the sandbox.
      '';
    };

    smind.hm.dev.llm.yolo.sessionVariables = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          EDITOR = "nvim";
          RUST_BACKTRACE = "1";
        }
      '';
      description = ''
        Environment variables to set INSIDE the yolo sandbox session, as a
        NAME -> value map. Applied to every `yolo` subcommand
        (claude/codex/pi/shell/cmd) via the sandbox's `--env`, and overridable
        per-invocation by an explicit `--env NAME=VALUE` flag. Values may contain
        `=` but not newlines. Mirrors home-manager's `home.sessionVariables`, but
        scoped to the sandbox only — these are NOT exported into the host session.
      '';
    };

    smind.hm.dev.llm.yolo.secretSessionVariables = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          OPENROUTER_API_KEY   = "/run/agenix/openrouter";
          BRAVE_SEARCH_API_KEY = config.age.secrets.brave.path;
          ANTHROPIC_API_KEY    = config.age.secrets.anthropic.path;
        }
      '';
      description = ''
        Secret-file-backed environment variables for the sandbox, as a map from
        the environment-variable name to the host path of the secret FILE (e.g.
        an agenix secret under `/run/agenix`, or `config.age.secrets.<n>.path`).

        Unlike {option}`smind.hm.dev.llm.yolo.sessionVariables` (literal values),
        these never pass through bwrap's argv. At launch, yolo reads each readable
        secret file's content on the host, composes a single mode-0600 file of
        `NAME=VALUE` lines, binds ONLY that one file into the sandbox, and
        re-exports each line verbatim inside before exec — so every harness
        (claude/codex/pi/shell/cmd) inherits the vars, and tokens stay out of argv
        and the Nix store. The composed file lives in tmpfs and is removed on
        exit. A secret whose file is unreadable on this host is skipped with a
        warning, so hosts missing a secret degrade gracefully. Values are
        single-line (API tokens); use {option}`smind.hm.dev.llm.llmSshKeyPath`
        for multi-line key files.
      '';
    };
  };

  # The sandbox is Linux-only (bubblewrap); on Darwin claude-code uses its own
  # sandbox wrapper, wired in dev-llm.nix. Gated on the shared harness enable.
  config = lib.mkIf (cfg.enable && isLinux) {
    home.packages = [
      pkgs.bubblewrap
      yoloPkg
    ];
  };
}
