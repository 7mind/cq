/**
 * XDG state-dir resolution for the primary store location.
 *
 * The primary ledger store is located under an XDG state directory,
 * with a consistent layout across all platforms (including macOS).
 *
 * Resolves to:
 *   $XDG_STATE_HOME ?? ~/.local/state
 *   └── cq/projects/<projectKey>/
 *       ├── state/
 *       └── logs/
 *
 * The projectKey is supplied as an input parameter (repo-identity keying
 * is a separate concern). Directory creation is lazy — triggered only on
 * first write via the bootstrap helper (not at module load).
 */

import { join, isAbsolute } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

/**
 * Resolve the base state directory for the ledger.
 *
 * Returns `$XDG_STATE_HOME/cq/projects/<projectKey>/` if XDG_STATE_HOME is set,
 * otherwise falls back to `~/.local/state/cq/projects/<projectKey>/`.
 *
 * This is pure path composition — no filesystem operations or directory creation.
 *
 * @param projectKey A stable identifier for the project (e.g. hash or slug)
 * @returns The base directory path (not created yet)
 */
export function resolveStateDirBase(projectKey: string): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const baseStateDir =
    xdgStateHome && xdgStateHome.trim() !== "" && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(homedir(), ".local", "state");

  return join(baseStateDir, "cq", "projects", projectKey);
}

/**
 * Layout constants for state and logs sub-areas within a project's base.
 *
 * Exported for reuse by the store, logs, and CLI modules.
 */
export const STORE_LAYOUT = {
  /**
   * Sub-directory name for ledger state (markdown files, sqlite database, etc.).
   * Relative to the project base.
   */
  state: "state" as const,

  /**
   * Sub-directory name for ledger logs (raw transcript JSONLs, markdown session logs, etc.).
   * Relative to the project base.
   */
  logs: "logs" as const,
} as const;

/**
 * Resolve the full path to the state sub-directory.
 *
 * @param projectKey A stable identifier for the project
 * @returns The state directory path (not created yet)
 */
export function resolveStateDir(projectKey: string): string {
  const base = resolveStateDirBase(projectKey);
  return join(base, STORE_LAYOUT.state);
}

/**
 * Resolve the full path to the logs sub-directory.
 *
 * @param projectKey A stable identifier for the project
 * @returns The logs directory path (not created yet)
 */
export function resolveLogsDir(projectKey: string): string {
  const base = resolveStateDirBase(projectKey);
  return join(base, STORE_LAYOUT.logs);
}

/**
 * Lazy bootstrap helper that ensures a directory exists.
 *
 * Creates the directory and all parent directories if they don't exist.
 * Called on first write to a location; not called at module load.
 *
 * @param dirPath The full path to create
 * @returns A promise that resolves when the directory is ready
 */
export async function ensureStateDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
