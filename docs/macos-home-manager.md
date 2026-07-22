# Install the cq harness on a new Mac with Home Manager

This guide installs the complete cq development harness on an **Apple Silicon
Mac** (`aarch64-darwin`):

- the `cq` ledger CLI, MCP server, TUI, and web UI;
- Claude Code, Codex, and Pi;
- the shared cq skills, commands, agents, and global context;
- the ledger and CodeGraph MCP servers;
- Claude Code's session and stop-gate hooks; and
- the macOS `yolo` wrapper, which confines agents with Seatbelt through
  `claude-code-sandbox`.

The flake currently publishes Darwin outputs only for `aarch64-darwin`. Intel
Macs (`x86_64-darwin`) are not supported by the top-level flake.

## 1. Prerequisites

Install Nix with flakes enabled. A multi-user Nix installation is recommended
on macOS. Confirm that it works:

```sh
nix --version
nix flake metadata nixpkgs
```

Use `nixpkgs-unstable` and Home Manager `master` together. The cq module uses
the recent `programs.claude-code`, `programs.codex`, and `programs.mcp` Home
Manager modules; Home Manager release branches that predate those modules will
fail with an `option ... does not exist` evaluation error.

If this Mac has no Home Manager configuration yet, create the directory:

```sh
mkdir -p ~/.config/home-manager
cd ~/.config/home-manager
```

## 2. Add the flake

Create `~/.config/home-manager/flake.nix`. Replace `YOUR_USER` in both files in
this guide with the macOS account name returned by `id -un`.

```nix
{
  description = "Home Manager configuration with the cq coding-agent harness";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    cq.url = "github:7mind/cq";
  };

  outputs =
    { nixpkgs, home-manager, cq, ... }:
    let
      system = "aarch64-darwin";
      username = "YOUR_USER";
      pkgs = import nixpkgs {
        inherit system;
        # Claude Code is unfree. Without this, evaluation fails before
        # Home Manager can build the activation package.
        config.allowUnfree = true;
      };
    in
    {
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          cq.homeManagerModules.dev-llm
          ./home.nix
        ];
      };
    };
}
```

The cq module is already curried over its own flake inputs, so this standalone
configuration does not need `extraSpecialArgs` or an overlay.

Create `~/.config/home-manager/home.nix`:

```nix
{ ... }:
{
  home.username = "YOUR_USER";
  home.homeDirectory = "/Users/YOUR_USER";

  # Set this once for a new configuration. Do not advance it merely because
  # Home Manager was updated; read the Home Manager release notes first.
  home.stateVersion = "26.05";
  programs.home-manager.enable = true;

  smind.hm.dev.llm = {
    enable = true;

    # Optional policy choices:
    fullscreenTui.enable = true;
    coAuthored.enable = true;

    # Pi normally exposes MCP servers through pi-mcp-adapter's compact `mcp`
    # proxy. Uncomment this to expose selected servers as direct Pi tools.
    # pi.mcpDirectTools = [ "ledger" ];
  };
}
```

Do not separately enable `programs.claude-code`, `programs.codex`, or
`programs.pi`; `smind.hm.dev.llm.enable = true` configures all three with the
versions and shared assets pinned by cq.

## 3. Build and activate

Build before activating so evaluation or package failures cannot alter the
active Home Manager generation:

```sh
cd ~/.config/home-manager
nix flake lock
nix build ".#homeConfigurations.$(id -un).activationPackage"
./result/activate
```

Subsequent updates can use:

```sh
home-manager switch --flake ~/.config/home-manager#"$(id -un)"
```

If `home-manager` is not yet on `PATH`, use the flake command once:

```sh
nix run home-manager/master -- switch \
  --flake ~/.config/home-manager#"$(id -un)"
```

The activation installs these commands on the Home Manager profile's `PATH`:

```text
cq  claude  codex  pi  yolo  codegraph  gh  node
```

It also materializes the shared configuration:

