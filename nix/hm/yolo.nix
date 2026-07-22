# Portable home-manager module for the `yolo` bubblewrap sandbox wrapper.
#
# Split out of dev-llm.nix (which had grown to own the whole Claude/Codex/Pi
# harness AND the sandbox) so the sandbox's options + package wiring live in one
# focused module. Imported alongside dev-llm via `homeManagerModules.dev-llm`,
# so it shares the same `config`: it reuses `smind.hm.dev.llm.enable` as its
# on/off switch. Provider/API-key secrets are wired here via
# `smind.hm.dev.llm.yolo.secretSessionVariables` on Linux (composed + sourced
# inside bubblewrap), so every Linux harness inherits them. Darwin inherits the
# launcher's environment; secret-file composition is not wired there.
#
# Curried over the flake's `inputs` (for the codegraph package the per-project
# index bootstrap needs). All host/hardware coupling (device passthrough,
# rootless-Podman socket, ssh key, prompt extensions) is surfaced as
# `smind.hm.dev.llm.*` options the consumer wires from its own NixOS config —
# GPU passthrough is no longer built in, and plain read-only binds (e.g. an
# ollama models dir) go through extraReadOnlyPaths.
{ inputs }:
{ config
, lib
, pkgs
, ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  isLinux = pkgs.stdenv.hostPlatform.isLinux;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  codegraphPkg = pkgs.callPackage ../pkg/codegraph/package.nix {
    src = inputs.codegraph;
  };

  cfg = config.smind.hm.dev.llm;

  # SSH key for remote worker machines: bound read-only (folded into the ro path
  # set below) and announced to agents via a prompt fragment (config, below) —
  # replacing the old dedicated YOLO_LLM_SSH_KEY_PATH env + bind. null disables.
  sshKeySet = cfg.llmSshKeyPath != null;

  # Prompt extensions (Idea 1) as a JSON array of { target, tags, prompt },
  # Nix-`when`-filtered and in declaration order. yolo.sh composes each agent's
  # prompt at launch with jq and drops objects whose tags intersect the runtime
  # `--disable` set — so the same tag gates a device bind AND its note
  # (e.g. `--disable=gpu`). JSON carries multi-line prompt bodies verbatim.
  promptJson = builtins.toJSON (
    map (e: { inherit (e) target tags prompt; }) (lib.filter (e: e.when) cfg.yolo.promptExtensions)
  );

  # Shared submodule for a tagged pre-start hook.
  hookType = lib.types.submodule {
    options = {
      command = lib.mkOption {
        type = lib.types.lines;
        description = "Shell command to run.";
      };
      tags = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "codegraph" ];
        description = "Suppression tags; the hook is skipped if any is in the `--disable` set.";
      };
    };
  };

  # Pre-start hooks as JSON arrays of { command, tags }. Host hooks run on the
  # host before an agent session; sandbox hooks run INSIDE the sandbox (via the
  # entrypoint) before the command. Both drop tags in the `--disable` set.
  prehooksJson = builtins.toJSON cfg.yolo.hooks.pre-start.host;
  sandboxHooksJson = builtins.toJSON cfg.yolo.hooks.pre-start.sandbox;

  # codegraph passed into the sandbox via the package set (no dedicated binary
  # env anymore); the per-project index bootstrap is a sandbox pre-start hook
  # (contributed in config below). null disables all codegraph integration.
  codegraphSet = cfg.yolo.codegraph != null;

  yoloPkg = pkgs.callPackage ../pkg/yolo/default.nix {
    podmanSocketPath = cfg.podman.socketPath;
    podmanSocketUri = cfg.podman.socketUri;
    # The remote-worker SSH key is just another read-only bind.
    extraReadOnlyPaths = cfg.yolo.extraReadOnlyPaths ++ lib.optional sshKeySet cfg.llmSshKeyPath;
    extraReadWritePaths = cfg.yolo.extraReadWritePaths;
    # Device paths bound with device access (bwrap --dev-bind), e.g. GPU nodes.
    extraDevicePaths = cfg.yolo.extraDevicePaths;
    # Extra packages exposed ONLY inside the sandbox (not the host profile);
    # codegraph rides along here so its CLI / `init -i` work inside the sandbox.
    sandboxPackages = cfg.yolo.packages ++ lib.optional codegraphSet cfg.yolo.codegraph;
    # Declarative env vars set inside the sandbox session.
    sessionVariables = cfg.yolo.sessionVariables;
    # Secret-file-backed env vars composed + sourced inside the sandbox.
    secretSessionVariables = cfg.yolo.secretSessionVariables;
    # Tagged, runtime-suppressible system-prompt additions (see promptExtensions).
    inherit promptJson;
    # Tagged pre-start hooks: host (before sandbox) + sandbox (inside, via the
    # entrypoint). See hooks.pre-start.{host,sandbox}.
    inherit prehooksJson sandboxHooksJson;
  };
