import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { PROMPT_SURFACES, type PromptSurface } from "./promptCatalog.js";

const SLOT_MARKER_PREFIX = "{{cq:fragment:";
const SLOT_MARKER_PATTERN = /\{\{cq:fragment:([^{}\r\n]+)\}\}/g;
const SAFE_ROLE_ID_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const SAFE_FRAGMENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_HARNESS_BRANCH_PATTERN = /\bCQ_HARNESS\b/;

/** One explicit canonical-source input. No source root or ambient CWD is consulted. */
export interface PromptCatalogFileInput {
  readonly canonicalSource: string;
  readonly path: string;
}

/** One explicit surface-fragment input for a catalog role and declared typed slot. */
export interface PromptFragmentFileInput {
  readonly roleId: string;
  readonly fragment: string;
  readonly path: string;
}

export interface RenderPromptSurfaceTreeInput {
  /** Selected output surface. Kept as string so untyped boundary callers get a deterministic error. */
  readonly surface: string;
  /** The direct JSON serialization of `assets.nix.catalog`. */
  readonly catalogJson: string;
  readonly sourcePaths: readonly PromptCatalogFileInput[];
  readonly fragmentPaths: readonly PromptFragmentFileInput[];
  /**
   * Schema-sidecar contract versions keyed by dispatched-subagent role id.
   * Every dispatched catalog role requires exactly one positive-integer
   * version; orchestrator-command roles carry none and extra keys fail.
   */
  readonly roleVersions: Readonly<Record<string, number>>;
  /**
   * Pi-only, authoritative role/tool decision manifest. Production rendering
   * supplies it; generic renderer fixtures may omit it.
   */
  readonly roleToolProfilesJson?: string;
}

export interface RenderedPromptArtifact {
  /** Relative path below a surface root. */
  readonly path: string;
  /** Exact UTF-8 bytes represented as a string. */
  readonly content: string;
}

/**
 * One role entry of the attested surface manifest: the schema-sidecar contract
 * version (`null` for an orchestrator-command role, which carries no contract)
 * paired with the lowercase hex SHA-256 of the exact installed role bytes
 * (the rendered `roles/<roleId>.md` UTF-8 content, frontmatter included).
 */
export interface PromptSurfaceRoleAttestation {
  readonly roleId: string;
  readonly version: number | null;
  readonly sha256: string;
}

export const PROMPT_SURFACE_MANIFEST_CORE_FIELDS = [
  "surface",
  "catalogMetadataHash",
  "roles",
] as const;
export type PromptSurfaceManifestCoreField =
  (typeof PROMPT_SURFACE_MANIFEST_CORE_FIELDS)[number];

export const PROMPT_SURFACE_MANIFEST_FIELDS = [
  ...PROMPT_SURFACE_MANIFEST_CORE_FIELDS,
  "surfaceDigest",
] as const;
export type PromptSurfaceManifestField = (typeof PROMPT_SURFACE_MANIFEST_FIELDS)[number];

export const PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS = ["roleId", "version", "sha256"] as const;
export type PromptSurfaceRoleAttestationField =
  (typeof PROMPT_SURFACE_ROLE_ATTESTATION_FIELDS)[number];

export interface PromptSurfaceManifestCore {
  readonly surface: PromptSurface;
  readonly catalogMetadataHash: string;
  readonly roles: readonly PromptSurfaceRoleAttestation[];
}

export interface PromptSurfaceManifest extends PromptSurfaceManifestCore {
  readonly surfaceDigest: string;
}

/** Serialize the canonical digest-bearing core of a packaged-surface manifest. */
export function serializePromptSurfaceManifestCore(
  surface: PromptSurface,
  catalogMetadataHash: string,
  roles: readonly PromptSurfaceRoleAttestation[],
): string {
  const core: PromptSurfaceManifestCore = {
    surface,
    catalogMetadataHash,
    roles: roles.map(({ roleId, version, sha256 }) => ({ roleId, version, sha256 })),
  };
  return JSON.stringify(core);
}