| Destination              | Installed content                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude/`             | settings, global `CLAUDE.md`, skills, `/cq:*` commands, cq agents, plugins, SessionStart hook, and stop-gate hook                 |
| `~/.codex/`              | settings, global `AGENTS.md`, skills, and cq prompt files                                                                         |
| `~/.pi/agent/`           | settings, global `AGENTS.md`, appended system prompt, skills, cq prompts and agents, Pi extensions, and MCP adapter configuration |
| `~/.config/mcp/mcp.json` | shared `ledger` and `codegraph` MCP server registry                                                                               |

The `ledger` server runs `cq mcp` in the agent's working directory, so one
global MCP declaration serves the ledger belonging to the current project.

## 4. Authenticate the agents

Run authentication from a project directory, not directly from `$HOME`.
The macOS `yolo` wrapper deliberately refuses to expose all of `$HOME` as its
writable working directory.

```sh
mkdir -p ~/src/example
cd ~/src/example
```

Authenticate Claude Code using its normal first-run flow:

```sh
yolo claude
# In Claude Code, use /login if it does not start authentication automatically.
```

Authenticate Codex. The wrapper configures file-backed credentials, including
for named profiles, before it launches the command:

```sh
yolo codex login
```

Pi defaults to the `openai-codex` provider. Authenticate the ChatGPT
subscription inside Pi:

```sh
yolo pi
# In Pi:
/login openai-codex
```

Pi installs its configured extension packages from npm on first use, so the
first launch requires network access and takes longer than later launches.
Other Pi providers remain selectable with `/login <provider>` and `/model`.
Provider API keys exported by the launching shell are inherited by the macOS
wrapper.

### Default and named yolo profiles

The default profile uses the native agent homes (`~/.claude`, `~/.codex`, and
`~/.pi`) and therefore reuses their authentication:

```sh
yolo claude
yolo codex
yolo pi
```

A named profile isolates writable agent state under
`~/.config/yolo/<profile>/`:

```sh
yolo --work claude                 # shorthand for --profile work
yolo --profile work codex login
yolo --profile experiment pi
```

Authenticate once inside each named profile. On its first launch, the wrapper
copies the immutable Home Manager-managed assets into that profile while
keeping authentication and mutable state profile-local. Copying is
copy-if-absent; after a Home Manager update, remove the affected named profile
and launch it again if that profile must receive newly generated assets:

```sh
rm -rf ~/.config/yolo/work
```

Do not remove the profile if it contains credentials or state that have not
been backed up.

## 5. Initialize a project ledger

The default XDG store needs a stable project identity. Use a full, non-shallow
Git repository with at least one commit, or set a stable
`[ledger].projectId` in an existing `cq.toml`. For a new repository:

```sh
cd ~/src/my-project
git init
git add .
git commit -m "Initial commit"
cq init
```

`cq init` creates the project's `cq.toml` and initializes the canonical ledger
set. The default `xdg` backend keeps the primary SQLite store out of the source
tree under the XDG state location (falling back to `~/.local/state/cq`). Commit
`cq.toml` if the project should share its cq model/panel and storage policy.
Do not use `--force` unless replacing an existing `cq.toml` is intentional.

Open a frontend when you need to inspect or answer ledger items:

```sh
cq tui
cq web                         # start the server, then open the printed URL
```

Then launch an agent in the same repository:

```sh
yolo claude
# or
yolo pi
```

The installed asset bundle supplies commands such as:

```text
/cq:plan <work description>
/cq:investigate <defect description>
/cq:plan:follow-up <goal id> <additional scope>
/cq:advance
```

Claude Code's managed stop hook calls `cq advance-gate` while `/cq:advance` is
active. It prevents a turn from stopping while actionable flow predicates
remain. The managed SessionStart hook injects the hostname into each Claude
session. Pi receives the corresponding cq flow integration through its prompt
and TypeScript extensions.

## 6. macOS yolo confinement model

On macOS, `yolo` uses Seatbelt through `claude-code-sandbox`; it does **not** use
Linux bubblewrap. Network access remains available. The generated policy:

- grants read/write access to the launch directory (`$PWD`), cq's XDG state
  directory, `~/.cache`, and all three agent configuration directories in the
  active profile;
- denies sibling named profiles and unrelated home-directory paths;
- retains the upstream base policy's runtime allowances, including temporary
  directories, Nix/system paths, and required macOS services; and
- sets `SMIND_SANDBOXED=1` for the child process.

Seatbelt path rules do not isolate individual macOS Keychain items. Named
profiles isolate file-backed state, and Claude uses profile-qualified Keychain
items, but all confined processes can still reach the Keychain service.

Examples:

```sh
cd ~/src/my-project
yolo claude
yolo pi
yolo shell
yolo cmd git status
yolo --disable=codegraph claude
```

`--disable=<tag>` suppresses matching prompt fragments on Darwin. Linux-only
resource controls—extra bind mounts, device passthrough, sandbox package sets,
pre-start hooks, and secret-file composition—do not apply to the Darwin
Seatbelt wrapper. Use native OAuth where possible and a macOS secret manager or
launch-shell environment for additional provider keys.

CodeGraph is installed on the host, but Darwin does not run the Linux yolo
pre-start indexing hook. Initialize an index manually when desired:

```sh
cd ~/src/my-project
codegraph init
```

## 7. Verify the installation

Run these checks after activation:

```sh
claude --version
codex --version
pi --version
cq --help || test "$?" -eq 2       # usage intentionally exits 2
yolo cmd pwd                       # run from a project directory

