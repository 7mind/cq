# yolo-darwin — macOS environment-separated LLM tool launcher

`yolo-darwin` is the macOS equivalent of the Linux `yolo` bubblewrap sandbox. It provides per-profile isolation of Claude Code, Codex, and pi configurations, settings, plugins, and credentials on a single macOS user account, using the Seatbelt (sandbox-exec) sandbox instead of bubblewrap.

## Quick start

Launch an isolated Claude Code session from a project directory (not your home directory):

```bash
yolo claude
```

With a named profile (e.g., "work"):

```bash
yolo --profile work claude
```

Or using the `--work` alias:

```bash
yolo --work claude
```

## Subcommands

All subcommands are confined and profile-isolated. Choose the agent and any arguments:

- `yolo claude [args...]` — Launch Claude Code with optional arguments passed to `claude` (e.g., `yolo claude --settings <file>`).
- `yolo codex [args...]` — Launch Codex with optional arguments (e.g., `yolo codex --search`).
- `yolo pi [args...]` — Launch pi, the Anthropic coding agent (e.g., `yolo pi chat`).
- `yolo shell [args...]` — Start an interactive shell confined within the sandbox, with the active profile's environment variables.
- `yolo cmd <program> [args...]` — Execute an arbitrary program confined within the sandbox (e.g., `yolo cmd git status`).

All agents inherit the active profile's configuration directories (when set).

## Flags and profiles

### Profile selection

Profiles isolate each agent's configuration, credentials, and session history under `~/.config/yolo/<name>/<agent>`. The default (no profile) uses the agents' real home directories (`~/.claude`, `~/.codex`, `~/.pi`).

- `--profile NAME` or `-p NAME` — Select a named profile. The profile name must contain only letters, digits, `.`, `_`, `-`, and cannot be `.` or `..`. Each agent (claude, codex, pi) gets a private directory under `~/.config/yolo/<name>/`.
- `--work` or `-w` — Shorthand for `--profile work`. Useful for launching a "work" profile with minimal typing.

Example:

```bash
mkdir -p ~/.config/yolo/personal ~/.config/yolo/work  # optional; created automatically
yolo --profile personal claude
yolo --work codex --search
```

### Feature suppression

- `--disable=TAG` — Exclude prompt fragments carrying `TAG`. Repeatable and comma-separated, matching Linux `yolo` parsing.

```bash
yolo --disable=gpu,ssh --disable=github claude
```

### Working directory safety

By default, `yolo-darwin` refuses to launch from your home directory (`$HOME`) because the sandbox grants read-write access to `$PWD`. Launching from `$HOME` would expose every credential, key, and shell history in your home directory, defeating profile isolation.

- `--unsafe-share-home` — Opt out of the `$PWD == $HOME` refusal. Use this flag only if you understand the security implications and want to operate from your home directory. Equivalent to `cd` into a subdirectory first and running without the flag.

### Environment variables

Pass arbitrary environment variables into the confined agent:

- `--env KEY=VAL` — Set an environment variable `KEY` to `VAL` inside the sandbox. Repeatable. The `KEY` must be a valid POSIX environment-variable name (starting with a letter or underscore, followed by letters, digits, or underscores). These variables are applied **only** to the agent's exec environment, not to the launcher's own environment or command-line arguments.

Example:

```bash
yolo --env RUST_BACKTRACE=1 --env DEBUG=true claude
```

## Profile directory layout

When you select a named profile (e.g., `--profile work`), `yolo-darwin` creates and isolates directories for each agent:

```
~/.config/yolo/work/
├── claude/           # CLAUDE_CONFIG_DIR when --profile work
│   ├── settings.json
│   ├── .claude.json
│   ├── projects/
│   ├── plugins/
│   └── ...
├── codex/            # CODEX_HOME when --profile work
│   ├── config.toml
│   ├── prompts/
│   ├── skills/
│   ├── auth.json
│   ├── sessions/
│   └── ...
└── pi/               # PI_CODING_AGENT_DIR when --profile work
    ├── settings.json
    ├── APPEND_SYSTEM.md
    ├── cq-agents/
    ├── prompts/
    ├── skills/
    ├── auth.json
    ├── sessions/
    └── ...
```