/**
 * Serialize the attested packaged-surface manifest (`surface.json`).
 *
 * Canonical byte shape (the ONLY writer — the artifact store, the centralized
 * verification, and the Nix checks all re-derive digests against this rule):
 *
 * ```
 * { "surface": <surface>, "catalogMetadataHash": <hex>, "roles": [ <attestation>... ],
 *   "surfaceDigest": <hex> }
 * ```
 *
 * with exactly these keys in exactly this order, `roles` in canonical catalog
 * order, and every role entry carrying exactly `roleId`, `version`, `sha256`
 * in this order. `surfaceDigest` is the lowercase hex SHA-256 of the UTF-8
 * `JSON.stringify` of the object WITHOUT the `surfaceDigest` key (i.e.
 * `{ surface, catalogMetadataHash, roles }` in this key order).
 */
export function serializePromptSurfaceManifest(
  surface: PromptSurface,
  catalogMetadataHash: string,
  roles: readonly PromptSurfaceRoleAttestation[],
): string {
  const core = serializePromptSurfaceManifestCore(surface, catalogMetadataHash, roles);
  return `${core.slice(0, -1)},"surfaceDigest":"${sha256Hex(core)}"}`;
}

export interface RenderedPromptSurfaceTree {
  readonly surface: PromptSurface;
  /** Root metadata, optional surface artifacts, then roles in canonical catalog order. */
  readonly artifacts: readonly RenderedPromptArtifact[];
}

/** Deterministic boundary or rendering failure. */
export class PromptRendererError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PromptRendererError";
  }
}

interface CatalogFragmentBinding {
  readonly fragment: string;
  readonly supportedSurfaces: readonly PromptSurface[];
  readonly forbiddenVocabulary: Readonly<Record<PromptSurface, readonly string[]>>;
}

type CatalogRoleKind = "dispatched-subagent" | "orchestrator-command";

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: CatalogRoleKind;
  readonly canonicalSource: string;
  readonly surfaces: readonly PromptSurface[];
  readonly fragmentBindings: readonly CatalogFragmentBinding[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `value`. */
function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(value)).digest("hex");
}

function parseSurfaceList(value: unknown, path: string): readonly PromptSurface[] {
  if (!Array.isArray(value)) {
    throw new PromptRendererError(path, "expected an array");
  }
  const surfaces: PromptSurface[] = [];
  for (const [index, candidate] of value.entries()) {
    if (
      typeof candidate !== "string" ||
      !(PROMPT_SURFACES as readonly string[]).includes(candidate)
    ) {
      throw new PromptRendererError(
        `${path}[${index}]`,
        `expected one of ${PROMPT_SURFACES.join(", ")}`,
      );
    }
    const surface = candidate as PromptSurface;
    if (surfaces.includes(surface)) {
      throw new PromptRendererError(`${path}[${index}]`, `duplicate surface "${surface}"`);
    }
    surfaces.push(surface);
  }
  return surfaces;
}

function parseForbiddenVocabulary(
  value: unknown,
  path: string,
): Readonly<Record<PromptSurface, readonly string[]>> {
  if (!isRecord(value)) {
    throw new PromptRendererError(path, "expected one token array per prompt surface");
  }
  const unexpectedSurface = Object.keys(value).find(
    (surface) => !(PROMPT_SURFACES as readonly string[]).includes(surface),
  );
  if (unexpectedSurface !== undefined) {
    throw new PromptRendererError(`${path}.${unexpectedSurface}`, "unknown prompt surface");
  }
  const parsed = {} as Record<PromptSurface, readonly string[]>;
  for (const surface of PROMPT_SURFACES) {
    const candidate = value[surface];
    if (
      !Array.isArray(candidate) ||
      candidate.some((token) => typeof token !== "string" || token.length === 0)
    ) {
      throw new PromptRendererError(
        `${path}.${surface}`,
        "expected an array of non-empty forbidden tokens",
      );
    }
    const tokens = candidate as readonly string[];
    if (new Set(tokens).size !== tokens.length) {
      throw new PromptRendererError(`${path}.${surface}`, "duplicate forbidden token");
    }
    parsed[surface] = tokens;
  }
  return parsed;
}

