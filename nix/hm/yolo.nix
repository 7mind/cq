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
# index bootstrap needs). All host/hardware coupling (device passthrough,
# rootless-Podman socket, ollama models dir, ssh key, prompt extensions) is
# surfaced as `smind.hm.dev.llm.*` options the consumer wires from its own
# NixOS config — GPU passthrough is no longer built in.
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

  # Per-agent composition of the prompt extensions: keep the enabled (`when`)
  # fragments targeted at this agent (or "*"), in declaration order, joined with
  # blank lines. Codex is intentionally absent — it has no --append-system-prompt.
  promptFor = agent:
    lib.concatStringsSep "\n\n" (
      map (e: e.prompt) (
        lib.filter (e: e.when && (e.target == agent || e.target == "*")) cfg.yolo.promptExtensions
      )
    );

  yoloPkg = pkgs.callPackage ../pkg/yolo/default.nix {
    codegraph = codegraphPkg;
    podmanSocketPath = cfg.podman.socketPath;
    podmanSocketUri = cfg.podman.socketUri;
    llmSshKeyPath = cfg.llmSshKeyPath;
    extraReadOnlyPaths = cfg.yolo.extraReadOnlyPaths;
    extraReadWritePaths = cfg.yolo.extraReadWritePaths;
    # Device paths bound with device access (bwrap --dev-bind), e.g. GPU nodes.
    extraDevicePaths = cfg.yolo.extraDevicePaths;
    # Bind the host's ollama models dir (the consumer sets this from its own
    # services.ollama.models); null skips the bind.
    ollamaModelsDir = cfg.ollamaModelsDir;
    # Extra packages exposed ONLY inside the sandbox (not the host profile).
    sandboxPackages = cfg.yolo.packages;
    # Declarative env vars set inside the sandbox session.
    sessionVariables = cfg.yolo.sessionVariables;
    # Secret-file-backed env vars composed + sourced inside the sandbox.
    secretSessionVariables = cfg.yolo.secretSessionVariables;
    # Per-agent system-prompt additions (see promptExtensions).
    promptForClaude = promptFor "claude";
    promptForPi = promptFor "pi";
  };
in
{
  options = {
    # Host/hardware coupling surfaced as plain options; the consumer wires
    # them from its own NixOS config (device passthrough, rootless-Podman
    # socket, ollama models dir). All default to off/null so a bare consumer works.
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

    smind.hm.dev.llm.yolo.extraDevicePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = lib.literalExpression ''[ "/dev/dri" "/dev/kfd" ]'';
      description = ''
        Host device paths to bind into the sandbox WITH device access (bwrap
        `--dev-bind`) — e.g. GPU render nodes for compute passthrough. Files or
        directories (a directory exposes every device node under it, so
        `/dev/dri` covers all render nodes). Missing paths are skipped. GPU
        passthrough is no longer built in: wire the device paths here, the
        non-device GPU bits (`/run/opengl-driver`, `/sys`) via
        {option}`smind.hm.dev.llm.yolo.extraReadOnlyPaths`, and the GPU
        availability note via {option}`smind.hm.dev.llm.yolo.promptExtensions`.
      '';
    };

    smind.hm.dev.llm.yolo.promptExtensions = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          prompt = lib.mkOption {
            type = lib.types.lines;
            description = "System-prompt fragment text appended to the targeted agent(s).";
          };
          target = lib.mkOption {
            type = lib.types.enum [ "claude" "pi" "*" ];
            default = "*";
            description = ''
              Which agent(s) the fragment is appended to: "claude", "pi", or
              "*" (both). Codex has no `--append-system-prompt` CLI hook, so it
              is not a valid target — deliver Codex instructions through the
              shared memory (`programs.codex` context / AGENTS.md) instead.
            '';
          };
          when = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Include this fragment only when true. Lets the consumer gate a
              fragment on host config (e.g. turn the GPU note on/off).
            '';
          };
        };
      });
      default = [ ];
      example = lib.literalExpression ''
        [
          { prompt = "GPU access is enabled (NVIDIA). /dev/dri is bound."; when = config.hardware.nvidia.modesetting.enable; }
          { prompt = "This host is the NAS; /srv holds the media library."; target = "*"; }
        ]
      '';
      description = ''
        Ordered system-prompt additions, appended (blank-line-separated) to each
        agent's `--append-system-prompt`, filtered per agent by `target` and
        gated by `when`. List-merges across modules: this module contributes the
        YOLO pre-authorization note (target "claude") via `mkBefore`, and the
        consumer appends host-specific fragments (GPU availability, host
        context). Replaces the old hardcoded permission/GPU notes and the
        former `extraPromptFragments` option. Codex receives none (no CLI hook).
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

  config = lib.mkMerge [
    {
      # The YOLO pre-authorization note. Claude has a permission system, so tell
      # it not to prompt on destructive ops; Pi/Codex have none, so it targets
      # claude only. mkBefore leads the list; the consumer's fragments append.
      smind.hm.dev.llm.yolo.promptExtensions = lib.mkBefore [
        {
          target = "claude";
          prompt = ''YOLO mode is active. The user has pre-authorized destructive shell operations (rm, rm -rf, kill, git reset --hard, etc.) and will not be available to confirm. Proceed without asking for confirmation on such operations. Standard safety still applies to actions with broader blast radius (force-push to shared branches, deleting remote resources, sending external messages).'';
        }
      ];
    }
    # The sandbox is Linux-only (bubblewrap); on Darwin claude-code uses its own
    # sandbox wrapper, wired in dev-llm.nix. Gated on the shared harness enable.
    (lib.mkIf (cfg.enable && isLinux) {
      home.packages = [
        pkgs.bubblewrap
        yoloPkg
      ];
    })
  ];
}
