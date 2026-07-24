import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

const SAFE_ROLE_ID_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const MANIFEST_FILENAME = "catalog.json";
const ROLE_ARTIFACTS_DIRECTORY = "roles";

export type PromptArtifactRoleKind = "dispatched-subagent" | "orchestrator-command";

export interface PromptArtifactRoleMetadata {
  readonly roleId: string;
  readonly roleKind: PromptArtifactRoleKind;
  readonly artifactPath: string;
  readonly sidecarSchemaRoleId: string | null;
}

export interface PromptArtifactManifest {
  readonly bytes: Uint8Array;
  readonly roles: readonly PromptArtifactRoleMetadata[];
}

export interface PromptRoleArtifact {
  readonly metadata: PromptArtifactRoleMetadata;
  readonly bytes: Uint8Array;
}

export interface PromptArtifactStore {
  readManifest(): PromptArtifactManifest;
  readRole(roleId: string): PromptRoleArtifact;
}

export interface InMemoryPromptRoleArtifact {
  readonly roleId: string;
  readonly bytes: Uint8Array;
}

export class PromptArtifactStoreError extends Error {
  constructor(pathLabel: string, detail: string) {
    super(`prompt artifact store: ${pathLabel}: ${detail}`);
    this.name = "PromptArtifactStoreError";
  }
}

export class PromptArtifactNotFoundError extends PromptArtifactStoreError {
  readonly roleId: string;

  constructor(roleId: string) {
    super(`roles.${roleId}`, "role is not declared by the manifest");
    this.name = "PromptArtifactNotFoundError";
    this.roleId = roleId;
  }
}

interface PromptArtifactSnapshot {
  readonly manifestBytes: Uint8Array;
  readonly roles: readonly PromptArtifactRoleMetadata[];
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function artifactPathFor(roleId: string): string {
  return path.posix.join(ROLE_ARTIFACTS_DIRECTORY, `${roleId}.md`);
}

function parseManifest(manifestBytes: Uint8Array): readonly PromptArtifactRoleMetadata[] {
  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    throw new PromptArtifactStoreError(MANIFEST_FILENAME, "expected valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(manifestText) as unknown;
  } catch {
    throw new PromptArtifactStoreError(MANIFEST_FILENAME, "expected valid JSON");
  }
  if (!Array.isArray(value)) {
    throw new PromptArtifactStoreError(MANIFEST_FILENAME, "expected an array");
  }

  const seenRoleIds = new Set<string>();
  const roles = value.map((candidate, index): PromptArtifactRoleMetadata => {
    const entryPath = `${MANIFEST_FILENAME}[${index}]`;
    if (!isRecord(candidate)) {
      throw new PromptArtifactStoreError(entryPath, "expected an object");
    }

    const roleId = candidate.roleId;
    if (typeof roleId !== "string" || !SAFE_ROLE_ID_PATTERN.test(roleId)) {
      throw new PromptArtifactStoreError(`${entryPath}.roleId`, "expected a safe role identifier");
    }
    if (seenRoleIds.has(roleId)) {
      throw new PromptArtifactStoreError(`${entryPath}.roleId`, `duplicate role "${roleId}"`);
    }
    seenRoleIds.add(roleId);

    const roleKind = candidate.roleKind;
    if (roleKind !== "dispatched-subagent" && roleKind !== "orchestrator-command") {
      throw new PromptArtifactStoreError(
        `${entryPath}.roleKind`,
        "expected dispatched-subagent or orchestrator-command",
      );
    }

    let sidecarSchemaRoleId: string | null;
    if (roleKind === "dispatched-subagent") {
      if (!isRecord(candidate.sidecar) || candidate.sidecar.schemaRoleId !== roleId) {
        throw new PromptArtifactStoreError(
          `${entryPath}.sidecar.schemaRoleId`,
          `expected "${roleId}"`,
        );
      }
      sidecarSchemaRoleId = roleId;
    } else {
      if (candidate.sidecar !== null) {
        throw new PromptArtifactStoreError(`${entryPath}.sidecar`, "expected null");
      }
      sidecarSchemaRoleId = null;
    }

    return Object.freeze({
      roleId,
      roleKind,
      artifactPath: artifactPathFor(roleId),
      sidecarSchemaRoleId,
    });
  });
  return Object.freeze(roles);
}

function buildSnapshot(
  manifestBytes: Uint8Array,
  inputArtifacts: readonly InMemoryPromptRoleArtifact[],
): PromptArtifactSnapshot {
  const roles = parseManifest(manifestBytes);
  const artifacts = new Map<string, Uint8Array>();
  for (const [index, artifact] of inputArtifacts.entries()) {
    if (!SAFE_ROLE_ID_PATTERN.test(artifact.roleId)) {
      throw new PromptArtifactStoreError(
        `artifacts[${index}].roleId`,
        "expected a safe role identifier",
      );
    }
    if (artifacts.has(artifact.roleId)) {
      throw new PromptArtifactStoreError(
        `artifacts[${index}].roleId`,
        `duplicate artifact "${artifact.roleId}"`,
      );
    }
    artifacts.set(artifact.roleId, copyBytes(artifact.bytes));
  }

  const declaredRoleIds = new Set(roles.map((role) => role.roleId));
  const missingRole = roles.find((role) => !artifacts.has(role.roleId));
  if (missingRole !== undefined) {
    throw new PromptArtifactStoreError(
      missingRole.artifactPath,
      `missing artifact for manifest role "${missingRole.roleId}"`,
    );
  }
  const extraRoleId = [...artifacts.keys()].sort().find((roleId) => !declaredRoleIds.has(roleId));
  if (extraRoleId !== undefined) {
    throw new PromptArtifactStoreError(
      artifactPathFor(extraRoleId),
      `artifact has no manifest role "${extraRoleId}"`,
    );
  }

  return Object.freeze({
    manifestBytes: copyBytes(manifestBytes),
    roles,
    artifacts,
  });
}

abstract class SnapshotPromptArtifactStore implements PromptArtifactStore {
  readonly #snapshot: PromptArtifactSnapshot;