function parseCatalog(catalogJson: string): readonly CatalogRole[] {
  let value: unknown;
  try {
    value = JSON.parse(catalogJson) as unknown;
  } catch {
    throw new PromptRendererError("catalogJson", "invalid JSON");
  }
  if (!Array.isArray(value)) {
    throw new PromptRendererError("catalogJson", "expected the assets.nix.catalog array");
  }

  const roles: CatalogRole[] = [];
  const roleIds = new Set<string>();
  const canonicalSources = new Set<string>();
  for (const [roleIndex, candidate] of value.entries()) {
    const rolePath = `catalog[${roleIndex}]`;
    if (!isRecord(candidate)) {
      throw new PromptRendererError(rolePath, "expected an object");
    }
    const roleId = candidate.roleId;
    if (typeof roleId !== "string" || !SAFE_ROLE_ID_PATTERN.test(roleId)) {
      throw new PromptRendererError(`${rolePath}.roleId`, "expected a safe role identifier");
    }
    if (roleIds.has(roleId)) {
      throw new PromptRendererError(`${rolePath}.roleId`, `duplicate role "${roleId}"`);
    }
    roleIds.add(roleId);

    const roleKind = candidate.roleKind;
    if (roleKind !== "dispatched-subagent" && roleKind !== "orchestrator-command") {
      throw new PromptRendererError(
        `${rolePath}.roleKind`,
        "expected dispatched-subagent or orchestrator-command",
      );
    }
    if (roleKind === "dispatched-subagent") {
      if (!isRecord(candidate.sidecar) || candidate.sidecar.schemaRoleId !== roleId) {
        throw new PromptRendererError(
          `${rolePath}.sidecar.schemaRoleId`,
          `expected "${roleId}"`,
        );
      }
    } else if (candidate.sidecar !== null) {
      throw new PromptRendererError(`${rolePath}.sidecar`, "expected null");
    }

    const canonicalSource = candidate.canonicalSource;
    if (
      typeof canonicalSource !== "string" ||
      canonicalSource.length === 0 ||
      nodePath.posix.isAbsolute(canonicalSource) ||
      canonicalSource.split("/").includes("..")
    ) {
      throw new PromptRendererError(
        `${rolePath}.canonicalSource`,
        "expected a safe relative canonical source",
      );
    }
    if (canonicalSources.has(canonicalSource)) {
      throw new PromptRendererError(
        `${rolePath}.canonicalSource`,
        `duplicate canonical source "${canonicalSource}"`,
      );
    }
    canonicalSources.add(canonicalSource);

    const surfaces = parseSurfaceList(candidate.surfaces, `${rolePath}.surfaces`);
    if (!Array.isArray(candidate.fragmentBindings)) {
      throw new PromptRendererError(`${rolePath}.fragmentBindings`, "expected an array");
    }
    const bindings: CatalogFragmentBinding[] = [];
    const fragments = new Set<string>();
    for (const [bindingIndex, bindingCandidate] of candidate.fragmentBindings.entries()) {
      const bindingPath = `${rolePath}.fragmentBindings[${bindingIndex}]`;
      if (!isRecord(bindingCandidate)) {
        throw new PromptRendererError(bindingPath, "expected an object");
      }
      const fragment = bindingCandidate.fragment;
      if (typeof fragment !== "string" || !SAFE_FRAGMENT_ID_PATTERN.test(fragment)) {
        throw new PromptRendererError(
          `${bindingPath}.fragment`,
          "expected a typed fragment identifier",
        );
      }
      if (fragments.has(fragment)) {
        throw new PromptRendererError(
          `${bindingPath}.fragment`,
          `duplicate slot declaration "${fragment}"`,
        );
      }
      fragments.add(fragment);
      bindings.push({
        fragment,
        supportedSurfaces: parseSurfaceList(
          bindingCandidate.supportedSurfaces,
          `${bindingPath}.supportedSurfaces`,
        ),
        forbiddenVocabulary: parseForbiddenVocabulary(
          bindingCandidate.forbiddenVocabulary,
          `${bindingPath}.forbiddenVocabulary`,
        ),
      });
    }
    roles.push({ roleId, roleKind, canonicalSource, surfaces, fragmentBindings: bindings });
  }
  return roles;
}

