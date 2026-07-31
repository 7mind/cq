import {
  PROMPT_SURFACES,
  type IntentionalDifferenceDeclaration,
  type PromptSurface,
} from "./promptCatalog.js";

const SLOT_MARKER_PREFIX = "{{cq:fragment:";
const SLOT_MARKER_PATTERN = /\{\{cq:fragment:([^{}\r\n]+)\}\}/g;
const RUNTIME_PLACEHOLDER_PATTERN =
  /\$[A-Z_][A-Z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{(?!cq:fragment:)[^{}\r\n]+\}\}/g;

export interface PromptVerificationRoot {
  readonly surface: PromptSurface;
  readonly artifacts: Readonly<Record<string, string>>;
}

export interface PromptFragmentObservation {
  readonly roleId: string;
  readonly fragment: string;
  readonly contents: Readonly<Record<PromptSurface, string>>;
}

export interface PromptCatalogVerificationInput {
  readonly authoritativeCatalogJson: string;
  readonly authoritativeProjection: Readonly<Record<string, unknown>>;
  readonly generatedProjection: Readonly<Record<string, unknown>>;
  readonly expectedRoots: Readonly<Record<PromptSurface, PromptVerificationRoot>>;
  readonly packagedRoots: Readonly<Record<PromptSurface, PromptVerificationRoot>>;
  readonly localClaudeRoot: PromptVerificationRoot;
  readonly canonicalSources: Readonly<Record<string, string>>;
  readonly fragmentObservations: readonly PromptFragmentObservation[];
  readonly sidecarRoleIds: readonly string[];
}

export class PromptCatalogVerificationError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PromptCatalogVerificationError";
  }
}

type DifferenceDeclaration = IntentionalDifferenceDeclaration;

interface FragmentBinding {
  readonly fragment: string;
  readonly supportedSurfaces: readonly PromptSurface[];
  readonly forbiddenVocabulary: Readonly<Record<PromptSurface, readonly string[]>>;
  readonly intentionalDifference?: DifferenceDeclaration;
}

interface DispatchRelation {
  readonly kind: "dispatch" | "recursion";
  readonly targetRoleId: string;
}

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
  readonly surfaces: readonly PromptSurface[];
  readonly fragmentBindings: readonly FragmentBinding[];
  readonly dispatchRelations: readonly DispatchRelation[];
  readonly intentionalDifferences: readonly DifferenceDeclaration[];
  readonly sidecar: { readonly schemaRoleId: string } | null;
}

interface CatalogProjection {
  readonly schemaVersion: number;
  readonly catalog: readonly CatalogRole[];
  readonly catalogMetadataHash: string;
  readonly fragmentContracts: readonly FragmentBinding[];
}

function fail(path: string, detail: string): never {
  throw new PromptCatalogVerificationError(path, detail);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProjection(
  value: Readonly<Record<string, unknown>>,
  path: string,
): CatalogProjection {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.catalog) ||
    typeof value.catalogMetadataHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.catalogMetadataHash) ||
    !Array.isArray(value.fragmentContracts)
  ) {
    fail(path, "unsupported prompt-catalog projection");
  }
  return value as unknown as CatalogProjection;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalArtifacts(artifacts: Readonly<Record<string, string>>): string {
  return canonicalJson(
    Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSupportedSurfaces(
  value: readonly PromptSurface[],
  path: string,
): void {
  if (!sameOrderedValues(value, PROMPT_SURFACES)) {
    fail(path, `supported surfaces must equal ${PROMPT_SURFACES.join(", ")} in order`);
  }
}

function differenceKey(value: DifferenceDeclaration): string {
  return canonicalJson({
    kind: value.kind,
    reason: value.reason,
    surfaces: value.surfaces,
  });
}

function observationKey(roleId: string, fragment: string): string {
  return `${roleId}\0${fragment}`;
}

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(RUNTIME_PLACEHOLDER_PATTERN)].map((match) => match[0]);
}