in
{
  options = {
    # Host/hardware coupling surfaced as plain options; the consumer wires
    # them from its own NixOS config (device passthrough, rootless-Podman
    # socket). All default to off/null so a bare consumer works.
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

    smind.hm.dev.llm.llmSshKeyPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Linux-only path to an SSH private key for remote worker machines. When
        set on Linux, the key is read-only bound into the sandbox at the same
        host path (folded into the read-only bind set), AND a prompt fragment
        (tagged "ssh") tells agents how to authenticate. Darwin does not add a
        filesystem grant or prompt for this option. null disables both.
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
      type = lib.types.listOf (lib.types.submodule {
        options = {
          path = lib.mkOption {
            type = lib.types.str;
            description = "Host device path to bind (file or directory).";
          };
          tags = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            example = [ "gpu" "amd" ];
            description = ''
              Suppression tags (e.g. `[ "gpu" "amd" ]`). The runtime
              `yolo --disable=<tag>` flag drops every device (and prompt
              fragment) carrying that tag, so tag a device with both its broad
              feature ("gpu") and any finer label ("amd") you may want to target.
            '';
          };
        };
      });
      default = [ ];
      example = lib.literalExpression ''
        [
          { path = "/dev/dri"; tags = [ "gpu" ]; }
          { path = "/dev/kfd"; tags = [ "gpu" "amd" ]; }
        ]
      '';
      description = ''
        Host device paths bound into the sandbox WITH device access (bwrap
        `--dev-bind`) — e.g. GPU render nodes for compute passthrough. Each entry
        is `{ path; tags ? []; }`; a directory `path` exposes every device node
        under it (so `/dev/dri` covers all render nodes). A device is dropped at
        launch if any of its `tags` is in the `yolo --disable=<tag>` set (e.g.
        `--disable=gpu`). Missing paths are skipped. GPU passthrough is no longer
        built in: wire the device paths here, the non-device GPU bits
        (`/run/opengl-driver`, `/sys`) via
        {option}`smind.hm.dev.llm.yolo.extraReadOnlyPaths`, and the GPU
        availability note (tagged the same, so `--disable=gpu` hides it too) via
        {option}`smind.hm.dev.llm.yolo.promptExtensions`.
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
          tags = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            example = [ "gpu" ];
            description = ''
              Suppression tags. The fragment is dropped at launch if any tag is
              in the `yolo --disable=<tag>` set — the same namespace as
              {option}`smind.hm.dev.llm.yolo.extraDevicePaths` tags, so tagging
              the GPU note `[ "gpu" ]` makes `--disable=gpu` hide the note along
              with the GPU device binds.
            '';
          };
          when = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Static (Nix-eval-time) gate: include this fragment only when true.
              Use it for per-host inclusion; use `tags` + `--disable` for
              per-run runtime suppression.
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
        agent's `--append-system-prompt`, filtered per agent by `target`, gated
        statically by `when` (Nix-eval) and at runtime by `tags` + the
        `yolo --disable=<tag>` flag. List-merges across modules: this module
        contributes the YOLO pre-authorization note (target "claude") and, on
        Linux only, the configured remote-worker SSH note (tag "ssh") and
        GitHub agent-account note (tag "github"). The consumer appends
        host-specific fragments (e.g. the GPU
        availability note, tagged "gpu"). Replaces the old hardcoded
        permission/GPU notes and the former `extraPromptFragments` option. Codex
        receives none (no CLI hook).
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
        Linux-only environment variables to set inside the bubblewrap session,
        as a NAME -> value map. Applied to every Linux `yolo` subcommand and
        overridable by `--env NAME=VALUE`. Values may contain `=` but not
        newlines. Darwin instead inherits the launcher's environment and accepts
        per-invocation `--env`; this declarative map is not wired there.
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

        Linux-only secret-file-backed environment variables. Unlike
        {option}`smind.hm.dev.llm.yolo.sessionVariables`, these never pass
        through bwrap's argv: yolo composes one mode-0600 file, binds it into
        bubblewrap, sources it before exec, and removes it on exit. Unreadable
        files are skipped with a warning. Darwin does not compose or bind these
        files; use native OAuth or the launcher's inherited environment there.
        Values are single-line API tokens; use
        {option}`smind.hm.dev.llm.llmSshKeyPath` for Linux multi-line key files.
      '';
    };

    smind.hm.dev.llm.yolo.codegraph = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = codegraphPkg;
      defaultText = lib.literalExpression "pkgs.callPackage ../pkg/codegraph/package.nix { src = inputs.codegraph; }";
      description = ''
        The codegraph package, or null to disable codegraph integration. When
        set, codegraph is added to the sandbox package set (its CLI / `init -i`
        work inside the sandbox), the per-project index bootstrap is registered
        as a `codegraph`-tagged sandbox pre-start hook (run `yolo --disable=codegraph`
        to skip it), and a `codegraph`-tagged usage note is added to
        {option}`smind.hm.dev.llm.yolo.promptExtensions`. null removes all three.
        The codegraph MCP server is configured separately (in tools.nix) and is
        unaffected by this option.
      '';
    };

    smind.hm.dev.llm.yolo.hooks.pre-start.host = lib.mkOption {
      type = lib.types.listOf hookType;
      default = [ ];
      description = ''
        Commands run ON THE HOST (in the launch directory) before the sandbox
        starts, for agent subcommands only (claude/codex/pi; shell/cmd skip
        them), each via `bash -c`. Run in declaration order, best-effort (a
        failure warns but does not abort). A hook is skipped if any of its
        `tags` is in the runtime `yolo --disable=<tag>` set. List-merges across
        modules.
      '';
    };

    smind.hm.dev.llm.yolo.hooks.pre-start.sandbox = lib.mkOption {
      type = lib.types.listOf hookType;
      default = [ ];
      description = ''
        Commands run INSIDE the sandbox before the command, for agent
        subcommands only (claude/codex/pi). The surviving (non-`--disable`'d)
        hooks are composed into one script that the in-sandbox entrypoint
        SOURCES — after loading secret session variables and before exec'ing the
        agent — so a hook runs in that shell and any environment it exports is
        inherited by the agent (and it may use the secret env vars). Run in
        declaration order; a non-zero command does not abort (no `set -e`). A
        hook is skipped if any of its `tags` is in the `yolo --disable=<tag>` set.
        List-merges across modules: the per-project codegraph index bootstrap is
        contributed here (tag "codegraph") when
        {option}`smind.hm.dev.llm.yolo.codegraph` is non-null.
      '';
    };
  };

  config = lib.mkMerge [
    {
      # Module-provided prompt fragments, leading the list (mkBefore); the
      # consumer's fragments append after.
      #   - YOLO authorization (claude only — Pi/Codex have no permission system).
      #   - Sandbox-active note (every harness — yolo always sets SMIND_SANDBOXED,
      #     so presence of this fragment IS the "sandbox active" signal).
      #   - SSH remote-worker key usage (Linux, when llmSshKeyPath is set).
      #   - GitHub agent-account note (Linux, when GH_TOKEN is a secret session var).
      smind.hm.dev.llm.yolo.promptExtensions = lib.mkBefore (
        [
          {
            target = "claude";
            prompt = ''YOLO mode is active. The user has pre-authorized destructive shell operations (rm, rm -rf, kill, git reset --hard, etc.) and will not be available to confirm. Proceed without asking for confirmation on such operations. Standard safety still applies to actions with broader blast radius (force-push to shared branches, deleting remote resources, sending external messages).'';
          }
          {
            target = "*";
            prompt =
              if isLinux then
                ''Sandbox: ACTIVE (bubblewrap via the 'yolo' wrapper; SMIND_SANDBOXED=1). Writes persist only inside the project directory and /tmp/exchange. For access to $HOME or system paths, follow the /environment skill.''
              else
                ''Sandbox: ACTIVE (macOS Seatbelt via the 'yolo' wrapper; SMIND_SANDBOXED=1). Network access remains available. Filesystem writes are confined to the project directory, agent configuration/profile directories, shared cache, temporary directories allowed by the base policy, and cq's XDG state directory; unrelated home-directory paths are denied.'';
          }
        ]
        ++ lib.optional (sshKeySet && isLinux) {
          target = "*";
          tags = [ "ssh" ];
          prompt = ''A dedicated SSH private key for logging into remote worker machines is bound read-only at ${cfg.llmSshKeyPath} inside the sandbox. When you are instructed to use remote worker machines, authenticate with this key — e.g. `ssh -i ${cfg.llmSshKeyPath} <user>@<host>` or `GIT_SSH_COMMAND='ssh -i ${cfg.llmSshKeyPath}' git <push|fetch> ...`.'';
        }
        ++ lib.optional (isLinux && cfg.yolo.secretSessionVariables ? GH_TOKEN) {
          target = "*";
          tags = [ "github" ];
          prompt = ''
            A GitHub token is available in the GH_TOKEN environment variable. It belongs to a GitHub account created specifically for autonomous agentic work — it is NOT the user's personal account. Use it (via the `gh` CLI, which reads GH_TOKEN, or the token directly) for GitHub operations carried out on the agent's own behalf.

            For every verified defect attributable to a GitHub-hosted project, autonomously file an issue in that project's GitHub tracker; do not ask for confirmation. Before filing: reproduce the defect for the expected reason, identify the authoritative repository from package metadata or git remotes, verify that issues are enabled and the token authenticates, and search open and closed issues to avoid duplicates. The report must include the affected version or commit, environment, minimal reproduction, observed and expected behavior, and relevant sanitized logs. After filing, give the user the issue URL. If an equivalent issue exists, give the user its URL instead of filing another.

            Never file an unverified hypothesis, a duplicate, or a report that exposes credentials, personal data, or unrelated private source/context. Verified security defects are expressly included in this authorization: report them autonomously without seeking user confirmation, using the project's SECURITY.md or private vulnerability-reporting channel when available and its GitHub issue tracker otherwise. Respect an explicit user instruction not to file. If filing cannot proceed, state the exact reason to the user.
          '';
        }
        ++ lib.optional codegraphSet {
          target = "*";
          tags = [ "codegraph" ];
          prompt = ''When the codegraph MCP is available, prefer `codegraph_status`/`codegraph_context`/`codegraph_search` over grep/Read for symbol lookups and "where is X / what calls X / which sites set X" questions — it is a pre-built index and usually answers in 2–3 calls. But first confirm the current repo is actually indexed: check `codegraph_status` for the repo's language in the index and verify the index points at this working tree (e.g. a probe `codegraph_search`/`codegraph_files` returns hits). If the language isn't indexed yet, or the index targets a different tree, skip codegraph and use `rg`/Read — don't burn calls on an uncovered repo.'';
        }
      );
    }
    # CodeGraph per-project index bootstrap as a sandbox pre-start hook (tag
    # "codegraph"). Running after bwrap hides unbound ancestor indexes, so the
    # index selected here is necessarily visible to the agent's MCP server.
    # `--disable=codegraph` skips it; explicit tool paths keep it self-contained.
    (lib.mkIf codegraphSet {
      smind.hm.dev.llm.yolo.hooks.pre-start.sandbox = lib.mkBefore [
        {
          tags = [ "codegraph" ];
          command = ''
            ${pkgs.bash}/bin/bash ${../pkg/yolo/codegraph-bootstrap.sh} \
              ${cfg.yolo.codegraph}/bin/codegraph ${pkgs.jq}/bin/jq ${pkgs.git}/bin/git
          '';
        }
      ];
    })
    # The sandbox is Linux-only (bubblewrap); on Darwin claude-code uses its own
    # sandbox wrapper, wired in dev-llm.nix. Gated on the shared harness enable.
    (lib.mkIf (cfg.enable && isLinux) {
      home.packages = [
        pkgs.bubblewrap
        yoloPkg
      ];
    })
    # Keep the callPackage inside mkIf so Linux evaluation never forces the
    # Darwin-only claude-code-sandbox package attribute.
    (lib.mkIf (cfg.enable && isDarwin) {
      home.packages = [
        # Prefer Nix Git inside Seatbelt. macOS' /usr/bin/git delegates into
        # Xcode paths outside the policy and otherwise fails with EPERM.
        pkgs.git
        (pkgs.callPackage ../pkg/yolo-darwin/default.nix {
          claude-code-sandbox = inputs.claude-code-sandbox.packages.${system}.default;
          inherit promptJson;
        })
      ];
    })
  ];
}