/**
 * Validate the schema-sidecar version map against the parsed catalog and
 * return the attestation version for one role: the stamped positive-integer
 * sidecar version for a dispatched subagent, `null` for an orchestrator
 * command. The map must cover every dispatched role exactly (a missing,
 * extra, or non-positive-integer entry fails the build closed).
 */
function validateRoleVersions(
  roleVersions: Readonly<Record<string, number>>,
  roles: readonly CatalogRole[],
): void {
  if (!isRecord(roleVersions)) {
    throw new PromptRendererError("roleVersions", "expected an object keyed by role id");
  }
  const dispatched = new Set(
    roles.filter((role) => role.roleKind === "dispatched-subagent").map((role) => role.roleId),
  );
  for (const [roleId, version] of Object.entries(roleVersions)) {
    if (!dispatched.has(roleId)) {
      throw new PromptRendererError(
        `roleVersions.${roleId}`,
        "version entry has no dispatched catalog role",
      );
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new PromptRendererError(
        `roleVersions.${roleId}`,
        "expected a positive integer schema-sidecar version",
      );
    }
  }
  for (const roleId of dispatched) {
    if (!(roleId in roleVersions)) {
      throw new PromptRendererError(
        `roleVersions.${roleId}`,
        "missing schema-sidecar version for a dispatched role",
      );
    }
  }
}

function parseSurface(value: string): PromptSurface {
  if (!(PROMPT_SURFACES as readonly string[]).includes(value)) {
    throw new PromptRendererError("surface", `unsupported prompt surface "${value}"`);
  }
  return value as PromptSurface;
}

function readExplicitFile(inputPath: string, label: string): string {
  if (!nodePath.isAbsolute(inputPath)) {
    throw new PromptRendererError(label, "expected an absolute explicit input path");
  }
  try {
    return readFileSync(inputPath, "utf8");
  } catch {
    throw new PromptRendererError(label, `cannot read "${inputPath}"`);
  }
}

function rejectHarnessBranch(content: string, label: string): void {
  if (FORBIDDEN_HARNESS_BRANCH_PATTERN.test(content)) {
    throw new PromptRendererError(label, "forbidden harness branch CQ_HARNESS");
  }
}

function rejectForbiddenVocabulary(
  content: string,
  tokens: readonly string[],
  surface: PromptSurface,
  label: string,
): void {
  const forbidden = tokens.find((token) => content.includes(token));
  if (forbidden !== undefined) {
    throw new PromptRendererError(
      label,
      `forbidden vocabulary "${forbidden}" for surface "${surface}"`,
    );
  }
}

function indexSourcePaths(
  inputs: readonly PromptCatalogFileInput[],
  roles: readonly CatalogRole[],
): ReadonlyMap<string, string> {
  const declaredSources = new Set(roles.map((role) => role.canonicalSource));
  const paths = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    if (!declaredSources.has(input.canonicalSource)) {
      throw new PromptRendererError(
        `sourcePaths[${index}]`,
        `undeclared canonical source "${input.canonicalSource}"`,
      );
    }
    if (paths.has(input.canonicalSource)) {
      throw new PromptRendererError(
        `sourcePaths[${index}]`,
        `duplicate canonical source input "${input.canonicalSource}"`,
      );
    }
    paths.set(input.canonicalSource, input.path);
  }
  for (const role of roles) {
    if (!paths.has(role.canonicalSource)) {
      throw new PromptRendererError(
        `sources.${role.roleId}`,
        `missing canonical source input "${role.canonicalSource}"`,
      );
    }
  }
  return paths;
}

function fragmentKey(roleId: string, fragment: string): string {
  return `${roleId}\0${fragment}`;
}