function assertCatalogStructure(
  roles: readonly CatalogRole[],
  fragmentContracts: readonly FragmentBinding[],
  sidecarRoleIds: readonly string[],
): void {
  const rolesById = new Map<string, CatalogRole>();
  const canonicalSources = new Set<string>();
  for (const [index, role] of roles.entries()) {
    const path = `catalog[${index}]`;
    if (!isRecord(role) || typeof role.roleId !== "string") {
      fail(path, "expected a catalog role");
    }
    if (rolesById.has(role.roleId)) {
      fail(`${path}.roleId`, `duplicate role "${role.roleId}"`);
    }
    rolesById.set(role.roleId, role);
    if (canonicalSources.has(role.canonicalSource)) {
      fail(`${path}.canonicalSource`, `duplicate source "${role.canonicalSource}"`);
    }
    canonicalSources.add(role.canonicalSource);
    assertSupportedSurfaces(role.surfaces, `${path}.surfaces`);
    if (!Array.isArray(role.fragmentBindings)) {
      fail(`${path}.fragmentBindings`, "expected an array");
    }
    for (const binding of role.fragmentBindings) {
      assertSupportedSurfaces(
        binding.supportedSurfaces,
        `${path}.fragmentBindings.${binding.fragment}.supportedSurfaces`,
      );
      if (binding.intentionalDifference !== undefined) {
        assertSupportedSurfaces(
          binding.intentionalDifference.surfaces,
          `${path}.fragmentBindings.${binding.fragment}.intentionalDifference.surfaces`,
        );
      }
    }
  }

  const expectedSidecars = roles
    .filter((role) => role.roleKind === "dispatched-subagent")
    .map((role) => role.roleId)
    .sort();
  const actualSidecars = [...sidecarRoleIds].sort();
  if (!sameOrderedValues(actualSidecars, expectedSidecars)) {
    fail(
      "sidecars",
      `sidecar closure differs: expected ${expectedSidecars.join(", ")}, got ${actualSidecars.join(", ")}`,
    );
  }
  for (const role of roles) {
    if (role.roleKind === "dispatched-subagent") {
      if (role.sidecar?.schemaRoleId !== role.roleId) {
        fail(`catalog.${role.roleId}.sidecar`, "sidecar closure does not match the role");
      }
    } else if (role.sidecar !== null) {
      fail(`catalog.${role.roleId}.sidecar`, "orchestrator roles must not carry a sidecar");
    }
    for (const relation of role.dispatchRelations) {
      const target = rolesById.get(relation.targetRoleId);
      if (target === undefined) {
        fail(
          `catalog.${role.roleId}.dispatchRelations`,
          `unknown dispatch target "${relation.targetRoleId}"`,
        );
      }
      if (relation.kind === "dispatch" && target.roleKind !== "dispatched-subagent") {
        fail(
          `catalog.${role.roleId}.dispatchRelations`,
          `dispatch target "${relation.targetRoleId}" is not a dispatched subagent`,
        );
      }
      if (relation.kind === "recursion" && target.roleKind !== "orchestrator-command") {
        fail(
          `catalog.${role.roleId}.dispatchRelations`,
          `recursion target "${relation.targetRoleId}" is not an orchestrator command`,
        );
      }
    }
  }

  const contractsByFragment = new Map<string, FragmentBinding>();
  for (const contract of fragmentContracts) {
    if (contractsByFragment.has(contract.fragment)) {
      fail(
        "fragmentContracts",
        `duplicate fragment declaration "${contract.fragment}"`,
      );
    }
    contractsByFragment.set(contract.fragment, contract);
  }

  for (const role of roles) {
    const declarationKeys = new Set<string>();
    for (const declaration of role.intentionalDifferences) {
      const key = differenceKey(declaration);
      if (declarationKeys.has(key)) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `duplicate difference declaration "${declaration.kind}"`,
        );
      }
      declarationKeys.add(key);
    }

    const boundDeclarationKeys = new Set<string>();
    for (const binding of role.fragmentBindings) {
      const contract = contractsByFragment.get(binding.fragment);
      const contractDeclarationKey =
        contract?.intentionalDifference === undefined
          ? undefined
          : differenceKey(contract.intentionalDifference);
      const bindingDeclarationKey =
        binding.intentionalDifference === undefined
          ? undefined
          : differenceKey(binding.intentionalDifference);
      if (
        contract === undefined ||
        contractDeclarationKey !== bindingDeclarationKey
      ) {
        fail(
          `catalog.${role.roleId}.fragmentBindings.${binding.fragment}`,
          "unknown fragment difference declaration",
        );
      }
      if (bindingDeclarationKey !== undefined) {
        boundDeclarationKeys.add(bindingDeclarationKey);
      }
    }
    for (const declaration of role.intentionalDifferences) {
      if (!boundDeclarationKeys.has(differenceKey(declaration))) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `unknown difference declaration "${declaration.kind}"`,
        );
      }
    }
  }
}

