import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import { CQ_CONFIG_FILENAME, loadConfig } from "@cq/config";
import { ProjectKeyResolutionError, resolveProjectKey } from "../../projectKey.js";
import { isSafeProjectKey } from "../../projectKeySafety.js";
import { resolveDisplayName } from "../postgres/displayName.js";
import { openExistingLedgerDb } from "./connection.js";
import {
  SqliteXdgProjectIdentityAccess,
  type XdgProjectIdentity,
} from "./projectIdentity.js";
import {
  FilesystemXdgProjectCatalogSource,
  ReadOnlyXdgProjectCatalog,
  type XdgProjectCatalogResult,
  type XdgProjectCatalogSource,
  type XdgProjectStoreProbe,
  type XdgProjectCatalogCandidate,
} from "./xdgProjectCatalog.js";

export interface XdgProjectIdentityBackfillRequest {
  readonly projectsRoot: string;
  readonly checkoutRoots: readonly string[];
}

export interface ResolvedXdgCheckout {
  readonly checkoutRoot: string;
  readonly projectKey: string;
  readonly identity: XdgProjectIdentity;
}

export type XdgCheckoutResolution =
  | { readonly ok: true; readonly checkout: ResolvedXdgCheckout }
  | {
      readonly ok: false;
      readonly checkoutRoot: string;
      readonly code:
        | "stale-checkout"
        | "not-repository"
        | "unresolved-project-key"
        | "unreadable-checkout";
      readonly message: string;
    };

export interface XdgProjectIdentityBackfillAccess {
  resolveCheckout(checkoutRoot: string): Promise<XdgCheckoutResolution>;
  discoverProjects(projectsRoot: string): Promise<XdgProjectCatalogResult>;
  upsertProjectIdentity(
    projectsRoot: string,
    projectKey: string,
    identity: XdgProjectIdentity,
  ): Promise<boolean>;
}

export type XdgProjectIdentityBackfillDiagnosticCode =
  | "stale-checkout"
  | "not-repository"
  | "unresolved-project-key"
  | "unreadable-checkout"
  | "duplicate-checkout"
  | "unmatched-checkout"
  | "unmatched-project"
  | "write-failed";

export interface XdgProjectIdentityBackfillDiagnostic {
  readonly code: XdgProjectIdentityBackfillDiagnosticCode;
  readonly checkoutRoot: string | null;
  readonly projectKey: string | null;
  readonly message: string;
}

export interface XdgProjectIdentityBackfillProject {
  readonly projectKey: string;
  readonly repositoryPath: string;
  readonly displayName: string;
  readonly status: "updated" | "unchanged";
}

export interface XdgProjectIdentityBackfillResult {
  readonly projects: readonly XdgProjectIdentityBackfillProject[];
  readonly diagnostics: readonly XdgProjectIdentityBackfillDiagnostic[];
  readonly catalogDiagnostics: XdgProjectCatalogResult["diagnostics"];
}

export class XdgProjectIdentityBackfillBoundaryError extends Error {
  override readonly name = "XdgProjectIdentityBackfillBoundaryError";
}

export interface XdgProjectIdentityBackfillAccessEvent {
  readonly scope: "checkout" | "projects";
  readonly path: string;
}

export interface XdgProjectIdentityBackfillAccessObserver {
  record(event: XdgProjectIdentityBackfillAccessEvent): void;
}

const NOOP_ACCESS_OBSERVER: XdgProjectIdentityBackfillAccessObserver = {
  record(_event): void {},
};

/**
 * Backfill persisted identity only where a caller-supplied checkout resolves
 * to the key of a project that the read-only XDG catalog accepted.
 */
export class XdgProjectIdentityBackfill {
  constructor(private readonly access: XdgProjectIdentityBackfillAccess) {}

  async run(
    request: XdgProjectIdentityBackfillRequest,
  ): Promise<XdgProjectIdentityBackfillResult> {
    validateRequest(request);

    const diagnostics: XdgProjectIdentityBackfillDiagnostic[] = [];
    const resolved: ResolvedXdgCheckout[] = [];
    const sortedCheckoutRoots = [...request.checkoutRoots].sort(compareStrings);
    for (const checkoutRoot of sortedCheckoutRoots) {
      const resolution = await this.access.resolveCheckout(checkoutRoot);
      if (!resolution.ok) {
        diagnostics.push({
          code: resolution.code,
          checkoutRoot: resolution.checkoutRoot,
          projectKey: null,
          message: resolution.message,
        });
        continue;
      }
      resolved.push(resolution.checkout);
    }

    const winners = selectCheckoutWinners(resolved, diagnostics);
    const catalog = await this.access.discoverProjects(request.projectsRoot);
    const readableProjects = new Map(
      catalog.projects.map((project) => [project.key, project]),
    );

    for (const project of catalog.projects) {
      if (!winners.has(project.key)) {
        diagnostics.push({
          code: "unmatched-project",
          checkoutRoot: null,
          projectKey: project.key,
          message: `readable XDG project ${project.key} has no matching supplied checkout`,
        });
      }
    }

    const projects: XdgProjectIdentityBackfillProject[] = [];
    for (const [projectKey, checkout] of [...winners].sort(([left], [right]) =>
      compareStrings(left, right),
    )) {
      if (!readableProjects.has(projectKey)) {
        diagnostics.push({
          code: "unmatched-checkout",
          checkoutRoot: checkout.checkoutRoot,
          projectKey,
          message: `checkout resolves to ${projectKey}, which is not a readable XDG catalog entry`,
        });
        continue;
      }

      try {
        const updated = await this.access.upsertProjectIdentity(
          request.projectsRoot,
          projectKey,
          checkout.identity,
        );
        projects.push({
          projectKey,
          repositoryPath: checkout.identity.repositoryPath,
          displayName: checkout.identity.displayName,
          status: updated ? "updated" : "unchanged",
        });
      } catch (error) {
        diagnostics.push({
          code: "write-failed",
          checkoutRoot: checkout.checkoutRoot,
          projectKey,
          message: `identity write failed for ${projectKey}: ${errorMessage(error)}`,
        });
      }
    }

    diagnostics.sort(compareDiagnostics);
    return {
      projects,
      diagnostics,
      catalogDiagnostics: catalog.diagnostics,
    };
  }
}