function indexFragmentPaths(
  inputs: readonly PromptFragmentFileInput[],
  roles: readonly CatalogRole[],
  surface: PromptSurface,
): ReadonlyMap<string, string> {
  const expected = new Map<string, { readonly roleId: string; readonly fragment: string }>();
  for (const role of roles) {
    if (!role.surfaces.includes(surface)) {
      throw new PromptRendererError(
        `catalog[${roles.indexOf(role)}].surfaces`,
        `surface "${surface}" is unsupported for role "${role.roleId}"`,
      );
    }
    for (const binding of role.fragmentBindings) {
      if (!binding.supportedSurfaces.includes(surface)) {
        throw new PromptRendererError(
          `catalog.${role.roleId}.${binding.fragment}.supportedSurfaces`,
          `surface "${surface}" is unsupported for slot`,
        );
      }
      expected.set(fragmentKey(role.roleId, binding.fragment), {
        roleId: role.roleId,
        fragment: binding.fragment,
      });
    }
  }

  const paths = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    const key = fragmentKey(input.roleId, input.fragment);
    if (!expected.has(key)) {
      throw new PromptRendererError(
        `fragmentPaths[${index}]`,
        `undeclared fragment input "${input.roleId}:${input.fragment}"`,
      );
    }
    if (paths.has(key)) {
      throw new PromptRendererError(
        `fragmentPaths[${index}]`,
        `duplicate slot input "${input.roleId}:${input.fragment}"`,
      );
    }
    paths.set(key, input.path);
  }
  for (const { roleId, fragment } of expected.values()) {
    if (!paths.has(fragmentKey(roleId, fragment))) {
      throw new PromptRendererError(
        `fragments.${roleId}.${fragment}`,
        `missing slot input for surface "${surface}"`,
      );
    }
  }
  return paths;
}

function renderRole(
  role: CatalogRole,
  surface: PromptSurface,
  sourcePath: string,
  fragmentPaths: ReadonlyMap<string, string>,
): string {
  const sourceLabel = `sources.${role.roleId}`;
  let rendered = readExplicitFile(sourcePath, sourceLabel);
  rejectHarnessBranch(rendered, sourceLabel);

  const declaredFragments = new Set(role.fragmentBindings.map((binding) => binding.fragment));
  const catalogFragments = new Set<string>();
  for (const key of fragmentPaths.keys()) {
    catalogFragments.add(key.slice(key.indexOf("\0") + 1));
  }
  const markerCounts = new Map<string, number>();
  for (const match of rendered.matchAll(SLOT_MARKER_PATTERN)) {
    const fragment = match[1]!;
    if (!catalogFragments.has(fragment)) {
      throw new PromptRendererError(
        `${sourceLabel}.${fragment}`,
        "unknown slot marker",
      );
    }
    if (!declaredFragments.has(fragment)) {
      throw new PromptRendererError(
        `${sourceLabel}.${fragment}`,
        "slot marker is undeclared for this role",
      );
    }
    markerCounts.set(fragment, (markerCounts.get(fragment) ?? 0) + 1);
  }

  for (const binding of role.fragmentBindings) {
    const count = markerCounts.get(binding.fragment) ?? 0;
    if (count === 0) {
      throw new PromptRendererError(
        `fragments.${role.roleId}.${binding.fragment}`,
        "unconsumed slot input",
      );
    }
    if (count > 1) {
      throw new PromptRendererError(
        `${sourceLabel}.${binding.fragment}`,
        "duplicate slot marker",
      );
    }
    const fragmentLabel = `fragments.${role.roleId}.${binding.fragment}`;
    const fragmentPath = fragmentPaths.get(fragmentKey(role.roleId, binding.fragment));
    if (fragmentPath === undefined) {
      throw new PromptRendererError(fragmentLabel, "missing slot input");
    }
    const fragment = readExplicitFile(fragmentPath, fragmentLabel);
    rejectHarnessBranch(fragment, fragmentLabel);
    rejectForbiddenVocabulary(
      fragment,
      binding.forbiddenVocabulary[surface],
      surface,
      fragmentLabel,
    );
    if (fragment.includes(SLOT_MARKER_PREFIX)) {
      throw new PromptRendererError(fragmentLabel, "fragment content contains a slot marker");
    }
    rendered = rendered.replace(`{{cq:fragment:${binding.fragment}}}`, fragment);
  }
  if (rendered.includes(SLOT_MARKER_PREFIX)) {
    throw new PromptRendererError(sourceLabel, "unresolved slot marker");
  }
  const outputForbiddenTokens = role.fragmentBindings.flatMap(
    (binding) => binding.forbiddenVocabulary[surface],
  );
  rejectForbiddenVocabulary(
    rendered,
    [...new Set(outputForbiddenTokens)],
    surface,
    `rendered.${role.roleId}`,
  );
  return rendered;
}