interface CanonicalSourceTemplate {
  readonly fragments: readonly string[];
  readonly literals: readonly string[];
}

function indexCanonicalSources(
  roles: readonly CatalogRole[],
  sources: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const expectedPaths = roles.map((role) => role.canonicalSource).sort();
  const actualPaths = Object.keys(sources).sort();
  const missing = expectedPaths.find((sourcePath) => !actualPaths.includes(sourcePath));
  if (missing !== undefined) {
    fail("canonicalSources", `missing canonical source "${missing}"`);
  }
  const extra = actualPaths.find((sourcePath) => !expectedPaths.includes(sourcePath));
  if (extra !== undefined) {
    fail("canonicalSources", `unknown canonical source "${extra}"`);
  }
  for (const sourcePath of expectedPaths) {
    if (typeof sources[sourcePath] !== "string") {
      fail(`canonicalSources.${sourcePath}`, "expected source bytes");
    }
  }
  return new Map(expectedPaths.map((sourcePath) => [sourcePath, sources[sourcePath]!]));
}

function parseCanonicalSource(
  role: CatalogRole,
  source: string,
): CanonicalSourceTemplate {
  const fragments: string[] = [];
  const literals: string[] = [];
  let offset = 0;
  for (const match of source.matchAll(SLOT_MARKER_PATTERN)) {
    const index = match.index;
    const marker = match[0];
    const fragment = match[1];
    if (index === undefined || fragment === undefined) {
      fail(`canonicalSources.${role.canonicalSource}`, "invalid typed slot marker");
    }
    literals.push(source.slice(offset, index));
    fragments.push(fragment);
    offset = index + marker.length;
  }
  literals.push(source.slice(offset));

  const duplicate = fragments.find(
    (fragment, index) => fragments.indexOf(fragment) !== index,
  );
  if (duplicate !== undefined) {
    fail(
      `canonicalSources.${role.canonicalSource}`,
      `duplicate typed slot marker "${duplicate}"`,
    );
  }
  const expectedFragments = role.fragmentBindings
    .map((binding) => binding.fragment)
    .sort();
  const actualFragments = [...fragments].sort();
  if (!sameOrderedValues(actualFragments, expectedFragments)) {
    fail(
      `canonicalSources.${role.canonicalSource}`,
      "typed slot-marker closure differs from catalog bindings",
    );
  }
  for (let index = 1; index < literals.length - 1; index += 1) {
    if (literals[index] === "") {
      fail(
        `canonicalSources.${role.canonicalSource}`,
        "adjacent typed slot markers have no literal provenance anchor",
      );
    }
  }
  return { fragments, literals };
}

function extractRenderedSegments(
  template: CanonicalSourceTemplate,
  rendered: string,
  provenanceLengths: Readonly<Record<string, number>>,
  path: string,
): Readonly<Record<string, string>> {
  const solutions: string[][] = [];
  const visit = (
    slotIndex: number,
    offset: number,
    segments: readonly string[],
  ): void => {
    const literal = template.literals[slotIndex]!;
    if (!rendered.startsWith(literal, offset)) {
      return;
    }
    const segmentStart = offset + literal.length;
    if (slotIndex === template.fragments.length) {
      if (segmentStart === rendered.length) {
        solutions.push([...segments]);
      }
      return;
    }

    const nextLiteral = template.literals[slotIndex + 1]!;
    if (nextLiteral === "") {
      visit(
        slotIndex + 1,
        rendered.length,
        [...segments, rendered.slice(segmentStart)],
      );
      return;
    }
    let boundary = rendered.indexOf(nextLiteral, segmentStart);
    while (boundary !== -1) {
      visit(
        slotIndex + 1,
        boundary,
        [...segments, rendered.slice(segmentStart, boundary)],
      );
      boundary = rendered.indexOf(nextLiteral, boundary + 1);
    }
  };

  visit(0, 0, []);
  if (solutions.length === 0) {
    fail(path, "source drift from canonical literal anchors");
  }
  let selected = solutions[0]!;
  if (solutions.length > 1) {
    const ranked = solutions.map((segments) => ({
      segments,
      score: segments.reduce(
        (total, segment, index) =>
          total +
          Math.abs(
            segment.length -
              provenanceLengths[template.fragments[index]!]!,
          ),
        0,
      ),
    }));
    const bestScore = Math.min(...ranked.map(({ score }) => score));
    const best = ranked.filter(({ score }) => score === bestScore);
    if (best.length !== 1) {
      fail(path, "ambiguous canonical literal-anchor provenance");
    }
    selected = best[0]!.segments;
  }
  return Object.fromEntries(
    template.fragments.map((fragment, index) => [
      fragment,
      selected[index]!,
    ]),
  );
}

