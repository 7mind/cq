import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  PROMPT_FRAGMENT_SLOTS,
  PROMPT_SURFACE_MANIFEST_FIELDS,
  PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS,
  serializePromptSurfaceManifestCore,
} from "@cq/config";
import type {
  PromptFragmentBinding,
  PromptIntentionalDifference,
  PromptRendererCapability,
  PromptRendererMetadata,
  PromptSharedSourceBlock,
  PromptSurface,
  PromptWorkflowDependency,
} from "@cq/ledger";

const SAFE_ROLE_ID_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_FILENAME = "catalog.json";
const SURFACE_METADATA_FILENAME = "surface.json";
const ROLE_ARTIFACTS_DIRECTORY = "roles";
const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
const PROMPT_RENDERER_CAPABILITIES =
  PROMPT_FRAGMENT_SLOTS satisfies readonly PromptRendererCapability[];
const INTENTIONAL_DIFFERENCE_KINDS = [
  "invocation-syntax",
  "dispatch-protocol",
  "recursion-protocol",
  "tool-vocabulary",
] as const;
const BUILD_METADATA_FIELDS = [
  "canonicalSource",
  "surfaces",
  "sharedSourceBlock",
  "fragmentBindings",
  "dispatchRelations",
  "intentionalDifferences",
] as const;

export type PromptArtifactRoleKind = "dispatched-subagent" | "orchestrator-command";

export interface PromptArtifactRoleMetadata {
  readonly roleId: string;
  readonly roleKind: PromptArtifactRoleKind;
  readonly artifactPath: string;
  readonly sidecarSchemaRoleId: string | null;
  readonly promptSurface?: PromptSurface;
  readonly renderer?: PromptRendererMetadata;
  readonly sourcePath?: string;
  readonly workflowDependencies?: readonly PromptWorkflowDependency[];
  /**
   * Ordered deterministic-renderer fragment ids from the catalog's
   * `fragmentBindings`, not a derived inventory of host runtime tools.
   */
  readonly requiredCapabilities?: readonly PromptRendererCapability[];
  readonly intentionalDifferences?: readonly PromptIntentionalDifference[];
  /**
   * Lowercase hex SHA-256 of the exact installed artifact bytes, bound by the
   * attested surface manifest; present only for an attested prompt root.
   */
  readonly promptDigest?: string;
  /**
   * The schema-sidecar contract version stamped into the surface attestation
   * (`null` for an orchestrator-command role); present only for an attested
   * prompt root.
   */
  readonly schemaVersion?: number | null;
}

export interface PromptArtifactManifest {
  readonly bytes: Uint8Array;
  readonly roles: readonly PromptArtifactRoleMetadata[];
  readonly promptSurface?: PromptSurface;
  /**
   * Lowercase hex SHA-256 of the installed `catalog.json` bytes (the catalog
   * metadata hash), bound by the attested surface manifest; present only for
   * an attested prompt root.
   */
  readonly catalogHash?: string;
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
  readonly promptSurface?: PromptSurface;
  readonly manifestBytes: Uint8Array;
  readonly roles: readonly PromptArtifactRoleMetadata[];
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
  readonly catalogHash?: string;
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

function parsePromptSurface(value: string, pathLabel: string): PromptSurface {
  if ((PROMPT_SURFACES as readonly string[]).includes(value)) {
    return value as PromptSurface;
  }
  throw new PromptArtifactStoreError(
    pathLabel,
    `expected one of ${PROMPT_SURFACES.join(", ")}`,
  );
}

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `value`. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** One attested role binding: schema-sidecar version paired with exact-byte digest. */
interface PromptSurfaceRoleAttestation {
  readonly roleId: string;
  readonly version: number | null;
  readonly digest: string;
}

/**
 * The parsed attested packaged-surface manifest (`surface.json`, T683). The
 * canonical byte shape is written once by the deterministic renderer
 * (`serializePromptSurfaceManifest` in @cq/config): exactly the keys
 * `surface`, `catalogMetadataHash`, `roles`, `surfaceDigest` in this order,
 * `roles` in canonical catalog order with exactly `roleId`, `version`,
 * `sha256` per entry, and `surfaceDigest` = lowercase hex SHA-256 of the
 * UTF-8 `JSON.stringify` of the object without the `surfaceDigest` key.
 */
interface PromptSurfaceAttestation {
  readonly surface: PromptSurface;
  readonly catalogHash: string;
  readonly roles: readonly PromptSurfaceRoleAttestation[];
  readonly surfaceDigest: string;
}

function parseSurfaceAttestation(surfaceBytes: Uint8Array): PromptSurfaceAttestation {
  let surfaceText: string;
  try {
    surfaceText = new TextDecoder("utf-8", { fatal: true }).decode(surfaceBytes);
  } catch {
    throw new PromptArtifactStoreError(SURFACE_METADATA_FILENAME, "expected valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(surfaceText) as unknown;
  } catch {
    throw new PromptArtifactStoreError(SURFACE_METADATA_FILENAME, "expected valid JSON");
  }
  if (!isRecord(value)) {
    throw new PromptArtifactStoreError(SURFACE_METADATA_FILENAME, "expected an object");
  }
  const fields = Object.keys(value);
  const unexpectedField = fields.find(
    (field) => !(PROMPT_SURFACE_MANIFEST_FIELDS as readonly string[]).includes(field),
  );
  if (unexpectedField !== undefined) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.${unexpectedField}`,
      "unexpected field in the attested surface manifest",
    );
  }
  for (const field of PROMPT_SURFACE_MANIFEST_FIELDS) {
    if (!(field in value)) {
      throw new PromptArtifactStoreError(
        `${SURFACE_METADATA_FILENAME}.${field}`,
        "missing field in the attested surface manifest",
      );
    }
  }
  if (typeof value.surface !== "string") {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.surface`,
      `expected one of ${PROMPT_SURFACES.join(", ")}`,
    );
  }
  const surface = parsePromptSurface(value.surface, `${SURFACE_METADATA_FILENAME}.surface`);