/**
 * Render one prompt surface from direct Nix catalog JSON and explicit files.
 *
 * The function performs no root discovery and reads no generated roster or
 * packaged prompt tree. Each canonical source contains exactly one
 * `{{cq:fragment:<fragment>}}` marker for each bound slot. Catalog order
 * determines artifact order.
 *
 * The rendered `surface.json` is the ATTESTED packaged-surface manifest
 * (T683): it binds every rendered role to the lowercase hex SHA-256 of its
 * exact installed bytes (frontmatter included — no stripping happens here),
 * pairs each dispatched role with its schema-sidecar contract version from
 * `roleVersions`, and records the catalog metadata hash plus a surface
 * aggregate digest (see {@link serializePromptSurfaceManifest} for the
 * canonical byte shape). Two runs over byte-identical inputs therefore emit
 * byte-identical manifests, and changing one rendered byte changes only that
 * role's `sha256` and the `surfaceDigest` aggregate.
 */
export function renderPromptSurfaceTree(
  input: RenderPromptSurfaceTreeInput,
): RenderedPromptSurfaceTree {
  const surface = parseSurface(input.surface);
  const roles = parseCatalog(input.catalogJson);
  validateRoleVersions(input.roleVersions, roles);
  const sourcePaths = indexSourcePaths(input.sourcePaths, roles);
  const fragmentPaths = indexFragmentPaths(input.fragmentPaths, roles, surface);
  const renderedRoles: { readonly role: CatalogRole; readonly content: string }[] = [];
  for (const role of roles) {
    const sourcePath = sourcePaths.get(role.canonicalSource);
    if (sourcePath === undefined) {
      throw new PromptRendererError(`sources.${role.roleId}`, "missing canonical source input");
    }
    renderedRoles.push({ role, content: renderRole(role, surface, sourcePath, fragmentPaths) });
  }
  const attestation: readonly PromptSurfaceRoleAttestation[] = renderedRoles.map(
    ({ role, content }) => ({
      roleId: role.roleId,
      version:
        role.roleKind === "dispatched-subagent" ? input.roleVersions[role.roleId]! : null,
      sha256: sha256Hex(content),
    }),
  );
  const artifacts: RenderedPromptArtifact[] = [
    { path: "catalog.json", content: input.catalogJson },
    {
      path: "surface.json",
      content: serializePromptSurfaceManifest(surface, sha256Hex(input.catalogJson), attestation),
    },
  ];
  if (input.roleToolProfilesJson !== undefined) {
    if (surface !== "pi") {
      throw new PromptRendererError(
        "roleToolProfilesJson",
        "role tool profiles are supported only on the pi surface",
      );
    }
    try {
      JSON.parse(input.roleToolProfilesJson);
    } catch {
      throw new PromptRendererError("roleToolProfilesJson", "invalid JSON");
    }
    artifacts.push({
      path: "role-tool-profiles.json",
      content: input.roleToolProfilesJson,
    });
  }
  for (const { role, content } of renderedRoles) {
    artifacts.push({
      path: nodePath.posix.join("roles", `${role.roleId}.md`),
      content,
    });
  }
  return { surface, artifacts };
}