function observeRenderedFragments(
  roles: readonly CatalogRole[],
  roots: Readonly<Record<PromptSurface, PromptVerificationRoot>>,
  canonicalSources: ReadonlyMap<string, string>,
  authoritativeObservations: ReadonlyMap<string, PromptFragmentObservation>,
): readonly PromptFragmentObservation[] {
  return roles.flatMap((role) => {
    const source = canonicalSources.get(role.canonicalSource);
    if (source === undefined) {
      fail(
        `canonicalSources.${role.canonicalSource}`,
        "missing canonical source",
      );
    }
    const template = parseCanonicalSource(role, source);
    const bySurface = Object.fromEntries(
      PROMPT_SURFACES.map((surface) => {
        const provenanceLengths = Object.fromEntries(
          role.fragmentBindings.map((binding) => {
            const observation = authoritativeObservations.get(
              observationKey(role.roleId, binding.fragment),
            );
            if (observation === undefined) {
              fail(
                "fragmentObservations",
                `missing observation "${role.roleId}:${binding.fragment}"`,
              );
            }
            return [binding.fragment, observation.contents[surface].length];
          }),
        );
        return [
          surface,
          extractRenderedSegments(
            template,
            roots[surface].artifacts[`roles/${role.roleId}.md`]!,
            provenanceLengths,
            `packagedRoots.${surface}.roles/${role.roleId}.md`,
          ),
        ];
      }),
    ) as Record<PromptSurface, Readonly<Record<string, string>>>;
    return role.fragmentBindings.map((binding) => ({
      roleId: role.roleId,
      fragment: binding.fragment,
      contents: Object.fromEntries(
        PROMPT_SURFACES.map((surface) => [
          surface,
          bySurface[surface][binding.fragment]!,
        ]),
      ) as Record<PromptSurface, string>,
    }));
  });
}

function indexFragmentObservations(
  roles: readonly CatalogRole[],
  observations: readonly PromptFragmentObservation[],
): ReadonlyMap<string, PromptFragmentObservation> {
  const byKey = new Map<string, PromptFragmentObservation>();
  for (const observation of observations) {
    const key = observationKey(observation.roleId, observation.fragment);
    if (byKey.has(key)) {
      fail(
        "fragmentObservations",
        `duplicate observation "${observation.roleId}:${observation.fragment}"`,
      );
    }
    for (const surface of PROMPT_SURFACES) {
      if (typeof observation.contents[surface] !== "string") {
        fail(
          `fragmentObservations.${observation.roleId}.${observation.fragment}.${surface}`,
          "expected authoritative fragment bytes",
        );
      }
    }
    byKey.set(key, observation);
  }

  const expectedKeys = roles.flatMap((role) =>
    role.fragmentBindings.map((binding) =>
      observationKey(role.roleId, binding.fragment),
    ),
  );
  const missing = expectedKeys.find((key) => !byKey.has(key));
  if (missing !== undefined) {
    const [roleId, fragment] = missing.split("\0");
    fail("fragmentObservations", `missing observation "${roleId}:${fragment}"`);
  }
  const extra = observations.find(
    (observation) =>
      !expectedKeys.includes(observationKey(observation.roleId, observation.fragment)),
  );
  if (extra !== undefined) {
    fail(
      "fragmentObservations",
      `unknown observation "${extra.roleId}:${extra.fragment}"`,
    );
  }
  return byKey;
}

