import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { isPromptSurface, type PromptSurface } from "./promptCatalog.js";
import {
  PROMPT_SURFACE_MANIFEST_FIELDS,
  PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS,
  serializePromptSurfaceManifest,
  serializePromptSurfaceManifestCore,
  type PromptSurfaceRoleAttestation,
} from "./promptRenderer.js";

const SAFE_ROLE_ID_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface PackagedPromptSurfaceRoleArtifact {
  /** POSIX path relative to the root's `roles/` directory. */
  readonly path: string;
  /** Exact artifact bytes. Strings denote their UTF-8 encoding. */
  readonly content: string | Uint8Array;
}

export interface PackagedPromptSurfaceSchemaArtifact {
  /** POSIX path relative to the root's `schemas/` directory. */
  readonly path: string;
  /** Exact artifact bytes. Strings denote their UTF-8 encoding. */
  readonly content: string | Uint8Array;
}

export interface PackagedPromptSurfaceInput {
  /** Kept as a string so boundary callers receive a deterministic validation error. */
  readonly expectedSurface: string;
  /** Exact installed UTF-8 bytes of `catalog.json`. */
  readonly catalogJson: string;
  /** Exact installed UTF-8 bytes of `surface.json`. */
  readonly surfaceJson: string;
  /** Complete file closure below the installed `roles/` directory. */
  readonly roleArtifacts: readonly PackagedPromptSurfaceRoleArtifact[];
  /** Complete file closure below the installed `schemas/` directory (D190). */
  readonly schemaArtifacts: readonly PackagedPromptSurfaceSchemaArtifact[];
}

interface CatalogRoleAttestation {
  readonly roleId: string;
  readonly hasSidecar: boolean;
}

/** Deterministic packaged-surface boundary failure. */
export class PackagedPromptSurfaceError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PackagedPromptSurfaceError";
  }
}