test -e ~/.claude/settings.json
test -e ~/.pi/agent/settings.json
test -e ~/.config/mcp/mcp.json
```

Verify the same package set and deterministic Darwin policy generation in the
cq flake itself. The `yolo cmd pwd` check above exercises live Seatbelt outside
Nix's own non-nestable Darwin sandbox:

```sh
nix build github:7mind/cq#cq
nix build github:7mind/cq#claude-code
nix build github:7mind/cq#pi-coding-agent
nix build github:7mind/cq#yolo-darwin
nix flake check github:7mind/cq
```

## 8. Update or roll back

Update the pinned inputs and activate a new generation:

```sh
cd ~/.config/home-manager
nix flake update cq nixpkgs home-manager
nix build ".#homeConfigurations.$(id -un).activationPackage"
home-manager switch --flake .#"$(id -un)"
```

Review the lock-file diff before activation. Home Manager keeps prior
generations, so a failed runtime change can be rolled back with the normal
Home Manager generation commands.

## Troubleshooting

### `The option programs.claude-code ... does not exist`

The configuration is using a Home Manager revision that predates the required
Claude Code or Codex module. Track `github:nix-community/home-manager/master`
and make it follow the same `nixpkgs` input as shown above.

### `Package 'claude-code-...' has an unfree license`

Import `nixpkgs` with `config.allowUnfree = true` in the `pkgs` passed to
`homeManagerConfiguration`.

### `does not provide attribute packages.x86_64-darwin`

The cq top-level flake currently supports Apple Silicon Darwin only. Use
`aarch64-darwin` on an Apple Silicon Mac.

### `refusing to run yolo-darwin from $HOME`

Change into a project subdirectory. `--unsafe-share-home` exists as an explicit
override, but it exposes the entire home directory through the writable `$PWD`
grant and defeats the intended isolation.

### `cq init` cannot resolve a project key

Use a full Git clone with at least one commit. For a shallow clone or a
non-Git project, create `cq.toml` and set a non-empty stable identifier:

```toml
[ledger]
projectId = "my-project"
```

Then run `cq init`. Keep that identifier committed and consistent across all
clones and worktrees.

### A named profile lacks newly installed skills or commands

Named-profile assets are copied only when absent. Back up any mutable state,
remove the affected `~/.config/yolo/<profile>` directory, and relaunch the
profile to copy the current Home Manager assets.