  const catalogHash = value.catalogMetadataHash;
  if (typeof catalogHash !== "string" || !SHA256_HEX_PATTERN.test(catalogHash)) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.catalogMetadataHash`,
      "expected a lowercase hex SHA-256 digest",
    );
  }

  if (!Array.isArray(value.roles)) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.roles`,
      "expected an array",
    );
  }
  const seenRoleIds = new Set<string>();
  const roles = value.roles.map((candidate, index): PromptSurfaceRoleAttestation => {
    const entryPath = `${SURFACE_METADATA_FILENAME}.roles[${index}]`;
    if (!isRecord(candidate)) {
      throw new PromptArtifactStoreError(entryPath, "expected an object");
    }
    const entryFields = Object.keys(candidate);
    const unexpectedEntryField = entryFields.find(
      (field) => !(PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS as readonly string[]).includes(field),
    );
    if (unexpectedEntryField !== undefined) {
      throw new PromptArtifactStoreError(
        `${entryPath}.${unexpectedEntryField}`,
        "unexpected field in the role attestation",
      );
    }
    for (const field of PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS) {
      if (!(field in candidate)) {
        throw new PromptArtifactStoreError(
          `${entryPath}.${field}`,
          "missing field in the role attestation",
        );
      }
    }
    const roleId = candidate.roleId;
    if (typeof roleId !== "string" || !SAFE_ROLE_ID_PATTERN.test(roleId)) {
      throw new PromptArtifactStoreError(
        `${entryPath}.roleId`,
        "expected a safe role identifier",
      );
    }
    if (seenRoleIds.has(roleId)) {
      throw new PromptArtifactStoreError(`${entryPath}.roleId`, `duplicate role "${roleId}"`);
    }
    seenRoleIds.add(roleId);
    const version = candidate.version;
    if (
      version !== null &&
      (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    ) {
      throw new PromptArtifactStoreError(
        `${entryPath}.version`,
        "expected null or a positive integer schema-sidecar version",
      );
    }
    const digest = candidate.sha256;
    if (typeof digest !== "string" || !SHA256_HEX_PATTERN.test(digest)) {
      throw new PromptArtifactStoreError(
        `${entryPath}.sha256`,
        "expected a lowercase hex SHA-256 digest",
      );
    }
    return Object.freeze({ roleId, version, digest });
  });

  const surfaceDigest = value.surfaceDigest;
  if (typeof surfaceDigest !== "string" || !SHA256_HEX_PATTERN.test(surfaceDigest)) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.surfaceDigest`,
      "expected a lowercase hex SHA-256 digest",
    );
  }
  const canonicalCore = serializePromptSurfaceManifestCore(
    surface,
    catalogHash,
    roles.map((role) => ({
      roleId: role.roleId,
      version: role.version,
      sha256: role.digest,
    })),
  );
  if (sha256Hex(canonicalCore) !== surfaceDigest) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.surfaceDigest`,
      "surface aggregate digest does not match the attested contents",
    );
  }
  return Object.freeze({ surface, catalogHash, roles: Object.freeze(roles), surfaceDigest });
}