function assertDifferenceDeclarations(
  roles: readonly CatalogRole[],
  renderedObservations: ReadonlyMap<string, PromptFragmentObservation>,
): void {
  for (const role of roles) {
    const declarations = new Set(
      role.intentionalDifferences.map(differenceKey),
    );
    for (const binding of role.fragmentBindings) {
      const observation = renderedObservations.get(
        observationKey(role.roleId, binding.fragment),
      );
      if (observation === undefined) {
        fail(
          "renderedObservations",
          `missing observation "${role.roleId}:${binding.fragment}"`,
        );
      }
      const observedDifference =
        new Set(PROMPT_SURFACES.map((surface) => observation.contents[surface]))
          .size > 1;
      const declared =
        binding.intentionalDifference !== undefined &&
        declarations.has(differenceKey(binding.intentionalDifference));
      if (observedDifference && !declared) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `missing difference declaration for "${binding.fragment}"`,
        );
      }
      if (!observedDifference && declared) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `stale difference declaration for "${binding.fragment}"`,
        );
      }
    }
  }
}

function assertAuthoritativeFragmentParity(
  rendered: ReadonlyMap<string, PromptFragmentObservation>,
  authoritative: ReadonlyMap<string, PromptFragmentObservation>,
): void {
  for (const [key, renderedObservation] of rendered) {
    const authoritativeObservation = authoritative.get(key);
    if (authoritativeObservation === undefined) {
      fail("fragmentObservations", "missing authoritative fragment input");
    }
    for (const surface of PROMPT_SURFACES) {
      if (
        renderedObservation.contents[surface] !==
        authoritativeObservation.contents[surface]
      ) {
        fail(
          `packagedRoots.${surface}.roles/${renderedObservation.roleId}.md`,
          `source drift from authoritative fragment input "${renderedObservation.fragment}"`,
        );
      }
    }
  }
}

/**
 * Verify the attested packaged-surface manifest (`surface.json`, T683) of one
 * root against its own installed bytes and the authoritative catalog: exact
 * field shape, surface identity, catalog metadata hash, canonical role order,
 * per-role exact-byte digests, schema-sidecar version/role-kind consistency,
 * and the recomputed surface aggregate digest. Any drift fails closed.
 */
