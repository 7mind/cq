# Runbook — migrate live ledger storage projection `docs/` → `.cq/`

> **⚠ REQUIRES USER EXECUTION during a maintenance window — the agent does NOT
> run this live.** The running ledger MCP server holds the storage directory
> open (advisory lockfiles, in-memory store), exactly as in the T415 constraint.
> The live move is a **redeploy-gated user action**. This document is the
> precise procedure; performing it is the operator's responsibility.

This repo's *deployed* ledger server predates the `docs/` → `.cq/` storage
rename (G58, T443–T449). The code on `main` now uses `.cq/` as the storage
projection directory (`LEDGER_STORAGE_DIRNAME = ".cq"`,
`packages/ledger/src/constants.ts`), but that build is **not yet deployed**.
This runbook migrates the *running deployment* once the new build is live.

Scope note: the deliverable migrates the **working-tree storage projection**.
For **this repo** (git-object backend) the authoritative ledger data is NOT in
the working tree at all — see §2.

---

## 1. Preconditions — deploy the `.cq` build FIRST

The migration must NOT begin until a `cq` / `ledger-mcp` binary built from
`main` is deployed. That binary must include the **entire** `docs/` → `.cq/`
rename:

- **G58 (T443–T449)** — the storage-dirname rename across the code,
  comments, CLAUDE.md, and cq-assets prompts.
- **D71 / G61** — the restore-subsystem (cache-mirror) fix. **This may still
  be in flight.** The migration MUST wait until D71/G61 is merged into `main`
  **and** included in the deployed build. Do not migrate against a build that
  predates the restore-subsystem fix.

Deploy step (this repo's mechanism):

```sh
# from the repo root
nix build .#cq
home-manager switch    # or the operator's actual deploy/activation mechanism
```

Confirm the deployed binary is the new one before proceeding (e.g. compare the
activated store path / version against the `main` build, or run a known new
subcommand).

---

## 2. What "migration" means under THIS repo's backend (git-object)

This repo sets, in `cq.toml`:

```toml
[ledger]
   backend = "git-object"
```

Consequences for the migration:

- **The ledger LIVES on the orphan ref `refs/heads/cq-ledger`.** Its internal
  tree layout has **no `docs/` prefix** — `ledgers.yaml`, each `<ledger>.md`,
  `archive/**`, and `logs/**` sit at the **ref-tree root**. Verified:

  ```sh
  git ls-tree --name-only refs/heads/cq-ledger
  # archive  decisions.md  defects.md  goals.md  handoffs.md  hypothesis.md
  # ideas.md  ledgers.yaml  logs  milestones.md  questions.md  reviews.md  tasks.md
  ```

  **Therefore NO orphan-ref rewrite is required.** The data is already
  path-prefix-agnostic; the rename only affects the *working-tree projection
  directory name*.

- **The git-object backend does NOT project the `.md` ledger files to the
  working tree.** Every mutation advances the orphan ref by one commit
  (blob → scratch-index tree → `commit-tree` → CAS `update-ref`) **without a
  checkout**; reads come from the in-memory store hydrated via
  `git cat-file` / `ls-tree` at `init()`
  (`packages/ledger/src/store/git/GitObjectLedgerBackend.ts`). The working
  tree, index, and HEAD stay byte-identical and `git status` stays clean.
  What the backend *does* write under the working-tree storage dir:
  - `.cq/.locks/` — advisory runtime lockfiles (gitignored, never in the
    orphan tree).
  - `.cq/ledgers.yaml` — the per-cwd registry, written by `registry.ts`
    (`./.cq/ledgers.yaml`), regenerated on connect.

  > The stale `docs/*.md` files currently on disk are **leftover working-tree
  > artifacts** from the pre-rename deployment's projection (they are
  > gitignored — `git ls-files docs/` returns nothing). They are NOT the source
  > of truth and can be removed safely. After restart the new build will not
  > recreate `docs/*.md` ledger files; it manages `.cq/` instead.

- **Session logs:** committed logs live in the orphan ref's `logs/` subtree
  (unchanged by this migration). Any working-tree `docs/logs/` copy is stale;
  the new build manages logs under `.cq/logs/` where applicable.

- **The managed `.gitignore` block self-migrates.** On the next startup the
  new build calls `ensureGitBackendGitignore`
  (`packages/ledger/src/store/gitBackendGitignore.ts`), which detects the
  stale marker-guarded block (the `docs/…` entries) and **replaces it in place**
  with the `.cq/…` entries (`<storage>/*.md`, `<storage>/ledgers.yaml`,
  `<storage>/.locks/`, `<storage>/logs/`). No manual `.gitignore` edit is
  needed. The current (stale) block, for reference:

  ```gitignore
  # cq git-object ledger backend (managed) — do not edit
  docs/*.md
  docs/ledgers.yaml
  docs/.locks/
  docs/logs/
  # cq git-object ledger backend (managed) — end
  ```

  After restart it becomes the `.cq/…` variant automatically.

---

## 3. Ordered procedure — git-object backend (THIS repo)

> Operator runs every step. The agent must not run these live (the server holds
> the storage dir open).

**(a) Confirm the new build is deployed** (per §1). Do not proceed otherwise.

**(b) STOP the running ledger MCP server.** Stop every process that has the
storage dir open — the standalone MCP server and any embedded host (TUI / web).
Embedded TUI/web co-host the MCP server in-process, so closing those clients
also releases the dir. Confirm no `cq mcp` / ledger server process remains and
that `.cq/.locks/` (and stale `docs/.locks/`) hold no live lock for this cwd.