/**
 * Production entry point. It has no discovery input other than the explicit
 * checkoutRoots array and the one XDG projects root.
 */
export async function backfillXdgProjectIdentities(
  request: XdgProjectIdentityBackfillRequest,
): Promise<XdgProjectIdentityBackfillResult> {
  const access = new FilesystemXdgProjectIdentityBackfillAccess(
    NOOP_ACCESS_OBSERVER,
  );
  return new XdgProjectIdentityBackfill(access).run(request);
}

export class FilesystemXdgProjectIdentityBackfillAccess
  implements XdgProjectIdentityBackfillAccess
{
  private readonly catalog: ReadOnlyXdgProjectCatalog;

  constructor(private readonly observer: XdgProjectIdentityBackfillAccessObserver) {
    const source = new ObservedCatalogSource(
      new FilesystemXdgProjectCatalogSource(),
      observer,
    );
    this.catalog = new ReadOnlyXdgProjectCatalog(source);
  }

  async resolveCheckout(checkoutRoot: string): Promise<XdgCheckoutResolution> {
    this.record("checkout", checkoutRoot);
    let checkoutInfo;
    try {
      checkoutInfo = await lstat(checkoutRoot);
    } catch (error) {
      return {
        ok: false,
        checkoutRoot,
        code: isMissingPathError(error) ? "stale-checkout" : "unreadable-checkout",
        message: isMissingPathError(error)
          ? `supplied checkout does not exist: ${checkoutRoot}`
          : `supplied checkout cannot be inspected: ${checkoutRoot}`,
      };
    }
    if (!checkoutInfo.isDirectory()) {
      return {
        ok: false,
        checkoutRoot,
        code: "not-repository",
        message: `supplied checkout is not a directory: ${checkoutRoot}`,
      };
    }

    let repositoryPath: string;
    try {
      repositoryPath = await realpath(checkoutRoot);
    } catch {
      return {
        ok: false,
        checkoutRoot,
        code: "unreadable-checkout",
        message: `supplied checkout cannot be resolved: ${checkoutRoot}`,
      };
    }
    this.record("checkout", repositoryPath);

    const gitMarker = path.join(repositoryPath, ".git");
    this.record("checkout", gitMarker);
    try {
      const gitInfo = await lstat(gitMarker);
      if (
        gitInfo.isSymbolicLink() ||
        (!gitInfo.isDirectory() && !gitInfo.isFile())
      ) {
        return notRepository(checkoutRoot);
      }
    } catch (error) {
      if (isMissingPathError(error)) return notRepository(checkoutRoot);
      return {
        ok: false,
        checkoutRoot,
        code: "unreadable-checkout",
        message: `checkout Git metadata cannot be inspected: ${checkoutRoot}`,
      };
    }

    this.record("checkout", path.join(repositoryPath, CQ_CONFIG_FILENAME));
    try {
      const config = loadConfig(repositoryPath);
      const projectId = config?.ledger?.projectId ?? null;
      const projectKey = await resolveProjectKey({
        repoRoot: repositoryPath,
        projectId,
      });
      const displayName = resolveDisplayName({
        projectName: config?.project?.name,
        projectId,
        repoBasename: path.basename(repositoryPath),
        projectKey,
      });
      return {
        ok: true,
        checkout: {
          checkoutRoot,
          projectKey,
          identity: { repositoryPath, displayName },
        },
      };
    } catch (error) {
      if (error instanceof ProjectKeyResolutionError) {
        return {
          ok: false,
          checkoutRoot,
          code: "unresolved-project-key",
          message: error.message,
        };
      }
      return {
        ok: false,
        checkoutRoot,
        code: "unreadable-checkout",
        message: `checkout configuration cannot be read: ${checkoutRoot}: ${errorMessage(error)}`,
      };
    }
  }

  discoverProjects(projectsRoot: string): Promise<XdgProjectCatalogResult> {
    return this.catalog.discover(projectsRoot);
  }

  async upsertProjectIdentity(
    projectsRoot: string,
    projectKey: string,
    identity: XdgProjectIdentity,
  ): Promise<boolean> {
    validateProjectKeySegment(projectKey);
    const projectDir = path.join(projectsRoot, projectKey);
    const stateDir = path.join(projectDir, "state");
    const dbPath = path.join(stateDir, "ledger.db");
    await this.requireWritePath(projectDir, "directory");
    await this.requireWritePath(stateDir, "directory");
    await this.requireWritePath(dbPath, "file");

    const db = openExistingLedgerDb(dbPath);
    try {
      return new SqliteXdgProjectIdentityAccess(db).upsertProjectIdentity(identity);
    } finally {
      db.close();
    }
  }

  private async requireWritePath(
    targetPath: string,
    expected: "directory" | "file",
  ): Promise<void> {
    this.record("projects", targetPath);
    const info = await lstat(targetPath);
    if (
      info.isSymbolicLink() ||
      (expected === "directory" ? !info.isDirectory() : !info.isFile())
    ) {
      throw new Error(`XDG identity write target is not a regular ${expected}: ${targetPath}`);
    }
  }

  private record(
    scope: XdgProjectIdentityBackfillAccessEvent["scope"],
    targetPath: string,
  ): void {
    this.observer.record({ scope, path: targetPath });
  }
}