function assertSurfaceManifest(
  root: PromptVerificationRoot,
  roles: readonly CatalogRole[],
  path: string,
): void {
  const surfacePath = `${path}.surface.json`;
  let value: unknown;
  try {
    value = JSON.parse(root.artifacts["surface.json"]!) as unknown;
  } catch {
    fail(surfacePath, "expected valid JSON");
  }
  if (!isRecord(value)) {
    fail(surfacePath, "expected an object");
  }
  const fields = Object.keys(value).sort();
  if (
    !sameOrderedValues(fields, [
      "catalogMetadataHash",
      "roles",
      "surface",
      "surfaceDigest",
    ])
  ) {
    fail(surfacePath, "expected exactly surface, catalogMetadataHash, roles, and surfaceDigest");
  }
  if (value.surface !== root.surface) {
    fail(`${surfacePath}.surface`, `expected "${root.surface}"`);
  }
  const catalogHash = value.catalogMetadataHash;
  if (typeof catalogHash !== "string" || !/^[0-9a-f]{64}$/.test(catalogHash)) {
    fail(`${surfacePath}.catalogMetadataHash`, "expected a lowercase hex SHA-256 digest");
  }
  if (catalogHash !== sha256(root.artifacts["catalog.json"]!)) {
    fail(
      `${surfacePath}.catalogMetadataHash`,
      "does not match the installed catalog.json bytes",
    );
  }
  if (!Array.isArray(value.roles)) {
    fail(`${surfacePath}.roles`, "expected an array");
  }
  const entries = value.roles as readonly Record<string, unknown>[];
  if (entries.length !== roles.length) {
    fail(`${surfacePath}.roles`, `expected ${roles.length} role attestations`);
  }
  for (const [index, role] of roles.entries()) {
    const entry = entries[index]!;
    const entryPath = `${surfacePath}.roles[${index}]`;
    if (!isRecord(entry)) {
      fail(entryPath, "expected an object");
    }
    const entryFields = Object.keys(entry).sort();
    if (!sameOrderedValues(entryFields, ["roleId", "sha256", "version"])) {
      fail(entryPath, "expected exactly roleId, version, and sha256");
    }
    if (entry.roleId !== role.roleId) {
      fail(`${entryPath}.roleId`, `expected "${role.roleId}" in canonical catalog order`);
    }
    const digest = entry.sha256;
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      fail(`${entryPath}.sha256`, "expected a lowercase hex SHA-256 digest");
    }
    if (digest !== sha256(root.artifacts[`roles/${role.roleId}.md`]!)) {
      fail(`${entryPath}.sha256`, "does not match the installed role artifact bytes");
    }
    if (role.roleKind === "dispatched-subagent") {
      if (
        typeof entry.version !== "number" ||
        !Number.isSafeInteger(entry.version) ||
        entry.version < 1
      ) {
        fail(`${entryPath}.version`, "expected a positive integer schema-sidecar version");
      }
    } else if (entry.version !== null) {
      fail(`${entryPath}.version`, "orchestrator-command roles must carry null");
    }
  }
  const canonicalCore = JSON.stringify({
    surface: value.surface,
    catalogMetadataHash: catalogHash,
    roles: entries.map((entry) => ({
      roleId: entry.roleId,
      version: entry.version,
      sha256: entry.sha256,
    })),
  });
  if (value.surfaceDigest !== sha256(canonicalCore)) {
    fail(
      `${surfacePath}.surfaceDigest`,
      "surface aggregate digest does not match the attested contents",
    );
  }
}

function assertRoot(
  root: PromptVerificationRoot,
  expected: PromptVerificationRoot,
  catalogJson: string,
  roles: readonly CatalogRole[],
  path: string,
): void {
  if (root.surface !== expected.surface) {
    fail(`${path}.surface`, `expected "${expected.surface}"`);
  }
  const requiredArtifactPaths = [
    "catalog.json",
    "surface.json",
    ...roles.map((role) => `roles/${role.roleId}.md`),
  ];
  const additionalArtifactPaths = Object.keys(expected.artifacts).filter(
    (artifactPath) => !requiredArtifactPaths.includes(artifactPath),
  );
  const expectedArtifactPaths = [...requiredArtifactPaths, ...additionalArtifactPaths].sort();
  const actualArtifactPaths = Object.keys(root.artifacts).sort();
  const missingArtifact = expectedArtifactPaths.find(
    (artifactPath) => !actualArtifactPaths.includes(artifactPath),
  );
  if (missingArtifact !== undefined) {
    const detail = missingArtifact.startsWith("roles/")
      ? `missing role artifact "${missingArtifact}"`
      : `missing root artifact "${missingArtifact}"`;
    fail(path, detail);
  }
  const extraArtifact = actualArtifactPaths.find(
    (artifactPath) => !expectedArtifactPaths.includes(artifactPath),
  );
  if (extraArtifact !== undefined) {
    fail(path, `undeclared root artifact "${extraArtifact}"`);
  }
  if (root.artifacts["catalog.json"] !== catalogJson) {
    fail(`${path}.catalog.json`, "catalog bytes differ from the authoritative Nix JSON");
  }
  assertSurfaceManifest(root, roles, path);

  for (const role of roles) {
    const artifactPath = `roles/${role.roleId}.md`;
    const actual = root.artifacts[artifactPath]!;
    const expectedContent = expected.artifacts[artifactPath];
    if (expectedContent === undefined) {
      fail(`${path}.${artifactPath}`, "expected renderer omitted the role artifact");
    }
    if (actual.includes("CQ_HARNESS")) {
      fail(`${path}.${artifactPath}`, "forbidden harness vocabulary CQ_HARNESS");
    }
    if (actual.includes(SLOT_MARKER_PREFIX)) {
      fail(`${path}.${artifactPath}`, "unresolved slot marker");
    }
    for (const token of new Set(
      role.fragmentBindings.flatMap(
        (binding) => binding.forbiddenVocabulary[root.surface],
      ),
    )) {
      if (actual.includes(token)) {
        fail(
          `${path}.${artifactPath}`,
          `forbidden vocabulary "${token}" for ${root.surface}`,
        );
      }
    }
    if (!sameOrderedValues(placeholders(actual), placeholders(expectedContent))) {
      fail(`${path}.${artifactPath}`, "runtime placeholder sequence changed");
    }
    if (actual !== expectedContent) {
      fail(`${path}.${artifactPath}`, "source drift from deterministic rendering");
    }
  }
  for (const artifactPath of additionalArtifactPaths) {
    if (root.artifacts[artifactPath] !== expected.artifacts[artifactPath]) {
      fail(`${path}.${artifactPath}`, "source drift from deterministic rendering");
    }
  }
}