**(c) Remove the STALE working-tree `docs/` ledger projection.** These are
gitignored runtime artifacts, so removal does not change tracked files:

```sh
# from the repo root — KEEP docs/drafts/ and any non-ledger docs/
rm -f  docs/*.md
rm -f  docs/ledgers.yaml
rm -rf docs/.locks/ docs/.backup/ docs/.ledger-backup/
rm -rf docs/logs/        # working-tree projection only; committed logs live on the orphan ref
```

Do **not** touch `docs/drafts/` (project docs, tracked) or any other
non-ledger content under `docs/`. If after this `docs/` contains only
`docs/drafts/` (and other intentional non-ledger docs), you are done with
cleanup.

**(d) RESTART the server pointed at the SAME `--cwd` (the repo root).** On
startup the new build:
- runs `ensureGitBackendGitignore` → self-migrates the managed `.gitignore`
  block `docs/…` → `.cq/…` (§2);
- hydrates the in-memory store from the orphan ref via `git cat-file`/`ls-tree`;
- creates `.cq/` and writes the regenerated `.cq/ledgers.yaml` registry +
  `.cq/.locks/` as needed.

**(e) VERIFY:**

```sh
ls -a .cq/
# Expect (git-object): ledgers.yaml + .locks/  (and .cq/logs/ if FS logs are used).
# NOTE: under git-object the per-ledger <ledger>.md files are NOT projected to
# .cq/ — they live ONLY on the orphan ref. Confirm the DATA via the server:
#   the MCP server / TUI / web enumerates the SAME ledger items as before
#   (e.g. fetch_ledger tasks, enumerate_ledgers — counts match pre-migration).

git ls-tree --name-only refs/heads/cq-ledger   # unchanged: root-level tree, no docs/ prefix

ls docs/                # docs/drafts/ still present; no ledger *.md / ledgers.yaml

grep -A5 'cq git-object ledger backend (managed)' .gitignore
# block now lists .cq/*.md, .cq/ledgers.yaml, .cq/.locks/, .cq/logs/

git status --short      # clean for the ledger projection (.cq/ is gitignored)
```

The decisive verification is **item parity**: the server must enumerate the
same ledgers and the same item counts/contents as before the migration
(because the orphan ref — the source of truth — was never touched).

---

## 4. fs-backend variant (other repos / completeness)

For a repo using `backend = "fs"` (the default), the ledger `.md` files +
`ledgers.yaml` + `archive/` + `logs/` ARE tracked under the storage dir, so the
migration is a tracked `git mv` (preserving history), done with the server
stopped:

```sh
# (a) confirm the new .cq build is deployed (§1)
# (b) STOP the server (§3b)
# (c) move the TRACKED ledger projection docs/ -> .cq/
mkdir -p .cq
git mv docs/ledgers.yaml .cq/ledgers.yaml
# each per-ledger file, e.g.:
git mv docs/tasks.md      .cq/tasks.md
git mv docs/defects.md    .cq/defects.md
git mv docs/milestones.md .cq/milestones.md
# ...and every other docs/<name>.md ledger file...
git mv docs/archive       .cq/archive
git mv docs/logs          .cq/logs       # if the fs log backend committed logs under docs/logs/

# discard EPHEMERAL runtime dirs (recreated on startup) — KEEP docs/drafts/:
rm -rf docs/.locks docs/.backup docs/.ledger-backup

# (d) RESTART the server at the same --cwd
# (e) VERIFY:
ls .cq/                 # ledgers.yaml + <ledger>.md + archive/ + logs/
ls docs/                # docs/drafts/ still present
git status --short      # the renames staged as R (rename), drafts untouched
# server enumerates the SAME items as before; commit the rename when satisfied.
```

> Dry-run validated: the `git mv` sequence above (registry, per-ledger `.md`,
> `archive/`, `logs/`) was exercised against a throwaway fixture repo in a temp
> dir. Result: all moves staged as `R` renames, `docs/.locks` + `docs/.backup`
> staged as deletions, and `docs/drafts/note.md` was preserved. The live
> `docs/` was not touched.

Unlike git-object, the fs backend DOES project `.md` files to `.cq/`, so the
`ls .cq/` check in §4(e) legitimately expects the per-ledger `.md` files.

---

## 5. Rollback

If verification fails, the migration is reversible with no data loss:

- **git-object (this repo):** the orphan ref `refs/heads/cq-ledger` is the
  source of truth and is **never modified** by this migration — so there is no
  data to lose. To revert: **re-deploy the prior (pre-`.cq`) binary**
  (`home-manager switch` to the previous generation, or rebuild the prior
  commit) and restart. The old build re-projects to `docs/` and rewrites the
  managed `.gitignore` block back to `docs/…` on startup. The removed stale
  `docs/*.md` working-tree files are inconsequential (they were gitignored
  projections, not data). No `git revert` of ledger data is needed.

- **fs-backend:** the `git mv` renames are staged but not committed until you
  choose to commit. To revert before committing: `git restore --staged .cq docs`
  then `git checkout -- .` (or `git mv` the files back). If already committed:
  `git revert <migration-commit>` restores the `docs/` layout, then re-deploy
  the prior binary and restart.

In both cases the safe rollback primitive is: **stop server → re-deploy prior
binary → restart**, because the canonical ledger data (orphan ref for
git-object; committed `git mv` history for fs) is never destructively rewritten.