function fail(path: string, detail: string): never {
  throw new PackagedPromptSurfaceError(path, detail);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFields(actual: readonly string[], expected: readonly string[]): boolean {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return (
    sortedActual.length === sortedExpected.length &&
    sortedActual.every((field, index) => field === sortedExpected[index])
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCatalog(catalogJson: string): readonly CatalogRoleAttestation[] {
  let value: unknown;
  try {
    value = JSON.parse(catalogJson) as unknown;
  } catch {
    fail("catalog.json", "expected valid JSON");
  }
  if (!Array.isArray(value)) {
    fail("catalog.json", "expected an ordered role array");
  }

  const roles: CatalogRoleAttestation[] = [];
  const roleIds = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const rolePath = `catalog.json[${index}]`;
    if (!isRecord(candidate)) {
      fail(rolePath, "expected an object");
    }
    const roleId = candidate.roleId;
    if (typeof roleId !== "string" || !SAFE_ROLE_ID_PATTERN.test(roleId)) {
      fail(`${rolePath}.roleId`, "expected a safe role identifier");
    }
    if (roleIds.has(roleId)) {
      fail(`${rolePath}.roleId`, `duplicate role "${roleId}"`);
    }
    roleIds.add(roleId);

    const sidecar = candidate.sidecar;
    const hasSidecar = sidecar !== null;
    if (hasSidecar) {
      if (
        !isRecord(sidecar) ||
        !sameFields(Object.keys(sidecar), ["schemaRoleId"]) ||
        sidecar.schemaRoleId !== roleId
      ) {
        fail(`${rolePath}.sidecar`, `expected exactly schemaRoleId "${roleId}"`);
      }
    }
    roles.push({ roleId, hasSidecar });
  }
  return roles;
}

function indexRelativeArtifacts(
  artifacts: readonly { readonly path: string; readonly content: string | Uint8Array }[],
  label: string,
): ReadonlyMap<string, string | Uint8Array> {
  const indexed = new Map<string, string | Uint8Array>();
  for (const [index, artifact] of artifacts.entries()) {
    const artifactPath = artifact.path;
    if (
      artifactPath.length === 0 ||
      path.posix.isAbsolute(artifactPath) ||
      artifactPath.includes("\\") ||
      artifactPath
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      fail(`${label}[${index}].path`, "expected a safe relative POSIX path");
    }
    if (indexed.has(artifactPath)) {
      fail(`${label}[${index}].path`, `duplicate artifact "${artifactPath}"`);
    }
    indexed.set(artifactPath, artifact.content);
  }
  return indexed;
}

function assertExactRoleClosure(
  catalogRoles: readonly CatalogRoleAttestation[],
  artifacts: ReadonlyMap<string, string | Uint8Array>,
): void {
  const expectedPaths = catalogRoles.map(({ roleId }) => `${roleId}.md`);
  const missingPath = expectedPaths.find((artifactPath) => !artifacts.has(artifactPath));
  if (missingPath !== undefined) {
    fail("roles", `missing role artifact "${missingPath}"`);
  }
  const extraPath = [...artifacts.keys()]
    .sort()
    .find((artifactPath) => !expectedPaths.includes(artifactPath));
  if (extraPath !== undefined) {
    fail("roles", `undeclared role artifact "${extraPath}"`);
  }
}

function assertExactSchemaClosure(
  catalogRoles: readonly CatalogRoleAttestation[],
  artifacts: ReadonlyMap<string, string | Uint8Array>,
): void {
  const expectedPaths = catalogRoles
    .filter((role) => role.hasSidecar)
    .map(({ roleId }) => `${roleId}.json`);
  const missingPath = expectedPaths.find((artifactPath) => !artifacts.has(artifactPath));
  if (missingPath !== undefined) {
    fail("schemas", `missing schema artifact "${missingPath}"`);
  }
  const extraPath = [...artifacts.keys()]
    .sort()
    .find((artifactPath) => !expectedPaths.includes(artifactPath));
  if (extraPath !== undefined) {
    fail("schemas", `undeclared schema artifact "${extraPath}"`);
  }
  for (const role of catalogRoles) {
    if (role.hasSidecar) {
      continue;
    }
    if (artifacts.has(`${role.roleId}.json`)) {
      fail("schemas", `orchestrator-command role must not ship schema artifact "${role.roleId}.json"`);
    }
  }
}

function parseManifest(surfaceJson: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(surfaceJson) as unknown;
  } catch {
    fail("surface.json", "expected valid JSON");
  }
  if (!isRecord(value)) {
    fail("surface.json", "expected an object");
  }
  if (!sameFields(Object.keys(value), PROMPT_SURFACE_MANIFEST_FIELDS)) {
    fail(
      "surface.json",
      "expected exactly surface, catalogMetadataHash, roles, and surfaceDigest",
    );
  }
  return value;
}

/**
 * Validate one packaged prompt surface against its own installed bytes.
 *
 * The exact closure applies below `roles/` and `schemas/`. Surface-specific
 * siblings such as Pi's `role-tool-profiles.json` remain outside this
 * attestation contract.
 */
export function validatePackagedPromptSurface(input: PackagedPromptSurfaceInput): void {
  if (!isPromptSurface(input.expectedSurface)) {
    fail("expectedSurface", "expected claude, codex, or pi");
  }
  const expectedSurface: PromptSurface = input.expectedSurface;
  const catalogRoles = parseCatalog(input.catalogJson);
  const artifacts = indexRelativeArtifacts(input.roleArtifacts, "roleArtifacts");
  assertExactRoleClosure(catalogRoles, artifacts);
  const schemaArtifacts = indexRelativeArtifacts(input.schemaArtifacts, "schemaArtifacts");
  assertExactSchemaClosure(catalogRoles, schemaArtifacts);
  const manifest = parseManifest(input.surfaceJson);

  if (manifest.surface !== expectedSurface) {
    fail("surface.json.surface", `expected "${expectedSurface}"`);
  }
  const catalogMetadataHash = manifest.catalogMetadataHash;
  if (typeof catalogMetadataHash !== "string" || !SHA256_PATTERN.test(catalogMetadataHash)) {
    fail("surface.json.catalogMetadataHash", "expected a lowercase hex SHA-256 digest");
  }
  if (catalogMetadataHash !== sha256(input.catalogJson)) {
    fail(
      "surface.json.catalogMetadataHash",
      "does not match the installed catalog.json bytes",
    );
  }
  if (!Array.isArray(manifest.roles)) {
    fail("surface.json.roles", "expected an array");
  }
  if (manifest.roles.length !== catalogRoles.length) {
    fail("surface.json.roles", `expected ${catalogRoles.length} role attestations`);
  }

  const validatedRoles: PromptSurfaceRoleAttestation[] = [];
  for (const [index, catalogRole] of catalogRoles.entries()) {
    const candidate = manifest.roles[index];
    const rolePath = `surface.json.roles[${index}]`;
    if (!isRecord(candidate)) {
      fail(rolePath, "expected an object");
    }
    if (!sameFields(Object.keys(candidate), PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS)) {
      fail(rolePath, "expected exactly roleId, version, sha256, and schemaSha256");
    }
    if (candidate.roleId !== catalogRole.roleId) {
      fail(
        `${rolePath}.roleId`,
        `expected "${catalogRole.roleId}" in canonical catalog order`,
      );
    }
    const digest = candidate.sha256;
    if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
      fail(`${rolePath}.sha256`, "expected a lowercase hex SHA-256 digest");
    }
    if (digest !== sha256(artifacts.get(`${catalogRole.roleId}.md`)!)) {
      fail(`${rolePath}.sha256`, "does not match the installed role artifact bytes");
    }
    const version = candidate.version;
    const schemaDigest = candidate.schemaSha256;
    if (catalogRole.hasSidecar) {
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
        fail(`${rolePath}.version`, "expected a positive integer schema-sidecar version");
      }
      if (typeof schemaDigest !== "string" || !SHA256_PATTERN.test(schemaDigest)) {
        fail(`${rolePath}.schemaSha256`, "expected a lowercase hex SHA-256 digest");
      }
      if (schemaDigest !== sha256(schemaArtifacts.get(`${catalogRole.roleId}.json`)!)) {
        fail(
          `${rolePath}.schemaSha256`,
          "does not match the installed schema artifact bytes",
        );
      }
    } else {
      if (version !== null) {
        fail(`${rolePath}.version`, "roles without schema sidecars must carry null");
      }
      if (schemaDigest !== null) {
        fail(`${rolePath}.schemaSha256`, "roles without schema sidecars must carry null");
      }
    }
    validatedRoles.push({
      roleId: catalogRole.roleId,
      version,
      sha256: digest,
      schemaSha256: schemaDigest as string | null,
    });
  }

  const surfaceDigest = manifest.surfaceDigest;
  if (typeof surfaceDigest !== "string" || !SHA256_PATTERN.test(surfaceDigest)) {
    fail("surface.json.surfaceDigest", "expected a lowercase hex SHA-256 digest");
  }
  const canonicalCore = serializePromptSurfaceManifestCore(
    expectedSurface,
    catalogMetadataHash,
    validatedRoles,
  );
  if (surfaceDigest !== sha256(canonicalCore)) {
    fail("surface.json.surfaceDigest", "does not match the canonical manifest core");
  }
  if (
    input.surfaceJson !==
    serializePromptSurfaceManifest(expectedSurface, catalogMetadataHash, validatedRoles)
  ) {
    fail("surface.json", "does not use the canonical prompt-surface serialization");
  }
}