export function verifyPromptCatalog(input: PromptCatalogVerificationInput): void {
  const authority = asProjection(input.authoritativeProjection, "authoritativeProjection");
  const generated = asProjection(input.generatedProjection, "generatedProjection");
  const authorityRoleIds = authority.catalog.map((role) => role.roleId);
  const generatedRoleIds = generated.catalog.map((role) => role.roleId);
  if (!sameOrderedValues(generatedRoleIds, authorityRoleIds)) {
    fail("generatedProjection.catalog", "different ordered role catalog");
  }
  assertCatalogStructure(
    authority.catalog,
    authority.fragmentContracts,
    input.sidecarRoleIds,
  );
  if (generated.schemaVersion !== authority.schemaVersion) {
    fail("generatedProjection.schemaVersion", "different schema version");
  }
  if (canonicalJson(generated.catalog) !== canonicalJson(authority.catalog)) {
    fail("generatedProjection.catalog", "catalog metadata drift");
  }
  if (
    canonicalJson(generated.fragmentContracts) !==
    canonicalJson(authority.fragmentContracts)
  ) {
    fail("generatedProjection.fragmentContracts", "fragment-contract drift");
  }
  if (generated.catalogMetadataHash !== authority.catalogMetadataHash) {
    fail("generatedProjection.catalogMetadataHash", "different metadata hash");
  }
  for (const surface of PROMPT_SURFACES) {
    assertRoot(
      input.packagedRoots[surface],
      input.expectedRoots[surface],
      input.authoritativeCatalogJson,
      authority.catalog,
      `packagedRoots.${surface}`,
    );
  }
  assertRoot(
    input.localClaudeRoot,
    input.expectedRoots.claude,
    input.authoritativeCatalogJson,
    authority.catalog,
    "localClaudeRoot",
  );
  if (
    canonicalArtifacts(input.localClaudeRoot.artifacts) !==
    canonicalArtifacts(input.packagedRoots.claude.artifacts)
  ) {
    fail("localClaudeRoot", "atomic local Claude root differs from the packaged root");
  }
  const canonicalSources = indexCanonicalSources(
    authority.catalog,
    input.canonicalSources,
  );
  const authoritativeObservations = indexFragmentObservations(
    authority.catalog,
    input.fragmentObservations,
  );
  const renderedObservations = indexFragmentObservations(
    authority.catalog,
    observeRenderedFragments(
      authority.catalog,
      input.packagedRoots,
      canonicalSources,
      authoritativeObservations,
    ),
  );
  assertDifferenceDeclarations(authority.catalog, renderedObservations);
  assertAuthoritativeFragmentParity(
    renderedObservations,
    authoritativeObservations,
  );

  let catalogValue: unknown;
  try {
    catalogValue = JSON.parse(input.authoritativeCatalogJson) as unknown;
  } catch {
    fail("authoritativeCatalogJson", "expected valid JSON");
  }
  if (canonicalJson(catalogValue) !== canonicalJson(authority.catalog)) {
    fail("authoritativeCatalogJson", "catalog metadata drift from the projection");
  }
  const actualHash = sha256(input.authoritativeCatalogJson);
  if (authority.catalogMetadataHash !== actualHash) {
    fail(
      "authoritativeProjection.catalogMetadataHash",
      `expected SHA-256 ${actualHash}`,
    );
  }
}
