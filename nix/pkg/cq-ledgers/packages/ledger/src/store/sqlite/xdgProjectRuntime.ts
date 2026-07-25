import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "@cq/config";

import { resolveProjectKey } from "../../projectKey.js";
import { STORE_LAYOUT } from "../../stateDir.js";
import type { OnMutation } from "../LedgerStore.js";
import { SqliteLedgerStore } from "./SqliteLedgerStore.js";
import {
  FilesystemXdgProjectCatalogSource,
  validateXdgProjectStoreSnapshot,
} from "./xdgProjectCatalog.js";

const XDG_DB_FILENAME = "ledger.db";
const execFileAsync = promisify(execFile);

export interface OpenXdgProjectRuntimeOptions {
  readonly projectsRoot: string;
  readonly projectKey: string;
  readonly onMutation?: OnMutation;
}

export interface XdgProjectRuntime {
  readonly projectKey: string;
  readonly dbPath: string;
  readonly logsDir: string;
  /** Canonical matching repository root; absent when persisted provenance is invalid. */
  readonly configRoot?: string;
  readonly store: SqliteLedgerStore;
  dispose(): Promise<void>;
}

export class XdgProjectRuntimeLocationError extends Error {
  override readonly name = "XdgProjectRuntimeLocationError";
}

export async function openXdgProjectRuntime(
  options: OpenXdgProjectRuntimeOptions,
): Promise<XdgProjectRuntime> {
  const { projectsRoot, projectKey } = options;
  validateProjectsRoot(projectsRoot);
  validateProjectKey(projectKey);

  const normalizedRoot = path.resolve(projectsRoot);
  const projectDir = path.join(normalizedRoot, projectKey);
  const stateDir = path.join(projectDir, STORE_LAYOUT.state);
  const dbPath = path.join(stateDir, XDG_DB_FILENAME);
  const logsDir = path.join(projectDir, STORE_LAYOUT.logs);

  await validateLocations({
    projectsRoot: normalizedRoot,
    projectKey,
    projectDir,
    stateDir,
    dbPath,
    logsDir,
  });

  const catalogSource = new FilesystemXdgProjectCatalogSource();
  const probe = await catalogSource.probeProjectForRuntime(
    normalizedRoot,
    projectKey,
  );
  if (!probe.ok) {
    throw new XdgProjectRuntimeLocationError(
      `Project "${projectKey}" cannot be opened: ${probe.message}`,
    );
  }
  const diagnostic = validateXdgProjectStoreSnapshot(projectKey, probe.snapshot);
  if (diagnostic !== null) {
    throw new XdgProjectRuntimeLocationError(
      `Project "${projectKey}" cannot be opened: ${diagnostic}`,
    );
  }
  const configRoot = await recoverConfigRoot(
    probe.snapshot.identity,
    projectKey,
  );

  await validateWritableLocations(stateDir, dbPath, logsDir);

  const store = new SqliteLedgerStore({
    dbPath,
    logsDir,
    ...(options.onMutation === undefined ? {} : { onMutation: options.onMutation }),
  });
  try {
    await store.init();
  } catch (error) {
    await store.dispose();
    throw error;
  }

  let disposal: Promise<void> | null = null;
  return {
    projectKey,
    dbPath,
    logsDir,
    ...(configRoot === undefined ? {} : { configRoot }),
    store,
    dispose(): Promise<void> {
      disposal ??= store.dispose();
      return disposal;
    },
  };
}

async function recoverConfigRoot(
  identity: { readonly repositoryPath: string } | null,
  projectKey: string,
): Promise<string | undefined> {
  if (
    identity === null ||
    !path.isAbsolute(identity.repositoryPath)
  ) {
    return undefined;
  }
  try {
    const canonicalRoot = await realpath(identity.repositoryPath);
    const rootStat = await lstat(canonicalRoot);
    if (!rootStat.isDirectory()) return undefined;
    const gitStat = await lstat(path.join(canonicalRoot, ".git"));
    if (
      gitStat.isSymbolicLink() ||
      (!gitStat.isDirectory() && !gitStat.isFile())
    ) {
      return undefined;
    }
    const insideWorkTree = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: canonicalRoot, encoding: "utf8" },
    );
    if (insideWorkTree.stdout.trim() !== "true") return undefined;
    const workTree = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: canonicalRoot, encoding: "utf8" },
    );
    const canonicalWorkTree = await realpath(workTree.stdout.trim());
    if (canonicalWorkTree !== canonicalRoot) return undefined;
    const config = loadConfig(canonicalRoot);
    const resolvedProjectKey = await resolveProjectKey({
      repoRoot: canonicalRoot,
      projectId: config?.ledger?.projectId ?? null,
    });
    return resolvedProjectKey === projectKey ? canonicalRoot : undefined;
  } catch {
    // Invalid provenance disables only repository-rooted capabilities.
    return undefined;
  }
}

interface RuntimeLocations {
  readonly projectsRoot: string;
  readonly projectKey: string;
  readonly projectDir: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly logsDir: string;
}