Each directory is created with `chmod 700` (read-write-execute for the owner only).

All three agents get the home-manager-managed shared assets **copied** into their profile directory on launch (claude: settings.json, CLAUDE.md, skills, plugins, commands, agents; codex: AGENTS.md, prompts, skills; pi: settings.json, AGENTS.md, APPEND_SYSTEM.md, cq-agents, prompts, skills, extensions, mcp.json). The copies are dereferenced and self-contained (no symlinks back into the sandbox-denied real homes) and are copy-if-absent: an existing file in the profile directory is never overwritten, so HM changes only propagate into a profile directory that is recreated.

The default profile (empty, no `--profile` flag) does NOT create any directories. Agents use their real home directories:
- Claude Code reads/writes `~/.claude/` and `~/.claude.json`.
- Codex reads/writes `~/.codex/`.
- pi reads/writes `~/.pi/`.

## Confinement model

`yolo-darwin` uses macOS Seatbelt (sandbox-exec) to confine each agent. For each launch, a per-launch Seatbelt profile (SBPL) is generated and applied via `claude-code-sandbox --use-profile`.

### What is confined

Read-write access is granted only to:
- **The working directory** (`$PWD`) — where you launched `yolo`.
- **`~/.cache`** — cache directory shared across profiles.
- **This profile's configuration directories** (when a named profile is active) — only the active profile's `~/.config/yolo/<name>/claude`, `~/.config/yolo/<name>/codex`, `~/.config/yolo/<name>/pi` directories are accessible; sibling profiles are explicitly denied.

Read-only access is granted to system files required to run the agent:
- `/usr`, `/bin`, `/opt` (executables and libraries).
- `/nix` (Nix store packages).
- `~/.config/git`, `~/.gitconfig`, `~/.config/jj` (version control configuration).
- `~/.nix-profile`, `~/.config/nix`, `~/.local/share/nix` (Nix configuration).
- `~/.config/gh` (GitHub CLI configuration).
- System configuration: `/etc`, `/var`, `/System`, and essential service files.

### What is NOT confined

- **Network** — All network access is allowed (parity with `claude-code-sandbox noread.sb`). Agents can make API calls without restriction.
- **The rest of your home directory** — Everything outside the working directory and the active profile's directories is denied. In particular, if you use the default profile, agents have read-write access to their real `~/.claude`, `~/.codex`, `~/.pi` directories but are denied all other home directories.

### Credential isolation

When using a named profile, the Seatbelt profile implements credential isolation by:
1. Denying access to the entire `~/.config/yolo` tree by default.
2. Re-granting read-write access **only** to the active profile's subdirectories (e.g., `~/.config/yolo/work/claude`, `~/.config/yolo/work/codex`, `~/.config/yolo/work/pi`).

This isolates file-backed credentials and session state. Claude Code's native credentials remain in the user's shared macOS Keychain database; `CLAUDE_CONFIG_DIR` makes Claude Code select a profile-specific Keychain item, but Seatbelt path rules do not isolate individual Keychain items by service name.

## Per-profile authentication setup

Each named profile requires one-time manual setup so that Claude Code, Codex, and pi each authenticate independently.

### Claude Code — native per-profile login

Claude Code scopes its macOS Keychain credential to `CLAUDE_CONFIG_DIR`. Authenticate each named profile directly:

```bash
yolo --profile work claude
```

Run `/login` and complete the browser flow with the intended subscription account. Claude Code stores the credential in a profile-specific Keychain item whose name starts with `Claude Code-credentials-`; subsequent launches with the same profile reuse that credential. The default profile continues to use the unsuffixed `Claude Code-credentials` item.

### Codex — file-based credentials

Codex stores subscription and MCP OAuth credentials. For profile isolation, configure each profile's `config.toml` to use file-based credential storage instead of the shared macOS Keychain:

1. **Create a profile directory and config**:

   ```bash
   mkdir -p ~/.config/yolo/work/codex
   chmod 700 ~/.config/yolo/work/codex
   ```

2. **Create or edit `~/.config/yolo/work/codex/config.toml`** and add the following at the top (before any table headers):

   ```toml
   cli_auth_credentials_store = "file"
   mcp_oauth_credentials_store = "file"
   ```

   This tells Codex to store subscription credentials in `auth.json` and MCP OAuth tokens in files within the profile's directory, not in the shared macOS Keychain.

3. **Launch Codex and authenticate**:

   ```bash
   yolo --profile work codex login
   ```

   Complete the authentication flow. Codex stores the credentials in `~/.config/yolo/work/codex/auth.json` (treat this as a secret file).

4. **Each profile is now independently authenticated**. Subsequent launches use the stored credentials from that profile's `auth.json`.

**Important**: Do not select `keyring` or `auto` for `cli_auth_credentials_store` if you need profile-isolated credentials independent of the shared Keychain. Use `file` explicitly.

### pi — automatic per-profile state isolation

pi (the Anthropic coding agent) exposes a configuration-directory environment variable, `PI_CODING_AGENT_DIR`. When you use a named profile, `yolo-darwin` automatically:

1. Sets `PI_CODING_AGENT_DIR` to the profile's pi directory (e.g., `~/.config/yolo/work/pi`).
2. Copies the HM-managed shared assets (settings.json, AGENTS.md, APPEND_SYSTEM.md, cq-agents, prompts, skills, extensions, mcp.json) from your main pi installation (`~/.pi/agent/`) into the profile directory, so it is self-contained (the real `~/.pi` stays denied by the sandbox).

This means:
- Each profile's pi instance has its own `auth.json`, sessions, trust store, and npm packages.
- Shared assets (like skill definitions) are copied in on first launch; existing files are never overwritten, so HM updates reach a profile only when its directory is recreated.

To authenticate pi in a named profile:

```bash
yolo --profile work pi login
```

Complete the authentication flow. The credentials are stored in `~/.config/yolo/work/pi/auth.json`, automatically isolated from other profiles.

## Runtime behavior and environment

When an agent runs under `yolo-darwin`:

- **Profile environment variables** (e.g., `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`) are set only for named profiles and applied **before** explicit `--env KEY=VAL` pairs, so an explicit flag overrides a profile default.
- **`--env KEY=VAL` pairs** are applied to the agent process **only**, not to the launcher itself, and not visible in the command-line arguments of the spawned process.

## Manual macOS verification checklist

The launcher's SBPL profile generation, the per-profile `~/.config/yolo/<name>/<agent>` directory layout (created `700`), the `$PWD==$HOME` guard, and `$PWD` sandbox confinement are covered **automatically** by the nix flake checks — `yolo-darwin-profile` (all systems) and `yolo-darwin-confinement` (macOS) — so they are not repeated here.

The steps below are the remaining runtime behaviors a Mac-less CI cannot exercise: real account/credential resolution, session isolation across a live agent, and OAuth refresh. Run them on a Mac using an actual test repository.

For each profile you set up (e.g., "personal" and "work"):

1. **Start from a test repository** — `cd` into a project directory on your Mac (not your home directory).

2. **Launch the first profile and inspect the active account**:

   ```bash
   yolo --profile personal claude /status
   ```

   or

   ```bash
   yolo --work codex status
   ```

   Confirm that the account shown matches the subscription or user account you configured for that profile (e.g., "personal@example.com").

3. **Verify session isolation** — after a real session, confirm the live agent state (sessions, logs, credentials) landed only under this profile's `~/.config/yolo/personal/claude/` (or `codex`/`pi`) and does NOT appear in another profile's dir. (The dirs themselves — one per agent, mode `700` — are already asserted by the `yolo-darwin-profile` flake test; this step confirms a real agent actually writes its session there.)

   ```bash
   ls -la ~/.config/yolo/personal/claude/
   ```