function readTreeArtifacts(
  directory: string,
  relativeDirectory: string,
  rootLabel: string,
): readonly { readonly path: string; readonly content: Uint8Array }[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    fail(rootLabel, `expected a readable ${rootLabel} directory`);
  }
  const artifacts: { readonly path: string; readonly content: Uint8Array }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...readTreeArtifacts(absolutePath, relativePath, rootLabel));
    } else if (entry.isFile()) {
      artifacts.push({ path: relativePath, content: readFileSync(absolutePath) });
    } else {
      fail(`${rootLabel}/${relativePath}`, "expected a regular file or directory");
    }
  }
  return artifacts;
}

/** Load and validate one real packaged prompt-surface root. */
export function validatePackagedPromptSurfaceRoot(
  expectedSurface: string,
  root: string,
): void {
  if (!path.isAbsolute(root)) {
    fail("root", "expected an absolute path");
  }
  let catalogJson: string;
  let surfaceJson: string;
  try {
    catalogJson = readFileSync(path.join(root, "catalog.json"), "utf8");
  } catch {
    fail("catalog.json", "expected a readable UTF-8 file");
  }
  try {
    surfaceJson = readFileSync(path.join(root, "surface.json"), "utf8");
  } catch {
    fail("surface.json", "expected a readable UTF-8 file");
  }
  const schemasDir = path.join(root, "schemas");
  const schemaArtifacts = existsSync(schemasDir)
    ? readTreeArtifacts(schemasDir, "", "schemas")
    : [];
  validatePackagedPromptSurface({
    expectedSurface,
    catalogJson,
    surfaceJson,
    roleArtifacts: readTreeArtifacts(path.join(root, "roles"), "", "roles"),
    schemaArtifacts,
  });
}