async function validateLocations(locations: RuntimeLocations): Promise<void> {
  const rootStat = await requiredLstat(locations.projectsRoot, "projects root");
  const projectStat = await requiredLstat(locations.projectDir, "project directory");
  const stateStat = await requiredLstat(locations.stateDir, "state directory");
  const dbStat = await requiredLstat(locations.dbPath, "ledger database");
  const logsStat = await optionalLstat(locations.logsDir, "logs directory");

  requireDirectory(rootStat, locations.projectsRoot, "projects root");
  requireDirectory(projectStat, locations.projectDir, "project directory");
  requireDirectory(stateStat, locations.stateDir, "state directory");
  requireRegularFile(dbStat, locations.dbPath, "ledger database");
  if (logsStat !== null) {
    requireDirectory(logsStat, locations.logsDir, "logs directory");
  }

  const rootReal = await requiredRealpath(locations.projectsRoot, "projects root");
  const projectReal = await requiredRealpath(locations.projectDir, "project directory");
  const stateReal = await requiredRealpath(locations.stateDir, "state directory");
  const dbReal = await requiredRealpath(locations.dbPath, "ledger database");
  const logsReal =
    logsStat === null
      ? null
      : await requiredRealpath(locations.logsDir, "logs directory");

  requireDirectChild(projectReal, rootReal, locations.projectKey, "project directory");
  requireDirectChild(stateReal, projectReal, STORE_LAYOUT.state, "state directory");
  requireDirectChild(dbReal, stateReal, XDG_DB_FILENAME, "ledger database");
  if (logsReal !== null) {
    requireDirectChild(logsReal, projectReal, STORE_LAYOUT.logs, "logs directory");
  }
}

async function validateWritableLocations(
  stateDir: string,
  dbPath: string,
  logsDir: string,
): Promise<void> {
  await requiredAccess(
    stateDir,
    fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
    "state directory",
  );
  const logsStat = await optionalLstat(logsDir, "logs directory");
  if (logsStat !== null) {
    await requiredAccess(
      logsDir,
      fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
      "logs directory",
    );
  }

  let dbHandle: FileHandle | null = null;
  try {
    dbHandle = await open(dbPath, fsConstants.O_RDWR | noFollowFlag());
    const stat = await dbHandle.stat();
    if (!stat.isFile()) {
      throw new XdgProjectRuntimeLocationError(
        `ledger database is not a regular file: ${dbPath}`,
      );
    }
  } catch (error) {
    if (error instanceof XdgProjectRuntimeLocationError) {
      throw error;
    }
    throw locationError("ledger database is not writable", dbPath, error);
  } finally {
    if (dbHandle !== null) {
      await dbHandle.close();
    }
  }
}

function validateProjectsRoot(projectsRoot: string): void {
  if (!path.isAbsolute(projectsRoot)) {
    throw new XdgProjectRuntimeLocationError(
      `projectsRoot must be absolute: ${projectsRoot}`,
    );
  }
}

/**
 * A single project-key safety predicate shared across both layered defenses:
 * this filesystem-level runtime (second defense, T832) and the route-level
 * decoded-key guard ahead of catalog lookup (first defense, T836's
 * `matchSafeXdgProjectRoute` and `createStaticXdgHostCatalog` in
 * `@cq/ledger-web`, which call this predicate directly). Keeping one copy
 * prevents the two layers from silently drifting apart on what counts as
 * unsafe.
 */
export function isSafeProjectKey(projectKey: string): boolean {
  return !(
    projectKey.length === 0 ||
    projectKey.trim().length === 0 ||
    projectKey === "." ||
    projectKey === ".." ||
    path.posix.isAbsolute(projectKey) ||
    path.win32.isAbsolute(projectKey) ||
    projectKey.includes("/") ||
    projectKey.includes("\\") ||
    projectKey.includes("\0")
  );
}

function validateProjectKey(projectKey: string): void {
  if (!isSafeProjectKey(projectKey)) {
    throw new XdgProjectRuntimeLocationError(
      `Invalid project key: ${JSON.stringify(projectKey)}`,
    );
  }
}

async function requiredLstat(
  target: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(target);
  } catch (error) {
    throw locationError(`${label} is unavailable`, target, error);
  }
}

async function optionalLstat(
  target: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw locationError(`${label} is unavailable`, target, error);
  }
}

async function requiredRealpath(target: string, label: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    throw locationError(`${label} cannot be resolved`, target, error);
  }
}

async function requiredAccess(target: string, mode: number, label: string): Promise<void> {
  try {
    await access(target, mode);
  } catch (error) {
    throw locationError(`${label} is not readable and writable`, target, error);
  }
}

function requireDirectory(
  stat: Awaited<ReturnType<typeof lstat>>,
  target: string,
  label: string,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new XdgProjectRuntimeLocationError(
      `${label} must be a directory and not a symbolic link: ${target}`,
    );
  }
}

function requireRegularFile(
  stat: Awaited<ReturnType<typeof lstat>>,
  target: string,
  label: string,
): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new XdgProjectRuntimeLocationError(
      `${label} must be a regular file and not a symbolic link: ${target}`,
    );
  }
}

function requireDirectChild(
  childReal: string,
  parentReal: string,
  childName: string,
  label: string,
): void {
  if (path.dirname(childReal) !== parentReal || path.basename(childReal) !== childName) {
    throw new XdgProjectRuntimeLocationError(
      `${label} escapes its expected parent: ${childReal}`,
    );
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
}

function locationError(message: string, target: string, cause: unknown): Error {
  return new XdgProjectRuntimeLocationError(
    `${message}: ${target}: ${errorMessage(cause)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