class ObservedCatalogSource implements XdgProjectCatalogSource {
  constructor(
    private readonly source: XdgProjectCatalogSource,
    private readonly observer: XdgProjectIdentityBackfillAccessObserver,
  ) {}

  listImmediateChildren(
    projectsRoot: string,
  ): Promise<readonly XdgProjectCatalogCandidate[]> {
    this.observer.record({ scope: "projects", path: projectsRoot });
    return this.source.listImmediateChildren(projectsRoot);
  }

  probeProject(projectsRoot: string, key: string): Promise<XdgProjectStoreProbe> {
    this.observer.record({
      scope: "projects",
      path: path.join(projectsRoot, key),
    });
    return this.source.probeProject(projectsRoot, key);
  }
}

function validateRequest(request: XdgProjectIdentityBackfillRequest): void {
  if (!path.isAbsolute(request.projectsRoot)) {
    throw new XdgProjectIdentityBackfillBoundaryError(
      `XDG projects root must be absolute: ${request.projectsRoot}`,
    );
  }
  for (const checkoutRoot of request.checkoutRoots) {
    if (!path.isAbsolute(checkoutRoot)) {
      throw new XdgProjectIdentityBackfillBoundaryError(
        `checkout root must be absolute: ${checkoutRoot}`,
      );
    }
  }
}

function validateProjectKeySegment(projectKey: string): void {
  // D140: one source of truth with every other project-key gate — reject
  // backslash and NUL in addition to blank/dot-segment/slash forms.
  if (!isSafeProjectKey(projectKey)) {
    throw new XdgProjectIdentityBackfillBoundaryError(
      `XDG project key must be one non-blank path segment: ${projectKey}`,
    );
  }
}

function selectCheckoutWinners(
  checkouts: readonly ResolvedXdgCheckout[],
  diagnostics: XdgProjectIdentityBackfillDiagnostic[],
): Map<string, ResolvedXdgCheckout> {
  const groups = new Map<string, ResolvedXdgCheckout[]>();
  for (const checkout of checkouts) {
    const group = groups.get(checkout.projectKey);
    if (group === undefined) groups.set(checkout.projectKey, [checkout]);
    else group.push(checkout);
  }

  const winners = new Map<string, ResolvedXdgCheckout>();
  for (const [projectKey, group] of groups) {
    group.sort(compareCheckouts);
    const winner = group[0];
    if (winner === undefined) continue;
    winners.set(projectKey, winner);
    for (const duplicate of group.slice(1)) {
      diagnostics.push({
        code: "duplicate-checkout",
        checkoutRoot: duplicate.checkoutRoot,
        projectKey,
        message:
          `duplicate checkout for ${projectKey} skipped; deterministic winner is ` +
          winner.identity.repositoryPath,
      });
    }
  }
  return winners;
}

function compareCheckouts(
  left: ResolvedXdgCheckout,
  right: ResolvedXdgCheckout,
): number {
  return (
    compareStrings(left.identity.repositoryPath, right.identity.repositoryPath) ||
    compareStrings(left.identity.displayName, right.identity.displayName) ||
    compareStrings(left.checkoutRoot, right.checkoutRoot)
  );
}

function compareDiagnostics(
  left: XdgProjectIdentityBackfillDiagnostic,
  right: XdgProjectIdentityBackfillDiagnostic,
): number {
  return (
    compareStrings(left.code, right.code) ||
    compareStrings(left.projectKey ?? "", right.projectKey ?? "") ||
    compareStrings(left.checkoutRoot ?? "", right.checkoutRoot ?? "")
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function notRepository(checkoutRoot: string): XdgCheckoutResolution {
  return {
    ok: false,
    checkoutRoot,
    code: "not-repository",
    message: `supplied checkout is not a Git repository root: ${checkoutRoot}`,
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