4. **Launch the second profile**:

   ```bash
   yolo --profile work claude /status
   ```

   Confirm that this shows a **different** account than the first profile. Verify that its session directory (`~/.config/yolo/work/claude/`) is separate.

5. **Restart both profiles and confirm account retention** — Close both agents and relaunch each profile:

   ```bash
   yolo --profile personal claude /status
   yolo --profile work claude /status
   ```

   Each should still show its original account. If you see the wrong account, check:
   - For Claude Code: Did you run `/login` separately inside each named profile?
   - For Codex: Is the profile's `config.toml` using `cli_auth_credentials_store = "file"`?
   - For pi: Is the `auth.json` in the correct profile directory?

6. **For Claude Code, re-test after OAuth refresh** — If you wait long enough (hours to days), Claude Code may refresh its OAuth token. Restart Claude Code after a refresh and confirm that it still shows the correct account for the profile. This verifies that the native profile-specific credential remains associated with the intended account.

   **Timing note**: Token refresh is automatic and depends on the token's age and usage. You may not observe a refresh during a single session; this step is optional but recommended for long-running environments.

(Sandbox confinement — that a read outside `$PWD` / of a sibling profile's dir is denied — is verified automatically by the `yolo-darwin-confinement` flake check on macOS; it is no longer a manual step.)

## Environment variable precedence

When launching `yolo-darwin`, environment variable precedence is:

1. **Profile environment variables** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`) — applied first.
2. **Agent-specific environment variables** (e.g., `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code) — applied second.
3. **Explicit `--env KEY=VAL` pairs** — applied last, so they override both profile and agent-specific values.

Example: If a profile sets `RUST_BACKTRACE=0` but you pass `--env RUST_BACKTRACE=1`, the agent receives `RUST_BACKTRACE=1`.

## Troubleshooting

### "Error: refusing to run yolo-darwin from $HOME"

The launcher detected that your working directory is your home directory. Sandboxing from `$HOME` would expose all your credentials. Solution:

```bash
cd ~/projects/my-project
yolo claude
```

Or, if you truly want to operate from your home directory, explicitly opt out:

```bash
cd ~
yolo --unsafe-share-home claude
```

### Claude Code shows the wrong account after a profile switch

For the default (no-profile) case, Claude Code uses the shared macOS Keychain credential. If you previously logged in with a different account, that credential may persist. Solution:

1. Use a named profile and run `/login` inside it (see "Claude Code — native per-profile login" above).
2. Or, open Claude Code's settings and sign out from `/login`, then sign back in with the desired account.

### Codex login fails or shows the wrong account

Ensure the profile's `config.toml` file exists and includes the file-based credential-store settings:

```bash
cat ~/.config/yolo/work/codex/config.toml
# Should include:
# cli_auth_credentials_store = "file"
# mcp_oauth_credentials_store = "file"
```

If you see `keyring` or another value, edit the file to change these settings, then try logging in again:

```bash
yolo --profile work codex login
```

### pi complains about missing configuration or sessions

Verify that the profile directory and shared assets are in place:

```bash
ls -la ~/.config/yolo/work/pi/
# Should include copies: settings.json, AGENTS.md, APPEND_SYSTEM.md, cq-agents,
# prompts, skills, extensions, mcp.json
```

If the copies are missing, recreate the profile directory and restart pi:

```bash
rm -rf ~/.config/yolo/work/pi
yolo --profile work pi login
```

### Sandbox permission denied on a file I need

The sandbox grants read-write access only to the working directory, `~/.cache`, and (for named profiles) the active profile's directories. If you need access to another path:

1. Copy or symlink it into your working directory.
2. Or, run the agent without a profile (`yolo claude`) to use the default configuration (but lose profile isolation).
3. Or, use the `/environment` skill to temporarily break out of the sandbox and fetch the file.

## See also

- `yolo-darwin.sh` — The launcher script and its internal implementation details.
- `nix/hm/yolo.nix` — The home-manager module that configures the launcher.
