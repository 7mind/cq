# Claude Code configuration for the LLM coding-agent harness, split out of
# dev-llm.nix. Configures the (downstream-provided) `programs.claude-code`
# module; the shared asset bundles / MCP registry / merged views come from the
# sibling tools.nix via `smind.hm.dev.llm.{enable,merged.*,…}`.
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.smind.hm.dev.llm;

  codexPluginCc = pkgs.fetchFromGitHub {
    owner = "openai";
    repo = "codex-plugin-cc";
    rev = "6a5c2ba53b734f3cdd8daacbd49f68f3e6c8c167";
    hash = "sha256-4kqtfdHlcg3YXWX1og9b5JuLgnB/3Nj5dFMe4Ryt7No=";
  };

  # claude-code pinned to the local native-tarball build (../pkg/claude-code),
  # built directly so the module does not depend on a consumer overlay.
  #
  # claudeExecpathFixed: nixpkgs' claude-code runs its inner binary via
  # `exec ld.so --library-path … inner`, so Node's process.execPath is the
  # dynamic loader. Claude exports that as CLAUDE_CODE_EXECPATH, and the
  # grep/find shims it writes into its shell snapshot then invoke `ld.so -G …`
  # / `ld.so -S …` → "error while loading shared libraries: -G". Fix: make the
  # inner binary self-contained (real glibc interp + rpath, taken from the
  # wrapper's own --library-path so the glibc always matches) and exec it
  # DIRECTLY, so execPath is the real binary and the bundled ugrep/bfs
  # multiplex (keyed on argv0) works. Verified: `exec -a ugrep <inner> -G …`
  # greps correctly once run directly.
  claudeBase = pkgs.callPackage ../pkg/claude-code/package.nix { };
  claudeExecpathFixed = claudeBase.overrideAttrs (old: {
    nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.patchelf ];
    postFixup = (old.postFixup or "") + ''
      inner="$out/libexec/claude-code/claude"
      if [ ! -e "$inner" ]; then
        echo "claudeExecpathFixed: inner binary missing at $inner" >&2; exit 1
      fi
      wrapper=""
      for w in "$out"/bin/*; do
        if [ -f "$w" ] && grep -qE 'ld-linux.*libexec/claude-code/claude' "$w"; then
          wrapper="$w"; break
        fi
      done
      if [ -z "$wrapper" ]; then
        echo "claudeExecpathFixed: no loader-indirection wrapper found" >&2; exit 1
      fi
      glibclib="$(grep -oE '/nix/store/[^ "]*-glibc-[^ "]*/lib' "$wrapper" | head -1)"
      if [ -z "$glibclib" ]; then
        echo "claudeExecpathFixed: could not determine glibc lib path" >&2; exit 1
      fi
      patchelf --set-interpreter "$glibclib/ld-linux-x86-64.so.2" --set-rpath "$glibclib" "$inner"
      for w in "$out"/bin/*; do
        [ -f "$w" ] && grep -qE 'ld-linux.*libexec/claude-code/claude' "$w" || continue
        grep -v -E '^exec .*ld-linux.*libexec/claude-code/claude' "$w" > "$w.tmp"
        printf 'exec -a "$0" %s "$@"\n' "$inner" >> "$w.tmp"
        chmod --reference="$w" "$w.tmp" 2>/dev/null || chmod +x "$w.tmp"
        mv "$w.tmp" "$w"
        if grep -qE 'ld-linux.*libexec/claude-code/claude' "$w"; then
          echo "claudeExecpathFixed: failed to rewrite $w" >&2; exit 1
        fi
      done
    '';
  });

  # SessionStart hook: surfaces the hostname on every session boot. Claude
  # Code's injected environment block lists OS/shell/cwd but not hostname, so
  # without this the model guesses (and tends to assume the wrong host). Sandbox
  # state is no longer reported here — it is a yolo concern, declared as a yolo
  # promptExtension (the "Sandbox: ACTIVE …" note in nix/hm/yolo.nix) which is
  # injected exactly when running under the wrapper that sets SMIND_SANDBOXED.
  claudeSessionStartHook = pkgs.writeShellScript "claude-session-start-context" ''
    set -eu
    HOST="''${HOSTNAME:-$(hostname 2>/dev/null || echo unknown)}"
    printf '%s\n' \
      'Runtime environment (injected by SessionStart hook):' \
      "- Hostname: $HOST. Use this exact value where CLAUDE.md or scripts reference the current host; do not rely on \$HOSTNAME (zsh, the user's login shell, does not export it)."
  '';

  # Wiring common to every skill-aware harness: enable it, feed the shared
  # programs.mcp registry, install the merged skill set, and the shared memory
  # text. Spread with `//` into the programs.claude-code block (no key overlap).
  sharedAgentWiring = {
    enable = true;
    enableMcpIntegration = true;
    skills = cfg.merged.skills;
    context = cfg.merged.memoryText;
  };
in
{
  config = lib.mkIf cfg.enable {
    programs.claude-code = sharedAgentWiring // {
      # Bake DISABLE_AUTOUPDATER into the wrapper so it survives downstream
      # wrappers (yolo, bubblewrap, fresh-env exec) and Claude Code can't
      # self-update past the nix pin.
      package = pkgs.symlinkJoin {
        name = "claude-code-no-autoupdate";
        paths = [ claudeExecpathFixed ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/claude --set-default DISABLE_AUTOUPDATER 1
        '';
      };
      plugins = [ "${codexPluginCc}/plugins/codex" ];
      # Bundle-contributed commands/agents via the native options: keys
      # like "plan/advance" land at ~/.claude/commands/plan/advance.md
      # (slash command /plan:advance); agents at ~/.claude/agents/<name>.md.
      commands = cfg.merged.commands;
      agents = cfg.merged.agents;
      settings = {
        alwaysThinkingEnabled = true;
        theme = "dark";
        # Workaround for Claude Code 2.1.83+ regression where sandbox
        # detection fails even when bubblewrap/socat are on PATH (the
        # error reads "sandbox required but unavailable: ${j$}").
        sandbox = {
          failIfUnavailable = false;
        };
        tui = lib.mkIf cfg.fullscreenTui.enable "fullscreen";
        permissions = {
          allow = [ "Edit(/tmp/**)" ];
          # defaultMode = "bypassPermissions";  # commented out: this controls *permission prompts* (file edits etc.), not the AskUserQuestion tool
          # Disable the AskUserQuestion tool (the interactive multiple-choice "ask user" / question UI).
          # Tool name from https://code.claude.com/docs/en/tools-reference ; see also GitHub #10258.
          deny = [ "AskUserQuestion" ];
        };
        includeCoAuthoredBy = cfg.coAuthored.enable;
        attribution = lib.mkIf (!cfg.coAuthored.enable) { commit = ""; pr = ""; };
        effortLevel = "high";
        model = "claude-opus-4-8[1m]";
        spinnerVerbs = {
          mode = "replace";
          verbs = [ "Working" ];
        };
        hooks = {
          # Inject hostname + sandbox state into every session. See
          # claudeSessionStartHook above for rationale.
          SessionStart = [
            {
              matcher = "*";
              hooks = [
                {
                  type = "command";
                  command = "${claudeSessionStartHook}";
                }
              ];
            }
          ];
        };
        statusLine = {
          "type" = "command";
          "command" = ''
            CLAUDE_ACCOUNT="$(${pkgs.jq}/bin/jq -r '
              .oauthAccount.emailAddress //
              .oauthAccount.email //
              .oauthAccount.account.emailAddress //
              .oauthAccount.account.email //
              .oauthAccount.name //
              .oauthAccount.displayName //
              .oauthAccount.accountName //
              .account.emailAddress //
              .account.email //
              .account.name //
              empty
            ' "$HOME/.claude.json" 2>/dev/null)"
            if [ -z "$CLAUDE_ACCOUNT" ]; then
              CLAUDE_ACCOUNT="unknown-claude-account"
            fi
            printf '\033[2m\033[35m%s \033[0m\033[2m\033[37m%s \033[0m\033[2m@ %s \033[0m\033[2m\033[36min \033[1m\033[36m%s\033[0m' "$CLAUDE_ACCOUNT" "$(whoami)" "$(hostname -s)" "$(pwd | sed "s|^$HOME|~|")"
          '';
        };
      };
    };

    # Mirror the HM-managed Claude settings + memory to a `.claude-work` profile
    # path so the yolo `--work`/`--profile work` namespace re-shares them.
    home.file.".claude-work/settings.json".source =
      config.home.file."${config.programs.claude-code.configDir}/settings.json".source;
    home.file.".claude-work/CLAUDE.md".source =
      config.home.file."${config.programs.claude-code.configDir}/CLAUDE.md".source;
  };
}