function validateSelectedSurface(
  selectedSurface: PromptSurface,
  surfaceBytes: Uint8Array,
): PromptSurfaceAttestation {
  const attestation = parseSurfaceAttestation(surfaceBytes);
  if (attestation.surface !== selectedSurface) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.surface`,
      `selected prompt surface "${selectedSurface}" does not match built root "${attestation.surface}"`,
    );
  }
  return attestation;
}

function parseNonEmptyString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PromptArtifactStoreError(pathLabel, "expected a non-empty string");
  }
  return value;
}

function parseSurfaceList(value: unknown, pathLabel: string): readonly PromptSurface[] {
  if (!Array.isArray(value)) {
    throw new PromptArtifactStoreError(pathLabel, "expected an array");
  }
  const surfaces = value.map((candidate, index) => {
    if (typeof candidate !== "string") {
      throw new PromptArtifactStoreError(
        `${pathLabel}[${index}]`,
        `expected one of ${PROMPT_SURFACES.join(", ")}`,
      );
    }
    return parsePromptSurface(candidate, `${pathLabel}[${index}]`);
  });
  const duplicate = surfaces.find(
    (surface, index) => surfaces.indexOf(surface) !== index,
  );
  if (duplicate !== undefined) {
    throw new PromptArtifactStoreError(pathLabel, `duplicate prompt surface "${duplicate}"`);
  }
  return Object.freeze(surfaces);
}

function parseStringArray(value: unknown, pathLabel: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PromptArtifactStoreError(pathLabel, "expected an array");
  }
  return Object.freeze(
    value.map((candidate, index) =>
      parseNonEmptyString(candidate, `${pathLabel}[${index}]`),
    ),
  );
}

function parseIntentionalDifference(
  value: unknown,
  pathLabel: string,
): PromptIntentionalDifference {
  if (!isRecord(value)) {
    throw new PromptArtifactStoreError(pathLabel, "expected an object");
  }
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    !(INTENTIONAL_DIFFERENCE_KINDS as readonly string[]).includes(kind)
  ) {
    throw new PromptArtifactStoreError(
      `${pathLabel}.kind`,
      `expected one of ${INTENTIONAL_DIFFERENCE_KINDS.join(", ")}`,
    );
  }
  const reason = parseNonEmptyString(value.reason, `${pathLabel}.reason`);
  const surfaces = parseSurfaceList(value.surfaces, `${pathLabel}.surfaces`);
  if (surfaces.length < 2) {
    throw new PromptArtifactStoreError(
      `${pathLabel}.surfaces`,
      "expected at least two participating surfaces",
    );
  }
  return Object.freeze({
    kind: kind as PromptIntentionalDifference["kind"],
    reason,
    surfaces,
  });
}

function parseFragmentBinding(value: unknown, pathLabel: string): PromptFragmentBinding {
  if (!isRecord(value)) {
    throw new PromptArtifactStoreError(pathLabel, "expected an object");
  }
  const fragment = value.fragment;
  if (
    typeof fragment !== "string" ||
    !(PROMPT_RENDERER_CAPABILITIES as readonly string[]).includes(fragment)
  ) {
    throw new PromptArtifactStoreError(
      `${pathLabel}.fragment`,
      `expected one of ${PROMPT_RENDERER_CAPABILITIES.join(", ")}`,
    );
  }
  const supportedSurfaces = parseSurfaceList(
    value.supportedSurfaces,
    `${pathLabel}.supportedSurfaces`,
  );
  const vocabulary = value.forbiddenVocabulary;
  if (!isRecord(vocabulary)) {
    throw new PromptArtifactStoreError(
      `${pathLabel}.forbiddenVocabulary`,
      "expected one token array per prompt surface",
    );
  }
  const unexpectedSurface = Object.keys(vocabulary).find(
    (surface) => !(PROMPT_SURFACES as readonly string[]).includes(surface),
  );
  if (unexpectedSurface !== undefined) {
    throw new PromptArtifactStoreError(
      `${pathLabel}.forbiddenVocabulary.${unexpectedSurface}`,
      "unknown prompt surface",
    );
  }
  const forbiddenVocabulary = Object.freeze({
    claude: parseStringArray(
      vocabulary.claude,
      `${pathLabel}.forbiddenVocabulary.claude`,
    ),
    codex: parseStringArray(
      vocabulary.codex,
      `${pathLabel}.forbiddenVocabulary.codex`,
    ),
    pi: parseStringArray(vocabulary.pi, `${pathLabel}.forbiddenVocabulary.pi`),
  });
  return Object.freeze({
    fragment: fragment as PromptRendererCapability,
    sourceBlock: parseNonEmptyString(value.sourceBlock, `${pathLabel}.sourceBlock`),
    supportedSurfaces,
    forbiddenVocabulary,
    ...(value.intentionalDifference === undefined
      ? {}
      : {
          intentionalDifference: parseIntentionalDifference(
            value.intentionalDifference,
            `${pathLabel}.intentionalDifference`,
          ),
        }),
  });
}

function parseSharedSourceBlock(value: unknown, pathLabel: string): PromptSharedSourceBlock {
  if (!isRecord(value)) {
    throw new PromptArtifactStoreError(pathLabel, "expected an object");
  }
  if (value.classification !== "shared-prose") {
    throw new PromptArtifactStoreError(
      `${pathLabel}.classification`,
      'expected "shared-prose"',
    );
  }
  if (value.targetFragment !== null) {
    throw new PromptArtifactStoreError(`${pathLabel}.targetFragment`, "expected null");
  }
  return Object.freeze({
    classification: "shared-prose",
    sourceBlock: parseNonEmptyString(value.sourceBlock, `${pathLabel}.sourceBlock`),
    targetFragment: null,
  });
}

function parseWorkflowDependency(
  value: unknown,
  pathLabel: string,
): PromptWorkflowDependency {
  if (!isRecord(value)) {
    throw new PromptArtifactStoreError(pathLabel, "expected an object");
  }
  if (value.kind !== "dispatch" && value.kind !== "recursion") {
    throw new PromptArtifactStoreError(
      `${pathLabel}.kind`,
      "expected dispatch or recursion",
    );
  }
  const targetRoleId = value.targetRoleId;
  if (typeof targetRoleId !== "string" || !SAFE_ROLE_ID_PATTERN.test(targetRoleId)) {
    throw new PromptArtifactStoreError(
      `${pathLabel}.targetRoleId`,
      "expected a safe role identifier",
    );
  }
  return Object.freeze({ kind: value.kind, targetRoleId });
}

interface ParsedBuildMetadata {
  readonly renderer: PromptRendererMetadata;
  readonly sourcePath: string;
  readonly workflowDependencies: readonly PromptWorkflowDependency[];
  readonly requiredCapabilities: readonly PromptRendererCapability[];
  readonly intentionalDifferences: readonly PromptIntentionalDifference[];
}

function parseBuildMetadata(
  candidate: Readonly<Record<string, unknown>>,
  entryPath: string,
  roleId: string,
  roleKind: PromptArtifactRoleKind,
  promptSurface: PromptSurface | undefined,
): ParsedBuildMetadata | undefined {
  if (!BUILD_METADATA_FIELDS.some((field) => candidate[field] !== undefined)) {
    return undefined;
  }

  const sourcePath = parseNonEmptyString(
    candidate.canonicalSource,
    `${entryPath}.canonicalSource`,
  );
  const expectedSource =
    roleKind === "dispatched-subagent"
      ? `agents/${roleId}.md`
      : `commands/cq/${roleId}.md`;
  if (sourcePath !== expectedSource) {
    throw new PromptArtifactStoreError(
      `${entryPath}.canonicalSource`,
      `expected "${expectedSource}"`,
    );
  }

  const surfaces = parseSurfaceList(candidate.surfaces, `${entryPath}.surfaces`);
  if (
    surfaces.length !== PROMPT_SURFACES.length ||
    PROMPT_SURFACES.some((surface, index) => surfaces[index] !== surface)
  ) {
    throw new PromptArtifactStoreError(
      `${entryPath}.surfaces`,
      `expected ${PROMPT_SURFACES.join(", ")} in canonical order`,
    );
  }
  if (promptSurface !== undefined && !surfaces.includes(promptSurface)) {
    throw new PromptArtifactStoreError(
      `${entryPath}.surfaces`,
      `selected prompt surface "${promptSurface}" is not supported`,
    );
  }

  if (!Array.isArray(candidate.fragmentBindings)) {
    throw new PromptArtifactStoreError(
      `${entryPath}.fragmentBindings`,
      "expected an array",
    );
  }
  const fragmentBindings = Object.freeze(
    candidate.fragmentBindings.map((binding, index) =>
      parseFragmentBinding(binding, `${entryPath}.fragmentBindings[${index}]`),
    ),
  );
  const requiredCapabilities = Object.freeze(
    fragmentBindings.map(({ fragment }) => fragment),
  );
  if (new Set(requiredCapabilities).size !== requiredCapabilities.length) {
    throw new PromptArtifactStoreError(
      `${entryPath}.fragmentBindings`,
      "duplicate renderer fragment capability",
    );
  }

  if (!Array.isArray(candidate.dispatchRelations)) {
    throw new PromptArtifactStoreError(
      `${entryPath}.dispatchRelations`,
      "expected an array",
    );
  }
  const workflowDependencies = Object.freeze(
    candidate.dispatchRelations.map((relation, index) =>
      parseWorkflowDependency(relation, `${entryPath}.dispatchRelations[${index}]`),
    ),
  );

  if (!Array.isArray(candidate.intentionalDifferences)) {
    throw new PromptArtifactStoreError(
      `${entryPath}.intentionalDifferences`,
      "expected an array",
    );
  }
  const intentionalDifferences = Object.freeze(
    candidate.intentionalDifferences.map((difference, index) =>
      parseIntentionalDifference(
        difference,
        `${entryPath}.intentionalDifferences[${index}]`,
      ),
    ),
  );

  return Object.freeze({
    renderer: Object.freeze({
      sharedSourceBlock: parseSharedSourceBlock(
        candidate.sharedSourceBlock,
        `${entryPath}.sharedSourceBlock`,
      ),
      fragmentBindings,
    }),
    sourcePath,
    workflowDependencies,
    requiredCapabilities,
    intentionalDifferences,
  });
}

function parseManifest(
  manifestBytes: Uint8Array,
  promptSurface: PromptSurface | undefined,
): readonly PromptArtifactRoleMetadata[] {
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

    const buildMetadata = parseBuildMetadata(
      candidate,
      entryPath,
      roleId,
      roleKind,
      promptSurface,
    );
    return Object.freeze({
      roleId,
      roleKind,
      artifactPath: artifactPathFor(roleId),
      sidecarSchemaRoleId,
      ...(promptSurface !== undefined ? { promptSurface } : {}),
      ...(buildMetadata ?? {}),
    });
  });
  return Object.freeze(roles);
}

function buildSnapshot(
  promptSurface: PromptSurface | undefined,
  manifestBytes: Uint8Array,
  inputArtifacts: readonly InMemoryPromptRoleArtifact[],
  attestation: PromptSurfaceAttestation | undefined,
): PromptArtifactSnapshot {
  const parsedRoles = parseManifest(manifestBytes, promptSurface);
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

  const declaredRoleIds = new Set(parsedRoles.map((role) => role.roleId));
  const missingRole = parsedRoles.find((role) => !artifacts.has(role.roleId));
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

  let roles = parsedRoles;
  let catalogHash: string | undefined;
  if (attestation !== undefined) {
    roles = verifySurfaceAttestation(attestation, manifestBytes, parsedRoles, artifacts);
    catalogHash = attestation.catalogHash;
  }

  return Object.freeze({
    ...(promptSurface !== undefined ? { promptSurface } : {}),
    manifestBytes: copyBytes(manifestBytes),
    roles,
    artifacts,
    ...(catalogHash !== undefined ? { catalogHash } : {}),
  });
}

/**
 * Verify the attested surface manifest against the exact installed bytes and
 * return the role metadata bound to the attestation (T683). Every check fails
 * closed: a stale catalog hash, a missing or extra role entry, a digest that
 * no longer matches the installed bytes, or a version/role-kind mismatch
 * makes the whole root unusable before any prompt can be dispatched.
 */
function verifySurfaceAttestation(
  attestation: PromptSurfaceAttestation,
  manifestBytes: Uint8Array,
  roles: readonly PromptArtifactRoleMetadata[],
  artifacts: ReadonlyMap<string, Uint8Array>,
): readonly PromptArtifactRoleMetadata[] {
  if (attestation.catalogHash !== sha256Bytes(manifestBytes)) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.catalogMetadataHash`,
      `does not match the installed ${MANIFEST_FILENAME} bytes`,
    );
  }
  const attestationByRoleId = new Map(
    attestation.roles.map((entry) => [entry.roleId, entry] as const),
  );
  const missingAttestation = roles.find((role) => !attestationByRoleId.has(role.roleId));
  if (missingAttestation !== undefined) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.roles`,
      `missing digest for manifest role "${missingAttestation.roleId}"`,
    );
  }
  const extraAttestation = attestation.roles.find(
    (entry) => !roles.some((role) => role.roleId === entry.roleId),
  );
  if (extraAttestation !== undefined) {
    throw new PromptArtifactStoreError(
      `${SURFACE_METADATA_FILENAME}.roles`,
      `digest entry has no manifest role "${extraAttestation.roleId}"`,
    );
  }
  return Object.freeze(
    roles.map((role) => {
      const entry = attestationByRoleId.get(role.roleId)!;
      const bytes = artifacts.get(role.roleId)!;
      if (sha256Bytes(bytes) !== entry.digest) {
        throw new PromptArtifactStoreError(
          role.artifactPath,
          `installed bytes do not match the attested digest for role "${role.roleId}"`,
        );
      }
      if (role.roleKind === "dispatched-subagent") {
        if (entry.version === null) {
          throw new PromptArtifactStoreError(
            `${SURFACE_METADATA_FILENAME}.roles`,
            `dispatched role "${role.roleId}" has no attested schema-sidecar version`,
          );
        }
      } else if (entry.version !== null) {
        throw new PromptArtifactStoreError(
          `${SURFACE_METADATA_FILENAME}.roles`,
          `orchestrator-command role "${role.roleId}" must not carry a schema-sidecar version`,
        );
      }
      return Object.freeze({
        ...role,
        promptDigest: entry.digest,
        schemaVersion: entry.version,
      });
    }),
  );
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
      ...(this.#snapshot.promptSurface !== undefined
        ? { promptSurface: this.#snapshot.promptSurface }
        : {}),
      ...(this.#snapshot.catalogHash !== undefined
        ? { catalogHash: this.#snapshot.catalogHash }
        : {}),
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
  constructor(manifestBytes: Uint8Array, artifacts: readonly InMemoryPromptRoleArtifact[]);
  constructor(
    promptSurface: PromptSurface,
    surfaceBytes: Uint8Array,
    manifestBytes: Uint8Array,
    artifacts: readonly InMemoryPromptRoleArtifact[],
  );
  constructor(
    promptSurfaceOrManifestBytes: PromptSurface | Uint8Array,
    surfaceBytesOrArtifacts: Uint8Array | readonly InMemoryPromptRoleArtifact[],
    maybeManifestBytes?: Uint8Array,
    maybeArtifacts?: readonly InMemoryPromptRoleArtifact[],
  ) {
    if (typeof promptSurfaceOrManifestBytes === "string") {
      const selectedSurface = parsePromptSurface(promptSurfaceOrManifestBytes, "promptSurface");
      if (
        !(surfaceBytesOrArtifacts instanceof Uint8Array) ||
        maybeManifestBytes === undefined ||
        maybeArtifacts === undefined
      ) {
        throw new PromptArtifactStoreError(
          "constructor",
          "expected surface metadata bytes, manifest bytes, and artifacts",
        );
      }
      const attestation = validateSelectedSurface(selectedSurface, surfaceBytesOrArtifacts);
      super(buildSnapshot(attestation.surface, maybeManifestBytes, maybeArtifacts, attestation));
      return;
    }
    if (!Array.isArray(surfaceBytesOrArtifacts)) {
      throw new PromptArtifactStoreError("constructor", "expected artifacts");
    }
    super(buildSnapshot(undefined, promptSurfaceOrManifestBytes, surfaceBytesOrArtifacts, undefined));
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

  constructor(root: string);
  constructor(promptSurface: PromptSurface, root: string);
  constructor(promptSurfaceOrRoot: PromptSurface | string, maybeRoot?: string) {
    const root = maybeRoot ?? promptSurfaceOrRoot;
    const promptSurface =
      maybeRoot === undefined
        ? undefined
        : parsePromptSurface(promptSurfaceOrRoot, "promptSurface");
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
    const attestation =
      promptSurface === undefined
        ? undefined
        : validateSelectedSurface(
            promptSurface,
            readContainedFile(
              resolvedRoot,
              SURFACE_METADATA_FILENAME,
              SURFACE_METADATA_FILENAME,
            ),
          );
    const manifestBytes = readContainedFile(resolvedRoot, MANIFEST_FILENAME, MANIFEST_FILENAME);
    super(
      buildSnapshot(
        attestation?.surface,
        manifestBytes,
        collectFilesystemArtifacts(resolvedRoot),
        attestation,
      ),
    );
    this.root = resolvedRoot;
  }
}