  protected constructor(snapshot: PromptArtifactSnapshot) {
    this.#snapshot = snapshot;
  }

  readManifest(): PromptArtifactManifest {
    return Object.freeze({
      bytes: copyBytes(this.#snapshot.manifestBytes),
      roles: this.#snapshot.roles,
    });
  }

  readRole(roleId: string): PromptRoleArtifact {
    if (!SAFE_ROLE_ID_PATTERN.test(roleId)) {
      throw new PromptArtifactStoreError(
        `roles.${roleId}`,
        "expected a safe role identifier without traversal",
      );
    }
    const metadata = this.#snapshot.roles.find((role) => role.roleId === roleId);
    if (metadata === undefined) {
      throw new PromptArtifactNotFoundError(roleId);
    }
    const bytes = this.#snapshot.artifacts.get(roleId);
    if (bytes === undefined) {
      throw new PromptArtifactStoreError(
        metadata.artifactPath,
        `missing artifact for manifest role "${roleId}"`,
      );
    }
    return Object.freeze({ metadata, bytes: copyBytes(bytes) });
  }
}

export class InMemoryPromptArtifactStore extends SnapshotPromptArtifactStore {
  constructor(manifestBytes: Uint8Array, artifacts: readonly InMemoryPromptRoleArtifact[]) {
    super(buildSnapshot(manifestBytes, artifacts));
  }
}

function assertContained(root: string, candidate: string, pathLabel: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new PromptArtifactStoreError(pathLabel, "path escapes the prompt artifact root");
}

function resolveContainedPath(root: string, relativePath: string, pathLabel: string): string {
  const candidate = path.resolve(root, relativePath);
  assertContained(root, candidate, pathLabel);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new PromptArtifactStoreError(pathLabel, "path does not exist");
  }
  assertContained(root, resolved, pathLabel);
  return resolved;
}

function readContainedFile(root: string, relativePath: string, pathLabel: string): Uint8Array {
  const resolved = resolveContainedPath(root, relativePath, pathLabel);
  if (!statSync(resolved).isFile()) {
    throw new PromptArtifactStoreError(pathLabel, "expected a regular file");
  }
  return copyBytes(readFileSync(resolved));
}

function collectFilesystemArtifacts(root: string): readonly InMemoryPromptRoleArtifact[] {
  const rolesRoot = resolveContainedPath(root, ROLE_ARTIFACTS_DIRECTORY, ROLE_ARTIFACTS_DIRECTORY);
  if (!statSync(rolesRoot).isDirectory()) {
    throw new PromptArtifactStoreError(ROLE_ARTIFACTS_DIRECTORY, "expected a directory");
  }

  const artifacts: InMemoryPromptRoleArtifact[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath =
        relativeDirectory === "" ? entry.name : path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(absolutePath).isSymbolicLink()) {
        throw new PromptArtifactStoreError(
          path.posix.join(ROLE_ARTIFACTS_DIRECTORY, relativePath),
          "symbolic links are not role artifacts",
        );
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !relativePath.endsWith(".md")) {
        throw new PromptArtifactStoreError(
          path.posix.join(ROLE_ARTIFACTS_DIRECTORY, relativePath),
          "expected a markdown role artifact",
        );
      }
      const roleId = relativePath.slice(0, -".md".length);
      if (!SAFE_ROLE_ID_PATTERN.test(roleId)) {
        throw new PromptArtifactStoreError(
          path.posix.join(ROLE_ARTIFACTS_DIRECTORY, relativePath),
          "artifact path does not encode a safe role identifier",
        );
      }
      artifacts.push({ roleId, bytes: copyBytes(readFileSync(absolutePath)) });
    }
  };
  visit(rolesRoot, "");
  return artifacts;
}

export class FileSystemPromptArtifactStore extends SnapshotPromptArtifactStore {
  readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new PromptArtifactStoreError("root", "expected an absolute path");
    }
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(root);
    } catch {
      throw new PromptArtifactStoreError("root", "path does not exist");
    }
    if (!statSync(resolvedRoot).isDirectory()) {
      throw new PromptArtifactStoreError("root", "expected a directory");
    }
    const manifestBytes = readContainedFile(resolvedRoot, MANIFEST_FILENAME, MANIFEST_FILENAME);
    super(buildSnapshot(manifestBytes, collectFilesystemArtifacts(resolvedRoot)));
    this.root = resolvedRoot;
  }
}
