/**
 * createLedgerStore — the SINGLE backend-selecting store factory (T357 / G43).
 *
 * Every store construction site in the running products (ledger-mcp's
 * `createEmbeddedStore()` + `main()`, cq-cli's `runInit()` / `runReset()`)
 * routes through this factory so the `[ledger]` backend choice in cq.toml is
 * honoured in EXACTLY one place:
 *
 *   - `backend = 'fs'` (the default, and the case when no cq.toml exists) →
 *     {@link FsLedgerStore}. Byte-identical to the historical behaviour.
 *   - `backend = 'git-object'` → {@link GitObjectLedgerBackend}, after a
 *     fail-fast validation of the git environment (git on PATH + the root is
 *     inside a git work tree) and an idempotent install of the git-backend
 *     `.gitignore` block (so a fresh ledger is never accidentally tracked).
 *
 * The factory `init()`s the returned store before handing it back, mirroring the
 * historical `new FsLedgerStore(); await store.init()` pattern at each site.
 *
 * This lives in `@cq/ledger` (not ledger-mcp) because BOTH ledger-mcp and cq-cli
 * already depend on `@cq/ledger`; cq-cli does not depend on ledger-mcp, so a
 * shared low-level home avoids pulling the MCP transport into the CLI.
 */

import { execFileSync } from "node:child_process";
import { loadConfig, type LedgerBackend } from "@cq/config";
import type { LedgerStore } from "./LedgerStore.js";
import { FsLedgerStore } from "./FsLedgerStore.js";
import { GitObjectLedgerBackend } from "./git/GitObjectLedgerBackend.js";
import { ensureGitBackendGitignore } from "./gitBackendGitignore.js";

/** Default branch/remote when no cq.toml `[ledger]` table is present. */
const DEFAULT_BRANCH = "cq-ledger";

/**
 * The resolved storage backend for a root, plus the branch the git-object
 * backend operates on (the `[ledger].branch`, default `cq-ledger`). Returned
 * alongside the store so the construction site can select the matching
 * coherence watcher (file-watch for fs, ref-sha-watch for git-object).
 */
export interface ResolvedLedgerStore {
  /** The initialised store (FsLedgerStore or GitObjectLedgerBackend). */
  readonly store: LedgerStore;
  /** The resolved backend identifier. */
  readonly backend: LedgerBackend;
  /** The orphan-ref branch (git-object only; the default otherwise). */
  readonly branch: string;
}

/**
 * Thrown when `backend = 'git-object'` is configured but the git environment is
 * not usable from `root` — git absent from PATH, or `root` not inside a git
 * work tree. A fail-fast at startup with a clear, actionable message.
 */
export class GitEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitEnvironmentError";
  }
}

/**
 * Resolve the `[ledger]` backend for `root` from cq.toml. No cq.toml (or no
 * `[ledger]` table) → `'fs'`, matching {@link loadConfig}'s contract and the
 * historical default.
 */
export function resolveLedgerBackend(root: string): { backend: LedgerBackend; branch: string } {
  const config = loadConfig(root);
  if (config === null || config.ledger === null) {
    return { backend: "fs", branch: DEFAULT_BRANCH };
  }
  return { backend: config.ledger.backend, branch: config.ledger.branch };
}

/**
 * Validate the git environment for the git-object backend, FAILING FAST with a
 * clear {@link GitEnvironmentError} when git is unavailable or `root` is not
 * inside a git work tree. Uses synchronous `git rev-parse --is-inside-work-tree`
 * (git resolves work-tree / GIT_DIR indirection itself) so the check is a single
 * cheap call before any store is constructed.
 */
export function assertGitWorkTree(root: string): void {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GitEnvironmentError(
      `[ledger] backend = 'git-object' requires a git work tree at ${root}, ` +
        `but \`git rev-parse --is-inside-work-tree\` failed ` +
        `(git missing from PATH or not a git repository): ${detail}`,
    );
  }
  if (out !== "true") {
    throw new GitEnvironmentError(
      `[ledger] backend = 'git-object' requires ${root} to be inside a git work tree, ` +
        `but \`git rev-parse --is-inside-work-tree\` returned "${out}".`,
    );
  }
}

/**
 * Construct and initialise the ledger store selected by cq.toml's `[ledger]`
 * backend at `root`. The ONE backend-selection site for the running products.
 *
 * For `git-object`: validates the git environment (fail-fast) and installs the
 * idempotent git-backend `.gitignore` block BEFORE constructing the store, so a
 * fresh git-object ledger's `.cq/` is gitignored from the first write.
 *
 * The store is `init()`-ed before return (mirrors every historical call site).
 */
export async function createLedgerStore(root: string): Promise<ResolvedLedgerStore> {
  const { backend, branch } = resolveLedgerBackend(root);

  if (backend === "git-object") {
    assertGitWorkTree(root);
    await ensureGitBackendGitignore(root);
    const store = new GitObjectLedgerBackend({ repoRoot: root, ref: branch });
    await store.init();
    return { store, backend, branch };
  }

  // backend === 'fs' — byte-identical to the historical default.
  const store = new FsLedgerStore({ root });
  await store.init();
  return { store, backend, branch };
}
